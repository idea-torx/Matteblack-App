/**
 * User/operator-added fal.ai models.
 *
 * A Falforge model normally means hand-written code: an entry in fal.ts's
 * MODEL_MAP with a bespoke `buildInput`. That is right for the ~47 models the
 * app tunes by hand, and wrong for "I just found this endpoint on fal.ai, let
 * me try it". A custom model instead carries fal's own OpenAPI input schema,
 * and `buildInputFromSchema` plays the part `buildInput` plays for the built-ins:
 * take Falforge's params, keep what the endpoint actually declares, coerce and
 * validate, hand fal an input object.
 *
 * Stored as one JSON array in the user's data dir — a handful of records the
 * user typed in, not a database.
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, ensureDataDir } from "../config/runtime.js";

export type CustomModelType = "image" | "video" | "audio";

export type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  default?: unknown;
  items?: JsonSchema;
  title?: string;
  description?: string;
  minimum?: number;
  maximum?: number;
  [k: string]: unknown;
};

export type CustomModel = {
  key: string;
  falModelId: string;
  type: CustomModelType;
  title: string;
  schema: JsonSchema;
  defaults: Record<string, unknown>;
  addedAt: string;
  addedBy: "user" | "operator";
};

const STORE_PATH = path.join(DATA_DIR, "custom-models.json");

/** fal endpoint ids are `owner/model[/variant]`; a model key has to survive a
 *  URL path segment and a <select> value, so slashes and dots become dashes. */
export function keyFromEndpoint(endpointId: string): string {
  return endpointId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function listCustomModels(): CustomModel[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    return Array.isArray(parsed) ? (parsed as CustomModel[]) : [];
  } catch {
    return [];
  }
}

export function readCustomModel(key: string): CustomModel | undefined {
  return listCustomModels().find((m) => m.key === key);
}

function persist(models: CustomModel[]): void {
  ensureDataDir();
  fs.writeFileSync(STORE_PATH, JSON.stringify(models, null, 2));
}

/** Add or replace by key. */
export function addCustomModel(model: CustomModel): CustomModel {
  const models = listCustomModels().filter((m) => m.key !== model.key);
  models.push(model);
  persist(models);
  return model;
}

export function removeCustomModel(key: string): boolean {
  const models = listCustomModels();
  const kept = models.filter((m) => m.key !== key);
  if (kept.length === models.length) return false;
  persist(kept);
  return true;
}

// ---------------------------------------------------------------------------
// Params -> fal input
// ---------------------------------------------------------------------------

/** Falforge's own param names -> the fal field names they usually mean. First
 *  candidate the endpoint actually declares wins.
 *  ponytail: a flat alias table, not a mapping DSL. If an endpoint names its
 *  fields something else, the user types the value into the schema form field
 *  directly — that path always works. */
const ALIASES: Record<string, string[]> = {
  prompt: ["prompt"],
  negative_prompt: ["negative_prompt"],
  seed: ["seed"],
  duration: ["duration", "duration_seconds", "num_seconds"],
  resolution: ["resolution"],
  aspect_ratio: ["aspect_ratio"],
  aspectRatio: ["aspect_ratio"],
  imageUrl: ["image_url", "image_urls"],
  firstFrameUrl: ["image_url", "first_frame_url", "start_image_url"],
  lastFrameUrl: ["last_frame_url", "end_image_url", "tail_image_url"],
  videoUrl: ["video_url"],
  audioUrl: ["audio_url"],
  referenceImageUrls: ["image_urls", "reference_image_urls", "image_url"],
  referenceVideoUrls: ["video_url", "reference_video_urls"],
};

function coerce(value: unknown, spec: JsonSchema): { value: unknown } | { error: string } {
  const t = spec.type;
  if (t === "integer" || t === "number") {
    const n = typeof value === "number" ? value : Number(String(value).trim());
    if (!isFinite(n)) return { error: `expected a number, got ${JSON.stringify(value)}` };
    return { value: t === "integer" ? Math.round(n) : n };
  }
  if (t === "boolean") {
    if (typeof value === "boolean") return { value };
    const s = String(value).trim().toLowerCase();
    if (s === "true" || s === "1") return { value: true };
    if (s === "false" || s === "0" || s === "") return { value: false };
    return { error: `expected a boolean, got ${JSON.stringify(value)}` };
  }
  if (t === "array") {
    const arr = Array.isArray(value)
      ? value
      : String(value).split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
    return { value: arr };
  }
  if (t === "string") return { value: typeof value === "string" ? value : String(value) };
  return { value };
}

/**
 * Build a fal input object from an endpoint's OpenAPI input schema.
 * Pure: no I/O, no network. Returns `{ input }` or `{ error }`.
 */
export function buildInputFromSchema(
  schema: JsonSchema,
  defaults: Record<string, unknown>,
  params: Record<string, unknown>,
): { input: Record<string, unknown> } | { error: string } {
  const props = schema.properties ?? {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(props, k);
  const raw: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(defaults)) if (has(k) && v !== undefined && v !== null) raw[k] = v;

  // Aliases fill fields the caller didn't name directly.
  for (const [from, candidates] of Object.entries(ALIASES)) {
    const v = params[from];
    if (v === undefined || v === null || v === "") continue;
    const target = candidates.find(has);
    if (!target || params[target] !== undefined) continue;
    // An array source into a scalar field means "the first one".
    raw[target] = Array.isArray(v) && props[target].type !== "array" ? v[0] : v;
  }

  // Explicit params win over both.
  for (const [k, v] of Object.entries(params)) {
    if (!has(k) || v === undefined || v === null || v === "") continue;
    raw[k] = v;
  }

  const input: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    const spec = props[k];
    const c = coerce(v, spec);
    if ("error" in c) return { error: `${k}: ${c.error}` };
    const allowed = spec.enum;
    if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(c.value as never)) {
      return { error: `${k}: ${JSON.stringify(c.value)} is not one of ${allowed.map((a) => JSON.stringify(a)).join(", ")}` };
    }
    input[k] = c.value;
  }

  const missing = (schema.required ?? []).filter((k) => input[k] === undefined);
  if (missing.length > 0) return { error: `missing required field(s): ${missing.join(", ")}` };
  return { input };
}
