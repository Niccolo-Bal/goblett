# goblet: security audit brief

You are reviewing **goblet**, a hackathon DApp for anonymous on-chain elections. Find vulnerabilities that break the security goals below. Read this whole brief before you start. It lists the accepted design limits, and reporting them again only adds noise.

## 1. What it does

Elections with a **public whitelist of wallets**, where **no one (the deployer included) can link a wallet to its ballot**. It is built on **Semaphore v4** (Groth16 zk proofs of group membership plus a per-scope nullifier). The target chain is **Arc**, Circle's EVM L1, which uses native USDC as gas (testnet chain ID `5042002`).

Flow:
1. The voter generates a Semaphore identity (secret) client-side. Its commitment `C = Poseidon(...)` is public.
2. **Registration** (public, linked to the wallet, carries no vote). A whitelisted wallet calls `register(C)`, or signs EIP-712 `Register(address wallet,uint256 identityCommitment)` and anyone relays it with `registerFor(wallet, C, sig)`. `C` is added as a leaf to the election's Semaphore group (LeanIMT Merkle tree).
3. **Freeze.** Registration closes before voting opens, so the Merkle root is final.
4. **Voting** (anonymous, anyone may submit). `vote(proof)` takes a Semaphore proof that "I know the secret of a leaf under root R; nullifier N = Poseidon(scope, secret); message = my ballot". The contract checks scope, root, nullifier freshness and proof validity, then records the ballot.
5. **Counting.** `winners()` (a view) is callable after `votingEnd`.

## 2. Security goals (what counts as a real finding)

1. **Ballot secrecy / unlinkability.** No party can link a registered wallet (or its commitment) to a ballot or nullifier using on-chain data.
2. **One person, one vote.** Each registered identity can cast at most one counted vote per election. That rules out double voting, voting through another scope or election, and voting without registering.
3. **Eligibility.** Only whitelisted wallets can register, and at most one commitment each.
4. **Integrity.** No one (relayer, front-runner, deployer after deployment) can alter, reorder, truncate, drop or redirect a valid ballot once it is submitted, or inject a vote that is not backed by a valid proof.
5. **Correct tally.** `tally()`, `ballots()` and `winners()` reflect exactly the counted votes, and the IRV / plurality rules behave as specified (section 5).
6. **No admin after deployment.** Whitelist, candidates and schedule are immutable. Nothing can add or remove members except `register`/`registerFor`.
7. **Liveness.** No cheap griefing that blocks registration or voting for honest users, or that makes `winners()` impossible to compute at realistic sizes.

## 3. Scope

**In scope** (all under `dapp/`):
- `src/Election.sol`: abstract base holding all the security-critical logic: constructor checks, whitelist, `register`/`registerFor`, EIP-712 + ECDSA (low-s) + ERC-1271 signature verification, phases, and `_useProof()` (every proof check plus the nullifier burn).
- `src/FPTPElection.sol`: `vote(proof)` where `proof.message` = candidate index. Plurality; ties return every top candidate. Max 64 candidates.
- `src/RankedChoiceElection.sol`: `vote(proof, ranking)`. It requires `proof.message == packRanking(ranking)` (byte i = `ranking[i] + 1`, first choice in the lowest byte, 0 terminates). It merges identical ballots and runs instant runoff in `_winners()`. Max 32 candidates.
- `script/DeploySemaphore.s.sol`: deploys unmodified Semaphore v4.14.5 (PoseidonT3, SemaphoreVerifier, Semaphore).
- Tests (`test/`, `e2e/arc-e2e.mjs`): report gaps in coverage of the invariants, not style issues.

**Out of scope / not built yet:**
- `site/` (front-end) and `relayer/` are empty. The relayer bounty/payment logic described in `dapp/CLAUDE.md` is **planned, not implemented**. You may comment on the design, but label it as design feedback.
- Upstream Semaphore contracts in `node_modules/@semaphore-protocol/contracts` (4.14.5) are assumed correct. Misuse of them by goblet **is** in scope.
- `lib/forge-std`.
- The private keys in `e2e/run.sh` and `e2e/arc-e2e.mjs` are **Anvil's public default dev keys** and are not a finding.

