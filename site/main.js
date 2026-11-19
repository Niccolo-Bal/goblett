// goblett minimal front-end.
//
// Registration: MetaMask signs EIP-712 Register(wallet, commitment); the relayer
// submits registerFor. Voting: the browser builds a Semaphore proof and the relayer
// submits vote(). Both travel as Nostr events on the election's topic (nostr.js);
// the browser never talks to the relayer directly.
//
// The identity secret lives only in this browser's localStorage. It never goes to
// the relayer: the server would otherwise be able to compute your nullifier
// (deanonymize you) and vote as you.

import { ethers } from "ethers"
import { Identity } from "@semaphore-protocol/identity"
import { Group } from "@semaphore-protocol/group"
import { generateProof } from "@semaphore-protocol/proof"

import { publish, confirm } from "./nostr.js"
import { ohttp } from "./ohttp.js"
import { usernamesOf, addressesOf, claimUsername, USERNAME_RE, USERNAME_RULES } from "./accounts.js"
// ABI + creation bytecode of both election types, exported by relayer/setup_chain.py.
import CONTRACTS from "./contracts.json"

const maskImmutables = (hex, refs) => {
  const b = ethers.getBytes(hex)
  for (const list of Object.values(refs ?? {})) for (const r of list) b.fill(0, r.start, r.start + r.length)
  return ethers.hexlify(b)
}
const TEMPLATES = Object.fromEntries(
  ["fptp", "ranked"].filter((k) => CONTRACTS[k]?.deployedBytecode).map((k) => [k, maskImmutables(CONTRACTS[k].deployedBytecode, CONTRACTS[k].immutableReferences)])
)
const matchKind = (code) => {
  for (const [k, t] of Object.entries(TEMPLATES)) {
    if (code.length === t.length && maskImmutables(code, CONTRACTS[k].immutableReferences) === t) return k
  }
  return null
}

const ABI = [
  "function title() view returns (string)",
  "function MAX_CANDIDATES() view returns (uint256)",
  "function candidates() view returns (string[])",
  "function phase() view returns (string)",
  "function registrationEnd() view returns (uint256)",
  "function votingStart() view returns (uint256)",
  "function votingEnd() view returns (uint256)",
  "function minAnonymitySet() view returns (uint256)",
  "function registeredCount() view returns (uint256)",
  "function totalVotes() view returns (uint256)",
  "function scope() view returns (uint256)",
  "function semaphore() view returns (address)",
  "function isWhitelisted(address) view returns (bool)",
  "function hasRegistered(address) view returns (bool)",
  "function nullifierUsed(uint256) view returns (bool)",
  "function tally() view returns (uint256[])",
  "function winners() view returns (uint256[])",
  "function commitments() view returns (uint256[])",
  "function relayBounty() view returns (uint256)",
  "function maxRefundGasPrice() view returns (uint256)",
  "function relayFunds() view returns (uint256)",
  "function creator() view returns (address)",
  "function reclaim()",
]

const $ = (id) => document.getElementById(id)
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const log = (msg) => {
  $("log").textContent = `${new Date().toLocaleTimeString()}  ${msg}\n` + $("log").textContent
}
const setStatus = (id, msg, cls = "") => {
  // Escaped: messages can carry unauthenticated Nostr reply text or revert reasons (R3-3).
  $(id).innerHTML = msg ? `<p class="${esc(cls)}">${esc(msg)}</p>` : ""
}

let cfg, provider, election, account, state

// Chain reads that would give a voter away (is MY registration in? is MY nullifier used?)
// go through the OHTTP channel when the deployment has one, so the RPC operator sees the
// gateway's address instead of the voter's. Everything else uses the RPC directly.
class OhttpRpcProvider extends ethers.JsonRpcApiProvider {
  #channel
  #chainId
  constructor(channel, chainId) {
    const net = ethers.Network.from(chainId)
    super(net, { staticNetwork: net, cacheTimeout: -1 })
    this.#channel = channel
    this.#chainId = chainId
  }
  async _send(payload) {
    const res = await this.#channel(`/rpc/${this.#chainId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
    const out = await res.json()
    if (!res.ok) throw new Error(`private chain read failed: ${out.error ?? `HTTP ${res.status}`}`)
    return Array.isArray(out) ? out : [out]
  }
}

let privateReads // Promise of the election contract to use for voter-specific reads
function privateElection() {
  return (privateReads ??= ohttp().then((channel) => (channel ? election.connect(new OhttpRpcProvider(channel, cfg.chainId)) : election))).catch((e) => {
    privateReads = undefined
    throw new Error(`the private channel is unavailable (${errMsg(e)}). Not continuing over a direct connection.`)
  })
}
const REFRESH_MS = 10000 // each refresh is a dozen RPC calls; public RPCs rate-limit
let ranking = [] // ranked elections: candidate indices in preference order

// ---------------------------------------------------------------------------
// Identity storage (per election, per wallet; local only)
// ---------------------------------------------------------------------------
const idPrefix = () => `goblett:id:${cfg.chainId}:${cfg.election.toLowerCase()}:`
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
const votedKey = (commitment) => `goblett:voted:${cfg.election.toLowerCase()}:${commitment}`

// ---------------------------------------------------------------------------
// Chain reads
// ---------------------------------------------------------------------------
// "testnet" when the page is opened under /testnet, else null (the main network).
const NETWORK = location.pathname.split("/")[1] === "testnet" ? "testnet" : null

async function init() {
  try {
    // Public chain config (RPC, Semaphore address, Nostr relays), written by relayer/setup_chain.py.
    // The first path segment picks the network: / is the main one, /testnet reads
    // election.testnet.json. Same page and code either way.
    cfg = await (await fetch(`/election${NETWORK ? "." + NETWORK : ""}.json`, { cache: "no-store" })).json()
  } catch {
    setStatus("homeMsg", `This site isn't set up for ${NETWORK ? `/${NETWORK}` : "this network"} yet (run relayer/setup_chain.py, then reload).`, "err")
    return
  }
  $("brand").href = NETWORK ? `/${NETWORK}` : "/"
  if (NETWORK) {
    $("network").textContent = cfg.chainName ?? NETWORK
    $("network").hidden = false
  }
  const net = ethers.Network.from(cfg.chainId)
  provider = new ethers.JsonRpcProvider(cfg.rpcUrl, net, { staticNetwork: net, cacheTimeout: -1 })
  initCreateForm().catch((e) => log(errMsg(e)))

  // Which election? ?election=0x... in the URL, else the config's default (if any).
  const q = new URLSearchParams(location.search)
  const fromUrl = q.get("election")
  if (!fromUrl && !cfg.election) return
  try {
    if (fromUrl) cfg.election = ethers.getAddress(fromUrl)
    // Verify before rendering anything the contract returns (R3-6): its runtime code
    // must match our build with immutables masked, as in the relayer's lookup_election,
    // and it must use the configured Semaphore.
    const kind = matchKind(await provider.getCode(cfg.election))
    if (!kind) throw new Error("not a goblett election")
    const c = new ethers.Contract(cfg.election, ABI, provider)
    if (ethers.getAddress(await c.semaphore()) !== ethers.getAddress(cfg.semaphore)) throw new Error("unknown Semaphore")
    cfg.kind = kind
    election = c
  } catch (e) {
    setStatus("homeMsg", `That link doesn't point to a goblett election on ${cfg.chainName ?? "chain " + cfg.chainId}. Check the link you were sent, or start your own.`, "err")
    return
  }
  document.body.classList.add("has-election")
  prefetchProofArtifacts()
  await refresh()
  setInterval(refresh, REFRESH_MS)
}

