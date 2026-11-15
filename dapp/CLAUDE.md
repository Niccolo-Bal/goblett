# goblet: anonymous elections on Arc

Hackathon project for UBC 2026 (University Blockchain Conference). A DApp on Arc
(Circle's L1, USDC as gas; testnet chain ID 5042002)
for elections with a **public whitelist of wallets** where **no one, including the
deployer, can link a wallet to its ballot**. Built on Semaphore v4. A web front-end
lives in `../site` (empty so far).

## Working with the user

- Niccolo is a math major learning the crypto/Solidity stack through this project.
  He wants to write as much as he can himself. Explain the concept before writing
  code, and prefer guiding him through core logic over writing it for him, unless
  he asks you to implement something.
- When reviewing his code, make the smallest set of changes that fixes it.
- Use Python for scripts unless the tool requires JS/TS (Semaphore proof
  generation and the front-end do).
- Be explicit about security trade-offs and limits. Don't oversell anonymity.

## Environment

- Windows + WSL. Run commands from WSL in
  `/mnt/c/Users/nicco/Desktop/Projects/UBC Hackathon/goblet/dapp`.
- Foundry (`forge`, forge-std v1.17.0 in `lib/`), solc 0.8.28.
- `@semaphore-protocol/contracts` 4.14.5 via npm (`node_modules/`), remapped in
  `remappings.txt`.
- Gotcha: WSL has an unrelated `/usr/bin/forge` (SNAP gene-prediction tool, "ZOE
  ERROR"). `~/.foundry/bin` must come first on PATH. Check with `which forge`.
- Arc Foundry (`arc-forge`, `arc-cast`, `arc-anvil` in `~/.local/bin`), from
  github.com/circlefin/arc-foundry releases. Install steps in `e2e/README.md`.
- JS dev deps: `@semaphore-protocol/identity|group|proof` 4.14.5, `ethers` 6.

```bash
forge build
forge test -vv
e2e/run.sh            # real proofs on arc-anvil (ANVIL_CMD=anvil for plain anvil)
```

## Layout

One election per deployment; pick the type by which contract you deploy (same
constructor arguments for both).

- `src/Election.sol`: **abstract** base with all shared logic: constructor checks,
  whitelist, `register`/`registerFor`, phases, `tally()`, `winners()`, and
  `_useProof(proof)` (every proof check + nullifier burn). Hooks for subclasses:
  `_maxCandidates()`, `_winners()`.
- `src/FPTPElection.sol`: `vote(proof)`, message = candidate index; plurality.
  Max 64 candidates.
- `src/RankedChoiceElection.sol`: `vote(proof, ranking)`, message =
  `packRanking(ranking)`; instant runoff; `ballots()`. Max 32 candidates.
- `test/ElectionBase.t.sol`: abstract test base (constructor, registration,
  registerFor, every `_useProof` check) with hooks `_deploy`, `_maxCandidates`,
  `_message`, `_submit`. Inherited by `test/FPTPElection.t.sol` (54 tests) and
  `test/RankedChoiceElection.t.sol` (65), so shared tests run against both types.
- `test/mocks/MockERC1271Wallet.sol`: contract wallet for registerFor tests
- `test/ElectionSemaphore.t.sol`: both election types against the real Semaphore
  contracts (Poseidon tree, Groth16 verifier) with chainid set to Arc testnet.
  No real proofs.
- `test/mocks/MockSemaphore.sol`: fakes `createGroup`, `addMember`,
  `getMerkleTreeRoot`, `verifyProof` (validity set by the test)
- `script/DeploySemaphore.s.sol`: deploys unmodified Semaphore v4 (PoseidonT3 lib +
  SemaphoreVerifier + Semaphore). Needed because Semaphore isn't deployed on Arc.
- `e2e/`: `run.sh` (node + deploy + test) and `arc-e2e.mjs` (real proofs, both
  types on one Semaphore: front-run, replay, tampering, wrong scope, cross-election
  proof, double vote, runoff, tally)
- `../../toy_proj/`: the user's Python toy model of the scheme (sha256, no SNARK)

## The scheme

1. Each voter generates a secret identity in the browser. Its commitment `C`
   (a Poseidon hash) is public.
2. **Registration (linked to the wallet, carries no vote):** a whitelisted wallet
   calls `register(C)`, or signs EIP-712 `Register(address wallet,uint256
   identityCommitment)` (domain: name "goblet Election", version "1", chainId,
   election address) and anyone relays it via `registerFor(wallet, C, sig)`.
   EOA (low-s ECDSA) and ERC-1271 wallets are supported. `C` becomes a leaf of
   the election's Semaphore Merkle tree.
3. **Freeze:** registration closes before voting opens, so the root is final and
   registration timing can't be correlated with votes.
4. **Voting (anonymous):** anyone submits a Semaphore proof of:
   "I know a secret whose commitment is a leaf under root `R`, and the nullifier
   `N = Poseidon(scope, secret)`." Public inputs: root, nullifier, `message`
   (= the ballot), `scope`. The contract rejects reused nullifiers.
   - FPTP: `vote(proof)`, `message` = candidate index.
   - Ranked choice: `vote(proof, ranking)`: `ranking` is 1..n distinct candidate indices, most
     preferred first. The contract requires `proof.message == packRanking(ranking)`
     (byte i = ranking[i] + 1, first choice in the lowest byte, 0 = end; hence
     `MAX_CANDIDATES = 32`). So the ranking is bound to the proof and a relayer
     can't reorder, truncate or change it.
   - The nullifier is per-election (via `scope`), so votes are unlinkable across
     elections.

## Counting (`winners()`, reverts before `votingEnd`)

FPTP: every candidate with the most votes (several = tie; no votes = all tie).

Instant runoff (`RankedChoiceElection`):

- Each round, a ballot counts for its highest-ranked continuing candidate;
  ballots with none left are exhausted and ignored.
- Strict majority of non-exhausted ballots wins. Otherwise all candidates tied
  for fewest votes are eliminated together; if that would eliminate everyone
  left, they are the tied winners. No random or index-based tie-breaks.
- Identical ballots are merged (`ballots()` returns packed ballots + counts), so
  cost scales with distinct ballots. `tally()` is first preferences only.
- `winners()` is a view (free via eth_call, but bounded by the RPC's eth_call gas
  cap). Measured: 10 candidates x 1000 distinct ballots ~11M gas, x 3000 ~33M;
  32 x 1000 ~23M. Beyond a few thousand distinct ballots, count off-chain from
  `ballots()` or add a paginated on-chain finalize.

## Security invariants in Election.sol (do not regress)

- **Every subclass `vote()` must:** (1) check `proof.message` is the canonical
  encoding of a valid ballot, (2) call `_useProof(proof)`, (3) record the ballot.
  Never re-implement or skip proof checks in a subclass.
- **Scope is what separates elections.** The message formats overlap: ranked
  ballot `[1]` packs to 2, a valid FPTP candidate index. Only the scope check stops
  a proof for one election counting in another (tested in e2e).

- **Use `verifyProof` (view) plus our own `nullifierUsed` mapping, never
  `validateProof`.** Anyone can call `Semaphore.validateProof` directly with a
  copied proof, burning the nullifier there without our tally counting the vote.
- **`proof.scope == scope`**, where `scope = keccak256(chainid, address(this))`.
  Without this check, one identity can make proofs for many scopes (many
  nullifiers) and vote many times.
- **`proof.merkleTreeRoot` must equal the current (frozen) root.** Semaphore also
  accepts recently superseded roots, but a proof against an old root reveals the
  voter registered early, which shrinks the anonymity set.
- **`vote()` never reads `msg.sender`.** Anyone can relay.
- **`minAnonymitySet`:** voting reverts if too few wallets registered.
- **No admin after deployment.** Whitelist, candidates and schedule are fixed in
  the constructor. The contract is its own Semaphore group admin, so only
  `register()` adds members and nothing removes them.
- Phases use half-open intervals: `[deploy, regEnd)`, `[regEnd, votingStart)`,
  `[votingStart, votingEnd)`, then ended.

## Known limits (state these openly; don't "fix" them with fake security)

- **Live tally is public.** Storage is readable, so a gated getter would be
  pointless. Hiding it needs encrypted ballots.
- **Full ranked ballots are public, which makes coercion easier**
  (`RankedChoiceElection` only). A coercer can demand an unusual ordering of the
  low preferences (n! orderings) and then check that this exact ballot appears in
  `ballots()`, without the voter revealing any secret. With `FPTPElection` the
  coercer needs the voter's nullifier or secret. It
  doesn't link wallets to ballots. Mitigations: fewer candidates, capped ranking
  length, or encrypted ballots.
- **Not receipt-free.** A voter can reveal their secret to prove their vote, so
  vote-buying is possible. MACI solves this with encryption to a coordinator plus
  key changes, but the coordinator can see every wallet's vote and can refuse to
  tally. **Our pitch:** anonymity against everyone with no trusted party, versus
  MACI's anti-bribery that relies on a trusted coordinator. Future work: threshold
  encryption (e.g. CRISP) for hidden tallies without a single coordinator.
- **Trusted Semaphore address.** A malicious deployer could point to a fake
  verifier. Semaphore has no official Arc deployment, so we deploy our own; users
  must check the explorer-verified source of Semaphore/SemaphoreVerifier/PoseidonT3
  matches the npm package 4.14.5 (verify contracts on Arcscan after deploying).
- **Registration front-running** can burn a commitment. The victim regenerates
  their identity.
- **registerFor signatures have no nonce or deadline.** A signed-but-unsubmitted
  signature stays valid until the wallet registers or registration closes. If a
  voter re-signs a new `C` (e.g. lost secret), whoever holds the old signature can
  still register the old `C` first. Signing only one `C` per wallet avoids it.
- **Whitelist stored by a constructor loop** means large lists are expensive to
  deploy. Later option: a Merkle root of the whitelist.
- **Network metadata** (IP, timing) when submitting to a relayer. Voters should
  use Tor/VPN.
- **Arc's validator set is permissioned.** Validators could censor or delay votes
  but not alter them (the vote is bound to the proof).

## Arc specifics

- BN254 precompiles (0x06-0x08) work on Arc testnet (checked), so the Groth16
  verifier runs unchanged. `Election.sol` needed no changes for Arc.
- Gas is native USDC with **18 decimals** (`msg.value`, balances); the ERC-20
  USDC interface at `0x3600…0000` uses 6. Never mix them.
- Minimum base fee is 20 gwei; txs below it are silently dropped.
- Block timestamps are non-decreasing, not strictly increasing (our half-open
  phase checks are fine with that).
- Value transfers to/from blocklisted addresses revert. Anvil dev account #1
  (`0x7099…79C8`) is blocklisted on Arc testnet; don't use it in tests.
- The public RPC rejects `eth_getLogs` over large ranges: query `Registered`
  events from the election's deployment block, not block 0.
- Measured (anvil fork of Arc testnet, depth-2 group): register ~150-190k gas
  (`registerFor` ~192k), FPTP vote ~340k, ranked vote ~383k (3-candidate
  ranking). At 20 gwei: ~0.003-0.004 USDC to register, ~0.007-0.008 USDC to vote.

## Relaying and gas (planned)

- Voters never need a wallet or burner at vote time. They send
  `(proof)` (plus `ranking` for ranked choice) over plain HTTPS to any relayer. The proof is the authorization.
- **Bounty:** the election creator funds the contract (in native USDC); `vote()`
  pays `msg.sender` for each new valid vote. Pay `gasUsed * min(tx.gasprice, cap) + bounty`
  (cap the gas price, or relayers can inflate refunds). Arc is an L1, so there is
  no separate L1 data fee. A transfer to a blocklisted relayer reverts, so prefer
  crediting a balance the relayer withdraws (pull payment) over paying inside
  `vote()`. Use checks-effects-interactions and a reentrancy guard once value
  transfers exist.
- A voter verifies inclusion by checking `nullifierUsed(N)` on-chain, and resubmits
  via another relayer if it's missing. A bounty enables a relayer market but
  doesn't create one; at the demo, our backend is the only relayer.
- ERC-4337 isn't needed: voters have no smart account. A paying `vote()` is simpler.

## Web front-end rules (when built)

- The identity secret is generated and stored **only in the browser**. A server
  holding it could compute the nullifier (deanonymize) and vote as the user.
- The vote/relay endpoint must be **unauthenticated**. No session cookie with the
  proof, or the server links account to ballot.
- Accounts (if added) handle signup/whitelisting/registration only.
- Proof generation: `@semaphore-protocol/identity`, `/group`, `/proof` (JS).

## Testing notes

- `vm.prank` and `vm.expectRevert` apply to the **next external call**. Build
  proof structs into a variable first; helper calls like `_proof()` would
  otherwise consume the prank. The `_submit` hooks make exactly one external call.
- New election type: subclass `Election`, then add a test contract inheriting
  `ElectionTestBase` to get all shared tests for free.
- The mock cannot test that message/scope are bound inside a real proof.

## Next steps

1. ~~Get `forge test` fully passing.~~ Done.
2. ~~Integration tests with real proofs~~ Done in `e2e/` (passes on plain anvil and
   on an anvil fork of Arc testnet). Still to run: `e2e/run.sh` with `arc-anvil`.
3. Deploy Semaphore + an Election to Arc testnet (faucet USDC), verify on Arcscan.
4. Relayer bounty in the contract, plus a minimal relay endpoint.
5. Front-end in `../site`: connect wallet, register, vote via relay, verify
   inclusion.
6. Optional: factory contract for creating elections (either type); Web2 accounts.
