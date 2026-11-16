const fs = require('fs');
const http = require('http');
const path = require('path');
const { ethers } = require('ethers');
const { votePayload } = require('./voteMessage');
const { electionsFor, assertWhitelisted } = require('./elections');
const { publishNostr, nostrAccount } = require('./nostr');
const { settleVote } = require('./settle-vote');
const { commitVote } = require('./election-call');
const { encodeVotes } = require('./ballots');
const { assertCast } = require('./vote-signature');
const { loadEnv } = require('./arc-config');
const { resolveNetwork } = require('./networks');

// Public Hardhat development account #0. It is only used for the local node.
const HARDHAT_ACCOUNT_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
loadEnv();
const network = resolveNetwork();
const rpcUrl = process.env.RPC_URL || network.rpcUrl;
const privateKey = network.id === 'local' ? HARDHAT_ACCOUNT_0 : (process.env.RELAYER_PRIVATE_KEY || '');
const port = Number(process.env.RELAYER_PORT || 8787);

if (!privateKey) {
  console.error('Set RELAYER_PRIVATE_KEY to the account that pays gas.');
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(rpcUrl, network.chainId, { staticNetwork: true });
const relayer = new ethers.Wallet(privateKey, provider);
const abi = [
  'function ELECTION_COUNT() view returns (uint256)',
  'function QUESTIONS_PER_ELECTION() view returns (uint256)',
  'function electionName(uint256 electionId) view returns (string)',
  'function whitelisted(uint256 electionId, address voter) view returns (bool)',
  'function hasVoted(uint256 questionId, address voter) view returns (bool)',
  'function submitSignedVotes(address voter, uint256[] questionIds, bool[] choices, bytes signature)'
];

function send(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type'
  });
  response.end(payload);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(new Error('The request body is not valid JSON.'));
      }
    });
    request.on('error', reject);
  });
}

function batch(body) {
  const contractAddress = body.contract;
  const voter = body.voter;
  const questionIds = Array.isArray(body.questionIds) ? body.questionIds : null;
  const choices = Array.isArray(body.choices) ? body.choices : null;
  if (!ethers.isAddress(contractAddress) || !ethers.isAddress(voter) || !questionIds || !choices) {
    throw new Error('Include the contract, voter, question ids, and choices.');
  }
  if (!questionIds.length || questionIds.length !== choices.length) {
    throw new Error('The vote batch is empty or mismatched.');
  }
  return {
    contractAddress: ethers.getAddress(contractAddress),
    voter: ethers.getAddress(voter),
    questionIds,
    choices: choices.map((choice) => Boolean(choice))
  };
}

