/**
 * Matte operator routes (Phase K) — the in-app agent console backed by the user's
 * Claude Code subscription (see server/operator/claudeOperator.ts).
 *
 *   GET  /api/operator/status   — is the operator configured (token + binary)?
 *   POST /api/operator/message  — SSE stream of one operator turn.
 */
import { Router } from "express";
import { requireAuth, type AuthRequest } from "../sessions.js";
import { runOperator, operatorStatus, OperatorNotConfiguredError, EFFORT_LEVELS, type OperatorEvent, type EffortLevel } from "../operator/claudeOperator.js";
import { setOperatorContext, takeOperatorJobs } from "../services/operatorCanvasContext.js";
import { pool } from "../db.js";
import type { Viewport } from "../utils/canvasPlacement.js";
import fs from "node:fs";
import path from "node:path";
import { UPLOADS_DIR } from "../config/runtime.js";
import { REPOS_DIR } from "../github/ghCli.js";
import { resolveUploadPath } from "../utils/uploadPath.js";

const router = Router();

/** Parse the {cx,cy,w,h} viewport the OperatorPanel reports at send time. */
function parseViewport(v: unknown): Viewport | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const nums = ["cx", "cy", "w", "h"].map((k) => o[k]);
  if (nums.some((n) => typeof n !== "number" || !Number.isFinite(n))) return undefined;
  const [cx, cy, w, h] = nums as number[];
  if (w <= 0 || h <= 0) return undefined;
  return { cx, cy, w, h };
}

/** Attachments are staged here so the spawned claude can Read them: its cwd is
 *  pinned to REPOS_DIR, and anything outside that needs a permission prompt. */
const ATTACH_DIR = path.join(REPOS_DIR, ".attachments");

const EXT_FOR_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

/**
 * Copy the turn's reference images into the operator's working directory and
 * return their paths.
 *
 * The operator runs as a `claude -p` subprocess, so there is no message array to
 * push vision blocks onto — the only way it can actually SEE an attachment is to
 * Read the file. Without this it got a text note saying images were attached and
 * nothing else, and correctly reported that it couldn't see them.
 *
 * ponytail: the whole staging dir is wiped each turn. Single-user desktop app,
 * one turn in flight at a time — give each turn its own subdir if that changes.
 */
async function stageAttachments(urls: string[]): Promise<string[]> {
  try { fs.rmSync(ATTACH_DIR, { recursive: true, force: true }); } catch { /* first run */ }
  const paths: string[] = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      let bytes: Buffer;
      let ext: string;
      const local = resolveUploadPath(url, UPLOADS_DIR);
      if (local) {
        bytes = fs.readFileSync(local.path);
        ext = EXT_FOR_MIME[local.mime] || ".png";
      } else if (/^https?:\/\//i.test(url)) {
        const r = await fetch(url);
        if (!r.ok) continue;
        bytes = Buffer.from(await r.arrayBuffer());
        ext = EXT_FOR_MIME[(r.headers.get("content-type") || "").split(";")[0].trim()] || ".png";
      } else if (url.startsWith("data:image/")) {
        const m = url.match(/^data:([^;]+);base64,(.+)$/);
        if (!m) continue;
        bytes = Buffer.from(m[2], "base64");
        ext = EXT_FOR_MIME[m[1]] || ".png";
      } else {
        continue;
      }
      fs.mkdirSync(ATTACH_DIR, { recursive: true });
      const full = path.join(ATTACH_DIR, `reference-${i + 1}${ext}`);
      fs.writeFileSync(full, bytes);
      paths.push(full);
    } catch {
      /* one bad attachment must not fail the turn */
    }
  }
  return paths;
}

export type GenerationRow = {
  type: string; model: string | null; status: string;
  result_url: string | null; prompt: string | null; created_at: string | Date;
};

/** The "what you actually generated" block. Pure — exported for the test. */
export function formatGenerationsNote(rows: GenerationRow[], now: number): string {
  if (rows.length === 0) return "";
  const lines = rows.map((r) => {
    const mins = Math.max(0, Math.round((now - new Date(r.created_at).getTime()) / 60000));
    const prompt = (r.prompt || "").replace(/\s+/g, " ").slice(0, 80);
    return `- ${mins}m ago — ${r.type} (${r.model || "?"}) ${r.status}${r.result_url ? ` → ${r.result_url}` : ""}${prompt ? ` — "${prompt}"` : ""}`;
  });
  return `\n\n[System note: generation jobs you dispatched in the last 30 minutes, from the app's job log. This list is ground truth — if a turn was interrupted, your own history may be missing tool results for jobs that still ran and landed on the canvas. Trust this list over your memory when deciding whether something was already generated; check list_canvas before regenerating.\n${lines.join("\n")}]`;
}

