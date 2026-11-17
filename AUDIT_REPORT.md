# goblett audit: status report

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
- Round 1 results and the R1-2 Info note.
