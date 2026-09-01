// Run: LOCAL_MODE=true npx tsx server/routes/agentTimeline.volume.test.ts
// Levels every clip to -16 LUFS. Export applies gains above 1; the player clamps.
import assert from "node:assert/strict";
import { normalizeVolumes, gainFor } from "./agentTimeline.js";

const close = (a: number | undefined, b: number) => Math.abs((a ?? NaN) - b) < 0.001;

const v = normalizeVolumes(new Map([["a", -10], ["b", -16], ["c", -22]]));
assert.ok(close(v.get("b"), 1), "on-target clip stays at 1");
assert.ok(close(v.get("a"), 10 ** (-6 / 20)), "6 dB hot clip attenuates ~0.5");
assert.ok(close(v.get("c"), 10 ** (6 / 20)), "6 dB quiet clip boosts ~2");
// The real case: -11.6 and -34.6 from one bridged pair land within 0.1 dB of each other.
const g = normalizeVolumes(new Map([["loud", -11.6], ["quiet", -34.6]]));
assert.ok(close(20 * Math.log10(g.get("loud")!) - 11.6, 20 * Math.log10(g.get("quiet")!) - 34.6));
// Clamps: ±20 dB.
assert.equal(gainFor(-60), 10); assert.equal(gainFor(10), 0.1);
assert.equal(gainFor(null), 1, "unmeasured clip is left alone");
assert.equal(normalizeVolumes(new Map()).size, 0);
console.log("volume normalization checks passed");
