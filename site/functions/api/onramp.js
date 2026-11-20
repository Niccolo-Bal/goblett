// Server function: /api/onramp. Buying USDC with a card or bank transfer, through Circle's
// Onramp Kit (the "Arc Onramp" widget; cards are processed by Circle's partner, not by us).
//
//   GET  /api/onramp?chainId=5042            -> { available, widgetBaseUrl }
//   POST /api/onramp { chainId, address }    -> the session the browser mounts the widget with
//
// The widget needs a short-lived session token, which only a server holding a Circle API
// key can mint. This uses the same keys as email sign-in (see circle.js): the live key on
// mainnet, where the widget sells real USDC, and the test key on testnets, where it is
// Circle's sandbox and no money moves. The funds go straight from Circle to `address`;
// they never pass through this site.

import { createOnrampServerKit } from "@circle-fin/onramp-kit/server"
import { ADDRESS_RE, json } from "../db.js"
import { circleFor } from "./circle.js"

// Circle's two environments. A key only works in its own.
const SANDBOX = { baseUrl: "https://api-test.circle.com", widgetBaseUrl: "https://onramp-sandbox.arc.io" }
const PRODUCTION = { baseUrl: "https://api.circle.com", widgetBaseUrl: "https://onramp.arc.io" }

function onrampFor(env, chainId) {
  const c = circleFor(env, chainId)
  return c && { key: c.key, ...(c.key.startsWith("TEST_API_KEY") ? SANDBOX : PRODUCTION) }
}

async function mint(request, env) {
  let body
  try {
    body = await request.json()
  } catch {
    return json(400, { error: "body must be JSON" })
  }
  const o = onrampFor(env, Number(body?.chainId))
  const address = String(body?.address ?? "").toLowerCase()
  if (!o) return json(400, { error: "buying funds isn't available on this network" })
  if (!ADDRESS_RE.test(address)) return json(400, { error: "address must be an address" })
  const kit = createOnrampServerKit({
    apiKey: o.key,
    baseUrl: o.baseUrl,
    widgetBaseUrl: o.widgetBaseUrl,
    // Card payments in production are only allowed from the domain registered with Circle.
    ...(env.ONRAMP_REFERRER_DOMAIN ? { referrerDomain: env.ONRAMP_REFERRER_DOMAIN } : {}),
  })
  try {
    // Only USDC on Arc is offered: it is what an election is paid for with.
    const session = await kit.createSession({ appUserId: address, destinationAddress: address, assets: { tokens: ["USDC"], chains: ["arc"] } })
    return json(200, { ...session, widgetBaseUrl: o.widgetBaseUrl })
  } catch (e) {
    return json(502, { error: `Circle couldn't start a purchase: ${e.message}` })
  }
}

export async function onRequest({ request, env }) {
  try {
    if (request.method === "GET") {
      const o = onrampFor(env, Number(new URL(request.url).searchParams.get("chainId")))
      return json(200, o ? { available: true, widgetBaseUrl: o.widgetBaseUrl } : { available: false })
    }
    if (request.method === "POST") return await mint(request, env)
    return json(405, { error: "method not allowed" })
  } catch (e) {
    return json(500, { error: e.message })
  }
}
