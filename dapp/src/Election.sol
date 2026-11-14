// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";
import {ISemaphoreGroups} from "@semaphore-protocol/contracts/interfaces/ISemaphoreGroups.sol";

/// @title Election
/// @notice One anonymous first-past-the-post election with a public whitelist.
///
/// Lifecycle (all times are fixed at deployment; there is no admin afterwards):
///   [deploy, registrationEnd)   whitelisted wallets register a Semaphore identity commitment
///   [registrationEnd, votingStart)  gap: the member set (and Merkle root) is frozen
///   [votingStart, votingEnd)    anyone submits (vote, nullifier, proof); msg.sender is ignored
///   [votingEnd, ...)            results are final
///
/// The vote is the proof's `message` (a candidate index), so it is bound to the proof
/// and a relayer cannot change it.
contract Election {
    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------
    error InvalidSchedule();
    error TooFewCandidates();
    error TooManyCandidates();
    error ZeroAddress();
    error InvalidMinAnonymitySet();

    error RegistrationClosed();
    error NotWhitelisted();
    error AlreadyRegistered();

    error VotingNotOpen();
    error AnonymitySetTooSmall();
    error WrongScope();
    error InvalidCandidate();
    error RootNotCurrent();
    error NullifierAlreadyUsed();
    error InvalidProof();

    error ElectionNotOver();

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------
    event Registered(address indexed wallet, uint256 identityCommitment);
    event VoteCast(uint256 indexed nullifier, uint256 indexed candidate);

    // ---------------------------------------------------------------------
    // Configuration (immutable after deployment)
    // ---------------------------------------------------------------------
    uint256 public constant MAX_CANDIDATES = 64;

    ISemaphore public immutable semaphore;
    uint256 public immutable groupId;
    /// @notice Semaphore scope for this election. The nullifier is derived from
    ///         (scope, identity secret), so it is unique per voter per election
    ///         and unlinkable across elections.
    uint256 public immutable scope;

    uint256 public immutable registrationEnd;
    uint256 public immutable votingStart;
    uint256 public immutable votingEnd;
    /// @notice Votes are refused unless at least this many wallets registered.
    uint256 public immutable minAnonymitySet;

    string public title;
    string[] private _candidates;

    // ---------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------
    mapping(address => bool) public isWhitelisted;
    mapping(address => bool) public hasRegistered;
    uint256 public registeredCount;

    /// @dev Our own nullifier set. We deliberately do NOT use Semaphore's
    ///      validateProof()/nullifier storage (see vote()).
    mapping(uint256 => bool) public nullifierUsed;
    uint256[] private _tally;
    uint256 public totalVotes;

    constructor(
        ISemaphore semaphore_,
        string memory title_,
        string[] memory candidates_,
        address[] memory whitelist_,
        uint256 registrationEnd_,
        uint256 votingStart_,
        uint256 votingEnd_,
        uint256 minAnonymitySet_
    ) {
        if (address(semaphore_) == address(0)) revert ZeroAddress();
        if (candidates_.length < 2) revert TooFewCandidates();
        if (candidates_.length > MAX_CANDIDATES) revert TooManyCandidates();
        if (!(block.timestamp < registrationEnd_ && registrationEnd_ <= votingStart_ && votingStart_ < votingEnd_)) {
            revert InvalidSchedule();
        }
        if (minAnonymitySet_ == 0 || minAnonymitySet_ > whitelist_.length) revert InvalidMinAnonymitySet();

        semaphore = semaphore_;
        title = title_;
        registrationEnd = registrationEnd_;
        votingStart = votingStart_;
        votingEnd = votingEnd_;
        minAnonymitySet = minAnonymitySet_;

        for (uint256 i = 0; i < candidates_.length; i++) {
            _candidates.push(candidates_[i]);
            _tally.push(0);
        }
        for (uint256 i = 0; i < whitelist_.length; i++) {
            if (whitelist_[i] == address(0)) revert ZeroAddress();
            isWhitelisted[whitelist_[i]] = true;
        }

        // Domain-separate the scope by chain and contract address, so a proof
        // for this election can never be valid for another one.
        scope = uint256(keccak256(abi.encode(block.chainid, address(this))));

        // This contract is the group admin, so only register() can add members,
        // and nothing can ever remove or update them.
        groupId = semaphore_.createGroup(address(this));
    }

    // ---------------------------------------------------------------------
    // Registration (public, linked to the wallet; carries no vote)
    // ---------------------------------------------------------------------

    /// @param identityCommitment The voter's Semaphore identity commitment,
    ///        generated client-side. The secret behind it never leaves the browser.
    function register(uint256 identityCommitment) external {
        if (block.timestamp >= registrationEnd) revert RegistrationClosed();
        if (!isWhitelisted[msg.sender]) revert NotWhitelisted();
        if (hasRegistered[msg.sender]) revert AlreadyRegistered();

        hasRegistered[msg.sender] = true;
        registeredCount++;

        // Reverts on a zero/out-of-field commitment or one already in the tree.
        semaphore.addMember(groupId, identityCommitment);

        emit Registered(msg.sender, identityCommitment);
    }

    // ---------------------------------------------------------------------
    // Voting (anonymous; anyone may submit, msg.sender is never read)
    // ---------------------------------------------------------------------

    /// @param proof Semaphore proof whose `message` is the candidate index
    ///        and whose `scope` is this election's scope.
    function vote(ISemaphore.SemaphoreProof calldata proof) external {
        if (block.timestamp < votingStart || block.timestamp >= votingEnd) revert VotingNotOpen();
        if (registeredCount < minAnonymitySet) revert AnonymitySetTooSmall();

        // Without this, one identity could generate proofs for many scopes
        // (= many distinct nullifiers) and vote many times.
        if (proof.scope != scope) revert WrongScope();
        if (proof.message >= _candidates.length) revert InvalidCandidate();

        // Semaphore accepts recently superseded roots too. A proof against an
        // older root reveals the voter registered early (a smaller anonymity
        // set), so only accept the final, frozen root.
        if (proof.merkleTreeRoot != ISemaphoreGroups(address(semaphore)).getMerkleTreeRoot(groupId)) {
            revert RootNotCurrent();
        }

        if (nullifierUsed[proof.nullifier]) revert NullifierAlreadyUsed();

        // verifyProof is a view: it checks the Groth16 proof (root, nullifier,
        // message, scope) but stores nothing. We avoid validateProof() because
        // anyone can call it directly on Semaphore with a copied proof, which
        // would burn the nullifier there without our tally counting the vote.
        if (!semaphore.verifyProof(groupId, proof)) revert InvalidProof();

        nullifierUsed[proof.nullifier] = true;
        _tally[proof.message]++;
        totalVotes++;

        emit VoteCast(proof.nullifier, proof.message);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function candidates() external view returns (string[] memory) {
        return _candidates;
    }

    /// @notice Live tally, cannot be hidden by construction.
    function tally() external view returns (uint256[] memory) {
        return _tally;
    }

    /// @notice FPTP result: every candidate index with the maximum count
    ///         (more than one entry means a tie).
    function winners() external view returns (uint256[] memory result) {
        if (block.timestamp < votingEnd) revert ElectionNotOver();

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

    function phase() external view returns (string memory) {
        if (block.timestamp < registrationEnd) return "registration";
        if (block.timestamp < votingStart) return "frozen";
        if (block.timestamp < votingEnd) return "voting";
        return "ended";
    }
}
