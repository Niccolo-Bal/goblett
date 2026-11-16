const fs = require('fs');
const path = require('path');
const hre = require('hardhat');
const { ballots } = require('./ballots');

async function main() {
  const contract = await hre.ethers.deployContract('VoteLedger', [
    ballots.map((ballot) => ballot.section),
    ballots.map((ballot) => ballot.name),
    ballots.map((ballot) => ballot.mode),
    ballots.map((ballot) => ballot.options)
  ]);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  const payload = JSON.stringify({ address }, null, 2) + '\n';
  fs.writeFileSync(path.join(__dirname, '..', 'contracts', 'vote-ledger.json'), payload);
  fs.writeFileSync(path.join(__dirname, '..', 'site', 'vote-ledger.json'), payload);
  console.log('VoteLedger', address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