// Show chain errors (node down, no contract at the address) instead of failing silently.
async function refresh() {
  if (!election) return
  try {
    await _refresh()
  } catch (e) {
    const code = provider && (await provider.getCode(cfg.election).catch(() => null))
    $("title").textContent =
      code === null ? `Chain RPC not reachable at ${cfg.rpcUrl}` : code === "0x" ? `No election contract at ${cfg.election}. Redeploy, then reload.` : `Error: ${errMsg(e)}`
  }
}

// Reads that name the connected wallet go over the private channel, once per wallet,
// not on every refresh over the direct RPC (R4-2). Cleared after registering.
let walletCache // { account, whitelisted, registered } or a pending Promise of it
function walletStatus(acc) {
  if (walletCache?.account === acc) return walletCache.status
  const status = privateElection()
    .then(async (priv) => {
      const [whitelisted, registered] = await Promise.all([priv.isWhitelisted(acc), priv.hasRegistered(acc)])
      return { whitelisted, registered, walletErr: undefined }
    })
    .catch((e) => {
      walletCache = undefined // retry next refresh
      return { whitelisted: undefined, registered: undefined, walletErr: errMsg(e) }
    })
  walletCache = { account: acc, status }
  return status
}

async function _refresh() {
  const [title, cands, phase, regEnd, vStart, vEnd, minAnon, regCount, total, tally, block, funds] = await Promise.all([
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
    election.relayFunds(),
  ])
  const firstLoad = !state
  // Fixed at deployment, so read once.
  const terms = state?.terms ?? { bounty: await election.relayBounty(), creator: await election.creator() }
  state = { title, cands, phase, regEnd, vStart, vEnd, minAnon, regCount, total, tally, funds, terms }
  if (account) Object.assign(state, await walletStatus(account))
  const t = (s) => new Date(Number(s) * 1000).toLocaleString()

  $("title").textContent = title
  $("info").innerHTML = `
    <dt>Type</dt><dd>${cfg.kind === "ranked" ? "Ranked choice (instant runoff)" : "First past the post"}</dd>
    <dt>Phase</dt><dd><b>${esc(phase)}</b></dd>
    <dt>Chain time</dt><dd>${t(block.timestamp)}</dd>
    <dt>Registration until</dt><dd>${t(regEnd)}</dd>
    <dt>Voting</dt><dd>${t(vStart)} → ${t(vEnd)}</dd>
    <dt>Registered</dt><dd>${regCount} (voting needs ≥ ${minAnon})</dd>
    <dt>Relayer funding</dt><dd>${fmt(funds)} left (bounty ${fmt(terms.bounty)} per registration/vote, plus gas)${funds === 0n ? ' <span class="err">— relayers may refuse to forward</span>' : ""}</dd>
    <dt>Election</dt><dd>${cfg.explorerUrl ? `<a href="${cfg.explorerUrl}/address/${cfg.election}" target="_blank" rel="noopener">${cfg.election}</a>` : cfg.election} (${esc(cfg.chainName ?? "chain " + cfg.chainId)})</dd>`
  $("reclaimBtn").hidden = !(phase === "ended" && funds > 0n)

  renderPhase(Number(block.timestamp))
  renderRegister()
  renderIdentities()
  renderKey()
  if (firstLoad) renderBallot()
  renderResults()
  updateVoteButton()
}

// "2 h 5 min", "3 d 4 h", "12 min": a rough countdown for the phase banner.
function until(secs) {
  if (secs <= 0) return "a moment"
  if (secs < 3600) return `${Math.max(1, Math.round(secs / 60))} min`
  const d = Math.floor(secs / 86400)
  const h = Math.floor((secs % 86400) / 3600)
  const m = Math.floor((secs % 3600) / 60)
  return d ? `${d} d ${h} h` : `${h} h ${m} min`
}

// The step bar and the "what can I do now" line. The page shows only the cards that
// matter in the current phase (style.css keys off body[data-phase]).
function renderPhase(now) {
  const { phase, regEnd, vStart, vEnd, regCount, minAnon } = state
  document.body.dataset.phase = phase
  const t = (s) => new Date(Number(s) * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
  const left = (end) => until(Number(end) - now)
  const current = { registration: 0, frozen: 1, voting: 1, ended: 2 }[phase] ?? 0
  const iRegistered = !!(account && state.registered) || loadIdentities().length > 0
  ;["stepRegister", "stepVote", "stepResults"].forEach((id, i) => {
    const done = i < current || (i === 0 && iRegistered)
    $(id).className = done ? "done" : i === current ? "current" : ""
    $(id).querySelector(".dot").textContent = i + 1
  })
  let head, sub
  if (phase === "registration") {
    head = iRegistered ? "You're registered." : "Registration is open."
    sub = `Registration closes in ${left(regEnd)} (${t(regEnd)}), and voting opens then.`
  } else if (phase === "frozen") {
    head = "Registration has closed."
    sub = `Voting opens in ${left(vStart)} (${t(vStart)}).`
  } else if (phase === "voting") {
    head = "Voting is open."
    sub = `Voting closes in ${left(vEnd)} (${t(vEnd)}).`
    if (regCount < minAnon) sub += ` Too few voters registered for votes to be accepted (${regCount} of ${minAnon} needed).`
  } else {
    head = "This election has ended."
    sub = `Voting closed on ${t(vEnd)}.`
  }
  $("phaseNow").innerHTML = `<b>${esc(head)}</b> <span class="muted">${esc(sub)}</span>`
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
  if (!eth) throw new Error("MetaMask wasn't found in this browser. Install it, then reload the page.")
  log(`using wallet: ${mm ? mm.info.name : "window.ethereum"}${wallets.length > 1 ? ` (found ${wallets.map((w) => w.info.name).join(", ")})` : ""}`)
  const [acc] = await eth.request({ method: "eth_requestAccounts" })
  account = ethers.getAddress(acc)
  resetAccount()
  eth.on?.("accountsChanged", (accs) => {
    account = accs[0] ? ethers.getAddress(accs[0]) : undefined
    resetAccount()
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
    throw new Error(`MetaMask hasn't authorized ${account} for this site. In MetaMask, open the site connections for localhost:5173, connect this account (and the goblett test network), then retry.`)
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
      params: [{
        chainId: hex,
        chainName: cfg.chainName ?? `chain ${cfg.chainId}`,
        rpcUrls: [cfg.rpcUrl],
        nativeCurrency: cfg.nativeCurrency ?? { name: "Native", symbol: "NATIVE", decimals: 18 },
        ...(cfg.explorerUrl ? { blockExplorerUrls: [cfg.explorerUrl] } : {}),
      }],
    })
  }
  const now = await active()
  if (now !== want) throw new Error(`MetaMask is on chain ${now}, but this election is on chain ${want}. Switch network in MetaMask and retry.`)
}

// Raw MetaMask errors are {code, message}; ethers errors have shortMessage + a nested cause.
const errMsg = (e) => e?.error?.message ?? e?.info?.error?.message ?? e?.shortMessage ?? e?.message ?? String(e)

