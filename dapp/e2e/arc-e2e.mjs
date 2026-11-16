// End-to-end test of Election with REAL Semaphore proofs on a local node
// (arc-anvil, or plain anvil). Run via e2e/run.sh, which starts the node and
// deploys Semaphore first. JS because Semaphore proof generation is JS-only.
//
// Env: RPC_URL (default http://127.0.0.1:8545), SEMAPHORE (deployed address).

import { readFileSync } from "node:fs"
import { ethers } from "ethers"
import { Identity } from "@semaphore-protocol/identity"
import { Group } from "@semaphore-protocol/group"
import { generateProof } from "@semaphore-protocol/proof"

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545"
const SEMAPHORE = process.env.SEMAPHORE
if (!SEMAPHORE) throw new Error("SEMAPHORE env var (deployed Semaphore address) is required")

// Anvil's default dev keys. Index 1 (0x7099...79C8) is deliberately skipped:
// Arc testnet blocklists it, so value transfers from it revert there.
const KEYS = {
    deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // #0
    voters: [
        "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // #2
        "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", // #3
        "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", // #4
        "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba", // #5
    ],
    relayer: "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6", // #9, not whitelisted
    attacker: "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97", // #8
}

// cacheTimeout -1: ethers otherwise reuses identical RPC results for 250ms
// (stale nonces, stale eth_estimateGas reverts after a time warp).
const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1 })
// Plain wallets (no NonceManager): it consumes a nonce even when gas estimation
// reverts, which leaves a nonce gap after every expected failure. We await each
// receipt anyway, so the provider's pending nonce is always right.
const wallet = (k) => new ethers.Wallet(k, provider)
const artifact = (path) => JSON.parse(readFileSync(new URL(`../out/${path}`, import.meta.url)))
// Election + Semaphore errors, to decode reverts from either contract.
let errorIfaces = []
function revertName(e) {
    if (e.revert?.name) return e.revert.name
    const data = e.data ?? e.info?.error?.data ?? e.error?.data
    for (const iface of errorIfaces) {
        try {
            const parsed = iface.parseError(data)
            if (parsed) return parsed.name
        } catch {}
    }
    return e.shortMessage ?? e.message
}

let failures = 0
const ok = (msg) => console.log(`  PASS  ${msg}`)
const fail = (msg) => {
    failures++
    console.log(`  FAIL  ${msg}`)
}
function check(cond, msg) {
    cond ? ok(msg) : fail(msg)
}
async function expectRevert(promise, errorName, msg) {
    try {
        const tx = await promise
        await tx.wait()
        fail(`${msg} (did not revert)`)
    } catch (e) {
        const got = revertName(e)
        got === errorName ? ok(`${msg} -> ${errorName}`) : fail(`${msg}: expected ${errorName}, got ${got}`)
    }
}
async function latestTimestamp() {
    return (await provider.getBlock("latest")).timestamp
}
async function warpTo(ts) {
    await provider.send("evm_setNextBlockTimestamp", [ts])
    await provider.send("evm_mine", [])
}
// Proofs from snarkjs are strings; the contract wants a uint tuple.
const toTuple = (p) => ({ ...p, points: [...p.points] })
const fmtUsdc = (wei) => `${ethers.formatUnits(wei, 18)} USDC`

