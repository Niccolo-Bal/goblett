// EIP-712 Vote, matching the contract domain version "1".
// The domain name is VOTING_EIP712_NAME and must be the name the contract was constructed with.
const VOTE_TYPES = {
  Vote: [
    { name: 'proposalId', type: 'uint256' },
    { name: 'choice', type: 'uint8' },
    { name: 'deadline', type: 'uint256' }
  ]
};

function voteDomain(config) {
  return {
    name: config.domainName,
    version: '1',
    chainId: config.chainId,
    verifyingContract: config.verifyingContract
  };
}

module.exports = { VOTE_TYPES, voteDomain };
