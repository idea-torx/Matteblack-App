/**
 * Self-check for the character → scene chain.
 * Run: `npx tsx server/routes/agent.i2i.test.ts`
 *
 * Two things have to hold for "generate a character, then put it in a scene"
 * to work, and neither fails loudly when it breaks:
 *
 *  1. Attaching a reference must flip the chosen family to its EDIT endpoint.
 *     If it doesn't, you get a brand-new character from the prompt alone and
 *     the run looks like the model simply ignored the likeness.
 *  2. That endpoint must emit `image_urls`. fal DROPS unknown fields silently,
 *     so a renamed field returns a perfectly good image of the wrong person.
 */
import assert from "node:assert/strict";
import { buildGenerateBody } from "./agent.js";
import { getModelConfig } from "../fal.js";

const CHAR = "https://v3.fal.media/files/character.png";
const SCENE = "https://v3.fal.media/files/second-character.png";

const gen = (over: Record<string, unknown>, refs: string[]) =>
  buildGenerateBody(
    { kind: "image", prompt: "two characters in a rain-lit alley", tier: "premium", ...over } as never,
    refs, "canvas-1", "ws-1", true,
  );

// --- 1. routing: no refs = text-to-image, refs = that family's edit endpoint ---
assert.equal(gen({}, [])!.resolvedModel, "nano-banana-2-t2i", "character step must be t2i");

for (const [named, t2i, edit] of [
  [undefined, "nano-banana-2-t2i", "nano-banana-2"],
  ["nano-banana-2", "nano-banana-2-t2i", "nano-banana-2"],
  ["nano banana", "nano-banana-2-t2i", "nano-banana-2"],   // the alias the user actually says
  ["gpt-image-2", "gpt-image-2-t2i", "gpt-image-2-edit"],
  ["seedream", "seedream-t2i", "seedream-edit"],
] as const) {
  const over = named ? { explicitModel: named } : {};
  assert.equal(gen(over, [])!.resolvedModel, t2i, `${named ?? "default"} without refs`);
  const withRef = gen(over, [CHAR])!;
  assert.equal(withRef.resolvedModel, edit, `${named ?? "default"} with a reference must use its edit endpoint`);
  assert.equal(withRef.type, "image_to_image");
  assert.deepEqual(withRef.body.referenceImageUrls, [CHAR]);
}

// Two characters into one scene: both survive, in order.
assert.deepEqual(gen({}, [CHAR, SCENE])!.body.referenceImageUrls, [CHAR, SCENE]);

// --- 2. fal payload: every edit endpoint sends image_urls, plural ---
for (const key of ["nano-banana-2", "gpt-image-2-edit", "seedream-edit"]) {
  const cfg = getModelConfig(key);
  assert.ok(cfg, `${key} missing from MODEL_MAP`);
  const input = cfg!.buildInput!({
    prompt: "p", aspect_ratio: "16:9", referenceImageUrls: [CHAR, SCENE],
  } as never) as Record<string, unknown>;
  assert.deepEqual(input.image_urls, [CHAR, SCENE], `${key} must pass both references as image_urls`);
}

// --- 3. the scene frame into H3 reference-to-video ---
const vid = buildGenerateBody(
  { kind: "video", prompt: "she turns", tier: "premium", explicitModel: "h3-max",
    videoReferenceMode: "references" } as never,
  [SCENE], "canvas-1", "ws-1", true,
)!;
assert.equal(vid.resolvedModel, "h3-max-r2v");
assert.deepEqual(vid.body.referenceImageUrls, [SCENE]);
assert.deepEqual(
  (getModelConfig("h3-max-r2v")!.buildInput!({ prompt: "p", referenceImageUrls: [SCENE] } as never) as Record<string, unknown>).reference_image_urls,
  [SCENE],
);

console.log("all image-to-image chain checks passed");
