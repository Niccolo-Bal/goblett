# End-to-end test on a local Arc node

`run.sh` starts a local node, deploys Semaphore v4 (`script/DeploySemaphore.s.sol`),
then `arc-e2e.mjs` deploys an Election and runs it with **real Groth16 proofs**:
registration, root matching, the `validateProof` front-running attack, replay,
message tampering, wrong scope, double voting, tally, winners.

## Install Arc Foundry (once, in WSL)

From <https://github.com/circlefin/arc-foundry/releases> (Linux x86_64 build):

```bash
V=v0.8.0-4; T=x86_64-unknown-linux-gnu
curl -LO https://github.com/circlefin/arc-foundry/releases/download/$V/arc-foundry-$V-$T.tar.gz
curl -LO https://github.com/circlefin/arc-foundry/releases/download/$V/arc-foundry-$V-$T.tar.gz.sha256
sha256sum -c arc-foundry-$V-$T.tar.gz.sha256
tar -xzf arc-foundry-$V-$T.tar.gz
mkdir -p ~/.local/bin
mv forge ~/.local/bin/arc-forge; mv cast ~/.local/bin/arc-cast; mv anvil ~/.local/bin/arc-anvil
export PATH="$HOME/.local/bin:$PATH"   # add to ~/.bashrc
```

## Run

```bash
npm install                      # once
e2e/run.sh                       # arc-anvil --network arc
ANVIL_CMD="arc-anvil --fork-url https://rpc.testnet.arc.io" e2e/run.sh
ANVIL_CMD=anvil e2e/run.sh       # plain anvil
arc-forge test                   # unit + real-Semaphore integration tests
```

The first proof downloads the Semaphore SNARK artifacts (needs internet).
Node logs go to `e2e/node.log`, deploy output to `e2e/deploy.log`.

Anvil dev account #1 (`0x7099…79C8`) is never used: Arc testnet blocklists it.
