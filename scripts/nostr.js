const fs = require('fs');
const path = require('path');
const { loadEnv } = require('./arc-config');

const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];
const envFile = path.join(__dirname, '..', '.env');

let toolsPromise;

function relayUrls() {
  const configured = process.env.NOSTR_RELAYS;
  if (!configured) return DEFAULT_RELAYS.slice();
  const urls = configured.split(',').map((url) => url.trim()).filter(Boolean);
  if (!urls.length) throw new Error('NOSTR_RELAYS is empty.');
  return urls;
}

function loadTools() {
  if (!toolsPromise) {
    toolsPromise = (async () => {
      const pool = await import('nostr-tools/pool');
      const pure = await import('nostr-tools/pure');
      const nip19 = await import('nostr-tools/nip19');
      if (typeof WebSocket === 'undefined') throw new Error('This Node version has no WebSocket.');
      pool.useWebSocketImplementation(WebSocket);
      return { pool, pure, nip19 };
    })();
  }
  return toolsPromise;
}

function secretKeyBytes(encoded, nip19) {
  const value = encoded.trim();
  if (value.startsWith('nsec1')) {
    const decoded = nip19.decode(value);
    if (decoded.type !== 'nsec') throw new Error('NOSTR_PRIVATE_KEY is not an nsec.');
    return decoded.data;
  }
  const hex = value.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('NOSTR_PRIVATE_KEY must be an nsec or a 32-byte hex secret.');
  }
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

async function ensureSecret() {
  loadEnv(envFile);
  if (process.env.NOSTR_PRIVATE_KEY) return process.env.NOSTR_PRIVATE_KEY;
  const { pure, nip19 } = await loadTools();
  const secret = pure.generateSecretKey();
  const nsec = nip19.nsecEncode(secret);
  const prefix = fs.existsSync(envFile) && !fs.readFileSync(envFile, 'utf8').endsWith('\n') ? '\n' : '';
  fs.appendFileSync(envFile, prefix + 'NOSTR_PRIVATE_KEY=' + nsec + '\n');
  process.env.NOSTR_PRIVATE_KEY = nsec;
  return nsec;
}

function writeClientKey(account) {
  const file = path.join(__dirname, '..', 'site', 'nostr-key.js');
  fs.writeFileSync(file, 'window.GOBLETT_NOSTR=' + JSON.stringify(account) + ';\n');
}

async function nostrAccount() {
  const encoded = await ensureSecret();
  const { pure, nip19 } = await loadTools();
  const secret = secretKeyBytes(encoded, nip19);
  const account = {
    nsec: encoded.startsWith('nsec1') ? encoded : nip19.nsecEncode(secret),
    npub: nip19.npubEncode(pure.getPublicKey(secret)),
    relays: relayUrls()
  };
  writeClientKey(account);
  return account;
}

async function publishNostr(content) {
  const account = await nostrAccount();
  const { pool, pure, nip19 } = await loadTools();
  const secret = secretKeyBytes(account.nsec, nip19);
  const event = pure.finalizeEvent({
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['t', 'goblett']],
    content: String(content)
  }, secret);
  if (!pure.verifyEvent(event)) throw new Error('The Nostr event signature did not verify.');

  const urls = relayUrls();
  const publisher = new pool.SimplePool();
  const results = await Promise.all(urls.map(async (url) => {
    try {
      await Promise.race([
        Promise.any(publisher.publish([url], event)),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 10000))
      ]);
      return { url, ok: true };
    } catch (error) {
      const message = error && error.errors ? error.errors.map((item) => item.message).join('; ') : error.message;
      return { url, ok: false, error: message || 'rejected' };
    }
  }));
  publisher.close(urls);

  const accepted = results.filter((result) => result.ok).map((result) => result.url);
  if (!accepted.length) {
    throw new Error(results.map((result) => result.url + ': ' + result.error).join('; '));
  }
  return {
    id: event.id,
    npub: nip19.npubEncode(event.pubkey),
    pubkey: event.pubkey,
    relays: accepted,
    event
  };
}

async function fetchEvent(id, urls) {
  const { pool } = await loadTools();
  const reader = new pool.SimplePool();
  try {
    return await Promise.race([
      reader.get(urls && urls.length ? urls : relayUrls(), { ids: [id] }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('The relay read timed out.')), 10000))
    ]);
  } finally {
    reader.close(urls && urls.length ? urls : relayUrls());
  }
}

module.exports = { publishNostr, nostrAccount, fetchEvent, relayUrls };
