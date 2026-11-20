// Tests for functions/api/circle.js (with Circle's API replaced by a stand-in) and for the
// wallet stand-in in circle-wallet.js (with the server and Circle's window replaced).
//   node test-circle.mjs
// Checks which Circle calls the server will make for a browser, that it creates a wallet
// once and only once, and that a transaction is broadcast only if Circle signed exactly
// what was asked.

import { ethers } from "ethers"
import { onRequest } from "./functions/api/circle.js"

let failures = 0
const check = (ok, msg) => {
  if (!ok) failures++
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${msg}`)
}

// ---------------------------------------------------------------------------
// The server function
// ---------------------------------------------------------------------------
const TESTNET = 5042002
const MAINNET = 5042
const user = { wallets: [], initialized: false, token: "token-1", refreshToken: "refresh-1" } // one Circle user
const calls = [] // every request "Circle" received
const circle = async (url, init = {}) => {
  const u = new URL(url)
  const path = u.pathname.replace("/v1/w3s", "")
  const body = init.body ? JSON.parse(init.body) : undefined
  const headers = init.headers ?? {}
  calls.push({ method: init.method ?? "GET", path, body, headers })
  const reply = (status, data) => new Response(JSON.stringify(status < 300 ? { data } : data), { status })
  if (headers.Authorization !== "Bearer TEST_API_KEY:id:secret" && headers.Authorization !== "Bearer LIVE_API_KEY:id:secret") return reply(401, { code: 401, message: "bad key" })
  if (path === "/config/entity") return reply(200, { appId: "app-1" })
  if (path === "/users/email/token") return reply(200, { deviceToken: "dt", deviceEncryptionKey: "dek", otpToken: "otp" })
  if (path === "/users/social/token") return reply(200, { deviceToken: "dt", deviceEncryptionKey: "dek" })
  // Everything else is the user's own.
  if (path === "/users/token/refresh") {
    if (body.refreshToken !== user.refreshToken) return reply(400, { code: 155105, message: "bad refresh token" })
    user.token += "+"
    user.refreshToken += "+"
    return reply(200, { userToken: user.token, encryptionKey: "ek-new", refreshToken: user.refreshToken })
  }
  if (headers["X-User-Token"] !== user.token) return reply(403, { code: 155104, message: "token expired" })
  if (path === "/wallets") return reply(200, { wallets: user.wallets })
  if (path === "/user/initialize") {
    if (user.initialized) return reply(409, { code: 155106, message: "already initialized" })
    user.pending = body
    return reply(201, { challengeId: "challenge-init" })
  }
  if (path === "/user/wallets") {
    user.pending = body
    return reply(201, { challengeId: "challenge-wallets" })
  }
  if (path === "/user/sign/typedData") return reply(201, { challengeId: "challenge-typed" })
  if (path === "/user/sign/transaction") return body.rawTransaction && user.refuseRaw ? reply(400, { code: 2, message: "rawTransaction not supported" }) : reply(201, { challengeId: "challenge-tx" })
  return reply(404, { message: "?" })
}
// What running a create-wallet challenge in Circle's window does.
const address = "0x" + "ab".repeat(20)
const runPending = () => {
  user.initialized = true
  for (const blockchain of user.pending.blockchains) user.wallets.push({ id: `0000000${user.wallets.length}-0000-4000-8000-000000000000`, address, blockchain, accountType: user.pending.accountType, state: "LIVE" })
  user.pending = undefined
}

globalThis.fetch = circle
const env = { CIRCLE_API_KEY: "TEST_API_KEY:id:secret" }
const server = async (method, query = "", body, e = env) => {
  const r = await onRequest({ request: new Request(`http://site.test/api/circle${query}`, { method, body: body && JSON.stringify(body) }), env: e })
  return { status: r.status, ...(await r.json()) }
}
const post = (body, e) => server("POST", "", body, e)

