// How it Works (why.html): one ballot's journey as a scroll story.
//
// The stage is pinned while the reader scrolls through #story. Scroll position becomes a
// progress value p from 0 to 8, one unit per scene, and every piece on the 600 × 440 board
// is placed from keyframes on p. Nothing runs on a timer, so scrolling back plays it in
// reverse. The displayed p eases toward the scroll position so the motion stays smooth.

const SCENES = 8
const story = document.getElementById("story")
const board = document.getElementById("board")
const view = board.parentElement
const caps = [...document.querySelectorAll(".pl-cap")]
const progress = document.getElementById("progress")
const cue = document.getElementById("scrollCue")
const reduce = matchMedia("(prefers-reduced-motion: reduce)")
const el = (name) => board.querySelector(`[data-el="${name}"]`)

// Board coordinates. The voter list's rows: row i is centred at y = 151 + 28 i.
const ROW = (i) => 151 + 28 * i
const STOPS = [70, 170, 270, 370]

// Keyframes: [p, { x, y, s (scale), o (opacity) }]. Missing values carry over from the key before.
const TRACKS = {
  token: [
    [0, { x: 300, y: 196, s: 1, o: 1 }], [0.35, {}], [0.9, { x: 412, y: 196, s: 0.66 }],
    [1.3, { x: 300, y: 250, s: 0.4 }], [2.0, {}], [2.4, { x: 150, y: 250, s: 0.36 }],
    [4.4, {}], [4.75, { s: 0.48 }],
    [6.0, { x: 150, y: 250 }], [6.15, { x: 240, y: STOPS[0], s: 0.3 }], [6.22, {}],
    [6.36, { y: STOPS[1] }], [6.47, {}], [6.61, { y: STOPS[2] }], [6.72, {}], [6.86, { y: STOPS[3] }],
    [7.02, {}], [7.28, { x: 300, y: 64 }], [7.42, { y: 126, s: 0.14, o: 0 }],
  ],
  wallet: [[0.35, { x: 300, y: 196, s: 0.6, o: 0 }], [0.9, { x: 188, y: 196, s: 1, o: 1 }], [1.3, { x: 104, y: 70, s: 0.9 }], [2.0, {}], [2.35, { x: 150, y: 100 }], [3.45, {}], [3.85, { o: 0, y: 84 }]],
  ballotSay: [[0.55, { x: 412, y: 282, o: 0 }], [0.85, { o: 1 }], [1.05, {}], [1.2, { o: 0 }]],
  browser: [[1.0, { x: 300, y: 250, s: 0.94, o: 0 }], [1.3, { s: 1, o: 1 }], [2.0, {}], [2.4, { x: 150 }], [6.0, {}], [6.15, { o: 0, s: 0.96 }]],
  list: [[2.0, { x: 440, y: 235, s: 0.94, o: 0 }], [2.3, { s: 1, o: 1 }], [6.0, {}], [6.15, { o: 0, s: 0.96 }]],
  chip: [[2.38, { x: 150, y: 250, s: 0.4, o: 0 }], [2.48, { s: 1, o: 1 }], [2.8, { x: 518, y: ROW(7) }], [2.86, { o: 0, s: 0.6 }]],
  ballot: [[4.0, { x: 150, y: 96, s: 0.96, o: 0 }], [4.18, { s: 1, o: 1 }], [4.42, {}], [4.72, { y: 238, s: 0.3, o: 0 }]],
  oneOf: [[4.65, { x: 440, y: 398, o: 0 }], [4.85, { o: 1 }], [5.9, {}], [6.02, { o: 0 }]],
  tag: [[5.0, { x: 150, y: 314, s: 0.9, o: 0 }], [5.2, { s: 1, o: 1 }], [6.0, {}], [6.12, { o: 0 }]],
  ghost: [[5.3, { x: 150, y: 250, s: 0.48, o: 0 }], [5.4, { o: 0.6 }], [5.66, { x: 296 }], [5.74, { x: 276, y: 258 }], [5.92, { x: 236, y: 330, o: 0 }]],
  cross: [[5.6, { x: 296, y: 190, s: 0.8, o: 0 }], [5.68, { s: 1, o: 1 }], [5.95, {}], [6.04, { o: 0 }]],
  route: [[6.0, { x: 300, y: 220, o: 0 }], [6.12, { o: 1 }], [7.0, {}], [7.12, { o: 0 }]],
  count: [[7.0, { x: 300, y: 220, o: 0 }], [7.12, { o: 1 }]],
}

