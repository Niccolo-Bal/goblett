const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const HARDHAT_ACCOUNT_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const addressFile = path.join(__dirname, '..', 'contracts', 'relay-reward.json');
const abi = [
  'function reward() view returns (uint256)',
  'function relayedBy(bytes32 eventId) view returns (address)',
  'function relay(bytes32 eventId)',
  'error EmptyEvent()',
  'error AlreadyRewarded(bytes32 eventId)',
  'error RewardUnpaid()'
];

function relayerWallet() {
  const rpcUrl = process.env.RPC_URL || 'http://127.0.0.1:8545';
  const local = /127\.0\.0\.1|localhost/.test(rpcUrl);
  const privateKey = process.env.RELAYER_PRIVATE_KEY || (local ? HARDHAT_ACCOUNT_0 : '');
  if (!privateKey) throw new Error('Set RELAYER_PRIVATE_KEY to the account that receives the relay reward.');
  return new ethers.Wallet(privateKey, new ethers.JsonRpcProvider(rpcUrl));
}

async function callElection(info, validation) {
  if (!validation || !validation.eventId) throw new Error('The Nostr event was not validated.');
  if (!fs.existsSync(addressFile)) throw new Error('Deploy the relay reward contract before paying a reward.');
  const deployed = JSON.parse(fs.readFileSync(addressFile, 'utf8'));
  const wallet = relayerWallet();
  const rewardContract = new ethers.Contract(deployed.address, abi, wallet);
  const eventId = ethers.zeroPadValue('0x' + validation.eventId, 32);
  let transaction;
  try {
    transaction = await rewardContract.relay(eventId);
  } catch (error) {
    const data = typeof error.data === 'string' ? error.data : '';
    const parsed = data ? rewardContract.interface.parseError(data) : null;
    if (parsed && parsed.name === 'AlreadyRewarded') throw new Error('This Nostr event was already rewarded.');
    throw error;
  }
  const receipt = await transaction.wait();
  return {
    transaction: receipt.hash,
    contract: deployed.address,
    relayer: wallet.address,
    reward: (await rewardContract.reward()).toString(),
    eventId: validation.eventId
  };
}

module.exports = { callElection };
