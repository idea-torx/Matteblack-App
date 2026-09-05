/**
 * Headless Blender bridge — the operator writes a Python step, Blender runs it
 * against the session's .blend, and the playblast/stills land on the canvas.
 *
 * Scene state lives in the .blend file, not here: each run reopens
 * <dataDir>/blender/<session>/scene.blend and saves it again, so a step is a
 * diff on a persistent scene rather than a whole rebuild.
 */
import { Router } from "express";
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { requireAuth, type AuthRequest } from "../sessions.js";
import { DATA_DIR } from "../config/runtime.js";
import { resolveBin } from "../setup/doctor.js";
import { getOperatorContext } from "../services/operatorCanvasContext.js";
import { requireMcpToken, importLocalMedia } from "./agentRender.js";
import { getPresenceTransport } from "./canvas.js";
import { BRIDGE_PY, digestLog, diffObjects, pixelDigest, tellMessage } from "../blender/bridge.js";
import { getBlenderConfig } from "../config/userConfig.js";
import { SESSION_RE } from "../utils/blenderPath.js";
import { bin } from "../setup/doctor.js";

const router = Router();

/** ponytail: 15 min hard stop. A runaway render would otherwise hold the turn forever. */
const TIMEOUT_MS = 15 * 60_000;
const BUSY = new Set<string>();

type Summary = {
  objects?: Array<{ name: string; type: string; loc: number[] }>;
  frame_range?: [number, number];
  fps?: number;
  camera_key_count?: number;
};

/** The harness's one JSON block: summary + renders on success, error on a Python
 *  failure; `stdout` is the step's own print() output either way. */
type Harness = { summary?: Summary; rendered?: string[]; views?: Array<{ label: string; file: string; from: number[]; rot: number[] }>; error?: string; stdout?: string };

/** Everything Blender printed; the harness's JSON block is parsed out of it. */
function runBlender(bin: string, args: string[]): Promise<{ log: string; code: number | null }> {
  return new Promise((resolve) => {
    let log = "";
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.stdout.on("data", (d) => { log += d; });
    child.stderr.on("data", (d) => { log += d; });
    child.on("error", (e) => { clearTimeout(timer); resolve({ log: `${log}\n${e.message}`, code: 127 }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ log, code }); });
  });
}

function parseSummary(log: string): Harness | null {
  const m = /MB_SUMMARY_BEGIN\n([\s\S]*?)\nMB_SUMMARY_END/.exec(log);
  if (!m) return null;
  try { return JSON.parse(m[1]) as Harness; } catch { return null; }
}

/**
 * 8 evenly spaced frames of the playblast tiled into one PNG (4 across, 2 down)
 * so the model can read a whole move in a single image.
 *
 * ponytail: no frame numbers burned in — drawtext needs a freetype-enabled
 * ffmpeg and a font path we'd have to guess. Reading order carries the frames.
 */
async function contactSheet(video: string, out: string, total: number): Promise<number[] | null> {
  const idx = Array.from({ length: 8 }, (_, i) => Math.round((i * (total - 1)) / 7));
  const select = [...new Set(idx)].map((n) => `eq(n\\,${n})`).join("+");
  fs.rmSync(out, { force: true });
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(bin("ffmpeg"), [
        "-i", video,
        "-vf", `select=${select},scale=320:-2,tile=4x2`,
        "-frames:v", "1", "-fps_mode", "vfr", "-y", out,
      ], (err) => (err ? reject(err) : resolve()));
    });
    return fs.existsSync(out) ? idx : null;
  } catch { return null; }
}

/** Inline stills are for the model's eyes: 640 wide is ~a quarter of the image tokens of 1280x720 and framing still reads. Full size on failure. */
async function shrink(file: string): Promise<Buffer> {
  const out = file.replace(/\.png$/, ".peek.png");
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(bin("ffmpeg"), ["-i", file, "-vf", "scale=640:-2", "-y", out], (err) => (err ? reject(err) : resolve()));
    });
    return fs.readFileSync(out);
  } catch { return fs.readFileSync(file); }
}

