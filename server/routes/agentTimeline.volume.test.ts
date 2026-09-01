// Run: LOCAL_MODE=true npx tsx server/routes/agentTimeline.volume.test.ts
// Levels an agent cut to its quietest clip, attenuate-only. Fails if a gain
// ever exceeds 1 (player can't boost) or falls under the sanity floor.
import assert from "node:assert/strict";
import { normalizeVolumes } from "./agentTimeline.js";

const close = (a: number | undefined, b: number) => Math.abs((a ?? NaN) - b) < 0.001;

// -20 is the quietest → target; -14 is 6 dB hotter → ~0.5 gain.
const v = normalizeVolumes(new Map([["a", -14], ["b", -20], ["c", -20]]));
assert.ok(close(v.get("b"), 1), "quietest clip stays at 1");
assert.ok(close(v.get("c"), 1), "equal-loudness clip stays at 1");
assert.ok(close(v.get("a"), 10 ** (-6 / 20)), "6 dB hotter clip attenuates ~0.5");

// A freakishly loud outlier clamps at the floor instead of vanishing.
assert.ok(close(normalizeVolumes(new Map([["a", -2], ["b", -40]])).get("a"), 0.2));
// Fewer than 2 measured clips: nothing to level against.
assert.equal(normalizeVolumes(new Map([["a", -16]])).size, 0);
assert.equal(normalizeVolumes(new Map()).size, 0);
console.log("volume normalization checks passed");
