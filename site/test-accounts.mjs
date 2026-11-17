// Tests for functions/api/account.js with the database replaced by an in-memory table.
//   node test-accounts.mjs
// Checks who may set a username (only the wallet itself, with a fresh signature) and lookups.

import { Wallet } from "ethers"
import { onRequest } from "./functions/api/account.js"
import { ACCOUNT_DOMAIN, ACCOUNT_TYPES } from "./account-terms.js"

// --- a tiny stand-in for the Supabase REST API (only the calls the function makes) ---
const rows = new Map() // address -> row
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url)
  const reply = (status, body) => new Response(JSON.stringify(body), { status })
  if ((init.method ?? "GET") === "GET") {
    const pick = (key, val) => {
      const m = /^(eq|in)\.\(?([^)]*)\)?$/.exec(val)
      const wanted = m[2].split(",")
      return [...rows.values()].filter((r) => wanted.includes(String(r[key])))
    }
    for (const key of ["address", "username"]) if (u.searchParams.has(key)) return reply(200, pick(key, u.searchParams.get(key)))
    return reply(200, [...rows.values()])
  }
  // PATCH applies its address/signed_at filters; POST is a plain insert. Unique username.
  const body = JSON.parse(init.body)
  const clash = (row) => [...rows.values()].some((r) => r.username === row.username && r.address !== row.address)
  if (init.method === "PATCH") {
    const addr = u.searchParams.get("address").replace(/^eq\./, "")
    const lt = Number(u.searchParams.get("signed_at").replace(/^lt\./, ""))
    const cur = rows.get(addr)
    if (!cur || !(Number(cur.signed_at) < lt)) return reply(200, [])
    const next = { ...cur, ...body }
    if (clash(next)) return reply(409, { code: "23505" })
    rows.set(addr, next)
    return reply(200, [next])
  }
  if (rows.has(body.address) || clash(body)) return reply(409, { code: "23505" })
  rows.set(body.address, body)
  return reply(201, [body])
}
const env = { SUPABASE_URL: "http://db.test", SUPABASE_SECRET_KEY: "test" }

let failures = 0
const check = (ok, msg) => {
  if (!ok) failures++
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${msg}`)
}
const call = async (method, query = "", body) => {
  const r = await onRequest({ request: new Request(`http://site.test/api/account${query}`, { method, body: body && JSON.stringify(body) }), env })
  return { status: r.status, ...(await r.json()) }
}
const now = () => Math.floor(Date.now() / 1000)
const signed = async (signer, wallet, username, issuedAt = now()) => ({
  wallet,
  username,
  issuedAt,
  signature: await signer.signTypedData(ACCOUNT_DOMAIN, ACCOUNT_TYPES, { wallet: wallet.toLowerCase(), username, issuedAt }),
})

const alice = Wallet.createRandom()
const bob = Wallet.createRandom()

let r = await call("POST", "", await signed(alice, alice.address, "alice"))
check(r.status === 200 && r.username === "alice" && r.address === alice.address.toLowerCase(), "a wallet sets its own username")

r = await call("POST", "", await signed(bob, alice.address, "mallory"))
check(r.status === 403, "another wallet cannot set it (signature from the wrong key)")

const forged = await signed(alice, alice.address, "alice2")
r = await call("POST", "", { ...forged, username: "evil" })
check(r.status === 403, "changing the username after signing is rejected")

r = await call("POST", "", await signed(bob, bob.address, "alice"))
check(r.status === 409 && /taken/.test(r.error), "a username already in use is refused")

r = await call("POST", "", await signed(bob, bob.address, "Bob!"))
check(r.status === 400, "invalid characters are refused")

r = await call("POST", "", await signed(bob, bob.address, "bob", now() - 3600))
check(r.status === 400 && /too old/.test(r.error), "an hour-old signature is refused")

const first = await signed(bob, bob.address, "bob", now() - 5)
r = await call("POST", "", first)
check(r.status === 200, "bob sets his username")
r = await call("POST", "", await signed(bob, bob.address, "robert", now()))
check(r.status === 200 && r.username === "robert", "and can change it with a newer signature")
r = await call("POST", "", first)
check(r.status === 409 && rows.get(bob.address.toLowerCase()).username === "robert", "replaying the older signature does not change it back")

r = await call("GET", `?usernames=alice,robert,nobody`)
check(r.status === 200 && r.accounts.length === 2, "lookup by usernames returns the ones that exist")
r = await call("GET", `?addresses=${alice.address},${bob.address}`)
check(r.status === 200 && r.accounts.find((a) => a.address === alice.address.toLowerCase())?.username === "alice", "lookup by addresses (any letter case)")
r = await call("GET", `?usernames=alice);drop`)
check(r.status === 400, "a malformed lookup is refused before reaching the database")
r = await call("DELETE")
check(r.status === 405, "other methods are refused")

console.log(failures ? `${failures} FAILURE(S)` : "ALL PASSED")
process.exit(failures ? 1 : 0)
