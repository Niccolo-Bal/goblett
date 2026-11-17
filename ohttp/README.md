# goblett OHTTP relay and gateway

Oblivious HTTP (RFC 9458) hides a voter's IP address from the Nostr relays and the chain
RPC. The browser encrypts each request to the **gateway's** key and posts it to the
**relay**:

```
browser --(ciphertext)--> relay --(ciphertext)--> gateway --> Nostr relays / chain RPC
          sees the IP,             sees the content,
          not the content          not the IP
```

Neither can alter a registration or a vote (those are authorized by the wallet signature
and the Semaphore proof). The privacy holds only while the relay and the gateway don't
pool what they know, so they should be run by different parties.

| Piece | File | Runs on |
|---|---|---|
| Relay | `relay/worker.js` | Cloudflare Worker (`relay/wrangler.jsonc`) |
| Gateway | `gateway/handler.js` | Cloudflare Worker (`gateway/worker.js`) or Node (`gateway/server.mjs`) |
| Client | `../site/ohttp.js` | the browser; configured by `site/public/ohttp.json` |

The gateway is not an open proxy. A decrypted request must be `POST /publish` (a signed
goblett Nostr event, kind 9467, for a chain it serves) or `POST /rpc/<chainId>`
(read-only JSON-RPC: `eth_call`, `eth_getCode`, `eth_chainId`, `eth_blockNumber`,
`eth_getBlockByNumber`).

## Current deployment

- Relay: `https://relay.goblett.xyz/` (Worker `goblett-ohttp-relay`)
- Gateway: `https://gateway.goblett.xyz/` (Worker `goblett-ohttp-gateway`), serving Arc
  mainnet (5042) and testnet (5042002)
- Logging is off on both. The gateway key's seed is the Worker secret `OHTTP_SEED`
  (a copy is in the gitignored `ohttp/.env`).

## Set up

```bash
npm install
node keygen.mjs        # prints OHTTP_SEED (secret, for the gateway) and the public keyConfig
```

1. **Gateway.** Either on your own server (keeps the key away from the relay's host):
   put `OHTTP_SEED` in `ohttp/.env` (see `.env.example`), run `node gateway/server.mjs`,
   and expose it over HTTPS. Or as a Worker: `cd gateway && npx wrangler deploy && npx
   wrangler secret put OHTTP_SEED`.
2. **Relay.** Set `GATEWAY_URL` in `relay/wrangler.jsonc` to the gateway's URL, then
   `cd relay && npx wrangler deploy`.
3. **Site.** Create `site/public/ohttp.json` and redeploy the site:
   ```json
   { "relayUrl": "https://relay.goblett.xyz/", "keyConfig": "<the public keyConfig>" }
   ```
   A built site requires that file: if it is missing or broken the site stops instead of
   talking to the Nostr relays directly (only the Vite dev server runs without it). With
   it, registrations, votes and the voter-specific chain reads go through the relay.

`node test.mjs` checks the encryption round trip and the relay's and gateway's rules.

## Limits (say these openly)

- **One operator.** If the same party runs (or hosts) both the relay and the gateway, it
  can match senders to messages. Hosting both on Cloudflare hides voters' addresses from
  the Nostr relays and the RPC, not from Cloudflare or from us.
- **Location metadata on Cloudflare.** Checked on the live deployment: the gateway never
  receives the sender's IP (it sees Cloudflare's own Worker address), but because both
  Workers run on Cloudflare, the gateway's request carries Cloudflare's `request.cf`
  data about the original sender: city, postal code, and network (ISP or organization).
  Our gateway code never reads it and logging is off, but a gateway operator could. A
  gateway outside Cloudflare does not get `request.cf` (check what headers it does get).
- **Timing.** The relay sees that an address sent something; the vote appears on-chain
  seconds later. With few voters that correlation is strong. Not mitigated yet (a random
  delay or batching at the gateway would help).
- **Other requests.** The page itself, the proof's circuit files (fetched at page load) and the ordinary
  election reads still come from the voter's own address. They don't say which vote is
  theirs, but they show that this address was using the site at that time.
- **Key rotation.** One key, derived from `OHTTP_SEED`. Changing it means updating
  `ohttp.json` and redeploying the site; old pages fail until reloaded.
- **Abuse.** The relay limits each address (the `LIMITER` binding, 60 requests a minute)
  and adds a shared secret (`RELAY_TOKEN`, set on both Workers) that the gateway requires,
  so nobody can skip the limit by calling the gateway directly. Until both secrets are
  set, anyone can use the gateway as a free read-only Arc RPC and a goblett-event publisher,
  and a flood could get its address rate-limited by the RPC or the Nostr relays, which
  stops every voter, since the site no longer falls back to a direct connection.
