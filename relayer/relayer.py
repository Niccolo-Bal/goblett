"""goblett relayer: reads registrations and votes from a Nostr topic and forwards
them to the election contract, paying the gas.

Transport (see nostr.py): voters publish a kind-9467 event tagged
["t", "goblett-<chainId>"] to public Nostr relays. Its content is JSON:

    {"type": "register", "election", "wallet", "identityCommitment", "signature"}   -> registerFor
    {"type": "vote", "election", "proof": {...}, "ranking": [..]?}                   -> vote

The relayer serves ANY genuine goblett election on its chain, so elections created from
the website need no relayer configuration. "Genuine" = the contract's code is exactly
our FPTPElection / RankedChoiceElection build and it uses our Semaphore (see
lookup_election). Without that check anyone could make the relayer pay for calls to
arbitrary contracts.

The relayer answers with a kind-9468 event tagged ["e", <request id>] whose content is
{"ok", "txHash"?, "error"?}. That reply is a courtesy; voters should check the chain.

The relayer can't forge or alter anything: registerFor checks the wallet's EIP-712
signature, and vote() checks the Semaphore proof, which binds the ballot. Nostr events
are signed with throwaway keys, so the Nostr signature authorizes nothing. Anyone can
run another relayer on the same topic; whoever submits first wins and the rest see
AlreadyRegistered / NullifierAlreadyUsed in simulation (no gas spent).

Privacy: the relayer never sees a voter's IP; the Nostr relays do instead (plus
timing). Use Tor/VPN for real elections.

Env: RPC_URL, RELAYER_KEY.
"""

import asyncio
import json
import threading
import time

from eth_account import Account
from web3 import Web3

import nostr
from common import CONFIG_PATH, KINDS, RELAYER_KEY, RPC_URL, artifact, connect, load_config, revert_reason, send

MAX_CONTENT = 16 * 1024
U256 = 2**256

MAX_GAS = 3_000_000  # a register is ~200k and a vote ~400k; refuse anything far beyond

w3 = connect(RPC_URL)
relayer = Account.from_key(RELAYER_KEY)
tx_lock = threading.Lock()  # one tx at a time, so nonces never collide
cfg = None
elections = {}  # address -> (contract, kind), for addresses that passed lookup_election


def _masked_runtime(code: bytes, art: dict) -> bytes:
    """Runtime bytecode with the immutable slots zeroed. Immutables (schedule, scope,
    semaphore address, ...) are baked into the deployed code, so two elections differ
    there and only there."""
    code = bytearray(code)
    for refs in art["deployedBytecode"].get("immutableReferences", {}).values():
        for r in refs:
            code[r["start"] : r["start"] + r["length"]] = bytes(r["length"])
    return bytes(code)


TEMPLATES = {
    kind: (art, _masked_runtime(bytes.fromhex(art["deployedBytecode"]["object"].removeprefix("0x")), art))
    for kind, art in ((k, artifact(name)) for k, name in KINDS.items())
}


def lookup_election(addr) -> tuple:
    """Return (contract, kind) if `addr` is a genuine goblett election on this chain."""
    try:
        addr = Web3.to_checksum_address(addr)
    except (TypeError, ValueError):
        raise BadRequest("need election (address)")
    if addr in elections:
        return elections[addr]
    code = bytes(w3.eth.get_code(addr))
    for kind, (art, template) in TEMPLATES.items():
        if len(code) == len(template) and _masked_runtime(code, art) == template:
            contract = w3.eth.contract(address=addr, abi=art["abi"])
            if contract.functions.semaphore().call() != Web3.to_checksum_address(cfg["semaphore"]):
                raise BadRequest("election uses an unknown Semaphore contract")
            elections[addr] = (contract, kind)
            print(f"  serving election {addr} ({kind}): {contract.functions.title().call()!r}")
            return elections[addr]
    raise BadRequest("not a goblett election contract")


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
    election, _ = lookup_election(body.get("election"))
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
    election, kind = lookup_election(body.get("election"))
    if kind == "ranked":
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
            rcpt = send(w3, relayer, fn, gas_cap=MAX_GAS)
        except Exception as e:  # revert during estimate_gas, or RPC failure
            reason = revert_reason(e)
            print(f"  rejected {label}: {reason}")
            return {"ok": False, "error": reason}
    ok = rcpt.status == 1
    print(f"  {'sent' if ok else 'FAILED'} {label}: tx {rcpt.transactionHash.to_0x_hex()} gas {rcpt.gasUsed}")
    return {"ok": ok, "txHash": rcpt.transactionHash.to_0x_hex(), "gasUsed": rcpt.gasUsed}


