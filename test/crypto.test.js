const { expect } = require('chai');
const { ethers } = require('hardhat');
const { buildTree, verifyProof } = require('../scripts/merkle');
const { ballots } = require('../scripts/ballots');
const { voteHash, recoverRegistration } = require('../scripts/vote-signature');

const SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;

async function deploy(members) {
  const tree = buildTree(members);
  const ledger = await ethers.deployContract('VoteLedger', [
    ballots.map((ballot) => ballot.section),
    ballots.map((ballot) => ballot.name),
    ballots.map((ballot) => ballot.mode),
    ballots.map((ballot) => ballot.options),
    tree.root
  ]);
  await ledger.waitForDeployment();
  return { ledger, tree };
}

async function sign(signer, ledger, ids, counts, choices) {
  const voter = await signer.getAddress();
  const root = await ledger.merkleRoot();
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const hash = voteHash(chainId, await ledger.getAddress(), root, voter, ids, counts, choices);
  expect(hash).to.equal(await ledger.voteHash(voter, ids, counts, choices));
  return signer.signMessage(ethers.getBytes(hash));
}

describe('vote cryptography', function () {
  it('accepts a member proof and rejects every other address', function () {
    const members = [
      '0x253D8209D37C28c62932f7Cf644b608D53f1dDE4',
      '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
      '0x90F79bf6EB2c4f870365E785982E1f101E93b906'
    ];
    const tree = buildTree(members);
    members.forEach((address) => {
      expect(verifyProof(tree.root, address, tree.proofs[address.toLowerCase()])).to.equal(true);
    });
    expect(verifyProof(tree.root, '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65', tree.proofs[members[0].toLowerCase()])).to.equal(false);
    const tampered = tree.proofs[members[0].toLowerCase()].slice();
    tampered[0] = ethers.ZeroHash;
    expect(verifyProof(tree.root, members[0], tampered)).to.equal(false);
  });

  it('records one signed vote and rejects a second, a forgery, and a swapped choice', async function () {
    const [alice, bob, carol] = await ethers.getSigners();
    const members = [alice, bob].map((signer) => signer.address);
    const { ledger, tree } = await deploy(members);
    const ids = [0, 3];
    const counts = [1, 2];
    const choices = [0, 1, 0];
    const proof = tree.proofs[alice.address.toLowerCase()];
    const signature = await sign(alice, ledger, ids, counts, choices);
    const eventId = ethers.id('vote-1');
    const borrowed = await sign(bob, ledger, ids, counts, choices);
    await expect(ledger.record(ethers.id('vote-3'), alice.address, borrowed, proof, ids, counts, choices))
      .to.be.revertedWithCustomError(ledger, 'InvalidSignature');

    await ledger.record(eventId, alice.address, signature, proof, ids, counts, choices);
    expect(await ledger.hasVoted(alice.address)).to.equal(true);
    const first = await ledger.vote(0);
    const second = await ledger.vote(1);
    expect(first.voter).to.equal(alice.address);
    expect(second.voter).to.equal(alice.address);
    expect(first.choices.map(Number)).to.deep.equal([0]);
    expect(second.choices.map(Number)).to.deep.equal([1, 0]);

    const again = await sign(alice, ledger, [0], [1], [1]);
    await expect(ledger.record(ethers.id('vote-2'), alice.address, again, proof, [0], [1], [1]))
      .to.be.revertedWithCustomError(ledger, 'AlreadyVoted');

    const outsider = await sign(carol, ledger, ids, counts, choices);
    await expect(ledger.record(ethers.id('vote-4'), carol.address, outsider, proof, ids, counts, choices))
      .to.be.revertedWithCustomError(ledger, 'NotInTree');

    const bobProof = tree.proofs[bob.address.toLowerCase()];
    await expect(ledger.record(ethers.id('vote-5'), bob.address, borrowed, proof, ids, counts, choices))
      .to.be.revertedWithCustomError(ledger, 'NotInTree');
    await expect(ledger.record(ethers.id('vote-5b'), bob.address, borrowed, bobProof, ids, counts, [1, 1, 0]))
      .to.be.revertedWithCustomError(ledger, 'InvalidSignature');
    const parsed = ethers.Signature.from(borrowed);
    const malleable = ethers.concat([
      parsed.r,
      ethers.toBeHex(SECP256K1_N - BigInt(parsed.s), 32),
      parsed.v === 27 ? '0x1c' : '0x1b'
    ]);
    await expect(ledger.record(ethers.id('vote-6'), bob.address, malleable, bobProof, ids, counts, choices))
      .to.be.revertedWithCustomError(ledger, 'InvalidSignature');
  });

  it('binds the registration signature to the commitment that would enter the tree', async function () {
    const wallet = ethers.Wallet.createRandom();
    const election = ethers.Wallet.createRandom().address;
    const commitment = 42n;
    const signature = await wallet.signTypedData(
      { name: 'goblet Election', version: '1', chainId: 31337, verifyingContract: election },
      { Register: [{ name: 'wallet', type: 'address' }, { name: 'identityCommitment', type: 'uint256' }] },
      { wallet: wallet.address, identityCommitment: commitment }
    );
    expect(recoverRegistration(31337, election, wallet.address, commitment, signature)).to.equal(wallet.address);
    expect(recoverRegistration(31337, election, wallet.address, commitment + 1n, signature)).to.not.equal(wallet.address);
  });
});
