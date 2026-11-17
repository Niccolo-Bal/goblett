// Cloudflare Worker entry for the site. The built static files (dist/) are served by
// Cloudflare directly; this code runs only for /api/* (see wrangler.jsonc).
//
// The account function is written in the Pages Functions shape (functions/api/account.js)
// so the Vite dev server can run the same file locally (vite.config.js).
import { onRequest as account } from "./functions/api/account.js"

export default {
  fetch(request, env) {
    if (new URL(request.url).pathname === "/api/account") return account({ request, env })
    return env.ASSETS.fetch(request)
  },
}
