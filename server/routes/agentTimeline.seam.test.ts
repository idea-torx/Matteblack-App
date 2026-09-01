// Run: LOCAL_MODE=true npx tsx server/routes/agentTimeline.seam.test.ts
//
// A seam='frame' continuation starts on the exact frame its source ended on, so
// laid side by side that frame plays twice. These are the cases the trim rule
// exists to separate: trim only the frame-seam that follows its own source.
import assert from "node:assert/strict";
import { seamTrimFor, SEAM_TRIM_SECONDS } from "./agentTimeline.js";

const srcs = ["/uploads/a.mp4", "/uploads/b.mp4", "/uploads/c.mp4"];
const cont = new Map([
  ["/uploads/b.mp4", { from: "/uploads/a.mp4", seam: "frame" }],     // b continues a, hard seam
  ["/uploads/c.mp4", { from: "/uploads/b.mp4", seam: "reference" }], // c continues b, soft seam
]);

assert.equal(seamTrimFor(0, srcs, cont), 0, "first clip never trims");
assert.equal(seamTrimFor(1, srcs, cont), SEAM_TRIM_SECONDS, "frame-seam after its source trims");
assert.equal(seamTrimFor(2, srcs, cont), 0, "reference seam has no duplicated frame");
// b placed after c (reordered cut): no longer follows its source, no trim.
assert.equal(seamTrimFor(2, ["/uploads/a.mp4", "/uploads/c.mp4", "/uploads/b.mp4"], cont), 0);
// A plain generation (no job continuation record) never trims.
assert.equal(seamTrimFor(1, ["/uploads/x.mp4", "/uploads/y.mp4"], cont), 0);
console.log("seam trim checks passed");
