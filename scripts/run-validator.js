const { ethers } = require('ethers');
const { loadEnv } = require('./arc-config');
const { encodeVotes } = require('./ballots');
const { voteHash } = require('./vote-signature');
const { publishNostr } = require('./nostr');
const { validateRelayedEvent } = require('./validate-nostr');
const { settleVote } = require('./settle-vote');
const { commitVote } = require('./election-call');
const { resolveNetwork } = require('./networks');

// Public Hardhat development account #1. Local node only.
const LOCAL_VOTER = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

function voterKey(network) {
  if (network.id === 'local') return LOCAL_VOTER;
  if (!process.env.TEST_VOTER_PRIVATE_KEY) {
    throw new Error('Set TEST_VOTER_PRIVATE_KEY. Deploying the network creates it.');
  }
  return process.env.TEST_VOTER_PRIVATE_KEY;
}

async function main() {
  loadEnv();
  const network = resolveNetwork();
  const provider = new ethers.JsonRpcProvider(network.rpcUrl, network.chainId, { staticNetwork: true });
  const remote = await provider.getNetwork();
  if (remote.chainId !== BigInt(network.chainId)) {
    throw new Error('The RPC chain id does not match ' + network.name + '.');
  }

  const deployed = require('../contracts/vote-ledger.json');
  const allowlist = require('../site/allowlist.json');
  if (!deployed.merkleRoot || deployed.merkleRoot.toLowerCase() !== String(allowlist.root).toLowerCase()) {
    throw new Error('The Merkle root does not match the vote ledger.');
  }

  const voter = new ethers.Wallet(voterKey(network), provider);
  const proof = allowlist.proofs[voter.address.toLowerCase()];
  if (!proof) throw new Error(voter.address + ' is not on the Merkle tree.');

  const ledger = new ethers.Contract(deployed.address, [
    'function hasVoted(address) view returns (bool)',
    'function voteCount() view returns (uint256)',
    'function vote(uint256) view returns (bytes32 eventId, address voter, uint8 ballotId, uint256[] choices)'
  ], provider);
  if (await ledger.hasVoted(voter.address)) {
    throw new Error(voter.address + ' already voted on ' + network.name + '.');
  }

  const votes = [{ name: 'Prop B', choices: ['Yes'] }];
  const encoded = encodeVotes(votes);
  const hash = voteHash(
    network.chainId,
    deployed.address,
    deployed.merkleRoot,
    voter.address,
    encoded.ballotIds,
    encoded.choiceCounts,
    encoded.choices
  );
  const signature = await voter.signMessage(ethers.getBytes(hash));
  const note = 'Goblett vote\nProp B: Yes';
  const nostr = await publishNostr(note);
  const validation = await validateRelayedEvent(nostr.event, { pubkey: nostr.event.pubkey, note: note });
  if (validation.eventId !== nostr.id) throw new Error('The validator returned a different event.');

  const committed = await commitVote({
    votes: votes,
    voter: voter.address,
    signature: signature,
    merkleProof: proof
  });
  const settlement = await settleVote({
    npub: nostr.npub,
    note: note,
    votes: votes,
    event: nostr.event,
    voter: voter.address,
    signature: signature,
    merkleProof: proof
  });

  let second = '';
  try {
    const other = encodeVotes([{ name: 'Prop A', choices: ['No'] }]);
    const otherHash = voteHash(
      network.chainId,
      deployed.address,
      deployed.merkleRoot,
      voter.address,
      other.ballotIds,
      other.choiceCounts,
      other.choices
    );
    const otherSignature = await voter.signMessage(ethers.getBytes(otherHash));
    await commitVote({
      votes: [{ name: 'Prop A', choices: ['No'] }],
      voter: voter.address,
      signature: otherSignature,
      merkleProof: proof
    });
    second = 'accepted';
  } catch (error) {
    second = error.shortMessage || error.message;
  }
  if (!/already voted/i.test(second)) throw new Error('A second vote was not rejected: ' + second);
  if (!(await ledger.hasVoted(voter.address))) throw new Error('The ledger did not record the vote.');

  const count = await ledger.voteCount();
  const stored = await ledger.vote(count - 1n);
  if (stored.voter.toLowerCase() !== voter.address.toLowerCase() || Number(stored.ballotId) !== 1 || stored.choices.map(Number).join(',') !== '0') {
    throw new Error('The stored vote does not match the signed ballot.');
  }
  console.log(network.name);
  console.log('Validator accepted', validation.eventId);
  console.log('VoteLedger', deployed.address);
  console.log('Recorded', committed.transaction);
  console.log('Voter', voter.address, 'ballot', stored.ballotId.toString(), 'choice', stored.choices.map((choice) => choice.toString()).join(','));
  console.log('Reward', settlement.chain.reward || 'unpaid', settlement.chain.transaction || '');
  console.log('Second vote rejected');
  if (network.explorerUrl && committed.transaction) {
    console.log(network.explorerUrl + '/tx/' + committed.transaction);
  }
}

main().catch((error) => {
  console.error(error.shortMessage || error.message);
  process.exit(1);
});
