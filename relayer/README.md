# goblett relayer + local test election

Registrations and votes travel over **Nostr**. The site publishes each one as a Nostr
event tagged with the election's topic; the relayer subscribes to that topic and submits
them to the chain (`registerFor` / `vote`), paying the gas. The browser never talks to
the relayer directly, and anyone can run another relayer on the same topic.

| | |
|---|---|
| Relays | `nostrRelays` in `election.json` (default `wss://nos.lol`, `wss://relay.primal.net`; set with `setup_chain.py --nostr-relays`) |
| Topic | tag `["t", "goblett-<chainId>"]`, one per chain |
| Request, kind 9467 | content `{"type":"register", election, wallet, identityCommitment, signature}` or `{"type":"vote", election, proof, ranking?}` |
| Reply, kind 9468 | tag `["e", <request id>]`, content `{ok, txHash?, error?}` |

The relayer serves **any genuine goblett election** on its chain, so an election created
from the website works with no relayer configuration. Before forwarding, it checks that
the contract's code is exactly our `FPTPElection` / `RankedChoiceElection` build
(comparing runtime bytecode with the immutable slots zeroed) and that it uses our
Semaphore. It also refuses calls needing more than 3M gas. Without these checks anyone
could make the relayer pay for calls to arbitrary contracts.

Every event is signed with a fresh throwaway Nostr key. That signature authorizes
nothing: a registration is authorized by the wallet's EIP-712 signature and a vote by
its Semaphore proof, so a relayer can't change either; it can only ignore them. Replies
are a courtesy and unauthenticated; the site waits for the chain itself
(`hasRegistered` / `nullifierUsed`) before showing success.

## Run it locally (4 terminals)

```bash
# 1. chain (WSL)
~/.foundry/bin/anvil

# 2. one-time setup per chain start (Windows, in relayer/): deploys Semaphore, writes the
#    config, exports the contracts for the site, gives your wallet test funds
python -m venv .venv && .venv\Scripts\pip install -r requirements.txt   # once
.venv\Scripts\python setup_chain.py --fund 0xYOUR_METAMASK

# 3. relayer (restart it after setup_chain.py deploys a new Semaphore, or after `forge build`)
.venv\Scripts\python relayer.py

# 4. site (in site/)
npm install && npm run dev        # open http://localhost:5173
```

Create an election from the site ("Create a new election": title, type, candidates,
voter wallets, registration end, voting end) and confirm the deployment in MetaMask. The
site then opens it at `?election=<address>&block=<deploy block>`; share that link with
voters. `deploy_election.py` does the same from the command line.

After changing the contracts: `forge build`, then `setup_chain.py` again (it re-exports
`site/contracts.json`), then restart the relayer. Elections deployed from an older build
are refused by the relayer.

Skip waiting on a local chain: `.venv\Scripts\python advance.py voting 0xELECTION` (or
`ended`, or N seconds). This moves the chain's clock ahead of your computer's.

MetaMask: the site asks to switch to chain 31337 (adds it, RPC `http://127.0.0.1:8545`, if
missing). Voters only sign and need no funds; the wallet that creates an election pays
for its deployment. After restarting anvil, MetaMask may remember old transaction counts:
if a deployment hangs, use MetaMask's "Clear activity tab data" for the account.

`site/smoke-test.mjs [fptp|ranked]` runs the whole flow headlessly with anvil wallets.

## Limits

- The messages are public on the Nostr relays (as they would be on a public chain), and
  the relays see the sender's IP and timing instead of our relayer. Registering and
  voting from the same IP gives a relay operator a hint. Use Tor/VPN for anything real.
- Anyone can post to the topic. Invalid messages cost the relayer only a simulation
  (no gas), but there is no rate limit yet.
- The relayer catches up on at most the last 24 hours of events, and never on events
  older than the chain itself. After a local chain restart a new election can reuse an
  old address, and an old registration signature for it would otherwise still be valid.
- The identity secret is in the browser's localStorage only. Clearing site data loses
  the vote; back it up from the page.
- No bounty yet: the relayer pays all gas.