console.log("server function")
let r = await server("GET", `?chainId=${TESTNET}`)
check(r.status === 200 && r.available && r.appId === "app-1" && r.google === null, "a test key offers email sign-in on the testnet, with the app id looked up")
r = await server("GET", `?chainId=${MAINNET}`)
check(r.status === 200 && r.available === false, "but not on mainnet")
r = await server("GET", `?chainId=${MAINNET}`, undefined, { CIRCLE_API_KEY: "LIVE_API_KEY:id:secret", CIRCLE_APP_ID: "app-live", GOOGLE_CLIENT_ID: "g-1" })
check(r.available && r.appId === "app-live" && r.google === "g-1", "a live key offers it on mainnet, with Google when a client id is set")
r = await server("GET", `?chainId=${TESTNET}`, undefined, {})
check(r.status === 200 && r.available === false, "no key: not offered at all")

r = await post({ action: "emailToken", deviceId: "device-1", email: "kofi@example.com" })
check(r.status === 200 && r.otpToken === "otp" && calls.at(-1).body.email === "kofi@example.com" && /^[0-9a-f-]{36}$/.test(calls.at(-1).body.idempotencyKey), "an email code is requested for the address given")
const before = calls.length
r = await post({ action: "emailToken", deviceId: "device-1", email: "not an email" })
check(r.status === 400 && calls.length === before, "a malformed email is refused before reaching Circle")
r = await post({ action: "transfer", userToken: user.token })
check(r.status === 400 && calls.length === before, "an action that isn't on the list is refused")
r = await post({ action: "constructor" })
check(r.status === 400, "including names that exist on every object")

r = await post({ action: "wallet", userToken: user.token, chainId: MAINNET })
check(r.status === 400, "no wallet on a network the key doesn't cover")
r = await post({ action: "wallet", userToken: user.token, chainId: TESTNET, create: false })
check(r.status === 200 && !r.address && !r.challengeId && !user.pending, "asking without create never starts a wallet")
r = await post({ action: "wallet", userToken: user.token, chainId: TESTNET })
check(r.challengeId === "challenge-init" && user.pending.accountType === "EOA" && user.pending.blockchains.join() === "ARC-TESTNET,EVM-TESTNET", "a new user gets a challenge that creates EOA wallets for Arc and generic EVM")
runPending()
r = await post({ action: "wallet", userToken: user.token, chainId: TESTNET })
const [arcWallet, evmWallet] = user.wallets
check(r.address === address && r.typedDataWalletId === arcWallet.id && r.transactionWalletId === evmWallet.id && !user.pending, "afterwards the wallet is returned, and nothing more is created")

user.wallets = [arcWallet] // set up on Arc only, e.g. before this network was added
r = await post({ action: "wallet", userToken: user.token, chainId: TESTNET })
check(r.challengeId === "challenge-wallets" && user.pending.blockchains.join() === "EVM-TESTNET", "an existing user only gets the wallet they are missing")
runPending()
user.wallets[1].address = "0x" + "cd".repeat(20)
r = await post({ action: "wallet", userToken: user.token, chainId: TESTNET })
check(r.address === user.wallets[1].address && r.typedDataWalletId === user.wallets[1].id, "wallets with different addresses are never mixed: one key signs everything")
user.wallets = [arcWallet, evmWallet]

r = await post({ action: "wallet", userToken: "stale", chainId: TESTNET })
check(r.status === 401 && !user.pending, "an expired session is reported as such, not treated as a new user")
r = await post({ action: "refresh", userToken: "stale", refreshToken: "refresh-1", deviceId: "device-1" })
check(r.status === 200 && r.userToken === "token-1+" && r.refreshToken === "refresh-1+", "and can be renewed")

