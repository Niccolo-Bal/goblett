// goblett OHTTP gateway (RFC 9458). Decrypts requests that arrive through the OHTTP relay
// and carries them out, so the Nostr relays and the chain RPC see this gateway's address
// instead of the voter's.
//
// The gateway sees WHAT is sent (a signed Nostr event, a chain read) but not WHO sent it:
// it only ever talks to the relay. The relay sees who, but only ciphertext. Neither can
// change a registration or a vote: those are authorized by the wallet's signature and the
// Semaphore proof inside the event.
//
// It is not an open proxy. The decrypted request must be one of:
//
//   POST /publish        body: a signed goblett Nostr event (kind 9467, topic goblett-<chainId>)
//                        -> forwarded to the configured Nostr relays
//   POST /rpc/<chainId>  body: JSON-RPC (single or small batch), read-only methods only
//                        -> forwarded to that chain's RPC
//   POST /elections      body: { chainId, wallet }
//                        -> the site's election list for that wallet (GET ELECTIONS_URL), so the
//                           site's server sees the wallet but not the visitor's address
//
// Plain (unencrypted) endpoint:  GET /ohttp-keys  -> the public key configuration.
//
// Runs unchanged as a Cloudflare Worker (worker.js) or under Node (server.mjs).
//
// Settings (env):
//   OHTTP_SEED     64 hex chars; the private key is derived from it. SECRET. (keygen.mjs)
//   NOSTR_RELAYS   comma-separated wss:// URLs
//   RPC_URLS       JSON object: chain id -> RPC URL, e.g. {"5042":"https://rpc.mainnet.arc.io"}
//   ELECTIONS_URL  the site's election list, default https://goblett.xyz/api/elections
//   RELAY_TOKEN    SECRET shared with the relay. When set, encrypted requests must carry it
//                  (X-Relay-Token), so the gateway can't be used without going through the
//                  relay and its per-address rate limit (R4-5).

import { AEAD_AES_128_GCM, CipherSuite, KDF_HKDF_SHA256, KEM_DHKEM_P256_HKDF_SHA256 } from "hpke"
import { KeyConfig, OHTTPServer } from "ohttp-ts"
import { verifyEvent } from "nostr-tools/pure"

// P-256 because every browser's WebCrypto has it (X25519 is still missing from older ones).
export const SUITE = new CipherSuite(KEM_DHKEM_P256_HKDF_SHA256, KDF_HKDF_SHA256, AEAD_AES_128_GCM)
export const KEY_ID = 1

const KIND_REQUEST = 9467 // must match site/nostr.js and the relayer's nostr.py
const MAX_EVENT_BYTES = 24 * 1024
const MAX_RPC_BYTES = 16 * 1024
const MAX_RPC_BATCH = 20
const MAX_CALL_GAS = 30_000_000n // well above any goblett view (commitments() of a big group)
const PUBLISH_TIMEOUT_MS = 6000
// Reads the site needs to confirm a registration or vote and to build a proof. Nothing
// that sends a transaction or scans logs.
const RPC_METHODS = new Set(["eth_call", "eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getCode"])

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
const hexToBytes = (hex) => Uint8Array.from(hex.match(/../g).map((b) => parseInt(b, 16)))

export async function keyConfigFromSeed(seedHex) {
  if (!/^[0-9a-fA-F]{64}$/.test(seedHex ?? "")) throw new Error("OHTTP_SEED must be 64 hex characters (run keygen.mjs)")
  return KeyConfig.derive(SUITE, hexToBytes(seedHex), KEY_ID)
}

/// Send one event to one Nostr relay and wait for its verdict (NIP-01 "OK" message).
function publishTo(url, event, WebSocketImpl) {
  return new Promise((resolve, reject) => {
    let ws
    const done = (fn, v) => {
      clearTimeout(timer)
      try {
        ws?.close()
      } catch {}
      fn(v)
    }
    const timer = setTimeout(() => done(reject, new Error("timed out")), PUBLISH_TIMEOUT_MS)
    try {
      ws = new WebSocketImpl(url)
    } catch (e) {
      return done(reject, e)
    }
    ws.addEventListener("open", () => ws.send(JSON.stringify(["EVENT", event])))
    ws.addEventListener("message", (m) => {
      try {
        const msg = JSON.parse(typeof m.data === "string" ? m.data : "")
        if (msg[0] === "OK" && msg[1] === event.id) msg[2] ? done(resolve, url) : done(reject, new Error(String(msg[3] ?? "rejected")))
      } catch {}
    })
    ws.addEventListener("error", () => done(reject, new Error("connection failed")))
    ws.addEventListener("close", () => done(reject, new Error("closed before answering")))
  })
}

