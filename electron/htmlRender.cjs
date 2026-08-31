/**
 * Rasterize agent-written HTML/CSS art to a PNG.
 *
 * Electron IS Chromium, so a hidden offscreen window does this for free —
 * puppeteer stays a devDependency rather than bolting a second browser (~200MB)
 * into the shipped app. Offscreen renders in software, which is slower but
 * paints filters, gradients and blend modes the same way.
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

async function renderHtmlToPng(html, width, height) {
  const w = Math.max(1, Math.min(4096, Math.round(width) || 1080));
  const h = Math.max(1, Math.min(4096, Math.round(height) || 1350));
  const win = new BrowserWindow({
    width: w,
    height: h,
    show: false,
    webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true },
  });
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
    // capturePage grabs at the display's scale factor, so a retina Mac hands
    // back 2x. Lay out at the requested CSS pixels and downsample to them — the
    // output size is then the same on any machine, supersampled where it can be.
    const img = await win.webContents.capturePage();
    const shot = img.getSize().width === w ? img : img.resize({ width: w, height: h, quality: "best" });
    return shot.toPNG();
  } finally {
    try { win.destroy(); } catch { /* already gone */ }
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  }
}

module.exports = { renderHtmlToPng };
