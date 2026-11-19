// The guided intro: a terminal "runs" goblett, then collapses into a chrome ballot
// token that walks the visitor through Register, Vote and Verify, one line at a time.
// Pure UI: it reads and sends nothing.

const $ = (id) => document.getElementById(id)
const SEEN = "goblett.introSeen"
const COMMAND = "goblett vote --private"
const OUTPUT = [
  ["✔", "register", "wallet checked, voter key made here"],
  ["✔", "seal", "your choice becomes a sealed token"],
  ["✔", "drop", "sent with no wallet attached"],
  ["✔", "count", "public, on-chain"],
  ["→", "guide", "your ballot"],
]
const STEPS = [
  ["Hi, I'm your ballot.", "Let me show you how this works."],
  ["First, register.", "Your wallet shows you're on the voter list, and a private voter key is made in this browser. It's free."],
  ["Then, vote.", "Tap a choice. I get sealed and dropped in the box with no wallet attached, so nobody can trace me to you."],
  ["Finally, verify.", "The count is public on-chain. Anyone can check the result."],
  ["That's it.", "Voters never pay. The organiser covers the costs."],
]

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches
const pace = (ms) => (calm() ? 0 : ms)

let run = 0 // bumps on every open/close so a stale sequence stops itself
let step = 0
let phase = "closed" // typing | ready | running | guide | closed
let actions = {}

function words(text, cls, from) {
  return text
    .split(" ")
    .map((w, i) => `<span class="w ${cls}" style="animation-delay:${pace((from + i) * 45)}ms">${w}</span>`)
    .join(" ")
}

function showStep(i) {
  step = i
  const [lead, rest] = STEPS[i]
  const n = lead.split(" ").length
  $("guideLine").innerHTML = `${words(lead, "lead", 0)} ${words(rest, "rest", n + 2)}`
  const token = document.querySelector(".guide-token")
  token.classList.remove("bob")
  void token.offsetWidth // restart the animation
  token.classList.add("bob")
  $("guideDots").innerHTML = STEPS.map((_, j) => `<li class="${j === i ? "on" : ""}"></li>`).join("")
  const last = i === STEPS.length - 1
  $("guideActions").innerHTML = last
    ? `<button data-go="join">Join an election</button><button class="secondary" data-go="create">Start one</button><button class="link" data-go="close">Look around</button>`
    : `<button class="link" data-go="next">Tap anywhere to continue</button>`
}

async function typeCommand(me) {
  $("termCmd").textContent = ""
  for (const ch of COMMAND) {
    if (me !== run) return
    $("termCmd").textContent += ch
    await wait(pace(55 + Math.random() * 50))
  }
  if (me !== run) return
  phase = "ready"
  $("intro").dataset.phase = "ready"
  $("termRun").focus({ preventScroll: true })
}

async function runCommand() {
  if (phase !== "ready") return
  const me = run
  phase = "running"
  $("intro").dataset.phase = "running"
  for (const [mark, key, text] of OUTPUT) {
    await wait(pace(260))
    if (me !== run) return
    $("termOut").insertAdjacentHTML("beforeend", `<p><b>${mark}</b> <span class="k">${key}</span> ${text}</p>`)
  }
  await wait(pace(700))
  if (me !== run) return
  $("intro").dataset.phase = "collapsing" // the card shrinks into the token
  await wait(pace(650))
  if (me !== run) return
  $("introTerm").hidden = true
  $("introGuide").hidden = false
  phase = "guide"
  $("intro").dataset.phase = "guide"
  showStep(0)
}

function advance() {
  if (phase === "ready") return runCommand()
  if (phase !== "guide" || step >= STEPS.length - 1) return
  showStep(step + 1)
}

export function openIntro() {
  run++
  phase = "typing"
  const el = $("intro")
  el.hidden = false
  el.dataset.phase = "typing"
  document.body.classList.add("intro-open")
  $("introTerm").hidden = false
  $("introGuide").hidden = true
  $("termOut").innerHTML = ""
  typeCommand(run)
}

export function closeIntro(go) {
  run++
  phase = "closed"
  try {
    localStorage.setItem(SEEN, "1")
  } catch {}
  $("intro").hidden = true
  document.body.classList.remove("intro-open")
  actions[go]?.()
}

// onJoin / onCreate: what the last step's buttons do.
export function wireIntro({ onJoin, onCreate }) {
  actions = { join: onJoin, create: onCreate }
  $("termRun").onclick = (e) => (e.stopPropagation(), runCommand())
  $("introSkip").onclick = () => closeIntro()
  $("introGuide").onclick = (e) => {
    const go = e.target.closest("button")?.dataset.go
    if (go === "next" || !go) return advance()
    if (go) closeIntro(go === "close" ? undefined : go)
  }
  document.addEventListener("keydown", (e) => {
    if (phase === "closed") return
    if (e.key === "Escape") return closeIntro()
    if (e.target.closest?.("#intro button")) return // a focused button handles its own Enter/Space
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowRight") {
      e.preventDefault()
      advance()
    }
  })
}

export function introSeen() {
  try {
    return localStorage.getItem(SEEN) === "1"
  } catch {
    return true
  }
}
