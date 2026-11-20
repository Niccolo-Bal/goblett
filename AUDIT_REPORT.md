# goblett audit: status report

Branch `Grok`, reset to `main` `9653e7b9` (the version goblett.xyz serves) on 2026-11-16. Team: Scout (code review), Red (exploit PoCs), Blue (fixes + report). Round 1 and 2 findings were against the older code and are dropped; only what still reproduces is carried over.

Scope this round: `main` on Arc Testnet (chain 5042002) plus local copies. Any contract may be tested. IP linking is out of scope (no OHTTP yet) but noted for later.

## Final round: live site, Circle, faucet, onramp, elections (2026-11-20, `main` `1753e846`)

| ID | Finding | Severity | Status |
|---|---|---|---|
| R5-1 | `/api/circle` `emailToken` has no limit: anyone can make Circle email sign-in codes to any address, under our Circle app | Medium | Fixed in code; deploy needed |
| R5-2 | Faucet checked the `latest` balance, so repeat requests before the first transfer is mined each got 2 USDC | Low | Fixed |
| R5-3 | Faucet has no per-address limit, so many fresh wallets can drain it (testnet funds only) | Low | Limited per address by R5-1's fix; rest accepted |

**Deploy:** the new `WRITE_LIMITER` binding in `site/wrangler.jsonc` (10 POSTs per minute per address per `/api/*` route) takes effect on the next `wrangler deploy`. `RELAY_TOKEN` (R4-5) is still unset on the live OHTTP Workers.

Reviewed and fine: `circle.js` only forwards the user's own session token, and signing still needs confirmation in Circle's window. Onramp funds go only to the named address. Identity secrets stay random and local, so Circle never sees them.

### Final round commits

- `f82b4e8e` `worker.js` limits POSTs to each `/api/*` route to 10 per minute per address with a Cloudflare rate-limit binding (R5-1, R5-3). The faucet checks the `pending` balance (R5-2). Site tests and build pass.


## Round 4: OHTTP and accounts (2026-11-17, `main` `98268aa5`)

Niccolo's "round 3". IDs start at R4 so they don't clash with the table below. IP linking is now in scope. Testing was on testnet and local copies only, with no mainnet transactions.

| # | Title | Severity | Status |
|---|-------|----------|--------|
| R4-1 | `ohttp()` returns null on a 404, 5xx or HTML `/ohttp.json` (including the SPA fallback) and caches it, so publishing and private reads silently go direct over the real IP (Scout, Red PoC) | High | Fixed `653990b8`, verified by Red and Scout |
| R4-2 | Every 10 s refresh sends `isWhitelisted(wallet)` and `hasRegistered(wallet)` to the RPC over the direct connection, tying the wallet to the IP (Scout, Red PoC) | Medium | Fixed `976fd8f0`, verified by Red and Scout |
| R4-3 | Same-origin direct requests still leak: the `/api/account` lookup of the connected wallet and election reads in refresh (IP watches election E) | Medium | Username lookup fixed `8626c8bf`. Election reads still direct: the RPC only learns that an IP watches a public election |
| R4-4 | `/api/account`: a concurrent race lets an older `signed_at` win, a freed username can be squatted at once (risky if whitelists use names), and GET enumerates 100 per call with no rate limit. Live table missing (502) (Red) | Low | Race fixed `d5df27d4`. Squatting and enumeration accepted: names and addresses are public by design, the whitelist preview shows what each name resolves to before deploy, and a Cloudflare rate-limit rule on `/api/account` is advised |
| R4-5 | The gateway (`gateway.goblett.xyz`) is public with no rate limit: anyone gets a free anonymous Arc read RPC (20 calls per request) and a goblett-event publisher, and a flood could get its address rate-limited by the RPC or Nostr relays, stopping every voter now that the site fails closed (Red, Blue) | Medium | Fixed in code `fd09e37a` + `95f0949c`. **Niccolo: set `RELAY_TOKEN` on both Workers and redeploy them** |
| R4-6 | If one party runs both the relay and the gateway (both behind Cloudflare under goblett.xyz), they see IP and plaintext together and OHTTP hides nothing from them. Timing still links a vote to the request that sent it | Design | Accepted for now: Niccolo runs both (noted in the README). Needs an independent relay operator before OHTTP protects against the operator |
| R4-7 | `generateProof` downloads the depth-N circuit from `snark-artifacts.pse.dev` over a direct connection right before a vote, so that third party sees which IP is voting and when (Scout, Red) | High | Fixed `746c90ce`, verified by Red. If the browser cache is evicted, the vote-time fetch is still visible to the site host |

R3-5 and R3-7 retested on the relayer submodule (`70b25f6f`) and still hold (Red).

### Round 4 commits

