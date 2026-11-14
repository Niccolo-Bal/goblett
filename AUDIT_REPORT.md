# goblet audit: status report

Branch `Grok`. Team: Scout (code review), Red (exploit PoCs), Blue (fixes + report).

## Round 1 (2026-11-14)

**Status:** first pass of `Election`, `FPTPElection` and `RankedChoiceElection` done. No confirmed exploit yet. Red is testing leads on signature auth, double voting, phase boundaries and IRV correctness.

### Findings

| # | Title | Severity | Goal | Status |
|---|-------|----------|------|--------|
| R1-1 | Anonymity set counts registrations, not honest voters | Info | 1, 3 | Design note, no code fix |

**R1-1.** `registeredCount` counts registrations. Anyone who controls K whitelisted wallets can register K identities, including throwaway commitments with no known secret, and so meet `minAnonymitySet` with a set that looks real but is empty. Mitigation: govern the whitelist and size `minAnonymitySet` to the expected *honest* turnout, not to the whitelist length.

### Commits

- Added this report (R1-1 design note).
