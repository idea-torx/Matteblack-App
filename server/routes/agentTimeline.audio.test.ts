// Run: LOCAL_MODE=true npx tsx server/routes/agentTimeline.audio.test.ts
// A cut's audio beds: several tracks playing at once, each with its own start
// and level. Fails if a bad track index, src or volume ever reaches the insert.
import assert from "node:assert/strict";
import { normalizeBeds } from "./agentTimeline.js";

// The shape the agent actually sends: bed on track 0, VO cut to picture on 1.
const beds = normalizeBeds({
  audio: [
    { src: "https://x/bed.mp3", volume: 0.25 },
    { src: "https://x/vo1.mp3", track: 1, startSeconds: 2.5, volume: 1, label: "VO — line 1" },
    { src: "/uploads/vo2.mp3", track: 1, startSeconds: 9 },
  ],
});
assert.equal(beds.length, 3);
assert.deepEqual(beds.map((b) => b.track), [0, 1, 1]);
assert.deepEqual(beds.map((b) => b.startSeconds), [0, 2.5, 9]);
assert.equal(beds[2].label, "Audio 3", "unlabelled beds still get a name");
assert.equal(Math.max(1, ...beds.map((b) => b.track + 1)), 2, "two tracks needed");

// Junk never reaches the DB: bad srcs dropped, out-of-range track/volume clamped.
const junk = normalizeBeds({
  audio: [
    { src: "ftp://nope/x.mp3" },
    { src: 42 },
    { src: "https://x/a.mp3", track: 99, volume: 8, startSeconds: -5 },
  ],
});
assert.equal(junk.length, 1);
assert.equal(junk[0].track, 7, "track clamps to the last audio track");
assert.equal(junk[0].volume, 1);
assert.equal(junk[0].startSeconds, 0);

// `music` is the one-bed shorthand — and yields to `audio` when both are sent.
const shorthand = normalizeBeds({ music: { src: "https://x/bed.mp3", volume: 0.8 } });
assert.deepEqual(
  [shorthand.length, shorthand[0].track, shorthand[0].label],
  [1, 0, "Music"],
);
assert.equal(
  normalizeBeds({ audio: [{ src: "https://x/a.mp3" }], music: { src: "https://x/bed.mp3" } })[0].src,
  "https://x/a.mp3",
);
// An empty list is not the same as no key: the caller uses it to clear the audio.
assert.equal(normalizeBeds({ audio: [] }).length, 0);
assert.equal(normalizeBeds({}).length, 0);
console.log("audio bed checks passed");
