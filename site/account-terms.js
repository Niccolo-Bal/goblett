// What a wallet signs to set its username. Shared by the browser (accounts.js) and the
// server function (functions/api/account.js), so the two can't drift apart.
//
// EIP-712 typed data, so MetaMask shows the fields. The domain has no chainId on purpose:
// an account is not tied to a chain, and the wallet can sign on whatever network it is on.
//
// Some wallets only sign typed data whose domain names a chain (Circle's, used for email
// sign-in). For those the domain may carry a chainId as well, which the request then
// states; accountDomain() builds either form. Which chain it names changes nothing: the
// message is still this wallet choosing this username.
export const ACCOUNT_DOMAIN = { name: "goblett accounts", version: "1" }
export const accountDomain = (chainId) => (chainId == null ? ACCOUNT_DOMAIN : { ...ACCOUNT_DOMAIN, chainId })
export const ACCOUNT_TYPES = {
  Account: [
    { name: "wallet", type: "address" },
    { name: "username", type: "string" },
    { name: "issuedAt", type: "uint256" },
  ],
}
export const USERNAME_RE = /^[a-z0-9_]{3,20}$/
export const USERNAME_RULES = "3 to 20 characters: lowercase letters, digits and _"
// A signature is accepted only this long after it was made.
export const MAX_SIGNATURE_AGE_S = 600
