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

import "./fonts.js"
import { ethers } from "ethers"
import { Identity } from "@semaphore-protocol/identity"
import { Group } from "@semaphore-protocol/group"
import { generateProof } from "@semaphore-protocol/proof"

import { publish, confirm } from "./nostr.js"
import { ohttp } from "./ohttp.js"
import { usernamesOf, addressesOf, claimUsername, USERNAME_RE, USERNAME_RULES } from "./accounts.js"
import { electionsFor, listElection } from "./elections.js"
import { circleConfig, circleProvider, savedSession, forgetSession, loginWithEmail, loginWithGoogle, finishGoogleLogin } from "./circle-wallet.js"
import { matchKind } from "./election-kind.js"
// ABI + creation bytecode of both election types, exported by relayer/setup_chain.py.
import CONTRACTS from "./contracts.json"

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
// Resolves once init() has the chain config and a provider (false if it couldn't get them).
let chainReady
const whenChainReady = new Promise((resolve) => (chainReady = resolve))

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
// (Old /testnet links are redirected by index.html to app.html?network=testnet.)
const NETWORK =
  location.pathname.split("/")[1] === "testnet" || new URLSearchParams(location.search).get("network") === "testnet" ? "testnet" : null

// Messages for when no election can be shown go to the lobby, which is what's visible then.
const lobbyMessage = (msg, cls = "err") => {
  $("lobbyMsg").className = cls
  $("lobbyMsg").textContent = msg
}

async function init() {
  try {
    // Public chain config (RPC, Semaphore address, Nostr relays), written by relayer/setup_chain.py.
    // ?network=testnet reads election.testnet.json instead. Same page and code either way.
    cfg = await (await fetch(`/election${NETWORK ? "." + NETWORK : ""}.json`, { cache: "no-store" })).json()
  } catch {
    lobbyMessage(`Chain not set up${NETWORK ? ` for ${NETWORK}` : ""} (run relayer/setup_chain.py, then reload).`)
    chainReady(false)
    return
  }
  // The header's network switch: mark where we are, and name the chains.
  const here = $(NETWORK ? "netTest" : "netMain")
  here.setAttribute("aria-current", "true")
  here.title = `You're on ${cfg.chainName ?? "chain " + cfg.chainId}`
  const net = ethers.Network.from(cfg.chainId)
  provider = new ethers.JsonRpcProvider(cfg.rpcUrl, net, { staticNetwork: net, cacheTimeout: -1 })
  chainReady(true)
  showSigninOptions()
  showFundingOptions()
  initCreateForm().catch((e) => log(errMsg(e)))

  // Which election? ?election=0x... in the URL, else the config's default (if any).
  const q = new URLSearchParams(location.search)
  const fromUrl = q.get("election")
  if (!fromUrl && !cfg.election) return showLobby()
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
    lobbyMessage(`There's no Goblett election at ${fromUrl ?? cfg.election} on ${cfg.chainName ?? "chain " + cfg.chainId}. Check the address, or start a new one.`)
    return showLobby()
  }
  document.body.classList.add("has-election")
  document.title = "Goblett · Loading election…"
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

// ---------------------------------------------------------------------------
// Phase, countdown and progress steps (display only)
// ---------------------------------------------------------------------------
let clock // { chainAt, localAt }: the latest block's time and when we saw it
const chainSecondsNow = () => (clock ? clock.chainAt + (Date.now() - clock.localAt) / 1000 : Date.now() / 1000)
const until = (deadline) => {
  let s = Math.max(0, Math.round(Number(deadline) - chainSecondsNow()))
  const d = Math.floor(s / 86400)
  s -= d * 86400
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (x) => String(x).padStart(2, "0")
  return d ? `${d}d ${h}h ${pad(m)}m` : `${pad(h)}:${pad(m)}:${pad(sec)}`
}

