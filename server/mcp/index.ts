/**
 * Matteblack MCP bridge (Phase J2) — a stdio Model Context Protocol server that
 * lets a Claude *subscription* client (Claude Desktop / Claude Code) drive the
 * local Matteblack generation harness.
 *
 * This process is spawned by the Claude client (`node dist-mcp/index.js` or
 * `tsx server/mcp/index.ts`). It is SEPARATE from the Express app: it finds the
 * running app via a discovery file (`<dataDir>/mcp-endpoint.json`, written by the
 * server on boot) and talks to it over HTTP loopback:
 *
 *   Claude client ──stdio(JSON-RPC)──▶ this server ──HTTP──▶ Fal Forge app
 *                                                          GET  /api/agent/tools
 *                                                          POST /api/agent/tool
 *                                                          GET  /api/job/:id  (poll)
 *
 * The three generation tools are request/response here (unlike the in-app SSE
 * agent): each call dispatches a job and BLOCKS, polling the job to completion,
 * then returns the result URL. Claude-the-client handles multi-step orchestration
 * natively, so none of the in-app prompt gymnastics are needed.
 *
 * CRITICAL: stdout is the JSON-RPC transport. NEVER write to stdout. All logs go
 * to stderr via `logErr`.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type Tool,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Resolve the data dir the same way server/config/runtime.ts does, without
 *  importing it (keeps this a small standalone bundle and avoids its boot
 *  side-effects). */
function resolveDataDir(): string {
  return process.env.MATTEBLACK_DATA_DIR || path.join(os.homedir(), ".matteblack");
}

const ENDPOINT_FILE = path.join(resolveDataDir(), "mcp-endpoint.json");

/** Overall poll budget. Images/music land in seconds; video can take minutes,
 *  so default generously. Override with MB_MCP_TIMEOUT_MS. */
const POLL_TIMEOUT_MS = Number(process.env.MB_MCP_TIMEOUT_MS) || 8 * 60 * 1000;
const POLL_INTERVAL_MS = Number(process.env.MB_MCP_POLL_MS) || 2000;

function logErr(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.error("[matteblack-mcp]", ...args);
}

// ---------------------------------------------------------------------------
// Discovery + HTTP helpers
// ---------------------------------------------------------------------------

interface Endpoint {
  baseUrl: string;
  token?: string;
}

/** Read the discovery file each time (the app may (re)start on a new ephemeral
 *  port between calls). Returns null if the app isn't running / hasn't published. */
function readEndpoint(): Endpoint | null {
  try {
    const raw = fs.readFileSync(ENDPOINT_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<Endpoint>;
    if (parsed && typeof parsed.baseUrl === "string" && parsed.baseUrl) {
      return { baseUrl: parsed.baseUrl.replace(/\/+$/, ""), token: parsed.token };
    }
  } catch {
    /* not running / not yet published */
  }
  return null;
}

/** Thrown when the app isn't reachable — surfaced to Claude as a clear, actionable
 *  tool error rather than a stack trace. */
class AppUnavailableError extends Error {}

function authHeaders(ep: Endpoint): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  // J3 will enforce this token via middleware; harmless for the app to ignore now.
  if (ep.token) h["x-matteblack-token"] = ep.token;
  return h;
}

