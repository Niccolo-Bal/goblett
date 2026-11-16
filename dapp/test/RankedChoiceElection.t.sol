// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";
import {Election} from "../src/Election.sol";
import {RankedChoiceElection} from "../src/RankedChoiceElection.sol";
import {ElectionTestBase} from "./ElectionBase.t.sol";

/// Shared Election tests (inherited, with single-entry rankings) plus
/// ranked-choice specifics: ballot validation/binding and the instant runoff.
contract RankedChoiceElectionTest is ElectionTestBase {
    function _deploy(
        ISemaphore s,
        string[] memory c,
        address[] memory w,
        uint256 r,
        uint256 vs,
        uint256 ve,
        uint256 minAnon
    ) internal override returns (Election) {
        return new RankedChoiceElection(s, "Test election", c, w, r, vs, ve, minAnon);
    }

    function _maxCandidates() internal pure override returns (uint256) {
        return 32;
    }

    function _message(uint256 candidate) internal pure override returns (uint256) {
        return _pack(_r(candidate));
    }

    function _submit(ISemaphore.SemaphoreProof memory p, uint256 candidate) internal override {
        rcv().vote(p, _r(candidate));
    }

    function rcv() internal view returns (RankedChoiceElection) {
        return RankedChoiceElection(address(election));
    }

    /// Packing computed independently of the contract.
    function _pack(uint256[] memory ranking) internal pure returns (uint256 packed) {
        for (uint256 i = 0; i < ranking.length; i++) {
            packed |= (ranking[i] + 1) << (8 * i);
        }
    }

    function _proofFor(uint256[] memory ranking, uint256 nullifier)
        internal
        view
        returns (ISemaphore.SemaphoreProof memory)
    {
        return _proofWithMessage(_pack(ranking), nullifier);
    }

    function _r(uint256 a) internal pure returns (uint256[] memory r) {
        r = new uint256[](1);
        r[0] = a;
    }

    function _r(uint256 a, uint256 b) internal pure returns (uint256[] memory r) {
        r = new uint256[](2);
        (r[0], r[1]) = (a, b);
    }

    function _r(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory r) {
        r = new uint256[](3);
        (r[0], r[1], r[2]) = (a, b, c);
    }

    /// Cast `times` identical ballots (fresh nullifiers).
    function _cast(uint256[] memory ranking, uint256 times) internal {
        for (uint256 i = 0; i < times; i++) {
            rcv().vote(_proofFor(ranking, ++_nextNullifier), ranking);
        }
    }

    function _assertSingleWinner(uint256 expected) internal {
        uint256[] memory w = _winners();
        assertEq(w.length, 1);
        assertEq(w[0], expected);
    }

    // =====================================================================
    // Ballot validation and binding
    // =====================================================================

    function test_vote_revertsOnInvalidCandidate() public {
        _openVoting();
        ISemaphore.SemaphoreProof memory p = _proofFor(_r(0, 3), 1); // 3 candidates: 0..2
        vm.expectRevert(Election.InvalidCandidate.selector);
        rcv().vote(p, _r(0, 3));
    }

    function test_vote_revertsOnEmptyRanking() public {
        _openVoting();
        uint256[] memory empty = new uint256[](0);
        ISemaphore.SemaphoreProof memory p = _proofFor(empty, 1);
        vm.expectRevert(RankedChoiceElection.InvalidRanking.selector);
        rcv().vote(p, empty);
    }

    function test_vote_revertsOnRankingLongerThanCandidates() public {
        _openVoting();
        uint256[] memory r = new uint256[](4);
        (r[0], r[1], r[2], r[3]) = (0, 1, 2, 0);
        ISemaphore.SemaphoreProof memory p = _proofFor(r, 1);
        vm.expectRevert(RankedChoiceElection.InvalidRanking.selector);
        rcv().vote(p, r);
    }

    function test_vote_revertsOnDuplicateCandidate() public {
        _openVoting();
        ISemaphore.SemaphoreProof memory p = _proofFor(_r(1, 0, 1), 1);
        vm.expectRevert(RankedChoiceElection.InvalidRanking.selector);
        rcv().vote(p, _r(1, 0, 1));
    }

    /// A relayer reorders the ranking: it no longer matches the proven message.
    function test_vote_revertsIfRelayerReordersRanking() public {
        _openVoting();
        ISemaphore.SemaphoreProof memory p = _proofFor(_r(0, 1), 1);
        RankedChoiceElection e = rcv();
        vm.prank(dave);
        vm.expectRevert(RankedChoiceElection.BallotMismatch.selector);
        e.vote(p, _r(1, 0));
    }

    /// A relayer drops lower preferences.
    function test_vote_revertsIfRelayerTruncatesRanking() public {
        _openVoting();
        ISemaphore.SemaphoreProof memory p = _proofFor(_r(0, 1, 2), 1);
        vm.expectRevert(RankedChoiceElection.BallotMismatch.selector);
        rcv().vote(p, _r(0, 1));
    }

    function test_vote_happyPath() public {
        _openVoting();

        ISemaphore.SemaphoreProof memory p = _proofFor(_r(1, 2), 77);
        vm.expectEmit(true, false, false, true, address(election));
        emit RankedChoiceElection.VoteCast(77, _r(1, 2));
        rcv().vote(p, _r(1, 2));

        uint256[] memory t = election.tally();
        assertEq(t[0], 0);
        assertEq(t[1], 1); // first preferences only
        assertEq(t[2], 0);
        assertEq(election.totalVotes(), 1);
        assertTrue(election.nullifierUsed(77));

        (uint256[] memory packed, uint256[] memory counts) = rcv().ballots();
        assertEq(packed.length, 1);
        assertEq(packed[0], 2 | (3 << 8));
        assertEq(counts[0], 1);
    }

    function test_vote_identicalBallotsAreMerged() public {
        _openVoting();
        _cast(_r(2, 0), 3);
        _cast(_r(2), 1); // same first choice, different ballot

        (uint256[] memory packed, uint256[] memory counts) = rcv().ballots();
        assertEq(packed.length, 2);
        assertEq(counts[0], 3);
        assertEq(counts[1], 1);
        assertEq(election.tally()[2], 4);
    }

    function test_packRanking_encoding() public view {
        assertEq(rcv().packRanking(_r(2, 0, 1)), 3 | (1 << 8) | (2 << 16));
        assertEq(rcv().packRanking(_r(0)), 1);
    }

    /// 32 candidates, full ranking: uses all 32 bytes of the message.
    function test_vote_fullRankingOfMaxCandidates() public {
        election = _deploy(_candidates(32), _whitelist(), regEnd, votingStart, votingEnd, 2);
        _register(alice, 1);
        _register(bob, 2);
        vm.warp(votingStart);

        uint256[] memory r = new uint256[](32);
        for (uint256 i = 0; i < 32; i++) {
            r[i] = 31 - i;
        }
        ISemaphore.SemaphoreProof memory p = _proofFor(r, 1);
        assertEq(p.message >> 248, 1); // last byte: candidate 0 (+1)
        rcv().vote(p, r);
        _assertSingleWinner(31);
    }

    // =====================================================================
    // Instant runoff
    // =====================================================================

    function test_winners_majorityInFirstRound() public {
        _openVoting();
        _cast(_r(2, 0), 2);
        _cast(_r(0, 2), 1);
        _assertSingleWinner(2);
    }

    /// Classic runoff: A leads on first preferences (plurality would pick A),
    /// but C's voters prefer B, so B wins after C is eliminated.
    function test_winners_transferBeatsPluralityLeader() public {
        _openVoting();
        _cast(_r(0), 4); // A
        _cast(_r(1), 3); // B
        _cast(_r(2, 1), 2); // C, then B
        // Round 1: A4 B3 C2 of 9, no majority, C out. Round 2: A4 B5 -> B.
        _assertSingleWinner(1);
    }

    /// Majority is over non-exhausted ballots, not all ballots.
    function test_winners_exhaustedBallotsDontCount() public {
        _openVoting();
        _cast(_r(0), 3);
        _cast(_r(1), 2);
        _cast(_r(2), 1); // exhausted once C is out
        // Round 1: 3 of 6 isn't > half. C out. Round 2: A3 B2 of 5 -> A.
        _assertSingleWinner(0);
    }

    /// Ties for last are eliminated together; their ballots transfer at once.
    function test_winners_tiedLowestEliminatedTogether() public {
        _openVoting();
        _cast(_r(0), 2);
        _cast(_r(1, 0), 1);
        _cast(_r(2, 0), 1);
        // Round 1: A2 B1 C1 of 4. B and C out together. Round 2: A4 -> A.
        _assertSingleWinner(0);
    }

    function test_winners_finalTie() public {
        _openVoting();
        _cast(_r(0), 3);
        _cast(_r(1), 3);
        _cast(_r(2), 1); // exhausted after round 1
        // Round 2: A3 B3 of 6, both lowest, eliminating both would leave no one -> tie.
        uint256[] memory w = _winners();
        assertEq(w.length, 2);
        assertEq(w[0], 0);
        assertEq(w[1], 1);
    }

    function test_winners_threeWayTie() public {
        _openVoting();
        _cast(_r(0, 1), 1);
        _cast(_r(1, 2), 1);
        _cast(_r(2, 0), 1);
        assertEq(_winners().length, 3);
    }

    /// Random valid ballots: the runoff always terminates with valid winners,
    /// and a candidate with a first-round majority always wins.
    function testFuzz_winnersAlwaysValid(uint256 seed, uint8 k) public {
        _openVoting();
        k = uint8(bound(k, 0, 40));
        for (uint256 i = 0; i < k; i++) {
            uint256 h = uint256(keccak256(abi.encode(seed, i)));
            uint256 a = h % 3;
            uint256 b = (a + 1 + (h >> 8) % 2) % 3; // != a
            uint256 c = 3 - a - b;
            uint256 len = 1 + (h >> 16) % 3;
            _cast(len == 1 ? _r(a) : len == 2 ? _r(a, b) : _r(a, b, c), 1);
        }

        uint256[] memory t = election.tally();
        uint256[] memory w = _winners();
        assertGt(w.length, 0);
        for (uint256 i = 0; i < w.length; i++) {
            assertLt(w[i], 3);
            if (i > 0) assertGt(w[i], w[i - 1]);
        }
        for (uint256 c = 0; c < 3; c++) {
            if (t[c] * 2 > k) {
                assertEq(w.length, 1);
                assertEq(w[0], c);
            }
        }
    }
}