router.get("/api/operator/status", requireAuth, (_req: AuthRequest, res) => {
  res.json(operatorStatus());
});

router.post("/api/operator/message", requireAuth, async (req: AuthRequest, res) => {
  const body = (req.body || {}) as {
    message?: unknown; sessionId?: unknown; model?: unknown; effort?: unknown; canvasId?: unknown; viewport?: unknown;
    referenceUrls?: unknown; referenceAspectRatio?: unknown; selectedNodeIds?: unknown;
  };
  let message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }
  const sessionId = typeof body.sessionId === "string" && body.sessionId ? body.sessionId : undefined;
  const model = typeof body.model === "string" && body.model ? body.model : undefined;
  // Anything not on the allowlist is dropped rather than passed through — an
  // unrecognised --effort makes the CLI exit before the stream starts.
  const effort = EFFORT_LEVELS.includes(body.effort as EffortLevel)
    ? (body.effort as EffortLevel)
    : undefined;

  // Attached reference images (canvas selection + uploads). These are merged
  // into the generation's referenceUrls server-side at /api/agent/tool.
  const referenceUrls: string[] = Array.isArray(body.referenceUrls)
    ? body.referenceUrls.filter((u): u is string => typeof u === "string" && u.length > 0).slice(0, 4)
    : [];
  const referenceAspectRatio = typeof body.referenceAspectRatio === "string" && body.referenceAspectRatio
    ? body.referenceAspectRatio
    : undefined;

  // Capture where the user is looking, so operator generations land on the
  // canvas they have open, at their viewport. Read back in /api/agent/tool.
  const canvasId = typeof body.canvasId === "string" && body.canvasId ? body.canvasId : undefined;
  const viewport = parseViewport(body.viewport);
  if (req.userId) setOperatorContext(req.userId, { canvasId, viewport, referenceUrls, referenceAspectRatio });

  // Ground truth about recent generations, injected every turn. The operator's
  // own history is lossy in exactly the moment it matters: interrupting a turn
  // kills the claude process mid-tool-call, so the generate_media that was in
  // flight leaves no tool_result in the transcript — the job still completes
  // and lands on the canvas, but on resume the agent truthfully "remembers"
  // generating nothing and denies it. Compaction loses the same records. The
  // jobs table doesn't forget, so it outranks the transcript.
  let generationsNote = "";
  if (req.userId) {
    try {
      const jobs = await pool.query(
        `SELECT type, model, status, result_url, params->>'prompt' AS prompt, created_at
           FROM jobs
          WHERE user_id = $1 AND params->>'source' = 'agent'
            AND created_at > NOW() - INTERVAL '30 minutes'
          ORDER BY created_at DESC LIMIT 6`,
        [req.userId],
      );
      generationsNote = formatGenerationsNote(jobs.rows as GenerationRow[], Date.now());
    } catch { /* the note is a nicety; never fail the turn over it */ }
  }
  message += generationsNote;

  let selectionNote = "";
  // The canvas selection, by node id. Selecting a rendered piece is how the user
  // says "this one" — without the id the agent can only guess from list_canvas,
  // and for an HTML render it can't revise in place at all.
  const selectedNodeIds: string[] = Array.isArray(body.selectedNodeIds)
    // uuid-shaped only: the selection can also hold synthetic ids (axiom slices,
    // in-flight generations), and one of those makes the whole query throw.
    ? body.selectedNodeIds.filter((v): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v)).slice(0, 4)
    : [];
  if (canvasId && selectedNodeIds.length > 0) {
    try {
      const sel = await pool.query(
        `SELECT id, label, node_type, metadata->>'kind' AS kind FROM canvas_nodes
          WHERE id = ANY($1::uuid[]) AND canvas_id = $2`,
        [selectedNodeIds, canvasId],
      );
      const rows = sel.rows as { id: string; label: string | null; node_type: string; kind: string | null }[];
      if (rows.length > 0) {
        const lines = rows.map((r) => `- ${r.id} — ${r.node_type}${r.label ? ` "${String(r.label).slice(0, 60)}"` : ""}${r.kind === "html" ? " (rendered from HTML)" : ""}`);
        let note = `\n\n[System note: the user has ${rows.length === 1 ? "this canvas node" : "these canvas nodes"} selected right now — when they say "this", "it", or "the ad", they mean ${rows.length === 1 ? "this one" : "these"}:\n${lines.join("\n")}`;
        if (rows.some((r) => r.kind === "html")) {
          note += `\nFor an HTML-rendered node: call get_html with that nodeId to read its markup, edit the markup, then call render_html with the SAME nodeId to replace it in place. Do not re-render it as a new node, and do not regenerate it with generate_media.`;
        }
        note += `]`;
        selectionNote = note;
      }
    } catch { /* selection is a hint; a bad id must not fail the turn */ }
  }

  // Tell Claude an image is attached AND that it's supplied to the tools
  // automatically — otherwise Claude assumes it can only reference images that
  // are already on the canvas (it has no URL of its own to pass) and asks the
  // user to add it. The actual URLs are injected server-side at /api/agent/tool.
  if (referenceUrls.length > 0) {
    const n = referenceUrls.length;
    const it = n > 1 ? "them" : "it";
    const img = n > 1 ? "images" : "image";
    const staged = await stageAttachments(referenceUrls);
    let note = `\n\n[System note: the user attached ${n} reference ${img} for this request.`;
    if (staged.length > 0) {
      note += ` To SEE ${it}, use the Read tool on ${staged.length > 1 ? "these files" : "this file"}: ${staged.join(", ")}. Read ${it} before answering anything about what the ${img} look${n > 1 ? "" : "s"} like.`;
    }
    note += ` ${n > 1 ? "They are" : "It is"} automatically provided to the generation tools as the reference — you do NOT need a URL and ${it} does NOT need to be on the canvas. To edit, restyle, recolor, or build on the attached ${img}, call generate_media now (the attached ${img} ${n > 1 ? "are" : "is"} passed as ${it}s reference). Use transform_media only for background removal, upscaling, or resizing. Do NOT ask the user to add ${it} to the canvas.`;
    // The URLs, verbatim. The auto-injection above only covers THIS turn: the
    // context store is re-set (to []) on every message, so a follow-up like
    // "now make another video from that image" arrives with no reference at
    // all and silently generates text-to-video — which is exactly the moment
    // continuity is lost. Holding the URLs means the agent can re-pass them.
    note += ` Reference URL${n > 1 ? "s" : ""}: ${referenceUrls.join(", ")}. Keep ${n > 1 ? "these" : "this"} for the rest of the conversation: on ANY later generation that continues the same subject — a second video, a variation, another shot — pass ${it} yourself in referenceUrls, because the automatic attachment only applies to this message. Omitting ${it} does not error; it silently falls back to text-to-video and the subject will not match.`;
    if (referenceAspectRatio) {
      note += ` The attached ${img} ${n > 1 ? "are" : "is"} ${referenceAspectRatio} — use aspectRatio "${referenceAspectRatio}" to keep the lineage consistent, unless the user asked for a different shape.`;
    }
    note += `]`;
    message += note;
  }
  // Last, so it outranks the attachment note above: that note pushes toward
  // generate_media, which is the wrong move for a piece the user selected to
  // revise.
  message += selectionNote;

  // SSE headers.
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (event: OperatorEvent | { type: "ping" }) => {
    try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* client gone */ }
  };
  // Initial ping so the client knows the stream is live.
  send({ type: "ping" });

  // Abort the claude process if the client disconnects.
  //
  // Killing claude only ends the reasoning. Anything it already dispatched is a
  // queued fal job that keeps running, keeps charging, and keeps dropping onto
  // the canvas — so Stop looked like it did nothing and the only way out was
  // quitting the app. Cancel this turn's jobs too: same status flip as
  // /api/job/:id/cancel, which the fal.ts polling loop watches for and turns
  // into a fal.queue.cancel.
  const ac = new AbortController();
  // 'close' also fires on a normal res.end(), and cancelling a completed turn's
  // jobs would be a worse bug than the one being fixed. The finally block below
  // runs first, so this flag is already true by then.
  let finished = false;
  req.on("close", () => {
    ac.abort();
    if (finished) return;
    const ids = req.userId ? takeOperatorJobs(req.userId) : [];
    if (ids.length === 0) return;
    pool
      .query(
        `UPDATE jobs SET status = 'cancelled'
          WHERE id = ANY($1::uuid[]) AND user_id = $2
            AND status IN ('queued', 'pending', 'processing')`,
        [ids, req.userId],
      )
      .catch((err) => console.error("[operator] failed to cancel in-flight jobs:", err));
  });

  try {
    const { sessionId: finalSession } = await runOperator({
      message,
      sessionId,
      model,
      effort,
      signal: ac.signal,
      onEvent: (e) => send(e),
    });
    // Redundant with the parsed 'done' event, but guarantees the client has the
    // resumable session id even if the result line was malformed.
    if (finalSession) send({ type: "session", sessionId: finalSession });
  } catch (err) {
    if (err instanceof OperatorNotConfiguredError) {
      send({ type: "error", message: err.message });
    } else {
      send({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  } finally {
    finished = true;
    try { res.write("event: end\ndata: {}\n\n"); res.end(); } catch { /* already closed */ }
  }
});

export default router;
