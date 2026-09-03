/**
 * Matte operator routes (Phase K) — the in-app agent console backed by the user's
 * Claude Code subscription (see server/operator/claudeOperator.ts).
 *
 *   GET  /api/operator/status   — is the operator configured (token + binary)?
 *   POST /api/operator/message  — SSE stream of one operator turn.
 */
import { Router } from "express";
import { requireAuth, type AuthRequest } from "../sessions.js";
import { refreshOpencodeModels } from "../operator/runners/opencode.js";
import { runOperator, operatorStatus, operatorAuth, operatorLogin, OperatorNotConfiguredError, EFFORT_LEVELS, REVIEW_MCP_TOOLS, RUNNERS, type OperatorEvent, type EffortLevel, type RunnerId } from "../operator/claudeOperator.js";
import { setUserConfig, setOperatorModels } from "../config/userConfig.js";
import { setOperatorContext, takeOperatorJobs, noteOperatorInterrupted, takeOperatorInterrupted } from "../services/operatorCanvasContext.js";
import { memoryDir } from "../skills/agentMemory.js";
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

// ---------------------------------------------------------------------------
// After-turn review — the self-improvement pass
// ---------------------------------------------------------------------------

const REVIEW_PROMPT = [
  "Review this conversation and update two things.",
  "MEMORY: who the user is — persona, preferences, expectations about how you should work — with `remember`.",
  "SKILLS: how to do this class of task. Be active; most sessions produce at least one skill update, and a pass that does nothing is a missed learning opportunity.",
  "Signals: the user corrected your style, format, workflow, or approach (frustration is a first-class skill signal); a non-trivial technique or fix emerged; a skill you followed turned out wrong or outdated.",
  "Routing: a correction about how you behave (asking first, verbosity, spend, what to confirm) goes to `operator-system`, which is read every turn; a correction about how a kind of piece is made goes to the skill for that piece.",
  "Preference order: patch the skill that was in play with `patch_skill`; else patch an existing broader skill; else `save_skill` a new class-level skill named for the kind of work, never for today's job.",
  "Memory is small and for the USER only (persona, preferences, `usual-settings`), one or two sentences per note. Any lesson about how a kind of piece is made goes into a skill with `patch_skill`, never into memory; if such a lesson already sits in a memory note, move it into the skill and `forget` the note; merge overlapping notes under one slug rather than adding a near-duplicate.",
  "Settings the user keeps repeating (model, resolution, aspect, duration) are their usual: keep the memory note `usual-settings` current with `remember` so 'my usual' resolves next time.",
  "Do not capture setup or environment failures, claims that a tool is broken, transient errors that resolved, unresolved attempts as if they were a workflow, or one-off narratives.",
  "Never touch a pinned skill or one the user edited by hand.",
  "Do not generate media, do not address the user, produce no prose beyond tool calls; if nothing stands out say 'Nothing to save.'",
].join(" ");

/** At most one review in flight per session. The user taking another turn on the
 *  same session cancels it — a live turn owns the transcript, and a review
 *  writing skills underneath it is exactly the race Hermes cancels for. */
const reviews = new Map<string, { ac: AbortController; done: Promise<void> }>();
// Abort whatever is running on this thread (review or turn) and wait for its process to exit: codex holds a
// per-thread writer lock, so a resume spawned too early fails with
// "thread-store conflict". ponytail: 5s cap, then spawn anyway.
async function stopReview(sessionId: string): Promise<void> {
  const r = reviews.get(sessionId);
  if (!r) return;
  r.ac.abort();
  await Promise.race([r.done, new Promise((res) => setTimeout(res, 5000))]);
}
const lastReviewAt = new Map<string, number>();
const REVIEW_MIN_GAP_MS = 10 * 60_000;

function startReview(sessionId: string, botId?: string): void {
  reviews.get(sessionId)?.ac.abort();
  const ac = new AbortController();
  // Fire and forget: never streamed to the client, never awaited, so `event:
  // end` has already gone out by the time this runs.
  const done = runOperator({
    message: REVIEW_PROMPT,
    sessionId,
    // ponytail: lowest effort — this is a bookkeeping pass. The cheap-model
    // choice is the runner's (claude picks haiku; codex stays on its default).
    effort: "low",
    review: true,
    botId,
    allowedTools: REVIEW_MCP_TOOLS,
    signal: ac.signal,
    onEvent: (e) => { if (e.type === "error") console.error("[operator] review:", e.message); },
  })
    .catch((err) => console.error("[operator] review failed:", err))
    .finally(() => { if (reviews.get(sessionId)?.ac === ac) reviews.delete(sessionId); });
  reviews.set(sessionId, { ac, done });
}

