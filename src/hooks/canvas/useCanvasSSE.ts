import { useEffect, useRef, useCallback } from "react";

const SSE_DEBOUNCE_MS = 500;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

/**
 * Generic listener for any message that arrives on the canvas SSE stream.
 * Used by feature modules (e.g. presence) that want to react to event types
 * other than `canvas:updated` without opening a second EventSource. Listeners
 * receive the canvas id the connection is bound to plus the parsed payload.
 */
export type CanvasSseListener = (canvasId: string, data: unknown) => void;

const sseListeners = new Set<CanvasSseListener>();

export function addCanvasSseListener(listener: CanvasSseListener): () => void {
  sseListeners.add(listener);
  return () => {
    sseListeners.delete(listener);
  };
}

function dispatchSseEvent(canvasId: string, data: unknown): void {
  for (const listener of sseListeners) {
    try {
      listener(canvasId, data);
    } catch (err) {
      console.warn("[useCanvasSSE] listener threw:", err);
    }
  }
}

export function useCanvasSSE(
  canvasId: string | null,
  sessionId: string,
  onRemoteUpdate: () => void
) {
  const eventSourceRef = useRef<EventSource | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canvasIdRef = useRef(canvasId);
  canvasIdRef.current = canvasId;
  // Chromium reports the window hidden when it's occluded (the user is in
  // another app while the agent generates), and we close the stream when that
  // happens — so every update sent while it was shut is simply never seen.
  // Any re-open therefore has to resync, not just resume listening.
  const hasOpenedRef = useRef(false);

  const onRemoteUpdateRef = useRef(onRemoteUpdate);
  onRemoteUpdateRef.current = onRemoteUpdate;

  const closeStream = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  const cleanup = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    closeStream();
  }, [closeStream]);

  const connect = useCallback(
    (cId: string) => {
      closeStream();

      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }

      const url = `/api/canvas/${cId}/events?sessionId=${encodeURIComponent(sessionId)}`;
      const es = new EventSource(url, { withCredentials: true });
      eventSourceRef.current = es;

      const openedRef = { current: false };
      es.onopen = () => {
        openedRef.current = true;
        reconnectAttemptRef.current = 0;
        if (hasOpenedRef.current) onRemoteUpdateRef.current();
        hasOpenedRef.current = true;
      };

      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data && typeof data === "object") {
            dispatchSseEvent(cId, data);
          }
          if (data.type === "canvas:updated" && data.canvasId === canvasIdRef.current) {
            if (debounceTimerRef.current) {
              clearTimeout(debounceTimerRef.current);
            }
            debounceTimerRef.current = setTimeout(() => {
              debounceTimerRef.current = null;
              onRemoteUpdateRef.current();
            }, SSE_DEBOUNCE_MS);
          }
        } catch {}
      };

      es.onerror = () => {
        const failedBeforeOpen = !openedRef.current;
        es.close();
        eventSourceRef.current = null;

        if (canvasIdRef.current !== cId) return;

        // If the SSE connection failed before opening, probe via fetch so we can
        // detect viewer-cap (HTTP 429) and surface a friendly UI message.
        if (failedBeforeOpen) {
          fetch(`/api/canvas/${cId}/events?sessionId=${encodeURIComponent(sessionId)}&probe=1`, {
            method: "GET",
            credentials: "include",
            headers: { Accept: "text/event-stream" },
          }).then((r) => {
            if (r.status === 429) {
              try { window.dispatchEvent(new CustomEvent("canvas-viewer-cap", { detail: { canvasId: cId } })); } catch {}
            }
            try { r.body?.cancel(); } catch {}
          }).catch(() => {});
        }

        if (typeof document !== "undefined" && document.visibilityState === "hidden") {
          return;
        }

        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }

        const attempt = reconnectAttemptRef.current++;
        const delay = Math.min(
          RECONNECT_BASE_MS * Math.pow(2, attempt) + Math.random() * 500,
          RECONNECT_MAX_MS
        );
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          if (canvasIdRef.current === cId) {
            connect(cId);
          }
        }, delay);
      };
    },
    [sessionId, closeStream]
  );

  useEffect(() => {
    if (!canvasId) {
      cleanup();
      return;
    }
    connect(canvasId);

    if (typeof document === "undefined") {
      return cleanup;
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        closeStream();
      } else if (canvasIdRef.current === canvasId && !eventSourceRef.current) {
        reconnectAttemptRef.current = 0;
        connect(canvasId);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      cleanup();
    };
  }, [canvasId, connect, cleanup, closeStream]);
}
