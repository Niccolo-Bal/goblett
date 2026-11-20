// Server function: /api/circle. Sign-in without a wallet extension, through Circle's
// user-controlled wallets (email code or Google). The browser side is circle-wallet.js.
//
//   GET  /api/circle?chainId=5042002            -> { available, appId, google }
//   POST /api/circle { action, chainId, ... }   -> see ACTIONS below
//
// Circle's API needs two credentials: our API key, which lives only in this function's
// environment (CIRCLE_API_KEY_TEST and CIRCLE_API_KEY_MAIN), and the user's own session token, which Circle gives the
// browser when the user proves their email or Google account. This function adds the
// first to requests the browser makes with the second. It is not a general proxy: only
// the handful of calls below are possible, and none of them moves or signs anything by
// itself. Signing needs a "challenge" that the user confirms in Circle's own window; the
// key is split between the user's device and Circle, and neither we nor Circle hold it whole.
//
// Like accounts, this is unrelated to casting a vote and is never called while voting.

import { json } from "../db.js"

const API = "https://api.circle.com/v1/w3s"
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ARC = { 5042: "ARC", 5042002: "ARC-TESTNET" }
const MAINNETS = new Set([5042])
// Circle error codes: the user already has a wallet set up; the session token ran out.
const ALREADY_INITIALIZED = 155106
const TOKEN_EXPIRED = 155104

class CircleError extends Error {
  constructor(status, code, message) {
    super(message || `Circle error (HTTP ${status})`)
    this.status = status
    this.code = code
  }
}

async function circle(key, path, { method = "GET", userToken, body } = {}) {
  const init = {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(userToken ? { "X-User-Token": userToken } : {}),
    },
    body: body && JSON.stringify({ idempotencyKey: crypto.randomUUID(), ...body }),
  }
  // A connection that doesn't open is tried again (on a poor network one in two can time
  // out). The idempotency key is the same each time, so Circle acts on the request once.
  let r
  for (let attempt = 1; !r; attempt++) {
    try {
      r = await fetch(API + path, { ...init, signal: AbortSignal.timeout(6000) })
    } catch (e) {
      if (attempt === 3) throw new Error("couldn't reach Circle; check the connection and try again")
    }
  }
  const out = await r.json().catch(() => ({}))
  if (!r.ok) throw new CircleError(r.status, out.code, out.message)
  return out.data ?? {}
}

// Circle keeps testnets and mainnets apart: a test key (TEST_API_KEY:...) only works on
// testnets and a live key only on mainnets, each with its own app id, users and wallets.
// The site serves both networks, so it holds one key for each: CIRCLE_API_KEY_TEST for
// testnets and CIRCLE_API_KEY_MAIN for mainnet. A key in the wrong variable is ignored
// (its prefix says which kind it is) rather than sent to an environment that rejects it.
const KEY_VARS = {
  testnet: ["CIRCLE_API_KEY_TEST", "CIRCLE_APP_ID_TEST"],
  mainnet: ["CIRCLE_API_KEY_MAIN", "CIRCLE_APP_ID_MAIN"],
}
const isTestKey = (key) => key.startsWith("TEST_API_KEY")

/// What serves `chainId`: { key, appIdVar, chains }, or null if no key here covers it.
/// `chains` are the Circle "blockchains" the user's wallets are created on.
export function circleFor(env, chainId) {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return null
  const testnet = !MAINNETS.has(chainId)
  const [keyVar, appIdVar] = testnet ? KEY_VARS.testnet : KEY_VARS.mainnet
  const key = String(env[keyVar] ?? "")
  if (!key || isTestKey(key) !== testnet) return null
  return { key, appId: env[appIdVar], chains: blockchainsFor(testnet, chainId) }
}

// A user's wallets for an election chain: the chain's own entry, where Circle knows the chain, plus
// the generic EVM one: Circle only signs raw transactions (which deploying an election
// needs) with a generic-EVM wallet. A user's wallets share one address on every EVM chain.
function blockchainsFor(testnet, chainId) {
  return [ARC[chainId], testnet ? "EVM-TESTNET" : "EVM"].filter(Boolean)
}

// The App ID is public (the browser SDK needs it) and fixed per key.
const appIds = new Map()
async function appId(c) {
  if (c.appId) return c.appId
  if (!appIds.has(c.key)) appIds.set(c.key, (await circle(c.key, "/config/entity")).appId)
  return appIds.get(c.key)
}

const str = (v, max = 4096) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null)

