// goblett OHTTP relay (RFC 9458), a Cloudflare Worker.
//
// It passes encrypted blobs between browsers and ONE fixed gateway. It sees the sender's
// IP address but can't read the blob (encrypted to the gateway's key); the gateway can
// read it but only ever sees this relay. The privacy of the scheme rests on the relay and
// the gateway not pooling what they know, so they should be run by different parties.
//
// Keep logging off for this Worker (no Workers Logs, Logpush or tail sessions): its job is
// to not remember which address sent something when.
//
// Settings (Worker variables):
//   GATEWAY_URL      where to forward, e.g. https://gateway.example/   (never client-chosen)
//   ALLOWED_ORIGINS  comma-separated site origins allowed to call it from a browser
//   RELAY_TOKEN      (Secret) shared with the gateway, so only this relay can reach it and
//                    the rate limit below can't be skipped by calling the gateway directly
//   LIMITER          (rate-limit binding, optional) requests per client address per minute.
//                    Counted in memory by Cloudflare, not logged.

const MAX_BYTES = 64 * 1024

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin")
    const allowed = (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim())
    const cors = {
      "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0] ?? "null",
      "Access-Control-Allow-Methods": "POST, GET",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    }
    const reply = (status, text) => new Response(text, { status, headers: cors })

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors })

    // The gateway's public key configuration, fetched through the relay so that asking
    // for it doesn't show the gateway the asker's address either.
    if (request.method === "GET" && new URL(request.url).pathname === "/ohttp-keys") {
      const keys = await fetch(new URL("/ohttp-keys", env.GATEWAY_URL))
      return new Response(keys.body, { status: keys.status, headers: { ...cors, "Content-Type": "application/ohttp-keys", "Cache-Control": "public, max-age=300" } })
    }

    if (request.method !== "POST" || request.headers.get("Content-Type") !== "message/ohttp-req") {
      return reply(400, "not an OHTTP request")
    }
    if (env.LIMITER) {
      const { success } = await env.LIMITER.limit({ key: request.headers.get("CF-Connecting-IP") ?? "unknown" })
      if (!success) return reply(429, "too many requests")
    }
    const body = await request.arrayBuffer()
    if (body.byteLength > MAX_BYTES) return reply(413, "too large")

    // A brand-new request: nothing of the client's is forwarded except the encrypted body.
    const upstream = await fetch(env.GATEWAY_URL, {
      method: "POST",
      headers: { "Content-Type": "message/ohttp-req", ...(env.RELAY_TOKEN ? { "X-Relay-Token": env.RELAY_TOKEN } : {}) },
      body,
    })
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...cors, "Content-Type": upstream.headers.get("Content-Type") ?? "message/ohttp-res" },
    })
  },
}