router.post("/api/agent/blender/run", requireMcpToken, requireAuth, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const canvasId = getOperatorContext(userId)?.canvasId ?? null;
  if (!canvasId) { res.status(400).json({ error: "No canvas is open." }); return; }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const session = typeof body.session === "string" ? body.session.trim() : "";
  const step = typeof body.step === "string" ? body.step : "";
  if (!SESSION_RE.test(session)) { res.status(400).json({ error: "session must be a slug: ^[a-z0-9-]{1,40}$" }); return; }
  const revert = typeof body.revert === "number" ? Math.trunc(body.revert) : null;
  if (!step.trim() && revert === null) { res.status(400).json({ error: "step (Python source) is required." }); return; }
  // Smaller models send `render` as a JSON string (sometimes with a stray brace); ignoring it silently cost a whole re-ship loop.
  let renderIn = body.render ?? {};
  if (typeof renderIn === "string") { try { renderIn = JSON.parse(renderIn); } catch { renderIn = null; } }
  if (typeof renderIn !== "object" || renderIn === null || Array.isArray(renderIn)) {
    res.status(400).json({ error: 'render must be a JSON object, e.g. {"stills":[1],"peek":true} — not a string' }); return;
  }
  const render = renderIn as { playblast?: boolean; stills?: number[]; peek?: boolean; sheet?: boolean; views?: unknown[] };

  const blender = resolveBin("blender");
  if (!blender.found) {
    res.status(503).json({ error: "Blender isn't installed. Ask the user to install it from Settings > Setup." });
    return;
  }

  // One Blender per session: a retry while a ship is still rendering used to start a second
  // Blender on the same scene.blend and playblast.mp4, and both came out corrupt.
  if (BUSY.has(session)) { res.status(409).json({ error: `Session "${session}" is still running its previous step; wait for it to finish, then try again.` }); return; }
  BUSY.add(session);
  try { await runStep(); } finally { BUSY.delete(session); }

  async function runStep() {
  const dir = path.join(DATA_DIR, "blender", session);
  const outDir = path.join(dir, "out");
  fs.mkdirSync(outDir, { recursive: true });
  const n = fs.readdirSync(dir).filter((f) => /^step-\d+\.py$/.test(f)).length + 1;
  const stepPath = path.join(dir, `step-${n}.py`);
  const bridgePath = path.join(dir, "bridge.py");
  fs.writeFileSync(bridgePath, BRIDGE_PY, "utf8");
  const blend = path.join(dir, "scene.blend");

  // ponytail: snapshots are never pruned — one .blend per step, forever.
  const snapshot = (i: number) => path.join(dir, `scene.step-${i}.blend`);
  if (revert !== null) {
    if (!fs.existsSync(snapshot(revert))) { res.status(400).json({ error: `No snapshot scene.step-${revert}.blend in this session.` }); return; }
    fs.copyFileSync(snapshot(revert), blend);
  }

  // Appended, not prepended, so a traceback's line numbers match the step the
  // agent sent. The .blend carries who made it without the agent remembering to.
  const stamped = [
    "import mb",
    `mb.stamp(${JSON.stringify(session)}, ${JSON.stringify(canvasId)}, `
      + `${JSON.stringify(String(body.runner ?? ""))}, ${JSON.stringify(String(body.model ?? ""))}, ${JSON.stringify(`step-${n}`)})`,
    "",
  ].join("\n");
  fs.writeFileSync(stepPath, `${step}\n${stamped}`, "utf8");

  const args = [
    "--background",
    ...(fs.existsSync(blend) ? [blend] : []),
    "--python", bridgePath,
    "--", stepPath, dir, JSON.stringify({ ...render, config: getBlenderConfig() }),
  ];
  const { log, code } = await runBlender(blender.path, args);
  const parsed = parseSummary(log);
  // 200 even on failure: the agent needs to read the error and fix its step.
  // A Python error is the harness's short block; anything else (crash, timeout)
  // is the digested Blender log.
  if (parsed?.error) { res.json({ ok: false, log: [parsed.error, parsed.stdout?.trim()].filter(Boolean).join("\n\nstep output:\n") }); return; }
  if (code !== 0 || !parsed?.summary) { res.json({ ok: false, log: digestLog(log) }); return; }

  const { summary, rendered = [], views = [], stdout = "" } = parsed;
  fs.copyFileSync(blend, snapshot(n));
  const frameRange = summary.frame_range ?? [1, 1];
  const fps = summary.fps ?? 24;
  const base = { source: "blender" as const, session, fps, frameRange };
  const nodes: Array<{ id: string; kind: string; url: string }> = [];
  const problems: string[] = [];
  // Stills first, so the playblast node can carry their URLs.
  const stills = rendered.filter((f) => !path.basename(f).startsWith("playblast"));
  const stillUrls: string[] = [];
  const warnings: string[] = [];
  const seenStill = new Map<string, number>();
  // peek: the model looks, the canvas stays clean (no node per framing check).
  const peeks: Array<{ frame: number; data: string; label?: string; from?: number[]; rot?: number[] }> = [];
  for (const file of stills) {
    const frame = Number(/still-(\d+)\./.exec(path.basename(file))?.[1] ?? 0);
    const bytes = fs.readFileSync(file);
    const digest = pixelDigest(bytes);
    const twin = seenStill.get(digest);
    if (twin !== undefined) warnings.push(`stills ${twin} and ${frame} are identical`);
    else seenStill.set(digest, frame);
    peeks.push({ frame, data: (await shrink(file)).toString("base64") }); // shipped stills come back the same way
    if (render.peek) continue;
    const r = await importLocalMedia({
      userId, canvasId, file, label: `${session} f${frame}`,
      metadata: { ...base, kind: "still", frame },
    });
    if ("error" in r) { problems.push(r.error); continue; }
    stillUrls.push(r.src);
    nodes.push({ id: r.nodeId, kind: "still", url: r.src });
  }
  // views: the model's viewport, never the canvas — its own vantage, with the pose it was taken from.
  for (const v of views) peeks.push({ frame: 0, label: v.label, from: v.from, rot: v.rot, data: (await shrink(v.file)).toString("base64") });
  const playblasts = rendered.filter((f) => path.basename(f).startsWith("playblast"));
  if (render.playblast && (summary.camera_key_count ?? 0) <= 1) {
    // ponytail: camera only — the summary carries no per-object animation data.
    warnings.push("playblast rendered but the camera has no keyframes, so nothing moves");
  }
  let sheet: { data: string; first: number; last: number } | undefined;
  if (render.sheet && playblasts[0]) {
    const total = Math.max(1, frameRange[1] - frameRange[0] + 1);
    const out = path.join(outDir, "sheet.png");
    const idx = await contactSheet(playblasts[0], out, total);
    if (idx) sheet = { data: fs.readFileSync(out).toString("base64"), first: frameRange[0] + idx[0], last: frameRange[0] + idx[idx.length - 1] };
    else problems.push("contact sheet failed (is ffmpeg installed?)");
  }
  for (const file of playblasts) {
    const r = await importLocalMedia({
      userId, canvasId, file, label: `${session} playblast`,
      metadata: { ...base, kind: "playblast", stills: stillUrls },
    });
    if ("error" in r) { problems.push(r.error); continue; }
    nodes.push({ id: r.nodeId, kind: "playblast", url: r.src });
  }

  // Only what changed since the last step reaches the model; the full list stays on disk for the next diff.
  const prevFile = path.join(dir, "summary.json");
  let prev: Summary["objects"] | undefined;
  try { prev = (JSON.parse(fs.readFileSync(prevFile, "utf8")) as Summary).objects; } catch { /* first step */ }
  fs.writeFileSync(prevFile, JSON.stringify(summary));
  const slim = { ...summary, ...diffObjects(prev, summary.objects ?? []) };
  res.json({ ok: true, log: [stdout.trim(), ...problems].filter(Boolean).join("\n"), summary: slim, nodes, peeks, warnings, sheet });  }
});

/** Selection + note from the Blender add-on → one Continue message for the open Operator session (over the canvas SSE stream). */

router.post("/api/agent/blender/tell", requireMcpToken, requireAuth, (req: AuthRequest, res) => {
  const body = (req.body ?? {}) as { session?: unknown; selected?: unknown; viewport?: unknown; note?: unknown };
  const session = typeof body.session === "string" && SESSION_RE.test(body.session) ? body.session : null;
  if (!session) { res.status(400).json({ error: "session must be a Matteblack session slug." }); return; }
  const canvasId = getOperatorContext(req.userId ?? "")?.canvasId ?? null;
  if (!canvasId) { res.status(400).json({ error: "No canvas is open in Matteblack." }); return; }
  const text = tellMessage(session, body as Parameters<typeof tellMessage>[1]);
  getPresenceTransport().writeToCanvas(canvasId, `data: ${JSON.stringify({ type: "blender:tell", canvasId, text })}\n\n`);
  res.json({ ok: true });
});

export default router;
