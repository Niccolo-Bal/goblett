require('@nomicfoundation/hardhat-toolbox');
const { loadEnv } = require('./scripts/arc-config');

loadEnv();
const accounts = process.env.RELAYER_PRIVATE_KEY ? [process.env.RELAYER_PRIVATE_KEY] : [];

// The live election contracts are the Foundry project in dapp/.
// This config builds the vote ledger and the relay reward.
module.exports = {
  solidity: {
    version: '0.8.28',
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true
    }
  },
  paths: {
    sources: './contracts',
    tests: './legacy/hardhat/test',
    cache: './legacy/hardhat/cache',
    artifacts: './legacy/hardhat/artifacts'
  },
  networks: {
    hardhat: { chainId: 31337 },
    localhost: { url: 'http://127.0.0.1:8545', chainId: 31337 },
    arcTestnet: { url: 'https://rpc.testnet.arc.io', chainId: 5042002, accounts: accounts },
    arc: { url: 'https://rpc.mainnet.arc.io', chainId: 5042, accounts: accounts }
  }
};
