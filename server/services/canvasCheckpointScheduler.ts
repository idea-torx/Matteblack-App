type FlushFn = () => Promise<void>;

const FLUSH_DEBOUNCE_MS = 5_000;
const FLUSH_MAX_DELAY_MS = 30_000;

let flushFn: FlushFn | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let firstDirtyAt: number | null = null;
let inflightFlush: Promise<void> | null = null;
let dirtyDuringFlush = false;

export function registerCheckpointFlush(fn: FlushFn): void {
  flushFn = fn;
}

function clearPendingTimer(): void {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
}

async function runFlush(): Promise<void> {
  if (!flushFn) return;
  if (inflightFlush) {
    dirtyDuringFlush = true;
    return inflightFlush;
  }
  clearPendingTimer();
  firstDirtyAt = null;
  inflightFlush = (async () => {
    try {
      await flushFn!();
    } catch (err) {
      console.error("[canvas-checkpoint] Flush failed:", err);
    } finally {
      inflightFlush = null;
      if (dirtyDuringFlush) {
        dirtyDuringFlush = false;
        scheduleCanvasFlush();
      }
    }
  })();
  return inflightFlush;
}

export function scheduleCanvasFlush(): void {
  if (!flushFn) return;
  if (inflightFlush) {
    dirtyDuringFlush = true;
    return;
  }
  const now = Date.now();
  if (firstDirtyAt === null) firstDirtyAt = now;

  const elapsed = now - firstDirtyAt;
  const remainingMax = Math.max(0, FLUSH_MAX_DELAY_MS - elapsed);
  const delay = Math.min(FLUSH_DEBOUNCE_MS, remainingMax);

  clearPendingTimer();
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    runFlush().catch((err) => {
      console.error("[canvas-checkpoint] Scheduled flush error:", err);
    });
  }, delay);
  // Don't keep the event loop alive solely for a pending flush — the flush
  // is opportunistic, and a final flush also runs on SIGTERM.
  if (typeof pendingTimer.unref === "function") pendingTimer.unref();
}

export async function flushCanvasNow(): Promise<void> {
  clearPendingTimer();
  await runFlush();
  if (inflightFlush) await inflightFlush;
}
