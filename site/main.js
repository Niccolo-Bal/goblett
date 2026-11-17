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
    $("title").textContent = `Chain not set up${NETWORK ? ` for /${NETWORK}` : ""} (run relayer/setup_chain.py, then reload)`
    return
  }
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
  if (!fromUrl && !cfg.election) {
    $("title").textContent = "No election selected. Create one below."
    $("createCard").open = true
    return
  }
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
    $("title").textContent = `No goblett election at ${fromUrl ?? cfg.election} on chain ${cfg.chainId}. Create one below.`
    $("createCard").open = true
    return
  }
  document.body.classList.add("has-election")
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
  if (account) {
    ;[state.whitelisted, state.registered] = await Promise.all([election.isWhitelisted(account), election.hasRegistered(account)])
  }
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
    const domain = { name: "goblett Election", version: "1", chainId: cfg.chainId, verifyingContract: cfg.election }
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
    step = "publish to Nostr"
    setStatus("regStatus", "Publishing to Nostr…", "muted")
    const sent = await publish(cfg, { type: "register", wallet: account, identityCommitment: identity.commitment.toString(), signature })
    log(`registration published to ${sent.accepted.join(", ")} (event ${short(sent.id)})`)
    step = "wait for a relayer to put it on-chain"
    setStatus("regStatus", "Waiting for a relayer to put it on-chain…", "muted")
    const wallet = account
    const res = await confirm(cfg, sent.id, () => election.hasRegistered(wallet))
    log(`registered on-chain${res.txHash ? `, tx ${res.txHash}` : ""}`)
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
    ? ids.map((x) => `<option value="${esc(x.label)}">${esc(x.label.startsWith("0x") ? "registered by " + x.label.slice(0, 10) + "…" : x.label)}</option>`).join("")
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
    // One call for the whole list (no event scan: Arc's RPC only serves small log ranges).
    const group = new Group([...(await election.commitments())])
    if (group.indexOf(identity.commitment) < 0) throw new Error("this identity is not registered in this election")

    const ballot = selectedBallot()
    const message = cfg.kind === "ranked" ? pack(ballot) : BigInt(ballot)
    // Bind the proof to this address: a look-alike contract could otherwise return
    // another election's scope and get a proof that counts there (R3-4).
    const scope = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "address"], [cfg.chainId, cfg.election])))
    if (scope !== (await election.scope())) throw new Error("This contract's scope does not match its address. It is not a genuine goblett election.")
    setStatus("voteStatus", `Generating zero-knowledge proof (${group.size} registered)… first time downloads the circuit, ~10-30 s`, "muted")
    const proof = await generateProof(identity, group, message, scope)

    setStatus("voteStatus", "Publishing proof to Nostr…", "muted")
    const body = { proof: { ...proof, points: proof.points.map(String) } }
    if (cfg.kind === "ranked") body.ranking = ballot
    const sent = await publish(cfg, { type: "vote", ...body })
    log(`vote published to ${sent.accepted.join(", ")} (event ${short(sent.id)})`)
    setStatus("voteStatus", "Waiting for a relayer to put it on-chain…", "muted")
    // Don't trust anyone's word: confirm() waits until the nullifier is used on-chain.
    const res = await confirm(cfg, sent.id, () => election.nullifierUsed(proof.nullifier))

    localStorage.setItem(votedKey(identity.commitment), "1")
    setStatus("voteStatus", `✓ Vote counted. Nullifier ${short(proof.nullifier)} is marked used on-chain.`, "ok")
    log(`vote on-chain${res.txHash ? `, tx ${res.txHash}` : ""}`)
    await refresh()
  } catch (e) {
    setStatus("voteStatus", `Vote failed: ${errMsg(e)}`, "err")
  } finally {
    updateVoteButton()
  }
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
    ? "<p class='muted'>Elections created from this browser:</p>" + recent.map((e) => `<div><a href="${electionUrl(e)}">${esc(e.title)}</a> <span class="muted">${e.address}</span></div>`).join("")
    : ""
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
// Per voter: one relayed registration (~200k gas) + one relayed vote (~400k), each with a bounty.
function updateFundingEstimate(price) {
  const voters = Math.max(1, lines("newWhitelist").length)
  let bounty = 0n
  try {
    bounty = ethers.parseEther($("newBounty").value || "0")
  } catch {}
  const estimate = BigInt(voters) * (600000n * price + 2n * bounty)
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
    const entered = lines("newWhitelist")
    const whitelist = [...new Set((entered.length ? entered : [account]).map((a) => {
      if (!ethers.isAddress(a)) throw new Error(`not an address: ${a}`)
      return ethers.getAddress(a)
    }))]
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
    setStatus("createStatus", `✓ Deployed at ${entry.address}. Opening it…`, "ok")
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
      html += `<p class="err">winners() failed: ${esc(errMsg(e))}</p>`
    }
  }
  $("tally").innerHTML = html
}

// ---------------------------------------------------------------------------
// Helpers + wiring
// ---------------------------------------------------------------------------
const short = (x) => String(x).slice(0, 10) + "…"

$("connect").onclick = () => connect().catch((e) => log(e.message))
$("registerBtn").onclick = register
$("voteBtn").onclick = vote
$("refresh").onclick = refresh
$("createBtn").onclick = createElection
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
