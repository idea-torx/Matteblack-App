/**
 * Self-check for schema-driven custom models.
 * Run: `npx tsx server/models/customModels.test.ts`
 *
 * These two pieces replace per-model hand-written code, so they are the whole
 * trust boundary for a model nobody reviewed: extraction reads fal's OpenAPI
 * doc, buildInputFromSchema turns Falforge params into that endpoint's input.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildInputFromSchema, type JsonSchema } from "./customModels.js";
import { extractSchemas, inferType } from "../services/falCatalog.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(here, "__fixtures__", name), "utf8"));

// --- OpenAPI extraction, on docs captured from the live fal endpoints --------

const flux = extractSchemas(fixture("flux-schnell.openapi.json"), "fal-ai/flux/schnell");
assert.equal(flux.type, "image", "flux/schnell returns images[]");
assert.ok(flux.input.properties?.prompt, "prompt is an input field");
assert.equal(flux.input.properties?.num_inference_steps?.default, 4);
assert.deepEqual(flux.input.required, ["prompt"]);
// $ref'd output schema (Image) is inlined, not left as a dangling reference.
assert.ok(flux.output.properties?.images, "images is on the output");

const kling = extractSchemas(fixture("kling-v2-t2v.openapi.json"), "fal-ai/kling-video/v2/master/text-to-video");
assert.equal(kling.type, "video", "a `video` output property means a video model");
assert.ok(kling.input.properties?.duration, "duration is an input field");

assert.equal(inferType({ properties: { audio: {} } }), "audio");
assert.equal(inferType({ properties: { whatever: {} } }), "image", "unknown output falls back to image");

// --- buildInputFromSchema ---------------------------------------------------

const schema: JsonSchema = {
  type: "object",
  required: ["prompt"],
  properties: {
    prompt: { type: "string" },
    image_url: { type: "string" },
    num_images: { type: "integer" },
    guidance_scale: { type: "number" },
    sync_mode: { type: "boolean" },
    aspect_ratio: { type: "string", enum: ["16:9", "9:16"] },
    image_urls: { type: "array", items: { type: "string" } },
  },
};

const ok = (r: ReturnType<typeof buildInputFromSchema>) => {
  assert.ok("input" in r, "error" in r ? r.error : "");
  return (r as { input: Record<string, unknown> }).input;
};

// Fields the endpoint doesn't declare are dropped, not forwarded.
assert.deepEqual(ok(buildInputFromSchema(schema, {}, { prompt: "a cat", nonsense: 1 })), { prompt: "a cat" });

// Defaults apply, explicit params win.
assert.equal(ok(buildInputFromSchema(schema, { num_images: 2 }, { prompt: "x" })).num_images, 2);
assert.equal(ok(buildInputFromSchema(schema, { num_images: 2 }, { prompt: "x", num_images: 3 })).num_images, 3);

// Coercion from the strings a form/JSON body actually sends.
const coerced = ok(buildInputFromSchema(schema, {}, { prompt: "x", num_images: "3", guidance_scale: "1.5", sync_mode: "true" }));
assert.deepEqual([coerced.num_images, coerced.guidance_scale, coerced.sync_mode], [3, 1.5, true]);
assert.ok("error" in buildInputFromSchema(schema, {}, { prompt: "x", num_images: "many" }));

// Enums are rejected, not silently forwarded to fal.
assert.ok("error" in buildInputFromSchema(schema, {}, { prompt: "x", aspect_ratio: "4:3" }));
assert.equal(ok(buildInputFromSchema(schema, {}, { prompt: "x", aspect_ratio: "9:16" })).aspect_ratio, "9:16");

// Required fields.
const missing = buildInputFromSchema(schema, {}, { num_images: 1 });
assert.ok("error" in missing && /prompt/.test(missing.error));

// Aliases: Falforge param names map onto the fields the endpoint declares.
// An array source into a scalar field means "the first one"...
assert.equal(
  ok(buildInputFromSchema({ ...schema, properties: { prompt: { type: "string" }, image_url: { type: "string" } } }, {},
    { prompt: "x", referenceImageUrls: ["https://a/1.png", "https://a/2.png"] })).image_url,
  "https://a/1.png",
);
// ...and into an array field, the whole list.
assert.deepEqual(
  ok(buildInputFromSchema(schema, {}, { prompt: "x", referenceImageUrls: ["https://a/1.png", "https://a/2.png"] })).image_urls,
  ["https://a/1.png", "https://a/2.png"],
);
// A field the endpoint doesn't have is simply not aliased anywhere.
assert.deepEqual(ok(buildInputFromSchema(schema, {}, { prompt: "x", duration: "5" })), { prompt: "x" });
// firstFrameUrl lands on image_url when that's what the endpoint calls it.
assert.equal(ok(buildInputFromSchema(schema, {}, { prompt: "x", firstFrameUrl: "https://a/f.png" })).image_url, "https://a/f.png");

// A newline-separated URL box becomes an array.
assert.deepEqual(
  ok(buildInputFromSchema(schema, {}, { prompt: "x", image_urls: "https://a/1.png\nhttps://a/2.png" })).image_urls,
  ["https://a/1.png", "https://a/2.png"],
);

console.log("customModels: all assertions passed");
