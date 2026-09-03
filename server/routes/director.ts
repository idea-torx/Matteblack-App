/**
 * H3 Max Director — fal's live WebRTC session (minimax/h3-max/director).
 *
 * The renderer opens the session itself with @fal-ai/client's realtime `wma()`
 * and points the client at /api/fal/proxy, so the fal key never leaves the
 * server: the proxy forwards signalling (`/session`, `/heartbeat`, `/ice`) to
 * the URL in `x-fal-target-url` and adds `Authorization: Key …`.
 *
 * /api/director/save takes the MediaRecorder take, remuxes it to mp4 on the
 * system ffmpeg (webm chokes DaVinci and the cinema concat), stores it under
 * generations/video like any other clip, and debits the wall-clock seconds.
 */
import { Router } from "express";
import multer from "multer";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { requireAuth, type AuthRequest } from "../sessions.js";
import { getFalKey } from "../config/userConfig.js";
import { saveFile } from "../storage.js";
import { checkAndDebit } from "../credits/creditGate.js";
import { bin } from "../setup/doctor.js";
import { isFalHost } from "../utils/falHost.js";

const run = promisify(execFile);
const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

/** fal bills a 60s minimum per Director session. */
export const DIRECTOR_MIN_SECONDS = 60;

router.all("/api/fal/proxy", requireAuth, async (req, res) => {
  const target = req.header("x-fal-target-url") ?? "";
  if (!isFalHost(target)) {
    res.status(400).json({ error: "x-fal-target-url must be an https fal.run / fal.ai URL" });
    return;
  }
  const key = getFalKey();
  if (!key) {
    res.status(401).json({ error: "No fal key configured" });
    return;
  }
  const hasBody = !["GET", "HEAD"].includes(req.method);
  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: {
        Authorization: `Key ${key}`,
        Accept: "application/json",
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
      },
      body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
    });
    res.status(upstream.status);
    const ct = upstream.headers.get("content-type");
    if (ct) res.setHeader("content-type", ct);
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/api/director/save", requireAuth, upload.single("file"), async (req: AuthRequest, res) => {
  if (!req.file) {
    res.status(400).json({ error: "file is required" });
    return;
  }
  const seconds = Math.max(1, Math.round(Number(req.body.seconds) || 0));
  const debit = await checkAndDebit(req.userId!, "h3-max-director", Math.min(100, Math.max(DIRECTOR_MIN_SECONDS, seconds)), undefined, req.body.workspace_id || undefined);
  if (!debit.success) {
    res.status(debit.required ? 402 : 400).json({ error: debit.error, required: debit.required, balance: debit.balance });
    return;
  }
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "director-"));
  try {
    const src = path.join(dir, "take.webm");
    const out = path.join(dir, "take.mp4");
    await fsp.writeFile(src, req.file.buffer);
    let data: Buffer;
    let ext = "mp4";
    try {
      // MediaRecorder writes VP8/Opus with no duration header; re-encode to the
      // same H.264/AAC shape the rest of the app produces.
      await run(bin("ffmpeg"), ["-y", "-i", src, "-vsync", "cfr", "-r", "24", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", out]);
      data = await fsp.readFile(out);
    } catch (err) {
      console.warn("[director] ffmpeg remux failed, keeping webm:", err instanceof Error ? err.message : err);
      data = req.file.buffer;
      ext = "webm";
    }
    const url = await saveFile("generations", `video/${randomUUID()}/director-take.${ext}`, data);
    res.json({ url, seconds });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

export default router;
