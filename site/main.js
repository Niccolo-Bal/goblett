// goblet minimal front-end.
//
// Registration: MetaMask signs EIP-712 Register(wallet, commitment); the relayer
// submits registerFor. Voting: the browser builds a Semaphore proof and posts it
// (no wallet, no cookies) to the relayer, which submits vote().
//
// The identity secret lives only in this browser's localStorage. It never goes to
// the relayer: the server would otherwise be able to compute your nullifier
// (deanonymize you) and vote as you.

import { ethers } from "ethers"
import { Identity } from "@semaphore-protocol/identity"
import { Group } from "@semaphore-protocol/group"
import { generateProof } from "@semaphore-protocol/proof"

const RELAYER = import.meta.env.VITE_RELAYER_URL || "http://localhost:8787"

const ABI = [
  "function title() view returns (string)",
  "function candidates() view returns (string[])",
  "function phase() view returns (string)",
  "function registrationEnd() view returns (uint256)",
  "function votingStart() view returns (uint256)",
  "function votingEnd() view returns (uint256)",
  "function minAnonymitySet() view returns (uint256)",
  "function registeredCount() view returns (uint256)",
  "function totalVotes() view returns (uint256)",
  "function scope() view returns (uint256)",
  "function isWhitelisted(address) view returns (bool)",
  "function hasRegistered(address) view returns (bool)",
  "function nullifierUsed(uint256) view returns (bool)",
  "function tally() view returns (uint256[])",
  "function winners() view returns (uint256[])",
  "event Registered(address indexed wallet, uint256 identityCommitment)",
]

const $ = (id) => document.getElementById(id)
const log = (msg) => {
  $("log").textContent = `${new Date().toLocaleTimeString()}  ${msg}\n` + $("log").textContent
}
const setStatus = (id, msg, cls = "") => {
  $(id).innerHTML = msg ? `<p class="${cls}">${msg}</p>` : ""
}

let cfg, provider, election, account, state
let ranking = [] // ranked elections: candidate indices in preference order

// ---------------------------------------------------------------------------
// Identity storage (per election, per wallet; local only)
// ---------------------------------------------------------------------------
const idPrefix = () => `goblet:id:${cfg.chainId}:${cfg.election.toLowerCase()}:`
function saveIdentity(label, identity) {
  localStorage.setItem(idPrefix() + label.toLowerCase(), identity.export())
}
function loadIdentities() {
  const out = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k.startsWith(idPrefix())) out.push({ label: k.slice(idPrefix().length), identity: Identity.import(localStorage.getItem(k)) })
  }
  return out
}
const votedKey = (commitment) => `goblet:voted:${cfg.election.toLowerCase()}:${commitment}`

// ---------------------------------------------------------------------------
// Chain reads
// ---------------------------------------------------------------------------
async function init() {
  try {
    cfg = await (await fetch(`${RELAYER}/config`)).json()
  } catch {
    $("title").textContent = `Relayer not reachable at ${RELAYER} (retrying…)`
    return setTimeout(init, 3000)
  }
  const net = ethers.Network.from(cfg.chainId)
  provider = new ethers.JsonRpcProvider(cfg.rpcUrl, net, { staticNetwork: net, cacheTimeout: -1 })
  election = new ethers.Contract(cfg.election, ABI, provider)
  await refresh()
  setInterval(refresh, 5000)
}

// Show chain errors (node down, no contract at the address) instead of failing silently.
async function refresh() {
  try {
    await _refresh()
  } catch (e) {
    const code = provider && (await provider.getCode(cfg.election).catch(() => null))
    $("title").textContent =
      code === null ? `Chain RPC not reachable at ${cfg.rpcUrl}` : code === "0x" ? `No election contract at ${cfg.election}. Redeploy, then reload.` : `Error: ${errMsg(e)}`
  }
}

