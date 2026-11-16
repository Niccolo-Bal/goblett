const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { encodeVotes } = require('./ballots');
const { loadEnv } = require('./arc-config');
const { resolveNetwork, feeOverrides } = require('./networks');

const HARDHAT_ACCOUNT_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const rewardFile = path.join(__dirname, '..', 'contracts', 'relay-reward.json');
const ledgerFile = path.join(__dirname, '..', 'contracts', 'vote-ledger.json');
const rewardAbi = [
  'function reward() view returns (uint256)',
  'function relayedBy(bytes32 eventId) view returns (address)',
  'function relay(bytes32 eventId)',
  'error EmptyEvent()',
  'error AlreadyRewarded(bytes32 eventId)',
  'error RewardUnpaid()'
];
const ledgerAbi = [
  'function hasVoted(address voter) view returns (bool)',
  'function recorded(bytes32 eventId) view returns (bool)',
  'function merkleRoot() view returns (bytes32)',
  'function record(bytes32 eventId, address voter, bytes signature, bytes32[] merkleProof, uint8[] ballotIds, uint256[] choiceCounts, uint256[] choices)',
  'error EmptyEvent()',
  'error AlreadyRecorded(bytes32 eventId)',
  'error AlreadyVoted(address voter)',
  'error InvalidSignature()',
  'error NotInTree()',
  'error UnknownBallot(uint256 ballotId)',
  'error BadVote()'
];
const proofType = 'tuple(uint256 merkleTreeDepth, uint256 merkleTreeRoot, uint256 nullifier, uint256 message, uint256 scope, uint256[8] points)';
const electionErrors = [
  'error VotingNotOpen()',
  'error InvalidProof()',
  'error RootNotCurrent()',
  'error WrongScope()',
  'error NullifierAlreadyUsed()',
  'error AnonymitySetTooSmall()',
  'error InvalidCandidate()',
  'error BallotMismatch()',
  'error InvalidRanking()'
];
const fptpAbi = ['function vote(' + proofType + ' proof)', ...electionErrors];
const rankedAbi = ['function vote(' + proofType + ' proof, uint256[] ranking)', ...electionErrors];

function relayerWallet() {
  loadEnv();
  const network = resolveNetwork();
  const rpcUrl = process.env.RPC_URL || network.rpcUrl;
  const privateKey = network.id === 'local' ? HARDHAT_ACCOUNT_0 : (process.env.RELAYER_PRIVATE_KEY || '');
  if (!privateKey) throw new Error('Set RELAYER_PRIVATE_KEY to the account that pays gas on ' + network.name + '.');
  return new ethers.Wallet(privateKey, new ethers.JsonRpcProvider(rpcUrl, network.chainId, { staticNetwork: true }));
}

function customError(contract, error) {
  const data = typeof error.data === 'string' ? error.data : '';
  if (!data) return null;
  try {
    return contract.interface.parseError(data);
  } catch (parseError) {
    return null;
  }
}

async function send(contract, method, args, ignored) {
  try {
    const fees = await feeOverrides(contract.runner.provider || contract.runner);
    const transaction = await contract[method](...args, fees);
    const receipt = await transaction.wait();
    return receipt.hash;
  } catch (error) {
    const parsed = customError(contract, error);
    if (parsed && ignored.indexOf(parsed.name) >= 0) return null;
    if (parsed && parsed.name === 'AlreadyRewarded') throw new Error('This Nostr event was already rewarded.');
    if (parsed && parsed.name === 'BadVote') throw new Error('The vote does not match a ballot on the ledger.');
    if (parsed && parsed.name === 'AlreadyVoted') throw new Error('This wallet already voted.');
    if (parsed && parsed.name === 'InvalidSignature') throw new Error('The vote signature is not valid.');
    if (parsed && parsed.name === 'NotInTree') throw new Error('This wallet is not on the Merkle tree.');
    if (parsed && parsed.name === 'RootNotCurrent') throw new Error('The proof Merkle root is not the election\'s current root.');
    if (parsed && parsed.name === 'InvalidProof') throw new Error('The Semaphore proof was rejected.');
    if (parsed && parsed.name === 'NullifierAlreadyUsed') throw new Error('This voter already has a ballot on the election.');
    if (parsed && parsed.name === 'BallotMismatch') throw new Error('The ranking does not match the proof.');
    if (parsed && parsed.name === 'VotingNotOpen') throw new Error('Voting is not open on this election.');
    throw error;
  }
}

