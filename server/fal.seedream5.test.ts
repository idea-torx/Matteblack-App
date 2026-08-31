import assert from "node:assert";
import { seedream5Size } from "./fal.js";

// v5 rejects under 2560x1440 total pixels and over 4096 a side.
const MIN = 2560 * 1440;
for (const ar of ["1:1", "4:3", "3:4", "16:9", "9:16", "21:9", "3:2", "2:3"]) {
  for (const res of ["1k", "2k", "4k", undefined]) {
    const { width, height } = seedream5Size(ar, res);
    assert.ok(width * height >= MIN, `${ar}/${res} too few pixels: ${width}x${height}`);
    assert.ok(width <= 4096 && height <= 4096, `${ar}/${res} over cap: ${width}x${height}`);
    const [w, h] = ar.split(":").map(Number);
    assert.ok(Math.abs(width / height - w / h) < 0.02, `${ar}/${res} wrong ratio: ${width}x${height}`);
  }
}
console.log("seedream5 size checks passed");
