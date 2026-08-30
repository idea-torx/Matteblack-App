/**
 * Self-check for the chunk-chaining tail extractor.
 * Run: `LOCAL_MODE=true npx tsx server/utils/videoTail.test.ts`
 *
 * The point of this file is that the ffmpeg arguments are actually right — the
 * seek-from-end lands on a real frame, and the tail is the END of the clip and
 * the length we asked for, not a keyframe-rounded whole copy. Those are the two
 * ways a continuation silently degrades into "a vaguely similar new clip".
 */
import assert from "node:assert/strict";
import http from "node:http";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { UPLOADS_DIR } from "../config/runtime.js";
import { extractLastFrame, extractTailClip, VideoTailError } from "./videoTail.js";

const run = promisify(execFile);
const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "tailtest-"));
const localFile = (url: string) => path.resolve(UPLOADS_DIR, url.replace(/^\/uploads\//, ""));

// A 6s clip that changes colour every 2s, so "did we get the END?" is a
// question the pixels can answer: red, then green, then blue.
const src = path.join(dir, "src.mp4");
await run("ffmpeg", [
  "-f", "lavfi", "-i", "color=c=red:s=320x240:d=2",
  "-f", "lavfi", "-i", "color=c=green:s=320x240:d=2",
  "-f", "lavfi", "-i", "color=c=blue:s=320x240:d=2",
  "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1[v]", "-map", "[v]",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "24", "-y", src,
]);

// Serve it over http, because that is how a fal result arrives.
const server = http.createServer(async (_req, res) => {
  res.writeHead(200, { "Content-Type": "video/mp4" });
  res.end(await fsp.readFile(src));
});
await new Promise<void>((r) => server.listen(0, r));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/src.mp4`;

/** Mean RGB of a PNG, via ffmpeg — enough to name a flat colour field. */
async function meanRgb(file: string): Promise<[number, number, number]> {
  const { stderr } = await run("ffmpeg", ["-i", file, "-vf", "signalstats,metadata=mode=print", "-f", "null", "-"]);
  const grab = (k: string) => Number(new RegExp(`lavfi\\.signalstats\\.${k}AVG=([\\d.]+)`).exec(stderr)?.[1] ?? "-1");
  return [grab("Y"), grab("U"), grab("V")];
}

// --- last frame is the LAST frame -------------------------------------------
const frameUrl = await extractLastFrame(url);
assert.match(frameUrl, /\.png$/, "last frame should be filed as a png");
const framePath = localFile(frameUrl);
assert.ok((await fsp.stat(framePath)).size > 0, "extracted frame is empty");
// Blue in YUV: low luma, high U (blue-difference), low V. If -sseof were wrong
// we would land on red (high V) or green (low U and low V).
const [y, u, v] = await meanRgb(framePath);
assert.ok(u > 140 && v < 120, `last frame should be the blue tail, got Y=${y} U=${u} V=${v}`);

// --- tail clip is the end, and the length asked for --------------------------
const tailUrl = await extractTailClip(url, 2);
assert.match(tailUrl, /\.mp4$/, "tail should be filed as an mp4");
const tailPath = localFile(tailUrl);
const dur = async (f: string) => Number(
  (await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", f])).stdout.trim(),
);
const tailDur = await dur(tailPath);
// The whole reason this re-encodes instead of stream-copying: a `-c copy` cut
// here rounds out to the nearest keyframe and hands back all 6 seconds.
assert.ok(Math.abs(tailDur - 2) < 0.5, `tail should be ~2s, got ${tailDur}s`);

// A 2s tail of this clip is the blue segment, so it must not open on red.
const tailHead = path.join(dir, "tailhead.png");
await run("ffmpeg", ["-i", tailPath, "-frames:v", "1", "-y", tailHead]);
const [, tu, tv] = await meanRgb(tailHead);
assert.ok(tu > 140 && tv < 120, `tail should start in the blue segment, got U=${tu} V=${tv}`);

// --- clamps and refusals -----------------------------------------------------
// Over-long requests clamp to the source rather than erroring out.
assert.ok(Math.abs((await dur(localFile(await extractTailClip(url, 99)))) - 6) < 0.5, "should clamp to clip length");
// Under fal's 2s floor, we still hand back 2s rather than an invalid reference.
assert.ok((await dur(localFile(await extractTailClip(url, 0.5)))) > 1.5, "should floor at 2s, not honour 0.5s");

await assert.rejects(
  () => extractLastFrame(`http://127.0.0.1:${(server.address() as { port: number }).port}/nope`.replace("127.0.0.1", "127.0.0.2")),
  "an unreachable source must fail loudly, not return a broken url",
);

// --- the form a real caller actually passes ---------------------------------
// generate_media, list_canvas and every previous chunk hand back a root-relative
// "/uploads/..." path, never a URL. fetch() cannot open one, so a chain broke on
// its second call with "Couldn't read the end of that clip" while the file sat
// on disk. Chaining is the whole feature, so the relative form gets a real
// end-to-end run, not just a unit test of the resolver.
const uploadRel = "/uploads/generations/tails/videotail-selfcheck.mp4";
await fsp.mkdir(path.dirname(localFile(uploadRel)), { recursive: true });
await fsp.copyFile(src, localFile(uploadRel));
const relFrame = localFile(await extractLastFrame(uploadRel));
const [, ru, rv] = await meanRgb(relFrame);
assert.ok(ru > 140 && rv < 120, `relative /uploads/ path must resolve to the same blue tail, got U=${ru} V=${rv}`);
assert.ok(Math.abs((await dur(localFile(await extractTailClip(uploadRel, 2)))) - 2) < 0.4, "relative path tail clip");
await fsp.rm(localFile(uploadRel), { force: true });

// A bare filename is neither a URL nor an upload path — it must say so, not ENOENT.
await assert.rejects(() => extractLastFrame("clip.mp4"), /sourceUrl/, "unresolvable input needs a clear message");

server.close();
await fsp.rm(dir, { recursive: true, force: true });
console.log("videoTail: all checks passed");
