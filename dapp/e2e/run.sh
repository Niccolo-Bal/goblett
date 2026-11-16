#!/usr/bin/env bash
# Start a local node, deploy Semaphore + run the real-proof e2e test, stop the node.
#
#   e2e/run.sh                              # arc-anvil --network arc (default)
#   ANVIL_CMD="arc-anvil --fork-url https://rpc.testnet.arc.io" e2e/run.sh
#   ANVIL_CMD=anvil e2e/run.sh              # plain anvil, for comparison
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8545}"
RPC_URL="http://127.0.0.1:$PORT"
ANVIL_CMD="${ANVIL_CMD:-arc-anvil --network arc}"
# Anvil dev key #0 (public, test-only).
PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

# Prefer Arc's forge build when available.
FORGE=forge
command -v arc-forge >/dev/null && FORGE=arc-forge
if ! command -v "${ANVIL_CMD%% *}" >/dev/null; then
    echo "error: '${ANVIL_CMD%% *}' not found. Install Arc Foundry (see README in e2e/) or set ANVIL_CMD=anvil." >&2
    exit 1
fi

echo "== starting: $ANVIL_CMD --port $PORT"
$ANVIL_CMD --port "$PORT" >e2e/node.log 2>&1 &
NODE_PID=$!
trap 'kill $NODE_PID 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
    curl -s -X POST -H 'content-type: application/json' \
        --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$RPC_URL" >/dev/null && break
    sleep 0.5
done

echo "== building with $FORGE"
$FORGE build >e2e/build.log 2>&1 || { cat e2e/build.log; exit 1; }

echo "== deploying Semaphore"
$FORGE script script/DeploySemaphore.s.sol --rpc-url "$RPC_URL" --private-key "$PK" --broadcast >e2e/deploy.log 2>&1 \
    || { cat e2e/deploy.log; exit 1; }
SEMAPHORE=$(grep -oE 'Semaphore: +0x[0-9a-fA-F]{40}' e2e/deploy.log | grep -oE '0x[0-9a-fA-F]{40}')
echo "   Semaphore at $SEMAPHORE"

echo "== e2e"
SEMAPHORE="$SEMAPHORE" RPC_URL="$RPC_URL" node e2e/arc-e2e.mjs