function renderRegister() {
  const btn = $("registerBtn")
  if (registering) return // keep the progress message of a registration in flight
  $("keyForge").hidden = true
  btn.disabled = true
  btn.textContent = "Register with MetaMask"
  btn.hidden = false
  if (state.phase !== "registration") return setStatus("regStatus", "Registration has closed.", "hint")
  if (!account) {
    btn.textContent = "Connect MetaMask"
    btn.disabled = false
    return setStatus("regStatus", "Start by connecting the wallet that's on the voter list.", "muted")
  }
  if (state.walletErr) return setStatus("regStatus", `Couldn't check your wallet privately right now (${state.walletErr}). It will retry in a few seconds.`, "err")
  if (!state.whitelisted) {
    return setStatus("regStatus", `This wallet (${account.slice(0, 6)}…${account.slice(-4)}) isn't on the voter list. If you have another wallet, switch to it in MetaMask.`, "err")
  }
  if (state.registered) {
    btn.hidden = true
    const mine = loadIdentities().find((x) => x.label === account.toLowerCase())
    const local = Boolean(mine)
    if (mine) {
      forgeStop(commitmentLabel(mine.identity))
      forgeState("registered", { instant: $("keyForge").dataset.state !== "registered" })
    }
    return setStatus(
      "regStatus",
      local ? "You're registered. Save your voter key below, then come back when voting opens." : "This wallet is already registered, but its voter key isn't in this browser. Load it below to vote.",
      local ? "ok" : "err"
    )
  }
  setStatus("regStatus", "")
  btn.disabled = false
}

// The registration animation. Only the identity *commitment* (the public half, which goes
// on-chain anyway) is ever shown; the secret key never reaches the screen.
const FORGE_STEP = { forging: 0, signing: 1, sending: 2, recording: 2, registered: 4 }
const FORGE_NOTE = {
  forging: "Creating it in this browser…",
  signing: "Approve in MetaMask",
  sending: "Sending its public half",
  recording: "Being added to the list",
  registered: "Saved in this browser",
}
const commitmentLabel = (identity) => {
  const hex = identity.commitment.toString(16).padStart(64, "0")
  return `0x${hex.slice(0, 4)}…${hex.slice(-4)}`
}
function forgeState(name, { instant = false } = {}) {
  const el = $("keyForge")
  if (instant) el.classList.add("instant")
  el.hidden = false
  el.dataset.state = name
  $("forgeNote").textContent = FORGE_NOTE[name]
  $("forgeListLabel").textContent = name === "registered" ? "Registered" : name === "recording" ? "Recording" : "Voter list"
  const at = FORGE_STEP[name]
  $("forgeSteps").querySelectorAll("li").forEach((li, i) => (li.className = i < at ? "done" : i === at ? "current" : ""))
  if (instant) requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove("instant")))
}
let forgeTimer
function forgeScramble() {
  clearInterval(forgeTimer)
  forgeTimer = setInterval(() => ($("forgeText").textContent = `0x${randHex(4)}…${randHex(4)}`), 55)
}
function forgeStop(final) {
  clearInterval(forgeTimer)
  if (final !== undefined) $("forgeText").textContent = final
}

