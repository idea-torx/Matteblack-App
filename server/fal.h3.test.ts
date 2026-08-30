/**
 * Self-check for the H3 Max chunk-chaining inputs.
 * Run: `npx tsx server/fal.h3.test.ts`
 *
 * The point of this file is that buildInput emits field names fal actually
 * accepts. fal silently DROPS unknown fields rather than erroring — so a typo'd
 * `reference_video_url` doesn't fail the call, it just returns an unconditioned
 * clip. That failure looks like "the model ignored my continuation", which is
 * indistinguishable from bad prompting and is exactly how a long-form sequence
 * quietly turns into a pile of unrelated shots.
 *
 * Schemas are fetched live and cached under /tmp/h3schemas by the build step;
 * if they're absent the schema half is skipped rather than failing offline.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getModelConfig } from "./fal.js";

const build = (key: string, params: Record<string, unknown>) => {
  const cfg = getModelConfig(key);
  assert.ok(cfg, `${key} is not registered in MODEL_MAP`);
  return cfg!.buildInput!(params as never) as Record<string, unknown>;
};

// --- i2v: the hard seam ------------------------------------------------------
const i2v = build("h3-max-i2v", {
  prompt: "she keeps walking", firstFrameUrl: "https://cdn.example.com/last.png", duration: 8, resolution: "480p",
});
assert.equal(i2v.image_url, "https://cdn.example.com/last.png", "the previous chunk's last frame must land on image_url");
assert.equal(i2v.duration, 8);
assert.equal(i2v.resolution, "480P", "fal's enum is uppercase");
assert.equal(i2v.prompt_expansion_mode, "balanced");
// This endpoint has no aspect_ratio field — output follows the image. Sending
// one would be dropped, so we must not pretend it was honoured.
assert.ok(!("aspect_ratio" in i2v), "i2v must not send aspect_ratio");
// end_image_url only appears when a target frame was actually given.
assert.ok(!("end_image_url" in i2v), "no end frame requested, none should be sent");
assert.equal(
  build("h3-max-i2v", { prompt: "p", firstFrameUrl: "https://cdn.example.com/a.png", lastFrameUrl: "https://cdn.example.com/b.png" }).end_image_url,
  "https://cdn.example.com/b.png",
);

// --- r2v: the soft seam ------------------------------------------------------
const r2v = build("h3-max-r2v", {
  prompt: "Video 1 continues", referenceVideoUrls: ["https://cdn.example.com/tail.mp4"],
  referenceImageUrls: ["https://cdn.example.com/hero.png"], duration: 5,
});
assert.deepEqual(r2v.reference_video_urls, ["https://cdn.example.com/tail.mp4"], "the tail clip is the continuation signal");
assert.deepEqual(r2v.reference_image_urls, ["https://cdn.example.com/hero.png"]);
assert.equal(r2v.aspect_ratio, "adaptive", "a continuation should follow its source, not force 16:9");
assert.equal(build("h3-max-r2v", { prompt: "p", aspect_ratio: "9:16" }).aspect_ratio, "9:16", "explicit AR still wins");

// fal's caps: 3 videos, 9 images, 12 files total. Videos carry continuity, so
// they must survive when both lists are overfull.
const capped = build("h3-max-r2v", {
  prompt: "p",
  referenceVideoUrls: Array.from({ length: 5 }, (_, i) => `https://cdn.example.com/v${i}.mp4`),
  referenceImageUrls: Array.from({ length: 12 }, (_, i) => `https://cdn.example.com/i${i}.png`),
});
assert.equal((capped.reference_video_urls as string[]).length, 3, "at most 3 reference videos");
const imgCount = (capped.reference_image_urls as string[]).length;
assert.ok(imgCount <= 9, "at most 9 reference images");
assert.ok(imgCount + 3 <= 12, `combined references must fit fal's 12-file cap, got ${imgCount + 3}`);

// Empty reference arrays must be omitted, not sent as [] — an empty
// reference_video_urls is what an r2v call rejects.
const bare = build("h3-max-r2v", { prompt: "p" });
assert.ok(!("reference_video_urls" in bare) && !("reference_image_urls" in bare));

// --- duration clamps ---------------------------------------------------------
for (const [asked, want] of [[1, 5], [5, 5], [15, 15], [99, 15], [7.6, 8]] as const) {
  assert.equal(build("h3-max-t2v", { prompt: "p", duration: asked }).duration, want, `duration ${asked}`);
}

// --- every emitted field is one fal actually accepts -------------------------
const SCHEMA_DIR = "/tmp/h3schemas";
const schemaFor = (file: string): Set<string> | null => {
  const p = path.join(SCHEMA_DIR, file);
  if (!fs.existsSync(p)) return null;
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  const schemas = doc?.components?.schemas ?? {};
  for (const [name, def] of Object.entries<{ properties?: Record<string, unknown> }>(schemas)) {
    if (name.includes("Input") && def.properties) return new Set(Object.keys(def.properties));
  }
  return null;
};
const cases: [string, string, Record<string, unknown>][] = [
  ["minimax_h3-max_image-to-video.json", "h3-max-i2v", { prompt: "p", firstFrameUrl: "https://cdn.example.com/a.png", lastFrameUrl: "https://cdn.example.com/b.png" }],
  ["minimax_h3-max_reference-to-video.json", "h3-max-r2v", { prompt: "p", referenceVideoUrls: ["https://cdn.example.com/t.mp4"], referenceImageUrls: ["https://cdn.example.com/i.png"] }],
  ["minimax_h3-max_text-to-video.json", "h3-max-t2v", { prompt: "p", aspect_ratio: "16:9" }],
];
let checked = 0;
for (const [file, key, params] of cases) {
  const allowed = schemaFor(file);
  if (!allowed) continue;
  checked++;
  for (const field of Object.keys(build(key, params))) {
    assert.ok(allowed.has(field), `${key} emits "${field}", which ${file} does not accept`);
  }
}
console.log(`fal h3: all checks passed (${checked}/${cases.length} verified against live fal schemas)`);