## 4. Invariants the code intends to enforce

Try to break each one.

- Every subclass `vote()` must: (1) check that `proof.message` is the canonical encoding of a valid ballot, (2) call `_useProof(proof)`, (3) record the ballot. No subclass re-implements proof checks.
- `scope = uint256(keccak256(abi.encode(block.chainid, address(this))))`, and `_useProof` requires `proof.scope == scope`. Message formats overlap across election types (ranked ballot `[1]` packs to `2`, which is a valid FPTP index), so only the scope check keeps a proof for one election from counting in another.
- `_useProof` uses `semaphore.verifyProof` (view) plus goblet's own `nullifierUsed` mapping, and **never** `validateProof`. Anyone can call `validateProof` on Semaphore directly with a copied proof, which would burn the nullifier there.
- `proof.merkleTreeRoot` must equal the **current** group root. Semaphore also accepts recent superseded roots, and accepting them would leak "registered early".
- `vote()` never reads `msg.sender`.
- Voting reverts if `registeredCount < minAnonymitySet`. The constructor requires `0 < minAnonymitySet <= whitelist.length`.
- Phases are half-open intervals: `[deploy, registrationEnd)` registration, `[registrationEnd, votingStart)` frozen, `[votingStart, votingEnd)` voting, then ended. The constructor requires `now < registrationEnd <= votingStart < votingEnd`.
- The election contract is its own Semaphore group admin (`createGroup(address(this))`).
- EIP-712 domain: name `"goblet Election"`, version `"1"`, live `block.chainid`, `verifyingContract = address(this)`. ECDSA path: 65-byte sig, `s <= secp256k1n/2`, `v ∈ {27,28}`, recovered address must be nonzero and equal to `wallet`. Otherwise, if `wallet` has code, the ERC-1271 `isValidSignature` staticcall must return the magic value `0x1626ba7e`.

## 5. Counting rules (check the implementation against these)

- **FPTP:** every candidate with the maximum count wins (several = tie; zero votes = all candidates tie).
- **IRV:** each round, a ballot counts for its highest-ranked continuing candidate. Exhausted ballots are ignored. A **strict majority of non-exhausted ballots** wins. Otherwise **all** candidates tied for fewest votes are eliminated together; if that would eliminate everyone left, those candidates are the tied winners. No random or index-based tie-breaks.
- `tally()` = first preferences only (ranked). `ballots()` = distinct packed ballots + counts.
- `winners()` reverts before `votingEnd`.

## 6. Known, accepted limitations (do NOT report these as findings)

