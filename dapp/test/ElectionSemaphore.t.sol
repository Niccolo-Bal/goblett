// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";
import {ISemaphoreVerifier} from "@semaphore-protocol/contracts/interfaces/ISemaphoreVerifier.sol";
import {Semaphore} from "@semaphore-protocol/contracts/Semaphore.sol";
import {SemaphoreVerifier} from "@semaphore-protocol/contracts/base/SemaphoreVerifier.sol";
import {Election} from "../src/Election.sol";
import {FPTPElection} from "../src/FPTPElection.sol";
import {RankedChoiceElection} from "../src/RankedChoiceElection.sol";

/// @notice Election against the real Semaphore contracts (Poseidon LeanIMT + Groth16
///         verifier), deployed the same way as script/DeploySemaphore.s.sol.
///         No real proofs here: those are generated in JS and tested end-to-end by
///         e2e/arc-e2e.mjs on a local node.
contract ElectionSemaphoreTest is Test {
    uint256 internal constant ARC_TESTNET_CHAIN_ID = 5042002;
    uint256 internal constant SNARK_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    Semaphore internal semaphore;
    RankedChoiceElection internal election;
    FPTPElection internal fptp;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    uint256 internal votingStart;

    function setUp() public {
        vm.chainId(ARC_TESTNET_CHAIN_ID);

        semaphore = new Semaphore(ISemaphoreVerifier(address(new SemaphoreVerifier())));

        string[] memory c = new string[](2);
        c[0] = "yes";
        c[1] = "no";
        address[] memory w = new address[](3);
        w[0] = alice;
        w[1] = bob;
        w[2] = carol;

        votingStart = block.timestamp + 2 days;
        election = new RankedChoiceElection(
            ISemaphore(address(semaphore)), "Real Semaphore", c, w, block.timestamp + 1 days, votingStart, votingStart + 1 days, 2
        );
        fptp = new FPTPElection(
            ISemaphore(address(semaphore)), "Real Semaphore FPTP", c, w, block.timestamp + 1 days, votingStart, votingStart + 1 days, 2
        );
    }

    /// Two elections on one Semaphore get separate groups, roots and scopes.
    function test_bothTypesShareSemaphoreWithSeparateGroups() public {
        vm.prank(alice);
        election.register(111);
        vm.prank(alice);
        fptp.register(222);

        assertTrue(election.groupId() != fptp.groupId());
        assertTrue(election.scope() != fptp.scope());
        assertTrue(semaphore.hasMember(election.groupId(), 111));
        assertFalse(semaphore.hasMember(fptp.groupId(), 111));
    }

    function test_fptp_forgedProofRejectedByRealVerifier() public {
        vm.prank(alice);
        fptp.register(111);
        vm.prank(bob);
        fptp.register(222);
        vm.warp(votingStart);

        ISemaphore.SemaphoreProof memory p;
        p.merkleTreeDepth = 1;
        p.merkleTreeRoot = semaphore.getMerkleTreeRoot(fptp.groupId());
        p.nullifier = 42;
        p.message = 0;
        p.scope = fptp.scope();
        for (uint256 i = 0; i < 8; i++) {
            p.points[i] = i + 1;
        }

        vm.expectRevert(Election.InvalidProof.selector);
        fptp.vote(p);
        assertEq(fptp.totalVotes(), 0);
    }

    function _register(address who, uint256 commitment) internal {
        vm.prank(who);
        election.register(commitment);
    }

    function test_electionIsGroupAdmin() public view {
        assertEq(semaphore.getGroupAdmin(election.groupId()), address(election));
    }

    function test_scopeUsesChainId() public view {
        assertEq(election.scope(), uint256(keccak256(abi.encode(ARC_TESTNET_CHAIN_ID, address(election)))));
    }

    function test_register_addsLeavesToRealTree() public {
        uint256 g = election.groupId();
        assertEq(semaphore.getMerkleTreeRoot(g), 0);

        _register(alice, 111);
        uint256 root1 = semaphore.getMerkleTreeRoot(g);
        _register(bob, 222);
        uint256 root2 = semaphore.getMerkleTreeRoot(g);

        assertTrue(semaphore.hasMember(g, 111));
        assertTrue(semaphore.hasMember(g, 222));
        assertEq(semaphore.getMerkleTreeSize(g), 2);
        assertEq(semaphore.getMerkleTreeDepth(g), 1);
        assertTrue(root1 != 0 && root2 != 0 && root1 != root2);
        // With one leaf, the LeanIMT root is the leaf itself.
        assertEq(root1, 111);
    }

    function test_register_duplicateCommitmentReverts() public {
        _register(alice, 111);
        vm.prank(bob);
        vm.expectRevert(); // LeanIMT__LeafAlreadyExists
        election.register(111);
        // The failed call rolled back, so bob can still register.
        _register(bob, 222);
    }

    function test_register_outOfFieldCommitmentReverts() public {
        vm.prank(alice);
        vm.expectRevert(); // LeanIMT__LeafGreaterThanSnarkScalarField
        election.register(SNARK_SCALAR_FIELD);
    }

    function test_register_zeroCommitmentReverts() public {
        vm.prank(alice);
        vm.expectRevert(); // LeanIMT__LeafCannotBeZero
        election.register(0);
    }

    function test_rootFrozenAfterRegistration() public {
        _register(alice, 111);
        _register(bob, 222);
        uint256 root = semaphore.getMerkleTreeRoot(election.groupId());
        vm.warp(votingStart);
        assertEq(semaphore.getMerkleTreeRoot(election.groupId()), root);
    }

    /// The real Groth16 verifier must reject a forged proof that passes all of
    /// Election's own checks (current root, our scope, valid candidate, fresh nullifier).
    function test_vote_forgedProofRejectedByRealVerifier() public {
        _register(alice, 111);
        _register(bob, 222);
        vm.warp(votingStart);

        ISemaphore.SemaphoreProof memory p;
        p.merkleTreeDepth = 1;
        p.merkleTreeRoot = semaphore.getMerkleTreeRoot(election.groupId());
        p.nullifier = 42;
        uint256[] memory ranking = new uint256[](1); // ranking [0]
        p.message = election.packRanking(ranking);
        p.scope = election.scope();
        for (uint256 i = 0; i < 8; i++) {
            p.points[i] = i + 1;
        }

        vm.expectRevert(Election.InvalidProof.selector);
        election.vote(p, ranking);
        assertEq(election.totalVotes(), 0);
        assertFalse(election.nullifierUsed(42));
    }
}
