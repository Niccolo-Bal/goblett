"""Minimal goblet relayer: an unauthenticated HTTP endpoint that forwards signed
registrations and anonymous votes to the election contract, paying the gas.

    GET  /config     election address, chain, RPC (from election.json)
    POST /register   {"wallet", "identityCommitment", "signature"}   -> registerFor
    POST /vote       {"proof": {...}, "ranking": [..]?}               -> vote

The relayer can't forge or alter anything: registerFor checks the wallet's EIP-712
signature, and vote() checks the Semaphore proof, which binds the ballot. It could
refuse to forward (censor); a voter then submits through someone else.

Privacy: no cookies, no accounts, and request IPs are not logged. The relayer still
sees network metadata (IP, timing), so a voter who registers and votes from the same
IP through the same relayer gives it a hint. Use Tor/VPN for real elections.

Env: RPC_URL, RELAYER_KEY, PORT (default 8787).
"""

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from eth_account import Account
from web3 import Web3

from common import CONFIG_PATH, KINDS, RELAYER_KEY, RPC_URL, artifact, connect, load_config, revert_reason, send

PORT = int(os.environ.get("PORT", "8787"))
MAX_BODY = 16 * 1024
U256 = 2**256

w3 = connect(RPC_URL)
relayer = Account.from_key(RELAYER_KEY)
tx_lock = threading.Lock()  # one tx at a time, so nonces never collide
cfg, election, _cfg_mtime = None, None, None


def reload_config():
    """(Re)load election.json when it changes, so redeploying needs no restart."""
    global cfg, election, _cfg_mtime
    mtime = CONFIG_PATH.stat().st_mtime if CONFIG_PATH.exists() else None
    if mtime == _cfg_mtime and cfg:
        return
    new = load_config()
    if w3.eth.chain_id != new["chainId"]:
        raise SystemExit(f"RPC chain {w3.eth.chain_id} != election.json chain {new['chainId']}")
    cfg, _cfg_mtime = new, mtime
    election = w3.eth.contract(address=cfg["election"], abi=artifact(KINDS[cfg["kind"]])["abi"])
    print(f"  serving election {cfg['election']} ({cfg['kind']})")


class BadRequest(Exception):
    pass


def uint(x, name) -> int:
    try:
        v = int(x, 0) if isinstance(x, str) else int(x)
    except (TypeError, ValueError):
        raise BadRequest(f"{name} must be an integer")
    if isinstance(x, bool) or not 0 <= v < U256:
        raise BadRequest(f"{name} out of range")
    return v


def handle_register(body: dict) -> dict:
    try:
        wallet = Web3.to_checksum_address(body["wallet"])
        sig = bytes.fromhex(str(body["signature"]).removeprefix("0x"))
    except (KeyError, ValueError):
        raise BadRequest("need wallet (address) and signature (hex)")
    commitment = uint(body.get("identityCommitment"), "identityCommitment")
    fn = election.functions.registerFor(wallet, commitment, sig)
    return submit(fn, f"registerFor {wallet}")


def handle_vote(body: dict) -> dict:
    p = body.get("proof")
    if not isinstance(p, dict) or not isinstance(p.get("points"), list) or len(p["points"]) != 8:
        raise BadRequest("proof must have merkleTreeDepth, merkleTreeRoot, nullifier, message, scope, points[8]")
    proof = (
        uint(p.get("merkleTreeDepth"), "merkleTreeDepth"),
        uint(p.get("merkleTreeRoot"), "merkleTreeRoot"),
        uint(p.get("nullifier"), "nullifier"),
        uint(p.get("message"), "message"),
        uint(p.get("scope"), "scope"),
        [uint(x, "points") for x in p["points"]],
    )
    if cfg["kind"] == "ranked":
        r = body.get("ranking")
        if not isinstance(r, list) or not 1 <= len(r) <= 32:
            raise BadRequest("ranked election: ranking must be a list of 1..32 candidate indices")
        fn = election.functions.vote(proof, [uint(x, "ranking") for x in r])
    else:
        fn = election.functions.vote(proof)
    # Log only the nullifier: it is public on-chain anyway and links to nothing.
    return submit(fn, f"vote nullifier {hex(proof[2])[:14]}...")


def submit(fn, label: str) -> dict:
    with tx_lock:
        try:
            rcpt = send(w3, relayer, fn)
        except Exception as e:  # revert during estimate_gas, or RPC failure
            reason = revert_reason(e)
            print(f"  rejected {label}: {reason}")
            return {"ok": False, "error": reason}
    ok = rcpt.status == 1
    print(f"  {'sent' if ok else 'FAILED'} {label}: tx {rcpt.transactionHash.to_0x_hex()} gas {rcpt.gasUsed}")
    return {"ok": ok, "txHash": rcpt.transactionHash.to_0x_hex(), "gasUsed": rcpt.gasUsed}


ROUTES = {"/register": handle_register, "/vote": handle_vote}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # default logs client IPs; we don't
        pass

    def _reply(self, code: int, obj: dict):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self._reply(204, {})

    def do_GET(self):
        reload_config()
        if self.path == "/config":
            self._reply(200, cfg)
        else:
            self._reply(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        handler = ROUTES.get(self.path)
        if not handler:
            return self._reply(404, {"ok": False, "error": "not found"})
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            return self._reply(413, {"ok": False, "error": "body too large"})
        reload_config()
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
            if not isinstance(body, dict):
                raise BadRequest("body must be a JSON object")
            res = handler(body)
            self._reply(200 if res["ok"] else 422, res)
        except (BadRequest, json.JSONDecodeError) as e:
            self._reply(400, {"ok": False, "error": str(e)})


def main():
    reload_config()
    bal = w3.eth.get_balance(relayer.address)
    print(f"goblet relayer on http://localhost:{PORT}")
    print(f"  chain {cfg['chainId']} via {RPC_URL}")
    print(f"  relayer wallet {relayer.address}, balance {Web3.from_wei(bal, 'ether')} (native)")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
