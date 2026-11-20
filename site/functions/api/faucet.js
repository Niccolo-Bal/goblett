// Server function: /api/faucet. Test funds for starting an election on the testnet.
//
//   GET  /api/faucet?chainId=5042002           -> { available, amount }
//   POST /api/faucet { chainId, address }      -> { txHash, amount }
//
// Sends a fixed amount of the testnet's native token (test USDC on Arc Testnet) from a
// wallet whose key is in this function's environment (FAUCET_PRIVATE_KEY). Testnets only:
// the function has no mainnet to send on, whatever key it is given.
//
// There is no account system to rate-limit by, so the limit is the chain itself: an
// address that already holds enough to start an election gets nothing more. That stops
// one address draining the faucet; it doesn't stop someone making many addresses, which
// is acceptable for money that is worth nothing.

import { Wallet, formatEther, getAddress, parseEther, toQuantity } from "ethers"
import testnet from "../../public/election.testnet.json" with { type: "json" }
import { ADDRESS_RE, json } from "../db.js"

// The chains the faucet serves. Mainnet (election.json) is deliberately not among them.
const CHAINS = new Map([[Number(testnet.chainId), testnet]])
const AMOUNT = parseEther("2") // per request
const ENOUGH = parseEther("1") // an address holding this much is refused

async function rpc(url, method, params) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })
  const out = r.ok ? await r.json() : null
  if (!out || out.error || out.result == null) throw new Error(out?.error?.message ?? "chain RPC error")
  return out.result
}

const amountText = (cfg) => `${formatEther(AMOUNT)} ${cfg.nativeCurrency?.symbol ?? ""}`.trim()

function config(request, env) {
  const cfg = CHAINS.get(Number(new URL(request.url).searchParams.get("chainId")))
  if (!cfg || !env.FAUCET_PRIVATE_KEY) return json(200, { available: false })
  return json(200, { available: true, amount: amountText(cfg) })
}

async function send(request, env) {
  let body
  try {
    body = await request.json()
  } catch {
    return json(400, { error: "body must be JSON" })
  }
  const cfg = CHAINS.get(Number(body?.chainId))
  const address = String(body?.address ?? "").toLowerCase()
  if (!cfg) return json(400, { error: "the faucet only works on the testnet" })
  if (!env.FAUCET_PRIVATE_KEY) return json(503, { error: "the faucet isn't set up" })
  if (!ADDRESS_RE.test(address)) return json(400, { error: "address must be an address" })

  const faucet = new Wallet(env.FAUCET_PRIVATE_KEY)
  let txHash
  try {
    const [has, left, nonce, block] = await Promise.all([
      rpc(cfg.rpcUrl, "eth_getBalance", [address, "latest"]),
      rpc(cfg.rpcUrl, "eth_getBalance", [faucet.address, "latest"]),
      rpc(cfg.rpcUrl, "eth_getTransactionCount", [faucet.address, "pending"]).catch(() => rpc(cfg.rpcUrl, "eth_getTransactionCount", [faucet.address, "latest"])),
      rpc(cfg.rpcUrl, "eth_getBlockByNumber", ["latest", false]),
    ])
    if (BigInt(has) >= ENOUGH) return json(429, { error: `that account already has ${formatEther(BigInt(has))} ${cfg.nativeCurrency?.symbol ?? ""}, enough to start an election` })
    const tip = 1000000000n
    const maxFeePerGas = 2n * BigInt(block.baseFeePerGas ?? 0) + tip
    if (BigInt(left) < AMOUNT + 21000n * maxFeePerGas) return json(503, { error: "the faucet is empty" })
    const signed = await faucet.signTransaction({
      type: 2,
      chainId: cfg.chainId,
      nonce: Number(nonce),
      to: getAddress(address),
      value: AMOUNT,
      gasLimit: 21000n,
      maxFeePerGas,
      maxPriorityFeePerGas: tip,
    })
    txHash = await rpc(cfg.rpcUrl, "eth_sendRawTransaction", [signed])
  } catch (e) {
    // Two requests at once can pick the same nonce; the second is told to retry.
    return json(502, { error: `the faucet couldn't send right now (${e.message}); try again in a moment` })
  }
  return json(200, { txHash, amount: amountText(cfg) })
}

export async function onRequest({ request, env }) {
  try {
    if (request.method === "GET") return config(request, env)
    if (request.method === "POST") return await send(request, env)
    return json(405, { error: "method not allowed" })
  } catch (e) {
    return json(500, { error: e.message })
  }
}

export { AMOUNT, ENOUGH }
