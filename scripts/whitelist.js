const { ethers } = require('hardhat');

async function main() {
  const wallet = process.env.WALLET;
  const contractAddress = process.env.CONTRACT;
  const electionIds = (process.env.ELECTIONS || '0,1').split(',').map((id) => id.trim()).filter(Boolean);
  if (!ethers.isAddress(wallet) || !ethers.isAddress(contractAddress) || !electionIds.length) {
    throw new Error('Set CONTRACT, WALLET, and optionally ELECTIONS=0,1.');
  }

  const voting = await ethers.getContractAt('Voting', contractAddress);
  for (const electionId of electionIds) {
    const tx = await voting.setWhitelist(electionId, wallet, true);
    await tx.wait();
    console.log('Whitelisted', wallet, 'for', await voting.electionName(electionId));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
