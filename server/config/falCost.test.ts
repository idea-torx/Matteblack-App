/**
 * Self-check for the at-cost pricing table.
 * Run: `LOCAL_MODE=true npx tsx server/config/falCost.test.ts`
 *
 * The check that earns its keep is the first one: every video model the
 * dispatcher can actually reach must have a cost rule. An unpriced model does
 * not fail loudly — `estimateFalCost` returns null and the estimate silently
 * omits it, which is exactly how h3-max's i2v/r2v shipped unpriced. Adding a
 * model to MODEL_MAP without a rule now fails here instead of on a bill.
 */
import assert from "node:assert/strict";
import { listAvailableModels } from "../fal.js";
import { estimateFalCost } from "./falCost.js";

const unpriced = listAvailableModels()
  .filter((m) => m.type === "video" && !estimateFalCost(m.key))
  .map((m) => m.key);
assert.deepEqual(unpriced, [], `video models with no cost rule: ${unpriced.join(", ")}`);

// H3 Max: same per-second rate across all three modes, 480P cheaper than 768P.
for (const key of ["h3-max-t2v", "h3-max-i2v", "h3-max-r2v"]) {
  assert.equal(estimateFalCost(key, { duration: 10 })?.usd, 0.8, `${key} 768p`);
  assert.equal(estimateFalCost(key, { duration: 10, resolution: "480p" })?.usd, 0.5, `${key} 480p`);
}

// H3, like Kling O3 Pro, IGNORES the live headline unit price: fal reports one
// number per endpoint and H3 bills on a 480P/768P matrix, so the headline is
// only one cell of it. Pinning that here so nobody "fixes" the refresh into
// silently quoting the 768P rate for a 480P clip.
assert.equal(estimateFalCost("h3-max-i2v", { duration: 10 }, 0.2)?.usd, 0.8);
assert.equal(estimateFalCost("kling-o3-pro-t2v", { duration: 10 }, 0.99)?.usd, 1.12);
// Models with a single flat rate DO take the live price — the refresh is not decorative.
assert.equal(estimateFalCost("kling-o3-4k-t2v", { duration: 10 }, 0.5)?.usd, 5);

// Unknown keys stay null rather than pricing at zero.
assert.equal(estimateFalCost("h3-max-nonexistent", { duration: 10 }), null);

console.log("falCost: all checks passed");
