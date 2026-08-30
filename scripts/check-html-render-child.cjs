// Stands in for the Express server child: same parent-port protocol as
// server/utils/htmlRender.ts. Exits 0 only if a real PNG comes back.
const port = process.parentPort;
if (!port) { console.error("no process.parentPort in utilityProcess child"); process.exit(1); }
port.on("message", (e) => {
  const m = e.data;
  if (!m || m.type !== "render-html-result" || m.id !== "probe") return;
  const png = Buffer.from(m.png || "", "base64");
  process.exit(png.length > 0 && png.readUInt32BE(16) === 200 ? 0 : 1);
});
port.postMessage({ type: "render-html", id: "probe", html: "<body style='background:#0f0'>", width: 200, height: 100 });
