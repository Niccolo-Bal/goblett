// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";
import {ISemaphoreGroups} from "@semaphore-protocol/contracts/interfaces/ISemaphoreGroups.sol";

/// @title Election
/// @notice Base for one anonymous election with a public whitelist. Concrete
///         elections (FPTPElection, RankedChoiceElection) add a `vote` function and
///         the counting rule; everything security-relevant lives here.
///
/// Lifecycle (all times are fixed at deployment; there is no admin afterwards):
///   [deploy, registrationEnd)   whitelisted wallets register a Semaphore identity commitment,
///                               directly or via a relayer with an EIP-712 signature (registerFor)
///   [registrationEnd, votingStart)  gap: the member set (and Merkle root) is frozen
///   [votingStart, votingEnd)    anyone submits a proof + ballot; msg.sender is ignored
///   [votingEnd, ...)            results are final
///
/// The ballot is encoded in the proof's `message`, so it is bound to the proof and a
/// relayer cannot change it. Each subclass defines that encoding.
abstract contract Election {
    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------
    error InvalidSchedule();
    error TooFewCandidates();
    error TooManyCandidates();
    error ZeroAddress();
    error InvalidMinAnonymitySet();
    error DuplicateWhitelistEntry();

    error RegistrationClosed();
    error NotWhitelisted();
    error AlreadyRegistered();
    error InvalidSignature();

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

    // ---------------------------------------------------------------------
    // Configuration (immutable after deployment)
    // ---------------------------------------------------------------------

    /// @notice EIP-712 type a wallet signs to let anyone register its commitment.
    ///         No nonce: the domain binds the signature to this election, and each
    ///         wallet can register only once.
    bytes32 public constant REGISTER_TYPEHASH = keccak256("Register(address wallet,uint256 identityCommitment)");
    bytes32 private constant _DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant _NAME_HASH = keccak256("goblet Election");
    bytes32 private constant _VERSION_HASH = keccak256("1");
    /// @dev secp256k1n / 2. Signatures with a larger s are the malleable twin of another one.
    uint256 private constant _HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;
    /// @dev ERC-1271 isValidSignature(bytes32,bytes) selector, returned on success.
    bytes4 private constant _ERC1271_MAGIC = 0x1626ba7e;

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
    string[] internal _candidates;

    // ---------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------
    mapping(address => bool) public isWhitelisted;
    mapping(address => bool) public hasRegistered;
    uint256 public registeredCount;

    /// @dev Our own nullifier set. We deliberately do NOT use Semaphore's
    ///      validateProof()/nullifier storage (see _useProof()).
    mapping(uint256 => bool) public nullifierUsed;
    /// @dev Votes per candidate (first preferences, for ranked ballots), kept live.
    uint256[] internal _tally;
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
        if (candidates_.length > _maxCandidates()) revert TooManyCandidates();
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
            // Duplicates would let minAnonymitySet exceed the number of distinct
            // voters, making voting permanently impossible.
            if (isWhitelisted[whitelist_[i]]) revert DuplicateWhitelistEntry();
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
    // Hooks for concrete elections
    // ---------------------------------------------------------------------

    /// @dev Upper bound on candidates, checked in the constructor.
    function _maxCandidates() internal pure virtual returns (uint256);

    /// @dev Result once voting has ended; more than one entry means a tie.
    function _winners() internal view virtual returns (uint256[] memory);

    // ---------------------------------------------------------------------
    // Registration (public, linked to the wallet; carries no vote)
    // ---------------------------------------------------------------------

    /// @param identityCommitment The voter's Semaphore identity commitment,
    ///        generated client-side. The secret behind it never leaves the browser.
    function register(uint256 identityCommitment) external {
        _register(msg.sender, identityCommitment);
    }

    /// @notice Register on behalf of `wallet`, which signed
    ///         Register(wallet, identityCommitment) off-chain (EIP-712). Anyone can
    ///         submit it (e.g. a relayer paying gas); they can't change the commitment.
    /// @param signature 65-byte ECDSA (r, s, v) from an EOA, or anything a
    ///        contract wallet accepts via ERC-1271.
    function registerFor(address wallet, uint256 identityCommitment, bytes calldata signature) external {
        if (!_isValidSignature(wallet, registerDigest(wallet, identityCommitment), signature)) {
            revert InvalidSignature();
        }
        _register(wallet, identityCommitment);
    }

    function _register(address wallet, uint256 identityCommitment) internal {
        if (block.timestamp >= registrationEnd) revert RegistrationClosed();
        if (!isWhitelisted[wallet]) revert NotWhitelisted();
        if (hasRegistered[wallet]) revert AlreadyRegistered();

        hasRegistered[wallet] = true;
        registeredCount++;

        // Reverts on a zero/out-of-field commitment or one already in the tree.
        semaphore.addMember(groupId, identityCommitment);

        emit Registered(wallet, identityCommitment);
    }

    /// @notice EIP-712 domain separator. Computed live so it follows block.chainid.
    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, address(this)));
    }

    /// @notice The digest `wallet` signs to authorize registerFor.
    function registerDigest(address wallet, uint256 identityCommitment) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(REGISTER_TYPEHASH, wallet, identityCommitment));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// @dev ECDSA for EOAs (low-s only, so each signature has one valid encoding),
    ///      falling back to ERC-1271 for contract wallets (and EIP-7702 accounts).
    function _isValidSignature(address signer, bytes32 digest, bytes calldata signature)
        internal
        view
        returns (bool)
    {
        if (signature.length == 65) {
            bytes32 r = bytes32(signature[0:32]);
            bytes32 s = bytes32(signature[32:64]);
            uint8 v = uint8(signature[64]);
            if (uint256(s) <= _HALF_N && (v == 27 || v == 28)) {
                address recovered = ecrecover(digest, v, r, s);
                // ecrecover returns 0 on failure; signer is never 0 (whitelist forbids it).
                if (recovered != address(0) && recovered == signer) return true;
            }
        }
        if (signer.code.length == 0) return false;
        (bool ok, bytes memory ret) =
            signer.staticcall(abi.encodeWithSelector(_ERC1271_MAGIC, digest, signature));
        return ok && ret.length >= 32 && abi.decode(ret, (bytes32)) == bytes32(_ERC1271_MAGIC);
    }

    // ---------------------------------------------------------------------
    // Voting (anonymous; anyone may submit, msg.sender is never read)
    // ---------------------------------------------------------------------

    /// @dev Every check a vote needs except the ballot itself, then burns the
    ///      nullifier. A subclass's vote() MUST (1) check that proof.message is the
    ///      canonical encoding of a valid ballot, (2) call this, (3) record the ballot.
    function _useProof(ISemaphore.SemaphoreProof calldata proof) internal {
        if (block.timestamp < votingStart || block.timestamp >= votingEnd) revert VotingNotOpen();
        if (registeredCount < minAnonymitySet) revert AnonymitySetTooSmall();

        // Without this, one identity could generate proofs for many scopes
        // (= many distinct nullifiers) and vote many times.
        if (proof.scope != scope) revert WrongScope();

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
        totalVotes++;
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function candidates() external view returns (string[] memory) {
        return _candidates;
    }

    /// @notice Live votes per candidate (first preferences for ranked ballots);
    ///         cannot be hidden by construction.
    function tally() external view returns (uint256[] memory) {
        return _tally;
    }

    /// @notice Final result: every winning candidate index (more than one = tie).
    function winners() external view returns (uint256[] memory) {
        if (block.timestamp < votingEnd) revert ElectionNotOver();
        return _winners();
    }

    function phase() external view returns (string memory) {
        if (block.timestamp < registrationEnd) return "registration";
        if (block.timestamp < votingStart) return "frozen";
        if (block.timestamp < votingEnd) return "voting";
        return "ended";
    }
}
