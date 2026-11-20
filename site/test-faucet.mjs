// Tests for functions/api/faucet.js with the chain replaced by an in-memory stand-in.
//   node test-faucet.mjs
// Checks that it only sends on the testnet, only to accounts that are short, and that
// what it signs is a plain transfer of the fixed amount from the faucet's own key.

import { Transaction, Wallet, parseEther, toQuantity } from "ethers"
import { readFileSync } from "node:fs"
import { onRequest, AMOUNT } from "./functions/api/faucet.js"

const testnet = JSON.parse(readFileSync(new URL("./public/election.testnet.json", import.meta.url)))
const mainnet = JSON.parse(readFileSync(new URL("./public/election.json", import.meta.url)))
const faucet = Wallet.createRandom()
const env = { FAUCET_PRIVATE_KEY: faucet.privateKey }

const balances = new Map([[faucet.address.toLowerCase(), parseEther("100")]])
const sent = []
let down = false
globalThis.fetch = async (url, init) => {
  if (down || new URL(url).href !== new URL(testnet.rpcUrl).href) return new Response("no", { status: 503 })
  const { method, params } = JSON.parse(init.body)
  const result =
    method === "eth_getBalance" ? toQuantity(balances.get(params[0].toLowerCase()) ?? 0n)
    : method === "eth_getTransactionCount" ? "0x5"
    : method === "eth_getBlockByNumber" ? { baseFeePerGas: toQuantity(20000000000n) }
    : method === "eth_sendRawTransaction" ? (sent.push(Transaction.from(params[0])), sent.at(-1).hash)
    : null
  return Response.json({ jsonrpc: "2.0", id: 1, result })
}

let failures = 0
const check = (ok, msg) => {
  if (!ok) failures++
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${msg}`)
}
const call = async (method, query = "", body, e = env) => {
  const r = await onRequest({ request: new Request(`http://site.test/api/faucet${query}`, { method, body: body && JSON.stringify(body) }), env: e })
  return { status: r.status, ...(await r.json()) }
}
const someone = Wallet.createRandom().address

let r = await call("GET", `?chainId=${testnet.chainId}`)
check(r.available && r.amount === "2.0 USDC", "offered on the testnet, saying how much it gives")
r = await call("GET", `?chainId=${mainnet.chainId}`)
check(r.available === false, "not offered on mainnet")
r = await call("GET", `?chainId=${testnet.chainId}`, undefined, {})
check(r.available === false, "not offered without a key")

r = await call("POST", "", { chainId: testnet.chainId, address: someone })
const tx = sent.at(-1)
check(r.status === 200 && r.txHash === tx.hash && r.amount === "2.0 USDC", "sends to an account that asks")
check(tx.from === faucet.address && tx.to === someone && tx.value === AMOUNT && tx.data === "0x" && tx.chainId === BigInt(testnet.chainId) && tx.nonce === 5, "as a plain transfer of the fixed amount, from the faucet, on the testnet")

r = await call("POST", "", { chainId: mainnet.chainId, address: someone })
check(r.status === 400 && sent.length === 1, "refuses mainnet")
r = await call("POST", "", { chainId: testnet.chainId, address: "0x123" })
check(r.status === 400 && sent.length === 1, "refuses a malformed address")
balances.set(someone.toLowerCase(), parseEther("1.5"))
r = await call("POST", "", { chainId: testnet.chainId, address: someone })
check(r.status === 429 && sent.length === 1, "refuses an account that already has enough")
balances.set(someone.toLowerCase(), 0n)
balances.set(faucet.address.toLowerCase(), parseEther("1"))
r = await call("POST", "", { chainId: testnet.chainId, address: someone })
check(r.status === 503 && /empty/.test(r.error) && sent.length === 1, "says so when it has run dry")
down = true
r = await call("POST", "", { chainId: testnet.chainId, address: someone })
check(r.status === 502 && sent.length === 1, "reports a chain outage")
r = await call("DELETE")
check(r.status === 405, "other methods are refused")

console.log(failures ? `${failures} FAILURE(S)` : "ALL PASSED")
process.exit(failures ? 1 : 0)
