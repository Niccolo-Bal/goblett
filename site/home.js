// Home page motion, all driven by the scroll position. Nothing pins.
//  1. "How a vote reaches Arc": a glowing dot holds the middle of the screen, lighting
//     each station it passes, with a soft light travelling alongside it. Each side's
//     text eases in from its own edge, settles as it nears the middle of the screen,
//     and drifts a little against the scroll, so the section reads slower.
//  2. Dot fields drift slower than the page.
//  3. Other content rises into place once as it enters the screen.
import "./fonts.js"

const flow = document.querySelector("#how .flow")
const fields = [...document.querySelectorAll(".dots")]
const calm = matchMedia("(prefers-reduced-motion: reduce)")
const narrow = matchMedia("(max-width: 900px)")
const clamp = (v, a = 0, b = 1) => Math.min(Math.max(v, a), b)

const stops = flow ? [...flow.querySelectorAll(".stop")] : []
const rows = flow ? [flow.querySelector(".flow-head"), ...stops] : []
let spine, centres = [], R = 240

if (flow) {
  spine = document.createElement("div")
  spine.className = "spine"
  spine.setAttribute("aria-hidden", "true")
  spine.innerHTML = '<i class="fill"></i><i class="ring"></i>'
  flow.append(spine)
  flow.classList.add("is-live")
}

// Station centres in layout space (offsets ignore transforms), relative to the flow.
function measure() {
  const ol = flow.querySelector(".stops")
  centres = stops.map((s) => {
    const hop = s.querySelector(".hop")
    return ol.offsetTop + s.offsetTop + hop.offsetTop + hop.offsetHeight / 2
  })
  // The pull must end before the next stop starts, or neighbours bunch up around
  // the dot: with spacing S, R * (1 + P) <= S keeps them at least S / (1 + P) apart.
  const S = Math.min(...centres.slice(1).map((c, i) => c - centres[i]))
  R = (S / (1 + hold())) * 0.98
}
const hold = () => (narrow.matches ? 0.4 : 0.5)

const smooth = (t) => t * t * (3 - 2 * t)

