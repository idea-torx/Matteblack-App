/**
 * Self-check for dispatching a runtime-added (custom) model through the agent.
 * Run: `npx tsx server/routes/agent.custommodel.test.ts`
 *
 * `add_model` tells Claude the new key is "usable via generate_media", but the
 * agent's model resolution is a whitelist of t2/i2 families — an unknown key
 * silently falls back to the tier default, so the run succeeds with the WRONG
 * model and nothing anywhere says so. That silence is what this pins.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mb-custom-"));
process.env.MATTEBLACK_DATA_DIR = dir;
fs.writeFileSync(
  path.join(dir, "custom-models.json"),
  JSON.stringify([
    { key: "my-img", falModelId: "fal-ai/flux/schnell", type: "image", title: "FLUX schnell",
      schema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
      defaults: {}, addedAt: "", addedBy: "operator" },
    { key: "my-vid", falModelId: "fal-ai/kling-video/v2/master/text-to-video", type: "video", title: "Kling",
      schema: { type: "object", properties: { prompt: { type: "string" }, duration: { type: "string" } }, required: ["prompt"] },
      defaults: {}, addedAt: "", addedBy: "operator" },
  ]),
);

const { buildGenerateBody } = await import("./agent.js");
const gen = (over: Record<string, unknown>, refs: string[] = []) =>
  buildGenerateBody({ kind: "image", prompt: "p", tier: "premium", ...over } as never, refs, "c1", "w1", true)!;

// The custom key wins over the whitelist instead of falling back to the tier default.
assert.equal(gen({ explicitModel: "my-img" }).resolvedModel, "my-img");
assert.equal(gen({ explicitModel: "my-img" }).type, "text_to_image");

// A reference flips it to image_to_image on the SAME endpoint — a custom model
// is one endpoint, there is no separate edit variant to route to.
const withRef = gen({ explicitModel: "my-img" }, ["https://x/a.png"]);
assert.equal(withRef.resolvedModel, "my-img");
assert.equal(withRef.type, "image_to_image");
assert.deepEqual(withRef.body.referenceImageUrls, ["https://x/a.png"]);

const vid = buildGenerateBody(
  { kind: "video", prompt: "p", tier: "premium", explicitModel: "my-vid", durationSeconds: 5 } as never,
  [], "c1", "w1", true,
)!;
assert.equal(vid.resolvedModel, "my-vid");
assert.equal(vid.type, "video_gen");
assert.equal(vid.body.duration, "5");

// Kind mismatch must NOT hijack the dispatch: asking for video with an image
// model falls back to the normal whitelist path.
assert.notEqual(
  buildGenerateBody({ kind: "video", prompt: "p", tier: "premium", explicitModel: "my-img" } as never, [], "c1", "w1", true)!.resolvedModel,
  "my-img",
);

fs.rmSync(dir, { recursive: true, force: true });
console.log("agent custom model: all checks passed");
// Importing agent.ts boots PGlite against MATTEBLACK_DATA_DIR in the background;
// leave before it writes into the temp dir we just removed.
process.exit(0);

// A whitelisted video family the old name-by-name chain didn't list (h3-turbo)
// fell through to Seedance 2.0 at $10 a clip. Seedance is never a fallthrough.
const turbo = gen({ kind: "video", explicitModel: "h3-turbo" });
assert.equal(turbo.resolvedModel, "h3-turbo-t2v");
assert.equal(gen({ kind: "video", explicitModel: "h3 max turbo" }).resolvedModel, "h3-turbo-t2v");
assert.equal(gen({ kind: "video", explicitModel: "no-such-model" }).resolvedModel, "h3-max-t2v");
assert.equal(gen({ kind: "video", explicitModel: "h3-turbo", videoResolution: "768p" }).videoResolution, "768p");
