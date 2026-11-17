// Headless check of the site's flow against a running relayer + LOCAL anvil:
// two anvil dev wallets sign registrations, time is warped to voting, both vote
// with real proofs via the relayer, and a replay is rejected.
//
//   node smoke-test.mjs   (after deploy_election.py whitelisting anvil #2 and #3, and relayer.py)

import { ethers } from "ethers"
import { Identity } from "@semaphore-protocol/identity"
import { Group } from "@semaphore-protocol/group"
import { generateProof } from "@semaphore-protocol/proof"

const RELAYER = process.env.RELAYER_URL ?? "http://localhost:8787"
const KEYS = [
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // anvil #2
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", // anvil #3
]
const ABI = [
  "function phase() view returns (string)",
  "function votingStart() view returns (uint256)",
  "function scope() view returns (uint256)",
  "function tally() view returns (uint256[])",
  "function nullifierUsed(uint256) view returns (bool)",
  "event Registered(address indexed wallet, uint256 identityCommitment)",
]
const post = async (path, body) =>
  (await fetch(RELAYER + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)) })).json()

const cfg = await (await fetch(`${RELAYER}/config`)).json()
const provider = new ethers.JsonRpcProvider(cfg.rpcUrl, undefined, { cacheTimeout: -1 })
const election = new ethers.Contract(cfg.election, ABI, provider)
console.log(`election ${cfg.election} (${cfg.kind}), phase ${await election.phase()}`)

const domain = { name: "goblet Election", version: "1", chainId: cfg.chainId, verifyingContract: cfg.election }
const types = { Register: [{ name: "wallet", type: "address" }, { name: "identityCommitment", type: "uint256" }] }
const ids = []
for (const k of KEYS) {
  const w = new ethers.Wallet(k)
  const id = new Identity()
  ids.push(id)
  const signature = await w.signTypedData(domain, types, { wallet: w.address, identityCommitment: id.commitment })
  console.log("register", w.address, await post("/register", { wallet: w.address, identityCommitment: id.commitment, signature }))
}
console.log("bad sig ->", await post("/register", { wallet: new ethers.Wallet(KEYS[0]).address, identityCommitment: 5, signature: "0x" + "11".repeat(65) }))

await provider.send("evm_setNextBlockTimestamp", [Number(await election.votingStart())])
await provider.send("evm_mine", [])
console.log("phase", await election.phase())

const events = await election.queryFilter(election.filters.Registered(), cfg.deployBlock)
const group = new Group(events.map((e) => e.args.identityCommitment))
const scope = await election.scope()
const ballots = cfg.kind === "ranked" ? [[1, 0], [1]] : [1, 2]
const pack = (r) => r.reduce((acc, c, i) => acc | (BigInt(c + 1) << BigInt(8 * i)), 0n)
let last
for (let i = 0; i < ids.length; i++) {
  const msg = cfg.kind === "ranked" ? pack(ballots[i]) : ballots[i]
  const proof = await generateProof(ids[i], group, msg, scope)
  last = { proof, ...(cfg.kind === "ranked" ? { ranking: ballots[i] } : {}) }
  const res = await post("/vote", last)
  console.log("vote", i, res, "nullifierUsed:", await election.nullifierUsed(proof.nullifier))
}
console.log("replay ->", await post("/vote", last))
console.log("garbage ->", await post("/vote", { proof: { points: [1] } }))
console.log("tally", (await election.tally()).map(Number))
process.exit(0)