// Fill in carried-over values so each key is complete.
for (const keys of Object.values(TRACKS)) {
  let last = { x: 300, y: 220, s: 1, o: 1 }
  for (const k of keys) last = k[1] = { ...last, ...k[1] }
}

const ease = (t) => t * t * (3 - 2 * t)
function at(keys, p) {
  if (p <= keys[0][0]) return keys[0][1]
  for (let i = 1; i < keys.length; i++) {
    const [p1, b] = keys[i]
    if (p <= p1) {
      const [p0, a] = keys[i - 1]
      const t = ease((p - p0) / (p1 - p0))
      const mix = (k) => a[k] + (b[k] - a[k]) * t
      return { x: mix("x"), y: mix("y"), s: mix("s"), o: mix("o") }
    }
  }
  return keys[keys.length - 1][1]
}

const nodes = Object.fromEntries(Object.keys(TRACKS).map((k) => [k, el(k)]))
const list = nodes.list
const mine = list.querySelector(".pl-mine span")
const stops = [...board.querySelectorAll(".pl-stop")]
const spine = board.querySelector(".pl-spine")
const bars = board.querySelector(".pl-bars")
const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v))
const span = (p, a, b) => clamp((p - a) / (b - a))

for (let i = 0; i < SCENES; i++) progress.append(document.createElement("li"))
const ticks = [...progress.children]

let scene = -1
function render(p) {
  for (const [name, keys] of Object.entries(TRACKS)) {
    const { x, y, s, o } = at(keys, p)
    const n = nodes[name]
    n.style.opacity = o.toFixed(3)
    n.style.visibility = o < 0.01 ? "hidden" : "visible"
    n.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%) scale(${s.toFixed(3)})`
  }
  nodes.wallet.classList.toggle("signing", p > 2.12 && p < 2.5)
  list.classList.toggle("joined", p >= 2.8)
  list.classList.toggle("frozen", p >= 3.2)
  list.classList.toggle("sweeping", p >= 4.55 && p < 6.05)
  list.classList.toggle("anon", p >= 4.55)
  mine.textContent = p >= 4.55 ? "0x7a…c4" : "0x7a…c4 · you"

  spine.style.setProperty("--fill", `${(span(p, 6.12, 6.88) * 100).toFixed(1)}%`)
  const stop = p < 6.29 ? 0 : p < 6.54 ? 1 : p < 6.79 ? 2 : 3
  stops.forEach((s, i) => s.classList.toggle("on", i === stop))
  bars.style.setProperty("--grow", ease(span(p, 7.42, 7.92)).toFixed(3))

  cue.classList.toggle("gone", p > 7.55)

  // The words lead the picture slightly.
  const now = Math.min(SCENES - 1, Math.floor(p + 0.06))
  if (now !== scene) {
    scene = now
    caps.forEach((c, i) => {
      c.classList.toggle("on", i === now)
      c.classList.toggle("past", i < now)
      c.setAttribute("aria-hidden", String(i !== now))
    })
    ticks.forEach((t, i) => t.classList.toggle("on", i === now))
  }
}

function target() {
  const r = story.getBoundingClientRect()
  const run = story.offsetHeight - innerHeight
  return clamp(-r.top / run) * SCENES
}

let shown = target()
let goal = shown
let frame = 0
function tick() {
  frame = 0
  // A big jump (a reload part-way down, the scrollbar dragged) skips ahead instead of
  // replaying every scene in between at speed.
  if (Math.abs(goal - shown) > 1) shown = goal - Math.sign(goal - shown) * 0.25
  shown = reduce.matches ? goal : shown + (goal - shown) * 0.14
  if (Math.abs(goal - shown) < 0.0005) shown = goal
  render(shown)
  if (shown !== goal) frame = requestAnimationFrame(tick)
}
function onScroll() {
  goal = target()
  if (!frame) frame = requestAnimationFrame(tick)
}

function fit() {
  const k = Math.min(view.clientWidth / 600, view.clientHeight / 440, 1.3)
  board.style.transform = `translate(-50%, -50%) scale(${Math.max(0.3, k).toFixed(3)})`
}

addEventListener("scroll", onScroll, { passive: true })
addEventListener("resize", () => { fit(); onScroll() })
new ResizeObserver(fit).observe(view)
fit()
render(shown)