function paintFlow() {
  const vh = innerHeight
  const mid = vh * 0.5
  const top = flow.getBoundingClientRect().top
  const still = calm.matches

  // Docking: a stop that reaches the middle of the screen stays there for a short
  // stretch of scroll (the plateau), then eases back to the page's speed.
  // Order is preserved and nothing moves backwards.
  const P = hold()
  const dock = (x) => {
    const u = Math.abs(x) / R
    if (u >= 1) return x
    const v = Math.max(0, (u - P) / (1 - P))
    const h = (-2 * v ** 3 + 3 * v ** 2) + (v ** 3 - v ** 2) * (1 - P)
    return Math.sign(x) * R * h
  }
  const shown = centres.map((c, i) => {
    const dist = top + c - mid
    const off = still ? 0 : dock(dist) - dist
    stops[i].style.transform = still ? "" : `translate3d(0, ${off.toFixed(1)}px, 0)`
    stops[i].classList.toggle("is-docked", Math.abs(dist) < R * P)
    return c + off
  })

  // The dot always belongs to a stop: it rides the docked one, then glides along
  // the line to the next, arriving as that one docks.
  const smooth01 = (t) => smooth(clamp(t))
  let y = shown[0]
  const last = centres.length - 1
  if (top + centres[last] - mid <= 0) y = shown[last]
  else
    for (let i = 0; i < last; i++) {
      const xa = top + centres[i] - mid, xb = top + centres[i + 1] - mid
      if (xa <= 0 && xb > 0) {
        const t = -xa / (xb - xa)
        const edge = (R * P) / (xb - xa)
        const s = still ? t : smooth01((t - edge) / (1 - 2 * edge))
        y = shown[i] + (shown[i + 1] - shown[i]) * s
        break
      }
    }
  spine.style.setProperty("--top", `${shown[0]}px`)
  spine.style.setProperty("--len", `${y - shown[0]}px`)
  spine.style.setProperty("--ry", `${y}px`)
  flow.style.setProperty("--ly", `${y}px`)

  let on = -1
  shown.forEach((c, i) => {
    if (c <= y + 2) on = i
  })
  // Focus: the stop under the dot is full size and bright; others recede.
  const gap = shown.length > 1 ? (shown[shown.length - 1] - shown[0]) / (shown.length - 1) : 1
  stops.forEach((s, i) => {
    s.classList.toggle("is-on", i === on && Math.abs(shown[i] - y) < 30)
    s.classList.toggle("is-past", i < on || (i === on && Math.abs(shown[i] - y) >= 30))
    const f = 1 - smooth(clamp(Math.abs(shown[i] - y) / gap))
    for (const side of s.querySelectorAll(".side")) {
      const dir = narrow.matches ? 1 : side.classList.contains("reg") ? -1 : 1
      side.style.opacity = (0.22 + 0.78 * f).toFixed(3)
      side.style.transform = still ? "" : `translate3d(${(dir * (narrow.matches ? 16 : 56) * (1 - f)).toFixed(1)}px, 0, 0) scale(${(0.88 + 0.12 * f).toFixed(3)})`
    }
    s.querySelector(".hop").style.transform = still ? "" : `scale(${(0.9 + 0.4 * f ** 2).toFixed(3)})`
  })

  if (still) return
  // The two column heads ease in from their edges as before.
  const head = rows[0].getBoundingClientRect()
  const t = clamp((head.top + 60 - mid) / mid, -1, 1)
  for (const side of rows[0].querySelectorAll(".side")) {
    const dir = narrow.matches ? 1 : side.classList.contains("reg") ? -1 : 1
    side.style.transform = `translate3d(${(dir * 100 * Math.abs(t) ** 3).toFixed(1)}px, 0, 0)`
    side.style.opacity = (1 - Math.abs(t) ** 2.5 * 0.95).toFixed(3)
  }
}

function paintFields() {
  if (calm.matches) return
  for (const el of fields) {
    const r = el.getBoundingClientRect()
    if (r.bottom < -200 || r.top > innerHeight + 200) continue
    const off = r.top + r.height / 2 - innerHeight / 2
    el.style.setProperty("--drift", `${(-off * 0.12).toFixed(1)}px`)
  }
}

let queued = false
function frame() {
  queued = false
  if (flow) paintFlow()
  paintFields()
}
const schedule = () => {
  if (!queued) {
    queued = true
    requestAnimationFrame(frame)
  }
}

if (flow) measure()
addEventListener("scroll", schedule, { passive: true })
addEventListener("resize", () => {
  if (flow) measure()
  schedule()
})
document.fonts?.ready.then(() => {
  if (flow) measure()
  schedule()
})
calm.addEventListener("change", () => {
  fields.forEach((el) => el.style.removeProperty("--drift"))
  flow?.querySelectorAll(".side, .stop, .hop").forEach((el) => el.removeAttribute("style"))
  schedule()
})
frame()

if (!calm.matches && "IntersectionObserver" in window) {
  const items = document.querySelectorAll("main .section-head, main .tile, main .limits > div, main .relay .main, main .terminal, main .close h2")
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        const el = e.target
        el.classList.add("is-in")
        io.unobserve(el)
        // Hand the element back to its own styles (hover lifts) once it lands.
        el.addEventListener("transitionend", (ev) => ev.target === el && ev.propertyName === "transform" && el.classList.remove("rise", "is-in"))
      }
    },
    { rootMargin: "0px 0px -12% 0px" },
  )
  items.forEach((el) => {
    const i = [...el.parentElement.children].indexOf(el)
    el.style.setProperty("--i", Math.min(i, 3))
    el.classList.add("rise")
    io.observe(el)
  })
}