function renderPhase() {
  if (!state) return
  const { phase, regEnd, vStart, vEnd } = state
  const now = chainSecondsNow()
  const pill = $("phasePill")
  pill.classList.toggle("ended", phase === "ended")
  $("phaseText").textContent =
    phase === "registration" ? `Registration · closes in ${until(regEnd)}`
    : phase === "frozen" ? `Voting opens in ${until(vStart)}`
    : phase === "voting" ? `Voting · closes in ${until(vEnd)}`
    : "Ended · final count"
  const fmtDate = (s) => new Date(Number(s) * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
  const votingShare = Math.min(1, Math.max(0, (now - Number(vStart)) / Math.max(1, Number(vEnd) - Number(vStart))))
  const seg = (label, sub, cls, fill) =>
    `<div class="${cls}"><div class="track"><i style="width:${Math.round(fill * 100)}%"></i></div><span><b>${label}</b> · ${sub}</span></div>`
  const order = ["registration", "frozen", "voting", "ended"].indexOf(phase)
  $("timeline").innerHTML =
    seg("Registration", `until ${fmtDate(regEnd)}`, order === 0 ? "now" : "done", 1) +
    seg("Voting", `until ${fmtDate(vEnd)}`, order === 2 ? "now" : order > 2 ? "done" : "", order === 2 ? votingShare : order > 2 ? 1 : 0) +
    seg("Result", order === 3 ? "final" : "after voting", order === 3 ? "now" : "", order === 3 ? 1 : 0)
}

// Ordered progress list for a long action. `at` is the step in progress (labels.length = all done).
function showSteps(id, labels, at, failed = false) {
  const el = $(id)
  el.hidden = false
  el.innerHTML = labels
    .map((l, i) => {
      const cls = i < at ? "done" : i === at ? (failed ? "failed" : "active") : ""
      const timer = i === at && !failed ? `<span class="t" data-start="${Date.now()}"></span>` : ""
      return `<li class="${cls}">${esc(l)}${timer}</li>`
    })
    .join("")
}

setInterval(() => {
  if (state && !document.hidden) renderPhase()
}, 1000)
setInterval(() => {
  for (const t of document.querySelectorAll(".progress [data-start]")) t.textContent = `${((Date.now() - Number(t.dataset.start)) / 1000).toFixed(1)}s`
}, 100)

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
  const t = (s) => new Date(Number(s) * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
  clock = { chainAt: Number(block.timestamp), localAt: Date.now() }

  $("title").textContent = title
  document.title = `Goblett · ${title}`
  $("elMeta").textContent = `${cfg.kind === "ranked" ? "Ranked choice" : "First past the post"} · ${cfg.chainName ?? "chain " + cfg.chainId}`
  $("info").innerHTML = `
    <dt>Contract</dt><dd>${cfg.explorerUrl ? `<a href="${cfg.explorerUrl}/address/${cfg.election}" target="_blank" rel="noopener">${cfg.election}</a>` : cfg.election}</dd>
    <dt>Chain time</dt><dd>${t(block.timestamp)}</dd>
    <dt>Registration</dt><dd>until ${t(regEnd)}</dd>
    <dt>Voting</dt><dd>${t(vStart)} → ${t(vEnd)}</dd>
    <dt>Relayer funding</dt><dd>${fmt(funds)} left${funds === 0n ? ' <span class="err">· relayers may refuse to forward</span>' : ""}</dd>
    <dt>Relayer bounty</dt><dd>${fmt(terms.bounty)} per registration or vote, plus gas</dd>
    <dt>Creator</dt><dd>${terms.creator}</dd>`
  $("reclaimBtn").hidden = !(phase === "ended" && funds > 0n)

  const n = (x) => Number(x).toLocaleString()
  $("stats").innerHTML = `
    <div><span class="k">Registered</span><span class="v">${n(regCount)}</span><span class="k">voting needs ${n(minAnon)}</span></div>
    <div><span class="k">Votes cast</span><span class="v">${n(total)}</span><span class="k">${regCount > 0n ? Math.round((100 * Number(total)) / Number(regCount)) : 0}% turnout</span></div>
    <div><span class="k">Anonymity set</span><span class="v">1 in ${n(regCount)}</span><span class="k">registered identities</span></div>
    <div><span class="k">Relayer funding</span><span class="v">${Number(ethers.formatEther(funds)).toLocaleString(undefined, { maximumFractionDigits: 4 })} <small>${esc(sym())}</small></span><span class="k">left for gas + bounties</span></div>`
  renderPhase()

  // Show only what this phase needs; once it's over, the result leads.
  const open = phase === "registration" || phase === "frozen"
  $("register").hidden = !open
  $("vote").hidden = phase !== "voting"
  const resultsHome = phase === "ended" ? document.querySelector(".el-cols > .primary") : document.querySelector(".el-cols > aside")
  if ($("results").parentElement !== resultsHome) resultsHome.prepend($("results"))
  $("res-h").textContent = phase === "ended" ? "Result" : "Live tally"

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
// The EIP-1193 provider we talk to: MetaMask, or the stand-in circle-wallet.js makes for
// someone who signed in by email or Google.
let eth
let circleLabel // their email, when signed in that way

const SIGNED_OUT = "goblett:signedOut" // set by "Sign out": don't reconnect by ourselves
let listening // the provider whose account changes we follow

// Someone who signed in by email shouldn't need to know there is a wallet underneath:
// they get plainer words, and no addresses. say() picks the wording; elements in
// app.html carry theirs in data-plain.
const plain = () => !!(account && eth?.isCircle)
const say = (withWallet, withEmail) => (plain() ? withEmail : withWallet)
function applyWording() {
  document.body.classList.toggle("plain", plain())
  for (const el of document.querySelectorAll("[data-plain]")) {
    el.dataset.wallet ??= el.textContent
    el.textContent = plain() ? el.dataset.plain : el.dataset.wallet
  }
}

function pickWallet() {
  const mm = wallets.find((w) => w.info.rdns === "io.metamask") ?? wallets.find((w) => w.info.rdns?.startsWith("io.metamask"))
  eth = mm?.provider ?? window.ethereum
  return mm
}

function useAccount(acc) {
  account = acc ? ethers.getAddress(acc) : undefined
  walletCache = undefined
  applyWording()
  resetAccount()
  loadLobby()
  showFunds()
  if (listening !== eth && eth?.on) {
    const wallet = (listening = eth)
    wallet.on("accountsChanged", (accs) => {
      // Not while signed out, or signed in some other way.
      if (eth !== wallet || localStorage.getItem(SIGNED_OUT)) return
      useAccount(accs[0])
      refresh()
    })
  }
}

// Adopt an email/Google session (from a sign-in just now, or saved in this browser).
function useCircle(session) {
  eth = circleProvider(session, provider, () => {
    signOut()
    location.hash = "#signin"
  })
  circleLabel = session.label
  localStorage.removeItem(SIGNED_OUT)
  useAccount(session.address)
}

// For actions that need an account: send a signed-out visitor to the sign-in card.
function requireAccount() {
  if (account) return
  location.hash = "#signin"
  throw new Error("sign in first")
}

async function connect() {
  const mm = pickWallet()
  if (!eth) throw new Error("MetaMask was not found in this browser. Install it, then reload this page.")
  log(`using wallet: ${mm ? mm.info.name : "window.ethereum"}${wallets.length > 1 ? ` (found ${wallets.map((w) => w.info.name).join(", ")})` : ""}`)
  const [acc] = await eth.request({ method: "eth_requestAccounts" })
  localStorage.removeItem(SIGNED_OUT)
  forgetSession() // one account at a time
  useAccount(acc)
  await refresh()
}

// ---- Sign in: connect the wallet, then make sure it has a username ----
// Which half of the sign-in card is showing.
function signinStep(step) {
  $("signinConnect").hidden = step !== "connect"
  $("signinName").hidden = step !== "name"
  if (step === "name") {
    $("signinWho").textContent = say(`${account.slice(0, 6)}…${account.slice(-4)}`, circleLabel)
    setStatus("claimStatus", "")
    // Offer the part of the email before the @, where that makes a valid username.
    const guess = plain() ? (circleLabel ?? "").split("@")[0].toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 20) : ""
    if (!$("newUsername").value && USERNAME_RE.test(guess)) $("newUsername").value = guess
    $("newUsername").focus()
  }
}

// Back to the view the visitor came from.
function leaveSignin() {
  signinStep("connect")
  setStatus("signinStatus", "")
  setStatus("claimStatus", "")
  $("newUsername").value = ""
  if (location.hash === "#signin") location.hash = sessionStorage.getItem("goblett:back") ?? ""
}

// After the wallet is connected: look its username up, and ask for one if it has none.
// The lookup sends the wallet address to goblett's server over a direct connection, so it
// runs only here, when the visitor signs in (the card says so), never on a page load (R4-3).
// (The lobby's election list is the exception: it asks for a signed-in wallet's elections
// whenever the lobby is shown. See loadLobby.)
async function afterConnect() {
  const wallet = account
  if (username) return leaveSignin()
  setStatus("signinStatus", "Looking up your username…", "hint")
  let name
  try {
    name = (await usernamesOf([wallet])).get(wallet.toLowerCase())
  } catch (e) {
    // The accounts service being down must not block signing in.
    log(`username lookup failed: ${errMsg(e)}`)
    return leaveSignin()
  }
  if (wallet !== account) return // the wallet changed while we were asking
  if (name) {
    rememberUsername(name)
    leaveSignin()
  } else {
    setStatus("signinStatus", "")
    signinStep("name")
  }
}

// One sign-in at a time, whichever way.
async function signingIn(message, how) {
  const buttons = ["connect", "emailBtn", "googleBtn"].map($)
  for (const b of buttons) b.disabled = true
  setStatus("signinStatus", message, "hint")
  try {
    await how()
    await afterConnect()
  } catch (e) {
    log(errMsg(e))
    setStatus("signinStatus", e.code === 4001 ? "Sign-in cancelled." : errMsg(e), "err")
  } finally {
    for (const b of buttons) b.disabled = false
  }
}

const signIn = () => signingIn("Approve the connection in MetaMask…", connect)

// By email: Circle emails a code and asks for it in its own window (circle-wallet.js).
function signInWithEmail(ev) {
  ev.preventDefault()
  const email = $("emailInput").value.trim()
  return signingIn(`We're emailing a code to ${email}. Enter it in the window that opens.`, async () => {
    useCircle(await loginWithEmail(cfg.chainId, email))
    await refresh()
  })
}

// By Google: the page leaves for Google and comes back; restoreSession() finishes it.
const signInWithGoogle = () => signingIn("Taking you to Google…", () => loginWithGoogle(cfg.chainId))

// Which ways to sign in this network offers. Email and Google need the server's Circle
// key to cover the network; without them the card is MetaMask only, as before.
async function showSigninOptions() {
  const { available, google } = await circleConfig(cfg.chainId)
  $("emailForm").hidden = !available
  $("googleBtn").hidden = !google
  $("connect").classList.toggle("btn-blue", !available)
  $("connect").classList.toggle("btn-ghost", !!available)
  // Testnet and mainnet each need their own Circle key on the server. If only the other
  // network has one, say so and point there, rather than showing MetaMask alone.
  $("emailElsewhere").hidden = true
  if (available) return
  try {
    const other = await (await fetch(`/election${NETWORK ? "" : ".testnet"}.json`, { cache: "no-store" })).json()
    if (!(await circleConfig(other.chainId)).available) return
    $("emailElsewhereLink").textContent = `Use it on ${other.chainName ?? "the other network"}`
    $("emailElsewhereLink").href = `/app.html${NETWORK ? "" : "?network=testnet"}#signin`
    $("emailElsewhere").hidden = false
  } catch {}
}

// The "Pick a username" form on the sign-in card.
async function claimAtSignin(ev) {
  ev.preventDefault()
  const wanted = $("newUsername").value.trim().toLowerCase()
  if (!USERNAME_RE.test(wanted)) return setStatus("claimStatus", `A username is ${USERNAME_RULES}.`, "err")
  $("claimBtn").disabled = true
  setStatus("claimStatus", say("Sign the username in MetaMask…", "Confirm it in the window that opens…"), "hint")
  try {
    const saved = await claimUsername(eth, account, wanted)
    rememberUsername(saved.username)
    leaveSignin()
  } catch (e) {
    setStatus("claimStatus", e.code === 4001 ? "Signature cancelled." : errMsg(e), "err")
  } finally {
    $("claimBtn").disabled = false
  }
}

// A site can't disconnect a wallet; signing out forgets the account here and stops the
// page from picking it up again until the next sign-in.
function signOut() {
  localStorage.setItem(SIGNED_OUT, "1")
  forgetSession()
  if (eth?.isCircle) eth = undefined
  useAccount(undefined)
  refresh()
}

// If this site is already connected in the wallet (and the visitor didn't sign out), pick
// the account up without a prompt. eth_accounts never opens MetaMask.
async function restoreSession() {
  if (!(await whenChainReady)) return
  // Back from Google with a sign-in to finish?
  try {
    const fresh = await finishGoogleLogin(cfg.chainId)
    if (fresh) {
      useCircle(fresh)
      refresh()
      location.hash = "#signin" // the card goes on to the username check, then closes
      return
    }
  } catch (e) {
    log(errMsg(e))
    location.hash = "#signin"
    setStatus("signinStatus", e.code === 4001 ? "Sign-in cancelled." : errMsg(e), "err")
    return
  }
  if (account || localStorage.getItem(SIGNED_OUT)) return
  const saved = savedSession(cfg.chainId)
  if (saved) {
    useCircle(saved)
    refresh()
    return
  }
  pickWallet()
  if (!eth) return
  const [acc] = await eth.request({ method: "eth_accounts" }).catch(() => [])
  if (!acc) return
  useAccount(acc)
  refresh()
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
  btn.disabled = true
  if (!account) {
    $("regStatus").innerHTML = '<p class="hint">Registering needs the account the organiser added as a voter. <a href="#signin">Sign in</a></p>'
    return
  }
  if (state.phase !== "registration") return setStatus("regStatus", `Registration is closed (phase: ${state.phase}).`, "hint")
  if (state.walletErr) return setStatus("regStatus", `Could not check this wallet over the private channel: ${state.walletErr}`, "err")
  if (!state.whitelisted) {
    return setStatus("regStatus", say(`${account} is not on this election's whitelist.`, `You're not on this election's voter list. Ask the organiser to add ${username ? `your username, ${username}` : "you"}.`), "err")
  }
  if (state.registered) {
    const local = loadIdentities().some((x) => x.label === account.toLowerCase())
    return setStatus(
      "regStatus",
      local
        ? say("✓ Registered. Your identity is stored in this browser.", "✓ Registered. Come back to this browser to vote once voting opens.")
        : say("This wallet is registered, but its identity is not in this browser. Import the secret to vote.", "You registered from another browser. Vote from that one, or import your voting key here."),
      local ? "ok" : "err"
    )
  }
  setStatus("regStatus", "")
  btn.disabled = false
}

const regSteps = () =>
  say(["Sign the registration in your wallet", "Send it privately to the relayers", "A relayer puts it on-chain"], ["Confirm your registration", "Send it privately", "Added to the voter list"])
async function register() {
  $("registerBtn").disabled = true
  const REG_STEPS = regSteps()
  let at = 0
  const progress = (i) => showSteps("regSteps", REG_STEPS, (at = i))
  progress(0)
  let step = "check wallet network"
  try {
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
    setStatus("regStatus", say("Sign the registration in MetaMask…", "Confirm it in the window that opens…"), "muted")
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
    progress(1)
    setStatus("regStatus", "")
    const sent = await publish(cfg, {
      type: "register",
      wallet: account,
      identityCommitment: identity.commitment.toString(),
      signature,
      ...(onElectionChain ? {} : { signingChainId: walletChain }),
    })
    log(`registration published${sent.private ? " through the private channel" : ""} to ${sent.accepted.join(", ")} (event ${short(sent.id)})`)
    step = "wait for a relayer to put it on-chain"
    progress(2)
    const wallet = account
    const priv = await privateElection()
    const res = await confirm(cfg, sent.id, () => priv.hasRegistered(wallet))
    progress(REG_STEPS.length)
    log(`registered on-chain${res.txHash ? `, tx ${res.txHash}` : ""}`)
    walletCache = undefined
    await refresh()
  } catch (e) {
    console.error(e)
    showSteps("regSteps", REG_STEPS, at, true)
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
    ? ids.map((x) => `<option value="${esc(x.label)}">${esc(plain() && x.label === account.toLowerCase() ? "Your voting key" : x.label.startsWith("0x") ? "registered by " + x.label.slice(0, 10) + "…" : x.label)}</option>`).join("")
    : `<option value="">(no identity in this browser)</option>`
  if (ids.some((x) => x.label === prev)) sel.value = prev
}

function renderBallot() {
  const box = $("ballot")
  if (cfg.kind === "ranked") {
    box.innerHTML =
      `<p class="faint">Tap candidates in order of preference. You can stop early.</p>` +
      state.cands.map((c, i) => `<label><input type="checkbox" data-i="${i}" /><span class="rank" id="rank${i}"></span>${esc(c)}</label>`).join("")
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

const VOTE_STEPS = ["Rebuild the voter group", "Make the zero-knowledge proof (10–30 s)", "Send it privately to the relayers", "Counted on Arc"]
async function vote() {
  $("voteBtn").disabled = true
  let at = 0
  const progress = (i) => showSteps("voteSteps", VOTE_STEPS, (at = i))
  try {
    const { identity } = loadIdentities().find((x) => x.label === $("identitySel").value)
    if (localStorage.getItem(votedKey(identity.commitment))) {
      if (!confirm("This identity already voted from this browser. A second vote will be rejected. Continue?")) return
    }
    voteResultShown = true
    setStatus("voteStatus", "")
    progress(0)
    // One call for the whole list (no event scan: Arc's RPC only serves small log ranges).
    const priv = await privateElection()
    const group = new Group([...(await priv.commitments())])
    if (group.indexOf(identity.commitment) < 0) throw new Error("this identity is not registered in this election")

    const ballot = selectedBallot()
    const message = cfg.kind === "ranked" ? pack(ballot) : BigInt(ballot)
    // Bind the proof to this address: a look-alike contract could otherwise return
    // another election's scope and get a proof that counts there (R3-4).
    const scope = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "address"], [cfg.chainId, cfg.election])))
    if (scope !== (await priv.scope())) throw new Error("This contract's scope does not match its address. It is not a genuine goblett election.")
    progress(1)
    if (group.depth > PROOF_DEPTH) throw new Error(`groups deeper than ${PROOF_DEPTH} are not supported`)
    const proof = await generateProof(identity, group, message, scope, PROOF_DEPTH, PROOF_ARTIFACTS)

    progress(2)
    const body = { proof: { ...proof, points: proof.points.map(String) } }
    if (cfg.kind === "ranked") body.ranking = ballot
    const sent = await publish(cfg, { type: "vote", ...body })
    log(`vote published${sent.private ? " through the private channel" : ""} to ${sent.accepted.join(", ")} (event ${short(sent.id)})`)
    progress(3)
    // Don't trust anyone's word: confirm() waits until the nullifier is used on-chain.
    const res = await confirm(cfg, sent.id, () => priv.nullifierUsed(proof.nullifier))

    localStorage.setItem(votedKey(identity.commitment), "1")
    progress(VOTE_STEPS.length)
    setStatus("voteStatus", `Your vote is counted. Receipt: nullifier ${short(proof.nullifier)}, now marked used on-chain. Nothing links it to your wallet.`, "ok")
    log(`vote on-chain${res.txHash ? `, tx ${res.txHash}` : ""}`)
    await refresh()
  } catch (e) {
    if (voteResultShown) showSteps("voteSteps", VOTE_STEPS, at, true)
    setStatus("voteStatus", `Vote failed: ${errMsg(e)}`, "err")
  } finally {
    updateVoteButton()
  }
}

