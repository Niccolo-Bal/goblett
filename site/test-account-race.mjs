// R4-4 regression: /api/account writes are conditional on signed_at, so an older
// signature can't win a race. Real handler; Supabase replaced by an in-memory table that
// applies PATCH filters and insert conflicts atomically, as Postgres does.
//   node test-account-race.mjs
import { Wallet } from "ethers"
import { onRequest } from "./functions/api/account.js"
import { ACCOUNT_DOMAIN, ACCOUNT_TYPES } from "./account-terms.js"

const rows = new Map()
const tick = () => new Promise((r) => setTimeout(r, 5))
const reply = (status, body) => new Response(JSON.stringify(body), { status })
const taken = (row) => [...rows.values()].some((r) => r.username === row.username && r.address !== row.address)
globalThis.fetch = async (url, init = {}) => {
  await tick() // let concurrent requests interleave between round trips
  const q = new URL(url).searchParams
  const method = init.method ?? "GET"
  const addr = q.get("address")?.replace(/^eq\./, "")
  if (method === "GET") return reply(200, [...rows.values()].filter((r) => !addr || r.address === addr))
  const body = JSON.parse(init.body)
  if (method === "PATCH") {
    const lt = Number(q.get("signed_at").replace(/^lt\./, ""))
    const cur = rows.get(addr)
    if (!cur || !(cur.signed_at < lt)) return reply(200, [])
    const next = { ...cur, ...body }
    if (taken(next)) return reply(409, { code: "23505" })
    rows.set(addr, next)
    return reply(200, [next])
  }
  if (rows.has(body.address) || taken(body)) return reply(409, { code: "23505" })
  rows.set(body.address, body)
  return reply(201, [body])
}
const env = { SUPABASE_URL: "http://db.test", SUPABASE_SECRET_KEY: "test" }
let failures = 0
const check = (ok, msg) => { if (!ok) failures++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${msg}`) }
const post = async (body) => (await onRequest({ request: new Request("http://site.test/api/account", { method: "POST", body: JSON.stringify(body) }), env })).status
const now = () => Math.floor(Date.now() / 1000)
const signed = async (w, username, issuedAt) => ({
  wallet: w.address, username, issuedAt,
  signature: await w.signTypedData(ACCOUNT_DOMAIN, ACCOUNT_TYPES, { wallet: w.address.toLowerCase(), username, issuedAt }),
})
const alice = Wallet.createRandom(), bob = Wallet.createRandom()
const a = alice.address.toLowerCase(), b = bob.address.toLowerCase()

const s1 = await signed(alice, "alice", now() - 20)
check((await post(s1)) === 200, "first claim inserts")
check((await post(s1)) === 409, "exact replay rejected")
const s2 = await signed(alice, "alice_two", now() - 10)
check((await post(s2)) === 200 && rows.get(a).username === "alice_two", "newer signature renames")
check((await post(s1)) === 409 && rows.get(a).username === "alice_two", "older signature rejected after rename")

for (let i = 0; i < 20; i++) {
  rows.delete(b)
  const old = await signed(bob, "bob_old", now() - 30), neu = await signed(bob, "bob_new", now() - 15)
  await post(await signed(bob, "bob_base", now() - 40))
  await Promise.all(i % 2 ? [post(old), post(neu)] : [post(neu), post(old)])
  if (rows.get(b).username !== "bob_new") { check(false, `race ${i}: older signature won`); break }
}
check(rows.get(b).username === "bob_new", "20 concurrent old/new races: newest signature always wins")
check((await post(await signed(bob, "alice_two", now()))) === 409, "taken username rejected")
console.log(failures ? `${failures} FAILED` : "all passed")
process.exit(failures ? 1 : 0)
