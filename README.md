<header>
  <h1 style="border-bottom: none;">Goblett: Seamless Private Voting</h1>
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

`goblett-<chainId>-<election address>`

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

Votes are signed, and cannot be modified without changing the proof, but contain the vote unencrypted. This means 
that if you can tie a voter to a vote (or to a specific time), you can tie them to who they voted for. GAMI and other
systems get around this by having a trusted party decrypt the votes and then publishing results with an sk-SNARK proof, 
and this solution or similar requires trust. However, tieing a voter to a vote is already a breach of security,
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
of the project that were not found initially by devs or coding agents (see `AUDIT_REPORT.md`).