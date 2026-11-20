// Page chrome for app.html: the #new view, the five-step create wizard and the
// "open by address" form. Chain logic and every element main.js writes to live in main.js.

const $ = (id) => document.getElementById(id)

// ---------------------------------------------------------------------------
// Views: #new shows the create wizard, #signin the sign-in card, anything else the
// election (or the lobby).
// ---------------------------------------------------------------------------
function route() {
  const view = location.hash === "#new" ? "new" : location.hash === "#signin" ? "signin" : "election"
  document.body.dataset.view = view
  $("createCard").hidden = view !== "new"
  $("signinCard").hidden = view !== "signin"
  // Where to return to after signing in (main.js reads it).
  if (view !== "signin") sessionStorage.setItem("goblett:back", location.hash)
  for (const a of document.querySelectorAll("[data-nav]")) {
    const here = a.dataset.nav === view || (a.dataset.nav === "lobby" && view === "election" && !document.body.classList.contains("has-election"))
    if (here) a.setAttribute("aria-current", "page")
    else a.removeAttribute("aria-current")
  }
  if (view !== "election") window.scrollTo(0, 0)
}
window.addEventListener("hashchange", route)
route()

// The header's links ("Elections", "Start an election") are written for mainnet. On the
// testnet they must say so too, or following one reloads the page on mainnet.
if (new URLSearchParams(location.search).get("network") === "testnet" || location.pathname.split("/")[1] === "testnet") {
  for (const a of document.querySelectorAll("a[data-nav]")) {
    const to = new URL(a.href)
    to.searchParams.set("network", "testnet")
    a.href = to.pathname + to.search + to.hash
  }
}

// ---------------------------------------------------------------------------
// Create wizard
// ---------------------------------------------------------------------------
const steps = [...document.querySelectorAll(".wizard fieldset[data-step]")]
const tabs = [...document.querySelectorAll(".wizard-steps button")]
let current = 1

const lines = (id) => $(id).value.split("\n").map((x) => x.trim()).filter(Boolean)

// Checks that must pass before leaving a step. main.js repeats them at deploy time.
function problem(step) {
  if (step === 1) {
    if (!$("newTitle").value.trim()) return "Give the election a title."
    const c = lines("newCands")
    if (c.length < 2) return "Add at least two candidates, one per line."
    if (new Set(c).size !== c.length) return "Candidate names must be different."
  }
  if (step === 3) {
    const r = new Date($("newRegEnd").value).getTime()
    const v = new Date($("newVoteEnd").value).getTime()
    if (!r || !v) return "Set both dates."
    if (!(v > r)) return "Voting must end after registration ends."
  }
  return ""
}

function show(step) {
  current = step
  steps.forEach((f) => (f.hidden = Number(f.dataset.step) !== step))
  tabs.forEach((b) => {
    const n = Number(b.dataset.goto)
    b.classList.toggle("done", n < step)
    if (n === step) b.setAttribute("aria-current", "step")
    else b.removeAttribute("aria-current")
  })
  $("wizBack").style.visibility = step === 1 ? "hidden" : "visible"
  $("wizNext").hidden = step === steps.length
  if (step === steps.length) fillReview()
  setError("")
}

function setError(msg) {
  let el = $("wizError")
  if (!el) {
    el = document.createElement("p")
    el.id = "wizError"
    el.className = "err"
    el.setAttribute("role", "alert")
    el.style.margin = "16px 0 0"
    $("wizBack").parentElement.before(el)
  }
  el.textContent = msg
  el.hidden = !msg
}

