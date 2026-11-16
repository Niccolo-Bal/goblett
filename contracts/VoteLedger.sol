// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Stores each relayed Goblett vote and reports the winner from those votes.
contract VoteLedger {
    error EmptyEvent();
    error EmptyVoter();
    error AlreadyRecorded(bytes32 eventId);
    error UnknownBallot(uint256 ballotId);
    error BadVote();

    uint8 public constant YES_NO = 0;
    uint8 public constant CHOOSE_ONE = 1;
    uint8 public constant RANKED = 2;

    struct Ballot {
        string section;
        string name;
        uint8 mode;
        string[] options;
    }

    struct Cast {
        bytes32 eventId;
        string voter;
        uint8 ballotId;
        uint256[] choices;
    }

    Ballot[] private _ballots;
    Cast[] private _votes;
    mapping(bytes32 => bool) public recorded;

    event VoteRecorded(bytes32 indexed eventId, uint8 indexed ballotId, string voter, uint256[] choices);

    constructor(
        string[] memory sections,
        string[] memory names,
        uint8[] memory modes,
        string[][] memory options
    ) {
        uint256 count = sections.length;
        if (count == 0 || count != names.length || count != modes.length || count != options.length) revert BadVote();
        for (uint256 i = 0; i < count; i++) {
            if (bytes(sections[i]).length == 0 || bytes(names[i]).length == 0 || options[i].length < 2) revert BadVote();
            if (modes[i] > RANKED) revert BadVote();
            Ballot storage item = _ballots.push();
            item.section = sections[i];
            item.name = names[i];
            item.mode = modes[i];
            for (uint256 j = 0; j < options[i].length; j++) {
                if (bytes(options[i][j]).length == 0) revert BadVote();
                item.options.push(options[i][j]);
            }
        }
    }

    function ballotCount() external view returns (uint256) {
        return _ballots.length;
    }

    function voteCount() external view returns (uint256) {
        return _votes.length;
    }

    function ballot(uint256 ballotId)
        external
        view
        returns (string memory section, string memory name, uint8 mode, string[] memory options)
    {
        if (ballotId >= _ballots.length) revert UnknownBallot(ballotId);
        Ballot storage item = _ballots[ballotId];
        return (item.section, item.name, item.mode, item.options);
    }

    function vote(uint256 index)
        external
        view
        returns (bytes32 eventId, string memory voter, uint8 ballotId, uint256[] memory choices)
    {
        Cast storage item = _votes[index];
        return (item.eventId, item.voter, item.ballotId, item.choices);
    }

    function record(
        bytes32 eventId,
        string calldata voter,
        uint8[] calldata ballotIds,
        uint256[] calldata choiceCounts,
        uint256[] calldata choices
    ) external {
        if (eventId == bytes32(0)) revert EmptyEvent();
        if (bytes(voter).length == 0 || bytes(voter).length > 90) revert EmptyVoter();
        if (recorded[eventId]) revert AlreadyRecorded(eventId);
        if (ballotIds.length == 0 || ballotIds.length != choiceCounts.length) revert BadVote();

        recorded[eventId] = true;
        bool[] memory seen = new bool[](_ballots.length);
        uint256 cursor = 0;
        for (uint256 i = 0; i < ballotIds.length; i++) {
            uint8 ballotId = ballotIds[i];
            if (ballotId >= _ballots.length) revert UnknownBallot(ballotId);
            if (seen[ballotId]) revert BadVote();
            seen[ballotId] = true;
            uint256 count = choiceCounts[i];
            if (cursor + count > choices.length) revert BadVote();
            _checkChoices(ballotId, choices, cursor, count);
            _store(eventId, voter, ballotId, choices, cursor, count);
            cursor += count;
        }
        if (cursor != choices.length) revert BadVote();
    }

    /// @notice Plurality for yes/no and choose-one. Instant runoff for ranked choice.
    /// For a ranked ballot, `counts` is the deciding round.
    function result(uint256 ballotId)
        external
        view
        returns (bool hasVotes, bool tie, uint256 winnerIndex, uint256[] memory counts)
    {
        if (ballotId >= _ballots.length) revert UnknownBallot(ballotId);
        Ballot storage item = _ballots[ballotId];
        if (item.mode == RANKED) return _instantRunoff(ballotId, item.options.length);
        counts = new uint256[](item.options.length);
        uint256 total = 0;
        for (uint256 i = 0; i < _votes.length; i++) {
            if (_votes[i].ballotId != ballotId || _votes[i].choices.length == 0) continue;
            uint256 choice = _votes[i].choices[0];
            if (choice >= counts.length) continue;
            counts[choice] += 1;
            total += 1;
        }
        if (total == 0) return (false, false, 0, counts);
        (tie, winnerIndex) = _plurality(counts, total);
        return (true, tie, winnerIndex, counts);
    }

    function _store(
        bytes32 eventId,
        string calldata voter,
        uint8 ballotId,
        uint256[] calldata choices,
        uint256 cursor,
        uint256 count
    ) private {
        _votes.push();
        Cast storage item = _votes[_votes.length - 1];
        item.eventId = eventId;
        item.voter = voter;
        item.ballotId = ballotId;
        for (uint256 i = 0; i < count; i++) item.choices.push(choices[cursor + i]);
        emit VoteRecorded(eventId, ballotId, voter, item.choices);
    }

    function _checkChoices(uint8 ballotId, uint256[] calldata choices, uint256 cursor, uint256 count) private view {
        Ballot storage item = _ballots[ballotId];
        if (item.mode == RANKED) {
            if (count == 0 || count > item.options.length) revert BadVote();
        } else if (count != 1) {
            revert BadVote();
        }
        for (uint256 j = 0; j < count; j++) {
            uint256 choice = choices[cursor + j];
            if (choice >= item.options.length) revert BadVote();
            for (uint256 k = 0; k < j; k++) {
                if (choices[cursor + k] == choice) revert BadVote();
            }
        }
    }

    function _plurality(uint256[] memory counts, uint256 total)
        private
        pure
        returns (bool tie, uint256 winnerIndex)
    {
        uint256 best = 0;
        for (uint256 i = 1; i < counts.length; i++) {
            if (counts[i] > counts[best]) best = i;
        }
        uint256 leaders = 0;
        for (uint256 i = 0; i < counts.length; i++) {
            if (counts[i] == counts[best]) leaders += 1;
        }
        return (leaders != 1 || total == 0, best);
    }

    function _instantRunoff(uint256 ballotId, uint256 optionCount)
        private
        view
        returns (bool hasVotes, bool tie, uint256 winnerIndex, uint256[] memory counts)
    {
        bool[] memory eliminated = new bool[](optionCount);
        uint256 active = optionCount;
        counts = new uint256[](optionCount);
        if (!_hasRanking(ballotId)) return (false, false, 0, counts);

        while (active > 0) {
            uint256 total;
            (counts, total) = _roundCounts(ballotId, eliminated, optionCount);
            if (total == 0) return (true, true, 0, counts);
            (winnerIndex, tie, active) = _applyRound(counts, eliminated, total, active);
            if (tie || winnerIndex != type(uint256).max) return (true, tie, winnerIndex == type(uint256).max ? 0 : winnerIndex, counts);
        }
        return (true, true, 0, counts);
    }

    function _hasRanking(uint256 ballotId) private view returns (bool) {
        for (uint256 i = 0; i < _votes.length; i++) {
            if (_votes[i].ballotId == ballotId && _votes[i].choices.length > 0) return true;
        }
        return false;
    }

    function _roundCounts(uint256 ballotId, bool[] memory eliminated, uint256 optionCount)
        private
        view
        returns (uint256[] memory counts, uint256 total)
    {
        counts = new uint256[](optionCount);
        for (uint256 i = 0; i < _votes.length; i++) {
            if (_votes[i].ballotId != ballotId) continue;
            uint256[] storage ranking = _votes[i].choices;
            for (uint256 rank = 0; rank < ranking.length; rank++) {
                uint256 choice = ranking[rank];
                if (choice < optionCount && !eliminated[choice]) {
                    counts[choice] += 1;
                    total += 1;
                    break;
                }
            }
        }
    }

    /// @dev `winnerIndex` is `type(uint256).max` when another round is required.
    function _applyRound(uint256[] memory counts, bool[] memory eliminated, uint256 total, uint256 active)
        private
        pure
        returns (uint256 winnerIndex, bool tie, uint256 remaining)
    {
        uint256 best = 0;
        uint256 bestCount = 0;
        uint256 worstCount = type(uint256).max;
        uint256 seen = 0;
        bool allEqual = true;
        uint256 firstCount = 0;
        bool haveFirst = false;
        for (uint256 choice = 0; choice < counts.length; choice++) {
            if (eliminated[choice]) continue;
            seen += 1;
            if (!haveFirst) {
                firstCount = counts[choice];
                haveFirst = true;
            } else if (counts[choice] != firstCount) {
                allEqual = false;
            }
            if (counts[choice] > bestCount) {
                bestCount = counts[choice];
                best = choice;
            }
            if (counts[choice] < worstCount) worstCount = counts[choice];
        }
        if (bestCount * 2 > total) return (best, false, active);
        if (seen <= 1 || allEqual) return (best, true, active);
        for (uint256 cursor = counts.length; cursor > 0; cursor--) {
            uint256 choice = cursor - 1;
            if (!eliminated[choice] && counts[choice] == worstCount) {
                eliminated[choice] = true;
                return (type(uint256).max, false, active - 1);
            }
        }
        return (best, true, active);
    }
}
