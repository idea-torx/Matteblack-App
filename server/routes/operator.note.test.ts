// Run: npx tsx server/routes/operator.note.test.ts
// An interrupted turn drops tool results from the operator's transcript; this
// note is the ground truth that outranks it. Fails if the note goes silent.
import assert from "node:assert/strict";
import { formatGenerationsNote } from "./operator.js";

const now = Date.parse("2026-08-31T12:00:00Z");
assert.equal(formatGenerationsNote([], now), "", "no jobs, no note");

const note = formatGenerationsNote(
  [
    { type: "video_gen", model: "h3-max-t2v", status: "completed", result_url: "/uploads/a.mp4", prompt: "BEAT 1 of 2: a\nthing", created_at: "2026-08-31T11:57:00Z" },
    { type: "video_gen", model: null, status: "processing", result_url: null, prompt: null, created_at: new Date(now) },
  ],
  now,
);
assert.match(note, /ground truth/);
assert.match(note, /3m ago — video_gen \(h3-max-t2v\) completed → \/uploads\/a\.mp4 — "BEAT 1 of 2: a thing"/);
assert.match(note, /0m ago — video_gen \(\?\) processing/);
console.log("generations note checks passed");