function go(step) {
  // Moving forward checks every step on the way.
  for (let s = current; s < step; s++) {
    const why = problem(s)
    if (why) {
      show(s)
      return setError(why)
    }
  }
  show(step)
  steps[step - 1].querySelector("input, select, textarea")?.focus({ preventScroll: true })
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
function fillReview() {
  const when = (id) => ($(id).value ? new Date($(id).value).toLocaleString() : "—")
  const voters = lines("newWhitelist")
  const sym = document.querySelector(".sym")?.textContent ?? ""
  const rows = [
    ["Title", $("newTitle").value.trim() || "—"],
    ["Type", $("newKind").selectedOptions[0].textContent],
    ["Candidates", lines("newCands").join(", ") || "—"],
    ["Voters", voters.length ? `${voters.length} (${voters.slice(0, 4).join(", ")}${voters.length > 4 ? ", …" : ""})` : "Only your wallet"],
    ["Voting opens after", `${$("newMinAnon").value || Math.min(2, voters.length || 1)} registration(s)`],
    ["Registration ends", when("newRegEnd")],
    ["Voting ends", when("newVoteEnd")],
    ["Relayer funding", `${$("newFunding").value || "0"} ${sym}`],
  ]
  $("review").innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")
}

$("wizNext").onclick = () => go(current + 1)
$("wizBack").onclick = () => show(Math.max(1, current - 1))
tabs.forEach((b) => (b.onclick = () => go(Number(b.dataset.goto))))
show(1)

// ---------------------------------------------------------------------------
// Join: open an election from its invite link or contract address
// ---------------------------------------------------------------------------
function openElection(text) {
  const t = text.trim()
  const address = t.match(/0x[0-9a-fA-F]{40}/)?.[0]
  if (!address) {
    $("openStatus").innerHTML = `<p class="err">That doesn't look like a Goblett invite link. It should contain an address starting with 0x.</p>`
    return
  }
  const q = new URLSearchParams(location.search)
  q.set("election", address)
  // An invite link says which network the election is on; keep it.
  if (/[?&]network=testnet\b|\/testnet\b/.test(t)) q.set("network", "testnet")
  else if (/^https?:\/\//.test(t)) q.delete("network")
  $("openStatus").innerHTML = `<p class="muted">Opening the election…</p>`
  location.href = `/app.html?${q}`
}
$("openForm").addEventListener("submit", (ev) => {
  ev.preventDefault()
  openElection($("openInput").value)
})
$("joinOpen").onclick = () => {
  const box = $("joinBox")
  box.hidden = !box.hidden
  $("joinOpen").setAttribute("aria-expanded", String(!box.hidden))
  if (!box.hidden) box.scrollIntoView({ behavior: "smooth", block: "nearest" })
}
$("pasteLink").onclick = async () => {
  try {
    const text = await navigator.clipboard.readText()
    $("openInput").value = text
    openElection(text)
  } catch {
    $("openStatus").innerHTML = `<p class="err">Couldn't read the clipboard. Paste the link into the box below.</p>`
    $("openInput").focus()
  }
}
if (location.hash === "#join") $("joinOpen").click()

// ---------------------------------------------------------------------------
// Share: an invite link to the open election (the share sheet on phones, else the clipboard)
// ---------------------------------------------------------------------------
function inviteLink() {
  const here = new URLSearchParams(location.search)
  const q = new URLSearchParams({ election: here.get("election") ?? "" })
  const testnet = here.get("network") === "testnet" || location.pathname.split("/")[1] === "testnet"
  if (testnet) q.set("network", "testnet")
  return `${location.origin}/app.html?${q}`
}
$("shareBtn").onclick = async () => {
  const btn = $("shareBtn")
  const url = inviteLink()
  const title = $("title").textContent.trim()
  const coarse = matchMedia("(pointer: coarse)").matches // phones and tablets
  try {
    if (coarse && navigator.share) {
      await navigator.share({ title: `Vote: ${title}`, text: `You're invited to vote in "${title}" on Goblett.`, url })
      return
    }
    await navigator.clipboard.writeText(url)
    btn.textContent = "Link copied ✓"
  } catch (e) {
    if (e?.name === "AbortError") return // closed the share sheet
    prompt("Copy this invite link:", url)
  }
  setTimeout(() => (btn.textContent = "Copy invite link"), 2000)
}
