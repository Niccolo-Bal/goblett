// Is the code at an address one of goblett's election contracts? Shared by the browser
// (main.js) and the server function that lists elections (functions/api/elections.js).
// contracts.json holds both election types as exported by relayer/setup_chain.py.

import CONTRACTS from "./contracts.json" with { type: "json" }

const KINDS = ["fptp", "ranked"].filter((k) => CONTRACTS[k]?.deployedBytecode)

// Immutables (set by the constructor) differ per deployment, so they are zeroed before comparing.
function maskImmutables(hex, refs) {
  const s = hex.toLowerCase().split("")
  for (const list of Object.values(refs ?? {})) for (const r of list) s.fill("0", 2 + 2 * r.start, 2 + 2 * (r.start + r.length))
  return s.join("")
}
const TEMPLATES = Object.fromEntries(KINDS.map((k) => [k, maskImmutables(CONTRACTS[k].deployedBytecode, CONTRACTS[k].immutableReferences)]))

/// "fptp" or "ranked" when `code` (runtime bytecode, 0x hex) is that contract, else null.
export function matchKind(code) {
  if (typeof code !== "string") return null
  for (const k of KINDS) {
    if (code.length === TEMPLATES[k].length && maskImmutables(code, CONTRACTS[k].immutableReferences) === TEMPLATES[k]) return k
  }
  return null
}
