// Cloudflare Worker entry for the site. The built static files (dist/) are served by
// Cloudflare directly; this code runs only for /api/* (see wrangler.jsonc).
//
// The functions are written in the Pages Functions shape (functions/api/*.js) so the Vite
// dev server can run the same files locally (vite.config.js).
import { onRequest as account } from "./functions/api/account.js"
import { onRequest as elections } from "./functions/api/elections.js"
import { onRequest as circle } from "./functions/api/circle.js"

const ROUTES = { "/api/account": account, "/api/elections": elections, "/api/circle": circle }

export default {
  fetch(request, env) {
    const handler = ROUTES[new URL(request.url).pathname]
    return handler ? handler({ request, env }) : env.ASSETS.fetch(request)
  },
}
