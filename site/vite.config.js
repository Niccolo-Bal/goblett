import { defineConfig, loadEnv } from "vite"

// Local dev only: Cloudflare Pages runs functions/ in production, but the Vite dev server
// doesn't. This runs the same function code for /api/account requests, with site/.env as
// its environment. (Variables without the VITE_ prefix never reach the browser bundle.)
function pagesFunctionsDev(env) {
  return {
    name: "pages-functions-dev",
    configureServer(server) {
      server.middlewares.use("/api/account", async (req, res) => {
        try {
          const chunks = []
          for await (const c of req) chunks.push(c)
          const request = new Request(`http://${req.headers.host}${req.originalUrl}`, {
            method: req.method,
            headers: req.headers,
            body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
          })
          const { onRequest } = await server.ssrLoadModule("/functions/api/account.js")
          const response = await onRequest({ request, env })
          res.statusCode = response.status
          response.headers.forEach((v, k) => res.setHeader(k, v))
          res.end(Buffer.from(await response.arrayBuffer()))
        } catch (e) {
          res.statusCode = 500
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ error: e.message }))
        }
      })
    },
  }
}

export default defineConfig(({ mode }) => ({
  plugins: [pagesFunctionsDev(loadEnv(mode, process.cwd(), ""))],
  build: {
    rollupOptions: {
      // Two pages: the landing page and the app (election, create, account).
      input: { main: "index.html", app: "app.html" },
    },
  },
}))
