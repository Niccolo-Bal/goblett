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
///
/// Relayers are paid from funds the creator (or anyone) sends to this contract: each
/// relayed registration (registerFor) and each counted vote credits msg.sender with a
/// gas refund plus a fixed bounty, which they collect with withdraw(). See "Relayer
/// payment" below.
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

    error InvalidRelayTerms();
    error NothingToWithdraw();
    error TransferFailed();
    error Reentrancy();

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------
    event Registered(address indexed wallet, uint256 identityCommitment);
    event Funded(address indexed from, uint256 amount);
    event RelayerCredited(address indexed relayer, uint256 amount);
    event Withdrawn(address indexed relayer, uint256 amount);
    event Reclaimed(address indexed creator, uint256 amount);

    // ---------------------------------------------------------------------
    // Configuration (immutable after deployment)
    // ---------------------------------------------------------------------

    /// @notice EIP-712 type a wallet signs to let anyone register its commitment.
    ///         No nonce: the domain binds the signature to this election, and each
    ///         wallet can register only once.
    bytes32 public constant REGISTER_TYPEHASH = keccak256("Register(address wallet,uint256 identityCommitment)");
    /// @notice EIP-712 type for a registration signed while the wallet is on ANOTHER
    ///         network (Ethereum, an L2, ...). Wallets refuse typed data whose domain
    ///         chainId is not their active network, so that domain names the network the
    ///         wallet is on, and the election's own chain and address move into the
    ///         message. Same guarantees as Register: valid for this election only.
    bytes32 public constant REGISTER_ON_TYPEHASH =
        keccak256("RegisterOn(address wallet,uint256 identityCommitment,uint256 electionChainId,address election)");
    /// @dev Domain of RegisterOn: no verifyingContract, because the election does not
    ///      live on the chain the wallet is signing on.
    bytes32 private constant _SIGNING_DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId)");
    bytes32 private constant _DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant _NAME_HASH = keccak256("goblett Election");
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

    /// @notice Paid to the relayer on top of the gas refund, per relayed registration
    ///         and per counted vote (in wei of the native token). 0 = no bounty.
    uint256 public immutable relayBounty;
    /// @notice Gas refunds use min(tx.gasprice, this). Without a cap, a relayer could
    ///         bid an absurd gas price and have the election pay for it. 0 = no refund.
    uint256 public immutable maxRefundGasPrice;
    /// @notice Gets back whatever relayer funding is left once voting has ended.
    ///         Has no other power: the election itself still has no admin.
    address public immutable creator;

    /// @dev Added to the measured gas: what the transaction costs outside our
    ///      measurement (21000 base, calldata, the credit's own storage write).
    uint256 public constant REFUND_GAS_OVERHEAD = 40_000;
    /// @dev Upper bound on refunded gas per call. registerFor runs code of a contract
    ///      wallet (ERC-1271), which could burn gas on purpose to inflate a refund.
    uint256 public constant MAX_REFUND_GAS = 1_000_000;
    /// @dev Tighter cap for registerFor: an honest registration is ~210k gas, so a
    ///      contract wallet can't burn up to MAX_REFUND_GAS in isValidSignature and
    ///      drain relayFunds() ~4x faster than honest use (R3-7). Wallets that need more
    ///      still register; the relayer is just refunded at most this much.
    uint256 public constant MAX_REGISTER_REFUND_GAS = 300_000;

    string public title;
    string[] internal _candidates;

    // ---------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------
    mapping(address => bool) public isWhitelisted;
    mapping(address => bool) public hasRegistered;
    uint256 public registeredCount;
    /// @dev Every registered commitment, in tree order. The same data as the Registered
    ///      events, but readable in one call: a voter needs the full list to build a
    ///      proof, and some RPCs (Arc) only serve logs for small block ranges.
    uint256[] internal _commitments;

    /// @dev Our own nullifier set. We deliberately do NOT use Semaphore's
    ///      validateProof()/nullifier storage (see _useProof()).
    mapping(uint256 => bool) public nullifierUsed;
    /// @dev Votes per candidate (first preferences, for ranked ballots), kept live.
    uint256[] internal _tally;
    uint256 public totalVotes;

    /// @notice What each relayer can withdraw().
    mapping(address => uint256) public owed;
    /// @dev Sum of `owed`. Invariant: address(this).balance >= totalOwed.
    uint256 public totalOwed;
    bool private _locked;

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
    ) payable {
        if (address(semaphore_) == address(0)) revert ZeroAddress();
        if (candidates_.length < 2) revert TooFewCandidates();
        if (candidates_.length > _maxCandidates()) revert TooManyCandidates();
        if (!(block.timestamp < registrationEnd_ && registrationEnd_ <= votingStart_ && votingStart_ < votingEnd_)) {
            revert InvalidSchedule();
        }
        if (minAnonymitySet_ == 0 || minAnonymitySet_ > whitelist_.length) revert InvalidMinAnonymitySet();
        // Bounded so the credit arithmetic can never overflow (which would block voting).
        if (relayBounty_ > type(uint128).max || maxRefundGasPrice_ > type(uint128).max) revert InvalidRelayTerms();

        semaphore = semaphore_;
        title = title_;
        registrationEnd = registrationEnd_;
        votingStart = votingStart_;
        votingEnd = votingEnd_;
        minAnonymitySet = minAnonymitySet_;
        relayBounty = relayBounty_;
        maxRefundGasPrice = maxRefundGasPrice_;
        creator = msg.sender;
        if (msg.value > 0) emit Funded(msg.sender, msg.value);

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
        uint256 gasStart = gasleft();
        if (!_isValidSignature(wallet, registerDigest(wallet, identityCommitment), signature)) {
            revert InvalidSignature();
        }
        _register(wallet, identityCommitment);
        _creditRelayer(gasStart, MAX_REGISTER_REFUND_GAS);
    }

    /// @notice Like registerFor, for a wallet that signed while on another network.
    ///         An address is the same on every EVM chain, so a whitelisted wallet does
    ///         not need Arc added to it (or any funds anywhere) to register: it signs
    ///         RegisterOn on whatever network it is on, and anyone relays it here.
    /// @param signingChainId The chain id the wallet was on when it signed (the
    ///        chainId of the signature's EIP-712 domain). It only selects which digest
    ///        to check; a wrong value just makes the signature invalid.
    function registerForSignedOn(
        address wallet,
        uint256 identityCommitment,
        uint256 signingChainId,
        bytes calldata signature
    ) external {
        uint256 gasStart = gasleft();
        if (!_isValidSignature(wallet, registerDigestOn(wallet, identityCommitment, signingChainId), signature)) {
            revert InvalidSignature();
        }
        _register(wallet, identityCommitment);
        _creditRelayer(gasStart, MAX_REGISTER_REFUND_GAS);
    }

    function _register(address wallet, uint256 identityCommitment) internal {
        if (block.timestamp >= registrationEnd) revert RegistrationClosed();
        if (!isWhitelisted[wallet]) revert NotWhitelisted();
        if (hasRegistered[wallet]) revert AlreadyRegistered();

        hasRegistered[wallet] = true;
        registeredCount++;
        _commitments.push(identityCommitment);

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

    /// @notice The digest `wallet` signs, on the network `signingChainId`, to authorize
    ///         registerForSignedOn. It commits to this election's chain and address, so
    ///         it is worthless for any other election, including a contract at the same
    ///         address on a different chain.
    function registerDigestOn(address wallet, uint256 identityCommitment, uint256 signingChainId)
        public
        view
        returns (bytes32)
    {
        bytes32 domain = keccak256(abi.encode(_SIGNING_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, signingChainId));
        bytes32 structHash =
            keccak256(abi.encode(REGISTER_ON_TYPEHASH, wallet, identityCommitment, block.chainid, address(this)));
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
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
    ///      canonical encoding of a valid ballot, (2) call this, (3) record the ballot,
    ///      (4) call _creditRelayer(gasStart), where gasStart = gasleft() on entry.
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
    // Relayer payment
    // ---------------------------------------------------------------------
    //
    // msg.sender is read here and nowhere else in the voting path: it decides who is
    // paid, never whether a vote counts. Credits are bookkeeping only (pull payment):
    // no value moves inside vote()/registerFor(), so a relayer that can't receive
    // funds (e.g. blocklisted on Arc) can't make a vote fail.
    //
    // What a credit can cost the election is bounded: one per whitelisted wallet
    // (registerFor, at most MAX_REGISTER_REFUND_GAS * maxRefundGasPrice + relayBounty)
    // plus one per registered voter (vote, at most MAX_REFUND_GAS * maxRefundGasPrice + relayBounty). A voter may relay for themself
    // and collect the credit; that is fine.

    /// @notice Anyone can add relayer funding at any time.
    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }

    /// @notice Funding not yet promised to a relayer.
    function relayFunds() public view returns (uint256) {
        return address(this).balance - totalOwed;
    }

    /// @dev Credit msg.sender for the call in progress. If the election has run out of
    ///      funding the credit is smaller or zero, and the call still succeeds: voting
    ///      must never depend on the funding.
    function _creditRelayer(uint256 gasStart) internal {
        _creditRelayer(gasStart, MAX_REFUND_GAS);
    }

    function _creditRelayer(uint256 gasStart, uint256 maxGas) internal {
        uint256 gasUsed = gasStart - gasleft() + REFUND_GAS_OVERHEAD;
        if (gasUsed > maxGas) gasUsed = maxGas;
        uint256 price = tx.gasprice < maxRefundGasPrice ? tx.gasprice : maxRefundGasPrice;

        uint256 amount = gasUsed * price + relayBounty;
        uint256 available = relayFunds();
        if (amount > available) amount = available;
        if (amount == 0) return;

        owed[msg.sender] += amount;
        totalOwed += amount;
        emit RelayerCredited(msg.sender, amount);
    }

    /// @notice Collect everything this contract owes the caller.
    function withdraw() external {
        if (_locked) revert Reentrancy();
        _locked = true;

        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        // Effects before the transfer (checks-effects-interactions).
        owed[msg.sender] = 0;
        totalOwed -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);

        _locked = false;
    }

    /// @notice After voting ends, send the unused funding back to the creator. Anyone
    ///         can call it; what relayers are owed stays in the contract.
    function reclaim() external {
        if (block.timestamp < votingEnd) revert ElectionNotOver();
        if (_locked) revert Reentrancy();
        _locked = true;

        uint256 amount = relayFunds();
        if (amount == 0) revert NothingToWithdraw();
        (bool ok,) = creator.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Reclaimed(creator, amount);

        _locked = false;
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function candidates() external view returns (string[] memory) {
        return _candidates;
    }

    /// @notice All registered identity commitments, in the order they were added to
    ///         the Merkle tree (what a voter needs to rebuild the group off-chain).
    function commitments() external view returns (uint256[] memory) {
        return _commitments;
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
