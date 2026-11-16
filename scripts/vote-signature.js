const { ethers } = require('ethers');
const { verifyProof } = require('./merkle');

// Must match voteHash() in VoteLedger. The signed bytes bind the ballot to
// this chain, this contract, and the Merkle root the wallet is proving.
function voteHash(chainId, contractAddress, merkleRoot, voter, ballotIds, choiceCounts, choices) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return ethers.keccak256(coder.encode(
    ['uint256', 'address', 'bytes32', 'address', 'bytes32', 'bytes32', 'bytes32'],
    [
      chainId,
      contractAddress,
      merkleRoot,
      voter,
      ethers.keccak256(coder.encode(['uint8[]'], [ballotIds])),
      ethers.keccak256(coder.encode(['uint256[]'], [choiceCounts])),
      ethers.keccak256(coder.encode(['uint256[]'], [choices]))
    ]
  ));
}

function recoverSigner(chainId, contractAddress, merkleRoot, voter, ballotIds, choiceCounts, choices, signature) {
  const hash = voteHash(chainId, contractAddress, merkleRoot, voter, ballotIds, choiceCounts, choices);
  return ethers.verifyMessage(ethers.getBytes(hash), signature);
}

// EIP-712 registration signature. Election.registerFor checks this before
// the commitment is inserted into the Semaphore Merkle tree.
const REGISTER_TYPES = {
  Register: [
    { name: 'wallet', type: 'address' },
    { name: 'identityCommitment', type: 'uint256' }
  ]
};

function registerDomain(chainId, election) {
  return {
    name: 'goblet Election',
    version: '1',
    chainId: chainId,
    verifyingContract: election
  };
}

function recoverRegistration(chainId, election, wallet, identityCommitment, signature) {
  return ethers.verifyTypedData(
    registerDomain(chainId, election),
    REGISTER_TYPES,
    { wallet: wallet, identityCommitment: identityCommitment },
    signature
  );
}

function assertCast(chainId, contractAddress, merkleRoot, voter, ballotIds, choiceCounts, choices, signature, proof) {
  const claimed = ethers.getAddress(voter);
  let recovered;
  try {
    recovered = recoverSigner(chainId, contractAddress, merkleRoot, claimed, ballotIds, choiceCounts, choices, signature);
  } catch (error) {
    throw new Error('The vote signature is not valid.');
  }
  if (recovered !== claimed) throw new Error('The vote signature is from a different wallet.');
  if (!verifyProof(merkleRoot, claimed, proof)) throw new Error('This wallet is not on the Merkle tree.');
  return claimed;
}

module.exports = {
  voteHash,
  recoverSigner,
  recoverRegistration,
  assertCast,
  REGISTER_TYPES,
  registerDomain
};