- `653990b8` Built sites fail closed: if `/ohttp.json` is missing, not JSON or incomplete, `ohttp()` throws (not cached, so it retries) instead of returning null. Only the Vite dev server may run without it. Red's `test-ohttp-fallback.mjs` now throws on the 404 case instead of going direct (R4-1).
- `976fd8f0` Wallet whitelist and registration status are read through `privateElection()`, once per wallet and again after registering, not on every refresh over the direct RPC. If the private channel is down, the register panel says so rather than guessing (R4-2).
- `fd09e37a` Reviewed `ohttp/` (merged from `main` `bfc8e98c`). The relay now forwards a shared `RELAY_TOKEN` that the gateway requires, so the gateway can't be called directly, and it limits each address to 60 requests a minute with a Cloudflare rate-limit binding (counted in memory, not logged). Tests added to `ohttp/test.mjs`, all pass. README updated for R4-1 and this (R4-5). Otherwise the gateway looks sound: a method allowlist, size and batch caps, only kind-9467 events on goblett topics, a fixed upstream, and padded requests.
- `95f0949c` Following Red's review of `ohttp/`: `/publish` checks each event's id and Schnorr signature (`nostr-tools` `verifyEvent`) before opening any relay connection. `/rpc` refuses full-transaction blocks and state overrides, and caps `eth_call` gas at 30M (Arc's block limit). The Node gateway caps request bodies at 64 KB like the relay. Calls to any contract stay allowed, because elections are created freely; the rate limit bounds that. Tests added, all pass (R4-5).
- `d5df27d4` `/api/account` writes as a conditional `PATCH ... signed_at=lt.issuedAt`, then falls back to a plain insert, so the freshness check is atomic with the write and an older signature can't land last. New `site/test-account-race.mjs` (20 interleaved old/new races, newest always wins); `test-accounts.mjs` mock updated, all pass (R4-4).
- `8626c8bf` Connecting a wallet no longer sends its address to `/api/account`. The account card has a "Look up my username" button and says the lookup reveals the wallet to goblett's server (R4-3).
- `746c90ce` Votes are always proven at depth 20 with `wasm`/`zkey` served by the site (`site/public/snark/`, 5.7 MB, from PSE's 4.13.0 release, sha256 `6f71e555…` / `33f9a067…`) and prefetched on page load, so nothing contacts pse.dev and the fetch isn't timed to the vote. Shorter Merkle proofs are padded; a depth-20 proof for a 3-member group verifies (R4-7).

## Round 3 (2026-11-16)

| # | Title | Severity | Status |
|---|-------|----------|--------|
| R3-1 | `relayer/relayer.env` is committed with a funded `DEPLOYER_KEY` (`0x273d…383d`, about 39 USDC) | High | Untracked `1520e434`. Key is still in git history; Niccolo is burning it (2026-11-17). |
| R3-2 | Duplicate whitelist entries can push `minAnonymitySet` past the distinct voters and brick voting (was R2-1) | Low | Fixed `1520e434` |
| R3-3 | Unauthenticated Nostr reply text and revert reasons go into `innerHTML`, so anyone can run script on goblett.xyz and read every identity secret in localStorage (Scout) | Critical | Fixed `ac0a7904` + `68d41c27` (escaping, incl. `phase()` in the info panel found by Red; Red confirmed all three paths dead on `68d41c27`). |
| R3-4 | A look-alike contract in `?election=` can return a real election's `scope()` and reorder `candidates()`, flipping a vote that then counts on the real election (Scout) | High | Fixed `ac0a7904` (site computes scope from chain ID and address and refuses a mismatch). Bytecode check added in R3-6 |
| R3-6 | Site renders any `?election=` contract without checking it is genuine, so every field it returns is an injection or spoofing path (Scout, Red) | High | Fixed `13f5fb4f`, verified by Red |
| R3-5 | One genuine, funded attacker election can starve the relayer's single queue for everyone else, and failed lookups aren't cached (Scout) | Medium | Fixed `2d4e6a6f`, verified by Red |
| R3-7 | A whitelisted contract wallet can burn gas in `isValidSignature` up to the 1M refund cap, draining `relayFunds()` ~4.4x faster than honest registrations, so reimbursement-requiring relayers stop forwarding (Scout, Red PoC) | Medium | Fixed `d2232b3d`, verified by Red (grief drain 1.4x honest, was 4.4x) |
| R3-8 | Anyone can post a fake relayer reply that makes the site show a vote or registration as rejected (Scout) | Low | Fixed `f7dfd84d` |
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
- `46bd874c` `confirm()` no longer fails fast on a reply; it waits for the on-chain check and on timeout says the request is still pending, quoting any reply error as unverified (R3-8). Keeps relaying permissionless instead of allowlisting relayer keys.
- `f7dfd84d` Per Niccolo, the browser no longer reads relayer replies at all: `confirm()` just polls `hasRegistered` / `nullifierUsed` on-chain (R3-8).
