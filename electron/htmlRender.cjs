/**
 * Rasterize agent-written HTML/CSS art to a PNG.
 *
 * Electron IS Chromium, so a hidden offscreen window does this for free —
 * puppeteer stays a devDependency rather than bolting a second browser (~200MB)
 * into the shipped app. Offscreen renders in software, which is slower but
 * paints filters, gradients and blend modes the same way.
 */
const { BrowserWindow } = require("electron");

// Webfonts resolve after load, and the compositor needs a couple of frames
// before gradients/filters are fully painted — capturing earlier grabs a
// half-drawn page. Raced against a cap so a font that never loads (offline)
// can't hang the render.
const SETTLE = `new Promise((r) => {
  const settle = () => requestAnimationFrame(() => requestAnimationFrame(r));
  setTimeout(r, 5000);
  (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(settle, settle);
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
  try {
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    await win.webContents.executeJavaScript(SETTLE);
    // capturePage grabs at the display's scale factor, so a retina Mac hands
    // back 2x. Lay out at the requested CSS pixels and downsample to them — the
    // output size is then the same on any machine, supersampled where it can be.
    const img = await win.webContents.capturePage();
    const shot = img.getSize().width === w ? img : img.resize({ width: w, height: h, quality: "best" });
    return shot.toPNG();
  } finally {
    try { win.destroy(); } catch { /* already gone */ }
  }
}

module.exports = { renderHtmlToPng };
