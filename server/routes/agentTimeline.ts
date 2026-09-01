/**
 * Agent timeline — lets the operator act as an editor, not just a generator.
 *
 * Claude generates shots in order, then declares the finished cut here: the
 * whole ordered clip list in one call. The server lays them end to end on the
 * cinema frame's video track (and drops the music bed on the audio track), so
 * the user opens the timeline to a sequence, not a pile of loose clips.
 *
 * Declarative on purpose — one `set_timeline` covers add, reorder, replace and
 * remove, which is the entire editing vocabulary the agent needs.
 */
import { Router, type Response, type NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";
import { requireAuth, type AuthRequest } from "../sessions.js";
import { getMcpToken } from "../mcpToken.js";
import { pool } from "../db.js";
import { broadcastCanvasUpdate } from "./canvas.js";
import { getOperatorContext } from "../services/operatorCanvasContext.js";
import { probeClip, seamDuplicatesFrame } from "../utils/videoTail.js";
import { placeNext, fallbackViewport, type Rect } from "../utils/canvasPlacement.js";

const router = Router();

function requireMcpToken(req: AuthRequest, res: Response, next: NextFunction): void {
  if (process.env.MB_MCP_NO_TOKEN === "1") { next(); return; }
  const expected = getMcpToken();
  if (!expected) { res.status(503).json({ error: "MCP bridge not ready." }); return; }
  if (req.header("x-matteblack-token") !== expected) { res.status(401).json({ error: "Invalid MCP token." }); return; }
  next();
}

/** The canvas the user is looking at — same context the placement path uses. */
function activeCanvas(req: AuthRequest): string | null {
  return getOperatorContext(req.userId ?? "")?.canvasId ?? null;
}

/** Generated results are re-hosted onto the app's own storage, which in the
 *  desktop build means a relative `/uploads/...` URL, not an https one. An
 *  https-only guard here silently dropped every clip the operator sent. */
function usableSrc(src: unknown): src is string {
  return typeof src === "string" && (/^https?:\/\//.test(src) || src.startsWith("/uploads/"));
}

function clipTypeFor(src: string): "video" | "image" | "audio" {
  const ext = (/\.([a-z0-9]+)(?:\?|$)/i.exec(src)?.[1] || "").toLowerCase();
  if (["mp3", "wav", "m4a", "aac", "ogg", "flac"].includes(ext)) return "audio";
  if (["png", "jpg", "jpeg", "webp", "gif", "avif"].includes(ext)) return "image";
  return "video";
}

/** Live (non-tombstoned) clip count for one cinema frame. */
async function clipCount(canvasId: string, nodeId: string): Promise<number> {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM cinema_clips c
       JOIN cinema_tracks t ON t.id = c.track_id
      WHERE c.canvas_id = $1 AND t.node_id = $2
        AND c.id NOT IN (SELECT clip_id FROM cinema_clip_tombstones WHERE canvas_id = $1)`,
    [canvasId, nodeId],
  );
  return (r.rows[0]?.n as number) ?? 0;
}

/** The canvas's cinema frames, oldest first. */
async function cinemaNodes(canvasId: string): Promise<{ id: string; label: string }[]> {
  const r = await pool.query(
    `SELECT id, label FROM canvas_nodes
      WHERE canvas_id = $1 AND node_type = 'cinema'
        AND id NOT IN (SELECT node_id FROM canvas_node_tombstones WHERE canvas_id = $1)
      ORDER BY z_index ASC`,
    [canvasId],
  );
  return r.rows as { id: string; label: string }[];
}

async function createCinemaNode(canvasId: string, userId?: string): Promise<string> {
  const z = await pool.query(`SELECT COALESCE(MAX(z_index), 0) + 1 AS z FROM canvas_nodes WHERE canvas_id = $1`, [canvasId]);
  // Same placement rules as every generated node: avoid everything occupied,
  // prefer the viewport the user is looking at (operator context).
  const size = { w: 1920, h: 1700 };
  const existing = await pool.query(
    `SELECT x, y, width, height, node_type FROM canvas_nodes
      WHERE canvas_id = $1
        AND id NOT IN (SELECT node_id FROM canvas_node_tombstones WHERE canvas_id = $1)`,
    [canvasId],
  );
  const occupied: Rect[] = existing.rows
    .filter((r) => r.node_type !== "frame" && r.node_type !== "group")
    .map((r) => ({ x: Number(r.x), y: Number(r.y), w: Number(r.width), h: Number(r.height) }));
  const viewport = (userId ? getOperatorContext(userId)?.viewport : undefined) ?? fallbackViewport(occupied, size);
  const rect = placeNext({ viewport, occupied, size });
  const nodeId = uuidv4();
  await pool.query(
    `INSERT INTO canvas_nodes (id, canvas_id, node_type, x, y, width, height, rotation, z_index, locked, visible, label, src, gradient, metadata, asset_id, job_id)
     VALUES ($1, $2, 'cinema', $4, $5, $6, $7, 0, $3, true, true, 'Cinema Frame', '', '', '{}', NULL, NULL)`,
    [nodeId, canvasId, z.rows[0]?.z ?? 1, rect.x, rect.y, rect.w, rect.h],
  );
  return nodeId;
}

/**
 * Pick the cinema frame to write to.
 *
 * A named nodeId is the "extend this cut" path. Without one, an existing cut
 * is never clobbered: only an empty frame is reused, otherwise a new frame is
 * added beside it.
 */
async function targetCinemaNode(
  canvasId: string,
  opts: { nodeId?: string; newNode?: boolean; userId?: string },
): Promise<string> {
  const nodes = await cinemaNodes(canvasId);
  if (opts.nodeId) {
    if (!nodes.some((n) => n.id === opts.nodeId)) {
      throw new Error(`No cinema frame ${opts.nodeId} on this canvas — call get_timeline for the current ids.`);
    }
    return opts.nodeId;
  }
  if (!opts.newNode) {
    for (const n of nodes) if ((await clipCount(canvasId, n.id)) === 0) return n.id;
  }
  return createCinemaNode(canvasId, opts.userId);
}

/** One cinema frame's video track plus `audioCount` audio tracks, created on
 *  first use. More than one audio track is what lets a cut carry a music bed,
 *  a voiceover and effects at once — the player and the ffmpeg export already
 *  mix every audio track they find, so the count is the whole feature. */
async function ensureTracks(
  canvasId: string, nodeId: string, audioCount = 1,
): Promise<{ video: string; audio: string[] }> {
  const rows = await pool.query(
    `SELECT id, track_type FROM cinema_tracks WHERE canvas_id = $1 AND node_id = $2 ORDER BY sort_order ASC`,
    [canvasId, nodeId],
  );
  type Row = { id: string; track_type: string };
  let video = (rows.rows as Row[]).find((r) => r.track_type === "video")?.id;
  const audio = (rows.rows as Row[]).filter((r) => r.track_type === "audio").map((r) => r.id);
  const add = async (type: "video" | "audio", sort: number): Promise<string> => {
    const id = uuidv4();
    await pool.query(
      `INSERT INTO cinema_tracks (id, canvas_id, node_id, track_type, sort_order) VALUES ($1, $2, $3, $4, $5)`,
      [id, canvasId, nodeId, type, sort],
    );
    return id;
  };
  if (!video) video = await add("video", 0);
  while (audio.length < audioCount) audio.push(await add("audio", audio.length + 1));
  return { video, audio };
}

/** Clear a track, tombstoning ids so a queued client sync can't resurrect them. */
async function clearTrack(canvasId: string, trackId: string): Promise<void> {
  const existing = await pool.query(`SELECT id FROM cinema_clips WHERE canvas_id = $1 AND track_id = $2`, [canvasId, trackId]);
  for (const row of existing.rows as { id: string }[]) {
    await pool.query(
      `INSERT INTO cinema_clip_tombstones (canvas_id, clip_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [canvasId, row.id],
    );
  }
  await pool.query(`DELETE FROM cinema_clips WHERE canvas_id = $1 AND track_id = $2`, [canvasId, trackId]);
}

async function insertClip(
  canvasId: string, trackId: string,
  clip: { src: string; duration: number; startOffset: number; label: string; sortOrder: number; volume?: number; trimStart?: number },
): Promise<void> {
  await pool.query(
    `INSERT INTO cinema_clips (id, track_id, canvas_id, source_node_id, src, clip_type, duration, start_offset, trim_start, trim_end, volume, label, linked_clip_id, sort_order)
     VALUES ($1, $2, $3, '', $4, $5, $6, $7, $8, 0, $9, $10, NULL, $11)`,
    [uuidv4(), trackId, canvasId, clip.src, clipTypeFor(clip.src), clip.duration, clip.startOffset, clip.trimStart ?? 0, clip.volume ?? 1, clip.label.slice(0, 120), clip.sortOrder],
  );
}

/** A continue_video seam='frame' chunk STARTS on the exact frame its source
 *  clip ENDED on — that is what makes the join invisible in generation, and
 *  what makes the same frame play twice when the chunks sit side by side on
 *  the timeline. Detect those chunks (the job row records continuedFrom +
 *  seam) and trim one frame off their head so the seam doesn't stutter.
 *  ponytail: ~1 frame at 24fps; read the real fps off the clip if a model
 *  ever ships something slower. */
export const SEAM_TRIM_SECONDS = 0.05;

// ponytail: sane ceilings for an assembled cut, not real editor limits.
const MAX_AUDIO_TRACKS = 8;
const MAX_AUDIO_CLIPS = 60;

/** Trim for clip i of the cut: one frame off the head iff it is a seam='frame'
 *  continuation of the clip it actually follows in this list. */
export function seamTrimFor(
  i: number,
  srcs: string[],
  continuations: Map<string, { from: string; seam: string }>,
): number {
  if (i === 0) return 0;
  const cont = continuations.get(srcs[i]);
  return cont && cont.seam === "frame" && cont.from === srcs[i - 1] ? SEAM_TRIM_SECONDS : 0;
}

/** Map result_url -> its generation's {continuedFrom, seam} for the given srcs. */
async function continuationInfo(srcs: string[]): Promise<Map<string, { from: string; seam: string }>> {
  const out = new Map<string, { from: string; seam: string }>();
  if (srcs.length === 0) return out;
  try {
    const r = await pool.query(
      `SELECT result_url, params->>'continuedFrom' AS cf, params->>'seam' AS seam FROM jobs WHERE result_url = ANY($1)`,
      [srcs],
    );
    for (const row of r.rows as { result_url: string; cf: string | null; seam: string | null }[]) {
      // Older jobs recorded continuedFrom but not seam; 'frame' was the default.
      if (row.cf) out.set(row.result_url, { from: row.cf, seam: row.seam ?? "frame" });
    }
  } catch { /* trim is a nicety — never fail the cut over it */ }
  return out;
}

/** Different models mix their audio at different levels, so an agent-assembled
 *  cut jumps in loudness at every clip boundary. Measure each clip's integrated
 *  loudness once (cached on its job row) and level the cut to its QUIETEST clip
 *  — attenuate-only, because the player's element volume can't exceed 1 and a
 *  boost risks clipping. The per-clip `volume` already flows through both the
 *  live player and export, so the number is the whole feature. */
async function clipStatsFor(srcs: string[]): Promise<Map<string, { lufs: number | null; duration: number | null }>> {
  const out = new Map<string, { lufs: number | null; duration: number | null }>();
  const unique = [...new Set(srcs)];
  if (unique.length === 0) return out;
  try {
    const r = await pool.query(
      `SELECT result_url, (params->>'lufs')::float AS lufs, (params->>'probedDuration')::float AS duration
         FROM jobs WHERE result_url = ANY($1)`,
      [unique],
    );
    for (const row of r.rows as { result_url: string; lufs: number | null; duration: number | null }[]) {
      if (row.duration != null) out.set(row.result_url, { lufs: row.lufs, duration: row.duration });
    }
    for (const src of unique) {
      // ponytail: a cached row with no lufs re-probes silent clips every call;
      // store a sentinel if that decode ever shows up in set_timeline latency.
      if (out.get(src)?.lufs != null) continue;
      const probed = await probeClip(src);
      if (probed.durationSeconds == null && probed.lufs == null) continue;
      out.set(src, { lufs: probed.lufs, duration: probed.durationSeconds });
      // Cache on the job row so the next set_timeline skips the decode. A clip
      // with no job row (user upload) just gets re-probed — still correct.
      pool
        .query(
          `UPDATE jobs SET params = params || jsonb_build_object('lufs', $2::float, 'probedDuration', $3::float) WHERE result_url = $1`,
          [src, probed.lufs, probed.durationSeconds],
        )
        .catch(() => { /* cache miss next time, nothing lost */ });
    }
  } catch { /* probing is a nicety — never fail the cut over it */ }
  return out;
}

/** Every clip is levelled to one loudness target. The export applies gains above
 *  1 through ffmpeg; the in-app player clamps at 1, so a quiet clip previews quieter
 *  than it exports. Clamped to ±20 dB so a near-silent decode can't become noise. */
const TARGET_LUFS = -16;
export const gainFor = (lufs: number | null | undefined): number =>
  lufs == null ? 1 : Math.min(10, Math.max(0.1, 10 ** ((TARGET_LUFS - lufs) / 20)));

/** Per-src volume that levels each measured clip to TARGET_LUFS. Pure —
 *  exported for the test. */
export function normalizeVolumes(lufs: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [src, l] of lufs) out.set(src, gainFor(l));
  return out;
}