async function _refresh() {
  const [title, cands, phase, regEnd, vStart, vEnd, minAnon, regCount, total, tally, block] = await Promise.all([
    election.title(),
    election.candidates(),
    election.phase(),
    election.registrationEnd(),
    election.votingStart(),
    election.votingEnd(),
    election.minAnonymitySet(),
    election.registeredCount(),
    election.totalVotes(),
    election.tally(),
    provider.getBlock("latest"),
  ])
  const firstLoad = !state
  state = { title, cands, phase, regEnd, vStart, vEnd, minAnon, regCount, total, tally }
  if (account) {
    ;[state.whitelisted, state.registered] = await Promise.all([election.isWhitelisted(account), election.hasRegistered(account)])
  }
  const t = (s) => new Date(Number(s) * 1000).toLocaleString()

  $("title").textContent = title
  $("info").innerHTML = `
    <dt>Type</dt><dd>${cfg.kind === "ranked" ? "Ranked choice (instant runoff)" : "First past the post"}</dd>
    <dt>Phase</dt><dd><b>${phase}</b></dd>
    <dt>Chain time</dt><dd>${t(block.timestamp)}</dd>
    <dt>Registration until</dt><dd>${t(regEnd)}</dd>
    <dt>Voting</dt><dd>${t(vStart)} → ${t(vEnd)}</dd>
    <dt>Registered</dt><dd>${regCount} (voting needs ≥ ${minAnon})</dd>
    <dt>Election</dt><dd>${cfg.election} (chain ${cfg.chainId})</dd>`

  renderRegister()
  renderIdentities()
  if (firstLoad) renderBallot()
  renderResults()
  updateVoteButton()
}

// ---------------------------------------------------------------------------
// Wallet + registration
// ---------------------------------------------------------------------------
// Find MetaMask specifically (EIP-6963). With several wallet extensions installed,
// window.ethereum may belong to another one, which then rejects our requests.
const wallets = []
window.addEventListener("eip6963:announceProvider", (ev) => wallets.push(ev.detail))
window.dispatchEvent(new Event("eip6963:requestProvider"))
let eth // the EIP-1193 provider we talk to

async function connect() {
  const mm = wallets.find((w) => w.info.rdns === "io.metamask") ?? wallets.find((w) => w.info.rdns?.startsWith("io.metamask"))
  eth = mm?.provider ?? window.ethereum
  if (!eth) return log("MetaMask not found")
  log(`using wallet: ${mm ? mm.info.name : "window.ethereum"}${wallets.length > 1 ? ` (found ${wallets.map((w) => w.info.name).join(", ")})` : ""}`)
  const [acc] = await eth.request({ method: "eth_requestAccounts" })
  account = ethers.getAddress(acc)
  $("account").textContent = account
  eth.on?.("accountsChanged", (accs) => {
    account = accs[0] ? ethers.getAddress(accs[0]) : undefined
    $("account").textContent = account ?? "not connected"
    refresh()
  })
  await refresh()
}

// MetaMask grants accounts per site (and per network in newer versions). Check that
// the account we're about to sign with is still authorized; if not, ask again.
async function ensureAccountAuthorized() {
  const authorized = async () => (await eth.request({ method: "eth_accounts" })).map((a) => a.toLowerCase())
  if ((await authorized()).includes(account.toLowerCase())) return
  await eth.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] })
  if (!(await authorized()).includes(account.toLowerCase())) {
    throw new Error(`MetaMask hasn't authorized ${account} for this site. In MetaMask, open the site connections for localhost:5173, connect this account (and the goblet test network), then retry.`)
  }
}

// MetaMask refuses to sign typed data whose domain chainId differs from the active chain.
async function ensureChain() {
  const want = BigInt(cfg.chainId)
  const active = async () => BigInt(await eth.request({ method: "eth_chainId" }))
  if ((await active()) === want) return
  const hex = "0x" + want.toString(16)
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] })
  } catch (e) {
    // 4902 = chain unknown to the wallet (some versions nest it in data.originalError).
    const code = e.code ?? e.data?.originalError?.code
    if (code !== 4902 && code !== -32603) throw e
    await eth.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId: hex, chainName: `goblet test chain ${cfg.chainId}`, rpcUrls: [cfg.rpcUrl], nativeCurrency: { name: "Test", symbol: "TEST", decimals: 18 } }],
    })
  }
  const now = await active()
  if (now !== want) throw new Error(`MetaMask is on chain ${now}, but this election is on chain ${want}. Switch network in MetaMask and retry.`)
}

