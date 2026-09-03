import assert from "node:assert/strict";
import { jobCostParams } from "./falBilling.js";

const p = jobCostParams({ duration: "5", resolution: "1080p", generate_audio: true, prompt: "x", num_images: 2 });
assert.deepEqual(p, { duration: 5, resolution: "1080p", quantity: 2, features: ["generate_audio"] });
assert.deepEqual(jobCostParams({}), { duration: undefined, resolution: undefined, quantity: undefined, features: [] });
console.log("falBilling ok");
