// Server function: /api/elections. The list of elections and who each one whitelists.
//
//   GET  /api/elections?chainId=5042&wallet=0x..        -> { elections: [...] }
//        the elections that whitelist `wallet`, or that it created
//   POST /api/elections { chainId, address, voters: [0x..] }   -> { address, voters: n }
//        list an election, and `voters` as wallets it whitelists
//
// Nothing here is taken on the sender's word, so a POST needs no signature: the function
// reads the chain itself. The contract's code must be one of goblett's election types
// using the configured Semaphore, the title and schedule are read from the contract, and
// a voter is stored only if the contract says that wallet is whitelisted. All of it is
// public on-chain data; this table only makes it searchable by wallet.
//
// Like accounts, this is unrelated to casting a vote and is never called while voting.

import { Interface } from "ethers"
import { matchKind } from "../../election-kind.js"
import mainnet from "../../public/election.json" with { type: "json" }
import testnet from "../../public/election.testnet.json" with { type: "json" }
import { ADDRESS_RE, db, json } from "../db.js"

// The chains the site itself is configured for (written by relayer/setup_chain.py).
const CHAINS = new Map([mainnet, testnet].map((c) => [Number(c.chainId), c]))
const MAX_VOTERS = 200 // per POST; a longer whitelist is sent in several
const RPC_BATCH = 100
const KEEP_ENDED_S = 30 * 86400 // ended elections stay listed this long, for the result

const abi = new Interface([
  "function semaphore() view returns (address)",
  "function title() view returns (string)",
  "function creator() view returns (address)",
  "function registrationEnd() view returns (uint256)",
  "function votingStart() view returns (uint256)",
  "function votingEnd() view returns (uint256)",
  "function isWhitelisted(address) view returns (bool)",
])

const dbError = (r) =>
  json(502, { error: r.status === 404 ? "the elections tables do not exist yet: run site/supabase/elections.sql in Supabase" : "database error" })

// JSON-RPC, batched. `calls` is [{ method, params }]; returns the results in order.
async function rpc(url, calls) {
  const out = []
  for (let i = 0; i < calls.length; i += RPC_BATCH) {
    const batch = calls.slice(i, i + RPC_BATCH).map((c, j) => ({ jsonrpc: "2.0", id: j, ...c }))
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(batch) })
    const replies = r.ok ? await r.json() : null
    if (!Array.isArray(replies) || replies.length !== batch.length) throw new Error("chain RPC error")
    const byId = new Map(replies.map((x) => [x.id, x]))
    for (const c of batch) {
      const reply = byId.get(c.id)
      if (!reply || reply.error || typeof reply.result !== "string") throw new Error("chain RPC error")
      out.push(reply.result)
    }
  }
  return out
}

// Contract reads: `reads` is [[functionName, args]]; returns each (single) return value.
async function read(url, address, reads) {
  const results = await rpc(
    url,
    reads.map(([fn, args = []]) => ({ method: "eth_call", params: [{ to: address, data: abi.encodeFunctionData(fn, args) }, "latest"] }))
  )
  return results.map((hex, i) => abi.decodeFunctionResult(reads[i][0], hex)[0])
}

async function list(request, env) {
  const q = new URL(request.url).searchParams
  const chainId = Number(q.get("chainId"))
  const wallet = (q.get("wallet") ?? "").toLowerCase()
  if (!CHAINS.has(chainId)) return json(400, { error: "unknown chainId" })
  if (!ADDRESS_RE.test(wallet)) return json(400, { error: "wallet must be an address" })

  // Values below were validated against strict patterns, or come from our own tables.
  const mine = await db(env, `election_voters?select=election&chain_id=eq.${chainId}&wallet=eq.${wallet}&limit=500`)
  if (!mine.ok) return dbError(mine)
  const votesIn = new Set((await mine.json()).map((r) => r.election))
  const who = votesIn.size ? `or=(creator.eq.${wallet},address.in.(${[...votesIn].join(",")}))` : `creator=eq.${wallet}`
  const cutoff = Math.floor(Date.now() / 1000) - KEEP_ENDED_S
  const r = await db(env, `elections?select=address,title,kind,creator,registration_end,voting_start,voting_end&chain_id=eq.${chainId}&voting_end=gte.${cutoff}&${who}&order=voting_end.asc&limit=200`)
  if (!r.ok) return dbError(r)
  return json(200, {
    elections: (await r.json()).map((e) => ({
      address: e.address,
      title: e.title,
      kind: e.kind,
      registrationEnd: Number(e.registration_end),
      votingStart: Number(e.voting_start),
      votingEnd: Number(e.voting_end),
      whitelisted: votesIn.has(e.address),
      created: e.creator === wallet,
    })),
  })
}

async function add(request, env) {
  let body
  try {
    body = await request.json()
  } catch {
    return json(400, { error: "body must be JSON" })
  }
  const chainId = Number(body?.chainId)
  const cfg = CHAINS.get(chainId)
  const address = String(body?.address ?? "").toLowerCase()
  const voters = [...new Set((Array.isArray(body?.voters) ? body.voters : []).map((v) => String(v).toLowerCase()))]
  if (!cfg) return json(400, { error: "unknown chainId" })
  if (!ADDRESS_RE.test(address)) return json(400, { error: "address must be an address" })
  if (voters.length > MAX_VOTERS || !voters.every((v) => ADDRESS_RE.test(v))) return json(400, { error: `voters must be up to ${MAX_VOTERS} addresses` })

  let kind, semaphore, title, creator, times, listed
  try {
    kind = matchKind((await rpc(cfg.rpcUrl, [{ method: "eth_getCode", params: [address, "latest"] }]))[0])
    if (!kind) return json(404, { error: "there is no Goblett election at that address (yet)" })
    ;[semaphore, title, creator, ...times] = await read(cfg.rpcUrl, address, [["semaphore"], ["title"], ["creator"], ["registrationEnd"], ["votingStart"], ["votingEnd"]])
    listed = await read(cfg.rpcUrl, address, voters.map((v) => ["isWhitelisted", [v]]))
  } catch {
    return json(502, { error: "could not read the election from the chain; try again" })
  }
  if (semaphore.toLowerCase() !== cfg.semaphore.toLowerCase()) return json(404, { error: "that election uses an unknown Semaphore" })
  const [registration_end, voting_start, voting_end] = times.map(Number)
  if (![registration_end, voting_start, voting_end].every(Number.isSafeInteger)) return json(400, { error: "that election's schedule is out of range" })

  const row = { chain_id: chainId, address, title: title.slice(0, 200), kind, creator: creator.toLowerCase(), registration_end, voting_start, voting_end }
  const up = await db(env, "elections?on_conflict=chain_id,address", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify(row) })
  if (!up.ok) return dbError(up)
  const rows = voters.filter((_, i) => listed[i]).map((wallet) => ({ chain_id: chainId, election: address, wallet }))
  if (rows.length) {
    const ins = await db(env, "election_voters?on_conflict=chain_id,election,wallet", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates" }, body: JSON.stringify(rows) })
    if (!ins.ok) return dbError(ins)
  }
  return json(200, { address, voters: rows.length })
}

export async function onRequest({ request, env }) {
  try {
    if (request.method === "GET") return await list(request, env)
    if (request.method === "POST") return await add(request, env)
    return json(405, { error: "method not allowed" })
  } catch (e) {
    return json(500, { error: e.message })
  }
}