// Raw MetaMask errors are {code, message}; ethers errors have shortMessage + a nested cause.
const errMsg = (e) => e?.error?.message ?? e?.info?.error?.message ?? e?.shortMessage ?? e?.message ?? String(e)

function renderRegister() {
  const btn = $("registerBtn")
  btn.disabled = true
  if (!account) return setStatus("regStatus", "Connect MetaMask to register.", "hint")
  if (state.phase !== "registration") return setStatus("regStatus", `Registration is closed (phase: ${state.phase}).`, "hint")
  if (!state.whitelisted) return setStatus("regStatus", `${account} is not on this election's whitelist.`, "err")
  if (state.registered) {
    const local = loadIdentities().some((x) => x.label === account.toLowerCase())
    return setStatus(
      "regStatus",
      local ? "✓ Registered. Your identity is stored in this browser." : "This wallet is registered, but its identity is not in this browser. Import the secret to vote.",
      local ? "ok" : "err"
    )
  }
  setStatus("regStatus", "")
  btn.disabled = false
}

async function register() {
  $("registerBtn").disabled = true
  let step = "switch network"
  try {
    await ensureChain()
    step = "check account permission"
    await ensureAccountAuthorized()
    step = "prepare identity"
    // Reuse an unsubmitted identity for this wallet: re-signing a new commitment
    // would leave the old signature valid too (registerFor has no nonce).
    let identity = loadIdentities().find((x) => x.label === account.toLowerCase())?.identity
    if (!identity) {
      identity = new Identity()
      saveIdentity(account, identity)
    }
    const domain = { name: "goblet Election", version: "1", chainId: cfg.chainId, verifyingContract: cfg.election }
    const types = { Register: [{ name: "wallet", type: "address" }, { name: "identityCommitment", type: "uint256" }] }
    const value = { wallet: account, identityCommitment: identity.commitment }
    // Ask MetaMask directly (not via ethers' signer) so its own error message reaches the page.
    const payload = ethers.TypedDataEncoder.getPayload(domain, types, value)
    setStatus("regStatus", "Sign the registration in MetaMask…", "muted")
    step = "sign (eth_signTypedData_v4)"
    const sign = () => eth.request({ method: "eth_signTypedData_v4", params: [account.toLowerCase(), JSON.stringify(payload)] })
    let signature
    try {
      signature = await sign()
    } catch (e) {
      if (e.code !== 4100) throw e
      // Unauthorized: ask MetaMask to re-grant this site's permissions, then retry once.
      step = "re-request permissions after 4100"
      await eth.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] })
      step = "sign again after re-granting"
      signature = await sign()
    }
    step = "verify signature / send to relayer"
    // Double-check locally before bothering the relayer.
    if (ethers.verifyTypedData(domain, types, value, signature) !== account) throw new Error("signature does not match the connected wallet")
    setStatus("regStatus", "Sending to relayer…", "muted")
    const res = await post("/register", { wallet: account, identityCommitment: identity.commitment.toString(), signature })
    if (!res.ok) throw new Error(res.error)
    log(`registered, tx ${res.txHash}`)
    await refresh()
  } catch (e) {
    console.error(e)
    setStatus("regStatus", `Registration failed at step "${step}": ${errMsg(e)}`, "err")
    $("registerBtn").disabled = false
    await walletDiagnostics(e, step)
  }
}

