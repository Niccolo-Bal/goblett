// Tests for the OHTTP relay + gateway, with the real client code the site uses.
//   node test.mjs
// Everything runs in-process: the network (relay -> gateway -> Nostr / RPC) is replaced by
// stand-ins, so this checks the encryption round trip and the gateway's rules, not connectivity.

import { randomBytes } from "node:crypto"
import { KeyConfig } from "ohttp-ts"
import { createGateway, keyConfigFromSeed } from "./gateway/handler.js"
import relay from "./relay/worker.js"
import { createOhttpClient } from "../site/ohttp.js"

let failures = 0
const check = (ok, msg) => {
  if (!ok) failures++
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${msg}`)
}

// --- stand-ins for the outside world ---
const seen = { nostr: [], rpc: [], gatewayRequests: [] }
class FakeWebSocket extends EventTarget {
  constructor(url) {
    super()
    this.url = url
    queueMicrotask(() => this.dispatchEvent(new Event("open")))
  }
  send(data) {
    const [, event] = JSON.parse(data)
    seen.nostr.push({ url: this.url, event })
    const ok = !this.url.includes("grumpy")
    const m = new Event("message")
    m.data = JSON.stringify(["OK", event.id, ok, ok ? "" : "blocked: no thanks"])
    queueMicrotask(() => this.dispatchEvent(m))
  }
  close() {}
}
const rpcFetch = async (url, init) => {
  seen.rpc.push({ url, body: JSON.parse(init.body) })
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x01" }), { headers: { "Content-Type": "application/json" } })
}

const seed = randomBytes(32).toString("hex")
const gatewayEnv = {
  OHTTP_SEED: seed,
  NOSTR_RELAYS: "wss://relay.one,wss://grumpy.relay",
  RPC_URLS: JSON.stringify({ 5042: "https://rpc.mainnet.test", 5042002: "https://rpc.testnet.test" }),
}
const gateway = createGateway(gatewayEnv, { fetchImpl: rpcFetch, WebSocketImpl: FakeWebSocket })

// The relay Worker calls global fetch() to reach the gateway: route that to our gateway.
const GATEWAY_URL = "https://gateway.test/"
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init)
  seen.gatewayRequests.push({ url: request.url, headers: Object.fromEntries(request.headers) })
  return gateway(request)
}
const relayEnv = { GATEWAY_URL, ALLOWED_ORIGINS: "https://goblett.xyz,http://localhost:5173" }
// What the browser does: fetch(relayUrl, ...) from the site's origin, with its own headers.
const browserFetch = (url, init) =>
  relay.fetch(new Request(url, { ...init, credentials: undefined, referrerPolicy: undefined, headers: { ...init.headers, Origin: "https://goblett.xyz", Cookie: "session=secret", "X-Forwarded-For": "203.0.113.9", "CF-Connecting-IP": "203.0.113.9" } }), relayEnv)

const keyConfig = Buffer.from(KeyConfig.serializeMultiple([await keyConfigFromSeed(seed)])).toString("base64")
const ohttpFetch = createOhttpClient({ relayUrl: "https://relay.test/", keyConfig }, browserFetch)
const post = (path, body) => ohttpFetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })

const event = (over = {}) => ({
  id: "ab".repeat(32), pubkey: "cd".repeat(32), sig: "ef".repeat(64), created_at: 1794800000, kind: 9467,
  tags: [["t", "goblett-5042"]], content: JSON.stringify({ type: "vote", election: "0x" + "11".repeat(20) }), ...over,
})

// --- publish ---
let r = await post("/publish", event())
let body = await r.json()
check(r.status === 200 && body.accepted.length === 1 && body.accepted[0] === "wss://relay.one", "an event is forwarded to the Nostr relays; the response names who accepted it")
check(body.rejected["wss://grumpy.relay"] === "blocked: no thanks", "and why a relay refused")
check(seen.nostr.length === 2 && seen.nostr[0].event.id === event().id && seen.nostr[0].event.sig === event().sig, "the event reaches Nostr unchanged")

const fwd = seen.gatewayRequests.at(-1)
check(!JSON.stringify(fwd.headers).includes("203.0.113.9") && !fwd.headers.cookie && !fwd.headers.origin, "the relay forwards none of the browser's headers (IP, cookie, origin)")
check(fwd.headers["content-type"] === "message/ohttp-req" && Object.keys(fwd.headers).length <= 2, "only the encrypted body and its content type go to the gateway")

r = await post("/publish", event({ kind: 1 }))
check(r.status === 403, "other kinds of Nostr event are refused (not a general publisher)")
r = await post("/publish", event({ tags: [["t", "goblett-1"]] }))
check(r.status === 403, "events for a chain the gateway doesn't serve are refused")
r = await post("/publish", { hello: "world" })
check(r.status === 400, "something that isn't a signed event is refused")

// --- rpc ---
r = await post("/rpc/5042", { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: "0x" + "22".repeat(20), data: "0x1234" }, "latest"] })
check(r.status === 200 && (await r.json()).result === "0x01" && seen.rpc.at(-1).url === "https://rpc.mainnet.test", "a chain read is forwarded to that chain's RPC")
r = await post("/rpc/5042002", [{ jsonrpc: "2.0", id: 1, method: "eth_chainId" }, { jsonrpc: "2.0", id: 2, method: "eth_blockNumber" }])
check(r.status === 200 && seen.rpc.at(-1).url === "https://rpc.testnet.test", "batches work, and the chain id picks the RPC")
const before = seen.rpc.length
r = await post("/rpc/5042", { jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: ["0x00"] })
check(r.status === 403 && seen.rpc.length === before, "sending transactions through the gateway is refused")
r = await post("/rpc/5042", { jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{}] })
check(r.status === 403, "so are log scans")
r = await post("/rpc/1", { jsonrpc: "2.0", id: 1, method: "eth_chainId" })
check(r.status === 404, "an unknown chain is refused")
r = await post("/somewhere-else", {})
check(r.status === 404, "it is not an open proxy: unknown routes are refused")

// --- encryption and the relay's rules ---
const otherKey = Buffer.from(KeyConfig.serializeMultiple([await keyConfigFromSeed(randomBytes(32).toString("hex"))])).toString("base64")
const wrong = createOhttpClient({ relayUrl: "https://relay.test/", keyConfig: otherKey }, browserFetch)
let threw = await wrong("/publish", { method: "POST", body: "{}" }).then(() => false, (e) => /private channel failed/.test(e.message))
check(threw, "a request encrypted to the wrong key fails cleanly")

r = await relay.fetch(new Request("https://relay.test/", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), relayEnv)
check(r.status === 400, "the relay refuses anything that isn't an OHTTP request")
r = await relay.fetch(new Request("https://relay.test/", { method: "POST", headers: { "Content-Type": "message/ohttp-req" }, body: new Uint8Array(70000) }), relayEnv)
check(r.status === 413, "and oversized bodies")
r = await relay.fetch(new Request("https://relay.test/", { method: "OPTIONS", headers: { Origin: "http://localhost:5173" } }), relayEnv)
check(r.status === 204 && r.headers.get("Access-Control-Allow-Origin") === "http://localhost:5173", "CORS preflight is answered for an allowed origin")
r = await relay.fetch(new Request("https://relay.test/", { method: "OPTIONS", headers: { Origin: "https://evil.example" } }), relayEnv)
check(r.headers.get("Access-Control-Allow-Origin") !== "https://evil.example", "but not for another site")
r = await relay.fetch(new Request("https://relay.test/ohttp-keys"), relayEnv)
check(r.status === 200 && Buffer.from(await r.arrayBuffer()).toString("base64") === keyConfig, "the key configuration can be fetched through the relay")

// The relay must not be able to read what it carries.
let captured
const spyFetch = (url, init) => {
  captured = Buffer.from(init.body)
  return browserFetch(url, init)
}
await createOhttpClient({ relayUrl: "https://relay.test/", keyConfig }, spyFetch)("/publish", { method: "POST", body: JSON.stringify(event({ content: "TOP-SECRET-BALLOT" })) })
check(!captured.includes("TOP-SECRET-BALLOT") && !captured.includes("publish"), "what the relay carries is ciphertext (neither the content nor the route is visible)")
check(captured.length >= 1024, `and it is padded (${captured.length} bytes for a small event)`)

// R4-5: with RELAY_TOKEN the gateway only answers the relay, and the relay rate-limits by address.
{
  const tokenGateway = createGateway({ ...gatewayEnv, RELAY_TOKEN: "t0ken" }, { fetchImpl: rpcFetch, WebSocketImpl: FakeWebSocket })
  const counts = new Map()
  const LIMITER = { limit: async ({ key }) => ({ success: (counts.set(key, (counts.get(key) ?? 0) + 1), counts.get(key) <= 3) }) }
  const env = { ...relayEnv, RELAY_TOKEN: "t0ken", LIMITER }
  const saved = globalThis.fetch
  globalThis.fetch = async (input, init) => tokenGateway(new Request(input, init))
  const via = (ip) => (url, init) => relay.fetch(new Request(url, { ...init, credentials: undefined, referrerPolicy: undefined, headers: { ...init.headers, Origin: "https://goblett.xyz", "CF-Connecting-IP": ip } }), env)
  const rpcBody = { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId" }) }
  const res = await createOhttpClient({ relayUrl: "https://relay.test/", keyConfig }, via("198.51.100.1"))("/rpc/5042002", rpcBody)
  check(res.status === 200, "through the relay, the token is added and the gateway answers")
  const direct = createOhttpClient({ relayUrl: "https://gateway.test/", keyConfig }, (url, init) => tokenGateway(new Request(url, init)))
  let refused = false
  try { await direct("/rpc/5042002", rpcBody) } catch (e) { refused = /through the OHTTP relay/.test(e.message) }
  check(refused, "calling the gateway directly without the token is refused")
  const c = createOhttpClient({ relayUrl: "https://relay.test/", keyConfig }, via("198.51.100.1"))
  let limited = false
  for (let i = 0; i < 3 && !limited; i++) try { await c("/rpc/5042002", rpcBody) } catch (e) { limited = /HTTP 429/.test(e.message) }
  check(limited, "the relay answers 429 once an address is over its limit")
  const other = await createOhttpClient({ relayUrl: "https://relay.test/", keyConfig }, via("198.51.100.2"))("/rpc/5042002", rpcBody)
  check(other.status === 200, "while other addresses are unaffected")
  globalThis.fetch = saved
}

console.log(failures ? `${failures} FAILURE(S)` : "ALL PASSED")
process.exit(failures ? 1 : 0)
