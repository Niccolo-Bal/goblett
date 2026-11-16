# goblet audit: status report

Branch `Grok`. Team: Scout (code review), Red (exploit PoCs), Blue (fixes + report).

## Round 1 (2026-11-14)

**Status:** no exploits found. On a live anvil chain with real proofs, Red tried each of these and all held: nullifier and message aliasing past the field modulus, replay, `registerFor` signature edge cases (v=0/1, cross-wallet replay, odd ERC-1271 returns), phase-boundary timestamps, and an IRV differential fuzz (2,000 runs). The worst IRV gas case found was about 353k, far below the ~11M accepted ceiling.

### Findings

| # | Title | Severity | Goal | Status |
|---|-------|----------|------|--------|
| R1-1 | Anonymity set counts registrations, not honest voters | Info | 1, 3 | Design note, no code fix |
| R1-2 | `scope` fixes the deploy-time chain ID, but the EIP-712 domain reads it live | Info | 4 | Noted, no fix yet |

**R1-1.** `registeredCount` counts registrations. Anyone who controls K whitelisted wallets can register K identities, including throwaway commitments with no known secret, and so meet `minAnonymitySet` with a set that looks real but is empty. Mitigation: govern the whitelist and size `minAnonymitySet` to the expected *honest* turnout, not to the whitelist length.

**R1-2.** `Election.sol:134` sets `scope` from `block.chainid` at deploy time, while `Election.sol:189` computes the domain separator from the live chain ID. After a fork, `registerFor` signatures stop working on the new chain but proofs keep working there. This is an inconsistency, not an exploit. Possible fix: store the deploy chain ID and revert `vote`/`register` when `block.chainid` differs.

### Commits

- `d910094` Added this report (R1-1 design note).
- `a40d6b4` Round 1 results and the R1-2 Info note.

## Round 2 (2026-11-16)

**Status:** merged `main` (the MVP frontend in `site/`, pointed at a local chain) into `Grok`. Stress testing of the frontend setup has started; IP tracking is assumed out of reach. One Low contract bug was fixed.

| # | Title | Severity | Goal | Status |
|---|-------|----------|------|--------|
| R2-1 | Duplicate whitelist entries can brick voting | Low | 7 | Fixed `52f67ed4` |
| R2-2 | Frontend bypasses Semaphore and publishes wallet-to-ballot on-chain | Critical | 1 | Leak fixed `bb17de88`; Semaphore voting in the UI still to do |
| R2-3 | `RelayReward.relay()` pays for any unseen id, so it can be drained | Critical | n/a (funds) | Reproduced by Red (local: 100 random ids drained ~0.99 ETH) |
| R2-4 | Relayer Nostr private key is committed and shipped to browsers | High | 4 | Removed from repo and site `bb17de88`; **key still in git history, must be rotated** |
| R2-5 | `VoteLedger.record()` callable by anyone with a voter's signed ballot | Medium | 1 | Partly confirmed: unauthorized stuffing blocked; removed with the ledger |
| R2-6 | Smaller relayer issues | Low | 7 | Fixed `bb17de88` (relayer runs, CORS pinned) |
| R2-7 | UI and relayer trust served JSON files over the chain | Medium | 3, 4 | Open |
| R2-8 | Relayer reads request bodies with no size limit | Medium | 7 | Fixed `bb17de88` (64 KB cap) |
| R2-9 | Shared Nostr key lets anyone delete pending vote notes (NIP-09) | High | 7 | Design, fixed by per-vote throwaway keys |
| R2-10 | Flooding the shared key or tag can get it throttled on public relays | Medium | 7 | Design |
| R2-11 | Relayer can withhold a vote; voter has no inclusion check | Medium | 4, 7 | Design |
| R2-12 | Reward to `msg.sender` can be front-run by copying calldata | Low | n/a | Design note |

**R2-1.** The constructor checked `minAnonymitySet` against the raw `whitelist_.length`, but only distinct wallets can register. With a whitelist like `[alice, alice, bob]` and `minAnonymitySet = 3`, voting reverts `AnonymitySetTooSmall` forever, even at 100% turnout. Found by Scout, reproduced by Red (`test_dupWhitelist_bricksVoting`). Fix: the constructor reverts with `DuplicateWhitelistEntry`, so the raw length equals the distinct count. Test: `test_constructor_revertsOnDuplicateWhitelistEntry`. All 131 Foundry tests pass.