router.get("/api/operator/status", requireAuth, async (_req: AuthRequest, res) => {
  // First load after launch: give the `opencode models` probe a moment so the
  // panel's dropdown shows the real catalog instead of the seed list.
  await Promise.race([refreshOpencodeModels(), new Promise((r) => setTimeout(r, 3000))]);
  res.json(operatorStatus());
});

/** Switch which agent CLI drives the operator. Session ids are runner-specific,
 *  so a session started on the old runner is simply dropped on the next turn. */
router.post("/api/operator/runner", requireAuth, (req: AuthRequest, res) => {
  const runner = (req.body || {}).runner as unknown;
  if (!RUNNERS.some((r) => r.id === runner)) {
    res.status(400).json({ error: "unknown runner" });
    return;
  }
  setUserConfig({ operatorRunner: runner as RunnerId });
  res.json(operatorStatus());
});

/** Which of a runner's catalog the panel dropdown offers. Empty = all. */
router.post("/api/operator/models", requireAuth, (req: AuthRequest, res) => {
  const { runner, ids } = (req.body || {}) as { runner?: unknown; ids?: unknown };
  if (!RUNNERS.some((r) => r.id === runner) || !Array.isArray(ids)) { res.status(400).json({ error: "bad request" }); return; }
  setOperatorModels(runner as RunnerId, ids.filter((v): v is string => typeof v === "string").slice(0, 50));
  res.json(operatorStatus());
});

router.get("/api/operator/auth", requireAuth, async (_req: AuthRequest, res) => {
  res.json(await operatorAuth());
});

/** Opens the CLI's browser sign-in; responds once it finishes. No credential passes through this app. */
router.post("/api/operator/login", requireAuth, async (req: AuthRequest, res) => {
  const runner = (req.body || {}).runner as unknown;
  if (!RUNNERS.some((r) => r.id === runner)) { res.status(400).json({ error: "unknown runner" }); return; }
  res.json({ loggedIn: await operatorLogin(runner as RunnerId) });
});

// ---------------------------------------------------------------------------
// Bots — named, persistent collaborators. A bot is a row plus a memory
// directory; everything else (threads, budget spending) is the panel's or a
// later step's.
// ---------------------------------------------------------------------------

type BotRow = { id: string; name: string; budget_cents: number; icon: string | null; description: string | null; created_at: string };

/** Anything else makes Postgres throw on the uuid cast, which in an async
 *  handler is an unhandled rejection rather than a 404. */
const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);

const asBot = (r: BotRow) => ({
  id: r.id, name: r.name, budgetCents: r.budget_cents,
  icon: r.icon ?? "", description: r.description ?? "", createdAt: r.created_at,
});

/** One emoji, at most. Stored as-is and rendered as text, never as markup —
 *  but capped so a paste can't push a novel through the picker. */
const cleanIcon = (v: unknown) => (typeof v === "string" ? [...v.trim()].slice(0, 2).join("") : "");
const cleanDescription = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 600) : "");

const BOT_COLS = "id, name, budget_cents, icon, description, created_at";

router.get("/api/bots", requireAuth, async (req: AuthRequest, res) => {
  const { rows } = await pool.query(
    `SELECT ${BOT_COLS} FROM bots WHERE user_id = $1 ORDER BY created_at`,
    [req.userId],
  );
  res.json({ bots: (rows as BotRow[]).map(asBot) });
});

router.post("/api/bots", requireAuth, async (req: AuthRequest, res) => {
  const { name, budgetCents, icon, description } = (req.body || {}) as
    { name?: unknown; budgetCents?: unknown; icon?: unknown; description?: unknown };
  const clean = typeof name === "string" ? name.trim().slice(0, 80) : "";
  if (!clean) { res.status(400).json({ error: "name is required" }); return; }
  // Budget is no longer set at creation — a monthly cap picked before the bot
  // has done anything is a guess. Still accepted for callers that send one.
  const cents = Number.isFinite(budgetCents) ? Math.max(0, Math.round(budgetCents as number)) : 0;
  const { rows } = await pool.query(
    `INSERT INTO bots (user_id, name, budget_cents, icon, description) VALUES ($1, $2, $3, $4, $5) RETURNING ${BOT_COLS}`,
    [req.userId, clean, cents, cleanIcon(icon), cleanDescription(description)],
  );
  res.json({ bot: asBot(rows[0] as BotRow) });
});

