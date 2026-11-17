<header>
  <h1 style="border-bottom: none;">Goblett.xyz: Seamless Private Voting</h1>
  <p class="subtitle">Made for UBC Hackathon 2026</p>
</header>

<br>

## Intro

Goblett is the first zero-trust on-chain voting system on Arc, using the [Semaphore Protocol](https://semaphore.pse.dev/) 
and OHTTPS to mask on and off-chain identities and a first of its kind Web2 relay protocol that requires no trust or gas from 
registered wallets.

Every existing crypto voting system requires either some level of trust in a coordinator (GAMI), are straight-up just not anonymous
(Polymesh), or in the best case require voters to create burner wallets on every election and, to attain the level of anonymity of Goblett, fund that wallet through privacy cryptocurrencies (which voters hardly ever do).

Goblett cuts through all of these drawbacks by being USDC native, having no coordinator privileges, and relying only on wallet
signatures and locally stored secretes, while maintaining minimal drawbacks (see limitations + mitigants).

## Core Architecture

<center>
<img src="media/Goblett%20Diagram.png" alt="A sleeping orange cat">
</center>

### Why not use wallets for semaphore secretes?

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

### OHTTP Not Truely Oblivious

The current OHTTP setup uses the built-in Cloudflare OHTTP relay system which, though it is reportedly self-audited, means that
Cloudflare could pair the IP + unencrypted messages.

The fix for this would be to run our own decrypter, and have 3rd party (or many) run the OHTTP. Though this requires trust that
there is no collusion, and opens up the possibility for the OHTTP host to not forward unwanted IPs. This could be solved by allowing 
anyone to run an OHTTP, which would work at scale.

## Grok Bot Usage (for SpaceXSI Bounty)