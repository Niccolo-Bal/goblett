// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";
import {Election} from "./Election.sol";

/// @title RankedChoiceElection
/// @notice Instant-runoff voting. A ballot is a ranking: 1..n distinct candidate
///         indices, most preferred first. The proof's `message` must equal
///         packRanking(ranking): byte i holds ranking[i] + 1 (first choice in the
///         lowest byte), 0 ends the ballot. Hence at most 32 candidates.
contract RankedChoiceElection is Election {
    error InvalidRanking();
    error BallotMismatch();

    event VoteCast(uint256 indexed nullifier, uint256[] ranking);

    /// @notice A full ranking must fit in one uint256 message, one byte per rank.
    uint256 public constant MAX_CANDIDATES = 32;

    /// @dev Identical ballots are merged, so the runoff costs O(distinct ballots),
    ///      not O(voters). _ballots[i] (packed) was cast _ballotCounts[i] times.
    uint256[] private _ballots;
    uint256[] private _ballotCounts;
    /// @dev packed ballot => index in _ballots + 1 (0 = not seen yet).
    mapping(uint256 => uint256) private _ballotSlot;

    constructor(
        ISemaphore semaphore_,
        string memory title_,
        string[] memory candidates_,
        address[] memory whitelist_,
        uint256 registrationEnd_,
        uint256 votingStart_,
        uint256 votingEnd_,
        uint256 minAnonymitySet_,
        uint256 relayBounty_,
        uint256 maxRefundGasPrice_
    )
        payable
        Election(
            semaphore_,
            title_,
            candidates_,
            whitelist_,
            registrationEnd_,
            votingStart_,
            votingEnd_,
            minAnonymitySet_,
            relayBounty_,
            maxRefundGasPrice_
        )
    {}

    /// @param proof Semaphore proof whose `message` is packRanking(ranking)
    ///        and whose `scope` is this election's scope.
    /// @param ranking Candidate indices, most preferred first.
    function vote(ISemaphore.SemaphoreProof calldata proof, uint256[] calldata ranking) external {
        uint256 gasStart = gasleft();
        // The ranking is only trusted because it equals the proven message.
        uint256 packed = packRanking(ranking);
        if (proof.message != packed) revert BallotMismatch();

        _useProof(proof);

        _tally[ranking[0]]++;
        uint256 slot = _ballotSlot[packed];
        if (slot == 0) {
            _ballots.push(packed);
            _ballotCounts.push(1);
            _ballotSlot[packed] = _ballots.length;
        } else {
            _ballotCounts[slot - 1]++;
        }

        emit VoteCast(proof.nullifier, ranking);
        _creditRelayer(gasStart);
    }

    /// @notice Canonical uint256 encoding of a ranking, used as the proof's message.
    ///         Reverts unless the ranking has 1..n distinct, valid candidate indices.
    function packRanking(uint256[] calldata ranking) public view returns (uint256 packed) {
        uint256 n = _candidates.length;
        if (ranking.length == 0 || ranking.length > n) revert InvalidRanking();

        uint256 seen; // bitmask of candidates already ranked
        for (uint256 i = 0; i < ranking.length; i++) {
            uint256 c = ranking[i];
            if (c >= n) revert InvalidCandidate();
            if (seen & (1 << c) != 0) revert InvalidRanking();
            seen |= 1 << c;
            packed |= (c + 1) << (8 * i);
        }
    }

    /// @notice Every distinct packed ballot and how many times it was cast, so
    ///         anyone can recount the runoff off-chain.
    function ballots() external view returns (uint256[] memory packed, uint256[] memory counts) {
        return (_ballots, _ballotCounts);
    }

    function _maxCandidates() internal pure override returns (uint256) {
        return MAX_CANDIDATES;
    }

    /// @dev Instant runoff. Each round, every ballot counts for its highest-ranked
    ///      continuing candidate (ballots with none left are exhausted and ignored).
    ///      A strict majority of non-exhausted ballots wins. Otherwise all candidates
    ///      tied for fewest votes are eliminated together, unless that would eliminate
    ///      everyone left, in which case they are the tied winners. No random or
    ///      index-based tie-breaking. With no votes, every candidate ties.
    ///      Gas ~ rounds * distinct ballots * ranking length; eth_call gas caps bound it.
    function _winners() internal view override returns (uint256[] memory result) {
        uint256 n = _candidates.length;
        uint256[] memory packed = _ballots;
        uint256[] memory weight = _ballotCounts;
        uint256 eliminated; // bitmask
        uint256 remaining = n;

        while (true) {
            uint256[] memory votes = new uint256[](n);
            uint256 active;
            for (uint256 b = 0; b < packed.length; b++) {
                for (uint256 rest = packed[b]; rest != 0; rest >>= 8) {
                    uint256 c = (rest & 0xff) - 1;
                    if (eliminated & (1 << c) == 0) {
                        votes[c] += weight[b];
                        active += weight[b];
                        break;
                    }
                }
            }

            uint256 lowest = type(uint256).max;
            for (uint256 c = 0; c < n; c++) {
                if (eliminated & (1 << c) != 0) continue;
                if (votes[c] * 2 > active) {
                    result = new uint256[](1);
                    result[0] = c;
                    return result;
                }
                if (votes[c] < lowest) lowest = votes[c];
            }

            uint256 lowMask;
            uint256 lowCount;
            for (uint256 c = 0; c < n; c++) {
                if (eliminated & (1 << c) == 0 && votes[c] == lowest) {
                    lowMask |= 1 << c;
                    lowCount++;
                }
            }

            if (lowCount == remaining) {
                result = new uint256[](lowCount);
                uint256 j;
                for (uint256 c = 0; c < n; c++) {
                    if (lowMask & (1 << c) != 0) result[j++] = c;
                }
                return result;
            }

            eliminated |= lowMask;
            remaining -= lowCount;
        }
    }
}
