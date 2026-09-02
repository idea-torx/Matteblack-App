/**
 * Rasterize agent-written HTML/CSS art to a PNG.
 *
 * Electron IS Chromium, so a hidden offscreen window does this for free —
 * puppeteer stays a devDependency rather than bolting a second browser (~200MB)
 * into the shipped app. Offscreen renders in software, which is slower but
 * paints filters, gradients and blend modes the same way.
 *
 * The window is kept warm between renders. Building one costs ~100ms and its
 * first navigation another ~200-600ms while the renderer process spins up and
 * the compositor wakes; reusing it takes a whole revision from ~500ms to ~60ms,
 * which is the difference between editing an ad and waiting on one. It is torn
 * down after a minute idle so an app left open doesn't hold a renderer forever.
 */
const { BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

// Webfonts resolve after load, and the compositor needs a couple of frames
// before gradients/filters are fully painted — capturing earlier grabs a
// half-drawn page. Images have to be waited for too: `load` covers <img> and
// CSS background-image alike, and without it any page with real imagery in it
// captures before the pixels arrive and comes back blank where they should be.
// Raced against a cap so a font or image that never resolves can't hang.
const SETTLE = `new Promise((r) => {
  const settle = () => requestAnimationFrame(() => requestAnimationFrame(r));
  setTimeout(r, 5000);
  const loaded = document.readyState === "complete"
    ? Promise.resolve()
    : new Promise((ok) => addEventListener("load", ok, { once: true }));
  const fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
  Promise.all([loaded, fonts]).then(settle, settle);
})`;

// Element map: what is where on the page, so the canvas can offer each piece
// for selection and the agent can be told "the user means THIS <h1>". Own text
// first so a wrapper doesn't repeat every word inside it. The root-sized box is
// skipped (it's the page, not a piece) and the walk is capped so a particle
// field of 5k spans doesn't ship as a map.
const ELEMENT_MAP = `(() => {
  const out = [];
  const W = innerWidth, H = innerHeight;
  const skip = new Set(["script", "style", "br", "html", "head"]);
  for (const el of document.body.querySelectorAll("*")) {
    const tag = el.tagName.toLowerCase();
    if (skip.has(tag)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.right <= 0 || r.bottom <= 0 || r.left >= W || r.top >= H) continue;
    if (r.width * r.height > 0.9 * W * H) continue;
    const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" ");
    const text = (own.trim() || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80);
    out.push({ tag, text, bbox: [r.left, r.top, r.width, r.height].map(Math.round) });
    if (out.length >= 400) break;
  }
  return out;
})()`;

// Nudge elements by their walk index (same order as ELEMENT_MAP) with a
// translate — no reflow, so the map stays true — and hand back the markup with
// the moves baked in. Two args: moves, and a flag for the serialize.
const APPLY_MOVES = `((moves) => {
  const skip = new Set(["script", "style", "br", "html", "head"]);
  const els = Array.from(document.body.querySelectorAll("*")).filter((el) => !skip.has(el.tagName.toLowerCase()));
  // Same filtering as ELEMENT_MAP so indices line up.
  const W = innerWidth, H = innerHeight;
  const visible = els.filter((el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.right <= 0 || r.bottom <= 0 || r.left >= W || r.top >= H) return false;
    return r.width * r.height <= 0.9 * W * H;
  });
  for (const m of moves) {
    const el = visible[m.i];
    if (!el) continue;
    const prev = /translate\\((-?[\\d.]+)px,\\s*(-?[\\d.]+)px\\)/.exec(el.style.transform || "");
    const x = (prev ? Number(prev[1]) : 0) + m.dx, y = (prev ? Number(prev[2]) : 0) + m.dy;
    el.style.transform = (el.style.transform || "").replace(/translate\\([^)]*\\)\\s*/, "") + \` translate(\${Math.round(x)}px, \${Math.round(y)}px)\`;
    el.style.transform = el.style.transform.trim();
  }
  return "<!doctype html>\\n" + document.documentElement.outerHTML;
})`;

const IDLE_MS = 60_000;

let warm = null;
let idleTimer = null;
// One window, so renders queue rather than overwrite each other's page.
let chain = Promise.resolve();

function dropWarm() {
  clearTimeout(idleTimer);
  idleTimer = null;
  const win = warm;
  warm = null;
  try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* already gone */ }
}

function getWindow(w, h) {
  clearTimeout(idleTimer);
  if (warm && !warm.isDestroyed() && !warm.webContents.isDestroyed()) {
    warm.setSize(w, h);
    return warm;
  }
  warm = new BrowserWindow({
    width: w,
    height: h,
    show: false,
    webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true },
  });
  // A dead renderer stays "not destroyed" from the outside, and every later
  // navigation on it fails — forget it so the next render builds a fresh one.
  warm.webContents.on("render-process-gone", dropWarm);
  return warm;
}

async function renderOnce(html, w, h, moves) {
  const win = getWindow(w, h);
  // A temp file, not a data: URL. Chromium caps data-URL navigations at ~2MB,
  // and a page with one inlined image in it clears that on its own — base64
  // inflates ~1.37x and percent-encoding the document expands it again. The
  // file has no such ceiling, and file:// keeps the page just as offline.
  //
  // The one thing the data: URL did carry was `;charset=utf-8`. A file has no
  // such header, and Chromium falls back to a legacy encoding — em dashes come
  // back as mojibake. A leading BOM says UTF-8 with higher priority than any
  // <meta charset>, needs no <head> to put it in, and is stripped by the parser,
  // so the caller's document is passed through byte for byte.
  const tmp = path.join(os.tmpdir(), `falforge-render-${randomUUID()}.html`);
  fs.writeFileSync(tmp, "\uFEFF" + html, "utf8");
  try {
    await win.loadFile(tmp);
    await win.webContents.executeJavaScript(SETTLE);
    let moved;
    if (moves && moves.length) moved = await win.webContents.executeJavaScript(`${APPLY_MOVES}(${JSON.stringify(moves)})`);
    // capturePage grabs at the display's scale factor, so a retina Mac hands
    // back 2x. Lay out at the requested CSS pixels and downsample to them — the
    // output size is then the same on any machine, supersampled where it can be.
    const img = await win.webContents.capturePage();
    const shot = img.getSize().width === w ? img : img.resize({ width: w, height: h, quality: "best" });
    const map = await win.webContents.executeJavaScript(ELEMENT_MAP).catch(() => []);
    return { png: shot.toPNG(), map, html: moved };
  } catch (err) {
    // The warm window is the prime suspect for any navigation failure, and a
    // sticky broken one would fail every render after it. Start over next time.
    dropWarm();
    throw err;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    if (warm) idleTimer = setTimeout(dropWarm, IDLE_MS);
  }
}

/** Resolves { png: Buffer, map: element map } */
function renderHtmlToPng(html, width, height, moves) {
  const w = Math.max(1, Math.min(4096, Math.round(width) || 1080));
  const h = Math.max(1, Math.min(4096, Math.round(height) || 1350));
  const next = chain.then(() => renderOnce(html, w, h, moves));
  // The queue must survive a failed render, so it chains on the settled result.
  chain = next.catch(() => {});
  return next;
}

module.exports = { renderHtmlToPng };
