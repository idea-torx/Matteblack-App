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

/** Find the canvas's cinema frame, creating one if the user hasn't yet. */
async function ensureCinemaNode(canvasId: string): Promise<string> {
  const found = await pool.query(
    `SELECT id FROM canvas_nodes
      WHERE canvas_id = $1 AND node_type = 'cinema'
        AND id NOT IN (SELECT node_id FROM canvas_node_tombstones WHERE canvas_id = $1)
      LIMIT 1`,
    [canvasId],
  );
  if (found.rows.length > 0) return found.rows[0].id as string;
  const z = await pool.query(`SELECT COALESCE(MAX(z_index), 0) + 1 AS z FROM canvas_nodes WHERE canvas_id = $1`, [canvasId]);
  const nodeId = uuidv4();
  await pool.query(
    `INSERT INTO canvas_nodes (id, canvas_id, node_type, x, y, width, height, rotation, z_index, locked, visible, label, src, gradient, metadata, asset_id, job_id)
     VALUES ($1, $2, 'cinema', 0, 0, 1920, 1700, 0, $3, true, true, 'Cinema Frame', '', '', '{}', NULL, NULL)`,
    [nodeId, canvasId, z.rows[0]?.z ?? 1],
  );
  return nodeId;
}

/** One cinema frame's video + audio tracks, created on first use. */
async function ensureTracks(canvasId: string, nodeId: string): Promise<{ video: string; audio: string }> {
  const rows = await pool.query(
    `SELECT id, track_type FROM cinema_tracks WHERE canvas_id = $1 AND node_id = $2 ORDER BY sort_order ASC`,
    [canvasId, nodeId],
  );
  const pick = (t: string) => rows.rows.find((r: { track_type: string }) => r.track_type === t)?.id as string | undefined;
  let video = pick("video");
  let audio = pick("audio");
  for (const [type, sort] of [["video", 0], ["audio", 1]] as const) {
    const have = type === "video" ? video : audio;
    if (have) continue;
    const id = uuidv4();
    await pool.query(
      `INSERT INTO cinema_tracks (id, canvas_id, node_id, track_type, sort_order) VALUES ($1, $2, $3, $4, $5)`,
      [id, canvasId, nodeId, type, sort],
    );
    if (type === "video") video = id; else audio = id;
  }
  return { video: video!, audio: audio! };
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
  clip: { src: string; duration: number; startOffset: number; label: string; sortOrder: number; volume?: number },
): Promise<void> {
  await pool.query(
    `INSERT INTO cinema_clips (id, track_id, canvas_id, source_node_id, src, clip_type, duration, start_offset, trim_start, trim_end, volume, label, linked_clip_id, sort_order)
     VALUES ($1, $2, $3, '', $4, $5, $6, $7, 0, 0, $8, $9, NULL, $10)`,
    [uuidv4(), trackId, canvasId, clip.src, clipTypeFor(clip.src), clip.duration, clip.startOffset, clip.volume ?? 1, clip.label.slice(0, 120), clip.sortOrder],
  );
}

/** The cut as it stands, in play order — so Claude can reason about what to fix. */
router.get("/api/agent/timeline", requireMcpToken, requireAuth, async (req: AuthRequest, res) => {
  const canvasId = activeCanvas(req);
  if (!canvasId) { res.json({ clips: [], music: null, canvasId: null }); return; }
  try {
    const tracks = await pool.query(`SELECT id, track_type, muted FROM cinema_tracks WHERE canvas_id = $1`, [canvasId]);
    const tombs = await pool.query(`SELECT clip_id FROM cinema_clip_tombstones WHERE canvas_id = $1`, [canvasId]);
    const dead = new Set((tombs.rows as { clip_id: string }[]).map((r) => r.clip_id));
    const clips = await pool.query(
      `SELECT id, track_id, src, clip_type, duration, start_offset, label FROM cinema_clips WHERE canvas_id = $1 ORDER BY start_offset ASC`,
      [canvasId],
    );
    const typeOf = new Map((tracks.rows as { id: string; track_type: string }[]).map((t) => [t.id, t.track_type]));
    const live = (clips.rows as { id: string; track_id: string; src: string; duration: number; start_offset: number; label: string }[])
      .filter((c) => !dead.has(c.id));
    res.json({
      canvasId,
      clips: live.filter((c) => typeOf.get(c.track_id) !== "audio")
        .map((c) => ({ src: c.src, durationSeconds: c.duration, startsAt: c.start_offset, label: c.label })),
      music: live.filter((c) => typeOf.get(c.track_id) === "audio")
        .map((c) => ({ src: c.src, durationSeconds: c.duration }))[0] ?? null,
      muteVideoAudio: (tracks.rows as { track_type: string; muted: boolean }[])
        .some((t) => t.track_type === "video" && t.muted),
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
    muteVideoAudio?: boolean;
  };
  const incoming = (body.clips ?? [])
    .filter((c): c is { src: string; durationSeconds?: number; label?: string } => usableSrc(c?.src));
  if (incoming.length === 0) { res.status(400).json({ error: "Expected a `clips` array of {src, durationSeconds}." }); return; }
  // ponytail: 120-clip ceiling — a sane cap for an ad, not a real editor limit.
  if (incoming.length > 120) { res.status(400).json({ error: "That's more than 120 clips." }); return; }
  try {
    const nodeId = await ensureCinemaNode(canvasId);
    const { video, audio } = await ensureTracks(canvasId, nodeId);
    // Always written, not only when true, so a later call without the flag
    // unmutes — `set_timeline` is declarative everywhere else and a mute you
    // can set but not clear is a trap.
    const muteVideoAudio = body.muteVideoAudio === true;
    await pool.query(`UPDATE cinema_tracks SET muted = $3 WHERE canvas_id = $1 AND id = $2`, [canvasId, video, muteVideoAudio]);
    await clearTrack(canvasId, video);
    let at = 0;
    for (const [i, c] of incoming.entries()) {
      const duration = Number.isFinite(c.durationSeconds) && (c.durationSeconds as number) > 0 ? (c.durationSeconds as number) : 5;
      await insertClip(canvasId, video, { src: c.src, duration, startOffset: at, label: c.label ?? `Shot ${i + 1}`, sortOrder: i });
      at += duration;
    }
    const music = body.music;
    if (music && usableSrc(music.src)) {
      await clearTrack(canvasId, audio);
      await insertClip(canvasId, audio, {
        src: music.src,
        duration: Number.isFinite(music.durationSeconds) && (music.durationSeconds as number) > 0 ? (music.durationSeconds as number) : at,
        startOffset: 0, label: "Music", sortOrder: 0, volume: music.volume ?? 0.8,
      });
    }
    broadcastCanvasUpdate(canvasId, "");
    res.json({ clips: incoming.length, totalSeconds: at, canvasId, muteVideoAudio });
  } catch (err) {
    console.error("[agent/timeline] write failed:", err);
    res.status(500).json({ error: "Failed to write the timeline." });
  }
});

export default router;
