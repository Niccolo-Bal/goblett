<h1 ></h1>
<header>
  <h1 style="border-bottom: none;">Goblett.xyz: Seamless Private Voting</h1>
  <p class="subtitle">Made for UBC Hackathon 2026</p>
</header>

<br>

## Intro

Goblett is the first zero-trust on-chain voting system on Arc, using the [Semaphore Protocol](https://semaphore.pse.dev/) to 
mask on-chain identities and a first of its kind Web2 relay protocol that requires no trust or gas from registered wallets.

Every existing crypto voting system requires either some level of trust in a coordinator (GAMI), are straight-up just not anonymous
(Polymesh), or in the best case require voters to create burner wallets on every election and, to attain the level of anonymity of Goblett, fund that wallet through privacy cryptocurrencies (which voters hardly ever do).

Goblett cuts through all of these drawbacks by being USDC native, having no coordinator privileges, and relying only on wallet
signatures and locally stored secretes, while maintaining minimal drawbacks (see limitations + mitigants).

## Architecture

### Why not use wallets for semaphore secretes?