// ---------------------------------------------------------------------------
// Accounts: a public username for the connected wallet (accounts.js). Optional, and
// separate from voting: nothing here runs while a vote is cast.
// ---------------------------------------------------------------------------
let username // of the connected wallet, if it has one

function renderAccount() {
  const shortAcc = account && `${account.slice(0, 6)}…${account.slice(-4)}`
  $("account").textContent = !account ? "" : plain() ? (username ?? circleLabel ?? "Signed in") : username ? `${username} · ${shortAcc}` : shortAcc
  $("account").title = account ?? ""
  $("signinLink").hidden = !!account
  $("signout").hidden = !account
}

// Usernames this browser has already learned, so a reload doesn't ask the server again.
const nameKey = (acc) => `goblett:username:${acc.toLowerCase()}`
function rememberUsername(name) {
  username = name || undefined
  if (account) {
    if (username) localStorage.setItem(nameKey(account), username)
    else localStorage.removeItem(nameKey(account))
  }
  renderAccount()
}

// A new (or no) wallet: show what this browser already knows about it. Asking the server
// is left to sign-in (R4-3).
function resetAccount() {
  username = (account && localStorage.getItem(nameKey(account))) || undefined
  renderAccount()
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
// Lobby: the elections that whitelist the signed-in wallet, or that it started, from
// goblett's server (elections.js). Asking sends the wallet's address there, as signing in
// does, so it happens only on the lobby and never while an election is open.
// ---------------------------------------------------------------------------
const electionUrl = (e) => `/app.html?election=${e.address}${NETWORK ? "&network=" + NETWORK : ""}`
let lobbyShown = false // set once init() knows no election is being opened
let lobbyLoad = 0

function showLobby() {
  lobbyShown = true
  return loadLobby()
}

const listMessage = (html, cls = "muted") => {
  $("listMsg").className = cls
  $("listMsg").innerHTML = html
}

async function loadLobby() {
  if (!lobbyShown) return
  const load = ++lobbyLoad
  $("myElections").innerHTML = ""
  if (!account) return listMessage('Elections you can vote in show up here. <a href="#signin">Sign in</a> with the wallet you were whitelisted with.')
  listMessage("Looking up your elections…")
  const wallet = account
  try {
    await listPending()
    const found = await electionsFor(cfg.chainId, wallet)
    if (load !== lobbyLoad) return // the wallet changed while we were asking
    if (!found.length) return listMessage(`No current election lists ${say(`${esc(wallet.slice(0, 6))}…${esc(wallet.slice(-4))}`, "you")} as a voter.`)
    listMessage("")
    const now = Date.now() / 1000
    const day = (s) => new Date(s * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    const when = (e) =>
      now < e.registrationEnd ? `Registration open until ${day(e.registrationEnd)}`
      : now < e.votingStart ? `Voting opens ${day(e.votingStart)}`
      : now < e.votingEnd ? `Voting open until ${day(e.votingEnd)}`
      : `Ended ${day(e.votingEnd)}`
    // Open elections first (soonest deadline first), then ended ones.
    const ended = (e) => now >= e.votingEnd
    $("myElections").innerHTML = [...found.filter((e) => !ended(e)), ...found.filter(ended).reverse()]
      .map((e) => `<a href="${esc(electionUrl(e))}"${ended(e) ? ' class="ended"' : ""}>
        <span class="t">${esc(e.title)}</span>
        <span class="m">${esc(when(e))} · ${e.kind === "ranked" ? "Ranked choice" : "First past the post"}${e.whitelisted ? "" : " · you started it, but aren't a voter"}</span>
      </a>`)
      .join("")
  } catch (e) {
    if (load === lobbyLoad) listMessage(`Couldn't load your elections: ${esc(errMsg(e))}`, "err")
  }
}

// Elections deployed from this browser that the server hasn't listed yet (it was
// unreachable, or its chain node hadn't seen the new contract). Retried from the lobby.
const pendingKey = () => `goblett:unlisted:${cfg.chainId}`
async function listPending() {
  const left = []
  for (const p of JSON.parse(localStorage.getItem(pendingKey()) ?? "[]")) {
    try {
      await listElection(cfg.chainId, p.address, p.voters)
    } catch (e) {
      left.push(p)
      log(`could not list ${p.address} for its voters yet: ${errMsg(e)}`)
    }
  }
  if (left.length) localStorage.setItem(pendingKey(), JSON.stringify(left))
  else localStorage.removeItem(pendingKey())
  return left
}

// ---------------------------------------------------------------------------
// Create an election (deployed from the connected wallet, which pays the gas)
// ---------------------------------------------------------------------------
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
  const now = await chainNow()
  $("newRegEnd").value = toLocalInput(now + 15 * 60)
  $("newVoteEnd").value = toLocalInput(now + 45 * 60)
  // Relayer payment defaults: refund gas up to twice today's price.
  const price = await gasPriceNow()
  $("newMaxGasPrice").value = Math.ceil(Number(ethers.formatUnits(2n * price, "gwei")))
  for (const el of document.querySelectorAll(".sym")) el.textContent = sym()
  for (const id of ["newWhitelist", "newBounty", "newMaxGasPrice"]) $(id).addEventListener("input", () => updateFundingEstimate(price))
  updateFundingEstimate(price)
  $("chainClock").textContent = `Chain time is now ${new Date(now * 1000).toLocaleString()}. Deadlines are checked against the chain's clock, which on a local test chain can differ from yours.`
}

const sym = () => cfg.nativeCurrency?.symbol ?? ""
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
  showFunds()
}