// Dump what the wallet reports, to debug failures like 4100 (unauthorized).
async function walletDiagnostics(err, step) {
  const ask = (method) => eth.request({ method }).catch((e) => `error ${e.code}: ${e.message}`)
  const perms = await ask("wallet_getPermissions")
  const d = {
    step,
    errorCode: err?.code,
    errorMessage: errMsg(err),
    errorData: err?.data,
    wallet: wallets.find((w) => w.provider === eth)?.info.name ?? "window.ethereum (not via EIP-6963)",
    walletsFound: wallets.map((w) => `${w.info.name} (${w.info.rdns})`),
    isMetaMask: !!eth?.isMetaMask,
    otherFlags: Object.keys(eth ?? {}).filter((k) => /^is[A-Z]/.test(k) && eth[k] === true),
    siteAccount: account,
    eth_chainId: await ask("eth_chainId"),
    eth_accounts: await ask("eth_accounts"),
    permissions: Array.isArray(perms) ? perms.map((p) => ({ method: p.parentCapability, caveats: p.caveats })) : perms,
    electionChainId: cfg.chainId,
  }
  log("DIAGNOSTICS (copy this):\n" + JSON.stringify(d, null, 2))
}

// ---------------------------------------------------------------------------
// Voting
// ---------------------------------------------------------------------------
function renderIdentities() {
  const sel = $("identitySel")
  const prev = sel.value
  const ids = loadIdentities()
  sel.innerHTML = ids.length
    ? ids.map((x) => `<option value="${x.label}">${x.label.startsWith("0x") ? "registered by " + x.label.slice(0, 10) + "…" : x.label}</option>`).join("")
    : `<option value="">(no identity in this browser)</option>`
  if (ids.some((x) => x.label === prev)) sel.value = prev
}

function renderBallot() {
  const box = $("ballot")
  if (cfg.kind === "ranked") {
    box.innerHTML =
      `<p class="muted">Click candidates in order of preference (you may stop early).</p>` +
      state.cands.map((c, i) => `<label><input type="checkbox" data-i="${i}" /> <span class="rank" id="rank${i}"></span>${esc(c)}</label>`).join("")
    box.querySelectorAll("input").forEach((el) =>
      el.addEventListener("change", () => {
        const i = Number(el.dataset.i)
        ranking = el.checked ? [...ranking, i] : ranking.filter((x) => x !== i)
        state.cands.forEach((_, j) => ($(`rank${j}`).textContent = ranking.includes(j) ? ranking.indexOf(j) + 1 : ""))
        updateVoteButton()
      })
    )
  } else {
    box.innerHTML = state.cands.map((c, i) => `<label><input type="radio" name="cand" value="${i}" /> ${esc(c)}</label>`).join("")
    box.querySelectorAll("input").forEach((el) => el.addEventListener("change", updateVoteButton))
  }
}

function selectedBallot() {
  if (cfg.kind === "ranked") return ranking.length ? ranking : null
  const el = document.querySelector('input[name="cand"]:checked')
  return el ? Number(el.value) : null
}

// Explain why the vote button is disabled, unless a vote result is being shown.
let voteResultShown = false
function updateVoteButton() {
  const why =
    state.phase !== "voting"
      ? `Voting is not open (phase: ${state.phase}).`
      : state.regCount < state.minAnon
        ? `Too few registrations (${state.regCount} of ${state.minAnon} needed).`
        : !$("identitySel").value
          ? "No identity for this election in this browser. Register first, or import your secret."
          : selectedBallot() === null
            ? "Pick a candidate."
            : ""
  $("voteBtn").disabled = !!why
  if (!voteResultShown) setStatus("voteStatus", why, "hint")
}

// Same encoding as RankedChoiceElection.packRanking: byte i = ranking[i] + 1.
const pack = (r) => r.reduce((acc, c, i) => acc | (BigInt(c + 1) << BigInt(8 * i)), 0n)