let registering = false
async function register() {
  $("registerBtn").disabled = true
  registering = true
  let step = "check wallet network"
  try {
    $("registerBtn").hidden = true
    setStatus("regStatus", "")
    forgeState("forging")
    forgeScramble()
    const forging = wait(reducedMotion() ? 0 : 1100)
    // The wallet may stay on whatever network it is on (Ethereum, an L2, ...): an address
    // is the same on every EVM chain, and the election accepts a signature made elsewhere.
    const walletChain = Number(BigInt(await eth.request({ method: "eth_chainId" })))
    const onElectionChain = walletChain === Number(cfg.chainId)
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
    await forging
    forgeStop(commitmentLabel(identity))
    // Wallets only sign typed data whose domain names their active network. On the
    // election's chain that is the plain Register message. On any other network it is
    // RegisterOn: the domain names the wallet's network, and the election's chain and
    // address are part of the message instead (Election.registerForSignedOn).
    const domain = onElectionChain
      ? { name: "goblett Election", version: "1", chainId: cfg.chainId, verifyingContract: cfg.election }
      : { name: "goblett Election", version: "1", chainId: walletChain }
    const types = onElectionChain
      ? { Register: [{ name: "wallet", type: "address" }, { name: "identityCommitment", type: "uint256" }] }
      : {
          RegisterOn: [
            { name: "wallet", type: "address" },
            { name: "identityCommitment", type: "uint256" },
            { name: "electionChainId", type: "uint256" },
            { name: "election", type: "address" },
          ],
        }
    const value = onElectionChain
      ? { wallet: account, identityCommitment: identity.commitment }
      : { wallet: account, identityCommitment: identity.commitment, electionChainId: cfg.chainId, election: cfg.election }
    // Ask MetaMask directly (not via ethers' signer) so its own error message reaches the page.
    const payload = ethers.TypedDataEncoder.getPayload(domain, types, value)
    forgeState("signing")
    setStatus("regStatus", "Approve the request in MetaMask. It's a free signature, not a transaction.", "muted")
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
    step = "publish to Nostr"
    setStatus("regStatus", "Sending your registration…", "muted")
    forgeState("sending")
    const [sent] = await Promise.all([publish(cfg, {
      type: "register",
      wallet: account,
      identityCommitment: identity.commitment.toString(),
      signature,
      ...(onElectionChain ? {} : { signingChainId: walletChain }),
    }), wait(reducedMotion() ? 0 : 1100)])
    log(`registration published${sent.private ? " through the private channel" : ""} to ${sent.accepted.join(", ")} (event ${short(sent.id)})`)
    step = "wait for a relayer to put it on-chain"
    forgeState("recording")
    setStatus("regStatus", "Recording your registration on-chain. This usually takes under a minute…", "muted")
    const wallet = account
    const priv = await privateElection()
    const res = await confirm(cfg, sent.id, () => priv.hasRegistered(wallet))
    log(`registered on-chain${res.txHash ? `, tx ${res.txHash}` : ""}`)
    walletCache = undefined
    forgeState("registered")
    await wait(reducedMotion() ? 0 : 900)
    registering = false
    await refresh()
    $("keyCard").scrollIntoView({ behavior: "smooth", block: "start" })
  } catch (e) {
    console.error(e)
    registering = false
    forgeStop()
    $("keyForge").hidden = true
    $("registerBtn").hidden = false
    setStatus("regStatus", `Registration didn't go through: ${errMsg(e)} (step: ${step}; details in the activity log)`, "err")
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
    ? ids.map((x) => `<option value="${esc(x.label)}">${esc(x.label.startsWith("0x") ? "registered by " + x.label.slice(0, 10) + "…" : x.label)}</option>`).join("")
    : `<option value="">(no voter key in this browser)</option>`
  if (ids.some((x) => x.label === prev)) sel.value = prev
}

// ---------------------------------------------------------------------------
// Voter key backup. The key never leaves the browser except as a file or clipboard
// copy the voter makes themselves.
// ---------------------------------------------------------------------------
const savedKey = (commitment) => `goblett:saved:${cfg.election.toLowerCase()}:${commitment}`
const selectedIdentity = () => loadIdentities().find((x) => x.label === $("identitySel").value)
let keyCardHadKey // so the import box opens by itself only when the card first has no key

function renderKey() {
  const ids = loadIdentities()
  const has = ids.length > 0
  $("keyCard").hidden = state.phase === "ended" || (!has && state.phase === "registration" && !(account && state.registered))
  $("keyBody").hidden = !has
  $("identityLabel").hidden = ids.length < 2
  if (keyCardHadKey !== has) $("importBox").open = !has
  keyCardHadKey = has
  const x = selectedIdentity()
  const saved = !!(x && localStorage.getItem(savedKey(x.identity.commitment)))
  $("keyCard").classList.toggle("warn", has && !saved)
  $("keyCard").querySelector("h2").textContent = has && !saved ? "Save your voter key" : "Your voter key"
  $("savedKey").checked = saved
  if (saved) $("savedKey").disabled = false
}

// The "I've saved it" box unlocks once the voter has downloaded, copied or shown the key.
function keyHandled(msg) {
  $("savedKey").disabled = false
  setStatus("keyStatus", msg, "muted")
}

function downloadKey() {
  const x = selectedIdentity()
  if (!x) return
  const url = URL.createObjectURL(new Blob([x.identity.export() + "\n"], { type: "text/plain" }))
  const a = Object.assign(document.createElement("a"), { href: url, download: `goblett-voter-key-${cfg.election.slice(2, 8).toLowerCase()}.txt` })
  a.click()
  URL.revokeObjectURL(url)
  keyHandled("Downloaded. Keep the file somewhere private; you'll need it if you vote from another browser.")
}

async function copyKey() {
  const x = selectedIdentity()
  if (!x) return
  try {
    await navigator.clipboard.writeText(x.identity.export())
    keyHandled("Copied. Paste it somewhere private, like a password manager.")
  } catch {
    setStatus("keyStatus", "Couldn't copy automatically. Use Show key and copy it yourself.", "err")
  }
}

function toggleShowKey() {
  const pre = $("exported")
  const x = selectedIdentity()
  pre.hidden = !pre.hidden || !x
  pre.textContent = pre.hidden ? "" : x.identity.export()
  $("exportBtn").textContent = pre.hidden ? "Show key" : "Hide key"
  if (!pre.hidden) keyHandled("Don't share this or show it on screen to anyone.")
}

async function importKey() {
  try {
    const file = $("importFile").files[0]
    const text = file ? (await file.text()).trim() : $("importTxt").value.trim()
    if (!text) throw new Error("choose your key file or paste your key first")
    const identity = Identity.import(text)
    saveIdentity(account ?? "imported-" + identity.commitment.toString().slice(0, 8), identity)
    localStorage.setItem(savedKey(identity.commitment), "1") // it came from a backup
    $("importTxt").value = ""
    $("importFile").value = ""
    $("importBox").open = false
    setStatus("importStatus", "")
    log(`imported identity ${short(identity.commitment)}`)
    await refresh()
    setStatus("keyStatus", "Voter key loaded.", "ok")
  } catch (e) {
    setStatus("importStatus", `That doesn't look like a voter key: ${errMsg(e)}`, "err")
  }
}

function renderBallot() {
  const box = $("ballot")
  if (cfg.kind === "ranked") {
    box.innerHTML =
      `<div class="ranked-tools"><p class="muted">Tap in order of preference: 1st, 2nd, … You can stop early.</p><button class="link" id="rankReset">Start over</button></div>` +
      state.cands.map((c, i) => `<label class="choice"><input type="checkbox" data-i="${i}" /><span class="mark" id="rank${i}"></span>${esc(c)}</label>`).join("")
    $("rankReset").onclick = () => {
      ranking = []
      box.querySelectorAll("input").forEach((el) => (el.checked = false))
      state.cands.forEach((_, j) => ($(`rank${j}`).textContent = ""))
      updateVoteButton()
    }
    box.querySelectorAll("input").forEach((el) =>
      el.addEventListener("change", () => {
        const i = Number(el.dataset.i)
        ranking = el.checked ? [...ranking, i] : ranking.filter((x) => x !== i)
        state.cands.forEach((_, j) => ($(`rank${j}`).textContent = ranking.includes(j) ? ranking.indexOf(j) + 1 : ""))
        updateVoteButton()
      })
    )
  } else {
    box.innerHTML = state.cands.map((c, i) => `<label class="choice"><input type="radio" name="cand" value="${i}" /><span class="mark"></span>${esc(c)}</label>`).join("")
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
  const x = selectedIdentity()
  const voted = !!(x && localStorage.getItem(votedKey(x.identity.commitment)))
  const why =
    state.phase === "ended"
      ? "Voting has closed."
      : state.phase !== "voting"
        ? "Voting hasn't opened yet."
        : state.regCount < state.minAnon
          ? `Too few voters registered for votes to be accepted (${state.regCount} of ${state.minAnon} needed).`
          : !x
            ? "Your voter key isn't in this browser. Load it under “Your voter key” above."
            : voted
              ? "You've already voted with this key."
              : selectedBallot() === null
                ? cfg.kind === "ranked"
                  ? "Pick candidates in your order of preference."
                  : "Pick a candidate."
                : ""
  $("voteBtn").disabled = !!why || votingNow
  if (!voteResultShown) setStatus("voteStatus", why, voted ? "ok" : "hint")
  if (!votingNow) {
    // Already voted with this key: show the box with the token in it instead of the ballot.
    $("ballot").hidden = voted
    $("voteBtn").hidden = voted
    if (voted) sealState("counted", "sealed", { instant: true })
    else $("sealer").hidden = true
  }
}

// ---------------------------------------------------------------------------
// The sealing animation shown while a vote is cast (states styled in style.css).
// The hex on the token is decorative and random: it is never the proof or the
// nullifier, which are public on-chain next to the ballot and would reveal the
// vote to anyone who sees this screen.
// ---------------------------------------------------------------------------
const randHex = (n) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("")
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches
const SEAL_STEP = { ready: -1, sealing: 0, sealed: 0, dropping: 1, inbox: 2, counted: 4, failed: -1 }

function sealState(stateName, text, { instant = false } = {}) {
  const el = $("sealer")
  if (instant) el.classList.add("instant")
  el.hidden = false
  el.dataset.state = stateName
  if (text !== undefined) $("sealText").textContent = text
  const at = SEAL_STEP[stateName]
  $("sealSteps").querySelectorAll("li").forEach((li, i) => (li.className = i < at ? "done" : i === at ? "current" : ""))
  $("sealBoxLabel").textContent = stateName === "counted" ? "Counted" : stateName === "inbox" ? "Recording" : "Ballot box"
  if (instant) requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove("instant")))
}

// The choice turns into hex letter by letter, then keeps cycling while the proof is built.
let scrambleTimer
function scramble(from) {
  clearInterval(scrambleTimer)
  const len = Math.min(Math.max(from.length, 14), 22)
  const src = from.padEnd(len).slice(0, len)
  let n = 0
  scrambleTimer = setInterval(() => {
    n = Math.min(len, n + 1)
    $("sealText").textContent = randHex(n) + src.slice(n)
  }, 45)
}
function stopScramble(final) {
  clearInterval(scrambleTimer)
  if (final !== undefined) $("sealText").textContent = final
}

function choiceLabel(ballot) {
  if (cfg.kind !== "ranked") return state.cands[ballot]
  return ballot.map((c, i) => `${i + 1}. ${state.cands[c]}`).join("   ")
}

// Same encoding as RankedChoiceElection.packRanking: byte i = ranking[i] + 1.
const pack = (r) => r.reduce((acc, c, i) => acc | (BigInt(c + 1) << BigInt(8 * i)), 0n)

