import { test } from "node:test";
import assert from "node:assert/strict";
import { guardArgs, mediaUrls } from "./higgsfield.js";

test("mediaUrls picks media links once, trailing punctuation off", () => {
  const out = mediaUrls("done: https://cdn.hf.ai/a.mp4, https://cdn.hf.ai/a.mp4 and https://higgsfield.ai/jobs/1 (https://x.io/b.png?sig=1).");
  assert.deepEqual(out, ["https://cdn.hf.ai/a.mp4", "https://x.io/b.png?sig=1"]);
});

test("guardArgs refuses auth/workspace and non-string args", () => {
  assert.ok("error" in guardArgs(["auth", "token"]));
  assert.ok("error" in guardArgs(["workspace", "select"]));
  assert.ok("error" in guardArgs([]));
  assert.ok("error" in guardArgs(["generate", 5]));
  assert.deepEqual(guardArgs(["generate", "create", "z_image", "--prompt", "x", "--wait"]), ["generate", "create", "z_image", "--prompt", "x", "--wait"]);
});