function semaphoreProof(proof) {
  const points = proof && proof.points;
  if (!proof || !Array.isArray(points) || points.length !== 8) {
    throw new Error('The Semaphore proof is incomplete.');
  }
  return {
    merkleTreeDepth: proof.merkleTreeDepth,
    merkleTreeRoot: proof.merkleTreeRoot,
    nullifier: proof.nullifier,
    message: proof.message,
    scope: proof.scope,
    points: points
  };
}

async function submitSemaphoreVote(info, validation, wallet) {
  if (!ethers.isAddress(info.election)) throw new Error('Include the election contract address.');
  const proof = semaphoreProof(info.proof);
  const ranking = Array.isArray(info.ranking) ? info.ranking : null;
  const election = new ethers.Contract(info.election, ranking ? rankedAbi : fptpAbi, wallet);
  const args = ranking ? [proof, ranking] : [proof];
  const transaction = await send(election, 'vote', args, []);
  return {
    transaction: transaction,
    contract: ethers.getAddress(info.election),
    relayer: wallet.address,
    eventId: validation.eventId,
    kind: ranking ? 'ranked' : 'fptp'
  };
}

function ledgerEventId(signature) {
  return ethers.keccak256(signature);
}

async function commitVote(info) {
  if (!info || !info.signature || !info.voter || !Array.isArray(info.merkleProof)) {
    throw new Error('Sign the vote with a wallet on the Merkle tree.');
  }
  const wallet = relayerWallet();
  if (!fs.existsSync(ledgerFile)) throw new Error('Deploy the vote ledger before recording a vote.');
  const ledgerDeployed = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  const encoded = encodeVotes(info.votes);
  const eventId = ledgerEventId(info.signature);
  const ledger = new ethers.Contract(ledgerDeployed.address, ledgerAbi, wallet);
  if (await ledger.recorded(eventId)) {
    return { transaction: null, contract: ledgerDeployed.address, eventId: eventId, voter: info.voter, alreadyRecorded: true };
  }
  const recordTransaction = await send(ledger, 'record', [
    eventId,
    info.voter,
    info.signature,
    info.merkleProof,
    encoded.ballotIds,
    encoded.choiceCounts,
    encoded.choices
  ], []);
  return { transaction: recordTransaction, contract: ledgerDeployed.address, eventId: eventId, voter: info.voter, alreadyRecorded: false };
}

async function callElection(info, validation) {
  if (!validation || !validation.eventId) throw new Error('The Nostr event was not validated.');
  if (!info || !info.npub) throw new Error('The vote is missing its Nostr account.');
  const wallet = relayerWallet();
  if (!fs.existsSync(rewardFile)) throw new Error('Deploy the relay reward contract before paying a reward.');
  const committed = await commitVote(info);
  let cast = null;
  if (info.proof) cast = await submitSemaphoreVote(info, validation, wallet);
  const reward = await payReward(validation, wallet);
  return {
    transaction: cast ? cast.transaction : reward.transaction || committed.transaction,
    recordTransaction: committed.transaction,
    contract: cast ? cast.contract : committed.contract,
    rewardContract: reward.rewardContract || null,
    relayer: wallet.address,
    reward: reward.reward || null,
    eventId: validation.eventId,
    kind: cast ? cast.kind : 'ledger',
    voter: info.voter
  };
}

async function payReward(validation, wallet) {
  if (!fs.existsSync(rewardFile)) return {};
  const rewardDeployed = JSON.parse(fs.readFileSync(rewardFile, 'utf8'));
  const rewardContract = new ethers.Contract(rewardDeployed.address, rewardAbi, wallet);
  const eventId = ethers.zeroPadValue('0x' + validation.eventId, 32);
  const transaction = await send(rewardContract, 'relay', [eventId], []);
  return {
    transaction: transaction,
    rewardContract: rewardDeployed.address,
    reward: (await rewardContract.reward()).toString()
  };
}

module.exports = { callElection, commitVote };