// Proofs always use one self-hosted circuit (R4-7). Left to itself, generateProof
// downloads the depth-N circuit from snark-artifacts.pse.dev right before publishing,
// so that third party would see "this IP is voting now". Depth 20 fits 1M voters;
// shorter Merkle proofs are padded and verify on-chain the same way.
const PROOF_DEPTH = 20
const PROOF_ARTIFACTS = { wasm: "/snark/semaphore-20.wasm", zkey: "/snark/semaphore-20.zkey" }
// Fetch them with the page rather than at vote time, so the request's timing says nothing.
function prefetchProofArtifacts() {
  for (const url of Object.values(PROOF_ARTIFACTS)) fetch(url, { cache: "force-cache" }).catch(() => {})
}

let votingNow = false // a vote in flight: refreshes must not re-enable the button
async function vote() {
  $("voteBtn").disabled = true
  votingNow = true
  try {
    const { identity } = selectedIdentity()
    const ballot = selectedBallot()
    voteResultShown = true
    $("ballot").hidden = true
    $("voteBtn").hidden = true
    sealState("ready", choiceLabel(ballot))
    setStatus("voteStatus", "Checking the voter list…", "muted")
    // One call for the whole list (no event scan: Arc's RPC only serves small log ranges).
    const priv = await privateElection()
    const group = new Group([...(await priv.commitments())])
    if (group.indexOf(identity.commitment) < 0) throw new Error("this voter key isn't registered in this election")

    const message = cfg.kind === "ranked" ? pack(ballot) : BigInt(ballot)
    // Bind the proof to this address: a look-alike contract could otherwise return
    // another election's scope and get a proof that counts there (R3-4).
    const scope = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "address"], [cfg.chainId, cfg.election])))
    if (scope !== (await priv.scope())) throw new Error("This contract's scope does not match its address. It is not a genuine goblett election.")
    setStatus("voteStatus", "Preparing your anonymous ballot. This takes 10–30 seconds; keep this tab open…", "muted")
    log(`generating proof over ${group.size} registered voters`)
    if (group.depth > PROOF_DEPTH) throw new Error(`groups deeper than ${PROOF_DEPTH} are not supported`)
    sealState("sealing")
    scramble(choiceLabel(ballot))
    // Let the letters visibly turn to ciphertext before the proof takes over the CPU.
    if (!reducedMotion()) await wait(900)
    const proof = await generateProof(identity, group, message, scope, PROOF_DEPTH, PROOF_ARTIFACTS)
    stopScramble(`0x${randHex(4)}…${randHex(4)}`)
    sealState("sealed")
    if (!reducedMotion()) await wait(600)

    setStatus("voteStatus", "Sending your sealed ballot…", "muted")
    const body = { proof: { ...proof, points: proof.points.map(String) } }
    if (cfg.kind === "ranked") body.ranking = ballot
    sealState("dropping")
    const [sent] = await Promise.all([publish(cfg, { type: "vote", ...body }), wait(reducedMotion() ? 0 : 1200)])
    log(`vote published${sent.private ? " through the private channel" : ""} to ${sent.accepted.join(", ")} (event ${short(sent.id)})`)
    sealState("inbox")
    setStatus("voteStatus", "Recording your vote on-chain. This usually takes under a minute…", "muted")
    // Don't trust anyone's word: confirm() waits until the nullifier is used on-chain.
    const res = await confirm(cfg, sent.id, () => priv.nullifierUsed(proof.nullifier))

    localStorage.setItem(votedKey(identity.commitment), "1")
    sealState("counted")
    setStatus("voteStatus", "Your vote was counted.", "ok")
    log(`vote on-chain, nullifier ${short(proof.nullifier)} marked used${res.txHash ? `, tx ${res.txHash}` : ""}`)
    await refresh()
  } catch (e) {
    stopScramble()
    $("sealer").hidden = true // back to the ballot so they can try again
    setStatus("voteStatus", `Your vote didn't go through: ${errMsg(e)}`, "err")
  } finally {
    votingNow = false
    updateVoteButton()
  }
}

// ---------------------------------------------------------------------------
// Accounts: a public username for the connected wallet (accounts.js). Optional, and
// separate from voting: nothing here runs while a vote is cast.
// ---------------------------------------------------------------------------
let username // of the connected wallet, if it has one

function renderAccount() {
  $("account").textContent = !account ? "not connected" : username ? `${username} (${account.slice(0, 6)}…${account.slice(-4)})` : account
  $("accountCard").hidden = !account
  $("connect").hidden = !!account
}

// The username lookup sends the wallet address to goblett's server over a direct
// connection, tying it to this IP, so it only runs when the voter asks (R4-3).
function resetAccount() {
  username = undefined
  renderAccount()
  if (account) setStatus("accountStatus", "Looking up your username sends this wallet's address to goblett's server.", "muted")
}

async function loadAccount() {
  username = undefined
  renderAccount()
  if (!account) return
  const wallet = account
  try {
    const name = (await usernamesOf([wallet])).get(wallet.toLowerCase())
    if (wallet !== account) return // the wallet changed while we were asking
    username = name
    $("usernameInput").value = name ?? ""
    setStatus("accountStatus", name ? `Your username is ${name}.` : "This wallet has no username yet.", name ? "ok" : "muted")
  } catch (e) {
    setStatus("accountStatus", `Accounts are unavailable right now: ${errMsg(e)}`, "muted")
  }
  renderAccount()
}

async function saveUsername() {
  const wanted = $("usernameInput").value.trim().toLowerCase()
  $("usernameBtn").disabled = true
  try {
    if (!account) throw new Error("connect MetaMask first")
    if (!USERNAME_RE.test(wanted)) throw new Error(`a username is ${USERNAME_RULES}`)
    setStatus("accountStatus", "Sign the username in MetaMask…", "muted")
    const saved = await claimUsername(eth, account, wanted)
    username = saved.username
    setStatus("accountStatus", `Your username is ${saved.username}.`, "ok")
    renderAccount()
  } catch (e) {
    setStatus("accountStatus", `Could not save the username: ${errMsg(e)}`, "err")
  } finally {
    $("usernameBtn").disabled = false
  }
}

// Whitelist entries are addresses or usernames (an optional leading @ is ignored).
// Returns the distinct checksummed addresses and how each name was resolved.
async function resolveWhitelist(entries) {
  const names = []
  for (const e of entries) {
    if (ethers.isAddress(e)) continue
    const name = e.replace(/^@/, "").toLowerCase()
    if (!USERNAME_RE.test(name)) throw new Error(`"${e}" is neither an address nor a username`)
    names.push(name)
  }
  const found = await addressesOf([...new Set(names)])
  const unknown = [...new Set(names)].filter((n) => !found.has(n))
  if (unknown.length) throw new Error(`no account with username: ${unknown.join(", ")}`)
  const addresses = entries.map((e) => ethers.getAddress(ethers.isAddress(e) ? e : found.get(e.replace(/^@/, "").toLowerCase())))
  return { addresses: [...new Set(addresses)], resolved: [...found].map(([name, address]) => ({ name, address: ethers.getAddress(address) })) }
}

