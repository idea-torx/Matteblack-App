/**
 * One check for the HTML->PNG path: `npx electron scripts/check-html-render.cjs`.
 * Renders a known page offscreen and asserts the capture is the right size and
 * actually painted the CSS (a blank/white grab is the failure this catches).
 */
const assert = require("node:assert");
const { app } = require("electron");
const { renderHtmlToPng } = require("../electron/htmlRender.cjs");

const HTML = `<style>html,body{margin:0;width:200px;height:100px}
body{background:linear-gradient(90deg,#f00 0 50%,#00f 50% 100%)}</style><body>`;

app.whenReady().then(async () => {
  const png = await renderHtmlToPng(HTML, 200, 100);
  assert.ok(png.length > 0, "empty PNG");
  // PNG IHDR: width/height are big-endian uint32 at bytes 16 and 20.
  assert.strictEqual(png.readUInt32BE(16), 200, "wrong width");
  assert.strictEqual(png.readUInt32BE(20), 100, "wrong height");

  const { nativeImage } = require("electron");
  const bmp = nativeImage.createFromBuffer(png).toBitmap(); // BGRA
  const at = (x, y) => { const i = (y * 200 + x) * 4; return [bmp[i + 2], bmp[i + 1], bmp[i]]; };
  const [lr, lg, lb] = at(50, 50);
  const [rr, rg, rb] = at(150, 50);
  assert.ok(lr > 200 && lg < 60 && lb < 60, `left half not red: ${[lr, lg, lb]}`);
  assert.ok(rb > 200 && rr < 60 && rg < 60, `right half not blue: ${[rr, rg, rb]}`);

  console.log("ok — offscreen render painted the CSS at the requested size");

  // The server reaches this renderer from a utilityProcess child over the
  // built-in parent port (server/utils/htmlRender.ts). Prove that seam too.
  const { utilityProcess } = require("electron");
  const path = require("node:path");
  const child = utilityProcess.fork(path.join(__dirname, "check-html-render-child.cjs"));
  const roundTrip = await new Promise((resolve, reject) => {
    setTimeout(() => reject(new Error("no reply from the utilityProcess child")), 30000);
    child.on("message", async (msg) => {
      if (!msg || msg.type !== "render-html") return;
      const out = await renderHtmlToPng(msg.html, msg.width, msg.height);
      child.postMessage({ type: "render-html-result", id: msg.id, png: out.toString("base64") });
    });
    child.on("exit", (code) => (code === 0 ? resolve(true) : reject(new Error(`child exited ${code}`))));
  });
  assert.ok(roundTrip);
  console.log("ok — parent-port round trip from a utilityProcess child");
  app.exit(0);
}).catch((err) => { console.error(err); app.exit(1); });
