const { expect } = require('chai');
const { ethers } = require('hardhat');
const { votePayload } = require('../scripts/voteMessage');
const { electionsFor } = require('../scripts/elections');

async function signedBatch(voting, voter, questionIds, choices, chainId) {
  const network = await ethers.provider.getNetwork();
  const payload = votePayload(
    chainId === undefined ? network.chainId : chainId,
    await voting.getAddress(),
    voter.address,
    questionIds,
    choices
  );
  const signature = await voter.signMessage(ethers.getBytes(payload));
  return { payload, signature };
}

describe('signed votes through a relayer', function () {
  async function deploy() {
    const [relayer, voter, other] = await ethers.getSigners();
    const voting = await ethers.deployContract('Voting');
    return { relayer, voter, other, voting };
  }

  async function allow(voting, owner, voter, electionId) {
    await voting.connect(owner).setWhitelist(electionId, voter.address, true);
  }

  it('reads the elections a wallet is whitelisted for from the chain', async function () {
    const { relayer, voter, other, voting } = await deploy();
    await allow(voting, relayer, voter, 0);

    const allowed = await electionsFor(voting, voter.address);
    expect(allowed.filter((election) => election.whitelisted).map((election) => election.name)).to.deep.equal(['State']);
    expect(await voting.whitelisted(1, voter.address)).to.equal(false);

    const none = await electionsFor(voting, other.address);
    expect(none.filter((election) => election.whitelisted)).to.deep.equal([]);

    await expect(voting.connect(voter).setWhitelist(1, voter.address, true))
      .to.be.revertedWithCustomError(voting, 'NotOwner');
  });

  it('rejects a vote in an election the wallet is not whitelisted for', async function () {
    const { relayer, voter, voting } = await deploy();
    await allow(voting, relayer, voter, 0);
    const questionIds = [4];
    const choices = [true];
    const { signature } = await signedBatch(voting, voter, questionIds, choices);

    await expect(
      voting.connect(relayer).submitSignedVotes(voter.address, questionIds, choices, signature)
    ).to.be.revertedWithCustomError(voting, 'NotWhitelisted').withArgs(1, voter.address);
  });

  it('credits the signer when another account submits the signature', async function () {
    const { relayer, voter, voting } = await deploy();
    await allow(voting, relayer, voter, 0);
    const questionIds = [0, 1];
    const choices = [true, false];
    const { signature } = await signedBatch(voting, voter, questionIds, choices);

    await expect(voting.connect(relayer).submitSignedVotes(voter.address, questionIds, choices, signature))
      .to.emit(voting, 'VoteCast')
      .withArgs(0, voter.address, true);

    expect(await voting.yesVotes(0)).to.equal(1n);
    expect(await voting.noVotes(1)).to.equal(1n);
    expect(await voting.hasVoted(0, voter.address)).to.equal(true);
    expect(await voting.hasVoted(0, relayer.address)).to.equal(false);
  });

  it('rejects a signature for a different chain and a second submission', async function () {
    const { relayer, voter, voting } = await deploy();
    await allow(voting, relayer, voter, 0);
    const questionIds = [2];
    const choices = [true];
    const network = await ethers.provider.getNetwork();
    const wrongChain = await signedBatch(voting, voter, questionIds, choices, network.chainId + 1n);

    await expect(
      voting.connect(relayer).submitSignedVotes(voter.address, questionIds, choices, wrongChain.signature)
    ).to.be.revertedWithCustomError(voting, 'InvalidSignature');

    const { signature } = await signedBatch(voting, voter, questionIds, choices);
    await voting.connect(relayer).submitSignedVotes(voter.address, questionIds, choices, signature);
    await expect(
      voting.connect(relayer).submitSignedVotes(voter.address, questionIds, choices, signature)
    ).to.be.revertedWithCustomError(voting, 'AlreadyVoted').withArgs(2, voter.address);
  });

  it('rejects a signature from a different wallet', async function () {
    const { relayer, voter, other, voting } = await deploy();
    const questionIds = [3];
    const choices = [false];
    const { signature } = await signedBatch(voting, other, questionIds, choices);

    await expect(
      voting.connect(relayer).submitSignedVotes(voter.address, questionIds, choices, signature)
    ).to.be.revertedWithCustomError(voting, 'InvalidSignature');
  });

  it('still accepts a vote sent directly by the voter', async function () {
    const { relayer, voter, voting } = await deploy();
    await allow(voting, relayer, voter, 1);
    await voting.connect(voter).submitVotes([4], [true]);
    expect(await voting.yesVotes(4)).to.equal(1n);
    expect(await voting.hasVoted(4, voter.address)).to.equal(true);
  });
});
