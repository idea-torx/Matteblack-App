/**
 * Self-check for the clip the viewer preloads.
 * Run: `npx tsx src/features/cinema-frame/helpers/timelineState.test.ts`
 *
 * Get this wrong and the standby <video> holds the wrong clip, the boundary
 * falls back to load-and-seek, and the one-frame gap between clips is back.
 */
import assert from "node:assert/strict";
import { getActiveClipAtTime, getNextVideoClipAfterTime, type TimelineState } from "./timelineState.js";

const clip = (id: string, startOffset: number, duration: number) =>
  ({ id, startOffset, duration, trimStart: 0, trimEnd: 0, src: `${id}.mp4`, type: "video", volume: 1 }) as never;

const state = {
  tracks: [
    { id: "v", type: "video", clips: [clip("a", 0, 4), clip("b", 4, 4), clip("c", 8, 4)] },
    { id: "a", type: "audio", clips: [clip("music", 0, 12)] },
  ],
} as unknown as TimelineState;

const videoTrack = (state.tracks as { id: string }[]).find((t) => t.id === "v") as never;

// Mid-clip: the next one is the one that follows, not the one playing.
assert.equal(getNextVideoClipAfterTime(state, 2)?.id, "b");
// Exactly on a boundary: `b` is active, so `c` is what to preload.
assert.equal(getActiveClipAtTime(videoTrack, 4)?.id, "b");
assert.equal(getNextVideoClipAfterTime(state, 4)?.id, "c");
// Last clip has nothing after it.
assert.equal(getNextVideoClipAfterTime(state, 9), null);
// Audio clips are never preload candidates.
assert.equal(getNextVideoClipAfterTime({ tracks: [state.tracks[1]] } as TimelineState, 0), null);

console.log("timelineState: all checks passed");
