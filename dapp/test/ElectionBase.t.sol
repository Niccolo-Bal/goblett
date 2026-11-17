// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";
import {Election} from "../src/Election.sol";
import {MockSemaphore} from "./mocks/MockSemaphore.sol";
import {MockERC1271Wallet} from "./mocks/MockERC1271Wallet.sol";

/// @notice Tests for everything the Election base provides (constructor checks,
///         registration, registerFor, every proof check). Each concrete election's
///         test contract inherits this, so all of it runs against every election type.
abstract contract ElectionTestBase is Test {
    MockSemaphore internal mock;
    Election internal election;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave"); // not whitelisted; plays relayer

    uint256 internal regEnd;
    uint256 internal votingStart;
    uint256 internal votingEnd;

    uint256 internal _nextNullifier = 1000;

    // Relayer payment terms used by every test election. Elections start unfunded, so
    // nothing is credited unless a test funds the contract.
    uint256 internal constant BOUNTY = 0.0005 ether;
    uint256 internal constant MAX_GAS_PRICE = 50 gwei;

    // =====================================================================
    // Hooks implemented per election type
    // =====================================================================

    function _deploy(
        ISemaphore s,
        string[] memory c,
        address[] memory w,
        uint256 r,
        uint256 vs,
        uint256 ve,
        uint256 minAnon
    ) internal virtual returns (Election);

    function _maxCandidates() internal pure virtual returns (uint256);

    /// The proof message for a ballot whose (first) choice is `candidate`.
    function _message(uint256 candidate) internal pure virtual returns (uint256);

    /// Submit a ballot for `candidate` with proof `p` (exactly one external call).
    function _submit(ISemaphore.SemaphoreProof memory p, uint256 candidate) internal virtual;

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
        return _deploy(ISemaphore(address(mock)), c, w, r, vs, ve, minAnon);
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
    function _proofWithMessage(uint256 message, uint256 nullifier)
        internal
        view
        returns (ISemaphore.SemaphoreProof memory p)
    {
        p.merkleTreeDepth = 2;
        p.merkleTreeRoot = mock.getMerkleTreeRoot(election.groupId());
        p.nullifier = nullifier;
        p.message = message;
        p.scope = election.scope();
    }

    function _proof(uint256 candidate, uint256 nullifier) internal view returns (ISemaphore.SemaphoreProof memory) {
        return _proofWithMessage(_message(candidate), nullifier);
    }

    function _winners() internal returns (uint256[] memory) {
        vm.warp(votingEnd);
        return election.winners();
    }

    // =====================================================================
    // Constructor
    // =====================================================================

    function test_constructor_revertsOnZeroSemaphore() public {
        vm.expectRevert(Election.ZeroAddress.selector);
        _deploy(ISemaphore(address(0)), _candidates(3), _whitelist(), regEnd, votingStart, votingEnd, 2);
    }

    function test_constructor_revertsOnTooFewCandidates() public {
        vm.expectRevert(Election.TooFewCandidates.selector);
        _deploy(_candidates(1), _whitelist(), regEnd, votingStart, votingEnd, 2);
    }

    function test_constructor_revertsOnTooManyCandidates() public {
        vm.expectRevert(Election.TooManyCandidates.selector);
        _deploy(_candidates(_maxCandidates() + 1), _whitelist(), regEnd, votingStart, votingEnd, 2);
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

    function test_constructor_revertsOnDuplicateWhitelistEntry() public {
        // A duplicate would let minAnonymitySet exceed the distinct voter count
        // and brick voting forever (round 2 finding R2-1).
        address[] memory w = _whitelist();
        w[2] = w[0];
        vm.expectRevert(Election.DuplicateWhitelistEntry.selector);
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

    function test_commitments_listsRegistrationsInOrder() public {
        assertEq(election.commitments().length, 0);
        _register(bob, 7);
        _register(alice, 5);
        uint256[] memory c = election.commitments();
        assertEq(c.length, 2);
        assertEq(c[0], 7);
        assertEq(c[1], 5);
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
    // Registration via relayer (registerFor + EIP-712 signature)
    // =====================================================================

    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    function _key(string memory name) internal returns (uint256 key) {
        (, key) = makeAddrAndKey(name);
    }

    function _sign(Election e, uint256 key, address wallet, uint256 commitment) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, e.registerDigest(wallet, commitment));
        return abi.encodePacked(r, s, v);
    }

    function test_registerFor_happyPathViaRelayer() public {
        bytes memory sig = _sign(election, _key("alice"), alice, 42);

        vm.expectEmit(true, false, false, true, address(election));
        emit Election.Registered(alice, 42);
        vm.prank(dave); // relayer, not whitelisted
        election.registerFor(alice, 42, sig);

        assertTrue(election.hasRegistered(alice));
        assertFalse(election.hasRegistered(dave));
        assertTrue(mock.isMember(election.groupId(), 42));
    }

    /// The digest is standard EIP-712, so wallets (eth_signTypedData_v4) produce it.
    function test_registerFor_digestIsEip712() public view {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("goblett Election"),
                keccak256("1"),
                block.chainid,
                address(election)
            )
        );
        bytes32 structHash = keccak256(abi.encode(keccak256("Register(address wallet,uint256 identityCommitment)"), alice, 42));
        assertEq(election.registerDigest(alice, 42), keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
    }

    function test_registerFor_revertsOnWrongSigner() public {
        bytes memory sig = _sign(election, _key("bob"), alice, 42);
        vm.expectRevert(Election.InvalidSignature.selector);
        election.registerFor(alice, 42, sig);
    }

    function test_registerFor_revertsIfRelayerChangesCommitment() public {
        bytes memory sig = _sign(election, _key("alice"), alice, 42);
        vm.expectRevert(Election.InvalidSignature.selector);
        election.registerFor(alice, 43, sig);
    }

    function test_registerFor_revertsOnSignatureForOtherElection() public {
        Election other = _deploy(_candidates(3), _whitelist(), regEnd, votingStart, votingEnd, 2);
        bytes memory sig = _sign(other, _key("alice"), alice, 42);
        vm.expectRevert(Election.InvalidSignature.selector);
        election.registerFor(alice, 42, sig);
    }

    function test_registerFor_revertsOnOtherChain() public {
        bytes memory sig = _sign(election, _key("alice"), alice, 42);
        vm.chainId(block.chainid + 1);
        vm.expectRevert(Election.InvalidSignature.selector);
        election.registerFor(alice, 42, sig);
    }

    function test_registerFor_revertsOnMalleableSignature() public {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(_key("alice"), election.registerDigest(alice, 42));
        // (r, n - s, v ^ 1) recovers the same address but is rejected (high s).
        bytes memory twin = abi.encodePacked(r, bytes32(SECP256K1_N - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(Election.InvalidSignature.selector);
        election.registerFor(alice, 42, twin);
    }

    function test_registerFor_revertsOnBadLength() public {
        bytes memory sig = _sign(election, _key("alice"), alice, 42);
        bytes memory truncated = new bytes(64);
        for (uint256 i = 0; i < 64; i++) {
            truncated[i] = sig[i];
        }
        vm.expectRevert(Election.InvalidSignature.selector);
        election.registerFor(alice, 42, truncated);
    }

    function test_registerFor_revertsIfSignerNotWhitelisted() public {
        bytes memory sig = _sign(election, _key("dave"), dave, 42);
        vm.expectRevert(Election.NotWhitelisted.selector);
        election.registerFor(dave, 42, sig);
    }

    function test_registerFor_replayReverts() public {
        bytes memory sig = _sign(election, _key("alice"), alice, 42);
        election.registerFor(alice, 42, sig);
        vm.expectRevert(Election.AlreadyRegistered.selector);
        election.registerFor(alice, 42, sig);
    }

    function test_registerFor_revertsAfterDirectRegister() public {
        _register(alice, 1);
        bytes memory sig = _sign(election, _key("alice"), alice, 42);
        vm.expectRevert(Election.AlreadyRegistered.selector);
        election.registerFor(alice, 42, sig);
    }

    function test_registerFor_revertsAtRegistrationEnd() public {
        bytes memory sig = _sign(election, _key("alice"), alice, 42);
        vm.warp(regEnd);
        vm.expectRevert(Election.RegistrationClosed.selector);
        election.registerFor(alice, 42, sig);
    }

    function test_registerFor_erc1271Wallet() public {
        MockERC1271Wallet wallet = new MockERC1271Wallet();
        address[] memory w = _whitelist();
        w[2] = address(wallet);
        Election e = _deploy(_candidates(3), w, regEnd, votingStart, votingEnd, 2);

        // Not approved yet: the wallet rejects, and there's no EOA key behind it.
        vm.expectRevert(Election.InvalidSignature.selector);
        e.registerFor(address(wallet), 42, "");

        wallet.approve(e.registerDigest(address(wallet), 42));
        vm.prank(dave);
        e.registerFor(address(wallet), 42, "");
        assertTrue(e.hasRegistered(address(wallet)));
    }

    function testFuzz_registerFor_onlyOwnKeyWorks(uint256 commitment, uint256 otherKey) public {
        commitment = bound(commitment, 1, type(uint128).max);
        otherKey = bound(otherKey, 1, SECP256K1_N - 1);
        vm.assume(vm.addr(otherKey) != alice);
        bytes memory sig = _sign(election, otherKey, alice, commitment);
        vm.expectRevert(Election.InvalidSignature.selector);
        election.registerFor(alice, commitment, sig);
    }

    function test_constructor_acceptsMaxCandidates() public {
        Election e = _deploy(_candidates(_maxCandidates()), _whitelist(), regEnd, votingStart, votingEnd, 2);
        assertEq(e.candidates().length, _maxCandidates());
    }

    // =====================================================================
    // Voting: shared checks (one per check, in Election._useProof)
    // =====================================================================

    function test_vote_revertsDuringRegistration() public {
        _registerAll();
        ISemaphore.SemaphoreProof memory p = _proof(0, 1);
        vm.expectRevert(Election.VotingNotOpen.selector);
        _submit(p, 0);
    }

    function test_vote_revertsDuringFrozenGap() public {
        _registerAll();
        vm.warp(regEnd);
        ISemaphore.SemaphoreProof memory p = _proof(0, 1);
        vm.expectRevert(Election.VotingNotOpen.selector);
        _submit(p, 0);
    }

    function test_vote_succeedsJustBeforeVotingEnd() public {
        _registerAll();
        vm.warp(votingEnd - 1);
        _submit(_proof(0, 1), 0);
        assertEq(election.totalVotes(), 1);
    }

    function test_vote_revertsAtExactlyVotingEnd() public {
        _registerAll();
        vm.warp(votingEnd);
        ISemaphore.SemaphoreProof memory p = _proof(0, 1);
        vm.expectRevert(Election.VotingNotOpen.selector);
        _submit(p, 0);
    }

    function test_vote_revertsIfAnonymitySetTooSmall() public {
        _register(alice, 1); // min is 2
        vm.warp(votingStart);
        ISemaphore.SemaphoreProof memory p = _proof(0, 1);
        vm.expectRevert(Election.AnonymitySetTooSmall.selector);
        _submit(p, 0);
    }

    function test_vote_revertsOnWrongScope() public {
        _openVoting();
        ISemaphore.SemaphoreProof memory p = _proof(0, 1);
        p.scope = election.scope() + 1;
        vm.expectRevert(Election.WrongScope.selector);
        _submit(p, 0);
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
        _submit(p, 0);
    }

    function test_vote_revertsOnReusedNullifier() public {
        _openVoting();
        _submit(_proof(0, 99), 0);

        // Same nullifier, different candidate and different sender.
        ISemaphore.SemaphoreProof memory p = _proof(1, 99);
        vm.prank(dave);
        vm.expectRevert(Election.NullifierAlreadyUsed.selector);
        _submit(p, 1);
    }

    function test_vote_revertsOnInvalidProof() public {
        _openVoting();
        mock.setProofValid(false);
        ISemaphore.SemaphoreProof memory p = _proof(0, 1);
        vm.expectRevert(Election.InvalidProof.selector);
        _submit(p, 0);
    }

    /// The submitter is irrelevant: a non-whitelisted relayer can submit.
    function test_vote_anyoneCanRelay() public {
        _openVoting();
        // Build the proof first: _proof() makes calls, and vm.prank applies
        // only to the very next call.
        ISemaphore.SemaphoreProof memory p = _proof(2, 5);
        vm.prank(dave);
        _submit(p, 2);
        assertEq(election.tally()[2], 1);
        assertTrue(election.nullifierUsed(5));
        assertEq(election.totalVotes(), 1);
    }

    // =====================================================================
    // Results and phases (shared)
    // =====================================================================

    function test_winners_revertsBeforeVotingEnd() public {
        _openVoting();
        vm.expectRevert(Election.ElectionNotOver.selector);
        election.winners();
    }

    function test_winners_noVotesMeansAllTied() public {
        assertEq(_winners().length, 3);
    }

    function test_winners_singleVoteWins() public {
        _openVoting();
        _submit(_proof(2, 1), 2);
        uint256[] memory w = _winners();
        assertEq(w.length, 1);
        assertEq(w[0], 2);
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

    function testFuzz_tallySumsToTotalVotes(uint8 k) public {
        _openVoting();
        for (uint256 i = 0; i < k; i++) {
            _submit(_proof(i % 3, i + 1), i % 3);
        }

        uint256[] memory t = election.tally();
        assertEq(t[0] + t[1] + t[2], k);
        assertEq(election.totalVotes(), k);
    }

    // =====================================================================
    // Relayer payment (gas refund + bounty, pull payment)
    // =====================================================================

    uint256 internal constant GAS_PRICE = 25 gwei;

    function _fund(uint256 amount) internal {
        vm.deal(address(this), amount);
        (bool ok,) = address(election).call{value: amount}("");
        assertTrue(ok);
    }

    /// dave relays alice's registration at `gasPrice`.
    function _relayRegistration(uint256 gasPrice) internal {
        bytes memory sig = _sign(election, _key("alice"), alice, 42);
        vm.txGasPrice(gasPrice);
        vm.prank(dave);
        election.registerFor(alice, 42, sig);
    }

    /// dave relays one vote at `gasPrice` (voting must be open).
    function _relayVote(uint256 gasPrice) internal {
        ISemaphore.SemaphoreProof memory p = _proof(0, _nextNullifier++);
        vm.txGasPrice(gasPrice);
        vm.prank(dave);
        _submit(p, 0);
    }

    function test_relay_termsAndCreatorAreRecorded() public view {
        assertEq(election.relayBounty(), BOUNTY);
        assertEq(election.maxRefundGasPrice(), MAX_GAS_PRICE);
        assertEq(election.creator(), address(this));
    }

    function test_relay_constructorRejectsHugeTerms() public {
        // Would let the credit arithmetic overflow, which would block voting.
        vm.expectRevert(Election.InvalidRelayTerms.selector);
        _deployWithTerms(uint256(type(uint128).max) + 1, MAX_GAS_PRICE);
        vm.expectRevert(Election.InvalidRelayTerms.selector);
        _deployWithTerms(BOUNTY, uint256(type(uint128).max) + 1);
    }

    function test_relay_fundingIsCountedAndAnyoneCanFund() public {
        assertEq(election.relayFunds(), 0);
        vm.expectEmit(true, false, false, true, address(election));
        emit Election.Funded(address(this), 1 ether);
        _fund(1 ether);
        assertEq(election.relayFunds(), 1 ether);
    }

    function test_relay_registerForCreditsRefundPlusBounty() public {
        _fund(1 ether);
        _relayRegistration(GAS_PRICE);

        uint256 credit = election.owed(dave);
        // bounty + gas * price, with gas somewhere between the overhead and the cap.
        assertGt(credit, BOUNTY + election.REFUND_GAS_OVERHEAD() * GAS_PRICE);
        assertLe(credit, BOUNTY + election.MAX_REFUND_GAS() * GAS_PRICE);
        assertEq(election.totalOwed(), credit);
        assertEq(election.relayFunds(), 1 ether - credit);
        assertEq(election.owed(alice), 0); // the voter is not paid, the relayer is
    }

    function test_relay_voteCreditsRefundPlusBounty() public {
        _fund(1 ether);
        _openVoting();
        _relayVote(GAS_PRICE);

        uint256 credit = election.owed(dave);
        assertGt(credit, BOUNTY + election.REFUND_GAS_OVERHEAD() * GAS_PRICE);
        assertLe(credit, BOUNTY + election.MAX_REFUND_GAS() * GAS_PRICE);
        assertEq(election.totalVotes(), 1);
    }

    function test_relay_directRegisterIsNotCredited() public {
        _fund(1 ether);
        vm.txGasPrice(GAS_PRICE);
        _register(alice, 1);
        assertEq(election.owed(alice), 0);
        assertEq(election.totalOwed(), 0);
    }

    /// A relayer can't make the election pay for an inflated gas price.
    function test_relay_gasPriceIsCapped() public {
        _fund(100 ether);
        _relayRegistration(MAX_GAS_PRICE * 1000);
        assertLe(election.owed(dave), BOUNTY + election.MAX_REFUND_GAS() * MAX_GAS_PRICE);
    }

    /// A failed relay (bad signature, reused nullifier, ...) reverts, so it earns nothing.
    function test_relay_failedCallsEarnNothing() public {
        _fund(1 ether);
        bytes memory sig = _sign(election, _key("bob"), alice, 42);
        vm.prank(dave);
        vm.expectRevert(Election.InvalidSignature.selector);
        election.registerFor(alice, 42, sig);

        _openVoting();
        ISemaphore.SemaphoreProof memory p = _proof(0, 77);
        _submit(p, 0); // first one counts (credited to this test contract)
        vm.prank(dave);
        vm.expectRevert(Election.NullifierAlreadyUsed.selector);
        _submit(p, 0);
        assertEq(election.owed(dave), 0);
    }

    /// Voting must never depend on the funding.
    function test_relay_unfundedElectionStillWorksWithoutCredit() public {
        _relayRegistration(GAS_PRICE);
        assertTrue(election.hasRegistered(alice));
        _register(bob, 2);
        _register(carol, 3);
        vm.warp(votingStart);
        _relayVote(GAS_PRICE);
        assertEq(election.totalVotes(), 1);
        assertEq(election.owed(dave), 0);
    }

    function test_relay_creditIsLimitedToRemainingFunds() public {
        _fund(1000 wei); // far less than one credit
        _relayRegistration(GAS_PRICE);
        assertEq(election.owed(dave), 1000 wei);
        assertEq(election.relayFunds(), 0);

        // Nothing left: later relays still succeed, for free.
        _register(bob, 2);
        _register(carol, 3);
        vm.warp(votingStart);
        _relayVote(GAS_PRICE);
        assertEq(election.owed(dave), 1000 wei);
        assertEq(election.totalVotes(), 1);
    }

    function test_relay_withdrawPaysOnce() public {
        _fund(1 ether);
        _relayRegistration(GAS_PRICE);
        uint256 credit = election.owed(dave);

        vm.expectEmit(true, false, false, true, address(election));
        emit Election.Withdrawn(dave, credit);
        vm.prank(dave);
        election.withdraw();
        assertEq(dave.balance, credit);
        assertEq(election.owed(dave), 0);
        assertEq(election.totalOwed(), 0);
        assertEq(address(election).balance, 1 ether - credit);

        vm.prank(dave);
        vm.expectRevert(Election.NothingToWithdraw.selector);
        election.withdraw();
    }

    function test_relay_withdrawRevertsWithNothingOwed() public {
        _fund(1 ether);
        vm.prank(dave);
        vm.expectRevert(Election.NothingToWithdraw.selector);
        election.withdraw();
    }

    /// A relayer that tries to re-enter withdraw() from its receive hook gets nothing extra.
    function test_relay_withdrawBlocksReentrancy() public {
        _fund(1 ether);
        ReentrantRelayer attacker = new ReentrantRelayer(election);
        bytes memory sig = _sign(election, _key("alice"), alice, 42);
        vm.txGasPrice(GAS_PRICE);
        attacker.relay(alice, 42, sig);
        uint256 credit = election.owed(address(attacker));
        assertGt(credit, 0);

        // The nested call reverts (Reentrancy), which makes the transfer fail.
        vm.expectRevert(Election.TransferFailed.selector);
        attacker.attack();
        assertEq(election.owed(address(attacker)), credit);
        assertEq(address(election).balance, 1 ether);
    }

    /// A relayer that can't receive funds only hurts itself.
    function test_relay_unpayableRelayerCannotBlockOthers() public {
        _fund(1 ether);
        vm.txGasPrice(GAS_PRICE);
        bytes memory sig = _sign(election, _key("alice"), alice, 42);
        vm.prank(address(mock)); // MockSemaphore has no receive(): it can't be paid
        election.registerFor(alice, 42, sig);
        vm.prank(address(mock));
        vm.expectRevert(Election.TransferFailed.selector);
        election.withdraw();

        bytes memory sig2 = _sign(election, _key("bob"), bob, 43);
        vm.prank(dave);
        election.registerFor(bob, 43, sig2);
        vm.prank(dave);
        election.withdraw();
        assertGt(dave.balance, 0);
    }

    function test_relay_reclaimOnlyAfterVotingEnds() public {
        _fund(1 ether);
        vm.expectRevert(Election.ElectionNotOver.selector);
        election.reclaim();
    }

    /// Leftover funding goes back to the creator; what relayers are owed stays.
    function test_relay_reclaimReturnsLeftoverToCreator() public {
        _fund(1 ether);
        _relayRegistration(GAS_PRICE);
        uint256 credit = election.owed(dave);

        vm.warp(votingEnd);
        uint256 before = address(this).balance;
        vm.prank(dave); // anyone may trigger it; the money still goes to the creator
        election.reclaim();
        assertEq(address(this).balance - before, 1 ether - credit);
        assertEq(address(election).balance, credit);

        vm.prank(dave);
        election.withdraw();
        assertEq(dave.balance, credit);
        assertEq(address(election).balance, 0);

        vm.expectRevert(Election.NothingToWithdraw.selector);
        election.reclaim();
    }

    /// Whatever happens, the contract always holds at least what it owes.
    function testFuzz_relay_solvent(uint96 funding, uint64 gasPrice, uint8 votes) public {
        _fund(funding);
        _relayRegistration(gasPrice);
        _register(bob, 2);
        _register(carol, 3);
        vm.warp(votingStart);
        for (uint256 i = 0; i < votes % 8; i++) {
            _relayVote(gasPrice);
        }
        assertGe(address(election).balance, election.totalOwed());
        assertEq(election.owed(dave), election.totalOwed());
    }

    /// The test contract is the creator and receives reclaimed funds.
    receive() external payable {}

    function _deployWithTerms(uint256 bounty, uint256 maxGasPrice) internal virtual returns (Election);
}

/// Relays a registration, then tries to withdraw twice by re-entering from receive().
contract ReentrantRelayer {
    Election internal immutable election;

    constructor(Election e) {
        election = e;
    }

    function relay(address wallet, uint256 commitment, bytes calldata sig) external {
        election.registerFor(wallet, commitment, sig);
    }

    function attack() external {
        election.withdraw();
    }

    receive() external payable {
        election.withdraw();
    }
}
