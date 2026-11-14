// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";
import {Election} from "../src/Election.sol";
import {MockSemaphore} from "./mocks/MockSemaphore.sol";

contract ElectionTest is Test {
    MockSemaphore internal mock;
    Election internal election;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave"); // not whitelisted; plays relayer

    uint256 internal regEnd;
    uint256 internal votingStart;
    uint256 internal votingEnd;

    // =====================================================================
    // Setup and helpers
    // =====================================================================

    function setUp() public {
        mock = new MockSemaphore();
        regEnd = block.timestamp + 1 days;
        votingStart = block.timestamp + 2 days;
        votingEnd = block.timestamp + 3 days;
        election = _deploy(_candidates(3), _whitelist(), regEnd, votingStart, votingEnd, 2);
    }

    function _candidates(uint256 n) internal pure returns (string[] memory c) {
        c = new string[](n);
        for (uint256 i = 0; i < n; i++) {
            c[i] = "candidate";
        }
    }

    function _whitelist() internal view returns (address[] memory w) {
        w = new address[](3);
        w[0] = alice;
        w[1] = bob;
        w[2] = carol;
    }

    function _deploy(
        string[] memory c,
        address[] memory w,
        uint256 r,
        uint256 vs,
        uint256 ve,
        uint256 minAnon
    ) internal returns (Election) {
        return new Election(ISemaphore(address(mock)), "Test election", c, w, r, vs, ve, minAnon);
    }

    function _register(address who, uint256 commitment) internal {
        vm.prank(who);
        election.register(commitment);
    }

    function _registerAll() internal {
        _register(alice, 1);
        _register(bob, 2);
        _register(carol, 3);
    }

    function _openVoting() internal {
        _registerAll();
        vm.warp(votingStart);
    }

    /// A proof that passes every Election check (the mock accepts it).
    function _proof(uint256 message, uint256 nullifier) internal view returns (ISemaphore.SemaphoreProof memory p) {
        p.merkleTreeDepth = 2;
        p.merkleTreeRoot = mock.getMerkleTreeRoot(election.groupId());
        p.nullifier = nullifier;
        p.message = message;
        p.scope = election.scope();
    }

    // =====================================================================
    // Constructor
    // =====================================================================

    function test_constructor_revertsOnZeroSemaphore() public {
        vm.expectRevert(Election.ZeroAddress.selector);
        new Election(ISemaphore(address(0)), "x", _candidates(3), _whitelist(), regEnd, votingStart, votingEnd, 2);
    }

    function test_constructor_revertsOnTooFewCandidates() public {
        vm.expectRevert(Election.TooFewCandidates.selector);
        _deploy(_candidates(1), _whitelist(), regEnd, votingStart, votingEnd, 2);
    }

    function test_constructor_revertsOnTooManyCandidates() public {
        vm.expectRevert(Election.TooManyCandidates.selector);
        _deploy(_candidates(65), _whitelist(), regEnd, votingStart, votingEnd, 2);
    }

    function test_constructor_revertsOnRegistrationEndNotInFuture() public {
        vm.expectRevert(Election.InvalidSchedule.selector);
        _deploy(_candidates(3), _whitelist(), block.timestamp, votingStart, votingEnd, 2);
    }

    function test_constructor_revertsOnVotingStartBeforeRegistrationEnd() public {
        vm.expectRevert(Election.InvalidSchedule.selector);
        _deploy(_candidates(3), _whitelist(), votingStart, regEnd, votingEnd, 2);
    }

    function test_constructor_revertsOnEmptyVotingWindow() public {
        vm.expectRevert(Election.InvalidSchedule.selector);
        _deploy(_candidates(3), _whitelist(), regEnd, votingStart, votingStart, 2);
    }

    function test_constructor_revertsOnZeroMinAnonymitySet() public {
        vm.expectRevert(Election.InvalidMinAnonymitySet.selector);
        _deploy(_candidates(3), _whitelist(), regEnd, votingStart, votingEnd, 0);
    }

    function test_constructor_revertsOnMinAnonymitySetAboveWhitelist() public {
        vm.expectRevert(Election.InvalidMinAnonymitySet.selector);
        _deploy(_candidates(3), _whitelist(), regEnd, votingStart, votingEnd, 4);
    }

    function test_constructor_revertsOnZeroAddressInWhitelist() public {
        address[] memory w = _whitelist();
        w[1] = address(0);
        vm.expectRevert(Election.ZeroAddress.selector);
        _deploy(_candidates(3), w, regEnd, votingStart, votingEnd, 2);
    }

    function test_constructor_scopeIsUniquePerElection() public {
        Election other = _deploy(_candidates(3), _whitelist(), regEnd, votingStart, votingEnd, 2);
        assertTrue(other.scope() != election.scope());
        assertTrue(other.groupId() != election.groupId());
    }

    function test_constructor_electionIsGroupAdmin() public view {
        assertEq(mock.admins(election.groupId()), address(election));
    }

    // =====================================================================
    // Registration
    // =====================================================================

    function test_register_happyPath() public {
        vm.expectEmit(true, false, false, true, address(election));
        emit Election.Registered(alice, 42);
        _register(alice, 42);

        assertTrue(election.hasRegistered(alice));
        assertEq(election.registeredCount(), 1);
        assertTrue(mock.isMember(election.groupId(), 42));
    }

    function test_register_revertsIfNotWhitelisted() public {
        vm.expectRevert(Election.NotWhitelisted.selector);
        _register(dave, 1);
    }

    function test_register_revertsOnSecondRegistration() public {
        _register(alice, 1);
        vm.expectRevert(Election.AlreadyRegistered.selector);
        _register(alice, 2);
    }

    function test_register_succeedsJustBeforeRegistrationEnd() public {
        vm.warp(regEnd - 1);
        _register(alice, 1);
        assertEq(election.registeredCount(), 1);
    }

    function test_register_revertsAtExactlyRegistrationEnd() public {
        vm.warp(regEnd);
        vm.expectRevert(Election.RegistrationClosed.selector);
        _register(alice, 1);
    }

    function test_register_revertsOnDuplicateCommitment() public {
        _register(alice, 7);
        vm.expectRevert(MockSemaphore.DuplicateCommitment.selector);
        _register(bob, 7);
        // The revert rolled back bob's registration, so he can retry.
        assertFalse(election.hasRegistered(bob));
    }

    function test_register_revertsOnZeroCommitment() public {
        vm.expectRevert(MockSemaphore.ZeroCommitment.selector);
        _register(alice, 0);
    }

    // =====================================================================
    // Voting: reverts (one per check)
    // =====================================================================

    function test_vote_revertsDuringRegistration() public {
        _registerAll();
        ISemaphore.SemaphoreProof memory p = _proof(0, 1);
        vm.expectRevert(Election.VotingNotOpen.selector);
        election.vote(p);
    }

    function test_vote_revertsDuringFrozenGap() public {
        _registerAll();
        vm.warp(regEnd);
        ISemaphore.SemaphoreProof memory p = _proof(0, 1);
        vm.expectRevert(Election.VotingNotOpen.selector);
        election.vote(p);
    }

    function test_vote_succeedsJustBeforeVotingEnd() public {
        _registerAll();
        vm.warp(votingEnd - 1);
        election.vote(_proof(0, 1));
        assertEq(election.totalVotes(), 1);
    }

    function test_vote_revertsAtExactlyVotingEnd() public {
        _registerAll();
        vm.warp(votingEnd);
        ISemaphore.SemaphoreProof memory p = _proof(0, 1);
        vm.expectRevert(Election.VotingNotOpen.selector);
        election.vote(p);
    }

    function test_vote_revertsIfAnonymitySetTooSmall() public {
        _register(alice, 1); // min is 2
        vm.warp(votingStart);
        ISemaphore.SemaphoreProof memory p = _proof(0, 1);
        vm.expectRevert(Election.AnonymitySetTooSmall.selector);
        election.vote(p);
    }

    function test_vote_revertsOnWrongScope() public {
        _openVoting();
        ISemaphore.SemaphoreProof memory p = _proof(0, 1);
        p.scope = election.scope() + 1;
        vm.expectRevert(Election.WrongScope.selector);
        election.vote(p);
    }

    function test_vote_revertsOnFirstInvalidCandidate() public {
        _openVoting();
        ISemaphore.SemaphoreProof memory p = _proof(3, 1); // 3 candidates: 0..2
        vm.expectRevert(Election.InvalidCandidate.selector);
        election.vote(p);
    }

    function test_vote_revertsOnStaleRoot() public {
        _register(alice, 1);
        uint256 earlyRoot = mock.getMerkleTreeRoot(election.groupId());
        _register(bob, 2);
        _register(carol, 3);
        vm.warp(votingStart);

        ISemaphore.SemaphoreProof memory p = _proof(0, 1);
        p.merkleTreeRoot = earlyRoot;
        vm.expectRevert(Election.RootNotCurrent.selector);
        election.vote(p);
    }

    function test_vote_revertsOnReusedNullifier() public {
        _openVoting();
        election.vote(_proof(0, 99));

        // Same nullifier, different candidate and different sender.
        ISemaphore.SemaphoreProof memory p = _proof(1, 99);
        vm.prank(dave);
        vm.expectRevert(Election.NullifierAlreadyUsed.selector);
        election.vote(p);
    }

    function test_vote_revertsOnInvalidProof() public {
        _openVoting();
        mock.setProofValid(false);
        ISemaphore.SemaphoreProof memory p = _proof(0, 1);
        vm.expectRevert(Election.InvalidProof.selector);
        election.vote(p);
    }

    // =====================================================================
    // Voting: happy paths
    // =====================================================================

    function test_vote_happyPath() public {
        _openVoting();

        ISemaphore.SemaphoreProof memory p = _proof(1, 77);
        vm.expectEmit(true, true, false, true, address(election));
        emit Election.VoteCast(77, 1);
        election.vote(p);

        uint256[] memory t = election.tally();
        assertEq(t[0], 0);
        assertEq(t[1], 1);
        assertEq(t[2], 0);
        assertEq(election.totalVotes(), 1);
        assertTrue(election.nullifierUsed(77));
    }

    /// The submitter is irrelevant: a non-whitelisted relayer can submit.
    function test_vote_anyoneCanRelay() public {
        _openVoting();
        // Build the proof first: _proof() makes calls, and vm.prank applies
        // only to the very next call.
        ISemaphore.SemaphoreProof memory p = _proof(2, 5);
        vm.prank(dave);
        election.vote(p);
        assertEq(election.tally()[2], 1);
    }

    // =====================================================================
    // Results and phases
    // =====================================================================

    function test_winners_revertsBeforeVotingEnd() public {
        _openVoting();
        vm.expectRevert(Election.ElectionNotOver.selector);
        election.winners();
    }

    function test_winners_singleWinner() public {
        _openVoting();
        election.vote(_proof(2, 1));
        election.vote(_proof(2, 2));
        election.vote(_proof(0, 3));
        vm.warp(votingEnd);

        uint256[] memory w = election.winners();
        assertEq(w.length, 1);
        assertEq(w[0], 2);
    }

    function test_winners_tie() public {
        _openVoting();
        election.vote(_proof(0, 1));
        election.vote(_proof(1, 2));
        vm.warp(votingEnd);

        uint256[] memory w = election.winners();
        assertEq(w.length, 2);
        assertEq(w[0], 0);
        assertEq(w[1], 1);
    }

    function test_winners_noVotesMeansAllTied() public {
        vm.warp(votingEnd);
        assertEq(election.winners().length, 3);
    }

    function test_phase_transitions() public {
        assertEq(election.phase(), "registration");
        vm.warp(regEnd);
        assertEq(election.phase(), "frozen");
        vm.warp(votingStart);
        assertEq(election.phase(), "voting");
        vm.warp(votingEnd);
        assertEq(election.phase(), "ended");
    }

    // =====================================================================
    // Fuzz
    // =====================================================================

    function testFuzz_candidateIndex(uint256 m) public {
        _openVoting();
        ISemaphore.SemaphoreProof memory p = _proof(m, 1);
        if (m >= 3) {
            vm.expectRevert(Election.InvalidCandidate.selector);
            election.vote(p);
        } else {
            election.vote(p);
            assertEq(election.tally()[m], 1);
        }
    }

    function testFuzz_tallySumsToTotalVotes(uint8 k) public {
        _openVoting();
        for (uint256 i = 0; i < k; i++) {
            election.vote(_proof(i % 3, i + 1));
        }

        uint256[] memory t = election.tally();
        assertEq(t[0] + t[1] + t[2], k);
        assertEq(election.totalVotes(), k);
    }
}
