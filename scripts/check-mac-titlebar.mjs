// Verifies the macOS titlebar layout: traffic-light strip is clear of the left
// rail, and the right-hand panels no longer reserve space they don't need.
import assert from 'node:assert'
import puppeteer from 'puppeteer'

const b = await puppeteer.launch()
const p = await b.newPage()
await p.setViewport({ width: 1440, height: 900 })
await p.evaluateOnNewDocument(() => { window.matteblack = { isDesktop: true } })
await p.goto('http://127.0.0.1:3001/', { waitUntil: 'networkidle2' })
await p.waitForSelector('.icon-rail', { timeout: 30000 })

const r = await p.evaluate(() => {
  const cs = getComputedStyle(document.documentElement)
  const box = (s) => { const e = document.querySelector(s); return e && e.getBoundingClientRect().toJSON() }
  return {
    isMac: document.documentElement.classList.contains('is-mac'),
    titlebarH: cs.getPropertyValue('--titlebar-h').trim(),
    floatTop: cs.getPropertyValue('--panel-float-top').trim(),
    rail: box('.icon-rail'),
    strip: box('.app-titlebar'),
    // Probe the inverted pill (filled with --text-primary, text in
    // --agent-surface) in both themes — it was white-on-white in dark.
    pill: (() => {
      const out = {}
      const prev = document.documentElement.getAttribute('data-theme')
      for (const theme of ['light', 'dark']) {
        document.documentElement.setAttribute('data-theme', theme)
        const panel = document.createElement('div')
        panel.className = 'agent-panel'
        const btn = document.createElement('button')
        btn.className = 'agent-panel__hero-signin'
        panel.appendChild(btn); document.body.appendChild(panel)
        const cs = getComputedStyle(btn)
        out[theme] = { bg: cs.backgroundColor, fg: cs.color }
        panel.remove()
      }
      if (prev) document.documentElement.setAttribute('data-theme', prev)
      return out
    })(),
  }
})
await b.close()
console.log(JSON.stringify(r, null, 2))

// Traffic lights occupy roughly x 16-68, y 14-26 (main.cjs trafficLightPosition).
assert.ok(r.isMac, 'is-mac class not applied')
assert.strictEqual(r.titlebarH, '0px', 'right side should reserve nothing on mac')
assert.ok(r.rail.top >= 32, `rail top ${r.rail.top} still collides with traffic lights`)
assert.strictEqual(r.strip.left, 0, 'drag strip should be top-left on mac')
assert.ok(r.strip.bottom <= r.rail.top, 'drag strip must not overlap the rail')
for (const [theme, { bg, fg }] of Object.entries(r.pill)) {
  assert.notStrictEqual(bg, fg, `hero-signin is ${fg} on ${bg} in ${theme} — invisible`)
}
console.log('OK')
