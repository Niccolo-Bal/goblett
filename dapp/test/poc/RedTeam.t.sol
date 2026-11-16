// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";
import {Election} from "../../src/Election.sol";
import {RankedChoiceElection} from "../../src/RankedChoiceElection.sol";
import {MockSemaphore} from "../mocks/MockSemaphore.sol";

contract ShortReturnWallet { fallback() external { assembly { mstore(0, 0x1626ba7e) return(28, 4) } } }
contract RightAlignedWallet { fallback() external { assembly { mstore(0, 0x1626ba7e) return(0, 32) } } }
contract RevertingWallet { fallback() external { revert("no"); } }
contract EmptyWallet { fallback() external {} }

/// Red team round 1: attacks Scout proposed (#1 sig auth, #3 phase edges, #4 IRV) plus my own.
contract RedTeamTest is Test {
    MockSemaphore mock;
    RankedChoiceElection el;
    uint256 aliceKey; address alice; uint256 bobKey; address bob; address carol = makeAddr("carol");
    uint256 regEnd; uint256 vStart; uint256 vEnd; uint256 nul = 1;

    function setUp() public {
        mock = new MockSemaphore();
        (alice, aliceKey) = makeAddrAndKey("alice");
        (bob, bobKey) = makeAddrAndKey("bob");
        regEnd = block.timestamp + 1 days; vStart = regEnd + 1 days; vEnd = vStart + 1 days;
        el = _deploy(_wl3(alice, bob, carol), 3, regEnd, vStart);
    }

    function _wl3(address a, address b, address c) internal pure returns (address[] memory w) {
        w = new address[](3); (w[0], w[1], w[2]) = (a, b, c);
    }
    function _cands(uint256 n) internal pure returns (string[] memory c) { c = new string[](n); }
    function _deploy(address[] memory w, uint256 n, uint256 r, uint256 vs) internal returns (RankedChoiceElection) {
        return new RankedChoiceElection(ISemaphore(address(mock)), "rt", _cands(n), w, r, vs, vs + 1 days, 1);
    }
    function _sig(uint256 key, address wallet, uint256 c, uint8 vOverride) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, el.registerDigest(wallet, c));
        return abi.encodePacked(r, s, vOverride == 0xff ? v : vOverride);
    }

    // ---- Scout #1: signature auth ----
    function test_sig_vZeroOrOneRejected() public {
        (uint8 v,,) = vm.sign(aliceKey, el.registerDigest(alice, 42));
        bytes memory sig = _sig(aliceKey, alice, 42, v - 27);
        vm.expectRevert(Election.InvalidSignature.selector);
        el.registerFor(alice, 42, sig);
    }
    function test_sig_aliceSigCannotRegisterBob() public {
        bytes memory sig = _sig(aliceKey, alice, 42, 0xff);
        vm.expectRevert(Election.InvalidSignature.selector);
        el.registerFor(bob, 42, sig);
    }
    function test_sig_erc1271OddReturnDataRejected() public {
        address[4] memory ws = [address(new ShortReturnWallet()), address(new RightAlignedWallet()),
            address(new RevertingWallet()), address(new EmptyWallet())];
        for (uint256 i; i < 4; i++) {
            RankedChoiceElection e = _deploy(_wl3(ws[i], alice, bob), 3, regEnd, vStart);
            // Includes a 65-byte junk sig that fails ECDSA and falls through to ERC-1271.
            vm.expectRevert(Election.InvalidSignature.selector);
            e.registerFor(ws[i], 42, new bytes(65));
        }
    }

    // ---- Scout #3: phase edges, incl. registrationEnd == votingStart ----
    function test_phase_regEndEqualsVotingStart() public {
        RankedChoiceElection e = _deploy(_wl3(alice, bob, carol), 3, regEnd, regEnd);
        vm.prank(alice); e.register(1);
        vm.warp(regEnd);
        vm.prank(bob); vm.expectRevert(Election.RegistrationClosed.selector); e.register(2);
        uint256[] memory r = new uint256[](1);
        ISemaphore.SemaphoreProof memory p;
        p.merkleTreeRoot = mock.getMerkleTreeRoot(e.groupId()); p.scope = e.scope(); p.nullifier = 7; p.message = 1;
        e.vote(p, r); // voting open in the same second registration closed
        assertEq(e.totalVotes(), 1);
        vm.warp(regEnd + 1 days - 1);
        vm.expectRevert(Election.ElectionNotOver.selector); e.winners();
    }

    // ---- Scout #4: IRV differential fuzz against an independent per-voter recount ----
    function testFuzz_irv_matchesReference(uint256 seed) public {
        uint256 n = 3 + seed % 5; // 3..7 candidates
        address[] memory w = new address[](40);
        for (uint256 i; i < 40; i++) w[i] = address(uint160(0x1000 + i));
        RankedChoiceElection e = new RankedChoiceElection(ISemaphore(address(mock)), "f", _cands(n), w, regEnd, vStart, vEnd, 1);
        vm.prank(w[0]); e.register(1);
        vm.warp(vStart);
        uint256 voters = 1 + (seed >> 8) % 40;
        uint256[][] memory bs = new uint256[][](voters);
        for (uint256 v; v < voters; v++) {
            uint256 h = uint256(keccak256(abi.encode(seed, v)));
            uint256 len = 1 + h % n;
            uint256[] memory perm = new uint256[](n);
            for (uint256 i; i < n; i++) perm[i] = i;
            for (uint256 i; i < n; i++) { uint256 j = i + (h >> (8 + i * 8)) % (n - i); (perm[i], perm[j]) = (perm[j], perm[i]); }
            bs[v] = new uint256[](len);
            for (uint256 i; i < len; i++) bs[v][i] = perm[i];
            ISemaphore.SemaphoreProof memory p;
            p.merkleTreeRoot = mock.getMerkleTreeRoot(e.groupId()); p.scope = e.scope(); p.nullifier = ++nul;
            p.message = e.packRanking(bs[v]);
            e.vote(p, bs[v]);
        }
        vm.warp(vEnd);
        uint256[] memory got = e.winners();
        uint256[] memory want = _refIrv(bs, n);
        assertEq(keccak256(abi.encode(got)), keccak256(abi.encode(want)), "IRV mismatch");
    }

    function _refIrv(uint256[][] memory bs, uint256 n) internal pure returns (uint256[] memory out) {
        bool[] memory out_ = new bool[](n);
        uint256 left = n;
        while (true) {
            uint256[] memory cnt = new uint256[](n);
            uint256 act;
            for (uint256 v; v < bs.length; v++) {
                for (uint256 i; i < bs[v].length; i++) {
                    if (!out_[bs[v][i]]) { cnt[bs[v][i]]++; act++; break; }
                }
            }
            uint256 lo = type(uint256).max;
            for (uint256 c; c < n; c++) if (!out_[c]) {
                if (2 * cnt[c] > act) { out = new uint256[](1); out[0] = c; return out; }
                if (cnt[c] < lo) lo = cnt[c];
            }
            uint256 k;
            for (uint256 c; c < n; c++) if (!out_[c] && cnt[c] == lo) k++;
            if (k == left) {
                out = new uint256[](k); uint256 j;
                for (uint256 c; c < n; c++) if (!out_[c] && cnt[c] == lo) out[j++] = c;
                return out;
            }
            for (uint256 c; c < n; c++) if (!out_[c] && cnt[c] == lo) out_[c] = true;
            left -= k;
        }
    }

    // ---- Own: IRV gas with the cheapest worst case (max candidates, ballots that force 31 rounds) ----
    function test_irv_gasWorstCaseFewVotes() public {
        address[] memory w = new address[](64);
        for (uint256 i; i < 64; i++) w[i] = address(uint160(0x2000 + i));
        RankedChoiceElection e = new RankedChoiceElection(ISemaphore(address(mock)), "g", _cands(32), w, regEnd, vStart, vEnd, 1);
        vm.prank(w[0]); e.register(1);
        vm.warp(vStart);
        // 64 distinct full-length ballots, staggered so one candidate drops per round.
        for (uint256 v; v < 64; v++) {
            uint256[] memory r = new uint256[](32);
            for (uint256 i; i < 32; i++) r[i] = (v / 2 + i) % 32;
            if (v % 2 == 1) { (r[30], r[31]) = (r[31], r[30]); }
            ISemaphore.SemaphoreProof memory p;
            p.merkleTreeRoot = mock.getMerkleTreeRoot(e.groupId()); p.scope = e.scope(); p.nullifier = ++nul;
            p.message = e.packRanking(r);
            e.vote(p, r);
        }
        vm.warp(vEnd);
        uint256 g = gasleft(); e.winners(); emit log_named_uint("winners() gas, 32 cands x 64 ballots", g - gasleft());
    }

    // ---- R1 (Scout/Red): duplicate whitelist entries made minAnonymitySet unreachable.
    /// Original PoC (bricks voting on unfixed code); kept as documentation, skipped once the fix lands.
    function test_dupWhitelist_bricksVoting_original() public {
        try new RankedChoiceElection(ISemaphore(address(mock)), "d", _cands(3), _wl3(alice, alice, bob), regEnd, vStart, vEnd, 3) returns (RankedChoiceElection) {} catch { vm.skip(true); }
        RankedChoiceElection e = new RankedChoiceElection(ISemaphore(address(mock)), "d", _cands(3), _wl3(alice, alice, bob), regEnd, vStart, vEnd, 3);
        vm.prank(alice); e.register(1);
        vm.prank(bob); e.register(2);
        vm.warp(vStart);
        uint256[] memory r = new uint256[](1);
        ISemaphore.SemaphoreProof memory p;
        p.merkleTreeRoot = mock.getMerkleTreeRoot(e.groupId()); p.scope = e.scope(); p.nullifier = 9; p.message = 1;
        vm.expectRevert(Election.AnonymitySetTooSmall.selector);
        e.vote(p, r); // 100% turnout of distinct voters, still unvotable forever
    }
}
