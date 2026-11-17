// Headless check of the site's flow (over Nostr) against a running relayer + LOCAL anvil:
// deploys a fresh election the way the site's "Create election" form does, two anvil dev
// wallets sign registrations, time is warped to voting, both vote with real proofs via
// the relayer, and a replay is rejected.
//
//   node smoke-test.mjs [fptp|ranked]   (after setup_chain.py, with relayer.py running)

import { ethers } from "ethers"
import { Identity } from "@semaphore-protocol/identity"
import { Group } from "@semaphore-protocol/group"
import { generateProof } from "@semaphore-protocol/proof"
import { readFileSync } from "node:fs"
import { publish, confirm } from "./nostr.js"

const KEYS = [
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // anvil #2
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", // anvil #3
]
const ABI = [
  "function phase() view returns (string)",
  "function MAX_CANDIDATES() view returns (uint256)",
  "function hasRegistered(address) view returns (bool)",
  "function votingStart() view returns (uint256)",
  "function scope() view returns (uint256)",
  "function tally() view returns (uint256[])",
  "function nullifierUsed(uint256) view returns (bool)",
  "event Registered(address indexed wallet, uint256 identityCommitment)",
]
const cfg = JSON.parse(readFileSync(new URL("./public/election.json", import.meta.url)))
const CONTRACTS = JSON.parse(readFileSync(new URL("./contracts.json", import.meta.url)))
cfg.kind = process.argv[2] ?? "fptp"
// Publish to the election's Nostr topic, then wait for the chain (or a relayer's error reply).
const post = async (body, onChain) => {
  const sent = await publish(cfg, body)
  return confirm(cfg, sent.id, onChain, 40000).catch((e) => ({ ok: false, error: e.message }))
}
const provider = new ethers.JsonRpcProvider(cfg.rpcUrl, undefined, { cacheTimeout: -1 })
const never = async () => false

// Deploy like the site does: contracts.json bytecode, votingStart = registrationEnd.
const deployer = new ethers.Wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", provider) // anvil #0
const now = Math.max((await provider.getBlock("pending")).timestamp, (await provider.getBlock("latest")).timestamp)
const factory = new ethers.ContractFactory(CONTRACTS[cfg.kind].abi, CONTRACTS[cfg.kind].bytecode, deployer)
const deployTx = await factory.getDeployTransaction(cfg.semaphore, "Smoke test", ["Alice", "Bob", "Carol"], KEYS.map((k) => new ethers.Wallet(k).address), now + 600, now + 600, now + 2400, 2)
const rcpt = await (await deployer.sendTransaction(deployTx)).wait()
cfg.election = rcpt.contractAddress
cfg.deployBlock = rcpt.blockNumber
const election = new ethers.Contract(cfg.election, ABI, provider)
console.log(`election ${cfg.election} (${cfg.kind}), phase ${await election.phase()}`)

const domain = { name: "goblett Election", version: "1", chainId: cfg.chainId, verifyingContract: cfg.election }
const types = { Register: [{ name: "wallet", type: "address" }, { name: "identityCommitment", type: "uint256" }] }
const ids = []
for (const k of KEYS) {
  const w = new ethers.Wallet(k)
  const id = new Identity()
  ids.push(id)
  const signature = await w.signTypedData(domain, types, { wallet: w.address, identityCommitment: id.commitment })
  console.log("register", w.address, await post({ type: "register", wallet: w.address, identityCommitment: id.commitment, signature }, () => election.hasRegistered(w.address)))
}
console.log("bad sig ->", await post({ type: "register", wallet: new ethers.Wallet(KEYS[0]).address, identityCommitment: 5, signature: "0x" + "11".repeat(65) }, never))

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
  last = { type: "vote", proof, ...(cfg.kind === "ranked" ? { ranking: ballots[i] } : {}) }
  const res = await post(last, () => election.nullifierUsed(proof.nullifier))
  console.log("vote", i, res, "nullifierUsed:", await election.nullifierUsed(proof.nullifier))
}
console.log("replay ->", await post(last, never))
console.log("not an election ->", await publish({ ...cfg, election: cfg.semaphore }, last).then((s) => confirm(cfg, s.id, never, 40000)).catch((e) => e.message))
console.log("garbage ->", await post({ type: "vote", proof: { points: [1] } }, never))
console.log("tally", (await election.tally()).map(Number))
process.exit(0)
