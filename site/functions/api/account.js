// Cloudflare Pages Function: /api/account. The only code that touches the database.
//
//   GET  /api/account?addresses=0x..,0x..      -> { accounts: [{ address, username }] }
//   GET  /api/account?usernames=alice,bob      -> same
//   POST /api/account { wallet, username, issuedAt, signature, chainId? }  -> { address, username }
//
// A username is public and so is its wallet address; reading needs no login. Writing
// needs a fresh EIP-712 signature from the wallet itself (account-terms.js), checked here.
// The Supabase secret key lives only in this function's environment (Cloudflare Pages
// settings, or site/.env for local dev) and never reaches the browser.
//
// Accounts are deliberately unrelated to voting: this endpoint is used when connecting a
// wallet and when creating an election, never when casting a vote.

import { verifyTypedData } from "ethers"
import { ACCOUNT_TYPES, MAX_SIGNATURE_AGE_S, USERNAME_RE, USERNAME_RULES, accountDomain } from "../../account-terms.js"
import { ADDRESS_RE, db, json } from "../db.js"

const MAX_LOOKUP = 100

// PostgREST answers 404 when the table itself is missing (the SQL was never run).
const dbError = (r) =>
  json(502, { error: r.status === 404 ? "the accounts table does not exist yet: run site/supabase/accounts.sql in Supabase" : "database error" })

// Comma-separated list from the query string, lowercased, every item matching `re`.
function list(value, re) {
  const items = [...new Set((value ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean))]
  if (!items.length || items.length > MAX_LOOKUP || !items.every((x) => re.test(x))) return null
  return items
}

async function lookup(request, env) {
  const q = new URL(request.url).searchParams
  const addresses = list(q.get("addresses"), ADDRESS_RE)
  const usernames = list(q.get("usernames"), USERNAME_RE)
  if (!addresses && !usernames) return json(400, { error: `pass addresses= or usernames= (up to ${MAX_LOOKUP}, comma-separated)` })
  // Items were validated against strict patterns above, so they are safe inside the filter.
  const filter = addresses ? `address=in.(${addresses.join(",")})` : `username=in.(${usernames.join(",")})`
  const r = await db(env, `accounts?select=address,username&${filter}`)
  if (!r.ok) return dbError(r)
  return json(200, { accounts: await r.json() })
}

async function claim(request, env) {
  let body
  try {
    body = await request.json()
  } catch {
    return json(400, { error: "body must be JSON" })
  }
  const wallet = String(body?.wallet ?? "").toLowerCase()
  const username = String(body?.username ?? "")
  const issuedAt = Number(body?.issuedAt)
  const signature = String(body?.signature ?? "")
  // Present when the wallet signed under a domain that names a chain (account-terms.js).
  const chainId = body?.chainId == null ? undefined : Number(body.chainId)
  if (chainId !== undefined && !(Number.isSafeInteger(chainId) && chainId > 0)) return json(400, { error: "chainId must be a chain id" })
  if (!ADDRESS_RE.test(wallet)) return json(400, { error: "wallet must be an address" })
  if (!USERNAME_RE.test(username)) return json(400, { error: `a username is ${USERNAME_RULES}` })
  const now = Math.floor(Date.now() / 1000)
  if (!Number.isInteger(issuedAt) || issuedAt > now + 60 || issuedAt < now - MAX_SIGNATURE_AGE_S) {
    return json(400, { error: "that signature is too old (or your clock is off); sign again" })
  }

  // The wallet itself must have signed exactly (wallet, username, issuedAt).
  let signer
  try {
    signer = verifyTypedData(accountDomain(chainId), ACCOUNT_TYPES, { wallet, username, issuedAt }, signature).toLowerCase()
  } catch {
    return json(400, { error: "malformed signature" })
  }
  if (signer !== wallet) return json(403, { error: "the signature is not from that wallet" })

  // Only a newer signature than the stored one may change the row (stops replays of an
  // older one). The check is part of each write, not a read before it, so two requests
  // racing can't let the older signature land last (R4-4).
  const row = { username, signed_at: issuedAt, updated_at: new Date().toISOString() }
  const rep = { "Content-Type": "application/json", Prefer: "return=representation" }
  const upd = await db(env, `accounts?address=eq.${wallet}&signed_at=lt.${issuedAt}`, { method: "PATCH", headers: rep, body: JSON.stringify(row) })
  if (upd.status === 409) return json(409, { error: `"${username}" is already taken` })
  if (!upd.ok) return dbError(upd)
  if (!(await upd.json()).length) {
    // No row newer-than-stored to update: either the wallet has no row yet, or it has a
    // row signed at or after issuedAt. A plain insert (no merge) decides atomically.
    const ins = await db(env, "accounts", { method: "POST", headers: rep, body: JSON.stringify({ address: wallet, ...row }) })
    if (ins.status === 409) {
      const cur = await db(env, `accounts?select=address&address=eq.${wallet}`)
      if (!cur.ok) return dbError(cur)
      if ((await cur.json()).length) return json(409, { error: "a newer signature was already used; sign again" })
      return json(409, { error: `"${username}" is already taken` })
    }
    if (!ins.ok) return dbError(ins)
  }
  return json(200, { address: wallet, username })
}

export async function onRequest({ request, env }) {
  try {
    if (request.method === "GET") return await lookup(request, env)
    if (request.method === "POST") return await claim(request, env)
    return json(405, { error: "method not allowed" })
  } catch (e) {
    return json(500, { error: e.message })
  }
}