export type AudioBed = {
  src: string; startSeconds: number; durationSeconds?: number;
  volume?: number; label: string; track: number;
};

/** The `audio` list, cleaned: unusable srcs dropped, tracks clamped into range,
 *  starts and volumes sane. `music` is the one-bed shorthand for the same thing
 *  and is used only when `audio` carries nothing. Pure — exported for the test.
 *
 *  Both keys are declarative: a call carrying either rewrites the frame's audio
 *  tracks, a call carrying neither leaves them alone (checked by the caller, so
 *  an empty list can still clear the audio). */
export function normalizeBeds(body: {
  audio?: unknown;
  music?: { src?: string; durationSeconds?: number; volume?: number } | null;
}): AudioBed[] {
  const vol = (v: unknown) => (typeof v === "number" && isFinite(v) ? Math.max(0, Math.min(1, v)) : undefined);
  const raw = Array.isArray(body.audio) ? (body.audio as Record<string, unknown>[]) : [];
  const beds: AudioBed[] = raw
    .filter((a) => usableSrc(a?.src))
    .slice(0, MAX_AUDIO_CLIPS)
    .map((a, i) => ({
      src: a.src as string,
      startSeconds: typeof a.startSeconds === "number" && a.startSeconds > 0 ? a.startSeconds : 0,
      durationSeconds: typeof a.durationSeconds === "number" && a.durationSeconds > 0 ? a.durationSeconds : undefined,
      volume: vol(a.volume),
      label: typeof a.label === "string" && a.label ? a.label : `Audio ${i + 1}`,
      track: Math.max(0, Math.min(MAX_AUDIO_TRACKS - 1, Math.trunc(Number(a.track) || 0))),
    }));
  if (beds.length === 0 && body.music && usableSrc(body.music.src)) {
    beds.push({
      src: body.music.src, startSeconds: 0, durationSeconds: body.music.durationSeconds,
      volume: vol(body.music.volume), label: "Music", track: 0,
    });
  }
  return beds;
}

