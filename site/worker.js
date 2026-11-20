// Cloudflare Worker entry for the site. The built static files (dist/) are served by
// Cloudflare directly; this code runs only for /api/* (see wrangler.jsonc).
//
// The functions are written in the Pages Functions shape (functions/api/*.js) so the Vite
// dev server can run the same files locally (vite.config.js).
import { onRequest as account } from "./functions/api/account.js"
import { onRequest as elections } from "./functions/api/elections.js"
import { onRequest as circle } from "./functions/api/circle.js"
import { onRequest as faucet } from "./functions/api/faucet.js"
import { onRequest as onramp } from "./functions/api/onramp.js"

const ROUTES = { "/api/account": account, "/api/elections": elections, "/api/circle": circle, "/api/faucet": faucet, "/api/onramp": onramp }

// Writes that cost us something (Circle sends an email, the faucet sends funds, a database
// row) are limited per address. Reads stay free. Only the counter is kept, in memory by
// Cloudflare (the WRITE_LIMITER binding in wrangler.jsonc), not a log of who called.
async function limited(request, env, path) {
  if (request.method !== "POST" || !env.WRITE_LIMITER) return false
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown"
  const { success } = await env.WRITE_LIMITER.limit({ key: `${path} ${ip}` })
  return !success
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname
    const handler = ROUTES[path]
    if (!handler) return env.ASSETS.fetch(request)
    if (await limited(request, env, path)) {
      return new Response(JSON.stringify({ error: "too many requests; wait a minute and try again" }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "60" },
      })
    }
    return handler({ request, env })
  },
}