HANDLERS = {"register": handle_register, "vote": handle_vote}


def process(event: dict) -> dict:
    """Blocking: validate one request event and forward it to the chain."""
    try:
        if len(event["content"]) > MAX_CONTENT:
            raise BadRequest("content too large")
        body = json.loads(event["content"])
        handler = HANDLERS.get(body.get("type")) if isinstance(body, dict) else None
        if not handler:
            raise BadRequest('content must be JSON with type "register" or "vote"')
        return handler(body)
    except (BadRequest, json.JSONDecodeError) as e:
        print(f"  bad request {event['id'][:12]}: {e}")
        return {"ok": False, "error": str(e)}


async def serve(config: dict):
    """Subscribe to the election's topic on every relay and forward what arrives."""
    global cfg
    cfg = config
    elections.clear()
    topic = nostr.topic(cfg["chainId"])
    print(f"listening on topic {topic} (Semaphore {cfg['semaphore']})")

    key = nostr.new_key()  # throwaway identity for replies
    seen = set()
    queue = asyncio.Queue()
    pool = nostr.Pool(cfg["nostrRelays"])
    # Catch up on what we missed while offline, but never on events older than the chain:
    # after a local chain restart a new election can reuse an old address, and old
    # registration signatures for it would still verify.
    genesis = w3.eth.get_block(0).timestamp
    flt = {"kinds": [nostr.KIND_REQUEST], "#t": [topic], "since": max(genesis, int(time.time()) - 24 * 3600)}
    tasks = [asyncio.create_task(pool.subscribe(url, flt, queue)) for url in cfg["nostrRelays"]]
    try:
        while True:
            event = await queue.get()
            if event["id"] in seen or not nostr.verify(event):
                continue
            seen.add(event["id"])
            try:
                result = await asyncio.to_thread(process, event)
            except Exception as e:  # never let one bad message stop the relayer
                print(f"  error on {event['id'][:12]}: {e!r}")
                result = {"ok": False, "error": "internal relayer error"}
            reply = nostr.make_event(key, nostr.KIND_REPLY, [["t", topic], ["e", event["id"]]], json.dumps(result))
            await pool.publish(reply)
    finally:
        for t in tasks:
            t.cancel()


async def main():
    bal = w3.eth.get_balance(relayer.address)
    print(f"goblett relayer (Nostr): chain {w3.eth.chain_id} via {RPC_URL}")
    print(f"  relayer wallet {relayer.address}, balance {Web3.from_wei(bal, 'ether')} (native)")
    while True:  # restart the subscription whenever election.json changes (redeploy)
        try:
            config = load_config()
            if w3.eth.chain_id != config["chainId"]:
                raise ValueError(f"RPC chain {w3.eth.chain_id} != election.json chain {config['chainId']}")
            mtime = CONFIG_PATH.stat().st_mtime
        except (OSError, ValueError, KeyError) as e:  # e.g. file half-written during a redeploy
            print(f"  config not usable yet ({e}); retrying")
            await asyncio.sleep(2)
            continue
        task = asyncio.create_task(serve(config))
        while not task.done():
            await asyncio.sleep(2)
            try:
                if CONFIG_PATH.stat().st_mtime != mtime:
                    break
            except OSError:
                break
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        except Exception as e:  # keep running whatever happens
            print(f"  subscription crashed ({e!r}); restarting")
            await asyncio.sleep(2)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
