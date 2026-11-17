// Node entry for the gateway, for running it on your own server (so the decryption key is
// held by a different party than the relay's host):
//
//   OHTTP_SEED=... NOSTR_RELAYS=wss://nos.lol,wss://relay.primal.net \
//   RPC_URLS='{"5042":"https://rpc.mainnet.arc.io"}' PORT=8788 node gateway/server.mjs
//
// Variables can also go in ohttp/.env (gitignored). Put it behind HTTPS (a reverse proxy
// or a tunnel) and point the relay's GATEWAY_URL at it. Needs Node 22+ (global WebSocket).

import { createServer } from "node:http"
import { existsSync, readFileSync } from "node:fs"
import { createGateway } from "./handler.js"

const envFile = new URL("../.env", import.meta.url)
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2")
  }
}

const handle = createGateway(process.env)
const port = Number(process.env.PORT ?? 8788)

createServer(async (req, res) => {
  // Same cap as the relay, so the Node gateway can't be made to buffer an unbounded body.
  const chunks = []
  let size = 0
  for await (const c of req) {
    if ((size += c.length) > 64 * 1024) return res.writeHead(413).end("too large")
    chunks.push(c)
  }
  const request = new Request(`http://${req.headers.host ?? "localhost"}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
  })
  const response = await handle(request)
  res.writeHead(response.status, Object.fromEntries(response.headers))
  res.end(Buffer.from(await response.arrayBuffer()))
  // No request logging on purpose: the gateway should not keep a record of what it forwarded when.
}).listen(port, () => console.log(`goblett OHTTP gateway listening on :${port}`))