// Show what the usernames in the whitelist box resolve to, so the creator can check the
// addresses before they are fixed in the contract. (The database, not the chain, says who
// "alice" is; the contract only ever stores addresses.)
let previewTimer
function previewWhitelist() {
  clearTimeout(previewTimer)
  previewTimer = setTimeout(async () => {
    const entries = lines("newWhitelist")
    if (entries.every((e) => ethers.isAddress(e))) return setStatus("whitelistPreview", "")
    try {
      const { resolved } = await resolveWhitelist(entries)
      $("whitelistPreview").innerHTML = resolved.map((r) => `<div class="muted">${esc(r.name)} → ${esc(r.address)}</div>`).join("")
    } catch (e) {
      setStatus("whitelistPreview", errMsg(e), "err")
    }
  }, 500)
}

// ---------------------------------------------------------------------------
// Create an election (deployed from the connected wallet, which pays the gas)
// ---------------------------------------------------------------------------
const recentKey = () => `goblett:elections:${cfg.chainId}`
const electionUrl = (e) => `?election=${e.address}`
const lines = (id) => $(id).value.split("\n").map((x) => x.trim()).filter(Boolean)
// <input type="datetime-local"> works in local time without a zone: "2026-11-16T21:05".
const toLocalInput = (unix) => {
  const d = new Date(unix * 1000)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}
const fromLocalInput = (v) => Math.floor(new Date(v).getTime() / 1000)
// The time the next block will carry (an idle local chain's latest block can be old).
// Some RPCs (Arc) refuse to serve the pending block; the latest block is then close enough.
const chainNow = async () => Math.max(...(await Promise.all([provider.getBlock("pending").catch(() => null), provider.getBlock("latest")])).map((b) => b?.timestamp ?? 0))

async function initCreateForm() {
  const recent = JSON.parse(localStorage.getItem(recentKey()) ?? "[]")
  $("recent").innerHTML = recent.length
    ? "<h3>Your elections</h3><div class='recent-list'>" +
      recent.map((e) => `<a class="recent-item" href="${electionUrl(e)}">${esc(e.title)} <span>${e.address.slice(0, 6)}…${e.address.slice(-4)} →</span></a>`).join("") +
      "</div>"
    : ""
  const now = await chainNow()
  createClock = { chain: now, local: Date.now() }
  setRegDuration(regSecs)
  // Relayer payment defaults: refund gas up to twice today's price.
  const price = await gasPriceNow()
  $("newMaxGasPrice").value = Math.ceil(Number(ethers.formatUnits(2n * price, "gwei")))
  for (const el of document.querySelectorAll(".sym")) el.textContent = sym()
  for (const id of ["newWhitelist", "newBounty", "newMaxGasPrice"]) $(id).addEventListener("input", () => updateFundingEstimate(price))
  updateFundingEstimate(price)
  $("chainClock").textContent = `Chain time is now ${new Date(now * 1000).toLocaleString()}. Deadlines are checked against the chain's clock, which on a local test chain can differ from yours.`
}

const sym = () => cfg.nativeCurrency?.symbol ?? ""

// ---------------------------------------------------------------------------
// Create wizard: four tap-through steps. Every tap writes into the plain inputs
// (newTitle, newKind, newCands, newWhitelist, newRegEnd, newVoteEnd, ...) that
// createElection() reads, so the deployment logic is unchanged.
// ---------------------------------------------------------------------------
let createClock // { chain, local }: the chain's clock when the form opened
const chainNowEstimate = () => (createClock ? createClock.chain + Math.floor((Date.now() - createClock.local) / 1000) : Math.floor(Date.now() / 1000))
let regSecs = 900
let voteSecs = 1800
let wizStep = 0
let votersMode = null // "me" | "group"

const PRESETS = {
  yesno: { title: "", placeholder: "Should we …?", kind: "fptp", cands: ["Yes", "No"] },
  yesnoabstain: { title: "", placeholder: "Should we …?", kind: "fptp", cands: ["Yes", "No", "Abstain"] },
  president: { title: `Club president ${new Date().getFullYear()}`, kind: "fptp", cands: [] },
  rank: { title: "", placeholder: "e.g. Where should the trip go?", kind: "ranked", cands: [] },
}

function showCreate(on = true) {
  document.body.classList.toggle("creating", on)
  if (on) {
    goStep(0)
    window.scrollTo({ top: 0 })
  }
}

function goStep(i) {
  wizStep = i
  document.querySelectorAll(".wiz-step").forEach((el) => el.classList.toggle("current", Number(el.dataset.step) === i))
  $("wizSteps").querySelectorAll("li").forEach((li, j) => (li.className = j < i ? "done" : j === i ? "current" : ""))
  $("wizPrev").style.visibility = i === 0 ? "hidden" : "visible"
  $("wizNext").hidden = i === 3
  $("wizError").textContent = ""
  if (i === 3) renderReview()
}

function stepError(i) {
  if (i === 0) {
    const cands = lines("newCands")
    if (!$("newTitle").value.trim()) return "Give your election a title."
    if (cands.length < 2) return "Add at least two choices."
  }
  if (i === 1) {
    if (!votersMode) return "Choose who can vote."
    if (votersMode === "group" && !lines("newWhitelist").length) return "Add at least one voter."
  }
  if (i === 2 && !(fromLocalInput($("newVoteEnd").value) > fromLocalInput($("newRegEnd").value))) return "Voting must end after sign-up ends."
  return ""
}

function setKind(kind) {
  $("newKind").value = kind
  $("kindChoices").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.kind === kind))
}

// A list of removable tags backed by a hidden one-per-line textarea.
function renderTags(boxId, textareaId, show = (x) => x) {
  const items = lines(textareaId)
  $(boxId).innerHTML = items.map((x, i) => `<span class="tag"><span>${esc(show(x))}</span><button data-i="${i}" title="Remove">×</button></span>`).join("")
  $(boxId).querySelectorAll("button").forEach((b) => {
    b.onclick = () => {
      $(textareaId).value = items.filter((_, j) => j !== Number(b.dataset.i)).join("\n")
      $(textareaId).dispatchEvent(new Event("input"))
      renderTags(boxId, textareaId, show)
    }
  })
}
function addTags(textareaId, entries) {
  const have = lines(textareaId)
  const add = entries.map((x) => x.trim()).filter((x) => x && !have.some((h) => h.toLowerCase() === x.toLowerCase()))
  $(textareaId).value = [...have, ...add].join("\n")
  $(textareaId).dispatchEvent(new Event("input"))
  return add.length
}
const renderCands = () => renderTags("candChips", "newCands")
const shortAddr = (x) => (ethers.isAddress(x) ? `${x.slice(0, 6)}…${x.slice(-4)}` : x)
const renderVoters = () => renderTags("voterChips", "newWhitelist", shortAddr)

function addCand() {
  const v = $("candInput").value
  if (addTags("newCands", [v])) renderCands()
  $("candInput").value = ""
  $("candInput").focus()
}
function addVoter(entries) {
  const n = addTags("newWhitelist", entries)
  renderVoters()
  return n
}

function setVotersMode(mode) {
  votersMode = mode
  $("voterChoices").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.voters === mode))
  $("voterGroup").hidden = mode !== "group"
  if (mode === "me") {
    $("newWhitelist").value = ""
    $("newWhitelist").dispatchEvent(new Event("input"))
    renderVoters()
  }
}

