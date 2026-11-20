// The election list behind /api/elections: which elections whitelist a wallet. The server
// checks every entry against the chain before storing it (functions/api/elections.js).
// Like accounts, nothing here is called while a vote is being cast.

const MAX_VOTERS = 200 // per request, as in the server function

async function api(path, init) {
  const r = await fetch(`/api/elections${path}`, init)
  const body = await r.json().catch(() => ({ error: `election list unavailable (HTTP ${r.status})` }))
  if (!r.ok) throw new Error(body.error ?? `election list error (HTTP ${r.status})`)
  return body
}

/// Elections on `chainId` that whitelist `wallet` or that it created, soonest to end first.
/// Each is { address, title, kind, registrationEnd, votingStart, votingEnd, whitelisted, created }.
export async function electionsFor(chainId, wallet) {
  return (await api(`?chainId=${chainId}&wallet=${wallet.toLowerCase()}`)).elections
}

/// List an election and `voters` (addresses it whitelists) so it shows up for them.
export async function listElection(chainId, address, voters) {
  for (let i = 0; i === 0 || i < voters.length; i += MAX_VOTERS) {
    await api("", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chainId, address, voters: voters.slice(i, i + MAX_VOTERS) }) })
  }
}