// ---------------------------------------------------------------------------
// Paying for it: the account's balance next to what the election needs, and a way to
// top it up. On the testnet that is a faucet (functions/api/faucet.js); on mainnet,
// buying USDC through Circle's on-ramp widget (functions/api/onramp.js).
// ---------------------------------------------------------------------------
// Deploying costs about 3M gas on top of the funding sent along; allow twice today's price.
const DEPLOY_GAS = 3000000n
let fundsShown = 0
async function showFunds() {
  $("fundBox").hidden = !account
  if (!account || !provider) return
  const shown = ++fundsShown
  try {
    const [balance, price] = await Promise.all([provider.getBalance(account), gasPriceNow()])
    if (shown !== fundsShown) return
    let funding = 0n
    try {
      funding = ethers.parseEther($("newFunding").value || "0")
    } catch {}
    const need = funding + 2n * price * DEPLOY_GAS
    $("fundBalance").textContent = fmt(balance)
    $("fundBalance").classList.toggle("err", balance < need)
    $("fundNeed").textContent = balance < need ? `This election needs about ${fmt(need)}: the funding above plus the cost of creating it.` : "Enough for this election."
  } catch {
    if (shown === fundsShown) $("fundBalance").textContent = "couldn't read it"
  }
}

// Which top-ups this network has. The faucet exists only on the testnet. Buying is
// offered on mainnet only: Circle's sandbox, which is what a testnet would get, hands out
// nothing an election here could be paid with.
const serviceConfig = (name) =>
  fetch(`/api/${name}?chainId=${cfg.chainId}`)
    .then((r) => r.json())
    .catch(() => ({ available: false }))
