// Shared by the server functions in api/: JSON replies and the Supabase REST client.
// The Supabase secret key lives only in the functions' environment (Cloudflare settings,
// or site/.env for local dev) and never reaches the browser.

export const ADDRESS_RE = /^0x[0-9a-f]{40}$/

export const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } })

export function db(env, path, init = {}) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) throw new Error("server is missing SUPABASE_URL / SUPABASE_SECRET_KEY")
  return fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  })
}