const ACTIONS = {
  // Step 1 of email sign-in: Circle emails a one-time code to `email`.
  // -> { deviceToken, deviceEncryptionKey, otpToken } for the browser SDK's code prompt.
  async emailToken(c, b) {
    const deviceId = str(b.deviceId, 200)
    const email = str(b.email, 320)?.trim()
    if (!deviceId) return json(400, { error: "deviceId is missing" })
    if (!email || !EMAIL_RE.test(email)) return json(400, { error: "that doesn't look like an email address" })
    return json(200, await circle(c.key, "/users/email/token", { method: "POST", body: { deviceId, email } }))
  },

  // Step 1 of Google sign-in. -> { deviceToken, deviceEncryptionKey }
  async socialToken(c, b) {
    const deviceId = str(b.deviceId, 200)
    if (!deviceId) return json(400, { error: "deviceId is missing" })
    return json(200, await circle(c.key, "/users/social/token", { method: "POST", body: { deviceId } }))
  },

  // A session token lasts an hour. -> { userToken, encryptionKey, refreshToken }
  async refresh(c, b) {
    const [userToken, refreshToken, deviceId] = [str(b.userToken), str(b.refreshToken), str(b.deviceId, 200)]
    if (!userToken || !refreshToken || !deviceId) return json(400, { error: "userToken, refreshToken and deviceId are required" })
    return json(200, await circle(c.key, "/users/token/refresh", { method: "POST", userToken, body: { refreshToken, deviceId } }))
  },

  // The signed-in user's wallet for an election chain.
  // -> { address, typedDataWalletId, transactionWalletId } once it exists. If it doesn't:
  //    { challengeId } for the browser SDK to run, which creates it; or {} when called
  //    with create: false, which is how the browser waits for a wallet being created
  //    (asking to create it twice would make two).
  async wallet(c, b) {
    const userToken = str(b.userToken)
    const chains = c.chains
    if (!userToken) return json(400, { error: "userToken is missing" })

    let wallets = []
    try {
      wallets = (await circle(c.key, "/wallets?pageSize=50", { userToken })).wallets ?? []
    } catch (e) {
      // A user who has never been set up has no wallet list yet. A bad token is another matter.
      if (e.status === 401 || e.status === 403 || e.code === TOKEN_EXPIRED) throw e
    }
    const mine = (chain) => wallets.find((w) => w.blockchain === chain && w.accountType === "EOA" && w.state === "LIVE")
    const generic = mine(chains.at(-1))
    if (generic) {
      const local = chains.length > 1 && mine(chains[0])
      const sameKey = local && local.address.toLowerCase() === generic.address.toLowerCase()
      return json(200, { address: generic.address, transactionWalletId: generic.id, typedDataWalletId: sameKey ? local.id : generic.id })
    }
    if (b.create === false) return json(200, {})
    const want = { accountType: "EOA", blockchains: chains }
    try {
      return json(200, await circle(c.key, "/user/initialize", { method: "POST", userToken, body: want }))
    } catch (e) {
      if (e.code !== ALREADY_INITIALIZED) throw e
      // Set up before (on another network): add this network's wallets.
      const missing = chains.filter((c) => !mine(c))
      return json(200, await circle(c.key, "/user/wallets", { method: "POST", userToken, body: { ...want, blockchains: missing } }))
    }
  },

  // Ask the user to sign EIP-712 typed data (registration, username). -> { challengeId }
  async signTypedData(c, b) {
    const [userToken, walletId, data] = [str(b.userToken), str(b.walletId, 64), str(b.data, 20000)]
    if (!userToken || !walletId || !UUID_RE.test(walletId) || !data) return json(400, { error: "userToken, walletId and data are required" })
    const body = { walletId, data, ...(str(b.memo, 200) ? { memo: b.memo } : {}) }
    return json(200, await circle(c.key, "/user/sign/typedData", { method: "POST", userToken, body }))
  },

  // Ask the user to sign a transaction (deploying an election). The browser broadcasts it
  // itself. -> { challengeId }
  async signTransaction(c, b) {
    const [userToken, walletId] = [str(b.userToken), str(b.walletId, 64)]
    const tx = str(b.rawTransaction, 200000) ? { rawTransaction: b.rawTransaction } : str(b.transaction, 200000) ? { transaction: b.transaction } : null
    if (!userToken || !walletId || !UUID_RE.test(walletId) || !tx) return json(400, { error: "userToken, walletId and a transaction are required" })
    const body = { walletId, ...tx, ...(str(b.memo, 200) ? { memo: b.memo } : {}) }
    return json(200, await circle(c.key, "/user/sign/transaction", { method: "POST", userToken, body }))
  },
}

async function config(request, env) {
  const chainId = Number(new URL(request.url).searchParams.get("chainId"))
  const c = circleFor(env, chainId)
  if (!c) return json(200, { available: false })
  return json(200, { available: true, appId: await appId(c), google: env.GOOGLE_CLIENT_ID || null })
}

export async function onRequest({ request, env }) {
  try {
    if (request.method === "GET") return await config(request, env)
    if (request.method !== "POST") return json(405, { error: "method not allowed" })
    let body
    try {
      body = await request.json()
    } catch {
      return json(400, { error: "body must be JSON" })
    }
    const action = Object.hasOwn(ACTIONS, body?.action) ? ACTIONS[body.action] : null
    if (!action) return json(400, { error: "unknown action" })
    // Every call names its network, which decides the key (test or live) it is made with.
    const c = circleFor(env, Number(body.chainId))
    if (!c) return json(400, { error: "email sign-in isn't available on this network" })
    return await action(c, body)
  } catch (e) {
    if (e instanceof CircleError) {
      // 401 tells the browser its session is over (it then refreshes, or asks to sign in again).
      const expired = e.status === 401 || e.status === 403 || e.code === TOKEN_EXPIRED
      return json(expired ? 401 : e.status >= 500 ? 502 : 400, { error: e.message, code: e.code })
    }
    return json(500, { error: e.message })
  }
}