**R2-2.** `site/main.html` (~381-446) has the voter `personal_sign` their wallet plus plaintext choices. The relayer then calls `VoteLedger.record(eventId, voter, sig, merkleProof, choices)`, which emits wallet to ballot publicly (`VoteRecorded`), and `/relay` also posts the voter address and choice to public Nostr relays. Ballot secrecy is gone even with perfect IP masking. Fix: route votes through the `Election` contracts' anonymous `vote(proof)` and drop the voter address from every public record.

**R2-3.** `relay(bytes32 eventId)` pays `msg.sender` for any nonzero id it hasn't seen, with no proof that a vote exists, so looping random ids empties the contract. Source only exists in `legacy/hardhat` build artifacts. Fix: only pay out from inside a successful `vote()`, keyed by the nullifier.

**R2-4.** `NOSTR_PRIVATE_KEY` is committed in `.env` and its `nsec` is shipped in `site/nostr-key.js`. `/nostr-vote` "authenticates" by comparing the submitted `nsec`, so anyone can post as the relayer. Fix: rotate the key, remove it from git history and the site, and give the relayer real auth.

**R2-5.** The deployed `VoteLedger` source isn't in the repo; the legacy one lets anyone call `record()` with an arbitrary `voter`. Needs confirmation.

**R2-6.** The relayer `require`s seven modules that aren't committed, so it can't run from the repo. It also answers any origin (`CORS *`), so any site the voter visits can spend its gas, and its sign-in message has no nonce or domain, so it can be replayed.

**R2-7.** `main.html` and the relayer only check that `vote-ledger.json` and `allowlist.json` have matching roots. Neither file is compared against on-chain state, so whoever serves `site/` decides which ledger and allowlist voters sign for. Separately, `scripts/networks.js` falls back to `network.json` (Arc Testnet) when `ARC_NETWORK` is unset, so the relayer targets testnet with `RELAYER_PRIVATE_KEY` by default. Fix: read the roots and addresses from the chain, and default `ARC_NETWORK` explicitly.

**Round 2 notes.** Red confirmed R2-2 end to end: one vote through `/nostr-vote` made dev wallet `0x7099…79C8` and its choices public via `VoteRecorded`. For R2-4, the key is also returned by unauthenticated `GET /info` and `GET /nostr`. On `main`/`Grok` the relayer doesn't start (`Cannot find module './voteMessage'`), so Red tested branch `frontend_` (`49ab5c1`). About 21k `node_modules` files are committed to `main`. Niccolo confirmed the wallet signature is meant only for registration, so the ledger vote path is a bug and will be removed. Agreed fix direction: Nostr notes carry only the Semaphore `vote(proof)` payload, posted with throwaway keys and an election tag, and the relay reward is paid inside `vote()`. Red's regression suite is at `dapp/test/poc/RedTeam.t.sol` (`4c30968`).

**Nostr relay design (R2-9 to R2-12).** Target is Arc Testnet (Niccolo). With one shared `nsec`, anyone counts as the author of every vote note and can delete them with NIP-09 kind-5 events before a relayer sees them; throwaway keys per vote fix this. Junk under a shared key or tag can get it rate-limited on damus, nos.lol or primal, so relayers should run the `verifyProof` view and check `nullifierUsed` before spending gas, and can require NIP-13 proof-of-work. The UI should watch `nullifierUsed[nullifier]` and fall back to another relayer, or let the voter submit directly, if the vote doesn't land. If the reward goes to `msg.sender` inside `vote()`, mempool watchers can copy a relayer's calldata and take it; it doesn't hurt the vote, but nothing binds the relayer today.

### Commits

- Merged `origin/main` (frontend MVP) into `Grok`.
- `52f67ed4` Fix R2-1 (reject duplicate whitelist entries) and add a regression test.
- `bb17de88` Rewrote `scripts/relayer.js` to accept only Semaphore proofs (`POST /vote` and Nostr notes tagged `goblett-vote:<chainId>:<election>`), check `nullifierUsed` and simulate before paying gas, cap bodies at 64 KB, pin CORS to `RELAYER_ALLOWED_ORIGIN`, and never return a key. It no longer needs the seven missing modules. Removed the wallet-signed vote submission from `site/main.html`, deleted `site/nostr-key.js`, untracked `.env`, and added `.gitignore`. Tested on local anvil: a vote is relayed, a replay is refused, and oversize bodies are cut off.

**Still to do for R2-2/R2-3:** in-browser registration plus Semaphore proof generation in `site/main.html`, and moving the relay reward into `Election.vote()`. The voting button is disabled until then.
