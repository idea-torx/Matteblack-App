/**
 * fal.ai model discovery.
 *
 * Two public, unauthenticated fal endpoints do the whole job:
 *
 *   GET https://fal.ai/api/models?keywords=<q>&page=1
 *     -> { items: [{ id, title, category, shortDescription, ... }], total }
 *   GET https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>
 *     -> the endpoint's OpenAPI 3 doc
 *
 * Neither takes the user's fal key (verified 2026-09-01), so discovery works
 * before a key is entered — you only need one to actually generate.
 *
 * From the OpenAPI doc we want two things: the request-body schema of
 * `POST /<endpointId>` (what the model takes) and the 200 schema of
 * `GET /<endpointId>/requests/{request_id}` (what it returns, which tells us
 * whether this is an image, video or audio model).
 */
import type { JsonSchema, CustomModelType } from "../models/customModels.js";

const SEARCH_URL = "https://fal.ai/api/models";
const OPENAPI_URL = "https://fal.ai/api/openapi/queue/openapi.json";

export type CatalogEntry = {
  endpointId: string;
  title: string;
  category: string;
  description: string;
};

async function getJson(url: string, timeoutMs = 15000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`fal responded ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Free-text search over fal's public model catalog. `page` is 1-based — page 0
 *  answers 200 with an empty `items`, which reads as "no results" and is not. */
export async function searchModels(q: string, limit = 20): Promise<CatalogEntry[]> {
  const data = (await getJson(`${SEARCH_URL}?keywords=${encodeURIComponent(q)}&page=1`)) as {
    items?: Array<{ id?: string; title?: string; category?: string; shortDescription?: string; deprecated?: boolean }>;
  };
  return (data.items ?? [])
    .filter((m) => m.id && !m.deprecated)
    .slice(0, limit)
    .map((m) => ({
      endpointId: m.id!,
      title: m.title || m.id!,
      category: m.category || "",
      description: m.shortDescription || "",
    }));
}

type OpenApiDoc = {
  components?: { schemas?: Record<string, JsonSchema> };
  paths?: Record<string, Record<string, unknown>>;
};

/** Inline `$ref`s so callers (and the client form) see a plain schema.
 *  ponytail: depth-capped rather than cycle-tracked — fal's generated schemas
 *  nest a couple of levels and never recurse. */
function deref(node: unknown, schemas: Record<string, JsonSchema>, depth = 0): JsonSchema {
  if (!node || typeof node !== "object") return {} as JsonSchema;
  if (depth > 6) return {} as JsonSchema;
  const obj = { ...(node as Record<string, unknown>) };
  const ref = obj.$ref;
  if (typeof ref === "string") {
    const name = ref.split("/").pop()!;
    delete obj.$ref;
    return { ...deref(schemas[name] ?? {}, schemas, depth + 1), ...(obj as JsonSchema) };
  }
  if (obj.properties && typeof obj.properties === "object") {
    const out: Record<string, JsonSchema> = {};
    for (const [k, v] of Object.entries(obj.properties as Record<string, unknown>)) out[k] = deref(v, schemas, depth + 1);
    obj.properties = out;
  }
  if (obj.items) obj.items = deref(obj.items, schemas, depth + 1);
  return obj as JsonSchema;
}

/** Media type a fal endpoint produces, read off its output schema's property
 *  names. Falls back to "image" — the commonest and the safest to render. */
export function inferType(output: JsonSchema): CustomModelType {
  const keys = Object.keys(output.properties ?? {});
  if (keys.some((k) => /^videos?$/.test(k) || k === "video_url")) return "video";
  if (keys.some((k) => /^audios?$/.test(k) || k === "audio_url")) return "audio";
  return "image";
}

export type EndpointSchema = {
  endpointId: string;
  title: string;
  input: JsonSchema;
  output: JsonSchema;
  type: CustomModelType;
};

/** Pull the input/output schemas out of an already-fetched OpenAPI doc. Split
 *  from the fetch so the extraction is testable against a saved fixture. */
export function extractSchemas(doc: OpenApiDoc, endpointId: string): EndpointSchema {
  const schemas = doc.components?.schemas ?? {};
  const paths = doc.paths ?? {};
  const submitPath = `/${endpointId}`;
  const resultPath = `/${endpointId}/requests/{request_id}`;

  const post = paths[submitPath]?.post as
    | { requestBody?: { content?: Record<string, { schema?: unknown }> } }
    | undefined;
  const get = paths[resultPath]?.get as
    | { responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> }
    | undefined;

  const inputRef = post?.requestBody?.content?.["application/json"]?.schema;
  const outputRef = get?.responses?.["200"]?.content?.["application/json"]?.schema;
  if (!inputRef) throw new Error(`No request body schema for ${endpointId} in its OpenAPI doc.`);

  const input = deref(inputRef, schemas);
  const output = deref(outputRef ?? {}, schemas);
  return {
    endpointId,
    title: endpointId,
    input,
    output,
    type: inferType(output),
  };
}

export async function getModelSchema(endpointId: string): Promise<EndpointSchema> {
  const doc = (await getJson(`${OPENAPI_URL}?endpoint_id=${encodeURIComponent(endpointId)}`)) as OpenApiDoc;
  const meta = (doc as { info?: { "x-fal-metadata"?: { endpointId?: string } } }).info?.["x-fal-metadata"];
  const s = extractSchemas(doc, meta?.endpointId || endpointId);
  return s;
}