function setRegDuration(secs) {
  regSecs = secs
  $("newRegEnd").value = toLocalInput(chainNowEstimate() + secs)
  setVoteDuration(voteSecs)
}
function setVoteDuration(secs) {
  voteSecs = secs
  $("newVoteEnd").value = toLocalInput(fromLocalInput($("newRegEnd").value) + secs)
  renderSchedule()
}
function renderSchedule() {
  const mark = (id, secs) => $(id).querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", Number(c.dataset.secs) === secs))
  mark("regChips", regSecs)
  mark("voteChips", voteSecs)
  const f = (v) => new Date(v).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
  $("schedulePreview").innerHTML = `<div><span>Sign-up closes</span><b>${esc(f($("newRegEnd").value))}</b></div><div><span>Voting closes</span><b>${esc(f($("newVoteEnd").value))}</b></div>`
}

function renderReview() {
  const cands = lines("newCands")
  const voters = lines("newWhitelist")
  const f = (v) => new Date(v).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
  $("review").innerHTML = `
    <dt>Title</dt><dd><b>${esc($("newTitle").value.trim())}</b></dd>
    <dt>Voting style</dt><dd>${$("newKind").value === "ranked" ? "Rank the choices" : "Pick one"}</dd>
    <dt>Choices</dt><dd>${cands.map(esc).join(", ")}</dd>
    <dt>Voters</dt><dd>${votersMode === "group" ? `${voters.length} voter${voters.length === 1 ? "" : "s"}` : "Just you"}</dd>
    <dt>Sign-up ends</dt><dd>${esc(f($("newRegEnd").value))}</dd>
    <dt>Voting ends</dt><dd>${esc(f($("newVoteEnd").value))}</dd>
    <dt>Upfront cost</dt><dd>≈ ${esc(Number($("newFunding").value || 0).toLocaleString(undefined, { maximumFractionDigits: 4 }))} ${esc(sym())} + setup fee</dd>`
}

function wireWizard() {
  $("createTile").onclick = () => showCreate(true)
  $("startOwnBtn").onclick = () => showCreate(true)
  $("createCancel").onclick = () => showCreate(false)
  $("wizPrev").onclick = () => goStep(Math.max(0, wizStep - 1))
  $("wizNext").onclick = () => {
    const err = stepError(wizStep)
    if (err) return ($("wizError").textContent = err)
    goStep(wizStep + 1)
  }
  $("presetChips").querySelectorAll(".chip").forEach((b) => {
    b.onclick = () => {
      const p = PRESETS[b.dataset.preset]
      $("presetChips").querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", c === b))
      $("newTitle").value = p.title
      $("newTitle").placeholder = p.placeholder ?? "e.g. Club president 2026"
      setKind(p.kind)
      $("newCands").value = p.cands.join("\n")
      renderCands()
      ;(p.title ? $("candInput") : $("newTitle")).focus()
    }
  })
  $("kindChoices").querySelectorAll("button").forEach((b) => (b.onclick = () => setKind(b.dataset.kind)))
  $("candAdd").onclick = addCand
  $("candInput").onkeydown = (e) => e.key === "Enter" && (e.preventDefault(), addCand())
  $("voterChoices").querySelectorAll("button").forEach((b) => (b.onclick = () => setVotersMode(b.dataset.voters)))
  $("voterAdd").onclick = () => {
    addVoter([$("voterInput").value])
    $("voterInput").value = ""
    $("voterInput").focus()
  }
  $("voterInput").onkeydown = (e) => e.key === "Enter" && (e.preventDefault(), $("voterAdd").click())
  $("pasteVoters").onclick = async () => {
    try {
      const n = addVoter((await navigator.clipboard.readText()).split(/[\s,;]+/))
      setStatus("whitelistPreview", n ? `Added ${n} voter${n === 1 ? "" : "s"}.` : "Nothing new to add from the clipboard.", "muted")
    } catch {
      setStatus("whitelistPreview", "Couldn't read the clipboard. Type or paste into the box below instead.", "err")
      $("voterInput").focus()
    }
  }
  $("regChips").querySelectorAll(".chip").forEach((c) => (c.onclick = () => setRegDuration(Number(c.dataset.secs))))
  $("voteChips").querySelectorAll(".chip").forEach((c) => (c.onclick = () => setVoteDuration(Number(c.dataset.secs))))
  for (const id of ["newRegEnd", "newVoteEnd"]) {
    $(id).addEventListener("input", () => {
      regSecs = voteSecs = 0
      renderSchedule()
    })
  }
  setKind("fptp")
  setRegDuration(regSecs)
}

// ---------------------------------------------------------------------------
// Home: open an election from a link
// ---------------------------------------------------------------------------
function openElection(text) {
  const t = text.trim()
  const m = t.match(/0x[0-9a-fA-F]{40}/)
  if (!m || !ethers.isAddress(m[0])) return setStatus("joinStatus", "That doesn't look like a goblett link. It should contain an address starting with 0x.", "err")
  location.search = `?election=${ethers.getAddress(m[0])}`
}
function wireHome() {
  const how = $("howDialog")
  $("howBtn").onclick = () => how.showModal()
  $("howClose").onclick = $("howDone").onclick = () => how.close()
  how.addEventListener("click", (e) => {
    // A click on the backdrop targets the dialog itself but lands outside its box.
    const r = how.getBoundingClientRect()
    if (e.target === how && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) how.close()
  })
  $("joinTile").onclick = () => {
    $("joinBox").hidden = false
    $("joinBox").scrollIntoView({ behavior: "smooth", block: "center" })
  }
  $("pasteLinkBtn").onclick = async () => {
    try {
      openElection(await navigator.clipboard.readText())
    } catch {
      setStatus("joinStatus", "Couldn't read the clipboard. Paste the link into the box below.", "err")
      $("joinInput").focus()
    }
  }
  $("joinBtn").onclick = () => openElection($("joinInput").value)
  $("joinInput").onkeydown = (e) => e.key === "Enter" && openElection($("joinInput").value)
  $("shareBtn").onclick = async () => {
    const url = `${location.origin}${location.pathname}?election=${cfg.election}`
    try {
      await navigator.clipboard.writeText(url)
      $("shareBtn").textContent = "Link copied"
    } catch {
      prompt("Copy this invite link:", url)
    }
    setTimeout(() => ($("shareBtn").textContent = "Copy invite link"), 2000)
  }
}
const fmt = (wei) => `${Number(ethers.formatEther(wei)).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${sym()}`
// What a transaction pays per gas right now (base fee + tip).
async function gasPriceNow() {
  const f = await provider.getFeeData()
  const base = (await provider.getBlock("latest")).baseFeePerGas
  return base != null ? base + (f.maxPriorityFeePerGas ?? 0n) : (f.gasPrice ?? 0n)
}
// Per voter: one relayed registration and one relayed vote, each with a bounty. A registration
// costs ~260k gas plus ~32k per level of the voters' Merkle tree (it gets deeper as the list
// grows); a vote ~450k.
function updateFundingEstimate(price) {
  const voters = Math.max(1, lines("newWhitelist").length)
  let bounty = 0n
  try {
    bounty = ethers.parseEther($("newBounty").value || "0")
  } catch {}
  const levels = BigInt(Math.max(1, Math.ceil(Math.log2(voters))))
  const estimate = BigInt(voters) * ((260000n + 32000n * levels + 450000n) * price + 2n * bounty)
  $("newFunding").value = ethers.formatEther(estimate)
  $("fundingHint").textContent = `Estimate for ${voters} voter(s) all registering and voting at today's gas price. Unused funding can be reclaimed to your wallet after voting ends.`
}

