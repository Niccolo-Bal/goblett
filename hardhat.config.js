require('@nomicfoundation/hardhat-toolbox');

// The live election contracts are the Foundry project in dapp/.
// This config only builds the earlier yes/no demo kept in legacy/hardhat.
module.exports = {
  solidity: '0.8.28',
  paths: {
    sources: './contracts',
    tests: './legacy/hardhat/test',
    cache: './legacy/hardhat/cache',
    artifacts: './legacy/hardhat/artifacts'
  },
  networks: {
    hardhat: { chainId: 31337 },
    localhost: { url: 'http://127.0.0.1:8545', chainId: 31337 }
  }
};
