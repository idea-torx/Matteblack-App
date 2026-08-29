import { Router, Request, Response } from "express";
import crypto from "crypto";
import { getProjectAccess, isSharingV1EnabledForUser } from "../services/projectAccess.js";
import {
  getBindingToken,
  getSession as getPresenceSession,
  setCursor,
} from "../services/presence/PresenceRegistry.js";
import {
  broadcastPresenceActive,
  broadcastPresenceCursor,
} from "../services/presence/presenceBroadcast.js";
import { tryConsume } from "../services/presence/cursorRateLimiter.js";
import { getPresenceTransport, touchSseSession } from "./canvas.js";
import type { CursorPostBody, PresenceViewport } from "../../shared/presence.js";

interface AuthRequest extends Request {
  userId?: string;
}

const router = Router();

function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function parseViewport(v: unknown): PresenceViewport | undefined {
  if (!v || typeof v !== "object") return undefined;
  const obj = v as Record<string, unknown>;
  if (!isFiniteNumber(obj.x) || !isFiniteNumber(obj.y) || !isFiniteNumber(obj.zoom)) {
    return undefined;
  }
  return { x: obj.x, y: obj.y, zoom: obj.zoom };
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

router.post("/api/canvas/:canvasId/cursor", async (req: AuthRequest, res: Response) => {
  try {
    const { canvasId } = req.params;
    const body = (req.body || {}) as Partial<CursorPostBody>;
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const bindingToken = typeof body.bindingToken === "string" ? body.bindingToken : "";
    const x = body.x;
    const y = body.y;
    const viewport = parseViewport(body.viewport);

    if (!sessionId || !bindingToken || !isFiniteNumber(x) || !isFiniteNumber(y)) {
      res.status(400).json({ error: "Invalid cursor payload" });
      return;
    }

    // Verify the requesting principal has access to this canvas. Guests
    // (req.userId === undefined) hit getProjectAccess, which returns
    // role: "none" today — when guest sharing is enabled the same access
    // layer will start returning a viewer role, no change required here.
    const access = await getProjectAccess(req.userId, canvasId);
    if (!access.exists) {
      res.status(404).json({ error: "Canvas not found" });
      return;
    }
    if (access.role === "none") {
      res.status(403).json({ error: "Not authorized" });
      return;
    }
    if (access.role === "viewer" && !(await isSharingV1EnabledForUser(req.userId))) {
      res.status(403).json({ error: "Not authorized" });
      return;
    }

    // Verify the sessionId belongs to the caller. Two layers:
    //   1. Strict equality of the principal — if the registered session was
    //      opened by an authenticated user, only that same user can publish
    //      cursors for it. A null-vs-defined mismatch is also rejected, so a
    //      logged-in user cannot drive a guest session and vice versa.
    //   2. The per-session bindingToken issued at SSE connect must match.
    //      This is what protects guest-vs-guest spoofing where principal
    //      equality alone (null === null) would otherwise be insufficient.
    const presenceUser = getPresenceSession(canvasId, sessionId);
    if (!presenceUser) {
      res.status(404).json({ error: "Session not connected to canvas" });
      return;
    }
    const callerUserId = req.userId ?? null;
    if (presenceUser.userId !== callerUserId) {
      res.status(403).json({ error: "Session does not belong to caller" });
      return;
    }
    const expectedToken = getBindingToken(canvasId, sessionId);
    if (!expectedToken || !timingSafeStringEqual(expectedToken, bindingToken)) {
      res.status(403).json({ error: "Session does not belong to caller" });
      return;
    }

    if (!tryConsume(sessionId)) {
      res.status(429).json({ error: "Cursor rate limit exceeded" });
      return;
    }

    // Mark the SSE connection as active so it isn't reaped by the idle timer.
    touchSseSession(sessionId);

    const result = setCursor(canvasId, sessionId, x, y, viewport);
    if (!result) {
      res.status(404).json({ error: "Session not connected to canvas" });
      return;
    }

    const transport = getPresenceTransport();
    if (result.wasIdle) {
      broadcastPresenceActive(transport, canvasId, sessionId);
    }
    broadcastPresenceCursor(transport, canvasId, {
      sessionId,
      userId: result.user.userId,
      x,
      y,
      viewport,
    });

    res.status(204).end();
  } catch (err) {
    console.error("[presence] cursor post error:", err);
    res.status(500).json({ error: "Failed to publish cursor" });
  }
});

export default router;
