# goblet relayer + local test election

The relayer is an unauthenticated HTTP endpoint on this laptop (`http://localhost:8787`).
The site posts signed registrations and anonymous vote proofs to it, and it submits
them to the chain (`registerFor` / `vote`), paying the gas. It can't change a
registration (EIP-712 signature) or a ballot (bound into the proof); it can only refuse.

| Endpoint | Body | Contract call |
|---|---|---|
| `GET /config` | none | returns `election.json` |
| `POST /register` | `{wallet, identityCommitment, signature}` | `registerFor` |
| `POST /vote` | `{proof, ranking?}` | `vote` |

## Run a test election (4 terminals)

```bash
# 1. chain (WSL)
~/.foundry/bin/anvil

# 2. deploy (Windows, in relayer/). Times are minutes of chain time.
python -m venv .venv && .venv\Scripts\pip install -r requirements.txt   # once
.venv\Scripts\python deploy_election.py --title "Lunch" --candidates Pizza Sushi Tacos ^
    --whitelist 0xYOUR_METAMASK_1 0xYOUR_METAMASK_2 --reg 10 --vote 30 --min-anon 2
# add --kind ranked for instant runoff

# 3. relayer (reloads election.json by itself after a redeploy)
.venv\Scripts\python relayer.py

# 4. site (in site/)
npm install && npm run dev        # open http://localhost:5173
```

Skip waiting on a local chain: `.venv\Scripts\python advance.py voting` (or `ended`, or N seconds).

MetaMask: the site asks to switch to chain 31337 (adds it, RPC `http://127.0.0.1:8545`, if
missing). MetaMask only signs; voter wallets need no funds. The relayer uses anvil
dev key #9 and the deployer #0 (override with `RELAYER_KEY` / `DEPLOYER_KEY`, `RPC_URL`).

`site/smoke-test.mjs` runs the whole flow headlessly with anvil wallets #2 and #3.

## Limits

- The relayer sees IP and timing. Registering and voting from the same IP through the
  same relayer gives it a hint linking the two. Use Tor/VPN for anything real.
- The identity secret is in the browser's localStorage only. Clearing site data loses
  the vote; back it up from the page.
- One relayer, no bounty yet: it pays all gas, and if it censors you, you need another.
