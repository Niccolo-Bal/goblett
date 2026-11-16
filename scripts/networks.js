const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GAS_FLOOR = 20n * 1000000000n;

const NETWORKS = {
  local: {
    id: 'local',
    chainId: 31337,
    chainIdHex: '0x7a69',
    name: 'Local Hardhat',
    rpcUrl: 'http://127.0.0.1:8545',
    explorerUrl: '',
    currency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    hardhat: 'localhost',
    arc: false
  },
  testnet: {
    id: 'testnet',
    chainId: 5042002,
    chainIdHex: '0x4cef52',
    name: 'Arc Testnet',
    rpcUrl: 'https://rpc.testnet.arc.io',
    explorerUrl: 'https://explorer.testnet.arc.io',
    currency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    hardhat: 'arcTestnet',
    arc: true
  },
  mainnet: {
    id: 'mainnet',
    chainId: 5042,
    chainIdHex: '0x13b2',
    name: 'Arc',
    rpcUrl: 'https://rpc.mainnet.arc.io',
    explorerUrl: 'https://explorer.arc.io',
    currency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    hardhat: 'arc',
    arc: true
  }
};

function networkById(id) {
  const network = NETWORKS[String(id || '').toLowerCase()];
  if (!network) throw new Error('ARC_NETWORK must be local, testnet, or mainnet.');
  return network;
}

function readLive() {
  const file = path.join(ROOT, 'site', 'network.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function resolveNetwork() {
  if (process.env.ARC_NETWORK) return networkById(process.env.ARC_NETWORK);
  const live = readLive();
  if (live && live.id) return networkById(live.id);
  return NETWORKS.local;
}

async function feeOverrides(provider, network) {
  const selected = network || resolveNetwork();
  if (!selected.arc) return {};
  const fee = await provider.getFeeData();
  let maxFee = fee.maxFeePerGas && fee.maxFeePerGas > GAS_FLOOR ? fee.maxFeePerGas : GAS_FLOOR;
  let priority = fee.maxPriorityFeePerGas || 5000000000n;
  if (priority > maxFee) priority = maxFee;
  return { maxFeePerGas: maxFee, maxPriorityFeePerGas: priority };
}

function publishDeployment(record) {
  const network = networkById(record.id);
  const live = {
    id: network.id,
    chainId: network.chainId,
    chainIdHex: network.chainIdHex,
    name: network.name,
    rpcUrl: network.rpcUrl,
    explorerUrl: network.explorerUrl,
    currency: network.currency
  };
  const dir = path.join(ROOT, 'contracts', 'deployments');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, network.id + '.json'), JSON.stringify(record, null, 2) + '\n');
  fs.writeFileSync(path.join(ROOT, 'site', 'network.json'), JSON.stringify(live, null, 2) + '\n');
  const ledger = JSON.stringify({ address: record.ledger, merkleRoot: record.merkleRoot }, null, 2) + '\n';
  fs.writeFileSync(path.join(ROOT, 'site', 'vote-ledger.json'), ledger);
  fs.writeFileSync(path.join(ROOT, 'contracts', 'vote-ledger.json'), ledger);
  fs.writeFileSync(path.join(ROOT, 'site', 'allowlist.json'), JSON.stringify(record.allowlist, null, 2) + '\n');
  if (record.reward) {
    fs.writeFileSync(
      path.join(ROOT, 'contracts', 'relay-reward.json'),
      JSON.stringify({ address: record.reward, reward: record.rewardAmount }, null, 2) + '\n'
    );
  }
}

module.exports = {
  NETWORKS,
  networkById,
  resolveNetwork,
  feeOverrides,
  publishDeployment,
  readLive
};