/** Rename / re-icon / rewrite the brief. Only the fields present are touched,
 *  so the panel can save one field without shipping the whole bot back. */
router.patch("/api/bots/:id", requireAuth, async (req: AuthRequest, res) => {
  if (!isUuid(req.params.id)) { res.status(404).json({ error: "not found" }); return; }
  const body = (req.body || {}) as { name?: unknown; icon?: unknown; description?: unknown; budgetCents?: unknown };
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (typeof body.name === "string") {
    const clean = body.name.trim().slice(0, 80);
    if (!clean) { res.status(400).json({ error: "name is required" }); return; }
    sets.push(`name = $${sets.length + 1}`); vals.push(clean);
  }
  if (body.icon !== undefined) { sets.push(`icon = $${sets.length + 1}`); vals.push(cleanIcon(body.icon)); }
  if (body.description !== undefined) { sets.push(`description = $${sets.length + 1}`); vals.push(cleanDescription(body.description)); }
  if (Number.isFinite(body.budgetCents)) { sets.push(`budget_cents = $${sets.length + 1}`); vals.push(Math.max(0, Math.round(body.budgetCents as number))); }
  if (!sets.length) { res.status(400).json({ error: "nothing to update" }); return; }
  const { rows } = await pool.query(
    `UPDATE bots SET ${sets.join(", ")} WHERE id = $${vals.length + 1} AND user_id = $${vals.length + 2} RETURNING ${BOT_COLS}`,
    [...vals, req.params.id, req.userId],
  );
  if (!rows.length) { res.status(404).json({ error: "not found" }); return; }
  res.json({ bot: asBot(rows[0] as BotRow) });
});

router.delete("/api/bots/:id", requireAuth, async (req: AuthRequest, res) => {
  if (!isUuid(req.params.id)) { res.status(404).json({ error: "not found" }); return; }
  const { rowCount } = await pool.query("DELETE FROM bots WHERE id = $1 AND user_id = $2", [req.params.id, req.userId]);
  if (!rowCount) { res.status(404).json({ error: "not found" }); return; }
  // The row is the only thing pointing at this directory, so it goes with it.
  try { fs.rmSync(memoryDir(req.params.id), { recursive: true, force: true }); } catch { /* nothing to remove */ }
  res.json({ ok: true });
});

