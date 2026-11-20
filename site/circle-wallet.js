// Sign in with an email code or Google instead of a wallet extension, through Circle's
// user-controlled wallets. Circle makes the user a wallet whose key is split between this
// device and Circle; the user sees an inbox code and a "confirm" window, never a seed
// phrase. The server half is functions/api/circle.js (it holds our Circle API key).
//
// circleProvider() wraps a signed-in session in the same EIP-1193 interface MetaMask
// has (request({ method, params })), so main.js signs registrations and deploys elections
// the same way with either. Everything the wallet doesn't decide (reads, gas estimates,
// receipts) goes to the chain's RPC.
//
// As with MetaMask, none of this is used to cast a vote: voting needs no wallet.

import { ethers } from "ethers"

const SESSION = "goblett:circle" // the signed-in session
const DEVICE = "goblett:circle:device" // Circle's id for this browser
const REDIRECT = "goblett:circle:redirect" // a Google sign-in in progress (the page leaves and comes back)
const CANCELLED = 4001 // "the user said no", as MetaMask reports it
const USER_CANCELED = 155701 // the same, as Circle reports it

const load = (key) => {
  try {
    return JSON.parse(localStorage.getItem(key))
  } catch {
    return null
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Google sends the browser back to /app.html with the sign-in result in the URL's hash
// and nothing else. If the visitor left from /app.html?network=testnet, go back to exactly
// that before the page reads which network it is on (main.js does at load).
const returning = load(REDIRECT)
if (returning && /(^#|&)state=/.test(location.hash) && returning.search !== location.search) {
  location.replace(location.pathname + returning.search + location.hash)
}

async function api(body, query = "") {
  const r = await fetch(`/api/circle${query}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined)
  const out = await r.json().catch(() => ({ error: `sign-in service unavailable (HTTP ${r.status})` }))
  if (!r.ok) throw Object.assign(new Error(out.error ?? `sign-in service error (HTTP ${r.status})`), { status: r.status, circleCode: out.code })
  return out
}

/// { available, appId, google } for a chain: whether email sign-in works there, and the
/// Google client id if Google sign-in is set up.
const configs = new Map()
export function circleConfig(chainId) {
  if (!configs.has(chainId)) {
    configs.set(
      chainId,
      api(null, `?chainId=${chainId}`).catch(() => {
        configs.delete(chainId)
        return { available: false }
      })
    )
  }
  return configs.get(chainId)
}

// ---------------------------------------------------------------------------
// Circle's Web SDK: a window (an iframe on pw-auth.circle.com) where the user types the
// emailed code and confirms signatures. Loaded only when someone signs in this way.
// ---------------------------------------------------------------------------
let login // { resolve, reject } while a sign-in is waiting for Circle's answer
function onLoginComplete(error, result) {
  if (result?.userToken) login?.resolve(result)
  else if (error) login?.reject(error)
}

/// Tests put a stand-in for the SDK's class here (the real one needs a browser).
export const testing = { Sdk: null }

// The SDK keeps one instance; constructing it again replaces its settings.
async function sdkWith(appId, loginConfigs) {
  const mod = testing.Sdk ? { W3SSdk: testing.Sdk } : await import("@circle-fin/w3s-pw-web-sdk")
  const W3SSdk = mod.W3SSdk ?? mod.default.W3SSdk
  return new W3SSdk({ appSettings: { appId }, ...(loginConfigs ? { loginConfigs } : {}) }, onLoginComplete)
}

async function deviceId(sdk) {
  let id = localStorage.getItem(DEVICE)
  if (!id) localStorage.setItem(DEVICE, (id = await sdk.getDeviceId()))
  return id
}

const toError = (e) => Object.assign(new Error(e?.message || "Circle couldn't complete that"), { code: e?.code === USER_CANCELED ? CANCELLED : e?.code })

// Closing Circle's window tells the SDK nothing we can await. Watch for the window going
// away instead, and treat that as "cancelled" unless a result arrived first.
function onWindowClosed(sdk, cancelled) {
  let gone = 0
  const timer = setInterval(() => {
    gone = document.getElementById("sdkIframe") ? 0 : gone + 1
    if (gone >= 2) cancelled(Object.assign(new Error("cancelled"), { code: CANCELLED }))
  }, 300)
  return () => {
    clearInterval(timer)
    sdk.closeModal()
    sdk.unSubscribeMessage()
  }
}

// Run a challenge (create the wallet, sign something) in Circle's window.
async function execute(session, challengeId) {
  const sdk = await sdkWith(session.appId, session.login)
  sdk.setAuthentication({ userToken: session.userToken, encryptionKey: session.encryptionKey })
  let stop
  try {
    return await new Promise((resolve, reject) => {
      sdk.execute(challengeId, (error, result) => {
        if (error) reject(toError(error))
        else if (result?.status === "FAILED" || result?.status === "EXPIRED") reject(new Error("Circle couldn't complete that. Try again."))
        else resolve(result)
      })
      stop = onWindowClosed(sdk, reject)
    })
  } finally {
    stop?.()
  }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
const save = (session) => localStorage.setItem(SESSION, JSON.stringify(session))

/// The session saved in this browser for `chainId`, if someone is signed in this way.
export function savedSession(chainId) {
  const s = load(SESSION)
  return s?.chainId === chainId && s.address && s.userToken ? s : null
}

export function forgetSession() {
  localStorage.removeItem(SESSION)
}

// A call that needs the user's session token. Tokens last an hour; one that has run out
// is renewed once, and if that fails too the session is over.
async function call(session, body) {
  try {
    return await api({ ...body, userToken: session.userToken })
  } catch (e) {
    if (e.status !== 401) throw e
    try {
      const fresh = await api({ action: "refresh", userToken: session.userToken, refreshToken: session.refreshToken, deviceId: session.deviceId })
      session.userToken = fresh.userToken
      if (fresh.encryptionKey) session.encryptionKey = fresh.encryptionKey
      if (fresh.refreshToken) session.refreshToken = fresh.refreshToken
      if (savedSession(session.chainId)) save(session)
    } catch {
      forgetSession()
      throw Object.assign(new Error("You've been signed out. Sign in again to continue."), { code: "SIGNED_OUT" })
    }
    return api({ ...body, userToken: session.userToken })
  }
}

// After Circle has verified who the user is: find their wallet, creating it the first time.
async function openSession(session) {
  const use = (w) => {
    Object.assign(session, { address: ethers.getAddress(w.address), typedDataWalletId: w.typedDataWalletId, transactionWalletId: w.transactionWalletId })
    save(session)
    return session
  }
  const first = await call(session, { action: "wallet", chainId: session.chainId })
  if (first.address) return use(first)
  await execute(session, first.challengeId)
  // The wallet appears a moment after the challenge completes.
  for (let i = 0; i < 20; i++) {
    const w = await call(session, { action: "wallet", chainId: session.chainId, create: false })
    if (w.address) return use(w)
    await sleep(1500)
  }
  throw new Error("Your account is taking too long to set up. Try signing in again in a minute.")
}

async function configFor(chainId) {
  const cfg = await circleConfig(chainId)
  if (!cfg.available) throw new Error("Email sign-in isn't available on this network.")
  return cfg
}

/// Sign in with a code Circle emails to `email`. Opens Circle's window for the code.
/// Resolves to the session ({ address, label, ... }); rejects with code 4001 if cancelled.
export async function loginWithEmail(chainId, email) {
  const { appId } = await configFor(chainId)
  const device = await deviceId(await sdkWith(appId))
  let tokens, sdk
  const sendCode = async () => {
    tokens = await api({ action: "emailToken", deviceId: device, email })
    sdk = await sdkWith(appId, tokens)
  }
  await sendCode()
  sdk.setOnResendOtpEmail(() => sendCode().catch(() => {}))
  let stop
  try {
    const result = await new Promise((resolve, reject) => {
      // A wrong code is reported here too, but Circle's window stays open to try again.
      login = { resolve, reject() {} }
      sdk.verifyOtp()
      stop = onWindowClosed(sdk, reject)
    })
    stop()
    return await openSession({ chainId, appId, deviceId: device, login: tokens, label: email, userToken: result.userToken, encryptionKey: result.encryptionKey, refreshToken: result.refreshToken })
  } finally {
    login = undefined
    stop?.()
  }
}

/// Sign in with Google. The page leaves for Google and comes back to /app.html, where
/// finishGoogleLogin() picks the sign-in up, so this never resolves.
export async function loginWithGoogle(chainId) {
  const { appId, google } = await configFor(chainId)
  if (!google) throw new Error("Google sign-in isn't set up.")
  const device = await deviceId(await sdkWith(appId))
  const tokens = await api({ action: "socialToken", deviceId: device })
  const loginConfigs = { ...tokens, google: { clientId: google, redirectUri: `${location.origin}/app.html`, selectAccountPrompt: true } }
  localStorage.setItem(REDIRECT, JSON.stringify({ chainId, appId, deviceId: device, login: loginConfigs, search: location.search }))
  ;(await sdkWith(appId, loginConfigs)).performLogin("Google")
  return new Promise(() => {})
}

/// Call once at page load: if the page has just come back from Google, finish that
/// sign-in and resolve to the session; otherwise resolve to null.
export async function finishGoogleLogin(chainId) {
  const saved = load(REDIRECT)
  if (!saved) return null
  localStorage.removeItem(REDIRECT)
  if (saved.chainId !== chainId || !/(^#|&)state=/.test(location.hash)) return null
  try {
    const result = await new Promise((resolve, reject) => {
      login = { resolve, reject: (e) => reject(toError(e)) }
      // Constructing the SDK with the saved settings makes it read the result from the URL.
      sdkWith(saved.appId, saved.login).catch(reject)
      setTimeout(() => reject(new Error("Google sign-in timed out. Try again.")), 30000)
    })
    const label = result.oAuthInfo?.socialUserInfo?.email ?? "Google account"
    return await openSession({ chainId, appId: saved.appId, deviceId: saved.deviceId, login: saved.login, label, userToken: result.userToken, encryptionKey: result.encryptionKey, refreshToken: result.refreshToken })
  } finally {
    login = undefined
  }
}

// ---------------------------------------------------------------------------
// The wallet, as an EIP-1193 provider
// ---------------------------------------------------------------------------
const hex = (n) => ethers.toQuantity(n)

/// `session` from a login or savedSession(); `rpc` an ethers provider for its chain;
/// `onSignedOut` is called if the session turns out to have ended.
export function circleProvider(session, rpc, onSignedOut) {
  const authed = async (body) => {
    try {
      return await call(session, body)
    } catch (e) {
      if (e.code === "SIGNED_OUT") onSignedOut?.()
      throw e
    }
  }

  // What Circle's confirm window says is being signed.
  const MEMOS = { Register: "Register to vote", RegisterOn: "Register to vote", Account: "Set your username" }

  async function signTypedData(json) {
    const memo = MEMOS[JSON.parse(json).primaryType]
    const { challengeId } = await authed({ action: "signTypedData", walletId: session.typedDataWalletId, data: json, ...(memo ? { memo } : {}) })
    const signature = (await execute(session, challengeId))?.data?.signature
    if (!signature) throw new Error("Circle returned no signature")
    return signature
  }

  // Circle signs; we fill in the transaction before and broadcast it after.
  async function sendTransaction(tx) {
    const from = session.address
    const request = { from, to: tx.to ?? null, data: tx.data ?? tx.input ?? "0x", value: BigInt(tx.value ?? 0) }
    const [nonce, block, fees, gasLimit] = await Promise.all([
      rpc.getTransactionCount(from, "pending").catch(() => rpc.getTransactionCount(from)),
      rpc.getBlock("latest"),
      rpc.getFeeData(),
      tx.gas != null ? BigInt(tx.gas) : rpc.estimateGas(request).then((g) => (g * 12n) / 10n),
    ])
    const tip = fees.maxPriorityFeePerGas ?? 0n
    const unsigned = ethers.Transaction.from({
      type: 2,
      chainId: session.chainId,
      nonce,
      to: request.to,
      data: request.data,
      value: request.value,
      gasLimit,
      maxPriorityFeePerGas: tip,
      // Room for the base fee to double before this is mined.
      maxFeePerGas: block.baseFeePerGas != null ? 2n * block.baseFeePerGas + tip : (fees.gasPrice ?? tip),
    })

    const ask = (form) => authed({ action: "signTransaction", walletId: session.transactionWalletId, memo: request.to ? "Send a transaction" : "Create your election", ...form })
    let challenge
    try {
      challenge = await ask({ rawTransaction: unsigned.unsignedSerialized })
    } catch (e) {
      if (e.status !== 400) throw e
      // The same transaction, spelled out field by field.
      const fields = { type: 2, chainId: session.chainId, nonce: hex(nonce), value: hex(request.value), gas: hex(gasLimit), maxFeePerGas: hex(unsigned.maxFeePerGas), maxPriorityFeePerGas: hex(tip), data: request.data }
      challenge = await ask({ transaction: JSON.stringify(request.to ? { ...fields, to: request.to } : fields) })
    }
    const out = (await execute(session, challenge.challengeId))?.data
    let signed
    if (out?.signedTransaction) signed = ethers.Transaction.from(out.signedTransaction)
    else if (out?.signature) signed = Object.assign(unsigned.clone(), { signature: out.signature })
    else throw new Error("Circle returned no signed transaction")
    // Broadcast only exactly what was asked for, signed by this account.
    if (signed.unsignedHash !== unsigned.unsignedHash || signed.from !== from) throw new Error("Circle signed something other than the transaction that was requested")
    return (await rpc.broadcastTransaction(signed.serialized)).hash
  }

  return {
    isCircle: true,
    async request({ method, params = [] }) {
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [session.address]
        case "eth_chainId":
          return hex(session.chainId)
        // Always on the election's chain, and this site is always allowed.
        case "wallet_switchEthereumChain":
        case "wallet_addEthereumChain":
          return null
        case "wallet_requestPermissions":
        case "wallet_getPermissions":
          return [{ parentCapability: "eth_accounts" }]
        case "eth_signTypedData_v4":
          return signTypedData(typeof params[1] === "string" ? params[1] : JSON.stringify(params[1]))
        case "eth_sendTransaction":
          return sendTransaction(params[0])
        default:
          return rpc.send(method, params)
      }
    },
  }
}
