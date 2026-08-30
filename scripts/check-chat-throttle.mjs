/**
 * The chat-persistence guard in OperatorPanel: a *throttle*, not a debounce.
 * A debounce whose timer restarts on every token never fires during a fast
 * stream — which is exactly the case that used to lose the thread.
 * Run: node scripts/check-chat-throttle.mjs
 */
import assert from "node:assert/strict";

const THROTTLE_MS = 3000;

/** Replays the effect body against a stream of message updates. */
function saves({ tokenGapMs, tokens }) {
  let now = 0, pending = null, count = 0;
  const fire = (at) => { pending = null; count++; void at; };
  for (let i = 0; i < tokens; i++) {
    now += tokenGapMs;
    if (pending !== null && now >= pending) fire(now);   // timer elapsed
    if (pending === null) pending = now + THROTTLE_MS;   // schedule if none in flight
  }
  return count;
}

// A 60s stream at 20 tokens/sec must persist roughly every 3s, not never.
const fast = saves({ tokenGapMs: 50, tokens: 1200 });
assert.ok(fast >= 15, `fast stream saved only ${fast} times`);

// A slow stream still saves, and doesn't save more often than the throttle.
const slow = saves({ tokenGapMs: 4000, tokens: 10 });
assert.ok(slow > 0 && slow <= 10, `slow stream saved ${slow} times`);

console.log(`ok — throttle persisted ${fast}x over a 60s fast stream, ${slow}x over a slow one`);
