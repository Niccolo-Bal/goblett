const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

function loadEnv(file = path.join(__dirname, '..', '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error('Set ' + name + ' in .env. Copy .env.example to start.');
  return value;
}

function arcConfig() {
  loadEnv();
  const network = (process.env.ARC_NETWORK || 'testnet').toLowerCase();
  if (network !== 'testnet' && network !== 'mainnet') {
    throw new Error('ARC_NETWORK must be testnet or mainnet.');
  }
  const prefix = network === 'mainnet' ? 'ARC_MAINNET' : 'ARC_TESTNET';
  const contract = process.env[prefix + '_CONTRACT'] || '';
  return {
    network,
    chainId: BigInt(required(prefix + '_CHAIN_ID')),
    chainName: network === 'mainnet' ? 'Arc' : 'Arc Testnet',
    rpcUrl: required(prefix + '_RPC_URL'),
    explorerUrl: required(prefix + '_EXPLORER_URL'),
    verifyingContract: ethers.isAddress(contract) ? ethers.getAddress(contract) : '',
    domainName: process.env.VOTING_EIP712_NAME || 'Goblett',
    maxFeePerGas: process.env.MAX_FEE_PER_GAS ? BigInt(process.env.MAX_FEE_PER_GAS) : null,
    privateKey: process.env.RELAYER_PRIVATE_KEY || '',
    port: Number(process.env.RELAYER_PORT || 8787)
  };
}

module.exports = { arcConfig, loadEnv };
