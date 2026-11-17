# goblett audit: status report

Branch `Grok`, reset to `main` `9653e7b9` (the version goblett.xyz serves) on 2026-11-16. Team: Scout (code review), Red (exploit PoCs), Blue (fixes + report). Round 1 and 2 findings were against the older code and are dropped; only what still reproduces is carried over.

Scope this round: `main` on Arc Testnet (chain 5042002) plus local copies. Any contract may be tested. IP linking is out of scope (no OHTTP yet) but noted for later.

## Round 3 (2026-11-16)

| # | Title | Severity | Status |
|---|-------|----------|--------|
| R3-1 | `relayer/relayer.env` is committed with a funded `DEPLOYER_KEY` (`0x273d…383d`, about 39 USDC) | High | Untracked `1520e434`. **Key is still in git history: rotate it and move the funds.** |
| R3-2 | Duplicate whitelist entries can push `minAnonymitySet` past the distinct voters and brick voting (was R2-1) | Low | Fixed `1520e434` |
| R3-3 | Unauthenticated Nostr reply text and revert reasons go into `innerHTML`, so anyone can run script on goblett.xyz and read every identity secret in localStorage (Scout) | Critical | Fixed `ac0a7904` + `68d41c27` (escaping, incl. `phase()` in the info panel found by Red). Accepting replies only from known relayer pubkeys is still open |
| R3-4 | A look-alike contract in `?election=` can return a real election's `scope()` and reorder `candidates()`, flipping a vote that then counts on the real election (Scout) | High | Fixed `ac0a7904` (site computes scope from chain ID and address and refuses a mismatch). Full bytecode check in the site still open |
| R3-5 | One genuine, funded attacker election can starve the relayer's single queue for everyone else, and failed lookups aren't cached (Scout) | Medium | Open |
| R1-1 | Anonymity set counts registrations, not honest voters | Info | Design note, still applies |

**R3-1.** Found by Red. `common.py` now loads `relayer/.env` first (as its docstring and `.env.example` already said) and still reads `relayer.env` if present; both are gitignored.

**R1-1.** Anyone controlling K whitelisted wallets can register K throwaway identities and meet `minAnonymitySet` with an empty set. Size the threshold to expected honest turnout.

### Commits

- `1520e434` Untracked `relayer/relayer.env`, gitignored it, and made `common.py` load `relayer/.env` (R3-1). Ported the duplicate-whitelist revert and its test to the new `Election.sol` (R3-2). Forge: 167 passed, 0 failed.
- `ac0a7904` `setStatus` and the `winners()` error now escape their text, and Nostr reply errors are capped at 200 chars (R3-3). Votes now use a scope computed locally as `keccak256(chainId, address)` and refuse a contract whose `scope()` differs (R3-4), with the formula checked against an on-chain value.

**Future (IP out of scope):** registration (carries the wallet) and voting go from the same browser to the same two relays, linkable by IP and timing. Identity secrets sit in localStorage under keys containing the wallet address.
- `68d41c27` Escaped the contract-supplied `phase()` string in the info panel, a second R3-3 sink Red found.
