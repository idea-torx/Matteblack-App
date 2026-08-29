import { useEffect, useRef } from "react";
import { usePresenceStore } from "./presenceStore";
import type { CursorPostBody } from "./types";

const SEND_INTERVAL_MS = 60; // ~16 Hz
const MAX_CONSECUTIVE_FAILURES = 5;
const FAILURE_BACKOFF_MS = 5000;

interface CursorBroadcastOptions {
  canvasId: string | null;
  viewportRef: React.RefObject<HTMLElement | null>;
  /** Live screen → world transform, captured by ref so we always read the
   *  current pan/zoom without re-binding listeners every frame. */
  screenToCanvas: (clientX: number, clientY: number) => { x: number; y: number };
  /** Current viewport (panX, panY, zoom) so we can echo it to the server. */
  panX: number;
  panY: number;
  zoom: number;
  /** Disabled when the user is not allowed to broadcast (e.g. cinema mode,
   *  no presence binding, page hidden). */
  enabled: boolean;
}

/**
 * Owns the throttled mousemove handler that pushes the local user's cursor
 * to the backend. Pauses while the tab is hidden, resumes on focus, and
 * tolerates POST failures with a simple consecutive-failure backoff.
 *
 * Render-free: returns nothing. Mount once at the canvas level.
 */
export function useCursorBroadcast(opts: CursorBroadcastOptions): void {
  const { canvasId, viewportRef, screenToCanvas, panX, panY, zoom, enabled } = opts;

  // Live refs so the rAF/throttle loop always sees fresh values without
  // forcing the effect to tear down on every pan/zoom change.
  const screenToCanvasRef = useRef(screenToCanvas);
  screenToCanvasRef.current = screenToCanvas;
  const panRef = useRef({ x: panX, y: panY, zoom });
  panRef.current = { x: panX, y: panY, zoom };
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const canvasIdRef = useRef(canvasId);
  canvasIdRef.current = canvasId;

  useEffect(() => {
    if (!canvasId || !enabled) return;
    const el = viewportRef.current;
    if (!el) return;

    let lastSentAt = 0;
    let pendingClient: { x: number; y: number } | null = null;
    let inFlight = false;
    let consecutiveFailures = 0;
    let pausedUntil = 0;
    let visible = typeof document === "undefined" || document.visibilityState !== "hidden";
    let throttleTimer: ReturnType<typeof setTimeout> | null = null;

    const trySend = async () => {
      if (!enabledRef.current) return;
      if (inFlight) return;
      if (!visible) return;
      if (!pendingClient) return;
      const now = Date.now();
      if (now < pausedUntil) return;
      if (now - lastSentAt < SEND_INTERVAL_MS) {
        if (!throttleTimer) {
          throttleTimer = setTimeout(() => {
            throttleTimer = null;
            trySend();
          }, SEND_INTERVAL_MS - (now - lastSentAt));
        }
        return;
      }

      const cId = canvasIdRef.current;
      const { selfSessionId: sessionId, bindingToken } = usePresenceStore.getState();
      if (!cId || !sessionId || !bindingToken) return;

      const client = pendingClient;
      pendingClient = null;
      lastSentAt = now;
      inFlight = true;

      const world = screenToCanvasRef.current(client.x, client.y);
      const pan = panRef.current;
      const body: CursorPostBody = {
        sessionId,
        bindingToken,
        x: world.x,
        y: world.y,
        viewport: { x: pan.x, y: pan.y, zoom: pan.zoom },
      };

      try {
        const resp = await fetch(`/api/canvas/${cId}/cursor`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (resp.ok) {
          consecutiveFailures = 0;
        } else if (resp.status === 429) {
          // Rate-limited — slow down briefly but don't count as a hard failure.
          pausedUntil = Date.now() + 500;
        } else {
          consecutiveFailures++;
        }
      } catch {
        consecutiveFailures++;
      } finally {
        inFlight = false;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          pausedUntil = Date.now() + FAILURE_BACKOFF_MS;
          consecutiveFailures = 0;
        }
        if (pendingClient) {
          if (throttleTimer) {
            clearTimeout(throttleTimer);
            throttleTimer = null;
          }
          throttleTimer = setTimeout(() => {
            throttleTimer = null;
            trySend();
          }, SEND_INTERVAL_MS);
        }
      }
    };

    const handleMove = (e: PointerEvent) => {
      if (e.pointerType && e.pointerType !== "mouse" && e.pointerType !== "pen") return;
      pendingClient = { x: e.clientX, y: e.clientY };
      trySend();
    };

    const handleVisibility = () => {
      const nowVisible = document.visibilityState !== "hidden";
      visible = nowVisible;
      if (nowVisible) {
        pausedUntil = 0;
        consecutiveFailures = 0;
      } else {
        pendingClient = null;
        if (throttleTimer) {
          clearTimeout(throttleTimer);
          throttleTimer = null;
        }
      }
    };

    el.addEventListener("pointermove", handleMove);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      el.removeEventListener("pointermove", handleMove);
      document.removeEventListener("visibilitychange", handleVisibility);
      if (throttleTimer) clearTimeout(throttleTimer);
    };
  }, [canvasId, viewportRef, enabled]);
}