async function showFundingOptions() {
  const [faucet, onramp] = await Promise.all([serviceConfig("faucet"), serviceConfig("onramp")])
  $("faucetBtn").hidden = !faucet.available
  if (faucet.available) $("faucetBtn").textContent = `Get ${faucet.amount} of test funds`
  $("onrampBtn").hidden = !(onramp.available && !NETWORK)
}

async function useFaucet() {
  $("faucetBtn").disabled = true
  setStatus("fundStatus", "Sending test funds…", "hint")
  try {
    const r = await fetch("/api/faucet", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chainId: cfg.chainId, address: account }) })
    const out = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(out.error ?? `the faucet is unavailable (HTTP ${r.status})`)
    log(`faucet sent ${out.amount} (tx ${out.txHash})`)
    setStatus("fundStatus", `${out.amount} is on its way…`, "hint")
    await provider.waitForTransaction(out.txHash, 1, 60000)
    setStatus("fundStatus", `✓ ${out.amount} added.`, "ok")
  } catch (e) {
    setStatus("fundStatus", `Couldn't get test funds: ${errMsg(e)}`, "err")
  } finally {
    $("faucetBtn").disabled = false
    showFunds()
  }
}

// Circle's on-ramp widget, mounted in the funding step. Loaded only when it's opened.
let onrampWidget
async function openOnramp() {
  $("onrampBtn").disabled = true
  setStatus("fundStatus", "Opening Circle's checkout…", "hint")
  try {
    const { createOnrampKit, parseOnrampSession } = await import("@circle-fin/onramp-kit")
    const r = await fetch("/api/onramp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chainId: cfg.chainId, address: account }) })
    const out = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(out.error ?? `buying funds is unavailable (HTTP ${r.status})`)
    const { widgetBaseUrl, ...session } = out
    closeOnramp()
    $("onrampPanel").hidden = false
    onrampWidget = createOnrampKit({ widgetBaseUrl }).mountIframe({
      session: parseOnrampSession(session),
      container: $("onrampRoot"),
      onInitializationSuccess: () => setStatus("fundStatus", ""),
      onInitializationError: ({ code }) => setStatus("fundStatus", `Circle's checkout didn't load (${code}).`, "err"),
      onDepositSubmitted: () => {
        setStatus("fundStatus", "Payment sent. Your balance updates when the funds arrive, usually within a few minutes.", "hint")
        watchForFunds()
      },
      onDepositSettled: ({ payload }) => {
        setStatus("fundStatus", `✓ ${payload?.amount ?? ""} ${payload?.tokenSymbol ?? sym()} added.`, "ok")
        showFunds()
      },
      onDepositNotCompleted: ({ code }) => setStatus("fundStatus", code === "CANCELED_BY_CUSTOMER" ? "Purchase cancelled." : `The purchase didn't complete (${code}).`, "err"),
      onSessionExpired: () => {
        closeOnramp()
        setStatus("fundStatus", "That checkout timed out. Open it again to continue.", "hint")
      },
    })
    $("onrampPanel").scrollIntoView({ behavior: "smooth", block: "nearest" })
  } catch (e) {
    closeOnramp()
    setStatus("fundStatus", `Couldn't open the checkout: ${errMsg(e)}`, "err")
  } finally {
    $("onrampBtn").disabled = false
  }
}

function closeOnramp() {
  onrampWidget?.close()
  onrampWidget = undefined
  $("onrampRoot").innerHTML = ""
  $("onrampPanel").hidden = true
}

// The widget's own "settled" message is best effort, so also watch the chain for a while.
let fundsWatch
function watchForFunds() {
  clearInterval(fundsWatch)
  let checks = 0
  fundsWatch = setInterval(() => {
    if (++checks > 60 || !account) return clearInterval(fundsWatch)
    showFunds()
  }, 10000)
}

// After voting ends, anyone can send the unused relayer funding back to the creator.
async function reclaim() {
  try {
    requireAccount()
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

    step = "sign in"
    requireAccount()
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
      throw new Error(
        say(`${account} has ${fmt(balance)}, not enough`, `Your balance is ${fmt(balance)}, not enough`) +
          ` for ${fmt(funding)} of relayer funding plus the deployment gas.` +
          say("", ` Add ${sym()} on ${cfg.chainName ?? "this network"} to your account's address, ${account}.`) +
          (cfg.chainId === 31337 ? ` On the local test chain run: python setup_chain.py --fund ${account}` : "")
      )
    }

    step = "confirm the deployment"
    setStatus("createStatus", say("Confirm the deployment in MetaMask…", "Confirm it in the window that opens…"), "muted")
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

    // Tell goblett's server, so the election shows up for its voters when they sign in.
    // Saved first: if this fails, the lobby retries it later (listPending).
    step = "list the election for its voters"
    const entry = { address: rcpt.contractAddress, voters: whitelist }
    localStorage.setItem(pendingKey(), JSON.stringify([...JSON.parse(localStorage.getItem(pendingKey()) ?? "[]"), entry]))
    setStatus("createStatus", `✓ Deployed at ${entry.address}. Adding it to your voters' election lists…`, "ok")
    await listPending()
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
  const label = cfg.kind === "ranked" ? "first preferences" : "votes"
  let head = ""
  if (state.phase === "ended") {
    try {
      const w = (await election.winners()).map((i) => state.cands[Number(i)])
      head = `<p class="winner">${w.length > 1 ? `Tie: ${w.map(esc).join(", ")}` : `${esc(w[0])} wins`}</p>`
    } catch (e) {
      head = `<p class="err">Couldn't read the winner: ${esc(errMsg(e))}</p>`
    }
  }
  const top = Math.max(0, ...state.tally.map(Number))
  const rows = state.cands
    .map((c, i) => {
      const n = Number(state.tally[i])
      const lead = top > 0 && n === top ? " lead" : ""
      return `<div class="tline${lead}"><div>${esc(c)}<span>${n}</span></div><div class="track"><i style="width:${total ? (100 * n) / total : 0}%"></i></div></div>`
    })
    .join("")
  const foot = `<p class="faint">${total} ${total === 1 ? label.replace(/s$/, "") : label}. ${state.phase === "ended" ? "Final, on-chain." : "Public on-chain by design; who voted for whom is not."}</p>`
  $("tally").innerHTML = head + rows + foot
}

// ---------------------------------------------------------------------------
// Helpers + wiring
// ---------------------------------------------------------------------------
const short = (x) => String(x).slice(0, 10) + "…"

$("connect").onclick = signIn
$("emailForm").addEventListener("submit", signInWithEmail)
$("googleBtn").onclick = signInWithGoogle
$("signinName").addEventListener("submit", claimAtSignin)
$("skipUsername").onclick = leaveSignin
// Opening the sign-in view while already signed in goes straight to the username check.
window.addEventListener("hashchange", () => {
  if (location.hash !== "#signin") return
  if (account) afterConnect().catch((e) => log(errMsg(e)))
  else if (cfg) showSigninOptions() // again, in case the first lookup failed
})
$("signout").onclick = signOut
$("registerBtn").onclick = register
$("voteBtn").onclick = vote
$("refresh").onclick = refresh
$("createBtn").onclick = createElection
$("faucetBtn").onclick = useFaucet
$("onrampBtn").onclick = openOnramp
$("onrampClose").onclick = closeOnramp
$("newFunding").addEventListener("input", showFunds)
$("newWhitelist").addEventListener("input", previewWhitelist)
$("reclaimBtn").onclick = reclaim
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
// Wallet extensions announce themselves just after load; give them a moment.
setTimeout(() => restoreSession().catch(() => {}), 300)