// After voting ends, anyone can send the unused relayer funding back to the creator.
async function reclaim() {
  try {
    if (!account) await connect()
    await ensureChain()
    await ensureAccountAuthorized()
    const signer = await new ethers.BrowserProvider(eth).getSigner(account)
    const tx = await new ethers.Contract(cfg.election, ABI, signer).reclaim()
    log(`reclaim sent (tx ${short(tx.hash)}); the funds go to the creator ${state.terms.creator}`)
    await provider.waitForTransaction(tx.hash, 1, 120000)
    await refresh()
  } catch (e) {
    log(`reclaim failed: ${errMsg(e)}`)
  }
}

async function createElection() {
  const btn = $("createBtn")
  btn.disabled = true
  let step = "check the form"
  try {
    const kind = $("newKind").value
    const title = $("newTitle").value.trim()
    const cands = lines("newCands")
    const maxCands = kind === "ranked" ? 32 : 64
    if (!title) throw new Error("give the election a title")
    if (cands.length < 2 || cands.length > maxCands) throw new Error(`need 2 to ${maxCands} candidates (one per line)`)
    if (new Set(cands).size !== cands.length) throw new Error("candidate names must be distinct")

    step = "connect wallet"
    if (!account) await connect()
    if (!account) throw new Error("connect MetaMask first")
    step = "look up usernames"
    const entered = lines("newWhitelist")
    const { addresses: whitelist, resolved } = await resolveWhitelist(entered.length ? entered : [account])
    for (const r of resolved) log(`whitelist: ${r.name} → ${r.address}`)
    const minAnon = Number($("newMinAnon").value || Math.min(2, whitelist.length))
    if (!(minAnon >= 1 && minAnon <= whitelist.length)) throw new Error(`minimum registrations must be between 1 and ${whitelist.length} (the whitelist size)`)

    const regEnd = fromLocalInput($("newRegEnd").value)
    const voteEnd = fromLocalInput($("newVoteEnd").value)
    const now = await chainNow()
    if (!(regEnd > now + 30)) throw new Error("registration must end in the future (by the chain's clock)")
    if (!(voteEnd > regEnd)) throw new Error("voting must end after registration ends")

    const bounty = ethers.parseEther($("newBounty").value || "0")
    const maxGasPrice = ethers.parseUnits($("newMaxGasPrice").value || "0", "gwei")
    const funding = ethers.parseEther($("newFunding").value || "0")

    step = "switch network"
    await ensureChain()
    await ensureAccountAuthorized()
    const balance = await provider.getBalance(account)
    if (balance <= funding) {
      throw new Error(`${account} has ${fmt(balance)}, not enough for ${fmt(funding)} of relayer funding plus the deployment gas.${cfg.chainId === 31337 ? ` On the local test chain run: python setup_chain.py --fund ${account}` : ""}`)
    }

    step = "confirm the deployment in MetaMask"
    setStatus("createStatus", "Confirm the deployment in MetaMask…", "muted")
    const signer = await new ethers.BrowserProvider(eth).getSigner(account)
    const factory = new ethers.ContractFactory(CONTRACTS[kind].abi, CONTRACTS[kind].bytecode, signer)
    // Voting opens when registration ends (votingStart = registrationEnd, no gap).
    // The funding is sent along with the deployment and held by the election contract.
    const deployTx = await factory.getDeployTransaction(cfg.semaphore, title, cands, whitelist, regEnd, regEnd, voteEnd, minAnon, bounty, maxGasPrice, { value: funding })
    const tx = await signer.sendTransaction(deployTx)

    step = "wait for the deployment to be mined"
    setStatus("createStatus", `Deploying… (tx ${short(tx.hash)})`, "muted")
    const rcpt = await provider.waitForTransaction(tx.hash, 1, 120000)
    if (!rcpt || rcpt.status !== 1) throw new Error("the deployment transaction failed")

    const entry = { address: rcpt.contractAddress, title }
    const recent = JSON.parse(localStorage.getItem(recentKey()) ?? "[]")
    localStorage.setItem(recentKey(), JSON.stringify([entry, ...recent].slice(0, 20)))
    setStatus("createStatus", `Deployed at ${entry.address}. Opening it…`, "ok")
    location.href = electionUrl(entry)
  } catch (e) {
    console.error(e)
    setStatus("createStatus", `Could not create the election at step "${step}": ${errMsg(e)}`, "err")
  } finally {
    btn.disabled = false
  }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
async function renderResults() {
  const total = Number(state.total)
  const ended = state.phase === "ended"
  const ranked = cfg.kind === "ranked"
  const label = ranked ? "first-choice" : ""
  const votes = (n) => `${n} ${label ? label + " " : ""}vote${n === 1 ? "" : "s"}`
  $("resultsTitle").textContent = ended ? "Final results" : "Live results"
  let html = ""
  if (ended) {
    try {
      const w = (await election.winners()).map((i) => state.cands[Number(i)])
      html += `<p class="winner">${w.length > 1 ? "Tie between " : "Winner: "}${w.map(esc).join(w.length > 1 ? " and " : "")}</p>`
    } catch (e) {
      html += `<p class="err">Couldn't work out the winner: ${esc(errMsg(e))}</p>`
    }
  }
  html += `<p class="muted">${total} vote${total === 1 ? "" : "s"} ${ended ? "cast" : "so far"}. Counts are public on-chain as votes come in, but no one can see who cast which.${
    ranked ? " The winner is decided by instant runoff, so they may not be the first-choice leader." : ""
  }</p>`
  state.cands.forEach((c, i) => {
    const n = Number(state.tally[i])
    html += `<div class="tally-row"><span>${esc(c)}</span><span class="muted">${votes(n)}</span></div><div class="bar-track"><div class="bar" style="width:${total ? (100 * n) / total : 0}%"></div></div>`
  })
  $("tally").innerHTML = html
}

// ---------------------------------------------------------------------------
// Helpers + wiring
// ---------------------------------------------------------------------------
const short = (x) => String(x).slice(0, 10) + "…"

$("connect").onclick = () => connect().catch((e) => log(e.message))
$("registerBtn").onclick = () => (account ? register() : connect().catch((e) => setStatus("regStatus", errMsg(e), "err")))
$("voteBtn").onclick = vote
$("refresh").onclick = refresh
$("createBtn").onclick = createElection
$("usernameBtn").onclick = saveUsername
$("lookupBtn").onclick = loadAccount
$("newWhitelist").addEventListener("input", previewWhitelist)
$("reclaimBtn").onclick = reclaim
$("identitySel").onchange = () => {
  voteResultShown = false
  $("exported").hidden = true
  $("exportBtn").textContent = "Show key"
  setStatus("keyStatus", "")
  renderKey()
  updateVoteButton()
}
$("downloadKeyBtn").onclick = downloadKey
$("copyKeyBtn").onclick = copyKey
$("exportBtn").onclick = toggleShowKey
$("importBtn").onclick = importKey
$("importFile").onchange = importKey
$("pasteKeyBtn").onclick = async () => {
  try {
    $("importTxt").value = await navigator.clipboard.readText()
    await importKey()
  } catch {
    setStatus("importStatus", "Couldn't read the clipboard. Type or paste the key below.", "err")
  }
}
wireHome()
wireWizard()
$("savedKey").onchange = () => {
  const x = selectedIdentity()
  if (!x) return
  if ($("savedKey").checked) localStorage.setItem(savedKey(x.identity.commitment), "1")
  else localStorage.removeItem(savedKey(x.identity.commitment))
  renderKey()
}

init().catch((e) => log(e.message))
