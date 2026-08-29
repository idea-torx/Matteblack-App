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
import { setOperatorContext } from "../services/operatorCanvasContext.js";
import type { Viewport } from "../utils/canvasPlacement.js";

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

router.get("/api/operator/status", requireAuth, (_req: AuthRequest, res) => {
  res.json(operatorStatus());
});

router.post("/api/operator/message", requireAuth, async (req: AuthRequest, res) => {
  const body = (req.body || {}) as {
    message?: unknown; sessionId?: unknown; model?: unknown; effort?: unknown; canvasId?: unknown; viewport?: unknown;
    referenceUrls?: unknown; referenceAspectRatio?: unknown;
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

  // Tell Claude an image is attached AND that it's supplied to the tools
  // automatically — otherwise Claude assumes it can only reference images that
  // are already on the canvas (it has no URL of its own to pass) and asks the
  // user to add it. The actual URLs are injected server-side at /api/agent/tool.
  if (referenceUrls.length > 0) {
    const n = referenceUrls.length;
    const it = n > 1 ? "them" : "it";
    const img = n > 1 ? "images" : "image";
    let note = `\n\n[System note: the user attached ${n} reference ${img} for this request. ${n > 1 ? "They are" : "It is"} automatically provided to the generation tools as the reference — you do NOT need a URL and ${it} does NOT need to be on the canvas. To edit, restyle, recolor, or build on the attached ${img}, call generate_media now (the attached ${img} ${n > 1 ? "are" : "is"} passed as ${it}s reference). Use transform_media only for background removal, upscaling, or resizing. Do NOT ask the user to add ${it} to the canvas.`;
    if (referenceAspectRatio) {
      note += ` The attached ${img} ${n > 1 ? "are" : "is"} ${referenceAspectRatio} — use aspectRatio "${referenceAspectRatio}" to keep the lineage consistent, unless the user asked for a different shape.`;
    }
    note += `]`;
    message += note;
  }

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
  const ac = new AbortController();
  req.on("close", () => ac.abort());

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
    try { res.write("event: end\ndata: {}\n\n"); res.end(); } catch { /* already closed */ }
  }
});

export default router;
