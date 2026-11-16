// Goblett relayer.
//
// Anonymous by design: it only ever handles Semaphore proofs and ballots,
// never a wallet address or a wallet signature. Anyone can run it, because
// Election.vote() checks the proof itself; the relayer only pays gas.
//
// Votes arrive two ways:
//   1. POST /vote  { election, kind: "fptp" | "ranked", proof, ranking? }
//   2. Nostr notes tagged ["t", "goblett-vote:<chainId>:<election>"] whose
//      content is the same JSON. Voters post them with a throwaway key.
//
// Env: ARC_NETWORK, RPC_URL, RELAYER_PRIVATE_KEY, RELAYER_PORT,
//      RELAYER_ALLOWED_ORIGIN, GOBLETT_ELECTIONS (comma list), NOSTR_RELAYS.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { ethers } = require('ethers');
const { resolveNetwork } = require('./networks');

function loadEnv() {
  const file = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

// Public Hardhat/Anvil development account #0. Only used for the local node.
const HARDHAT_ACCOUNT_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const MAX_BODY_BYTES = 64 * 1024;

loadEnv();
const network = resolveNetwork();
const rpcUrl = process.env.RPC_URL || network.rpcUrl;
const privateKey = network.id === 'local' ? HARDHAT_ACCOUNT_0 : (process.env.RELAYER_PRIVATE_KEY || '');
const port = Number(process.env.RELAYER_PORT || 8787);
const allowedOrigin = process.env.RELAYER_ALLOWED_ORIGIN || 'http://localhost:8080';

if (!privateKey) {
  console.error('Set RELAYER_PRIVATE_KEY to the account that pays gas.');
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(rpcUrl, network.chainId, { staticNetwork: true });
const relayer = new ethers.Wallet(privateKey, provider);

const PROOF = 'tuple(uint256 merkleTreeDepth, uint256 merkleTreeRoot, uint256 nullifier, uint256 message, uint256 scope, uint256[8] points)';
const ABI = {
  fptp: ['function vote(' + PROOF + ' proof)', 'function nullifierUsed(uint256) view returns (bool)', 'function scope() view returns (uint256)'],
  ranked: ['function vote(' + PROOF + ' proof, uint256[] ranking)', 'function nullifierUsed(uint256) view returns (bool)', 'function scope() view returns (uint256)']
};

const inFlight = new Set();

function parseVote(body) {
  if (!body || typeof body !== 'object') throw new Error('Send a JSON vote.');
  if (!ethers.isAddress(body.election)) throw new Error('Include the election address.');
  if (body.kind !== 'fptp' && body.kind !== 'ranked') throw new Error('kind must be "fptp" or "ranked".');
  const p = body.proof || {};
  const fields = ['merkleTreeDepth', 'merkleTreeRoot', 'nullifier', 'message', 'scope'];
  const proof = {};
  for (const field of fields) proof[field] = BigInt(p[field]);
  if (!Array.isArray(p.points) || p.points.length !== 8) throw new Error('proof.points must have 8 values.');
  proof.points = p.points.map((x) => BigInt(x));
  let ranking = null;
  if (body.kind === 'ranked') {
    if (!Array.isArray(body.ranking) || body.ranking.length > 32) throw new Error('Include the ranking (at most 32 entries).');
    ranking = body.ranking.map((x) => BigInt(x));
  }
  return { election: ethers.getAddress(body.election), kind: body.kind, proof, ranking };
}

// Checks the vote with a free eth_call before paying gas, so junk costs us nothing.
async function submitVote(vote) {
  const key = vote.election + ':' + vote.proof.nullifier;
  if (inFlight.has(key)) throw new Error('This vote is already being submitted.');
  inFlight.add(key);
  try {
    const election = new ethers.Contract(vote.election, ABI[vote.kind], relayer);
    if (await election.nullifierUsed(vote.proof.nullifier)) throw new Error('This vote was already counted.');
    const args = vote.kind === 'ranked' ? [vote.proof, vote.ranking] : [vote.proof];
    await election.vote.staticCall(...args);
    const tx = await election.vote(...args);
    const receipt = await tx.wait();
    console.log('Vote relayed to', vote.election, 'in', receipt.hash);
    return { transaction: receipt.hash };
  } finally {
    inFlight.delete(key);
  }
}

function headers() {
  return {
    'content-type': 'application/json',
    'access-control-allow-origin': allowedOrigin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    vary: 'origin'
  };
}

function send(response, status, body) {
  response.writeHead(status, headers());
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('The request body is too large.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (error) {
        reject(new Error('The request body is not valid JSON.'));
      }
    });
    request.on('error', reject);
  });
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, headers());
    response.end();
    return;
  }
  try {
    if (request.method === 'GET' && request.url === '/info') {
      send(response, 200, { chainId: network.chainId.toString(), relayer: relayer.address });
      return;
    }
    if (request.method === 'POST' && request.url === '/vote') {
      const vote = parseVote(await readBody(request));
      send(response, 200, await submitVote(vote));
      return;
    }
    send(response, 404, { error: 'Not found.' });
  } catch (error) {
    const message = error.shortMessage || error.reason || error.message || 'The relayer could not submit the vote.';
    send(response, 400, { error: message });
  }
});

// Optional Nostr listener. Each election is watched under its own tag.
async function watchNostr() {
  const elections = (process.env.GOBLETT_ELECTIONS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!elections.length) return;
  const relays = (process.env.NOSTR_RELAYS || 'wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net').split(',');
  const { SimplePool } = require('nostr-tools/pool');
  const pool = new SimplePool();
  const tags = elections.map((address) => 'goblett-vote:' + network.chainId + ':' + ethers.getAddress(address).toLowerCase());
  pool.subscribeMany(relays, [{ kinds: [1], '#t': tags }], {
    onevent(event) {
      let vote;
      try {
        if (event.content.length > MAX_BODY_BYTES) return;
        vote = parseVote(JSON.parse(event.content));
        const tag = 'goblett-vote:' + network.chainId + ':' + vote.election.toLowerCase();
        if (!event.tags.some((t) => t[0] === 't' && t[1] === tag)) return;
      } catch (error) {
        return; // Not a well-formed vote; ignore it.
      }
      submitVote(vote).catch((error) => console.log('Skipped Nostr vote', event.id, '-', error.shortMessage || error.message));
    }
  });
  console.log('Watching Nostr for', tags.join(', '));
}

server.listen(port, '127.0.0.1', () => {
  console.log('Goblett relayer listening on http://127.0.0.1:' + port);
  console.log('Submitting through', rpcUrl, 'as', relayer.address);
  watchNostr().catch((error) => console.error('Nostr watch failed:', error.message));
});
