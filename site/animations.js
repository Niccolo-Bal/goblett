// The register and vote animations. Pure UI: they read and send nothing.
//
// main.js reports progress through showSteps(), which fires a "goblett:steps" event:
// { id: "regSteps" | "voteSteps", at, total, failed }. Each step index maps to a stage:
//
//   regSteps   0 sign  → a voter key is made, then waits for the signature
//              1 send  → a token of its public half flies to the voter list
//              2 chain → it waits there while a relayer records it
//              total   → the row fills in: registered
//
//   voteSteps  0 group → the chosen candidate on a card
//              1 proof → the choice scrambles into ciphertext (the proof is being made)
//              2 send  → the card becomes a liquid-metal token and drops into the box
//              3 chain → the box waits while the vote is recorded
//              total   → counted
//
// The codes shown are random. Neither the identity secret nor the proof reaches the screen.

const $ = (id) => document.getElementById(id)
const hex = (n) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("")
const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches
const later = (ms, fn) => setTimeout(fn, calm() ? 0 : ms)

// ---- registering: the voter key ----
const FORGE_NOTE = {
  forging: "Creating it in this browser…",
  signing: "Waiting for your signature",
  sending: "Sending its public half",
  recording: "Being added to the list",
  registered: "Saved in this browser",
}
let forgeTimer
function forge(state) {
  const el = $("keyForge")
  if (!el) return
  if (!state) {
    clearInterval(forgeTimer)
    el.hidden = true
    return
  }
  el.hidden = false
  el.dataset.state = state
  $("forgeNote").textContent = FORGE_NOTE[state]
  $("forgeListLabel").textContent = state === "registered" ? "Registered" : state === "recording" ? "Recording" : "Voter list"
}
function onRegister({ at, total, failed }) {
  if (failed) return forge(null)
  if (at === 0) {
    forge("forging")
    clearInterval(forgeTimer)
    forgeTimer = setInterval(() => ($("forgeText").textContent = `0x${hex(4)}…${hex(4)}`), 55)
    later(1100, () => {
      clearInterval(forgeTimer)
      if ($("keyForge").dataset.state === "forging") forge("signing")
    })
  } else if (at === 1) {
    clearInterval(forgeTimer)
    forge("sending")
  } else if (at === 2) forge("recording")
  else if (at >= total) forge("registered")
}

// ---- voting: the sealed ballot ----
let sealTimer
function seal(state, text) {
  const el = $("sealer")
  if (!el) return
  const vote = $("vote")
  if (!state) {
    clearInterval(sealTimer)
    el.hidden = true
    vote?.classList.remove("sealing")
    return
  }
  el.hidden = false
  el.dataset.state = state
  vote?.classList.add("sealing")
  if (text !== undefined) $("sealText").textContent = text
  $("sealBoxLabel").textContent = state === "counted" ? "Counted" : state === "inbox" ? "Recording" : "Ballot box"
}
// What the voter picked, as it reads on the ballot.
function choiceLabel() {
  const picked = [...document.querySelectorAll("#ballot input:checked")]
  const names = picked.map((i) => i.closest("label")?.textContent.trim() ?? "")
  const ranked = picked.some((i) => i.type === "checkbox")
  if (!ranked) return names[0] || "Your choice"
  // Ranked: order by the rank badge, not by position on the page.
  const order = picked.map((i) => [Number(i.closest("label")?.querySelector(".rank")?.textContent || 99), i.closest("label")?.textContent.replace(/^\d+/, "").trim()])
  return order.sort((a, b) => a[0] - b[0]).map(([n, t], k) => `${k + 1}. ${t}`).join("   ")
}
function onVote({ at, total, failed }) {
  if (failed) return seal(null)
  if (at === 0) seal("ready", choiceLabel())
  else if (at === 1) {
    seal("sealing")
    const src = $("sealText").textContent.padEnd(16).slice(0, 22)
    let n = 0
    clearInterval(sealTimer)
    sealTimer = setInterval(() => {
      n = Math.min(src.length, n + 1)
      $("sealText").textContent = hex(n) + src.slice(n)
    }, 45)
  } else if (at === 2) {
    clearInterval(sealTimer)
    seal("sealed", `0x${hex(4)}…${hex(4)}`)
    later(600, () => $("sealer").dataset.state === "sealed" && seal("dropping"))
  } else if (at === 3) {
    const go = () => seal("inbox")
    // Let the token finish its drop before the box starts waiting.
    $("sealer").dataset.state === "sealed" ? later(1300, go) : later(900, go)
  } else if (at >= total) later(400, () => seal("counted"))
}

document.addEventListener("goblett:steps", (e) => {
  if (e.detail.id === "regSteps") onRegister(e.detail)
  else if (e.detail.id === "voteSteps") onVote(e.detail)
})
