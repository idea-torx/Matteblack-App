/**
 * Pulling the tail off a finished clip, so the next clip can start where it
 * ended. This is the one primitive chunk-chained long-form video needs that
 * H3 does not give us: fal returns a video URL, and a continuation needs
 * either that video's last frame (a hard seam) or its final seconds (a soft,
 * motion-carrying seam) as an input to the next generation.
 *
 * The technique is ComfyUI-HR-Endless-Sampler's, minus the parts that only
 * work with local weights. There, chunks are continued inside one sampling
 * pass. Here each chunk is a complete generation conditioned on the previous
 * one through H3's own documented reference inputs, which is why it ports to a
 * hosted API at all.
 *
 * ponytail: shells out to the system ffmpeg rather than bundling one. The app
 * already ships @ffmpeg/ffmpeg for browser-side export, but that is wasm in the
 * renderer and this runs in the server process. Swap in fluent-ffmpeg or a
 * static binary if this ever has to run somewhere ffmpeg isn't on PATH.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { saveFile } from "../storage.js";
import { UPLOADS_DIR } from "../config/runtime.js";
import { resolveUploadFile } from "./uploadPath.js";

const run = promisify(execFile);

/** Where extracted tails are filed. Same bucket the generators write to. */
const BUCKET = "generations";

/** fal caps a reference video at 15s and refuses anything under 2s. */
export const MIN_TAIL_SECONDS = 2;
export const MAX_TAIL_SECONDS = 15;
/** Default tail for seam='reference'. More tail carries more motion and
 *  identity context at no extra cost; extractTailClip clamps it to the source
 *  clip's own length, so this is safe against 5s chunks. */
export const DEFAULT_TAIL_SECONDS = 6;

export class VideoTailError extends Error {}

/** One probe, so a missing ffmpeg is reported once and clearly. */
let ffmpegChecked: Promise<void> | null = null;
function ensureFfmpeg(): Promise<void> {
  ffmpegChecked ??= run("ffmpeg", ["-version"]).then(
    () => undefined,
    () => {
      throw new VideoTailError(
        "ffmpeg is not installed or not on PATH, so video continuation can't read the end of a clip. Install it with `brew install ffmpeg`.",
      );
    },
  );
  return ffmpegChecked;
}

/**
 * Get the source clip onto local disk.
 *
 * A LOCAL_MODE generation result is a root-relative "/uploads/..." path, not a
 * URL — that is what generate_media, list_canvas and every previous chunk hand
 * back, so it is what a continuation is always called with. fetch() cannot take
 * one, so read it off disk instead of round-tripping through our own HTTP
 * server. Anything absolute (fal's CDN, R2) still downloads.
 */
async function fetchToTemp(videoUrl: string, dir: string): Promise<string> {
  const file = path.join(dir, "src.mp4");
  const local = resolveUploadFile(videoUrl, UPLOADS_DIR);
  if (local) {
    await fsp.copyFile(local, file).catch(() => {
      throw new VideoTailError(`That clip isn't on disk any more: ${videoUrl}`);
    });
    return file;
  }
  if (!/^https?:\/\//i.test(videoUrl)) {
    throw new VideoTailError(
      `Can't read that clip — \`sourceUrl\` must be a http(s) URL or an /uploads/ path, got: ${videoUrl}`,
    );
  }
  const res = await fetch(videoUrl);
  if (!res.ok) throw new VideoTailError(`Couldn't download the source clip (${res.status}).`);
  await fsp.writeFile(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

/** Clip length in seconds, via ffprobe. */
async function durationOf(file: string): Promise<number> {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", file,
  ]);
  const d = Number(String(stdout).trim());
  if (!isFinite(d) || d <= 0) throw new VideoTailError("Couldn't read the source clip's duration.");
  return d;
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "falforge-tail-"));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => { /* temp cleanup is best-effort */ });
  }
}

/**
 * The clip's final frame, as a hosted PNG.
 *
 * Seeks from the end rather than to an absolute timestamp: the caller knows the
 * clip it generated, not its exact frame count, and `-sseof` lands near the end
 * even when the container's duration is slightly off.
 *
 * `-update 1` with NO `-frames:v` is the whole trick, and it is load-bearing.
 * `-sseof -1` starts output one second before the end, so `-frames:v 1` stops
 * at the FIRST frame of that second — a 25fps clip came back 24 frames early.
 * Without it, ffmpeg decodes the last second and `-update` overwrites the same
 * PNG each frame, so what survives is the last one.
 */
export async function extractLastFrame(videoUrl: string): Promise<string> {
  await ensureFfmpeg();
  return withTempDir(async (dir) => {
    const src = await fetchToTemp(videoUrl, dir);
    const out = path.join(dir, "last.png");
    await run("ffmpeg", ["-sseof", "-1", "-i", src, "-update", "1", "-y", out]);
    const data = await fsp.readFile(out).catch(() => {
      throw new VideoTailError("ffmpeg produced no frame from the end of that clip.");
    });
    return saveFile(BUCKET, `tails/${randomUUID()}.png`, data);
  });
}

/**
 * The clip's final `seconds`, as a hosted mp4, for use as an H3 `<Video N>`
 * reference. Re-encoded rather than stream-copied: a copy cuts on the nearest
 * keyframe, which on a 5s generation can be the whole clip.
 */
export async function extractTailClip(videoUrl: string, seconds: number): Promise<string> {
  await ensureFfmpeg();
  return withTempDir(async (dir) => {
    const src = await fetchToTemp(videoUrl, dir);
    const total = await durationOf(src);
    // Never ask for more tail than the clip has, and never fall under fal's 2s
    // floor — a 1.5s request against a 5s source silently fails validation.
    const want = Math.min(MAX_TAIL_SECONDS, Math.max(MIN_TAIL_SECONDS, seconds));
    if (total < MIN_TAIL_SECONDS) {
      throw new VideoTailError(
        `That clip is only ${total.toFixed(1)}s; a continuation reference has to be at least ${MIN_TAIL_SECONDS}s.`,
      );
    }
    const take = Math.min(want, total);
    const out = path.join(dir, "tail.mp4");
    await run("ffmpeg", [
      "-ss", String(Math.max(0, total - take)), "-i", src,
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-movflags", "+faststart", "-y", out,
    ]);
    const data = await fsp.readFile(out).catch(() => {
      throw new VideoTailError("ffmpeg produced no tail clip from that video.");
    });
    return saveFile(BUCKET, `tails/${randomUUID()}.mp4`, data);
  });
}
