"""Shared helpers for the relayer and the deploy/advance scripts.

Contract ABIs/bytecode come from the Foundry build in ../dapp/out (run `forge build`).
"""

import json
import os
from pathlib import Path

from web3 import Web3
from web3.exceptions import ContractCustomError, ContractLogicError

HERE = Path(__file__).resolve().parent
DAPP = HERE.parent / "dapp"
CONFIG_PATH = HERE / "election.json"

RPC_URL = os.environ.get("RPC_URL", "http://127.0.0.1:8545")
# Anvil dev keys (public, test-only). #1 is skipped: Arc testnet blocklists it.
DEPLOYER_KEY = os.environ.get(
    "DEPLOYER_KEY", "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
)  # #0
RELAYER_KEY = os.environ.get(
    "RELAYER_KEY", "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6"
)  # #9

KINDS = {"fptp": "FPTPElection", "ranked": "RankedChoiceElection"}


def artifact(name: str) -> dict:
    path = DAPP / "out" / f"{name}.sol" / f"{name}.json"
    if not path.exists():
        raise SystemExit(f"missing {path}; run `forge build` in dapp/")
    return json.loads(path.read_text())


def connect(rpc_url: str = RPC_URL) -> Web3:
    w3 = Web3(Web3.HTTPProvider(rpc_url, request_kwargs={"timeout": 60}))
    if not w3.is_connected():
        raise SystemExit(f"cannot reach RPC at {rpc_url} (is anvil running?)")
    return w3


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        raise SystemExit(f"{CONFIG_PATH.name} not found; run deploy_election.py first")
    return json.loads(CONFIG_PATH.read_text())


def _error_selectors() -> dict:
    """4-byte selector -> error name, for Election + Semaphore custom errors."""
    out = {}
    for name in ("FPTPElection", "RankedChoiceElection", "Semaphore"):
        for item in artifact(name)["abi"]:
            if item["type"] == "error":
                sig = f"{item['name']}({','.join(i['type'] for i in item['inputs'])})"
                out[Web3.keccak(text=sig)[:4].hex().removeprefix("0x")] = item["name"]
    return out


_SELECTORS = None


def revert_reason(e: Exception) -> str:
    """Turn a web3 revert into the contract's custom error name when possible."""
    global _SELECTORS
    if _SELECTORS is None:
        _SELECTORS = _error_selectors()
    data = getattr(e, "data", None)
    if isinstance(e, (ContractCustomError, ContractLogicError)) and isinstance(data, str):
        sel = data.removeprefix("0x")[:8]
        if sel in _SELECTORS:
            return _SELECTORS[sel]
    msg = str(e.args[0]) if e.args else str(e)
    return msg[:200]


def send(w3: Web3, account, fn, gas_floor: int = 0) -> dict:
    """Simulate (estimate_gas reverts with the reason), then sign, send, and wait."""
    gas = fn.estimate_gas({"from": account.address})
    tx = fn.build_transaction(
        {
            "from": account.address,
            "nonce": w3.eth.get_transaction_count(account.address, "pending"),
            "gas": max(int(gas * 1.2), gas_floor),
        }
    )
    signed = account.sign_transaction(tx)
    h = w3.eth.send_raw_transaction(signed.raw_transaction)
    return w3.eth.wait_for_transaction_receipt(h, timeout=120)