export function createGateway(env, { fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket } = {}) {
  const relays = (env.NOSTR_RELAYS ?? "").split(",").map((s) => s.trim()).filter(Boolean)
  const rpcUrls = JSON.parse(env.RPC_URLS || "{}")
  const topics = new Set(Object.keys(rpcUrls).map((id) => `goblett-${id}`))
  let ready // key config + server, created once

  const setup = () =>
    (ready ??= keyConfigFromSeed(env.OHTTP_SEED).then((keyConfig) => ({
      server: new OHTTPServer([keyConfig]),
      keys: KeyConfig.serializeMultiple([keyConfig]),
    })))

  async function publish(request) {
    const text = await request.text()
    if (text.length > MAX_EVENT_BYTES) return json(413, { error: "event too large" })
    let ev
    try {
      ev = JSON.parse(text)
    } catch {
      return json(400, { error: "body must be a JSON Nostr event" })
    }
    const wellFormed =
      ev && typeof ev === "object" && /^[0-9a-f]{64}$/.test(ev.id) && /^[0-9a-f]{64}$/.test(ev.pubkey) && /^[0-9a-f]{128}$/.test(ev.sig) &&
      typeof ev.content === "string" && Array.isArray(ev.tags) && Number.isInteger(ev.created_at)
    // Check the id and signature here, so a forged event costs the sender a 400, not a
    // connection to every Nostr relay (R4-5).
    if (!wellFormed || !verifyEvent(ev)) return json(400, { error: "not a signed Nostr event" })
    // Only goblett requests for the chains we serve: this is not a general Nostr publisher.
    const onTopic = ev.tags.some((t) => Array.isArray(t) && t[0] === "t" && topics.has(t[1]))
    if (ev.kind !== KIND_REQUEST || !onTopic) return json(403, { error: "only goblett registration/vote events are forwarded" })

    const results = await Promise.allSettled(relays.map((url) => publishTo(url, ev, WebSocketImpl)))
    const accepted = relays.filter((_, i) => results[i].status === "fulfilled")
    const rejected = Object.fromEntries(relays.map((url, i) => [url, results[i].reason?.message]).filter(([, why]) => why))
    return json(accepted.length ? 200 : 502, { accepted, rejected })
  }

  async function rpc(request, chainId) {
    const url = rpcUrls[chainId]
    if (!url) return json(404, { error: `chain ${chainId} is not served by this gateway` })
    const text = await request.text()
    if (text.length > MAX_RPC_BYTES) return json(413, { error: "request too large" })
    let body
    try {
      body = JSON.parse(text)
    } catch {
      return json(400, { error: "body must be JSON-RPC" })
    }
    const calls = Array.isArray(body) ? body : [body]
    if (!calls.length || calls.length > MAX_RPC_BATCH) return json(400, { error: `1 to ${MAX_RPC_BATCH} calls per request` })
    const bad = calls.find((c) => !c || typeof c !== "object" || !RPC_METHODS.has(c.method))
    if (bad) return json(403, { error: `method not allowed: ${String(bad?.method)}` })
    // No full-transaction blocks (the site only needs the header) and a gas cap on calls,
    // so each request costs the upstream RPC about what the site itself would (R4-5).
    if (calls.some((c) => c.method === "eth_getBlockByNumber" && c.params?.[1] === true)) return json(403, { error: "full-transaction blocks are not served" })
    for (const c of calls) {
      if (c.method !== "eth_call") continue
      const tx = c.params?.[0]
      if (!tx || typeof tx !== "object") return json(400, { error: "eth_call needs a call object" })
      let gas
      try {
        gas = tx.gas === undefined ? undefined : BigInt(tx.gas)
      } catch {
        return json(400, { error: "bad gas value" })
      }
      if (gas === undefined || gas > MAX_CALL_GAS) tx.gas = "0x" + MAX_CALL_GAS.toString(16)
    }
    if (calls.some((c) => c.method === "eth_call" && c.params?.length > 2)) return json(403, { error: "state overrides are not allowed" })
    const upstream = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    return new Response(await upstream.text(), { status: upstream.status, headers: { "Content-Type": "application/json" } })
  }

  // The lobby's "your elections" list (Scout's final-round item 2).
  async function elections(inner) {
    const b = await inner.json().catch(() => null)
    const chainId = Number(b?.chainId)
    const wallet = String(b?.wallet ?? "").toLowerCase()
    if (!Number.isSafeInteger(chainId) || chainId <= 0 || !/^0x[0-9a-f]{40}$/.test(wallet)) return json(400, { error: "chainId and wallet are required" })
    const url = new URL(env.ELECTIONS_URL || "https://goblett.xyz/api/elections")
    url.search = new URLSearchParams({ chainId: String(chainId), wallet }).toString()
    const upstream = await fetchImpl(url.toString(), { headers: { Accept: "application/json" } })
    return new Response(await upstream.text(), { status: upstream.status, headers: { "Content-Type": "application/json" } })
  }

  async function route(inner) {
    const path = new URL(inner.url).pathname
    if (inner.method !== "POST") return json(405, { error: "POST only" })
    if (path === "/publish") return publish(inner)
    if (path === "/elections") return elections(inner)
    const m = /^\/rpc\/(\d+)$/.exec(path)
    if (m) return rpc(inner, m[1])
    return json(404, { error: "unknown gateway route" })
  }

  return async function handle(request) {
    const path = new URL(request.url).pathname
    let state
    try {
      state = await setup()
    } catch (e) {
      return json(500, { error: e.message })
    }
    if (request.method === "GET" && path === "/ohttp-keys") {
      return new Response(state.keys, { headers: { "Content-Type": "application/ohttp-keys", "Cache-Control": "public, max-age=300" } })
    }
    if (request.method !== "POST" || request.headers.get("Content-Type") !== "message/ohttp-req") {
      return json(400, { error: "expected an OHTTP request (POST, Content-Type: message/ohttp-req)" })
    }
    if (env.RELAY_TOKEN && request.headers.get("X-Relay-Token") !== env.RELAY_TOKEN) {
      return json(403, { error: "requests must come through the OHTTP relay" })
    }
    let inner, context
    try {
      ;({ request: inner, context } = await state.server.decapsulateRequest(request))
    } catch {
      // Wrong or rotated key, or garbage. Nothing can be said back in encrypted form.
      return json(400, { error: "could not decrypt the request (stale key configuration?)" })
    }
    let response
    try {
      response = await route(inner)
    } catch (e) {
      response = json(502, { error: `gateway error: ${e.message}` })
    }
    return context.encapsulateResponse(response)
  }
}