/** Every cinema frame on the canvas, each with its own cut, in play order —
 *  so Claude knows which one to extend and which one to leave alone. */
router.get("/api/agent/timeline", requireMcpToken, requireAuth, async (req: AuthRequest, res) => {
  const canvasId = activeCanvas(req);
  if (!canvasId) { res.json({ timelines: [], canvasId: null }); return; }
  try {
    const nodes = await cinemaNodes(canvasId);
    const tracks = await pool.query(`SELECT id, node_id, track_type, muted FROM cinema_tracks WHERE canvas_id = $1 ORDER BY sort_order ASC`, [canvasId]);
    const tombs = await pool.query(`SELECT clip_id FROM cinema_clip_tombstones WHERE canvas_id = $1`, [canvasId]);
    const dead = new Set((tombs.rows as { clip_id: string }[]).map((r) => r.clip_id));
    const clips = await pool.query(
      `SELECT id, track_id, src, duration, start_offset, label FROM cinema_clips WHERE canvas_id = $1 ORDER BY start_offset ASC`,
      [canvasId],
    );
    type Track = { id: string; node_id: string; track_type: string; muted: boolean };
    const trackRows = tracks.rows as Track[];
    const live = (clips.rows as { id: string; track_id: string; src: string; duration: number; start_offset: number; label: string }[])
      .filter((c) => !dead.has(c.id));
    res.json({
      canvasId,
      timelines: nodes.map((n) => {
        const mine = trackRows.filter((t) => t.node_id === n.id);
        const typeOf = new Map(mine.map((t) => [t.id, t.track_type]));
        const audioIndex = new Map(mine.filter((t) => t.track_type === "audio").map((t, i) => [t.id, i]));
        const ours = live.filter((c) => typeOf.has(c.track_id));
        return {
          nodeId: n.id,
          label: n.label || "Cinema Frame",
          clips: ours.filter((c) => typeOf.get(c.track_id) !== "audio")
            .map((c) => ({ src: c.src, durationSeconds: c.duration, startsAt: c.start_offset, label: c.label })),
          audio: ours.filter((c) => typeOf.get(c.track_id) === "audio")
            .map((c) => ({
              src: c.src, durationSeconds: c.duration, startsAt: c.start_offset, label: c.label,
              track: audioIndex.get(c.track_id) ?? 0,
            })),
          // Kept alongside `audio` so an older reader still sees the bed.
          music: ours.filter((c) => typeOf.get(c.track_id) === "audio")
            .map((c) => ({ src: c.src, durationSeconds: c.duration }))[0] ?? null,
          muteVideoAudio: mine.some((t) => t.track_type === "video" && t.muted),
        };
      }),
    });
  } catch (err) {
    console.error("[agent/timeline] load failed:", err);
    res.status(500).json({ error: "Failed to read the timeline." });
  }
});

