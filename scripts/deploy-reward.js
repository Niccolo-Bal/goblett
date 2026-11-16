const fs = require('fs');
const path = require('path');
const hre = require('hardhat');

async function main() {
  const reward = hre.ethers.parseEther('0.01');
  const funding = hre.ethers.parseEther('1');
  const contract = await hre.ethers.deployContract('RelayReward', [reward], { value: funding });
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  const file = path.join(__dirname, '..', 'contracts', 'relay-reward.json');
  fs.writeFileSync(file, JSON.stringify({ address, reward: reward.toString() }, null, 2) + '\n');
  console.log('RelayReward', address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
