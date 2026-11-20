// Tests for functions/api/elections.js with the database and the chain replaced by
// in-memory stand-ins.
//   node test-elections.mjs
// Checks that only what the chain confirms is stored, and who sees which election.

import { Interface, Wallet } from "ethers"
import { readFileSync } from "node:fs"
import { onRequest } from "./functions/api/elections.js"

const CONTRACTS = JSON.parse(readFileSync(new URL("./contracts.json", import.meta.url)))
const cfg = JSON.parse(readFileSync(new URL("./public/election.json", import.meta.url)))
const abi = new Interface([
  "function semaphore() view returns (address)",
  "function title() view returns (string)",
  "function creator() view returns (address)",
  "function registrationEnd() view returns (uint256)",
  "function votingStart() view returns (uint256)",
  "function votingEnd() view returns (uint256)",
  "function isWhitelisted(address) view returns (bool)",
])

// --- the chain: address -> { code, semaphore, title, creator, times, whitelist } ---
const chain = new Map()
function ethCall({ to, data }) {
  const c = chain.get(to)
  const fn = abi.parseTransaction({ data })
  const value = fn.name === "isWhitelisted" ? c.whitelist.includes(fn.args[0].toLowerCase()) : c[fn.name]
  return abi.encodeFunctionResult(fn.name, [value])
}
let rpcDown = false
function rpc(batch) {
  if (rpcDown) return new Response("down", { status: 503 })
  return Response.json(
    batch.map((c) => ({ jsonrpc: "2.0", id: c.id, result: c.method === "eth_getCode" ? (chain.get(c.params[0])?.code ?? "0x") : ethCall(c.params[0]) })).reverse()
  )
}

// --- the Supabase REST API (only the calls the function makes) ---
const elections = new Map() // address -> row
const voters = new Set() // "election wallet"
function database(u, init) {
  const table = u.pathname.split("/").pop()
  const q = u.searchParams
  if (init.method === "POST") {
    const body = JSON.parse(init.body)
    if (table === "elections") elections.set(body.address, body)
    else for (const r of body) voters.add(`${r.election} ${r.wallet}`)
    return new Response(null, { status: 201 })
  }
  if (table === "election_voters") {
    const wallet = q.get("wallet").replace("eq.", "")
    return Response.json([...voters].map((v) => v.split(" ")).filter(([, w]) => w === wallet).map(([election]) => ({ election })))
  }
  const cutoff = Number(q.get("voting_end").replace("gte.", ""))
  const or = q.get("or")
  const creator = (or ? /creator\.eq\.(0x[0-9a-f]{40})/.exec(or)[1] : q.get("creator").replace("eq.", ""))
  const addresses = or ? /address\.in\.\(([^)]*)\)/.exec(or)[1].split(",") : []
  return Response.json(
    [...elections.values()].filter((e) => e.voting_end >= cutoff && (e.creator === creator || addresses.includes(e.address))).sort((a, b) => a.voting_end - b.voting_end)
  )
}

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url)
  return u.origin === "http://db.test" ? database(u, init) : u.href === new URL(cfg.rpcUrl).href ? rpc(JSON.parse(init.body)) : new Response("?", { status: 404 })
}
const env = { SUPABASE_URL: "http://db.test", SUPABASE_SECRET_KEY: "test" }

let failures = 0
const check = (ok, msg) => {
  if (!ok) failures++
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${msg}`)
}
const call = async (method, query = "", body) => {
  const r = await onRequest({ request: new Request(`http://site.test/api/elections${query}`, { method, body: body && JSON.stringify(body) }), env })
  return { status: r.status, ...(await r.json()) }
}
const addr = () => Wallet.createRandom().address
const now = Math.floor(Date.now() / 1000)
const deploy = (over = {}) => {
  const address = addr().toLowerCase()
  chain.set(address, {
    code: CONTRACTS.fptp.deployedBytecode,
    semaphore: cfg.semaphore,
    title: "Club president",
    creator: carol,
    registrationEnd: now + 600,
    votingStart: now + 600,
    votingEnd: now + 3600,
    whitelist: [alice, bob].map((a) => a.toLowerCase()),
    ...over,
  })
  return address
}
const forWallet = (w) => call("GET", `?chainId=${cfg.chainId}&wallet=${w}`)