async function httpJson(
  ep: Endpoint,
  method: "GET" | "POST",
  route: string,
  body?: unknown,
  timeoutMs = 15000,
): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${ep.baseUrl}${route}`, {
      method,
      headers: authHeaders(ep),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    // Connection refused / DNS / abort → the app is down.
    throw new AppUnavailableError(
      `Could not reach the Fal Forge app at ${ep.baseUrl} (${err instanceof Error ? err.message : String(err)}).`,
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data: unknown = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg =
      (data && typeof data === "object" && "error" in data && typeof (data as { error: unknown }).error === "string"
        ? (data as { error: string }).error
        : undefined) || `HTTP ${res.status}`;
    const e = new Error(msg) as Error & { status?: number };
    e.status = res.status;
    throw e;
  }
  return data;
}

// ---------------------------------------------------------------------------
// Tool schema discovery (live, with an embedded fallback so tools still list
// when the app isn't running yet)
// ---------------------------------------------------------------------------

const EMBEDDED_TOOLS: Tool[] = [
  {
    name: "generate_media",
    description:
      "Generate an image or video from a text prompt (optionally with reference image URLs). Blocks until the result is ready and returns its URL; the result also lands on the Fal Forge canvas. Connect the running Fal Forge app for the full, tuned schema.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["image", "video"], description: "What to generate." },
        prompt: { type: "string", description: "The generation prompt." },
        tier: { type: "string", enum: ["quick", "standard", "pro"], description: "Quality/speed tier; picks the model." },
        model: { type: "string", description: "Explicit model key (overrides tier)." },
        aspectRatio: { type: "string", description: "e.g. \"1:1\", \"16:9\", \"9:16\"." },
        resolution: { type: "string", description: "e.g. \"1080p\" (video)." },
        durationSeconds: { type: "number", description: "Video length in seconds." },
        referenceUrls: {
          type: "array",
          items: { type: "string" },
          description: "Up to 4 reference image URLs (http(s)).",
        },
      },
      required: ["kind", "prompt"],
    },
  },
  {
    name: "generate_music",
    description:
      "Generate music/audio from a prompt (and optional lyrics). Blocks until ready and returns the audio URL. Connect the running Fal Forge app for the full schema.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Description / style of the music." },
        lyrics: { type: "string", description: "Optional lyrics." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "transform_media",
    description:
      "Transform an existing image by URL (edit / upscale / background-remove / etc.). Requires a reference image URL in referenceUrls. Blocks until ready and returns the result URL. Connect the running Fal Forge app for the full schema.",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", description: "The transform to apply (e.g. edit, upscale, remove_background)." },
        prompt: { type: "string", description: "Instruction for edit-style operations." },
        referenceUrls: {
          type: "array",
          items: { type: "string" },
          description: "Exactly one source image URL (http(s)).",
        },
      },
      required: ["operation", "referenceUrls"],
    },
  },
];

/** Read-only tools served entirely by the MCP server (they hit dedicated app
 *  endpoints, not /api/agent/tools). Let Claude see the canvas + available models
 *  so it can target existing assets as references. */
const READ_TOOLS: Tool[] = [
  {
    name: "list_models",
    description: "List the generation models available in Matteblack and their media type (image/video/audio). Use to self-document what can be generated.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_canvas",
    description:
      "List recent completed generations on the Fal Forge canvas (most recent first) with their id, media type, model, result URL, and prompt. Pass a returned `url` back in `referenceUrls` of generate_media/transform_media to iterate on it.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max results (1–50, default 20)." },
        workspace_id: { type: "string", description: "Optional workspace to scope to." },
        canvas_id: { type: "string", description: "Optional canvas id (resolves to its workspace)." },
      },
    },
  },
  {
    name: "get_asset",
    description:
      "Fetch one asset by id (from list_canvas). Returns its metadata and, for images, an inline thumbnail so you can see the result and decide next steps.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The asset/job id." } },
      required: ["id"],
    },
  },
  {
    name: "estimate_cost",
    description:
      "What a generation would cost in USD — fal.ai's actual price, no markup, since the user pays fal directly with their own key. Omit `model` to price every model at once and recommend the cheapest that fits. Call this before an expensive generation (video especially: clips range from a few cents to several dollars) or whenever the user asks what something costs.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "Model key (from list_models). Omit to price the whole catalog." },
        duration: { type: "number", description: "Output length in seconds, for video/audio." },
        resolution: { type: "string", description: 'Resolution token, e.g. "1k", "2k", "720p", "1080p".' },
        features: {
          type: "array",
          items: { type: "string" },
          description: 'Feature flags that change the price, e.g. ["generate_audio"].',
        },
        quantity: { type: "number", description: "Number of outputs (default 1)." },
        characters: { type: "number", description: "Character count, for text-to-speech." },
      },
    },
  },
];

interface LiveToolDef {
  name: string;
  description?: string;
  inputSchema?: Tool["inputSchema"];
}

/** Adapt a generation tool's schema for THIS transport: the in-app schema attaches
 *  references via `referenceImageIds` (an in-app 'canvas:N' catalog that doesn't
 *  exist over the bridge), so advertise `referenceUrls` — the field the bridge
 *  actually resolves — as the way to attach references. */
function adaptForBridge(tool: Tool): Tool {
  if (tool.name !== "generate_media" && tool.name !== "transform_media") return tool;
  const schema = (tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object" }) as {
    type: "object";
    properties?: Record<string, object>;
    required?: string[];
  };
  const isTransform = tool.name === "transform_media";
  const props: Record<string, object> = { ...(schema.properties ?? {}) };
  props.referenceUrls = {
    type: "array",
    items: { type: "string" },
    maxItems: 4,
    description:
      "Reference image URL(s), http(s). Over this bridge, attach references by URL here (get URLs from list_canvas / get_asset) — NOT via referenceImageIds." +
      (isTransform ? " REQUIRED: the single source image to transform." : ""),
  };
  return { ...tool, inputSchema: { ...schema, properties: props } as Tool["inputSchema"] };
}

/** Fetch the live tool schemas from the app; fall back to the embedded copy so
 *  Claude always sees the three tools even before the app is open. */
async function listTools(): Promise<Tool[]> {
  const ep = readEndpoint();
  if (!ep) return [...EMBEDDED_TOOLS.map(adaptForBridge), ...READ_TOOLS];
  try {
    const data = (await httpJson(ep, "GET", "/api/agent/tools", undefined, 4000)) as { tools?: LiveToolDef[] };
    const live = Array.isArray(data?.tools) ? data.tools : [];
    const gen: Tool[] = live.length === 0
      ? EMBEDDED_TOOLS
      : live.map((t) => ({
          name: t.name,
          description: t.description ?? "",
          inputSchema: (t.inputSchema as Tool["inputSchema"]) ?? { type: "object" as const },
        }));
    return [...gen.map(adaptForBridge), ...READ_TOOLS];
  } catch (err) {
    logErr("live tool discovery failed, using embedded schemas:", err instanceof Error ? err.message : err);
    return [...EMBEDDED_TOOLS.map(adaptForBridge), ...READ_TOOLS];
  }
}

// ---------------------------------------------------------------------------
// Job dispatch + block-and-poll
// ---------------------------------------------------------------------------

interface JobRow {
  job_id?: string;
  id?: string;
  status?: string;
  progress?: number;
  result_url?: string | null;
  error?: string | null;
  error_type?: string | null;
  type?: string;
  model?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Pull any caller-supplied reference URLs out of the tool arguments so they can
 *  be passed at the top level of /api/agent/tool (the endpoint resolves refs as
 *  URLs; canvas-id resolution arrives in J3's canvas tools). */
function extractReferenceUrls(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ["referenceUrls", "referenceImageUrls", "imageUrls"]) {
    const v = args[key];
    if (Array.isArray(v)) {
      for (const u of v) if (typeof u === "string" && /^https?:\/\//i.test(u)) out.push(u);
    }
  }
  // Single-URL convenience fields.
  for (const key of ["imageUrl", "image_url", "referenceUrl"]) {
    const v = args[key];
    if (typeof v === "string" && /^https?:\/\//i.test(v)) out.push(v);
  }
  return out.slice(0, 4);
}

type ProgressFn = (progress: number, message: string) => void;

async function pollToCompletion(ep: Endpoint, jobId: string, onProgress?: ProgressFn): Promise<JobRow> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  // The job row can briefly 404 immediately after dispatch; tolerate a few.
  let notFound = 0;
  let transient = 0;
  while (Date.now() < deadline) {
    // Fetch is fallible (network / transient app errors) — retry those. Status
    // interpretation lives OUTSIDE the catch so a terminal "failed" propagates
    // instead of being mistaken for a network blip and retried forever.
    let job: JobRow;
    try {
      job = (await httpJson(ep, "GET", `/api/job/${jobId}`, undefined, 15000)) as JobRow;
    } catch (err) {
      if (err instanceof AppUnavailableError) throw err;
      const status = (err as { status?: number }).status;
      if (status === 404) {
        if (++notFound > 5) throw new Error(`Job ${jobId} not found.`);
      } else if (++transient > 5) {
        throw err;
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    notFound = 0;
    transient = 0;
    // Terminal success — the app marks finished jobs 'complete' (also accept
    // 'completed'/'succeeded' defensively). Anything else terminal is a failure.
    if (job.status === "complete" || job.status === "completed" || job.status === "succeeded") return job;
    if (job.status === "failed" || job.status === "cancelled" || job.status === "canceled") {
      throw new Error(job.error || job.error_type || `Generation ${job.status}.`);
    }
    // queued / processing → report progress (this resets the MCP client's request
    // timeout, so long video/image jobs don't get cut off at the default ~60s).
    onProgress?.(typeof job.progress === "number" ? job.progress : 0, job.status || "processing");
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `Timed out after ${Math.round(POLL_TIMEOUT_MS / 1000)}s waiting for job ${jobId}. It may still be running in the app.`,
  );
}

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}
function fail(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

async function runTool(
  name: string,
  args: Record<string, unknown>,
  onProgress?: ProgressFn,
): Promise<CallToolResult> {
  const ep = readEndpoint();
  if (!ep) {
    return fail(
      "The Fal Forge app isn't running (no endpoint published). Open the Matteblack desktop app, then try again.",
    );
  }

  const referenceUrls = extractReferenceUrls(args);
  // Send the tool args through as `input`; the app's parse*/build* functions read
  // exactly the fields they expect. referenceUrls are lifted to the top level.
  const payload = { tool: name, input: args, referenceUrls };

  let dispatch: { jobId?: string; type?: string; model?: string; canvasId?: string };
  try {
    dispatch = (await httpJson(ep, "POST", "/api/agent/tool", payload, 30000)) as typeof dispatch;
  } catch (err) {
    if (err instanceof AppUnavailableError) return fail(err.message + " Is the Fal Forge app still open?");
    return fail(`Couldn't start the generation: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!dispatch?.jobId) {
    return fail("The app accepted the request but returned no job id.");
  }

  let job: JobRow;
  try {
    job = await pollToCompletion(ep, dispatch.jobId, onProgress);
  } catch (err) {
    if (err instanceof AppUnavailableError) return fail(err.message + " Is the Fal Forge app still open?");
    return fail(`Generation did not complete: ${err instanceof Error ? err.message : String(err)}`);
  }

  const url = job.result_url || "(no url returned)";
  const lines = [
    `✅ ${dispatch.type ?? name} complete.`,
    `Model: ${dispatch.model ?? job.model ?? "unknown"}`,
    `Result: ${url}`,
  ];
  if (dispatch.canvasId) lines.push(`Placed on canvas: ${dispatch.canvasId}`);
  lines.push("", "The result is on the Fal Forge canvas. (Thumbnails back to Claude arrive in a later phase.)");
  return ok(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Read tools (list_models / list_canvas / get_asset)
// ---------------------------------------------------------------------------

const NOT_RUNNING =
  "The Fal Forge app isn't running (no endpoint published). Open the Matteblack desktop app, then try again.";

function errToFail(err: unknown): CallToolResult {
  if (err instanceof AppUnavailableError) return fail(err.message + " Is the Fal Forge app still open?");
  return fail(err instanceof Error ? err.message : String(err));
}

async function runListModels(): Promise<CallToolResult> {
  const ep = readEndpoint();
  if (!ep) return fail(NOT_RUNNING);
  try {
    const data = (await httpJson(ep, "GET", "/api/agent/models")) as { models?: { key: string; type: string }[] };
    const models = data.models ?? [];
    if (models.length === 0) return ok("No models reported by the app.");
    const groups: Record<string, string[]> = {};
    for (const m of models) (groups[m.type] ??= []).push(m.key);
    const lines = ["Available generation models:"];
    for (const [type, keys] of Object.entries(groups)) lines.push(`\n${type}:\n  ${keys.join(", ")}`);
    return ok(lines.join("\n"));
  } catch (err) {
    return errToFail(err);
  }
}

interface AssetRow {
  id: string;
  type: string;
  model: string;
  url: string;
  prompt?: string;
  createdAt?: string;
}

async function runListCanvas(args: Record<string, unknown>): Promise<CallToolResult> {
  const ep = readEndpoint();
  if (!ep) return fail(NOT_RUNNING);
  const qs = new URLSearchParams();
  if (typeof args.limit === "number") qs.set("limit", String(args.limit));
  if (typeof args.workspace_id === "string") qs.set("workspace_id", args.workspace_id);
  if (typeof args.canvas_id === "string") qs.set("canvas_id", args.canvas_id);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  try {
    const data = (await httpJson(ep, "GET", `/api/agent/assets${suffix}`)) as { assets?: AssetRow[] };
    const assets = data.assets ?? [];
    if (assets.length === 0) return ok("No generations on the canvas yet.");
    const lines = [`${assets.length} recent generation(s) (most recent first):`, ""];
    for (const a of assets) {
      const p = a.prompt ? ` — "${a.prompt.slice(0, 80)}${a.prompt.length > 80 ? "…" : ""}"` : "";
      lines.push(`• [${a.type}] ${a.id}${p}`);
      lines.push(`  model: ${a.model}  url: ${a.url}`);
    }
    lines.push("", "Pass a url in `referenceUrls` to iterate on it, or call get_asset with an id to view it.");
    return ok(lines.join("\n"));
  } catch (err) {
    return errToFail(err);
  }
}

/** Loopback-fetch an image and return it as an inline MCP image block (the MCP
 *  server can reach loopback URLs that the Claude client cannot). Returns null if
 *  not an image, unreachable, or too large to inline. */
async function fetchThumbnail(ep: Endpoint, url: string): Promise<{ data: string; mimeType: string } | null> {
  const target = /^https?:\/\//i.test(url) ? url : `${ep.baseUrl}${url.startsWith("/") ? "" : "/"}${url}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(target, { headers: { "x-matteblack-token": ep.token ?? "" }, signal: ctrl.signal });
    if (!res.ok) return null;
    const mimeType = res.headers.get("content-type") || "image/png";
    if (!mimeType.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > 1_500_000) return null; // too large to inline; leave the url
    return { data: buf.toString("base64"), mimeType };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function runGetAsset(args: Record<string, unknown>): Promise<CallToolResult> {
  const ep = readEndpoint();
  if (!ep) return fail(NOT_RUNNING);
  const id = typeof args.id === "string" ? args.id : "";
  if (!id) return fail("get_asset requires an `id`.");
  try {
    const a = (await httpJson(ep, "GET", `/api/agent/asset/${encodeURIComponent(id)}`)) as AssetRow & {
      status?: string;
      error?: string | null;
    };
    const meta = [
      `Asset ${a.id}`,
      `type: ${a.type}`,
      `model: ${a.model}`,
      a.status ? `status: ${a.status}` : "",
      a.prompt ? `prompt: ${a.prompt}` : "",
      `url: ${a.url ?? "(none)"}`,
    ].filter(Boolean).join("\n");

    const content: CallToolResult["content"] = [{ type: "text", text: meta }];
    // Job types are e.g. "text_to_image"/"image_to_image" (not "image"); embed a
    // thumbnail whenever the type or url looks like an image. fetchThumbnail
    // self-guards on the response content-type + a size cap, so this is safe even
    // if the guess is wrong (video/audio → returns null, no huge download).
    const looksImage = /image/i.test(a.type ?? "") || /\.(png|jpe?g|webp|gif|bmp|avif)(\?|$)/i.test(a.url ?? "");
    if (looksImage && a.url) {
      const thumb = await fetchThumbnail(ep, a.url);
      if (thumb) content.push({ type: "image", data: thumb.data, mimeType: thumb.mimeType });
    }
    return { content };
  } catch (err) {
    return errToFail(err);
  }
}

interface CostRow {
  model: string;
  usd: number;
  accuracy: "exact" | "approx";
  basis: string;
}

async function runEstimateCost(args: Record<string, unknown>): Promise<CallToolResult> {
  const ep = readEndpoint();
  if (!ep) return fail(NOT_RUNNING);
  try {
    const data = (await httpJson(ep, "POST", "/api/agent/cost", args)) as { estimates?: CostRow[] };
    const rows = data.estimates ?? [];
    if (rows.length === 0) return ok("No fal pricing available for that model.");
    const money = (usd: number) => (usd < 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`);

    if (rows.length === 1) {
      const r = rows[0];
      const tilde = r.accuracy === "approx" ? "about " : "";
      return ok(`${r.model}: ${tilde}${money(r.usd)} — ${r.basis}\n\nThis is fal.ai's price at cost; the user pays it directly from their own fal balance.`);
    }

    const sorted = [...rows].sort((a, b) => a.usd - b.usd);
    const lines = [
      `Cost for these parameters across ${sorted.length} models, cheapest first (fal.ai's price at cost — the user pays it directly):`,
      "",
    ];
    for (const r of sorted) {
      lines.push(`• ${r.model}: ${r.accuracy === "approx" ? "~" : ""}${money(r.usd)} (${r.basis})`);
    }
    lines.push("", "Prices for models whose parameters you didn't supply assume defaults, so compare like with like.");
    return ok(lines.join("\n"));
  } catch (err) {
    return errToFail(err);
  }
}

// ---------------------------------------------------------------------------
// Server wiring
// ---------------------------------------------------------------------------

const INSTRUCTIONS = [
  "Matteblack generates images, video, and music locally using the user's own fal.ai key; every result lands on the user's Fal Forge canvas (a separate window they keep open beside this chat).",
  "",
  "TOOLS: `generate_media` (image or short video), `generate_music` (audio), `transform_media` (edit / upscale / remove-background / resize an existing image). Read tools: `list_canvas` (recent generations + their URLs), `get_asset` (one asset's metadata + an inline image thumbnail), `list_models` (what's installed), `estimate_cost` (what a generation costs in USD).",
  "",
  "COST: the user pays fal.ai directly with their own key, so prices are real money, at cost, and vary hugely — a sound effect is under a cent, a 5s 1080p Seedance clip is over three dollars. Check `estimate_cost` before anything expensive (any video, or a large batch), state the figure, and get a yes before spending. Quote the number plainly ('about $3.40'); don't editorialise about it.",
  "",
  "BLOCKING & ORCHESTRATION: the generation tools run synchronously — each call waits for the job to finish and returns the result URL. Multi-step work is yours to drive: to make N variations, call `generate_media` N times; to iterate, generate then inspect with `get_asset` then generate again. There is no batching or status-line protocol to follow here — just call the tools.",
  "",
  "REFERENCES (important — differs from the in-app UI): to build on or edit an existing asset, first get its URL from `list_canvas` (or `get_asset`), then pass that URL in `referenceUrls`. Do NOT use `referenceImageIds` or 'canvas:N' / 'agent:N' ids — that catalog belongs to the in-app panel and is not available over this bridge. `transform_media` REQUIRES a source image URL in `referenceUrls`.",
  "",
  "MODEL/TIER: omit `model` and let `tier` choose — 'premium' (best, default), 'quality' (mid), 'quick' (cheap/fast, use only when the user asks for cheap/draft/fast/'save credits'). Set `model` only when the user names one explicitly.",
  "VIDEO references: when attaching a reference to a video, also set `videoReferenceMode` (first_frame / first_last_frame / references). If the user hasn't made the intended mode clear, ask before generating rather than guessing.",
  "ASPECT: default 1:1 unless the subject implies otherwise (e.g. wallpaper → 16:9, phone screen → 9:16).",
  "",
  "FORWARD FAITHFULLY: pass creative requests through as written. The fal.ai providers run their own moderation and return a clear error if something is disallowed, so don't pre-refuse or add disclaimers for ordinary creative work (real people, brands, styles, mature themes are all fine to attempt).",
  "",
  "The Matteblack desktop app must be open. If a tool reports it can't reach the app, ask the user to open it.",
].join("\n");

async function main(): Promise<void> {
  const server = new Server(
    { name: "falforge", version: "0.1.0" },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await listTools() }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    // Read tools first (no job dispatch / progress).
    if (name === "list_models") return runListModels();
    if (name === "list_canvas") return runListCanvas(args);
    if (name === "get_asset") return runGetAsset(args);
    if (name === "estimate_cost") return runEstimateCost(args);
    if (name !== "generate_media" && name !== "generate_music" && name !== "transform_media") {
      return fail(`Unknown tool: ${name}`);
    }
    // If the client passed a progress token, stream progress during the block-and-
    // poll. Emitting progress resets the client's per-request timeout, so long
    // (video / high-res) generations don't get cut off at the client default.
    const progressToken = req.params._meta?.progressToken;
    const onProgress: ProgressFn | undefined =
      progressToken === undefined
        ? undefined
        : (progress, message) => {
            extra.sendNotification({
              method: "notifications/progress",
              params: { progressToken, progress, message },
            }).catch((e) => logErr("progress notification failed:", e));
          };
    return runTool(name, args, onProgress);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logErr(`ready (endpoint file: ${ENDPOINT_FILE})`);
}

main().catch((err) => {
  logErr("fatal:", err);
  process.exit(1);
});
