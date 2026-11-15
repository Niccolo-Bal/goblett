const http = require('http');
const { ethers } = require('ethers');
const { votePayload } = require('./voteMessage');
const { electionsFor, assertWhitelisted } = require('./elections');

// Public Hardhat development account #0. It is only used for the local node.
const HARDHAT_ACCOUNT_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const rpcUrl = process.env.RPC_URL || 'http://127.0.0.1:8545';
const local = /127\.0\.0\.1|localhost/.test(rpcUrl);
const privateKey = process.env.RELAYER_PRIVATE_KEY || (local ? HARDHAT_ACCOUNT_0 : '');
const port = Number(process.env.RELAYER_PORT || 8787);

if (!privateKey) {
  console.error('Set RELAYER_PRIVATE_KEY to the account that pays gas.');
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(rpcUrl);
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
    if (request.method === 'GET' && request.url === '/info') {
      const network = await provider.getNetwork();
      send(response, 200, { chainId: network.chainId.toString(), relayer: relayer.address });
      return;
    }

    if (request.method !== 'POST') {
      send(response, 404, { error: 'Not found.' });
      return;
    }

    const body = await readBody(request);

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
      send(response, 200, { transaction: receipt.hash, voter: vote.voter, count: vote.questionIds.length });
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
});
