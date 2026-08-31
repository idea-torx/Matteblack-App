// Run: npx tsx server/skills/label.test.ts
import assert from "node:assert";
import { classify } from "./skillStore.js";

// The rules are ordered, so these check the collisions that ordering exists to
// settle — an ad recipe that mentions its voice-over is still Video.
assert.equal(classify("Build a 15s animated ad with voice-over and music"), "Video");
assert.equal(classify("Write a full storyboard, then shoot it scene by scene"), "Video");
assert.equal(classify("Poster stills at 4k, seedream, aspect ratio 3:2"), "Image");
assert.equal(classify("An editing pass for removing AI-writing habits, tone intact"), "Writing");
assert.equal(classify("Notes on how the studio thinks about its work"), "Creative");
console.log("skill label checks passed");
