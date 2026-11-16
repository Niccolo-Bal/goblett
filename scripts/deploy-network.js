const fs = require('fs');
const path = require('path');
const hre = require('hardhat');
const { loadEnv } = require('./arc-config');
const { ballots } = require('./ballots');
const { members } = require('./members');
const { buildTree } = require('./merkle');
const { networkById, feeOverrides, publishDeployment } = require('./networks');

const ENV_FILE = path.join(__dirname, '..', '.env');
const GRAHAM = '0x253D8209D37C28c62932f7Cf644b608D53f1dDE4';
const BLOCKLISTED = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';

function ensureKey(name) {
  loadEnv();
  if (process.env[name]) return process.env[name];
  const wallet = hre.ethers.Wallet.createRandom();
  const prefix = fs.existsSync(ENV_FILE) && !fs.readFileSync(ENV_FILE, 'utf8').endsWith('\n') ? '\n' : '';
  fs.appendFileSync(ENV_FILE, prefix + name + '=' + wallet.privateKey + '\n');
  process.env[name] = wallet.privateKey;
  return wallet.privateKey;
}

function votersFor(network) {
  if (network.id === 'local') return members.slice();
  const tester = new hre.ethers.Wallet(ensureKey('TEST_VOTER_PRIVATE_KEY')).address;
  return [GRAHAM, tester].filter((address) => address.toLowerCase() !== BLOCKLISTED);
}

async function signerFor(network) {
  if (network.id === 'local') {
    const signers = await hre.ethers.getSigners();
    return signers[0];
  }
  const provider = new hre.ethers.JsonRpcProvider(network.rpcUrl, network.chainId, { staticNetwork: true });
  return new hre.ethers.Wallet(ensureKey('RELAYER_PRIVATE_KEY'), provider);
}

async function main() {
  loadEnv();
  if (!process.env.ARC_NETWORK) throw new Error('Set ARC_NETWORK to local, testnet, or mainnet.');
  const network = networkById(process.env.ARC_NETWORK);
  if (network.id === 'mainnet' && process.env.CONFIRM_MAINNET !== 'yes') {
    throw new Error('Set CONFIRM_MAINNET=yes to deploy on Arc. That spends real USDC.');
  }
  if (hre.network.name !== network.hardhat && !(network.id === 'local' && hre.network.name === 'hardhat')) {
    throw new Error('Run this with --network ' + network.hardhat + '.');
  }

  const signer = await signerFor(network);
  const remote = await signer.provider.getNetwork();
  if (remote.chainId !== BigInt(network.chainId)) {
    throw new Error('The RPC chain id does not match ' + network.name + '.');
  }
  if (signer.address.toLowerCase() === BLOCKLISTED) {
    throw new Error('This signer is blocklisted on Arc. Use a different RELAYER_PRIVATE_KEY.');
  }

  const fees = await feeOverrides(signer.provider, network);
  const balance = await signer.provider.getBalance(signer.address);
  const reward = hre.ethers.parseEther('0.01');
  const funding = hre.ethers.parseEther(network.arc ? '0.5' : '1');
  if (network.arc && balance < funding + hre.ethers.parseEther('0.2')) {
    const have = hre.ethers.formatEther(balance);
    throw new Error(
      'The relayer ' + signer.address + ' has ' + have + ' USDC on ' + network.name +
      '. Fund it from https://faucet.circle.com (Arc Testnet), then deploy again.'
    );
  }

  const voters = votersFor(network);
  const tree = buildTree(voters);
  const ledgerFactory = await hre.ethers.getContractFactory('VoteLedger', signer);
  const ledger = await ledgerFactory.deploy(
    ballots.map((ballot) => ballot.section),
    ballots.map((ballot) => ballot.name),
    ballots.map((ballot) => ballot.mode),
    ballots.map((ballot) => ballot.options),
    tree.root,
    fees
  );
  await ledger.waitForDeployment();

  const rewardFactory = await hre.ethers.getContractFactory('RelayReward', signer);
  const rewardContract = await rewardFactory.deploy(reward, { ...fees, value: funding });
  await rewardContract.waitForDeployment();

  const record = {
    id: network.id,
    chainId: network.chainId,
    ledger: await ledger.getAddress(),
    merkleRoot: tree.root,
    reward: await rewardContract.getAddress(),
    rewardAmount: reward.toString(),
    relayer: signer.address,
    voters: voters,
    allowlist: { root: tree.root, proofs: tree.proofs }
  };
  publishDeployment(record);
  console.log(network.name);
  console.log('VoteLedger', record.ledger);
  console.log('RelayReward', record.reward);
  console.log('Relayer', record.relayer);
  console.log('Voters', voters.join(', '));
  if (network.explorerUrl) console.log(network.explorerUrl + '/address/' + record.ledger);
}

main().catch((error) => {
  console.error(error.shortMessage || error.message);
  process.exitCode = 1;
});
