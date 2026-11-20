// Accounts: a public username for a wallet address, kept in a small database behind
// /api/account. Used for display and for whitelisting voters by name. It has nothing to do
// with voting, and nothing here is called while a vote is being cast.

import { ACCOUNT_TYPES, USERNAME_RE, USERNAME_RULES, accountDomain } from "./account-terms.js"

export { USERNAME_RE, USERNAME_RULES }

async function api(path, init) {
  const r = await fetch(`/api/account${path}`, init)
  const body = await r.json().catch(() => ({ error: `account service unavailable (HTTP ${r.status})` }))
  if (!r.ok) throw new Error(body.error ?? `account service error (HTTP ${r.status})`)
  return body
}

/// Usernames for addresses. Returns a Map of lowercase address -> username.
export async function usernamesOf(addresses) {
  if (!addresses.length) return new Map()
  const { accounts } = await api(`?addresses=${addresses.map((a) => a.toLowerCase()).join(",")}`)
  return new Map(accounts.map((a) => [a.address, a.username]))
}

/// Addresses for usernames. Returns a Map of username -> lowercase address.
export async function addressesOf(usernames) {
  if (!usernames.length) return new Map()
  const { accounts } = await api(`?usernames=${usernames.join(",")}`)
  return new Map(accounts.map((a) => [a.username, a.address]))
}

/// Set (or change) the username of `wallet`. The wallet signs the request; `eth` is the
/// EIP-1193 provider (MetaMask).
export async function claimUsername(eth, wallet, username) {
  if (!USERNAME_RE.test(username)) throw new Error(`a username is ${USERNAME_RULES}`)
  const message = { wallet: wallet.toLowerCase(), username, issuedAt: Math.floor(Date.now() / 1000) }
  // A Circle wallet (email sign-in) only signs data that names its chain; see account-terms.js.
  const chainId = eth.isCircle ? Number(await eth.request({ method: "eth_chainId" })) : undefined
  const typed = {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        ...(chainId == null ? [] : [{ name: "chainId", type: "uint256" }]),
      ],
      ...ACCOUNT_TYPES,
    },
    domain: accountDomain(chainId),
    primaryType: "Account",
    message,
  }
  const signature = await eth.request({ method: "eth_signTypedData_v4", params: [wallet.toLowerCase(), JSON.stringify(typed)] })
  return api("", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...message, chainId, signature }) })
}
