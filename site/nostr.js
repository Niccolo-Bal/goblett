// Nostr transport: how registrations and votes travel from the browser to relayers.
//
// Each message is a Nostr event tagged with the chain's topic and published to public
// relays. It names its election; any relayer subscribed to the topic can forward it.
// Every event is signed with a fresh throwaway key, so events can't be linked to
// each other or to a person by their Nostr pubkey.
//
// When the deployment has an OHTTP channel (ohttp.js), the event is handed to the OHTTP
// gateway, which publishes it: the Nostr relays then see the gateway's address, not the
// voter's. Without one (local dev) the browser connects to the Nostr relays itself, and
// they see its IP and timing.
//
// Must match relayer/nostr.py.

import { generateSecretKey, finalizeEvent } from "nostr-tools/pure"
import { SimplePool } from "nostr-tools/pool"
import { ohttp } from "./ohttp.js"

export const KIND_REQUEST = 9467 // voter -> relayers
export const KIND_REPLY = 9468 // relayer -> voter
export const topicOf = (cfg) => `goblett-${cfg.chainId}` // one topic per chain

const pool = new SimplePool()
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms))])

/// Publish `body` to the election's topic. Returns the event id and the relays that took it.
export async function publish(cfg, body) {
  const event = finalizeEvent(
    {
      kind: KIND_REQUEST,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["t", topicOf(cfg)]],
      content: JSON.stringify({ election: cfg.election, ...body }, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
    },
    generateSecretKey()
  )
  // Private channel if there is one. If it is configured but fails, this throws: we never
  // quietly fall back to a direct connection, which would expose the sender's address.
  const channel = await ohttp()
  if (channel) {
    const res = await withTimeout(channel("/publish", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(event) }), 20000, "publish")
    const out = await res.json().catch(() => ({}))
    if (!res.ok || !out.accepted?.length) {
      throw new Error("the private channel could not publish the message: " + (out.error ?? JSON.stringify(out.rejected ?? {}) ?? `HTTP ${res.status}`))
    }
    return { id: event.id, accepted: out.accepted, private: true }
  }

  const results = await Promise.allSettled(pool.publish(cfg.nostrRelays, event).map((p) => withTimeout(p, 8000, "publish")))
  const accepted = cfg.nostrRelays.filter((_, i) => results[i].status === "fulfilled")
  if (!accepted.length) {
    throw new Error("no Nostr relay accepted the message: " + results.map((r, i) => `${cfg.nostrRelays[i]}: ${r.reason?.message ?? r.reason}`).join("; "))
  }
  return { id: event.id, accepted }
}

/// Wait until `onChain()` is true. The browser reads the chain itself and ignores
/// relayer replies entirely: they are unauthenticated, so they can't be trusted for
/// success or failure (R3-8). `_id` is kept so callers don't change.
export async function confirm(_cfg, _id, onChain, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await onChain()) return { ok: true }
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error("still pending, not on-chain yet. The message is stored on Nostr, so any relayer can still submit it later.")
}
