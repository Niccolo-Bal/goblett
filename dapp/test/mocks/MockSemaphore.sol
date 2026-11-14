// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";

/// @notice Test double for the four Semaphore functions Election uses.
///         Proof validity is whatever the test sets, so this cannot test that
///         message/scope are actually bound inside a proof (needs real proofs).
contract MockSemaphore {
    error NotGroupAdmin();
    error ZeroCommitment();
    error DuplicateCommitment();

    uint256 public groupCounter;
    mapping(uint256 => address) public admins;
    mapping(uint256 => uint256) public roots;
    mapping(uint256 => uint256) public sizes;
    mapping(uint256 => mapping(uint256 => bool)) public isMember;

    bool public proofValid = true;

    function setProofValid(bool valid) external {
        proofValid = valid;
    }

    function createGroup(address admin) external returns (uint256 groupId) {
        groupId = groupCounter++;
        admins[groupId] = admin;
    }

    function addMember(uint256 groupId, uint256 identityCommitment) external {
        if (msg.sender != admins[groupId]) revert NotGroupAdmin();
        if (identityCommitment == 0) revert ZeroCommitment();
        if (isMember[groupId][identityCommitment]) revert DuplicateCommitment();

        isMember[groupId][identityCommitment] = true;
        sizes[groupId]++;
        // Fake root: changes on every insert, like a real Merkle root.
        roots[groupId] = uint256(keccak256(abi.encode(roots[groupId], identityCommitment)));
    }

    function getMerkleTreeRoot(uint256 groupId) external view returns (uint256) {
        return roots[groupId];
    }

    function verifyProof(uint256, ISemaphore.SemaphoreProof calldata) external view returns (bool) {
        return proofValid;
    }
}
