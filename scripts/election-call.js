const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { encodeVotes } = require('./ballots');

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
  'function record(bytes32 eventId, string voter, uint8[] ballotIds, uint256[] choiceCounts, uint256[] choices)',
  'error EmptyEvent()',
  'error EmptyVoter()',
  'error AlreadyRecorded(bytes32 eventId)',
  'error UnknownBallot(uint256 ballotId)',
  'error BadVote()'
];

function relayerWallet() {
  const rpcUrl = process.env.RPC_URL || 'http://127.0.0.1:8545';
  const local = /127\.0\.0\.1|localhost/.test(rpcUrl);
  const privateKey = process.env.RELAYER_PRIVATE_KEY || (local ? HARDHAT_ACCOUNT_0 : '');
  if (!privateKey) throw new Error('Set RELAYER_PRIVATE_KEY to the account that receives the relay reward.');
  return new ethers.Wallet(privateKey, new ethers.JsonRpcProvider(rpcUrl));
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
    const transaction = await contract[method](...args);
    const receipt = await transaction.wait();
    return receipt.hash;
  } catch (error) {
    const parsed = customError(contract, error);
    if (parsed && ignored.indexOf(parsed.name) >= 0) return null;
    if (parsed && parsed.name === 'AlreadyRewarded') throw new Error('This Nostr event was already rewarded.');
    if (parsed && parsed.name === 'BadVote') throw new Error('The vote does not match a ballot on the ledger.');
    throw error;
  }
}

async function callElection(info, validation) {
  if (!validation || !validation.eventId) throw new Error('The Nostr event was not validated.');
  if (!info || !info.npub) throw new Error('The vote is missing its Nostr account.');
  if (!fs.existsSync(ledgerFile)) throw new Error('Deploy the vote ledger before recording a vote.');
  if (!fs.existsSync(rewardFile)) throw new Error('Deploy the relay reward contract before paying a reward.');
  const ledgerDeployed = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  const rewardDeployed = JSON.parse(fs.readFileSync(rewardFile, 'utf8'));
  const wallet = relayerWallet();
  const encoded = encodeVotes(info.votes);
  const eventId = ethers.zeroPadValue('0x' + validation.eventId, 32);
  const ledger = new ethers.Contract(ledgerDeployed.address, ledgerAbi, wallet);
  const recordTransaction = await send(ledger, 'record', [
    eventId,
    info.npub,
    encoded.ballotIds,
    encoded.choiceCounts,
    encoded.choices
  ], ['AlreadyRecorded']);
  const rewardContract = new ethers.Contract(rewardDeployed.address, rewardAbi, wallet);
  const transaction = await send(rewardContract, 'relay', [eventId], []);
  return {
    transaction: transaction,
    recordTransaction: recordTransaction,
    contract: ledgerDeployed.address,
    rewardContract: rewardDeployed.address,
    relayer: wallet.address,
    reward: (await rewardContract.reward()).toString(),
    eventId: validation.eventId
  };
}

module.exports = { callElection };
