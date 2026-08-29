import { useEffect } from "react";
import { addCanvasSseListener } from "../../hooks/canvas/useCanvasSSE";
import { usePresenceStore } from "./presenceStore";
import type { PresenceEvent } from "./types";

function isPresenceEvent(data: unknown): data is PresenceEvent {
  if (!data || typeof data !== "object") return false;
  const t = (data as { type?: unknown }).type;
  return (
    t === "presence:snapshot" ||
    t === "presence:join" ||
    t === "presence:leave" ||
    t === "presence:cursor" ||
    t === "presence:idle" ||
    t === "presence:active"
  );
}

/**
 * Subscribes to the canvas SSE stream and applies presence:* events into
 * the presence store. Mounted once at the canvas level. When the bound
 * canvas changes, the store is reset so a fresh snapshot starts cleanly.
 */
export function usePresenceChannel(canvasId: string | null): void {
  const reset = usePresenceStore((s) => s.reset);
  const applySnapshot = usePresenceStore((s) => s.applySnapshot);
  const applyJoin = usePresenceStore((s) => s.applyJoin);
  const applyLeave = usePresenceStore((s) => s.applyLeave);
  const applyCursor = usePresenceStore((s) => s.applyCursor);
  const applyIdle = usePresenceStore((s) => s.applyIdle);

  useEffect(() => {
    reset(canvasId);
    if (!canvasId) return;

    const off = addCanvasSseListener((connectionCanvasId, data) => {
      if (connectionCanvasId !== canvasId) return;
      if (!isPresenceEvent(data)) return;
      if (data.canvasId !== canvasId) return;

      switch (data.type) {
        case "presence:snapshot":
          applySnapshot(data.canvasId, data.me, data.users);
          break;
        case "presence:join":
          applyJoin(data.canvasId, data.user);
          break;
        case "presence:leave":
          applyLeave(data.canvasId, data.sessionId);
          break;
        case "presence:cursor":
          applyCursor(data.canvasId, data.sessionId, data.x, data.y, Date.now());
          break;
        case "presence:idle":
          applyIdle(data.canvasId, data.sessionId, true);
          break;
        case "presence:active":
          applyIdle(data.canvasId, data.sessionId, false);
          break;
      }
    });

    return () => {
      off();
      reset(null);
    };
  }, [canvasId, reset, applySnapshot, applyJoin, applyLeave, applyCursor, applyIdle]);
}
