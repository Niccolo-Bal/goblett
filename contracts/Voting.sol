// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract Voting {
    uint256 public constant QUESTION_COUNT = 8;
    uint256 public constant ELECTION_COUNT = 2;
    uint256 public constant QUESTIONS_PER_ELECTION = 4;

    address public owner;
    mapping(uint256 => mapping(address => bool)) public whitelisted;
    mapping(uint256 => uint256) public yesVotes;
    mapping(uint256 => uint256) public noVotes;
    mapping(uint256 => mapping(address => bool)) public hasVoted;

    event VoteCast(uint256 indexed questionId, address indexed voter, bool choice);
    event WhitelistUpdated(uint256 indexed electionId, address indexed voter, bool allowed);

    error InvalidBatch();
    error InvalidQuestion(uint256 questionId);
    error InvalidElection(uint256 electionId);
    error AlreadyVoted(uint256 questionId, address voter);
    error InvalidSignature();
    error NotOwner();
    error NotWhitelisted(uint256 electionId, address voter);

    constructor() {
        owner = msg.sender;
    }

    function electionName(uint256 electionId) public pure returns (string memory) {
        if (electionId == 0) return "State";
        if (electionId == 1) return "Federal";
        revert InvalidElection(electionId);
    }

    function setWhitelist(uint256 electionId, address voter, bool allowed) external {
        if (msg.sender != owner) revert NotOwner();
        if (electionId >= ELECTION_COUNT) revert InvalidElection(electionId);
        whitelisted[electionId][voter] = allowed;
        emit WhitelistUpdated(electionId, voter, allowed);
    }

    function submitVotes(uint256[] calldata questionIds, bool[] calldata choices) external {
        _cast(msg.sender, questionIds, choices);
    }

    // The voter signs the batch. A relayer submits this transaction and pays gas.
    // The votes are stored for the recovered signer, not for the relayer.
    function submitSignedVotes(
        address voter,
        uint256[] calldata questionIds,
        bool[] calldata choices,
        bytes calldata signature
    ) external {
        bytes32 payload = keccak256(abi.encode(
            keccak256("Goblett vote"),
            block.chainid,
            address(this),
            voter,
            questionIds,
            choices
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", payload));
        if (_recover(digest, signature) != voter) revert InvalidSignature();
        _cast(voter, questionIds, choices);
    }

    function _cast(address voter, uint256[] calldata questionIds, bool[] calldata choices) internal {
        if (questionIds.length == 0 || questionIds.length != choices.length) revert InvalidBatch();

        for (uint256 i = 0; i < questionIds.length; i++) {
            uint256 questionId = questionIds[i];
            if (questionId >= QUESTION_COUNT) revert InvalidQuestion(questionId);
            uint256 electionId = questionId / QUESTIONS_PER_ELECTION;
            if (!whitelisted[electionId][voter]) revert NotWhitelisted(electionId, voter);
            if (hasVoted[questionId][voter]) revert AlreadyVoted(questionId, voter);

            hasVoted[questionId][voter] = true;
            if (choices[i]) {
                yesVotes[questionId]++;
            } else {
                noVotes[questionId]++;
            }
            emit VoteCast(questionId, voter, choices[i]);
        }
    }

    function _recover(bytes32 digest, bytes calldata signature) internal pure returns (address) {
        if (signature.length != 65) revert InvalidSignature();

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) revert InvalidSignature();
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert InvalidSignature();

        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
        return signer;
    }
}