/** Declare the cut: the full ordered clip list, laid end to end from t=0. */
router.post("/api/agent/timeline", requireMcpToken, requireAuth, async (req: AuthRequest, res) => {
  const canvasId = activeCanvas(req);
  if (!canvasId) { res.status(400).json({ error: "No canvas is open — ask the user to open the canvas first." }); return; }
  const body = (req.body ?? {}) as {
    clips?: { src?: string; durationSeconds?: number; label?: string }[];
    music?: { src?: string; durationSeconds?: number; volume?: number } | null;
    audio?: {
      src?: string; startSeconds?: number; durationSeconds?: number;
      volume?: number; label?: string; track?: number;
    }[] | null;
    muteVideoAudio?: boolean;
    nodeId?: string;
    newNode?: boolean;
  };
  const incoming = (body.clips ?? [])
    .filter((c): c is { src: string; durationSeconds?: number; label?: string } => usableSrc(c?.src));
  if (incoming.length === 0) { res.status(400).json({ error: "Expected a `clips` array of {src, durationSeconds}." }); return; }
  // ponytail: 120-clip ceiling — a sane cap for an ad, not a real editor limit.
  if (incoming.length > 120) { res.status(400).json({ error: "That's more than 120 clips." }); return; }
  const rewriteAudio = "audio" in body || "music" in body;
  const beds = normalizeBeds(body);
  try {
    const nodeId = await targetCinemaNode(canvasId, { nodeId: body.nodeId, newNode: body.newNode === true, userId: req.userId });
    const audioTracksNeeded = Math.max(1, ...beds.map((b) => b.track + 1));
    const { video, audio } = await ensureTracks(canvasId, nodeId, audioTracksNeeded);
    // Always written, not only when true, so a later call without the flag
    // unmutes — `set_timeline` is declarative everywhere else and a mute you
    // can set but not clear is a trap.
    const muteVideoAudio = body.muteVideoAudio === true;
    await pool.query(`UPDATE cinema_tracks SET muted = $3 WHERE canvas_id = $1 AND id = $2`, [canvasId, video, muteVideoAudio]);
    await clearTrack(canvasId, video);
    const continuations = await continuationInfo(incoming.map((c) => c.src));
    // Real durations, not requested ones: a "15s" generation is ~15.1s on disk,
    // and laying clips by the requested length chops the end of every clip and
    // compounds the drift down the cut.
    const stats = await clipStatsFor(incoming.map((c) => c.src));
    const lufs = new Map<string, number>();
    for (const [src, s] of stats) if (s.lufs != null) lufs.set(src, s.lufs);
    const volumes = muteVideoAudio ? new Map<string, number>() : normalizeVolumes(lufs);
    let at = 0;
    for (const [i, c] of incoming.entries()) {
      const declared = Number.isFinite(c.durationSeconds) && (c.durationSeconds as number) > 0 ? (c.durationSeconds as number) : 5;
      const duration = stats.get(c.src)?.duration ?? declared;
      // Trim only when the continuation really duplicates the seam frame —
      // some models don't, and trimming real motion skips the cut forward.
      let trimStart = seamTrimFor(i, incoming.map((x) => x.src), continuations);
      if (trimStart > 0 && !(await seamDuplicatesFrame(incoming[i - 1].src, c.src))) trimStart = 0;
      await insertClip(canvasId, video, { src: c.src, duration, startOffset: at, label: c.label ?? `Shot ${i + 1}`, sortOrder: i, trimStart, volume: volumes.get(c.src) ?? 1 });
      at += duration - trimStart;
    }
    if (rewriteAudio) {
      for (const trackId of audio) await clearTrack(canvasId, trackId);
      // Real durations again: a voiceover's length is whatever the model spoke,
      // and the agent has no way to know it before laying it down.
      const bedStats = await clipStatsFor(beds.map((b) => b.src));
      const perTrack = new Map<number, number>();
      for (const b of beds) {
        const sortOrder = perTrack.get(b.track) ?? 0;
        perTrack.set(b.track, sortOrder + 1);
        await insertClip(canvasId, audio[b.track], {
          src: b.src,
          duration: Math.min(bedStats.get(b.src)?.duration ?? b.durationSeconds ?? at, at - b.startSeconds),
          startOffset: b.startSeconds, label: b.label, sortOrder,
          volume: (b.volume ?? 0.8) * gainFor(bedStats.get(b.src)?.lufs),
        });
      }
    }
    broadcastCanvasUpdate(canvasId, "");
    res.json({ clips: incoming.length, audioClips: rewriteAudio ? beds.length : undefined, totalSeconds: at, canvasId, nodeId, muteVideoAudio });
  } catch (err) {
    console.error("[agent/timeline] write failed:", err);
    const msg = err instanceof Error && err.message.startsWith("No cinema frame")
      ? err.message
      : "Failed to write the timeline.";
    res.status(msg === "Failed to write the timeline." ? 500 : 400).json({ error: msg });
  }
});

export default router;
