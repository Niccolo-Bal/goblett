<header>
  <h1 style="border-bottom: none;">Goblett: Seamless Private Voting</h1>
  <p class="subtitle">Made for UBC Hackathon 2026</p>
</header>

<br>

## Intro

[Goblett](https://goblett.xyz) is the first zero-trust on-chain voting system on Arc, using the [Semaphore Protocol](https://semaphore.pse.dev/) 
and OHTTPS to mask on and off-chain identities and a first of its kind Web2 relay protocol that requires no trust or gas from 
registered wallets.

Every existing crypto voting system requires either some level of trust in a coordinator (GAMI), are straight-up just not anonymous
(Polymesh), or in the best case require voters to create burner wallets on every election and, to attain the level of anonymity of Goblett, fund that wallet through privacy cryptocurrencies (which voters hardly ever do).

Goblett cuts through all of these drawbacks by being USDC native, having no coordinator privileges, and relying only on wallet
signatures and locally stored secretes, while maintaining minimal drawbacks (see limitations + mitigants).

## Core Architecture

### Semaphore

The Semaphore Protocol is a cryptographic protocol for masking group identity. Simply put, group members can send commitments
to Semaphore from their whitelisted addresses (or with some other open proof of membership), and then from another address
prove their membership to the group without revealing what commitment they know the secrete for. The technicals of it are 
explained quite succinctly [HERE](https://docs.semaphore.pse.dev/technical-reference/circuits).

### Goblett

The main limitation that comes with Semaphore is that though group membership is masked, the secondary wallet is fully traceable.
In the case of elections, this means it would be fairly easy to deduce which main wallet corresponds to which secondary one based off
IP and election overlap. To achieve complete anonymity, you would need to create and fund (secretely) a new burner wallet for every
election, and use Tor for any transactions from burner wallets.

Goblett kills two birds with one stone by having an oblivious funded relayer forward both registrations and votes to the on-chain 
election. The relayer listens to a [Nostr](https://nostr.org/) topic, so no Web2 endpoint needs to be trusted, and cannot modify
ballots without invalidating the proof. Additionally, anyone can set up a Goblett relayer, and is rewarded for doing so by receiving
refund of gas paid plus a bounty from the contract (which is funded upon creation).

<center>
<img src="media/Goblett%20Diagram.png" alt="A sleeping orange cat">
</center>

During the registration phase of a Goblett election, users sign a commitment hashed from their Semaphore secrete and send it
through an [OHTTP](https://en.wikipedia.org/wiki/Oblivious_HTTP)

### Semaphore deployments:

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; Arc testnet:  &nbsp; [0x78e50FBA810bb1496c8C1c5209F491AB1Aa8a743](
  https://explorer.testnet.arc.io/address/0x78e50FBA810bb1496c8C1c5209F491AB1Aa8a743)

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; Arc mainnet: [0x21F9ee5fbA61be8755E49eE7Cb7F679077429482](
  https://explorer.arc.io/address/0x21F9ee5fbA61be8755E49eE7Cb7F679077429482?tab=txs)

### Relayer Addresses: 

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; Arc testnet: &nbsp; [0x89D659eaA0Ff1E7527582D795bAaA4b43b168ee5](
  https://explorer.testnet.arc.io/address/0x89D659eaA0Ff1E7527582D795bAaA4b43b168ee5)

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; Arc mainnet: [0x89D659eaA0Ff1E7527582D795bAaA4b43b168ee5](
  https://explorer.arc.io/address/0x89D659eaA0Ff1E7527582D795bAaA4b43b168ee5)

### Why not use wallets for semaphore identities?

This seems appealing, as it removes the need for the registration period (commitments are addresses, secretes are private keys), and was
the initial idea for the project. However, Metamask and every other wallet has no native support for making semaphore proofs, only 
signatures (which tie to the address). So doing this would require users to copy their private keys directly onto the website, 
which is a huge security risk.

## Front-End Implementation

## Limitations + Mitigants

### Cannot Change Votes

This is the biggest structural issue. By having nullifiers, and allowing only allowing users to submit their vote once
(which is needed, since we cannot identify identities at vote time by construction). In most online voting systems,
this is seen as a necessity to avoid collusion. In reality, it doesn't impact anonymity or security at all, but is important to
note.

A workaround is to shorten the window for voting, and then have relayers or voters wait until that window till they actually input
their vote (which they placed in advance), which would have the same effect as allowing multiple votes in terms of avoiding collusion.
We chose not to take that approach for this hackathon.

### Nostr Opens Vulnerabilities

This is the only open vulnerability, and is a fairly weak one. Attackers could spam the topic with pointless messages or 
false proofs, leading to what could amount to many false expensive checks for relayers. Most Nostr nodes have some level
of IP or pubkey rate limit though, so the problem would largely fix itself. Though a coordinated attack is still a
possible risk (though this only impacts the Web2 portion of Goblett, the DApp would remain unaffected).

### Unencrypted Votes

Votes are signed, and cannot be modified without changing the proof, but contain the vote unencrypted. This means 
that if you can tie a voter to a vote (or to a specific time), you can tie them to who they voted for. GAMI and other
systems get around this by having a trusted party decrypt the votes and then publishing results with an sk-SNARK proof, 
but this solution and other similar ones require trust. However, tieing a voter to a vote is already a breach of security,
so for an airtight system, this doesn't arise as an issue.   

### OHTTP Not Truely Oblivious

The current OHTTP setup uses the built-in Cloudflare OHTTP relay system which, though it is reportedly self-audited, means that
Cloudflare could pair the IP + unencrypted messages.

The fix for this would be to have one party run the decrypter, and have 3rd party (or many) run the OHTTP. Though this requires trust
that there is no collusion, and opens up the possibility for the OHTTP host to not forward unwanted IPs. This could be solved by
allowing anyone to run an OHTTP or decrypter, which would work at scale.

## Grok Bot Usage (for SpaceXSI Bounty)

Grok Bot was used consistently throughout the project primarily to check for vulnerabilities. A team of three
specialist bots ("Red," "Blue," and "Scout") worked together to uncover several vulnerabilities at each step 
of the project that were not found initially by devs or coding agents. See `AUDIT_REPORT.md`.