r = await post({ action: "signTypedData", userToken: user.token, walletId: arcWallet.id, data: "{}", memo: "Register to vote" })
check(r.challengeId === "challenge-typed" && calls.at(-1).body.walletId === arcWallet.id && calls.at(-1).body.memo === "Register to vote", "typed data to sign becomes a challenge for the user")
r = await post({ action: "signTypedData", userToken: user.token, walletId: "../wallets", data: "{}" })
check(r.status === 400, "a wallet id that isn't an id is refused")
r = await post({ action: "signTransaction", userToken: user.token, walletId: evmWallet.id, rawTransaction: "0x02c0" })
check(r.challengeId === "challenge-tx" && calls.at(-1).body.rawTransaction === "0x02c0" && !("transaction" in calls.at(-1).body), "so does a transaction")
r = await post({ action: "signTransaction", userToken: user.token, walletId: evmWallet.id })
check(r.status === 400, "but not an empty one")
check(calls.every((c) => !JSON.stringify(c.body ?? {}).includes("secret")), "the API key never travels in a request body")
r = await server("DELETE")
check(r.status === 405, "other methods are refused")

// ---------------------------------------------------------------------------
// The wallet stand-in (circle-wallet.js): /api/circle is the function above, and Circle's
// window is replaced by a real key that signs whatever the pending challenge asks.
// ---------------------------------------------------------------------------
console.log("wallet")
const key = new ethers.Wallet("0x" + "11".repeat(32))
user.wallets = [arcWallet, evmWallet].map((w) => ({ ...w, address: key.address }))
const store = new Map()
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }
globalThis.location = { hash: "", search: "", pathname: "/app.html", origin: "http://site.test" }
let iframe = false
globalThis.document = { getElementById: () => (iframe ? {} : null) }
globalThis.fetch = (url, init) => (String(url).startsWith("/api/circle") ? onRequest({ request: new Request(`http://site.test${url}`, init), env }) : circle(url, init))

// Circle's window: signs the last challenge the server was asked for, or does what the test says.
let windowDoes = "sign"
let tamper = false
class W3SSdk {
  setAuthentication(auth) {
    this.auth = auth
  }
  closeModal() {
    iframe = false
  }
  unSubscribeMessage() {}
  execute(challengeId, done) {
    iframe = true
    const asked = calls.findLast((c) => c.path.startsWith("/user/sign/"))
    setTimeout(async () => {
      if (windowDoes === "close") return (iframe = false)
      if (windowDoes === "cancel") return done({ code: 155701, message: "User canceled" })
      if (challengeId === "challenge-typed") {
        const { domain, types, message } = JSON.parse(asked.body.data)
        delete types.EIP712Domain
        return done(undefined, { type: "SIGN_TYPEDDATA", status: "COMPLETE", data: { signature: await key.signTypedData(domain, types, message) } })
      }
      const tx = asked.body.rawTransaction ? ethers.Transaction.from(asked.body.rawTransaction) : ethers.Transaction.from({ ...JSON.parse(asked.body.transaction), gasLimit: JSON.parse(asked.body.transaction).gas, gas: undefined })
      if (tamper) tx.value += 1n
      done(undefined, { type: "SIGN_TRANSACTION", status: "COMPLETE", data: { signedTransaction: await key.signTransaction(tx) } })
    }, 5)
  }
}
const { circleProvider, savedSession, forgetSession, testing } = await import("./circle-wallet.js")
testing.Sdk = W3SSdk

const sent = []
const rpc = {
  getTransactionCount: async () => 7,
  getBlock: async () => ({ baseFeePerGas: 100n }),
  getFeeData: async () => ({ maxPriorityFeePerGas: 3n, gasPrice: 103n }),
  estimateGas: async () => 1000000n,
  broadcastTransaction: async (raw) => (sent.push(ethers.Transaction.from(raw)), { hash: sent.at(-1).hash }),
  send: async (method, params) => ({ method, params }),
}
const session = { chainId: TESTNET, appId: "app-1", deviceId: "device-1", login: {}, label: "kofi@example.com", userToken: user.token, encryptionKey: "ek", refreshToken: user.refreshToken, address: key.address, typedDataWalletId: arcWallet.id, transactionWalletId: evmWallet.id }
localStorage.setItem("goblett:circle", JSON.stringify(session))
let signedOut = 0
const wallet = circleProvider(session, rpc, () => signedOut++)

