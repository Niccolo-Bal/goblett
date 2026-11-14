// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";
import {Election} from "../src/Election.sol";
import {FPTPElection} from "../src/FPTPElection.sol";
import {ElectionTestBase} from "./ElectionBase.t.sol";

/// Shared Election tests (inherited) plus first-past-the-post specifics.
contract FPTPElectionTest is ElectionTestBase {
    function _deploy(
        ISemaphore s,
        string[] memory c,
        address[] memory w,
        uint256 r,
        uint256 vs,
        uint256 ve,
        uint256 minAnon
    ) internal override returns (Election) {
        return new FPTPElection(s, "Test election", c, w, r, vs, ve, minAnon);
    }

    function _maxCandidates() internal pure override returns (uint256) {
        return 64;
    }

    function _message(uint256 candidate) internal pure override returns (uint256) {
        return candidate;
    }

    function _submit(ISemaphore.SemaphoreProof memory p, uint256) internal override {
        FPTPElection(address(election)).vote(p);
    }

    function _cast(uint256 candidate, uint256 times) internal {
        for (uint256 i = 0; i < times; i++) {
            _submit(_proof(candidate, ++_nextNullifier), candidate);
        }
    }

    // =====================================================================
    // Ballot
    // =====================================================================

    function test_vote_revertsOnInvalidCandidate() public {
        _openVoting();
        ISemaphore.SemaphoreProof memory p = _proof(3, 1); // 3 candidates: 0..2
        vm.expectRevert(Election.InvalidCandidate.selector);
        _submit(p, 3);
    }

    function test_vote_happyPath() public {
        _openVoting();

        ISemaphore.SemaphoreProof memory p = _proof(1, 77);
        vm.expectEmit(true, true, false, true, address(election));
        emit FPTPElection.VoteCast(77, 1);
        _submit(p, 1);

        uint256[] memory t = election.tally();
        assertEq(t[0], 0);
        assertEq(t[1], 1);
        assertEq(t[2], 0);
        assertEq(election.totalVotes(), 1);
        assertTrue(election.nullifierUsed(77));
    }

    function testFuzz_candidateIndex(uint256 m) public {
        _openVoting();
        ISemaphore.SemaphoreProof memory p = _proof(m, 1);
        if (m >= 3) {
            vm.expectRevert(Election.InvalidCandidate.selector);
            _submit(p, m);
        } else {
            _submit(p, m);
            assertEq(election.tally()[m], 1);
        }
    }

    // =====================================================================
    // Results
    // =====================================================================

    function test_winners_mostVotesWins() public {
        _openVoting();
        _cast(2, 2);
        _cast(0, 1);
        uint256[] memory w = _winners();
        assertEq(w.length, 1);
        assertEq(w[0], 2);
    }

    /// Plurality, no runoff: A wins with 4 of 9 even though B+C voters are 5.
    function test_winners_pluralityNotMajority() public {
        _openVoting();
        _cast(0, 4);
        _cast(1, 3);
        _cast(2, 2);
        uint256[] memory w = _winners();
        assertEq(w.length, 1);
        assertEq(w[0], 0);
    }

    function test_winners_tie() public {
        _openVoting();
        _cast(0, 1);
        _cast(1, 1);
        uint256[] memory w = _winners();
        assertEq(w.length, 2);
        assertEq(w[0], 0);
        assertEq(w[1], 1);
    }
}