const [alice, bob, carol, mallory] = [addr(), addr(), addr(), addr()]

const first = deploy()
let r = await call("POST", "", { chainId: cfg.chainId, address: first, voters: [alice, bob, mallory] })
check(r.status === 200 && r.voters === 2, "an election is listed with only the voters the chain confirms")

r = await forWallet(alice)
check(r.status === 200 && r.elections.length === 1 && r.elections[0].address === first && r.elections[0].whitelisted && !r.elections[0].created, "a whitelisted wallet sees it")
check(r.elections[0].title === "Club president" && r.elections[0].kind === "fptp" && r.elections[0].votingEnd === now + 3600, "with the title, type and schedule read from the chain")
r = await forWallet(mallory)
check(r.status === 200 && r.elections.length === 0, "a wallet that only claimed to be whitelisted does not")
r = await forWallet(carol)
check(r.elections.length === 1 && r.elections[0].created && !r.elections[0].whitelisted, "the creator sees it without being a voter")

r = await call("POST", "", { chainId: cfg.chainId, address: first, voters: [alice] })
check(r.status === 200 && (await forWallet(alice)).elections.length === 1, "listing it again changes nothing")

const fake = deploy({ code: "0x6001600155" })
r = await call("POST", "", { chainId: cfg.chainId, address: fake, voters: [alice] })
check(r.status === 404 && !elections.has(fake), "a contract that isn't a Goblett election is refused")
r = await call("POST", "", { chainId: cfg.chainId, address: addr(), voters: [] })
check(r.status === 404, "so is an address with no contract")
const otherSemaphore = deploy({ semaphore: addr() })
r = await call("POST", "", { chainId: cfg.chainId, address: otherSemaphore, voters: [alice] })
check(r.status === 404 && !elections.has(otherSemaphore), "and an election on an unknown Semaphore")

const ranked = deploy({ code: CONTRACTS.ranked.deployedBytecode, title: "Board seats", votingEnd: now + 7200, whitelist: [alice.toLowerCase()] })
await call("POST", "", { chainId: cfg.chainId, address: ranked, voters: [alice] })
const old = deploy({ title: "Last year", registrationEnd: now - 90 * 86400, votingStart: now - 90 * 86400, votingEnd: now - 60 * 86400 })
await call("POST", "", { chainId: cfg.chainId, address: old, voters: [alice] })
r = await forWallet(alice)
check(r.elections.length === 2 && r.elections[1].address === ranked && r.elections[1].kind === "ranked", "a wallet sees all its current elections, soonest to end first")
check(!r.elections.some((e) => e.address === old), "an election that ended long ago is not listed")
r = await forWallet(bob)
check(r.elections.length === 1 && r.elections[0].address === first, "another voter sees only the ones whitelisting them")

r = await call("POST", "", { chainId: 1, address: first, voters: [] })
check(r.status === 400, "an unknown chain is refused")
r = await call("POST", "", { chainId: cfg.chainId, address: first, voters: ["0x123);drop"] })
check(r.status === 400, "malformed voters are refused before reaching the chain")
r = await call("POST", "", { chainId: cfg.chainId, address: first, voters: Array.from({ length: 201 }, addr) })
check(r.status === 400, "too many voters in one request are refused")
r = await call("GET", `?chainId=${cfg.chainId}&wallet=0x12`)
check(r.status === 400, "a malformed wallet is refused")
rpcDown = true
r = await call("POST", "", { chainId: cfg.chainId, address: deploy(), voters: [alice] })
check(r.status === 502, "a chain outage is reported, and nothing is stored")
r = await call("DELETE")
check(r.status === 405, "other methods are refused")

console.log(failures ? `${failures} FAILURE(S)` : "ALL PASSED")
process.exit(failures ? 1 : 0)
