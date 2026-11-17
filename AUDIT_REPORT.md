# goblett audit: status report

Branch `Grok`, reset to `main` `9653e7b9` (the version goblett.xyz serves) on 2026-11-16. Team: Scout (code review), Red (exploit PoCs), Blue (fixes + report). Round 1 and 2 findings were against the older code and are dropped; only what still reproduces is carried over.

Scope this round: `main` on Arc Testnet (chain 5042002) plus local copies. Any contract may be tested. IP linking is out of scope (no OHTTP yet) but noted for later.

## Round 3 (2026-11-16)

| # | Title | Severity | Status |
|---|-------|----------|--------|
| R3-1 | `relayer/relayer.env` is committed with a funded `DEPLOYER_KEY` (`0x273d…383d`, about 39 USDC) | High | Untracked `1520e434`. **Key is still in git history: rotate it and move the funds.** |
| R3-2 | Duplicate whitelist entries can push `minAnonymitySet` past the distinct voters and brick voting (was R2-1) | Low | Fixed `1520e434` |
| R3-3 | Unauthenticated Nostr reply text and revert reasons go into `innerHTML`, so anyone can run script on goblett.xyz and read every identity secret in localStorage (Scout) | Critical | Fixed `ac0a7904` + `68d41c27` (escaping, incl. `phase()` in the info panel found by Red; Red confirmed all three paths dead on `68d41c27`). Accepting replies only from known relayer pubkeys is still open |
| R3-4 | A look-alike contract in `?election=` can return a real election's `scope()` and reorder `candidates()`, flipping a vote that then counts on the real election (Scout) | High | Fixed `ac0a7904` (site computes scope from chain ID and address and refuses a mismatch). Bytecode check added in R3-6 |
| R3-6 | Site renders any `?election=` contract without checking it is genuine, so every field it returns is an injection or spoofing path (Scout, Red) | High | Fixed `13f5fb4f`, verified by Red |
| R3-5 | One genuine, funded attacker election can starve the relayer's single queue for everyone else, and failed lookups aren't cached (Scout) | Medium | Fixed `2d4e6a6f`, verified by Red |
| R3-7 | A whitelisted contract wallet can burn gas in `isValidSignature` up to the 1M refund cap, draining `relayFunds()` ~4.4x faster than honest registrations, so reimbursement-requiring relayers stop forwarding (Scout, Red PoC) | Medium | Fixed `d2232b3d`, verified by Red (grief drain 1.4x honest, was 4.4x) |
| R1-1 | Anonymity set counts registrations, not honest voters | Info | Design note, still applies |

**R3-1.** Found by Red. `common.py` now loads `relayer/.env` first (as its docstring and `.env.example` already said) and still reads `relayer.env` if present; both are gitignored.

**R1-1.** Anyone controlling K whitelisted wallets can register K throwaway identities and meet `minAnonymitySet` with an empty set. Size the threshold to expected honest turnout.

### Commits

- `1520e434` Untracked `relayer/relayer.env`, gitignored it, and made `common.py` load `relayer/.env` (R3-1). Ported the duplicate-whitelist revert and its test to the new `Election.sol` (R3-2). Forge: 167 passed, 0 failed.
- `ac0a7904` `setStatus` and the `winners()` error now escape their text, and Nostr reply errors are capped at 200 chars (R3-3). Votes now use a scope computed locally as `keccak256(chainId, address)` and refuse a contract whose `scope()` differs (R3-4), with the formula checked against an on-chain value.

**Future (IP out of scope):** registration (carries the wallet) and voting go from the same browser to the same two relays, linkable by IP and timing. Identity secrets sit in localStorage under keys containing the wallet address.
- `68d41c27` Escaped the contract-supplied `phase()` string in the info panel, a second R3-3 sink Red found.
- `13f5fb4f` The site now matches `?election=` runtime code against `contracts.json` with immutables masked (same as `lookup_election`) and checks `semaphore()`, refusing anything else (R3-6). `setup_chain.py` exports `deployedBytecode` and `immutableReferences`; `contracts.json` regenerated. Tested on anvil: a real FPTP election matches, another contract is refused. Elections deployed from the old build will no longer load and must be redeployed.
- `819019e4` Escaped identity labels in the identity `<option>` list (same sink class as R3-3, found by Red; labels are local today).
- Red, refund path: no profitable drain. `registerFor` is reimbursed slightly *less* than its cost, and ERC-1271 gas burn is capped by `MAX_REFUND_GAS` and paid by the sender.
- `2d4e6a6f` Relayer queues requests per election and serves them round-robin (priority elections from `PRIORITY_ELECTIONS` plus the configured one get `PRIORITY_WEIGHT`=4 turns), caps each election at 200 pending, and caches failed lookups for 10 min (R3-5). Simulated 50 attacker events then 3 real ones: real served at positions 1, 3, 5 (was 50 to 52). Test: `relayer/test_fair_queue.py`.
- `d2232b3d` New `MAX_REGISTER_REFUND_GAS` = 300k caps the refund for `registerFor` (honest is ~210k); votes keep the 1M cap. Expensive wallets still register, only the refund is capped. The relayer's reimbursement precheck mirrors it, and `contracts.json` is regenerated. New test with a gas-burning ERC-1271 wallet; Forge 169 passed, 0 failed (R3-7).
