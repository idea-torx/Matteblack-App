/**
 * Self-check for the /uploads path mapper. Run: `npx tsx server/utils/uploadPath.test.ts`
 * The point of this file is the traversal case.
 */
import assert from "node:assert/strict";
import { resolveUploadPath, resolveUploadFile } from "./uploadPath.js";

const DIR = "/data/uploads";

assert.deepEqual(resolveUploadPath("/uploads/a.png", DIR), { path: "/data/uploads/a.png", mime: "image/png" });
assert.deepEqual(resolveUploadPath("/uploads/sub/b.JPG", DIR), { path: "/data/uploads/sub/b.JPG", mime: "image/jpeg" });
// Query strings (cache busters) are stripped, %20 is decoded.
assert.equal(resolveUploadPath("/uploads/my%20pic.webp?v=2", DIR)?.path, "/data/uploads/my pic.webp");

// Not ours, or not an image we can send.
assert.equal(resolveUploadPath("https://cdn.fal.ai/x.png", DIR), null);
assert.equal(resolveUploadPath("/audio/x.png", DIR), null);
assert.equal(resolveUploadPath("/uploads/notes.txt", DIR), null);
assert.equal(resolveUploadPath("/uploads/", DIR), null);

// The one that matters.
assert.equal(resolveUploadPath("/uploads/../../etc/passwd.png", DIR), null);
assert.equal(resolveUploadPath("/uploads/sub/../../secrets.png", DIR), null);
// A sibling dir sharing the prefix must not pass either.
assert.equal(resolveUploadPath("/uploads/../uploads-evil/x.png", DIR), null);


// Non-image uploads resolve as PATHS but have no image mime. This is the split
// continue_video needed: a .mp4 through the image-gated function came back null
// and read as "file missing" when the file was sitting right there.
assert.equal(
  resolveUploadFile("/uploads/generations/video/abc/1788081517030-rpqs464p.mp4", DIR),
  "/data/uploads/generations/video/abc/1788081517030-rpqs464p.mp4",
);
assert.equal(resolveUploadPath("/uploads/generations/video/abc/clip.mp4", DIR), null);
// The traversal guard must hold on the split-out function too, not just the wrapper.
assert.equal(resolveUploadFile("/uploads/../../etc/passwd", DIR), null);
assert.equal(resolveUploadFile("https://fal.media/x/clip.mp4", DIR), null);

console.log("uploadPath: all checks passed");
