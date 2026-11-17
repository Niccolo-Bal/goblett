"""Local anvil only: jump chain time to the next phase of the configured election.

    python advance.py voting     # to votingStart
    python advance.py ended      # to votingEnd
    python advance.py 300        # forward N seconds
"""

import sys

from common import artifact, connect, load_config


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    cfg = load_config()
    w3 = connect()
    el = w3.eth.contract(address=cfg["election"], abi=artifact("Election")["abi"])
    now = w3.eth.get_block("latest").timestamp
    target = {
        "frozen": lambda: el.functions.registrationEnd().call(),
        "voting": lambda: el.functions.votingStart().call(),
        "ended": lambda: el.functions.votingEnd().call(),
    }.get(sys.argv[1], lambda: now + int(sys.argv[1]))()
    if target > now:
        w3.provider.make_request("evm_setNextBlockTimestamp", [target])
    w3.provider.make_request("evm_mine", [])
    print(f"phase is now: {el.functions.phase().call()}")


if __name__ == "__main__":
    main()
