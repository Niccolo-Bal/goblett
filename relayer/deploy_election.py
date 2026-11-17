"""Deploy a test election (and Semaphore, if needed) and write relayer/election.json.

Example (local anvil, times in minutes from now):
    python deploy_election.py --title "Lunch" --candidates Pizza Sushi Tacos \
        --whitelist 0xYourMetaMaskAddr 0xAnotherAddr --reg 10 --gap 0 --vote 30 --min-anon 1

Semaphore: reused from election.json if it still has code on this chain, or taken from
--semaphore, otherwise deployed fresh (PoseidonT3 + SemaphoreVerifier + Semaphore).
"""

import argparse
import json

from eth_account import Account
from web3 import Web3

from common import CONFIG_PATH, DEPLOYER_KEY, KINDS, RPC_URL, artifact, connect


def deploy(w3, acct, art, *args, bytecode=None):
    c = w3.eth.contract(abi=art["abi"], bytecode=bytecode or art["bytecode"]["object"])
    fn = c.constructor(*args)
    tx = fn.build_transaction(
        {"from": acct.address, "nonce": w3.eth.get_transaction_count(acct.address, "pending")}
    )
    rcpt = w3.eth.wait_for_transaction_receipt(
        w3.eth.send_raw_transaction(acct.sign_transaction(tx).raw_transaction), timeout=120
    )
    if rcpt.status != 1:
        raise SystemExit(f"deploy failed: {rcpt.transactionHash.hex()}")
    return rcpt


def link(art, libs: dict) -> str:
    """Replace Foundry library placeholders with deployed library addresses."""
    code = art["bytecode"]["object"].removeprefix("0x")
    for _file, names in art["bytecode"]["linkReferences"].items():
        for name, refs in names.items():
            addr = libs[name].lower().removeprefix("0x")
            for r in refs:
                s = r["start"] * 2
                code = code[:s] + addr + code[s + 40 :]
    return "0x" + code


def deploy_semaphore(w3, acct) -> str:
    poseidon = deploy(w3, acct, artifact("PoseidonT3")).contractAddress
    verifier = deploy(w3, acct, artifact("SemaphoreVerifier")).contractAddress
    sem_art = artifact("Semaphore")
    sem = deploy(w3, acct, sem_art, verifier, bytecode=link(sem_art, {"PoseidonT3": poseidon}))
    print(f"Semaphore deployed at {sem.contractAddress} (verifier {verifier}, PoseidonT3 {poseidon})")
    return sem.contractAddress


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--kind", choices=KINDS, default="fptp")
    p.add_argument("--title", default="goblet test election")
    p.add_argument("--candidates", nargs="+", default=["Alice", "Bob", "Carol"])
    p.add_argument("--whitelist", nargs="+", required=True, help="voter wallet addresses")
    p.add_argument("--reg", type=float, default=10, help="registration window, minutes")
    p.add_argument("--gap", type=float, default=0, help="freeze between registration and voting, minutes")
    p.add_argument("--vote", type=float, default=30, help="voting window, minutes")
    p.add_argument("--min-anon", type=int, default=None, help="min registrations before voting (default: min(2, whitelist))")
    p.add_argument("--semaphore", help="existing Semaphore address")
    p.add_argument("--rpc", default=RPC_URL)
    p.add_argument("--public-rpc", help="RPC URL the browser should use (default: --rpc)")
    a = p.parse_args()

    w3 = connect(a.rpc)
    acct = Account.from_key(DEPLOYER_KEY)
    chain_id = w3.eth.chain_id

    sem = a.semaphore
    if not sem and CONFIG_PATH.exists():
        old = json.loads(CONFIG_PATH.read_text())
        if old.get("chainId") == chain_id and w3.eth.get_code(old["semaphore"]):
            sem = old["semaphore"]
            print(f"reusing Semaphore at {sem}")
    if not sem:
        sem = deploy_semaphore(w3, acct)
    sem = Web3.to_checksum_address(sem)

    whitelist = [Web3.to_checksum_address(x) for x in a.whitelist]
    min_anon = a.min_anon or min(2, len(whitelist))
    now = w3.eth.get_block("latest").timestamp
    reg_end = now + int(a.reg * 60)
    vote_start = reg_end + int(a.gap * 60)
    vote_end = vote_start + int(a.vote * 60)

    name = KINDS[a.kind]
    rcpt = deploy(
        w3, acct, artifact(name), sem, a.title, a.candidates, whitelist, reg_end, vote_start, vote_end, min_anon
    )
    cfg = {
        "chainId": chain_id,
        "rpcUrl": a.public_rpc or a.rpc,
        "semaphore": sem,
        "election": rcpt.contractAddress,
        "kind": a.kind,
        "deployBlock": rcpt.blockNumber,
    }
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2))
    print(f"{name} '{a.title}' at {rcpt.contractAddress} (block {rcpt.blockNumber})")
    print(f"  candidates {a.candidates}, whitelist {len(whitelist)}, minAnonymitySet {min_anon}")
    print(f"  registration until +{a.reg}m, voting +{a.reg + a.gap}m .. +{a.reg + a.gap + a.vote}m (chain time)")
    print(f"wrote {CONFIG_PATH}")


if __name__ == "__main__":
    main()
