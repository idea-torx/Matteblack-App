// npx tsx server/canvas/edges.test.ts
import assert from "node:assert/strict";
import { deriveEdges } from "./edges.js";

const nodes = [
  { id: "a", jobType: "text_to_image", params: {}, urls: ["http://127.0.0.1:5000/uploads/a.png"] },
  // relative form of a.png's URL — must still match the absolute one above
  { id: "b", jobType: "image_to_image", params: { referenceImageUrls: ["/uploads/a.png"] }, urls: ["/uploads/b.png"] },
  { id: "c", jobType: "upscale", params: { referenceImageUrls: ["http://127.0.0.1:5000/uploads/b.png"] }, urls: ["/uploads/c.png"] },
  { id: "d", jobType: "video_gen", params: { firstFrameUrl: "/uploads/c.png" }, urls: ["/uploads/d.mp4"] },
  { id: "e", jobType: "video_gen", params: { continuedFrom: "https://cdn.example.com/x/d.mp4", seam: "frame" }, urls: ["/uploads/e.mp4"] },
  // input that isn't on this canvas → silently skipped
  { id: "f", jobType: "remove_bg", params: { referenceImageUrls: ["/uploads/ghost.png"] }, urls: ["/uploads/f.png"] },
  // self-reference must not produce an edge
  { id: "g", jobType: "resize", params: { image_url: "/uploads/g.png" }, urls: ["/uploads/g.png"] },
];

const edges = deriveEdges(nodes);
assert.deepEqual(edges, [
  { from: "a", to: "b", kind: "reference" },
  { from: "b", to: "c", kind: "upscale" },
  { from: "c", to: "d", kind: "keyframe" },
  { from: "d", to: "e", kind: "continuation" },
]);

// dedupe: the same source listed twice yields one edge
assert.equal(
  deriveEdges([
    { id: "s", jobType: "text_to_image", params: {}, urls: ["/uploads/s.png"] },
    { id: "t", jobType: "image_to_image", params: { referenceImageUrls: ["/uploads/s.png", "/uploads/s.png"] }, urls: ["/uploads/t.png"] },
  ]).length,
  1,
);

console.log("edges.test.ts ok");
