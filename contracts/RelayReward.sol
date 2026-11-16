// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Pays the account that relays one Nostr event id. The id can be paid once.
contract RelayReward {
    error EmptyEvent();
    error AlreadyRewarded(bytes32 eventId);
    error RewardUnpaid();

    uint256 public immutable reward;
    mapping(bytes32 => address) public relayedBy;

    event RewardPaid(bytes32 indexed eventId, address indexed relayer, uint256 amount);

    constructor(uint256 reward_) payable {
        reward = reward_;
    }

    function relay(bytes32 eventId) external {
        if (eventId == bytes32(0)) revert EmptyEvent();
        if (relayedBy[eventId] != address(0)) revert AlreadyRewarded(eventId);
        relayedBy[eventId] = msg.sender;
        (bool ok,) = msg.sender.call{value: reward}("");
        if (!ok) revert RewardUnpaid();
        emit RewardPaid(eventId, msg.sender, reward);
    }
}
