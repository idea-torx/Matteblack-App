import assert from "node:assert/strict";
import { isFalHost } from "../utils/falHost.js";
assert.equal(isFalHost("https://wma.fal.run/session"), true);
assert.equal(isFalHost("https://fal.run/ice"), true);
assert.equal(isFalHost("https://evil.com/?x=fal.run"), false);
assert.equal(isFalHost("https://notfal.run/"), false);
assert.equal(isFalHost("http://wma.fal.run/session"), false);
assert.equal(isFalHost("nonsense"), false);
console.log("director ok");
