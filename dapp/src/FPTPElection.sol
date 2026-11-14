// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";
import {Election} from "./Election.sol";

/// @title FPTPElection
/// @notice First-past-the-post: each voter picks one candidate; most votes wins.
///         The proof's `message` is the candidate index.
contract FPTPElection is Election {
    event VoteCast(uint256 indexed nullifier, uint256 indexed candidate);

    uint256 public constant MAX_CANDIDATES = 64;

    constructor(
        ISemaphore semaphore_,
        string memory title_,
        string[] memory candidates_,
        address[] memory whitelist_,
        uint256 registrationEnd_,
        uint256 votingStart_,
        uint256 votingEnd_,
        uint256 minAnonymitySet_
    )
        Election(
            semaphore_, title_, candidates_, whitelist_, registrationEnd_, votingStart_, votingEnd_, minAnonymitySet_
        )
    {}

    /// @param proof Semaphore proof whose `message` is the candidate index
    ///        and whose `scope` is this election's scope.
    function vote(ISemaphore.SemaphoreProof calldata proof) external {
        if (proof.message >= _candidates.length) revert InvalidCandidate();
        _useProof(proof);
        _tally[proof.message]++;
        emit VoteCast(proof.nullifier, proof.message);
    }

    function _maxCandidates() internal pure override returns (uint256) {
        return MAX_CANDIDATES;
    }

    /// @dev Every candidate with the maximum count.
    function _winners() internal view override returns (uint256[] memory result) {
        uint256 best;
        uint256 count;
        for (uint256 i = 0; i < _tally.length; i++) {
            if (_tally[i] > best) {
                best = _tally[i];
                count = 1;
            } else if (_tally[i] == best) {
                count++;
            }
        }

        result = new uint256[](count);
        uint256 j;
        for (uint256 i = 0; i < _tally.length; i++) {
            if (_tally[i] == best) result[j++] = i;
        }
    }
}
