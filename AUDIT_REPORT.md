# goblett audit: status report

Branch `Grok`, reset to `main` `9653e7b9` (the version goblett.xyz serves) on 2026-11-16. Team: Scout (code review), Red (exploit PoCs), Blue (fixes + report). Round 1 and 2 findings were against the older code and are dropped; only what still reproduces is carried over.

Scope this round: `main` on Arc Testnet (chain 5042002) plus local copies. Any contract may be tested. IP linking is out of scope (no OHTTP yet) but noted for later.

## Round 3 (2026-11-16)

| # | Title | Severity | Status |
|---|-------|----------|--------|
| R3-1 | `relayer/relayer.env` is committed with a funded `DEPLOYER_KEY` (`0x273d…383d`, about 39 USDC) | High | Untracked `1520e434`. **Key is still in git history: rotate it and move the funds.** |
| R3-2 | Duplicate whitelist entries can push `minAnonymitySet` past the distinct voters and brick voting (was R2-1) | Low | Fixed `1520e434` |
| R1-1 | Anonymity set counts registrations, not honest voters | Info | Design note, still applies |

**R3-1.** Found by Red. `common.py` now loads `relayer/.env` first (as its docstring and `.env.example` already said) and still reads `relayer.env` if present; both are gitignored.

**R1-1.** Anyone controlling K whitelisted wallets can register K throwaway identities and meet `minAnonymitySet` with an empty set. Size the threshold to expected honest turnout.

### Commits

- `1520e434` Untracked `relayer/relayer.env`, gitignored it, and made `common.py` load `relayer/.env` (R3-1). Ported the duplicate-whitelist revert and its test to the new `Election.sol` (R3-2). Forge: 167 passed, 0 failed.
