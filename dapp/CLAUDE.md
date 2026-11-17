# goblett: anonymous elections on Arc

Hackathon project for UBC 2026 (University Blockchain Conference). A DApp on Arc
(Circle's L1, USDC as gas; testnet chain ID 5042002)
for elections with a **public whitelist of wallets** where **no one, including the
deployer, can link a wallet to its ballot**. Built on Semaphore v4. A web front-end
lives in `../site`, and the relayer in `../relayer`.

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
- `../relayer/` (Python, web3.py): `relayer.py` (Nostr -> chain), `setup_chain.py`
  (Semaphore + config + exports `site/contracts.json`), `deploy_election.py`,
  `withdraw.py`, `advance.py` (anvil only). `README.md` there has the run and Arc steps.
- `../site/` (Vite, ethers, Semaphore JS, nostr-tools): create an election with
  MetaMask, register, vote, results. `smoke-test.mjs` runs the flow headlessly.
- After changing a contract: `forge build`, then `relayer/setup_chain.py` (re-exports the
  bytecode for the site), then restart the relayer. The relayer only serves elections
  whose code matches the current build.

## The scheme

1. Each voter generates a secret identity in the browser. Its commitment `C`
   (a Poseidon hash) is public.
2. **Registration (linked to the wallet, carries no vote):** a whitelisted wallet
   calls `register(C)`, or signs EIP-712 `Register(address wallet,uint256
   identityCommitment)` (domain: name "goblett Election", version "1", chainId,
   election address) and anyone relays it via `registerFor(wallet, C, sig)`.
   EOA (low-s ECDSA) and ERC-1271 wallets are supported.
   A wallet need not be on Arc to sign: on any other network it signs
   `RegisterOn(address wallet,uint256 identityCommitment,uint256 electionChainId,address election)`
   (domain: name, version and the chainId the wallet is on; no verifyingContract) and
   the relayer calls `registerForSignedOn(wallet, C, signingChainId, sig)`. The election's
   chain and address are inside the message, so the signature is valid for this election
   only, including against a contract at the same address on another chain. `C` becomes a leaf of
   the election's Semaphore Merkle tree. It is also appended to
   `commitments()` (the full list in tree order, so a voter can rebuild the group with
   one call; Arc's RPC only serves logs for small block ranges).
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
  encoding of a valid ballot, (2) call `_useProof(proof)`, (3) record the ballot,
  (4) call `_creditRelayer(gasStart)` with `gasStart = gasleft()` taken on entry.
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
- **`vote()` never uses `msg.sender` to decide anything.** Anyone can relay; it is read
  only to credit the relayer's payment.
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
- **Network metadata.** Registrations, votes and the voter-specific chain reads go
  through an OHTTP relay + gateway (`../ohttp/`), so the Nostr relays and the RPC see the
  gateway, not the voter. Both currently run on Cloudflare under our account, so this
  does not hide voters from Cloudflare or from us, and the gateway can see the sender's
  city and network. Timing is not hidden either. Voters who need more should use Tor/VPN.
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
- Measured (anvil fork of Arc testnet, 2-member group, with relayer payment):
  `registerFor` ~240k gas, FPTP vote ~340k, ranked vote ~390-460k. Deploying an election
  with 3 candidates and 2 wallets: ~2.0M gas (FPTP), ~2.3M (ranked), plus ~22k per extra
  whitelisted wallet. The block gas limit is 30M. At 25 gwei: ~0.006 USDC to register,
  ~0.009-0.012 USDC to vote, before the bounty.

## Relaying and gas

- Voters never need a wallet or burner at vote time. The browser publishes the proof
  (plus `ranking` for ranked choice) as a Nostr event; any relayer subscribed to the
  chain's topic submits it. The proof is the authorization. Registrations travel the same
  way (EIP-712 signature + `registerFor`). See `../relayer/README.md` for the event format.
- **Relayer payment (in `Election.sol`):** the creator funds the contract in native USDC
  (constructor is payable; `receive()` accepts top-ups). `registerFor` and every `vote()`
  end with `_creditRelayer(gasStart)`, which credits `msg.sender` with
  `min(gasUsed + REFUND_GAS_OVERHEAD, MAX_REFUND_GAS) * min(tx.gasprice, maxRefundGasPrice) + relayBounty`,
  limited to what funding is left. Relayers collect with `withdraw()`; after `votingEnd`
  anyone can call `reclaim()`, which sends the unused funding to `creator`.
- Invariants of the payment code (do not regress):
  - **Pull payment only.** No value moves inside `vote()`/`registerFor()`, so a relayer
    that can't receive funds (blocklisted on Arc) can't make a vote fail.
  - **Voting never depends on funding.** With no funds the credit is zero and the call
    still succeeds.
  - **`msg.sender` decides who is paid, never whether a vote counts.**
  - **The gas price and the refunded gas are both capped**, or a relayer could inflate
    refunds (absurd gas price; an ERC-1271 wallet that burns gas in `isValidSignature`).
  - `relayBounty` and `maxRefundGasPrice` are bounded to uint128 in the constructor so
    the credit arithmetic can't overflow and block voting.
  - `withdraw()`/`reclaim()` use checks-effects-interactions and a reentrancy lock.
  - `creator` can only receive leftover funding after the election; it is not an admin.
- Known limits: the refund is an estimate (measured within ~5% of real gas); a voter can
  relay for themself and collect the bounty; a failed relay (lost race) is not refunded.
- A voter verifies inclusion by checking `nullifierUsed(N)` on-chain. A bounty enables a
  relayer market but doesn't create one; at the demo, our relayer is the only one.
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
2. ~~Integration tests with real proofs~~ Done in `e2e/` (plain anvil and an anvil fork of
   Arc testnet). Still to run: `e2e/run.sh` with `arc-anvil`.
3. ~~Relayer bounty in the contract, relay transport (Nostr), front-end.~~ Done, and
   rehearsed end to end on an anvil fork of Arc testnet.
4. Deploy to Arc testnet with funded keys and verify on Arcscan (steps in
   `../relayer/README.md`).
5. Optional: rate limiting on the Nostr topic; Merkle-root whitelist (the constructor
   loop caps an election at ~1,200 wallets on Arc); factory contract; Web2 accounts.
