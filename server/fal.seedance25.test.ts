import assert from "node:assert";
import { getModelConfig } from "./fal.js";

// 2.5 goes to 30s and takes "auto"; the 2.0 helper would clamp it to 15.
const t2v = getModelConfig("seedance-2.5-t2v")!;
assert.equal((await t2v.buildInput({ prompt: "x", duration: 30 })).duration, "30");
assert.equal((await t2v.buildInput({ prompt: "x", duration: 99 })).duration, "30");
assert.equal((await t2v.buildInput({ prompt: "x" })).duration, "auto");

// 2.5 takes LISTS where 2.0 took single urls, and 30 images where 2.0 took 3.
const r2v = getModelConfig("seedance-2.5-r2v")!;
const built = await r2v.buildInput({
  prompt: "x",
  referenceImageUrls: Array.from({ length: 40 }, (_, i) => `https://e.com/${i}.png`),
  video_url: "https://e.com/a.mp4",
});
assert.equal((built.image_urls as string[]).length, 30);
assert.deepEqual(built.video_urls, ["https://e.com/a.mp4"]);
console.log("seedance 2.5 checks passed");
