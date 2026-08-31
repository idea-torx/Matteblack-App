import assert from "node:assert";
import { getModelConfig } from "./fal.js";

// 3-10s, 16:9 / 9:16 only, own resolution ladder — every other video model
// in the map disagrees on at least one of those.
const t2v = getModelConfig("gemini-omni-t2v")!;
assert.deepEqual(await t2v.buildInput({ prompt: "x" }),
  { prompt: "x", duration: 8, resolution: "720p", aspect_ratio: "16:9" });
assert.equal((await t2v.buildInput({ prompt: "x", duration: 30 })).duration, 10);
assert.equal((await t2v.buildInput({ prompt: "x", duration: 1 })).duration, 3);
assert.equal((await t2v.buildInput({ prompt: "x", aspect_ratio: "1:1" })).aspect_ratio, "16:9");
assert.equal((await t2v.buildInput({ prompt: "x", resolution: "480p" })).resolution, "720p");
assert.equal((await t2v.buildInput({ prompt: "x", resolution: "4k" })).resolution, "4k");

const i2v = getModelConfig("gemini-omni-i2v")!;
const built = await i2v.buildInput({ prompt: "x", firstFrameUrl: "https://e.com/a.png", lastFrameUrl: "https://e.com/b.png" });
assert.equal(built.image_url, "https://e.com/a.png");
assert.equal(built.end_image_url, "https://e.com/b.png");
console.log("gemini omni checks passed");
