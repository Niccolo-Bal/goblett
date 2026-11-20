// The closing token on privacy.html: the goblet mark melts into the liquid-metal blob.
//
// Both shapes are drawn as the same number of outline points, starting at the top centre
// and running clockwise, so every point on the goblet has a partner on the blob. Each frame
// mixes the two and clips the metal surface to the result. The flame sinks into the metal
// as it melts. It changes shape every 4 seconds (goblet → blob → goblet in 8) while it's on screen.
// ?morph=0.5 holds one frame (0 goblet, 1 blob).

const BOX = { w: 140, h: 170 }
const N = 200 // outline points
// The goblet body from goblett_mark.svg, placed at 2× in the box (x' = 30 + 2x, y' = -2 + 2y).
const GOBLET = "M3 39h34c0 11-5 19-13.5 23.5-1.5 1.5-1.9 3.5-1.9 6.5v8c0 2.5 3.4 4 9.4 5 2 .4 2 3 0 3H9c-2 0-2-2.6 0-3 6-1 9.4-2.5 9.4-5v-8c0-3-.4-5-1.9-6.5C8 58 3 50 3 39z"
const BLOB = { cx: 70, cy: 112, r: 50 }
const HOLD = 3500 // ms each shape holds
const MELT = 500 // ms each change takes; 2 × (HOLD + MELT) = one 8 s cycle

function gobletPoints() {
  const ns = "http://www.w3.org/2000/svg"
  const svg = document.createElementNS(ns, "svg")
  svg.setAttribute("style", "position:absolute;width:0;height:0;overflow:hidden")
  const path = document.createElementNS(ns, "path")
  path.setAttribute("d", GOBLET)
  svg.append(path)
  document.body.append(svg)
  const len = path.getTotalLength()
  const raw = Array.from({ length: N }, (_, i) => {
    const p = path.getPointAtLength((i / N) * len)
    return [30 + 2 * p.x, -2 + 2 * p.y]
  })
  svg.remove()
  // Start at the rim's centre (the top middle), like the blob does; the path already runs clockwise.
  let start = 0
  raw.forEach(([x, y], i) => { if (Math.hypot(x - 70, y - 76) < Math.hypot(raw[start][0] - 70, raw[start][1] - 76)) start = i })
  return raw.slice(start).concat(raw.slice(0, start))
}

// The blob: a circle whose radius ripples slowly, so it reads as liquid.
function blobPoints(t, wobble) {
  return Array.from({ length: N }, (_, i) => {
    const a = -Math.PI / 2 + (i / N) * Math.PI * 2
    const r = BLOB.r * (1 + wobble * (0.045 * Math.sin(3 * a + t * 0.0011) + 0.03 * Math.sin(2 * a - t * 0.0016) + 0.02 * Math.sin(5 * a + t * 0.0007)))
    return [BLOB.cx + r * Math.cos(a), BLOB.cy + r * Math.sin(a)]
  })
}

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
const clamp = (v) => Math.min(1, Math.max(0, v))

export function morph(root) {
  const metal = root.querySelector(".pl-metal")
  const flame = root.querySelector(".pl-flame")
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches
  const goblet = gobletPoints()

  // m: 0 = goblet, 1 = blob
  function draw(m, t) {
    const blob = blobPoints(t, m)
    const e = easeInOut(m)
    const pts = goblet.map(([gx, gy], i) => {
      const [bx, by] = blob[i]
      return `${(gx + (bx - gx) * e).toFixed(1)}px ${(gy + (by - gy) * e).toFixed(1)}px`
    })
    metal.style.clipPath = `polygon(${pts.join(",")})`
    const f = clamp(m * 1.7)
    flame.style.opacity = (1 - f).toFixed(3)
    flame.style.transform = `translateY(${(f * 34).toFixed(1)}px) scale(${(1 - f * 0.55).toFixed(3)})`
  }

  if (reduce) return draw(1, 0)
  const still = Number.parseFloat(new URLSearchParams(location.search).get("morph"))
  if (Number.isFinite(still)) return draw(clamp(still), 0)

  let start = 0
  let frame = 0
  let visible = false
  function tick(now) {
    if (!start) start = now
    const t = now - start
    const c = t % (2 * (HOLD + MELT))
    const m = c < HOLD ? 0 : c < HOLD + MELT ? (c - HOLD) / MELT : c < 2 * HOLD + MELT ? 1 : 1 - (c - 2 * HOLD - MELT) / MELT
    draw(m, now)
    frame = visible ? requestAnimationFrame(tick) : 0
  }
  function play() {
    start = 0
    if (!frame) frame = requestAnimationFrame(tick)
  }

  draw(0, 0)
  new IntersectionObserver(([e]) => {
    const was = visible
    visible = e.isIntersecting
    if (visible && !was) play()
  }, { threshold: 0.6 }).observe(root)
}