- The live tally and all ballots are public (readable storage). Hiding them needs encrypted ballots.
- Ranked ballots are public, so a coercer can demand a unique ordering of low preferences and check `ballots()` for it. Accepted. Mitigations are documented.
- Not receipt-free: a voter can reveal their secret to prove their vote, so vote-buying is possible. Accepted (the trade-off versus MACI's trusted coordinator).
- The Semaphore address is trusted. A malicious deployer could point at a fake verifier. Users must check the explorer-verified source.
- Registration front-running can burn a commitment (someone inserts `C` first). The victim regenerates.
- `registerFor` signatures have no nonce or deadline. An unsubmitted old signature stays valid until the wallet registers or registration closes.
- The whitelist is stored by a constructor loop, so large lists are expensive to deploy.
- Network metadata (IP/timing) at relay time. Voters should use Tor/VPN.
- Arc validators are permissioned and could censor or delay txs (but not alter ballots).
- IRV `winners()` gas grows with rounds × distinct ballots × ranking length. It is bounded by the RPC `eth_call` gas cap, measured at ~11M gas for 10 candidates × 1000 distinct ballots. **Do** report it if an attacker can make it blow up far beyond that cheaply (e.g. with few votes).

If you think one of these is **worse than described** (e.g. a variant that links wallets to ballots, or a no-nonce issue that allows more than burning a commitment), that is a valid finding. Explain the difference.

## 7. Platform specifics (Arc)

- EVM-compatible. BN254 precompiles 0x06–0x08 work, so the Groth16 verifier runs unchanged.
- Native gas token is USDC with **18 decimals**. The ERC-20 USDC interface at `0x3600…0000` uses **6 decimals**. (No value transfers exist in the contracts yet.)
- Minimum base fee 20 gwei. Block timestamps are **non-decreasing, not strictly increasing**.
- Value transfers to/from blocklisted addresses revert.
- Solidity `0.8.28` (pragma `^0.8.23`), optimizer 200 runs. No upgradeability, no proxies, no `delegatecall`, no owner.

## 8. Suggested attack angles

- Ways to vote twice: alternative scopes, different roots, nullifier encoding (e.g. values ≥ the SNARK field modulus vs. the `nullifierUsed` key), message values ≥ field modulus aliasing to a valid ballot, or proof malleability.
- Ballot binding in ranked choice: can `ranking` differ from what the proof commits to while `packRanking` still matches? Consider out-of-range indices, duplicates, length edge cases (0, n, 32), and how Semaphore hashes `message` inside the circuit.
- Cross-election / cross-chain replay of proofs or EIP-712 signatures (the scope and domain separator both use the live `block.chainid`, so think about forks).
- `registerFor`: ECDSA edge cases, ERC-1271 fallback behavior when ECDSA fails for a wallet with code (EIP-7702 delegated EOAs, a malicious contract wallet returning odd data, returndata handling), and whether a relayer can register a commitment the wallet didn't sign.
- Griefing registration: pre-inserting someone's commitment, or making `addMember` revert for an honest user.
- Phase boundaries with equal timestamps (`registrationEnd == votingStart`, txs in the same block as a boundary).
- `minAnonymitySet` bypass or manipulation.
- IRV correctness: exhausted ballots, all-ties, eliminating multiple candidates at once, `votes[c] * 2 > active` overflow or rounding, candidate index 31/32 bitmask shifts, and a packed byte of `0` mid-ballot.
- FPTP `_winners()` when all tallies are zero.
- Anything that leaks registration order or wallet identity into the vote path.

## 9. Build and test

From `dapp/` (WSL or Linux, Foundry required):

```bash
npm install                 # @semaphore-protocol/* 4.14.5, ethers 6
forge build
forge test -vv              # unit tests with MockSemaphore + tests against real Semaphore contracts
e2e/run.sh                  # real Groth16 proofs on a local node (ANVIL_CMD=anvil for plain anvil)
```

Test layout: `test/ElectionBase.t.sol` is an abstract shared suite inherited by `FPTPElection.t.sol` and `RankedChoiceElection.t.sol`. `test/mocks/MockSemaphore.sol` fakes proof validity, so it **cannot** test message/scope binding inside a real proof. `e2e/arc-e2e.mjs` covers that part (front-running, replay, tampering, wrong scope, cross-election proof, double vote, runoff).

`dapp/CLAUDE.md` has more design notes, including the planned relayer bounty design.

## 10. How to report

For each finding give:
- **Title** and **severity** (Critical / High / Medium / Low / Info).
- **Which security goal** from section 2 it breaks.
- **Location** (`file:line`).
- **Concrete exploit scenario**: preconditions, attacker steps, outcome.
- **PoC** if possible (a Foundry test in the style of `test/ElectionBase.t.sol`, or a variant of `e2e/arc-e2e.mjs`).
- **Suggested minimal fix.**

Don't report anything listed in section 6, gas micro-optimizations, or style issues unless they hide a real bug. State your confidence, and if you couldn't confirm a finding, say so.
