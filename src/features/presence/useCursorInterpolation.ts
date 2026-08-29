import { useEffect, useRef, useState } from "react";
import type { RemoteSession } from "./presenceStore";

const INTERP_MS = 120;
const HIDE_AFTER_MS = 3000;

interface InterpolatedCursor {
  x: number;
  y: number;
  visible: boolean;
}

/**
 * Smooths the most-recent two cursor samples for a remote session. Returns
 * null until at least one sample has arrived, and reports `visible: false`
 * once 3s have elapsed since the last sample.
 *
 * Drives a single rAF loop while the cursor is in the smoothing window so
 * we don't keep re-rendering once the cursor has settled on its target.
 */
export function useCursorInterpolation(session: RemoteSession): InterpolatedCursor | null {
  const [tick, setTick] = useState(0);
  const rafRef = useRef<number | null>(null);

  // last/prev are read from the session prop on each render — keep a ref so
  // the rAF loop always sees the freshest target without rebinding.
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    if (!session.lastCursor) return;
    const tickFn = () => {
      const cur = sessionRef.current;
      const last = cur.lastCursor;
      if (!last) return;
      const elapsed = performance.now() - lastReceivedPerf(last.receivedAt);
      const stillInterpolating = elapsed < INTERP_MS;
      const stillVisible = Date.now() - last.receivedAt < HIDE_AFTER_MS;
      setTick((t) => t + 1);
      if (stillInterpolating || stillVisible) {
        rafRef.current = requestAnimationFrame(tickFn);
      } else {
        rafRef.current = null;
      }
    };
    if (rafRef.current == null) {
      rafRef.current = requestAnimationFrame(tickFn);
    }
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
    // tick is intentionally omitted; we drive the loop ourselves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.lastCursor?.receivedAt]);

  void tick;

  if (!session.lastCursor) return null;
  const last = session.lastCursor;
  const prev = session.prevCursor;
  const age = Date.now() - last.receivedAt;
  const visible = age < HIDE_AFTER_MS;

  if (!prev) {
    return { x: last.x, y: last.y, visible };
  }
  const t = Math.min(1, age / INTERP_MS);
  const x = prev.x + (last.x - prev.x) * t;
  const y = prev.y + (last.y - prev.y) * t;
  return { x, y, visible };
}

/**
 * The store records `Date.now()` when a sample arrives, but our rAF loop
 * needs an elapsed value relative to the same clock as `performance.now()`.
 * We store the offset once so subsequent comparisons are cheap.
 */
let perfClockOffset: number | null = null;
function lastReceivedPerf(receivedAtWallClock: number): number {
  if (perfClockOffset == null) {
    perfClockOffset = Date.now() - performance.now();
  }
  return receivedAtWallClock - perfClockOffset;
}
