/**
 * Native cinema export — the renderer's ffmpeg.wasm encode of a full cut takes
 * minutes; the same job on the system ffmpeg (already a hard dependency for
 * seam extraction, see utils/videoTail.ts) takes seconds. The client POSTs its
 * timeline state and export config here; the command is built by the SAME
 * buildFFmpegCommand the wasm path uses, so the two exports can never drift.
 * The wasm path stays behind as the fallback when this route fails.
 */
import { Router } from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requireAuth, type AuthRequest } from "../sessions.js";
import { UPLOADS_DIR } from "../config/runtime.js";
import { resolveUploadFile } from "../utils/uploadPath.js";
import { bin } from "../setup/doctor.js";
import {
  buildFFmpegCommand,
  type ExportConfig,
  type StreamInfo,
} from "../../src/features/cinema-frame/helpers/buildFFmpegCommand";
import {
  getEffectiveDuration,
  getTotalDuration,
  type TimelineState,
} from "../../src/features/cinema-frame/helpers/timelineState";

const run = promisify(execFile);
const router = Router();

async function probe(file: string): Promise<StreamInfo> {
  const { stdout } = await run(bin("ffprobe"), [
    "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height", "-of", "json", file,
  ]);
  const streams = (JSON.parse(String(stdout)).streams ?? []) as
    { codec_type?: string; codec_name?: string; width?: number; height?: number }[];
  const v = streams.find((s) => s.codec_type === "video");
  return {
    hasAudio: streams.some((s) => s.codec_type === "audio"),
    isH264: v?.codec_name === "h264",
    width: v?.width,
    height: v?.height,
  };
}

router.get("/api/cinema/exports/:name", requireAuth, (req: AuthRequest, res) => {
  const file = path.join(UPLOADS_DIR, "exports", path.basename(req.params.name));
  res.download(file, req.params.name.replace(/^\d+-/, ""));
});

router.post("/api/cinema/export", requireAuth, async (req: AuthRequest, res) => {
  const { timeline, config } = (req.body ?? {}) as { timeline?: TimelineState; config?: ExportConfig };
  if (!timeline?.tracks || !config?.filename) {
    res.status(400).json({ error: "Expected { timeline, config }." });
    return;
  }
  // The filename becomes a path inside the temp dir — basename only, safe chars.
  const safeName = path.basename(config.filename).replace(/[^\w.-]/g, "_") || "export";
  const cfg: ExportConfig = { ...config, filename: safeName };

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "falforge-export-"));
  const cleanup = () => fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  try {
    const clipFileMap = new Map<string, string>();
    const streamInfoMap = new Map<string, StreamInfo>();
    const fileBySrc = new Map<string, string>();
    const infoBySrc = new Map<string, StreamInfo>();
    const allClips = timeline.tracks.flatMap((t) => t.clips).filter((c) => c.src && getEffectiveDuration(c) > 0);
    let idx = 0;
    for (const clip of allClips) {
      let file = fileBySrc.get(clip.src);
      if (!file) {
        const local = resolveUploadFile(clip.src, UPLOADS_DIR);
        if (local) {
          file = local;
        } else if (/^https?:\/\//i.test(clip.src)) {
          const r = await fetch(clip.src);
          if (!r.ok) throw new Error(`Couldn't download clip (${r.status}): ${clip.src}`);
          file = path.join(dir, `input_${idx++}${clip.type === "audio" ? ".mp3" : ".mp4"}`);
          await fsp.writeFile(file, Buffer.from(await r.arrayBuffer()));
        } else {
          // blob:/data: etc — this route can't reach it; the client falls back to wasm.
          throw new Error(`Unreachable clip src: ${clip.src.slice(0, 40)}`);
        }
        fileBySrc.set(clip.src, file);
      }
      clipFileMap.set(clip.id, file);
      // Probed for every clip type: an audio-track mirror clip can point at a
      // silent video, and a hardcoded hasAudio would reference a stream that
      // isn't there.
      let info = infoBySrc.get(clip.src);
      if (!info) { info = await probe(file); infoBySrc.set(clip.src, info); }
      streamInfoMap.set(clip.id, info);
    }
    if (clipFileMap.size === 0) { await cleanup(); res.status(400).json({ error: "No clips to export." }); return; }

    const { args, concatListContent } = buildFFmpegCommand(
      timeline, clipFileMap, cfg, getTotalDuration(timeline), streamInfoMap,
    );
    if (concatListContent) await fsp.writeFile(path.join(dir, "concat_list.txt"), concatListContent);
    // cwd=dir: the built args reference concat_list.txt and the output by bare name.
    await run(bin("ffmpeg"), ["-y", ...args], { cwd: dir, maxBuffer: 64 * 1024 * 1024 });

    const out = path.join(dir, safeName.endsWith(".mp4") ? safeName : `${safeName}.mp4`);
    // Move the result into a served exports dir and hand back a GET URL
    // instead of streaming bytes in the POST response: a plain attachment URL
    // is the only download path iOS Safari honors (a post-fetch blob +
    // synthetic click is silently dropped), and it skips the in-memory blob.
    const exportsDir = path.join(UPLOADS_DIR, "exports");
    await fsp.mkdir(exportsDir, { recursive: true });
    const servedName = `${Date.now()}-${path.basename(out)}`;
    await fsp.copyFile(out, path.join(exportsDir, servedName));
    await cleanup();
    res.json({ url: `/api/cinema/exports/${encodeURIComponent(servedName)}` });
  } catch (err) {
    await cleanup();
    console.error("[cinema/export] native export failed:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Export failed." });
    }
  }
});

export default router;