router.post("/api/operator/message", requireAuth, async (req: AuthRequest, res) => {
  const body = (req.body || {}) as {
    message?: unknown; sessionId?: unknown; model?: unknown; effort?: unknown; canvasId?: unknown; viewport?: unknown;
    referenceUrls?: unknown; referenceAspectRatio?: unknown; selectedNodeIds?: unknown; botId?: unknown;
  };
  let message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }
  // Run as a bot: its own durable memory instead of the shared session memory.
  // Validated against this user's own bots — the id reaches a filesystem path.
  let botId: string | undefined;
  let botPersona: { name: string; description: string; icon: string } | undefined;
  if (body.botId !== undefined && body.botId !== null && body.botId !== "") {
    if (!isUuid(body.botId)) { res.status(400).json({ error: "unknown bot" }); return; }
    const { rows } = await pool.query("SELECT id, name, description, icon FROM bots WHERE id = $1 AND user_id = $2", [body.botId, req.userId]);
    if (rows.length === 0) { res.status(400).json({ error: "unknown bot" }); return; }
    botId = rows[0].id as string;
    botPersona = { name: rows[0].name as string, description: (rows[0].description as string | null) ?? "", icon: (rows[0].icon as string | null) ?? "" };
  }
  const sessionId = typeof body.sessionId === "string" && body.sessionId ? body.sessionId : undefined;
  // The user has the floor again: stop any review still chewing on this session.
  if (sessionId) await stopReview(sessionId);
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
  if (req.userId) setOperatorContext(req.userId, { canvasId, viewport, referenceUrls, referenceAspectRatio, botName: botPersona?.name, botIcon: botPersona?.icon });

  // Ground truth about recent generations, injected every turn. The operator's
  // own history is lossy in exactly the moment it matters: interrupting a turn
  // kills the claude process mid-tool-call, so the generate_media that was in
  // flight leaves no tool_result in the transcript — the job still completes
  // and lands on the canvas, but on resume the agent truthfully "remembers"
  // generating nothing and denies it. Compaction loses the same records. The
  // jobs table doesn't forget, so it outranks the transcript.
  // Told-to-abort path: the previous turn was interrupted (Stop), its jobs
  // were cancelled, but the resumed transcript ends in dangling tool calls
  // that read as unfinished work. Without this note the agent helpfully picks
  // the task back up — the opposite of what Stop meant.
  if (req.userId && takeOperatorInterrupted(req.userId)) {
    message +=
      "\n\n[System note: your previous turn was interrupted by the user pressing Stop, and its queued generations were cancelled. Treat that task as aborted — do not resume, retry, or re-dispatch any of it unless THIS message explicitly asks you to continue.]";
  }

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
  // Pieces picked inside a rendered-HTML node. Text is the handle the agent
  // edits by (render_html `edits` find/replace), position disambiguates.
  const picked = Array.isArray(body.selectedElements)
    ? (body.selectedElements as unknown[]).filter((e): e is { nodeId: string; tag: string; text: string; bbox: number[] } =>
        !!e && typeof e === "object" && typeof (e as { nodeId?: unknown }).nodeId === "string" && typeof (e as { tag?: unknown }).tag === "string").slice(0, 8)
    : [];
  if (picked.length > 0 && selectionNote) {
    const lines = picked.map((e) => {
      const [x, y, w, h] = Array.isArray(e.bbox) ? e.bbox.map(Number) : [0, 0, 0, 0];
      const text = String(e.text || "").slice(0, 80);
      return `- <${e.tag.replace(/[^a-z0-9-]/gi, "")}>${text ? ` "${text}"` : ""} at ${x},${y} (${w}×${h}px) in node ${e.nodeId}`;
    });
    selectionNote = selectionNote.slice(0, -1) + `\nThe user picked ${picked.length === 1 ? "this element" : "these elements"} inside the render — "this", "that text", "this bit" means exactly ${picked.length === 1 ? "it" : "them"}, nothing else on the page:\n${lines.join("\n")}\nChange only what was picked: get_html, then render_html with the same nodeId and \`edits\` whose find strings are that element's exact markup or text.]`;
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
  let sawToolUse = false;
  req.on("close", () => {
    ac.abort();
    if (finished) return;
    if (req.userId) noteOperatorInterrupted(req.userId);
    const sweep = () => {
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
    };
    sweep();
    // Killing claude doesn't abort a /api/agent/tool call it already made —
    // that handler keeps running and can dispatch its job AFTER this close
    // fires, past the first sweep. One delayed sweep catches the straggler.
    // ponytail: single fixed re-sweep; poll a few times if jobs still slip through.
    setTimeout(sweep, 5000);
  });

  // ponytail: one count per turn; cheap on a jobs table with an index on user_id.
  const firstSession = (await pool.query("SELECT 1 FROM jobs WHERE user_id = $1 AND status = 'complete' LIMIT 1", [req.userId])).rows.length === 0;
  try {
    const run = runOperator({
      message,
      sessionId,
      model,
      effort,
      firstSession,
      botId,
      botPersona,
      signal: ac.signal,
      onEvent: (e) => { if (e.type === "tool_use") sawToolUse = true; send(e); },
    });
    // A foreground turn holds the thread too: a message sent mid-render must
    // stop it (same lock story as the review) instead of colliding with it.
    const entry = { ac, done: run.then(() => undefined, () => undefined) };
    if (sessionId) { reviews.set(sessionId, entry); entry.done.then(() => { if (reviews.get(sessionId) === entry) reviews.delete(sessionId); }); }
    const { sessionId: finalSession } = await run;
    // Redundant with the parsed 'done' event, but guarantees the client has the
    // resumable session id even if the result line was malformed.
    if (finalSession) send({ type: "session", sessionId: finalSession });
    // Self-improvement pass. Only ever started for a foreground turn (this
    // handler is the only caller and never sets `review`), so it can't recurse.
    // Skipped for chat-only turns (nothing was made, so nothing to learn) and
    // throttled per session: a review rewrites memory, which changes the system
    // prompt and cold-starts the prompt cache on the next turn.
    if (finalSession && !ac.signal.aborted && sawToolUse && Date.now() - (lastReviewAt.get(finalSession) ?? 0) > REVIEW_MIN_GAP_MS) {
      lastReviewAt.set(finalSession, Date.now());
      startReview(finalSession, botId);
    }
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