check((await wallet.request({ method: "eth_accounts" }))[0] === key.address && (await wallet.request({ method: "eth_chainId" })) === "0x4cef52", "reports its account and the election's chain")
check((await wallet.request({ method: "eth_getBalance", params: ["0x1", "latest"] })).method === "eth_getBalance", "passes chain reads to the RPC")

const domain = { name: "goblett Election", version: "1", chainId: TESTNET, verifyingContract: "0x" + "22".repeat(20) }
const types = { Register: [{ name: "wallet", type: "address" }, { name: "identityCommitment", type: "uint256" }] }
const value = { wallet: key.address, identityCommitment: 12345n }
const payload = JSON.stringify(ethers.TypedDataEncoder.getPayload(domain, types, value))
let signature = await wallet.request({ method: "eth_signTypedData_v4", params: [key.address.toLowerCase(), payload] })
check(ethers.verifyTypedData(domain, types, value, signature) === key.address && calls.findLast((c) => c.path === "/user/sign/typedData").body.memo === "Register to vote", "signs a registration the election contract would accept")

windowDoes = "cancel"
let err = await wallet.request({ method: "eth_signTypedData_v4", params: [key.address, payload] }).catch((e) => e)
check(err.code === 4001, "cancelling in Circle's window is reported like a MetaMask rejection")
windowDoes = "close"
err = await wallet.request({ method: "eth_signTypedData_v4", params: [key.address, payload] }).catch((e) => e)
check(err.code === 4001, "and so is just closing the window")
windowDoes = "sign"

// Deploying an election: a contract creation carrying the relayer funding.
const deploy = { from: key.address, data: "0x6001600155", value: ethers.toQuantity(ethers.parseEther("2.5")), gas: "0x2dc6c0" }
let hash = await wallet.request({ method: "eth_sendTransaction", params: [deploy] })
let tx = sent.at(-1)
check(hash === tx.hash && tx.from === key.address && tx.to === null && tx.data === deploy.data && tx.value === ethers.parseEther("2.5"), "deploys a contract with funds attached, signed by the user's key")
check(tx.chainId === BigInt(TESTNET) && tx.nonce === 7 && tx.gasLimit === 3000000n && tx.maxFeePerGas === 203n && tx.maxPriorityFeePerGas === 3n, "on the right chain, with the next nonce and fees with headroom")

user.refuseRaw = true
hash = await wallet.request({ method: "eth_sendTransaction", params: [{ from: key.address, to: "0x" + "33".repeat(20), data: "0x", value: "0x1" }] })
tx = sent.at(-1)
const asJson = JSON.parse(calls.findLast((c) => c.path === "/user/sign/transaction").body.transaction)
check(hash === tx.hash && tx.to.toLowerCase() === "0x" + "33".repeat(20) && tx.gasLimit === 1200000n && asJson.chainId === TESTNET, "falls back to the field-by-field form if Circle won't take the raw one, estimating gas when none is given")
user.refuseRaw = false

tamper = true
const count = sent.length
err = await wallet.request({ method: "eth_sendTransaction", params: [deploy] }).catch((e) => e)
check(/other than/.test(err.message) && sent.length === count, "a signed transaction that differs from the request is not broadcast")
tamper = false

// The hour is up: the token is renewed without the user noticing.
session.userToken = "stale"
signature = await wallet.request({ method: "eth_signTypedData_v4", params: [key.address, payload] })
check(ethers.verifyTypedData(domain, types, value, signature) === key.address && session.userToken === user.token, "an expired session token is renewed and the request retried")
check(savedSession(TESTNET).userToken === user.token && savedSession(TESTNET).encryptionKey === "ek-new" && signedOut === 0, "and the renewed session is saved")
session.userToken = "stale"
session.refreshToken = "spent"
err = await wallet.request({ method: "eth_signTypedData_v4", params: [key.address, payload] }).catch((e) => e)
check(err.code === "SIGNED_OUT" && signedOut === 1 && savedSession(TESTNET) === null, "when it can't be renewed, the user is signed out here")

forgetSession()
console.log(failures ? `${failures} FAILURE(S)` : "ALL PASSED")
process.exit(failures ? 1 : 0)