async function vote() {
  $("voteBtn").disabled = true
  try {
    const { identity } = loadIdentities().find((x) => x.label === $("identitySel").value)
    if (localStorage.getItem(votedKey(identity.commitment))) {
      if (!confirm("This identity already voted from this browser. A second vote will be rejected. Continue?")) return
    }
    voteResultShown = true
    setStatus("voteStatus", "Rebuilding the voter group from on-chain registrations…", "muted")
    const events = await election.queryFilter(election.filters.Registered(), cfg.deployBlock)
    const group = new Group(events.map((e) => e.args.identityCommitment))
    if (group.indexOf(identity.commitment) < 0) throw new Error("this identity is not registered in this election")

    const ballot = selectedBallot()
    const message = cfg.kind === "ranked" ? pack(ballot) : BigInt(ballot)
    const scope = await election.scope()
    setStatus("voteStatus", `Generating zero-knowledge proof (${group.size} registered)… first time downloads the circuit, ~10-30 s`, "muted")
    const proof = await generateProof(identity, group, message, scope)

    setStatus("voteStatus", "Sending proof to relayer…", "muted")
    const body = { proof: { ...proof, points: proof.points.map(String) } }
    if (cfg.kind === "ranked") body.ranking = ballot
    const res = await post("/vote", body)
    if (!res.ok) throw new Error(res.error)

    // Don't trust the relayer's answer: check the nullifier on-chain ourselves.
    const counted = await election.nullifierUsed(proof.nullifier)
    localStorage.setItem(votedKey(identity.commitment), "1")
    setStatus(
      "voteStatus",
      counted ? `✓ Vote counted. Nullifier ${short(proof.nullifier)} is marked used on-chain.` : "Relayer reported success but the nullifier isn't marked used yet. Refresh in a moment.",
      counted ? "ok" : "err"
    )
    log(`voted, tx ${res.txHash}`)
    await refresh()
  } catch (e) {
    setStatus("voteStatus", `Vote failed: ${errMsg(e)}`, "err")
  } finally {
    updateVoteButton()
  }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
async function renderResults() {
  const total = Number(state.total)
  const label = cfg.kind === "ranked" ? "first preferences" : "votes"
  let html = `<p class="muted">${total} vote(s). The live tally is public on-chain by design.</p>`
  state.cands.forEach((c, i) => {
    const n = Number(state.tally[i])
    html += `<div>${esc(c)}: ${n} ${label}</div><div class="bar" style="width:${total ? (100 * n) / total : 0}%"></div>`
  })
  if (state.phase === "ended") {
    try {
      const w = (await election.winners()).map((i) => state.cands[Number(i)])
      html += `<p><b>${w.length > 1 ? "Tie: " : "Winner: "}${w.map(esc).join(", ")}</b></p>`
    } catch (e) {
      html += `<p class="err">winners() failed: ${errMsg(e)}</p>`
    }
  }
  $("tally").innerHTML = html
}

// ---------------------------------------------------------------------------
// Helpers + wiring
// ---------------------------------------------------------------------------
async function post(path, body) {
  // credentials: "omit" so nothing (cookies etc.) ties the request to an account.
  const r = await fetch(RELAYER + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "omit",
    body: JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  })
  return r.json()
}
const short = (x) => String(x).slice(0, 10) + "…"
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

$("connect").onclick = () => connect().catch((e) => log(e.message))
$("registerBtn").onclick = register
$("voteBtn").onclick = vote
$("refresh").onclick = refresh
$("identitySel").onchange = () => {
  voteResultShown = false
  updateVoteButton()
}
$("exportBtn").onclick = () => {
  const x = loadIdentities().find((i) => i.label === $("identitySel").value)
  $("exported").textContent = x ? x.identity.export() : "no identity selected"
}
$("importBtn").onclick = () => {
  try {
    const identity = Identity.import($("importTxt").value.trim())
    saveIdentity(account ?? "imported-" + identity.commitment.toString().slice(0, 8), identity)
    $("importTxt").value = ""
    log(`imported identity ${short(identity.commitment)}`)
    refresh()
  } catch (e) {
    log(`import failed: ${e.message}`)
  }
}

init().catch((e) => log(e.message))