async function contractAt(contractAddress) {
  const code = await provider.getCode(contractAddress);
  if (code === '0x') throw new Error('No voting contract is deployed at that address on Hardhat.');
  return new ethers.Contract(contractAddress, abi, relayer);
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type'
    });
    response.end();
    return;
  }

  try {
    if (request.method === 'GET' && request.url === '/nostr') {
      send(response, 200, await nostrAccount());
      return;
    }

    if (request.method === 'GET' && request.url === '/info') {
      const network = await provider.getNetwork();
      send(response, 200, {
        chainId: network.chainId.toString(),
        relayer: relayer.address,
        nostr: await nostrAccount()
      });
      return;
    }

    if (request.method !== 'POST') {
      send(response, 404, { error: 'Not found.' });
      return;
    }

    const body = await readBody(request);

    if (request.url === '/nostr-vote') {
      const account = await nostrAccount();
      if (!body.nsec || body.nsec !== account.nsec) {
        send(response, 400, { error: 'The Nostr key does not match this relayer.' });
        return;
      }
      const votes = Array.isArray(body.votes) ? body.votes : [];
      const lines = ['Goblett vote'];
      const cleaned = [];
      votes.forEach((vote) => {
        const name = String(vote && vote.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        const choices = Array.isArray(vote && vote.choices) ? vote.choices : [];
        const picked = choices.map((choice) => String(choice).replace(/\s+/g, ' ').trim().slice(0, 80)).filter(Boolean);
        if (!name || !picked.length) return;
        cleaned.push({ name, choices: picked });
        lines.push(name + ': ' + picked.join(', '));
      });
      if (lines.length < 2) throw new Error('Select at least one answer.');
      if (!ethers.isAddress(body.voter) || typeof body.signature !== 'string' || !Array.isArray(body.merkleProof)) {
        throw new Error('Sign the vote with a wallet on the Merkle tree.');
      }
      const ledgerFile = path.join(__dirname, '..', 'contracts', 'vote-ledger.json');
      const allowFile = path.join(__dirname, '..', 'site', 'allowlist.json');
      if (!fs.existsSync(ledgerFile) || !fs.existsSync(allowFile)) {
        throw new Error('Deploy the vote ledger before recording a vote.');
      }
      const deployed = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
      const allowlist = JSON.parse(fs.readFileSync(allowFile, 'utf8'));
      if (!deployed.merkleRoot || deployed.merkleRoot.toLowerCase() !== String(allowlist.root).toLowerCase()) {
        throw new Error('The Merkle root does not match the vote ledger.');
      }
      const encoded = encodeVotes(cleaned);
      const network = await provider.getNetwork();
      const voter = assertCast(
        network.chainId,
        deployed.address,
        deployed.merkleRoot,
        body.voter,
        encoded.ballotIds,
        encoded.choiceCounts,
        encoded.choices,
        body.signature,
        body.merkleProof
      );
      const ledger = new ethers.Contract(deployed.address, ['function hasVoted(address) view returns (bool)'], provider);
      if (await ledger.hasVoted(voter)) throw new Error('This wallet already voted.');
      const note = lines.join('\n');
      const committed = await commitVote({
        votes: cleaned,
        voter: voter,
        signature: body.signature,
        merkleProof: body.merkleProof
      });
      let nostr = null;
      try {
        nostr = await publishNostr(note);
        console.log('Nostr vote', nostr.id, 'from', nostr.npub);
      } catch (error) {
        send(response, 200, {
          count: cleaned.length,
          voter: voter,
          recordTransaction: committed.transaction,
          nostrError: error.message
        });
        return;
      }
      const settlement = await settleVote({
        npub: account.npub,
        note,
        votes: cleaned,
        event: nostr.event,
        proof: body.proof || null,
        ranking: Array.isArray(body.ranking) ? body.ranking : null,
        election: body.election || null,
        voter: voter,
        signature: body.signature,
        merkleProof: body.merkleProof
      });
      if (settlement.chain.kind === 'fptp' || settlement.chain.kind === 'ranked') {
        console.log('Election vote', settlement.chain.kind, settlement.chain.transaction, 'on', settlement.chain.contract);
      }
      if (settlement.chain.reward) {
        console.log('Reward', settlement.chain.reward, 'paid to', settlement.chain.relayer, 'in', settlement.chain.transaction);
      }
      send(response, 200, {
        count: cleaned.length,
        nostr: { id: nostr.id, npub: nostr.npub, relays: nostr.relays },
        settlement
      });
      return;
    }

    if (request.url === '/elections') {
      if (!ethers.isAddress(body.contract) || !ethers.isAddress(body.voter)) {
        throw new Error('Include the contract and the wallet.');
      }
      const voting = await contractAt(ethers.getAddress(body.contract));
      const voter = ethers.getAddress(body.voter);
      const elections = await electionsFor(voting, voter);
      send(response, 200, {
        voter,
        elections: elections.filter((election) => election.whitelisted)
      });
      return;
    }

    const vote = batch(body);
    const voting = await contractAt(vote.contractAddress);
    const network = await provider.getNetwork();
    await assertWhitelisted(voting, vote.voter, vote.questionIds);

    if (request.url === '/prepare') {
      const questionIds = [];
      const choices = [];
      for (let i = 0; i < vote.questionIds.length; i++) {
        if (!(await voting.hasVoted(vote.questionIds[i], vote.voter))) {
          questionIds.push(vote.questionIds[i]);
          choices.push(vote.choices[i]);
        }
      }
      send(response, 200, { chainId: network.chainId.toString(), questionIds, choices });
      return;
    }

    if (request.url === '/relay') {
      const payload = votePayload(network.chainId, vote.contractAddress, vote.voter, vote.questionIds, vote.choices);
      const recovered = ethers.verifyMessage(ethers.getBytes(payload), body.signature);
      if (recovered.toLowerCase() !== vote.voter.toLowerCase()) {
        send(response, 400, { error: 'The signature does not match this wallet.' });
        return;
      }
      const transaction = await voting.submitSignedVotes(vote.voter, vote.questionIds, vote.choices, body.signature);
      const receipt = await transaction.wait();
      console.log('Relayed', vote.questionIds.length, 'votes for', vote.voter, 'in', receipt.hash);
      const answers = vote.questionIds.map((id, index) => id + ' ' + (vote.choices[index] ? 'yes' : 'no')).join(', ');
      const note = 'Goblett vote recorded for ' + vote.voter + '. ' + answers + '. Transaction ' + receipt.hash + '.';
      let nostr = null;
      try {
        nostr = await publishNostr(note);
        console.log('Nostr', nostr.id, 'from', nostr.npub, 'accepted by', nostr.relays.join(', '));
      } catch (error) {
        console.error('Nostr publish failed:', error.message);
      }
      send(response, 200, {
        transaction: receipt.hash,
        voter: vote.voter,
        count: vote.questionIds.length,
        nostr: nostr ? { id: nostr.id, npub: nostr.npub, relays: nostr.relays } : null
      });
      return;
    }

    send(response, 404, { error: 'Not found.' });
  } catch (error) {
    const message = error.shortMessage || error.reason || error.message || 'The relayer could not submit the vote.';
    send(response, 400, { error: message });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log('Goblett relayer listening on http://127.0.0.1:' + port);
  console.log('Submitting through', rpcUrl, 'as', relayer.address);
  publishNostr('Goblett relayer is online.')
    .then((nostr) => console.log('Nostr', nostr.id, 'from', nostr.npub, 'accepted by', nostr.relays.join(', ')))
    .catch((error) => console.error('Nostr publish failed:', error.message));
});
