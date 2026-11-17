// Oblivious HTTP client (RFC 9458): how the browser reaches the Nostr relays and the chain
// RPC without showing them its IP address.
//
// A request is encrypted to the gateway's public key and posted to the relay. The relay
// sees our address but only ciphertext; the gateway decrypts it but only sees the relay.
// See ../ohttp/ for both. Configured by /ohttp.json: { relayUrl, keyConfig }.
//
// What this does not hide: timing (a vote appears on-chain seconds after this browser
// sent something to the relay), and anything if the relay and the gateway are run by the
// same party or share their logs.

import { AEAD_AES_128_GCM, CipherSuite, KDF_HKDF_SHA256, KEM_DHKEM_P256_HKDF_SHA256 } from "hpke"
import { KeyConfig, OHTTPClient } from "ohttp-ts"

// Must match the gateway (ohttp/gateway/handler.js).
const SUITE = new CipherSuite(KEM_DHKEM_P256_HKDF_SHA256, KDF_HKDF_SHA256, AEAD_AES_128_GCM)
const fromBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

/// Returns ohttpFetch(path, init) -> Response, where `path` is a gateway route such as
/// "/publish". The host in the inner URL is a placeholder; the gateway only reads the path.
export function createOhttpClient({ relayUrl, keyConfig }, fetchImpl = (...a) => fetch(...a)) {
  const client = new OHTTPClient(SUITE, KeyConfig.select(SUITE, KeyConfig.parseMultiple(fromBase64(keyConfig))))
  return async function ohttpFetch(path, init) {
    const { init: outer, context } = await client.encapsulateRequest(new Request(`https://gateway.invalid${path}`, init))
    // Nothing identifying rides along: no cookies, no referrer.
    const res = await fetchImpl(relayUrl, { ...outer, credentials: "omit", referrerPolicy: "no-referrer" })
    if (res.headers.get("Content-Type") !== "message/ohttp-res") {
      throw new Error(`private channel failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`)
    }
    return context.decapsulateResponse(res)
  }
}

let loaded
/// The site's OHTTP channel, or null when the deployment has none configured (local dev).
/// A network failure throws rather than returning null: callers must not quietly fall back
/// to a direct connection, which would expose the address this exists to hide.
export function ohttp() {
  if (typeof location === "undefined") return Promise.resolve(null) // not a browser (tests)
  return (loaded ??= fetch("/ohttp.json", { cache: "no-store" }).then(async (r) => {
    if (!r.ok || !r.headers.get("Content-Type")?.includes("json")) return null // no such file
    const cfg = await r.json()
    return cfg?.relayUrl && cfg?.keyConfig ? createOhttpClient(cfg) : null
  })).catch((e) => {
    loaded = undefined
    throw e
  })
}
