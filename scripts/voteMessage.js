const { ethers } = require('ethers');

// Must stay identical to votePayload() in main.html and submitSignedVotes in Voting.sol.
function votePayload(chainId, contractAddress, voter, questionIds, choices) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'uint256', 'address', 'address', 'uint256[]', 'bool[]'],
    [ethers.id('Goblett vote'), chainId, contractAddress, voter, questionIds, choices]
  ));
}

module.exports = { votePayload };