async function main() {
    const net = await provider.getNetwork()
    console.log(`Chain ${net.chainId} at ${RPC_URL}`)
    console.log(`Semaphore at ${SEMAPHORE}`)
    const code = await provider.getCode(SEMAPHORE)
    if (code === "0x") throw new Error("No contract at SEMAPHORE address")

    const deployer = wallet(KEYS.deployer)
    const voters = KEYS.voters.map(wallet)
    const relayer = wallet(KEYS.relayer)
    const attacker = wallet(KEYS.attacker)
    const voterAddrs = await Promise.all(voters.map((v) => v.getAddress()))

    const semArt = artifact("Semaphore.sol/Semaphore.json")
    const elArt = artifact("RankedChoiceElection.sol/RankedChoiceElection.json")
    const fptpArt = artifact("FPTPElection.sol/FPTPElection.json")
    const semaphore = new ethers.Contract(SEMAPHORE, semArt.abi, provider)
    errorIfaces = [elArt, fptpArt, semArt].map((a) => new ethers.Interface(a.abi))

    // ------------------------------------------------------------------
    console.log("\n[1] Deploy RankedChoiceElection")
    const now = await latestTimestamp()
    const regEnd = now + 600
    const votingStart = now + 1200
    const votingEnd = now + 1800
    const factory = new ethers.ContractFactory(elArt.abi, elArt.bytecode.object, deployer)
    const election = await factory.deploy(
        SEMAPHORE,
        "goblet e2e",
        ["Alice", "Bob", "Carol"],
        voterAddrs,
        regEnd,
        votingStart,
        votingEnd,
        3
    )
    const deployRcpt = await election.deploymentTransaction().wait()
    console.log(`  Election at ${await election.getAddress()} (gas ${deployRcpt.gasUsed})`)
    const groupId = await election.groupId()
    const scope = await election.scope()
    check(
        scope === BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "address"], [net.chainId, await election.getAddress()]))),
        "scope = keccak256(chainid, election)"
    )
    check((await semaphore.getGroupAdmin(groupId)) === (await election.getAddress()), "Election is its own group admin")

    // ------------------------------------------------------------------
    console.log("\n[2] Registration (identities generated client-side)")
    const identities = voters.map(() => new Identity())
    for (let i = 0; i < voters.length - 1; i++) {
        const rcpt = await (await election.connect(voters[i]).register(identities[i].commitment)).wait()
        console.log(`  voter ${i} registered (gas ${rcpt.gasUsed}, fee ${fmtUsdc(rcpt.fee)})`)
    }

    // Last voter signs off-chain (EIP-712, as a browser wallet would) and the
    // relayer pays gas via registerFor.
    const last = voters.length - 1
    const domain = { name: "goblet Election", version: "1", chainId: net.chainId, verifyingContract: await election.getAddress() }
    const types = { Register: [{ name: "wallet", type: "address" }, { name: "identityCommitment", type: "uint256" }] }
    const value = { wallet: voterAddrs[last], identityCommitment: identities[last].commitment }
    const sig = await voters[last].signTypedData(domain, types, value)
    check(ethers.TypedDataEncoder.hash(domain, types, value) === (await election.registerDigest(value.wallet, value.identityCommitment)), "ethers EIP-712 digest == registerDigest()")
    await expectRevert(
        election.connect(relayer).registerFor(value.wallet, value.identityCommitment + 1n, sig),
        "InvalidSignature",
        "relayer swaps the commitment"
    )
    const balBefore = await provider.getBalance(voterAddrs[last])
    const rf = await (await election.connect(relayer).registerFor(value.wallet, value.identityCommitment, sig)).wait()
    console.log(`  voter ${last} registered via relayer (gas ${rf.gasUsed}, fee ${fmtUsdc(rf.fee)})`)
    check((await provider.getBalance(voterAddrs[last])) === balBefore, "voter paid no gas for registerFor")
    await expectRevert(election.connect(relayer).registerFor(value.wallet, value.identityCommitment, sig), "AlreadyRegistered", "replaying the signature")
    await expectRevert(election.connect(relayer).register(123n), "NotWhitelisted", "non-whitelisted register")
    await expectRevert(election.connect(voters[0]).register(456n), "AlreadyRegistered", "double register")

    // ------------------------------------------------------------------
    console.log("\n[3] Freeze, then open voting")
    await warpTo(votingStart)
    check((await election.phase()) === "voting", "phase is voting")

    // Rebuild the group from public Registered events, as a front-end would.
    // Query from the deployment block: Arc's RPC rejects eth_getLogs from block 0
    // ("requested range too large"). The front-end must do the same.
    const events = await election.queryFilter(election.filters.Registered(), deployRcpt.blockNumber)
    const group = new Group(events.map((e) => e.args.identityCommitment))
    const onchainRoot = await semaphore.getMerkleTreeRoot(groupId)
    check(group.root === onchainRoot, `off-chain group root matches on-chain (${group.size} members, depth ${group.depth})`)

    // ------------------------------------------------------------------
    console.log("\n[4] Real proofs (ranked ballots: message = packRanking(ranking))")
    // Ballot encoding, same as Election.packRanking: byte i = ranking[i] + 1.
    const pack = (r) => r.reduce((acc, c, i) => acc | (BigInt(c + 1) << BigInt(8 * i)), 0n)
    check((await election.packRanking([2, 0, 1])) === pack([2, 0, 1]), "JS pack() == Election.packRanking()")
    const prove = async (i, ranking, s = scope) => toTuple(await generateProof(identities[i], group, pack(ranking), s))

    console.log("  generating proof for voter 0 (downloads SNARK artifacts on first run)...")
    const r0 = [1, 0]
    const p0 = await prove(0, r0)
    check(BigInt(p0.scope) === scope && BigInt(p0.message) === pack(r0), "proof carries our scope and packed ranking")
    check(await semaphore.verifyProof(groupId, p0), "Semaphore.verifyProof accepts it")

    // Front-running: an attacker copies the proof from the mempool and burns the
    // nullifier inside Semaphore via validateProof. Our vote must still count.
    const fr = await (await semaphore.connect(attacker).validateProof(groupId, p0)).wait()
    check(fr.status === 1, "attacker burned the nullifier in Semaphore via validateProof")

    const voteRcpt = await (await election.connect(relayer).vote(p0, r0)).wait()
    check(voteRcpt.status === 1, `vote via non-whitelisted relayer still counts after front-run (gas ${voteRcpt.gasUsed}, fee ${fmtUsdc(voteRcpt.fee)})`)
    check(await election.nullifierUsed(p0.nullifier), "nullifierUsed(N) is true (voter can verify inclusion)")

    await expectRevert(election.connect(relayer).vote(p0, r0), "NullifierAlreadyUsed", "replaying the same proof")

    console.log("  generating tamper proofs for voter 1...")
    const r1 = [0, 2]
    const p1 = await prove(1, r1)
    // A relayer reorders the ranking but keeps the proof: caught by our message check.
    await expectRevert(election.connect(relayer).vote(p1, [2, 0]), "BallotMismatch", "relayer reorders ranking")
    await expectRevert(election.connect(relayer).vote(p1, [0]), "BallotMismatch", "relayer truncates ranking")
    // ...and also rewrites the message to match: caught by the SNARK.
    await expectRevert(election.connect(relayer).vote({ ...p1, message: pack([2, 0]) }, [2, 0]), "InvalidProof", "relayer rewrites message + ranking")

    // Same identity, other scope: a valid Semaphore proof, but not for this election.
    const pOther = await prove(1, r1, scope + 1n)
    check(BigInt(pOther.nullifier) !== BigInt(p1.nullifier), "different scope gives a different nullifier")
    await expectRevert(election.connect(relayer).vote(pOther, r1), "WrongScope", "proof for another scope")
    await expectRevert(election.connect(relayer).vote({ ...pOther, scope }, r1), "InvalidProof", "other-scope proof with scope field patched")

    // The untampered proof still works.
    await (await election.connect(relayer).vote(p1, r1)).wait()
    ok("voter 1's original proof accepted after the failed tampering")

    // Voter 2 tries to vote twice with two different rankings: same nullifier.
    const p2a = await prove(2, [2, 0])
    const p2b = await prove(2, [1])
    check(p2a.nullifier === p2b.nullifier, "same identity + scope -> same nullifier regardless of ballot")
    await (await election.connect(relayer).vote(p2a, [2, 0])).wait()
    await expectRevert(election.connect(relayer).vote(p2b, [1]), "NullifierAlreadyUsed", "second vote with a different ranking")

    // Invalid ballots are rejected before the (expensive) proof check.
    await expectRevert(election.connect(relayer).vote(await prove(3, [7]), [7]), "InvalidCandidate", "candidate index out of range")
    await expectRevert(election.connect(relayer).vote(await prove(3, [0, 0]), [0, 0]), "InvalidRanking", "duplicate candidate in ranking")

    const p3 = await prove(3, [0, 1, 2])
    const v3 = await (await election.connect(relayer).vote(p3, [0, 1, 2])).wait()
    console.log(`  full 3-candidate ranking: gas ${v3.gasUsed}`)

    // ------------------------------------------------------------------
    console.log("\n[5] Tally and instant runoff")
    // Ballots: [B,A] [A,C] [C,A] [A,B,C]. First preferences A2 B1 C1 of 4: no
    // majority. B and C tie for last and are eliminated together; their ballots
    // move to A -> A wins 4-0.
    const tally = (await election.tally()).map(Number)
    check(JSON.stringify(tally) === JSON.stringify([2, 1, 1]), `first-preference tally is [2, 1, 1] (got [${tally}])`)
    check((await election.totalVotes()) === 4n, "totalVotes is 4")
    const [packed, counts] = await election.ballots()
    check(packed.length === 4 && counts.every((c) => c === 1n), "ballots() lists 4 distinct ballots")
    await expectRevert(election.winners.staticCall().then(() => ({ wait: async () => {} })), "ElectionNotOver", "winners() before end")
    await warpTo(votingEnd)
    const w = (await election.winners()).map(Number)
    check(JSON.stringify(w) === JSON.stringify([0]), `runoff winner is candidate 0 (Alice) (got [${w}])`)
    const wGas = await election.winners.estimateGas()
    console.log(`  winners() eth_call gas: ${wGas}`)
    await expectRevert(election.connect(relayer).vote(p2b, [1]), "VotingNotOpen", "valid proof after voting end")

    // ------------------------------------------------------------------
    console.log("\n[6] FPTPElection on the same Semaphore (message = candidate index)")
    const t0 = await latestTimestamp()
    const fFactory = new ethers.ContractFactory(fptpArt.abi, fptpArt.bytecode.object, deployer)
    const fptp = await fFactory.deploy(SEMAPHORE, "goblet e2e fptp", ["Alice", "Bob", "Carol"], voterAddrs, t0 + 600, t0 + 1200, t0 + 1800, 3)
    const fDeploy = await fptp.deploymentTransaction().wait()
    const fScope = await fptp.scope()
    check((await fptp.groupId()) !== groupId && fScope !== scope, "separate Semaphore group and scope")
    // Fresh identities: reusing them would also be safe (different scope ->
    // unlinkable nullifiers), but this mirrors real voters.
    const fIds = voters.map(() => new Identity())
    for (let i = 0; i < voters.length; i++) {
        await (await fptp.connect(voters[i]).register(fIds[i].commitment)).wait()
    }
    await warpTo(t0 + 1200)
    const fEvents = await fptp.queryFilter(fptp.filters.Registered(), fDeploy.blockNumber)
    const fGroup = new Group(fEvents.map((e) => e.args.identityCommitment))
    check(fGroup.root === (await semaphore.getMerkleTreeRoot(await fptp.groupId())), "FPTP group root matches")

    const fVotes = [1, 1, 0, 2]
    const fProofs = []
    for (let i = 0; i < voters.length; i++) {
        fProofs.push(toTuple(await generateProof(fIds[i], fGroup, fVotes[i], fScope)))
    }
    await expectRevert(fptp.connect(relayer).vote({ ...fProofs[0], message: 0n }), "InvalidProof", "relayer changes FPTP vote 1 -> 0")
    await expectRevert(fptp.connect(relayer).vote({ ...fProofs[0], message: 5n }), "InvalidCandidate", "out-of-range FPTP candidate")
    // Voter 2's ranked ballot [1] packs to 2, a valid FPTP candidate index: only
    // the scope check stops a ranked-election proof from counting here.
    await expectRevert(fptp.connect(relayer).vote(p2b), "WrongScope", "ranked-election proof (message 2) submitted to FPTP")
    for (const p of fProofs) {
        await (await fptp.connect(relayer).vote(p)).wait()
    }
    await expectRevert(fptp.connect(relayer).vote(fProofs[1]), "NullifierAlreadyUsed", "FPTP double vote")
    const fTally = (await fptp.tally()).map(Number)
    check(JSON.stringify(fTally) === JSON.stringify([1, 2, 1]), `FPTP tally is [1, 2, 1] (got [${fTally}])`)
    await warpTo(t0 + 1800)
    const fw = (await fptp.winners()).map(Number)
    check(JSON.stringify(fw) === JSON.stringify([1]), `FPTP winner is candidate 1 (Bob) (got [${fw}])`)

    console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`)
}

main()
    .catch((e) => {
        console.error(e)
        failures++
    })
    .finally(() => process.exit(failures === 0 ? 0 : 1))
