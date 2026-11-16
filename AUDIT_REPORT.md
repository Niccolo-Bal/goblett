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
| R2-2 | Frontend bypasses Semaphore and publishes wallet-to-ballot on-chain | Critical | 1 | Open, awaiting design decision |
| R2-3 | `RelayReward.relay()` pays for any unseen id, so it can be drained | Critical | n/a (funds) | Open, Red verifying on local chain |
| R2-4 | Relayer Nostr private key is committed and shipped to browsers | High | 4 | Open, key must be rotated |
| R2-5 | `VoteLedger.record()` may be permissionless (ballot stuffing) | High? | 2, 4 | Unconfirmed |
| R2-6 | Smaller relayer issues | Low | 7 | Open |

**R2-1.** The constructor checked `minAnonymitySet` against the raw `whitelist_.length`, but only distinct wallets can register. With a whitelist like `[alice, alice, bob]` and `minAnonymitySet = 3`, voting reverts `AnonymitySetTooSmall` forever, even at 100% turnout. Found by Scout, reproduced by Red (`test_dupWhitelist_bricksVoting`). Fix: the constructor reverts with `DuplicateWhitelistEntry`, so the raw length equals the distinct count. Test: `test_constructor_revertsOnDuplicateWhitelistEntry`. All 131 Foundry tests pass.

**R2-2.** `site/main.html` (~381-446) has the voter `personal_sign` their wallet plus plaintext choices. The relayer then calls `VoteLedger.record(eventId, voter, sig, merkleProof, choices)`, which emits wallet to ballot publicly (`VoteRecorded`), and `/relay` also posts the voter address and choice to public Nostr relays. Ballot secrecy is gone even with perfect IP masking. Fix: route votes through the `Election` contracts' anonymous `vote(proof)` and drop the voter address from every public record.

**R2-3.** `relay(bytes32 eventId)` pays `msg.sender` for any nonzero id it hasn't seen, with no proof that a vote exists, so looping random ids empties the contract. Source only exists in `legacy/hardhat` build artifacts. Fix: only pay out from inside a successful `vote()`, keyed by the nullifier.

**R2-4.** `NOSTR_PRIVATE_KEY` is committed in `.env` and its `nsec` is shipped in `site/nostr-key.js`. `/nostr-vote` "authenticates" by comparing the submitted `nsec`, so anyone can post as the relayer. Fix: rotate the key, remove it from git history and the site, and give the relayer real auth.

**R2-5.** The deployed `VoteLedger` source isn't in the repo; the legacy one lets anyone call `record()` with an arbitrary `voter`. Needs confirmation.

**R2-6.** The relayer `require`s seven modules that aren't committed, so it can't run from the repo. It also answers any origin (`CORS *`), so any site the voter visits can spend its gas, and its sign-in message has no nonce or domain, so it can be replayed.

### Commits

- Merged `origin/main` (frontend MVP) into `Grok`.
- `52f67ed4` Fix R2-1 (reject duplicate whitelist entries) and add a regression test.
