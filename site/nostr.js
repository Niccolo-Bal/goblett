// Nostr transport: how registrations and votes travel from the browser to relayers.
//
// Each message is a Nostr event tagged with the chain's topic and published to public
// relays. It names its election; any relayer subscribed to the topic can forward it.
// Every event is signed with a fresh throwaway key, so events can't be linked to
// each other or to a person by their Nostr pubkey. (The Nostr relays still see the
// sender's IP and timing.)
//
// Must match relayer/nostr.py.

import { generateSecretKey, finalizeEvent } from "nostr-tools/pure"
import { SimplePool } from "nostr-tools/pool"

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
  const results = await Promise.allSettled(pool.publish(cfg.nostrRelays, event).map((p) => withTimeout(p, 8000, "publish")))
  const accepted = cfg.nostrRelays.filter((_, i) => results[i].status === "fulfilled")
  if (!accepted.length) {
    throw new Error("no Nostr relay accepted the message: " + results.map((r, i) => `${cfg.nostrRelays[i]}: ${r.reason?.message ?? r.reason}`).join("; "))
  }
  return { id: event.id, accepted }
}

/// Wait until `onChain()` is true (the only proof that counts). A relayer's reply
/// event is used just to fail fast with its error; replies are unauthenticated, so
/// an "ok" reply is never trusted on its own.
export async function confirm(cfg, id, onChain, timeoutMs = 90000) {
  let reply
  const sub = pool.subscribeMany(cfg.nostrRelays, { kinds: [KIND_REPLY], "#e": [id] }, {
    onevent: (e) => {
      try {
        reply ??= JSON.parse(e.content)
      } catch {}
    },
  })
  try {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      // Only the chain decides. Anyone can post a reply, so a reply's error is never
      // treated as final (R3-8); it is shown below only as an unverified hint.
      if (await onChain()) return { ok: true }
      await new Promise((r) => setTimeout(r, 1000))
    }
    const hint = reply && !reply.ok ? ` A relayer replied "${String(reply.error).slice(0, 200)}" (unverified: anyone can post replies).` : ""
    throw new Error(`still pending, not on-chain yet. The message is stored on Nostr, so any relayer can still submit it later.${hint}`)
  } finally {
    sub.close()
  }
}
