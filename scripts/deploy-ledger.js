const fs = require('fs');
const path = require('path');
const hre = require('hardhat');
const { ballots } = require('./ballots');
const { members } = require('./members');
const { buildTree } = require('./merkle');

async function main() {
  const tree = buildTree(members);
  const contract = await hre.ethers.deployContract('VoteLedger', [
    ballots.map((ballot) => ballot.section),
    ballots.map((ballot) => ballot.name),
    ballots.map((ballot) => ballot.mode),
    ballots.map((ballot) => ballot.options),
    tree.root
  ]);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  const payload = JSON.stringify({ address, merkleRoot: tree.root }, null, 2) + '\n';
  const allowlist = JSON.stringify({ root: tree.root, proofs: tree.proofs }, null, 2) + '\n';
  fs.writeFileSync(path.join(__dirname, '..', 'contracts', 'vote-ledger.json'), payload);
  fs.writeFileSync(path.join(__dirname, '..', 'site', 'vote-ledger.json'), payload);
  fs.writeFileSync(path.join(__dirname, '..', 'site', 'allowlist.json'), allowlist);
  console.log('VoteLedger', address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
