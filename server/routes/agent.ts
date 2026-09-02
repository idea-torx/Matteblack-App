import { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  ImageBlockParam,
  TextBlockParam,
  Tool,
  ToolUnion,
  ToolUseBlock,
  WebSearchTool20250305,
} from "@anthropic-ai/sdk/resources/messages.js";
import { requireAuth, requireVerifiedEmail, type AuthRequest } from "../sessions.js";
import { checkAndDebit, refundCreditsWithFallback, reserveAgentCredits, settleAgentCredits } from "../credits/creditGate.js";
import { v4 as uuidv4 } from "uuid";
import { pool } from "../db.js";
import probe from "probe-image-size";
import fs from "node:fs";
import { UPLOADS_DIR } from "../config/runtime.js";
import { resolveUploadPath } from "../utils/uploadPath.js";
import { getAnthropicKey } from "../config/userConfig.js";
import { listAvailableModels } from "../fal.js";
import { readCustomModel } from "../models/customModels.js";
import { estimateFalCost, falPricedModelKeys } from "../config/falCost.js";
import { unitPriceFor, falPricingStatus } from "../services/falPricing.js";
import { getMcpToken } from "../mcpToken.js";
import { broadcastCanvasUpdate } from "./canvas.js";
import { setNodes as redisSetNodes, type RedisNodeUpdate } from "../services/canvasRedisCache.js";
import { scheduleCanvasFlush } from "../services/canvasCheckpointScheduler.js";
import redisClient from "../services/redisClient.js";
import type { Response, NextFunction } from "express";
import { placeNext, placeholderSize, fallbackViewport, type Rect } from "../utils/canvasPlacement.js";
import { extractLastFrame, extractTailClip, probeMinDimension, VideoTailError, DEFAULT_TAIL_SECONDS } from "../utils/videoTail.js";
import { getOperatorContext, noteOperatorJob } from "../services/operatorCanvasContext.js";
import crypto from "node:crypto";
import { getPresenceTransport } from "./canvas.js";
import {
  addSession as presenceAddSession,
  removeSession as presenceRemoveSession,
  setCursor as presenceSetCursor,
} from "../services/presence/PresenceRegistry.js";
import {
  broadcastPresenceCursor,
  broadcastPresenceJoin,
  broadcastPresenceLeave,
} from "../services/presence/presenceBroadcast.js";

const router = Router();

/**
 * Gate the MCP-only endpoints (Phase J3). The stdio MCP server sends the per-boot
 * token (from the discovery file) as `x-matteblack-token`; we validate it against
 * the value stashed by the server on startup so other local processes can't drive
 * the app. LOCAL_MODE auth already treats any loopback call as the local
 * superadmin, so this token is the actual access control for these routes.
 * Escape hatch: MB_MCP_NO_TOKEN=1 disables the check (debugging only).
 */
function requireMcpToken(req: AuthRequest, res: Response, next: NextFunction): void {
  if (process.env.MB_MCP_NO_TOKEN === "1") { next(); return; }
  const expected = getMcpToken();
  if (!expected) {
    res.status(503).json({ error: "MCP bridge not ready (no token published yet)." });
    return;
  }
  const provided = req.header("x-matteblack-token");
  if (!provided || provided !== expected) {
    res.status(401).json({ error: "Invalid or missing MCP token." });
    return;
  }
  next();
}

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const CLAUDE_MODELS: Record<string, { id: string; pricingKey: string; label: string; inputTokenLimit: number; tokenBilled?: boolean }> = {
  sonnet: {
    id: process.env.ANTHROPIC_SONNET_MODEL || "claude-sonnet-4-6",
    pricingKey: "claude-sonnet",
    label: "Claude Sonnet 4.6",
    inputTokenLimit: 200_000,
    // Sonnet is billed against the real Anthropic input/output token counts
    // returned at the end of the stream, plus a 25% platform margin. Haiku
    // and Opus stay on the legacy character-based price column until we
    // have rate data to migrate them too.
    tokenBilled: true,
  },
  haiku: {
    id: process.env.ANTHROPIC_HAIKU_MODEL || "claude-haiku-4-5",
    pricingKey: "claude-haiku",
    label: "Claude Haiku 4.5",
    inputTokenLimit: 200_000,
  },
};

// Conservative chars→tokens ratio used only for the up-front reservation
// estimate. Real tokenization runs at ~3.5–4 chars/token for English; we
// pick 3 to slightly *over*-estimate, which means the reservation almost
// always covers the actual debit and the user only ever sees a refund of
// the unused portion (never a surprise extra charge at settlement time).
const RESERVATION_CHARS_PER_TOKEN = 3;
// Flat overhead added to every reservation to cover the system prompt,
// tool schemas, and per-image vision tokens that aren't visible from the
// raw character count of the user's messages alone. Lowered from 4000 →
// 1800 because (a) the static system prefix + tools block is now prompt-
// cached so subsequent turns see ~0 fresh tokens for it, and (b) the
// per-image overhead was over-estimating once we stripped stale vision
// blocks from old turns. Settlement uses real Anthropic usage so this
// only affects the upfront *reservation* hold, not what the user is
// charged.
const RESERVATION_TOKEN_OVERHEAD_BASE = 1800;
const RESERVATION_TOKENS_PER_IMAGE = 1300;

// Only the most recent N user turns retain their image blocks in the
// outgoing Anthropic payload. Older user turns keep their text but the
// image blocks are replaced with a short text marker — the single
// biggest token saver for image-heavy chats. The references the
// generator actually needs are independently surfaced via the reference
// catalog (canvas:N / agent:N / brand:* / product:*).
const RETAIN_IMAGES_LAST_N_USER = 2;

// Soft sliding window: when the estimated input-token total exceeds this
// threshold, drop the oldest user+assistant pairs (preserving the very
// first user turn so the conversation context stays coherent) until the
// total falls back under the threshold or only the first turn + the most
// recent two pairs remain. The 40-message hard cap above is still in
// force.
const SLIDING_WINDOW_TOKEN_THRESHOLD = 30_000;

// Cap the reference catalog surfaced in the system prompt to the most
// recent K entries. Brand / product / pinned ids are always preserved
// even past the cap so explicitly-pinned references stay resolvable.
const REFERENCE_CATALOG_CAP = 12;

// Music intent keywords: only when the conversation looks music-shaped
// do we surface the GENERATE_MUSIC_TOOL to Claude. This trims a few
// hundred tokens off the average image-only turn.
const MUSIC_INTENT_RE = /\b(song|songs|track|tracks|music|musical|beat|beats|jingle|anthem|soundtrack|melody|melodies|lyric|lyrics|instrumental|tune|tunes|score|composition|compose|bpm|chorus|verse|hook|jingle|edm|hip[\s-]?hop|techno|house\s+music|lo[\s-]?fi)\b/i;

// Same idea for the voiceover tool: a turn that says nothing about speech
// doesn't pay for its schema. Deliberately narrower than the music regex —
// "voice", "read" and "line" are common enough words that matching them alone
// would surface the tool on most turns.
const VOICEOVER_INTENT_RE = /\b(voice[\s-]?over|voiceover|vo\s+(?:line|track|script)|narrat(?:e|es|ed|ing|ion|or)|narration|speak|speaks|spoken|say\s+it|read\s+(?:this|it|out|aloud)|aloud|dialogue|monologue|announcer|text[\s-]?to[\s-]?speech|tts|speech)\b/i;

const DEFAULT_MODEL_KEY = "haiku";

const MAX_INPUT_CHARS = 60_000;
const MAX_IMAGES = 8;
// Bumped from 8192 → 32768. Heavy batch turns ("5 video clips", "10 logo
// variations") emit one tool_use block per item, and each tool_use block
// — especially video, with long prompts and reference id arrays — eats a
// surprising amount of output budget on top of any narration. At 8K we
// were hitting the ceiling mid-batch, the model would stop after ~1
// tool_use block, and the turn looked like the multi-call rule was being
// ignored when really we were just truncating it. Sonnet 4.6 supports up
// to 64K output tokens; 32K gives us comfortable headroom for a full
// 20-call batch (the per-turn cap below) without risking pathological
// runaway cost on a normal chat-style turn. Token-cost accounting
// downstream uses Anthropic's actual reported output_tokens, so the
// higher ceiling only matters if the model genuinely emits that much.
const MAX_OUTPUT_TOKENS = 32768;
// Per-turn cap on locally-dispatched generation tool calls
// (generate_media / transform_media / generate_music). Bumped from 5 →
// 20 so power users can ask the agent for a full grid in one shot
// ("12 thumbnails, 3 variants each = 36" still has to be split, but
// "give me 10 logo ideas" works in a single turn). Keep a hard ceiling
// because each call hits a paid backend and a runaway loop would drain
// credits silently. The web_search server tool is NOT counted against
// this cap — it's free of credit cost and capped separately by
// max_uses on the tool definition.
const MAX_GENERATIONS_PER_TURN = 20;
// Per-turn cap on Anthropic's server-side web_search tool. Each search
// is billed by Anthropic (currently $10/1k searches) and we don't want
// a single chat turn to fan out indefinitely. 5 is generous for normal
// research-style asks ("look up the latest specs for X").
const MAX_WEB_SEARCHES_PER_TURN = 5;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TITLE_LENGTH = 120;
// Threshold (fraction of the model's input window) at which we tell the
// client to surface a "start a new chat" suggestion. 0.75 = 150K of 200K.
const CONTEXT_WARN_FRACTION = 0.75;
const CONTEXT_CRITICAL_FRACTION = 0.9;

// Lazily build (and cache) the Anthropic client from the currently-effective
// key, which may be user-supplied at runtime via Settings (userConfig) or come
// from ANTHROPIC_API_KEY. Rebuilds only when the key value changes.
let _anthropicClient: Anthropic | null = null;
let _anthropicClientKey: string | undefined;
function getAnthropicClient(): Anthropic | null {
  const key = getAnthropicKey();
  if (!key) return null;
  if (_anthropicClient && _anthropicClientKey === key) return _anthropicClient;
  _anthropicClient = new Anthropic({ apiKey: key });
  _anthropicClientKey = key;
  return _anthropicClient;
}

/**
 * Map an Anthropic SDK error (or anything else thrown by the chat path)
 * to a short, user-friendly sentence. The SDK's APIError stuffs the raw
 * upstream JSON into `.message`, which is what was leaking to the chat
 * bubble (e.g. `{"type":"error","error":{"type":"overloaded_error",...}}`).
 *
 * We sniff a few well-known shapes:
 *   - Anthropic APIError with `.status` and `.error.type`
 *   - Plain Error whose `.message` parses as the JSON envelope above
 *   - Network errors (ECONNRESET, fetch failed)
 * and fall back to the generic message for anything else so we never
 * surface raw JSON or stack traces to the user.
 */
function friendlyAnthropicError(err: unknown): string {
  // Try to pull a structured Anthropic error type from either the SDK's
  // APIError shape or the JSON body the SDK sometimes serializes into
  // `.message`.
  let upstreamType: string | undefined;
  let httpStatus: number | undefined;
  if (err && typeof err === "object") {
    const e = err as { status?: number; type?: string; error?: { type?: string; error?: { type?: string } }; message?: unknown };
    if (typeof e.status === "number") httpStatus = e.status;
    // Anthropic's SDK surfaces the leaf error type at `.type` on the
    // APIError itself (e.g. "overloaded_error"). The wrapped body
    // shape is `{ type: "error", error: { type: "overloaded_error" } }`,
    // where `e.error.type` is the literal string "error" — not useful.
    // Pick the leaf type from `.type` first, then the nested
    // `error.error.type`, and only fall back to `error.type` if the
    // wrapper-vs-leaf distinction is missing.
    upstreamType = e.type ?? e.error?.error?.type ?? e.error?.type;
    if ((!upstreamType || upstreamType === "error") && typeof e.message === "string") {
      const trimmed = e.message.trim();
      // SDK error messages sometimes prefix the body with the status,
      // e.g. `529 {"type":"error",...}`. Strip the prefix before parsing.
      const jsonStart = trimmed.indexOf("{");
      if (jsonStart >= 0) {
        try {
          const parsed = JSON.parse(trimmed.slice(jsonStart)) as
            | { error?: { type?: string } }
            | undefined;
          upstreamType = parsed?.error?.type;
        } catch { /* fall through to generic */ }
      }
    }
  }

  switch (upstreamType) {
    case "overloaded_error":
      return "The chat model is overloaded right now. Give it a few seconds and try again.";
    case "rate_limit_error":
      return "You've hit the chat model's rate limit. Wait a moment and try again.";
    case "api_error":
      return "The chat model had a temporary problem. Try again in a moment.";
    case "authentication_error":
    case "permission_error":
      return "The chat model rejected the request. This is a server-side configuration issue — please report it.";
    case "invalid_request_error":
      return "That request couldn't be processed. Try rephrasing or shortening your message.";
    case "not_found_error":
      return "The chat model couldn't be reached. Try again in a moment.";
    case "timeout_error":
      return "The chat model took too long to respond. Try again — usually faster on the second try.";
    case "billing_error":
      return "The chat model rejected the request for a billing reason. This is a server-side issue — please report it.";
  }

  if (httpStatus === 529 || httpStatus === 503) {
    return "The chat model is overloaded right now. Give it a few seconds and try again.";
  }
  if (httpStatus === 429) {
    return "You've hit the chat model's rate limit. Wait a moment and try again.";
  }
  if (httpStatus && httpStatus >= 500) {
    return "The chat model had a temporary problem. Try again in a moment.";
  }

  // Network / connection errors from undici/fetch don't have a status.
  // Anthropic's APIConnectionError / APIConnectionTimeoutError surface
  // generic messages like "Connection error." or "Request timed out."
  // and stash the underlying socket code on `err.cause.code`.
  if (err instanceof Error) {
    const m = err.message;
    if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|network|connection error|request timed out|timeout/i.test(m)) {
      return "Couldn't reach the chat model. Check your connection and try again.";
    }
    const cause = (err as { cause?: { code?: unknown } }).cause;
    const causeCode = typeof cause?.code === "string" ? cause.code : null;
    if (causeCode && /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_SOCKET/i.test(causeCode)) {
      return "Couldn't reach the chat model. Check your connection and try again.";
    }
  }

  return "Something went wrong talking to the chat model. Try again in a moment.";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function normalizeModelKey(value: unknown): string {
  if (typeof value === "string" && CLAUDE_MODELS[value]) return value;
  // Migrate legacy 'opus' references to 'sonnet'.
  if (value === "opus") return "sonnet";
  return DEFAULT_MODEL_KEY;
}

// Confirms the authenticated user is a member of the given workspace.
// Returns true when workspaceId is null/undefined (no scoping requested).
async function userHasWorkspaceAccess(userId: string, workspaceId: string | null | undefined): Promise<boolean> {
  if (!workspaceId) return true;
  if (!isUuid(workspaceId)) return false;
  try {
    const r = await pool.query(
      `SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 LIMIT 1`,
      [workspaceId, userId]
    );
    return r.rows.length > 0;
  } catch {
    return false;
  }
}

function deriveTitleFromText(text: string): string {
  const trimmed = (text || "").trim().replace(/\s+/g, " ");
  if (!trimmed) return "New chat";
  return trimmed.length > 60 ? trimmed.slice(0, 60).trim() + "…" : trimmed;
}

// Public: reports whether the platform-wide ANTHROPIC_API_KEY is configured.
router.get("/api/agent/status", async (_req, res) => {
  res.json({
    available: !!getAnthropicClient(),
    models: Object.entries(CLAUDE_MODELS).map(([key, m]) => ({
      key,
      label: m.label,
      inputTokenLimit: m.inputTokenLimit,
    })),
    defaultModelKey: DEFAULT_MODEL_KEY,
    contextWarnFraction: CONTEXT_WARN_FRACTION,
    contextCriticalFraction: CONTEXT_CRITICAL_FRACTION,
  });
});

// ---------- Chat history endpoints ----------

// Stored image rows on agent_chat_messages.images carry both legacy
// "attachment" entries (canvas references the user attached to a message) and
// new "agent" entries (inline generations the agent fired via generate_media).
// Legacy rows have only url+label and default to source: "attachment".
type StoredImage = {
  url: string;
  label?: string;
  source?: "attachment" | "agent";
  kind?: "image" | "video" | "music";
  trayItemId?: string;
  jobId?: string;
  // Canvas the agent dispatched the generation into. Persisted so reload
  // restores polling/cancel targeting when the server lazy-resolved a canvas
  // (e.g. mobile sessions with no active canvas).
  trayCanvasId?: string;
  model?: string;
  quality?: string;
  resolution?: string;
  aspectRatio?: string;
  tier?: "premium" | "quality" | "quick";
  status?: "pending" | "generating" | "ready" | "failed";
  // Where this generation was dispatched — "on_canvas" causes the chat to
  // render the slim grey/blue chip variant on reload instead of the regular
  // inline media card. Defaults to "in_chat" client-side when missing so
  // legacy rows render unchanged.
  outputMode?: "in_chat" | "on_canvas";
  // The canvas node id the generation was placed into. Persisted so the chip's
  // "click to focus" behavior survives a page reload. Stored as a string only
  // (the client tolerates `null` separately for "not yet placed").
  canvasNodeId?: string;
};

type StoredMessage = {
  id: string;
  role: "user" | "assistant" | "error";
  text: string;
  images?: StoredImage[];
};

function sanitizeImages(input: unknown): StoredImage[] {
  if (!Array.isArray(input)) return [];
  const out: StoredImage[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const url = typeof r.url === "string" ? r.url : "";
    // Agent-source rows are allowed to have an empty URL while the underlying
    // job is still in flight, as long as we have a tray id (or job id) to
    // resume polling on reload. All other rows require a non-empty URL.
    const hasTrayRef =
      (typeof r.trayItemId === "string" && r.trayItemId.length > 0) ||
      (typeof r.jobId === "string" && r.jobId.length > 0);
    const isAgentRow = r.source === "agent";
    if (!url && !(isAgentRow && hasTrayRef)) continue;
    const item: StoredImage = { url };
    if (typeof r.label === "string") item.label = r.label;
    if (r.source === "attachment" || r.source === "agent") item.source = r.source;
    if (r.kind === "image" || r.kind === "video" || r.kind === "music") item.kind = r.kind;
    if (typeof r.trayItemId === "string") item.trayItemId = r.trayItemId;
    if (typeof r.jobId === "string") item.jobId = r.jobId;
    if (typeof r.trayCanvasId === "string") item.trayCanvasId = r.trayCanvasId;
    if (typeof r.model === "string") item.model = r.model;
    if (typeof r.quality === "string") item.quality = r.quality;
    if (typeof r.resolution === "string") item.resolution = r.resolution;
    if (typeof r.aspectRatio === "string") item.aspectRatio = r.aspectRatio;
    if (r.tier === "premium" || r.tier === "quality" || r.tier === "quick") item.tier = r.tier;
    if (r.status === "pending" || r.status === "generating" || r.status === "ready" || r.status === "failed") {
      item.status = r.status;
    }
    if (r.outputMode === "in_chat" || r.outputMode === "on_canvas") {
      item.outputMode = r.outputMode;
    }
    if (typeof r.canvasNodeId === "string" && r.canvasNodeId.length > 0) {
      item.canvasNodeId = r.canvasNodeId;
    }
    out.push(item);
  }
  return out;
}

function rowToMessage(row: { id: string; role: string; text: string; images: unknown }): StoredMessage {
  return {
    id: row.id,
    role: row.role === "assistant" || row.role === "error" ? row.role : "user",
    text: row.text || "",
    images: sanitizeImages(row.images),
  };
}

router.get("/api/agent/chats", requireAuth, requireVerifiedEmail, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  // Optional ?workspace_id= filter. When supplied we return only chats that
  // belong to that workspace (after verifying the user is a member).
  const rawWs = typeof req.query.workspace_id === "string" ? req.query.workspace_id : "";
  const workspaceFilter = isUuid(rawWs) ? rawWs : null;
  if (rawWs && !workspaceFilter) {
    res.status(400).json({ error: "Invalid workspace_id" });
    return;
  }
  if (workspaceFilter) {
    const ok = await userHasWorkspaceAccess(userId, workspaceFilter);
    if (!ok) {
      res.status(403).json({ error: "No access to workspace" });
      return;
    }
  }
  try {
    const params: unknown[] = [userId];
    let where = `user_id = $1`;
    if (workspaceFilter) {
      params.push(workspaceFilter);
      where += ` AND workspace_id = $2`;
    }
    const result = await pool.query(
      `SELECT id, title, model_key, workspace_id, brand_profile_id, brand_disabled, last_product_ids, created_at, updated_at
       FROM agent_chats
       WHERE ${where}
       ORDER BY updated_at DESC
       LIMIT 200`,
      params
    );
    res.json({
      chats: result.rows.map((r) => ({
        id: r.id,
        title: r.title,
        modelKey: r.model_key,
        workspaceId: r.workspace_id,
        brandProfileId: r.brand_profile_id,
        brandDisabled: !!r.brand_disabled,
        productIds: Array.isArray(r.last_product_ids) ? r.last_product_ids : [],
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    });
  } catch (err) {
    console.error("[agent/chats] list error:", err);
    res.status(500).json({ error: "Failed to list chats" });
  }
});

router.get("/api/agent/chats/:id", requireAuth, requireVerifiedEmail, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const id = req.params.id;
  if (!isUuid(id)) {
    res.status(400).json({ error: "Invalid chat id" });
    return;
  }
  try {
    const chatRes = await pool.query(
      `SELECT id, title, model_key, workspace_id, brand_profile_id, brand_disabled, last_product_ids, created_at, updated_at
       FROM agent_chats WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    if (chatRes.rows.length === 0) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    const c = chatRes.rows[0];
    const msgRes = await pool.query(
      `SELECT id, role, text, images
       FROM agent_chat_messages
       WHERE chat_id = $1
       ORDER BY sort_order ASC, created_at ASC`,
      [id]
    );
    res.json({
      chat: {
        id: c.id,
        title: c.title,
        modelKey: c.model_key,
        workspaceId: c.workspace_id,
        brandProfileId: c.brand_profile_id,
        brandDisabled: !!c.brand_disabled,
        productIds: Array.isArray(c.last_product_ids) ? c.last_product_ids : [],
        createdAt: c.created_at,
        updatedAt: c.updated_at,
      },
      messages: msgRes.rows.map(rowToMessage),
    });
  } catch (err) {
    console.error("[agent/chats] get error:", err);
    res.status(500).json({ error: "Failed to load chat" });
  }
});

/* List all products the user can mention with @product in this workspace.
 * Combines:
 *   - User's own axioms (axioms.user_id = caller)
 *   - Workspace axioms (axioms.workspace_id = ?workspace_id, caller is a member)
 *   - Entitled platform axiom-type contents (free OR active user/org entitlement)
 * Each row carries an opaque id of the form "axiom:<uuid>" or
 * "platform:<uuid>" — that's the value the client must send back in
 * chat body.product_ids. */
router.get("/api/agent/products", requireAuth, requireVerifiedEmail, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const rawWs = typeof req.query.workspace_id === "string" ? req.query.workspace_id : "";
  const workspaceId = isUuid(rawWs) ? rawWs : null;
  if (rawWs && !workspaceId) {
    res.status(400).json({ error: "Invalid workspace_id" });
    return;
  }
  if (workspaceId) {
    const ok = await userHasWorkspaceAccess(userId, workspaceId);
    if (!ok) {
      res.status(403).json({ error: "No access to workspace" });
      return;
    }
  }
  try {
    // User axioms — the caller's personal library, regardless of workspace.
    const userAxioms = await pool.query(
      `SELECT id, name, description, images, updated_at
       FROM axioms
       WHERE user_id = $1
       ORDER BY updated_at DESC
       LIMIT 200`,
      [userId]
    );
    // Workspace axioms — only when a workspace is in scope. Membership
    // already enforced above.
    const wsAxioms = workspaceId
      ? await pool.query(
          `SELECT id, name, description, images, updated_at
           FROM axioms
           WHERE workspace_id = $1
           ORDER BY updated_at DESC
           LIMIT 200`,
          [workspaceId]
        )
      : { rows: [] as { id: string; name: string; description: string; images: unknown; updated_at: Date }[] };
    // Platform axiom-type contents the caller is entitled to. Free items
    // are always included; otherwise check user_entitlements (and
    // workspace org_entitlements when a workspace is in scope).
    const platformParams: unknown[] = [userId];
    let workspaceClause = "";
    if (workspaceId) {
      platformParams.push(workspaceId);
      workspaceClause = `OR EXISTS (
        SELECT 1 FROM org_entitlements oe
        WHERE oe.workspace_id = $2 AND oe.platform_item_id = pi.id
          AND oe.is_active = true
          AND (oe.expires_at IS NULL OR oe.expires_at > now())
      )`;
    }
    const platform = await pool.query(
      `SELECT pic.id, pic.name, pic.thumbnail_url, pic.file_url, pic.metadata, pic.sort_order,
              pi.description AS item_description, pi.name AS item_name
       FROM platform_item_contents pic
       JOIN platform_items pi ON pi.id = pic.platform_item_id
       WHERE pi.is_published = true
         AND pi.type = 'axiom'
         AND pic.content_type = 'axiom'
         AND (
           pi.is_free = true
           OR EXISTS (
             SELECT 1 FROM user_entitlements ue
             WHERE ue.user_id = $1 AND ue.platform_item_id = pi.id
               AND ue.is_active = true
               AND (ue.expires_at IS NULL OR ue.expires_at > now())
           )
           ${workspaceClause}
         )
       ORDER BY pi.name, pic.sort_order, pic.name
       LIMIT 200`,
      platformParams
    );

    type Row = {
      id: string;
      slug: string;
      name: string;
      description: string;
      thumbnail: string | null;
      sourceKind: ProductSourceKind;
    };
    const products: Row[] = [];
    const slugTaken = new Set<string>();
    const pushAxiom = (
      r: { id: string; name: string; description: string; images: unknown },
      sourceKind: "user" | "workspace"
    ) => {
      const slug = uniquifyProductSlug(normalizeProductSlug(r.name), r.id, slugTaken);
      const images = extractAxiomImageUrls(r.images, 1);
      products.push({
        id: `axiom:${r.id}`,
        slug,
        name: r.name || "Untitled",
        description: r.description || "",
        thumbnail: images[0] || null,
        sourceKind,
      });
    };
    for (const r of userAxioms.rows) pushAxiom(r, "user");
    for (const r of wsAxioms.rows) pushAxiom(r, "workspace");
    for (const r of platform.rows) {
      const slug = uniquifyProductSlug(normalizeProductSlug(r.name), r.id, slugTaken);
      const desc =
        (r.metadata && typeof r.metadata === "object"
          && typeof (r.metadata as { description?: unknown }).description === "string"
          ? (r.metadata as { description: string }).description
          : "")
        || r.item_description
        || "";
      products.push({
        id: `platform:${r.id}`,
        slug,
        name: r.name || r.item_name || "Platform product",
        description: desc,
        thumbnail: r.thumbnail_url || r.file_url || null,
        sourceKind: "platform",
      });
    }
    res.json({ products });
  } catch (err) {
    console.error("[agent/products] list error:", err);
    res.status(500).json({ error: "Failed to list products" });
  }
});

router.post("/api/agent/chats", requireAuth, requireVerifiedEmail, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const body = (req.body || {}) as {
    title?: string;
    modelKey?: string;
    workspace_id?: string;
    messages?: unknown;
    brand_profile_id?: string | null;
    brand_disabled?: boolean;
  };
  const modelKey = normalizeModelKey(body.modelKey);
  // Strict validation: when a workspace_id is supplied it must be a valid
  // UUID, not silently coerced to null. This prevents malformed clients
  // from creating unscoped chats by accident.
  let workspaceId: string | null = null;
  if (body.workspace_id !== undefined && body.workspace_id !== null && body.workspace_id !== "") {
    if (!isUuid(body.workspace_id)) {
      res.status(400).json({ error: "Invalid workspace_id" });
      return;
    }
    workspaceId = body.workspace_id;
    const ok = await userHasWorkspaceAccess(userId, workspaceId);
    if (!ok) {
      res.status(403).json({ error: "No access to workspace" });
      return;
    }
  }
  const incomingMessages = Array.isArray(body.messages) ? body.messages : [];

  let title = (body.title || "").toString().trim().slice(0, MAX_TITLE_LENGTH);
  if (!title) {
    const firstUser = incomingMessages.find(
      (m): m is { role: string; text: string } =>
        !!m && typeof m === "object" && (m as { role?: unknown }).role === "user"
    );
    title = deriveTitleFromText(firstUser ? String(firstUser.text || "") : "");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // brand_profile_id is a UUID FK — never write the wire-protocol sentinel
    // "__none__" into it. Translate the sentinel into the brand_disabled
    // boolean column instead so "disable brand for this chat" is a real
    // first-class state with no FK type errors.
    const brandDisabled =
      body.brand_disabled === true || body.brand_profile_id === "__none__";
    const brandProfileId = brandDisabled
      ? null
      : (typeof body.brand_profile_id === "string" && isUuid(body.brand_profile_id) ? body.brand_profile_id : null);
    const inserted = await client.query(
      `INSERT INTO agent_chats (user_id, workspace_id, title, model_key, brand_profile_id, brand_disabled)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, title, model_key, workspace_id, brand_profile_id, brand_disabled, created_at, updated_at`,
      [userId, workspaceId, title, modelKey, brandProfileId, brandDisabled]
    );
    const chat = inserted.rows[0];

    if (incomingMessages.length > 0) {
      let order = 0;
      for (const raw of incomingMessages) {
        if (!raw || typeof raw !== "object") continue;
        const role = (raw as { role?: unknown }).role;
        if (role !== "user" && role !== "assistant" && role !== "error") continue;
        const text = String((raw as { text?: unknown }).text ?? "");
        const images = sanitizeImages((raw as { images?: unknown }).images);
        await client.query(
          `INSERT INTO agent_chat_messages (chat_id, role, text, images, sort_order)
           VALUES ($1, $2, $3, $4::jsonb, $5)`,
          [chat.id, role, text, JSON.stringify(images), order++]
        );
      }
    }
    await client.query("COMMIT");
    res.status(201).json({
      chat: {
        id: chat.id,
        title: chat.title,
        modelKey: chat.model_key,
        workspaceId: chat.workspace_id,
        brandProfileId: chat.brand_profile_id,
        brandDisabled: !!chat.brand_disabled,
        createdAt: chat.created_at,
        updatedAt: chat.updated_at,
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[agent/chats] create error:", err);
    res.status(500).json({ error: "Failed to create chat" });
  } finally {
    client.release();
  }
});

// Replace all messages for a chat (used to keep the server in sync with the panel state).
router.put("/api/agent/chats/:id/messages", requireAuth, requireVerifiedEmail, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const id = req.params.id;
  if (!isUuid(id)) {
    res.status(400).json({ error: "Invalid chat id" });
    return;
  }
  const body = (req.body || {}) as { messages?: unknown; modelKey?: string; title?: string };
  const incoming = Array.isArray(body.messages) ? body.messages : null;
  if (!incoming) {
    res.status(400).json({ error: "messages array required" });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const owned = await client.query(
      `SELECT id, title FROM agent_chats WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [id, userId]
    );
    if (owned.rows.length === 0) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    const updates: string[] = [];
    const values: unknown[] = [];
    let pi = 1;
    if (typeof body.modelKey === "string") {
      updates.push(`model_key = $${pi++}`);
      values.push(normalizeModelKey(body.modelKey));
    }
    let nextTitle: string | null = null;
    if (typeof body.title === "string" && body.title.trim()) {
      nextTitle = body.title.trim().slice(0, MAX_TITLE_LENGTH);
    } else {
      // Auto-derive title from first user message if it's still the default.
      const currentTitle = owned.rows[0].title;
      if (currentTitle === "New chat") {
        const firstUser = incoming.find(
          (m): m is { role: string; text: string } =>
            !!m && typeof m === "object" && (m as { role?: unknown }).role === "user"
        );
        if (firstUser) nextTitle = deriveTitleFromText(String(firstUser.text || ""));
      }
    }
    if (nextTitle) {
      updates.push(`title = $${pi++}`);
      values.push(nextTitle);
    }
    updates.push(`updated_at = NOW()`);
    values.push(id);
    await client.query(`UPDATE agent_chats SET ${updates.join(", ")} WHERE id = $${pi}`, values);

    await client.query(`DELETE FROM agent_chat_messages WHERE chat_id = $1`, [id]);

    let order = 0;
    for (const raw of incoming) {
      if (!raw || typeof raw !== "object") continue;
      const role = (raw as { role?: unknown }).role;
      if (role !== "user" && role !== "assistant" && role !== "error") continue;
      const text = String((raw as { text?: unknown }).text ?? "");
      const images = sanitizeImages((raw as { images?: unknown }).images);
      await client.query(
        `INSERT INTO agent_chat_messages (chat_id, role, text, images, sort_order)
         VALUES ($1, $2, $3, $4::jsonb, $5)`,
        [id, role, text, JSON.stringify(images), order++]
      );
    }
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[agent/chats] put-messages error:", err);
    res.status(500).json({ error: "Failed to update chat" });
  } finally {
    client.release();
  }
});

router.patch("/api/agent/chats/:id", requireAuth, requireVerifiedEmail, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const id = req.params.id;
  if (!isUuid(id)) {
    res.status(400).json({ error: "Invalid chat id" });
    return;
  }
  const body = (req.body || {}) as { title?: string; modelKey?: string; brand_profile_id?: string | null; brand_disabled?: boolean; product_ids?: string[] | null };
  const updates: string[] = [];
  const values: unknown[] = [];
  let pi = 1;
  if (typeof body.title === "string") {
    const t = body.title.trim().slice(0, MAX_TITLE_LENGTH);
    if (!t) {
      res.status(400).json({ error: "Title cannot be empty" });
      return;
    }
    updates.push(`title = $${pi++}`);
    values.push(t);
  }
  if (typeof body.modelKey === "string") {
    updates.push(`model_key = $${pi++}`);
    values.push(normalizeModelKey(body.modelKey));
  }
  // Translate the wire sentinel "__none__" into the brand_disabled boolean
  // and never write a non-UUID into the brand_profile_id FK column.
  if (body.brand_profile_id !== undefined || body.brand_disabled !== undefined) {
    const disabled =
      body.brand_disabled === true || body.brand_profile_id === "__none__";
    let nextProfileId: string | null = null;
    if (!disabled && body.brand_profile_id !== undefined && body.brand_profile_id !== null) {
      nextProfileId = (typeof body.brand_profile_id === "string" && isUuid(body.brand_profile_id))
        ? body.brand_profile_id
        : null;
    }
    updates.push(`brand_profile_id = $${pi++}`);
    values.push(nextProfileId);
    updates.push(`brand_disabled = $${pi++}`);
    values.push(disabled);
  }
  if (body.product_ids !== undefined) {
    // Filter to well-formed opaque ids; do not validate access here — that
    // happens at chat dispatch time. Persisting an opaque id the user no
    // longer has access to simply causes resolveProducts() to drop it.
    const cleaned = Array.isArray(body.product_ids)
      ? body.product_ids.filter((x): x is string => typeof x === "string" && parseProductId(x) !== null)
      : [];
    updates.push(`last_product_ids = $${pi++}::text[]`);
    values.push(cleaned);
  }
  if (updates.length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }
  updates.push(`updated_at = NOW()`);
  values.push(id);
  values.push(userId);
  try {
    const result = await pool.query(
      `UPDATE agent_chats SET ${updates.join(", ")} WHERE id = $${pi} AND user_id = $${pi + 1}
       RETURNING id, title, model_key, workspace_id, created_at, updated_at`,
      values
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    const c = result.rows[0];
    res.json({
      chat: {
        id: c.id,
        title: c.title,
        modelKey: c.model_key,
        workspaceId: c.workspace_id,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
      },
    });
  } catch (err) {
    console.error("[agent/chats] patch error:", err);
    res.status(500).json({ error: "Failed to update chat" });
  }
});

router.delete("/api/agent/chats/:id", requireAuth, requireVerifiedEmail, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const id = req.params.id;
  if (!isUuid(id)) {
    res.status(400).json({ error: "Invalid chat id" });
    return;
  }
  try {
    const result = await pool.query(
      `DELETE FROM agent_chats WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("[agent/chats] delete error:", err);
    res.status(500).json({ error: "Failed to delete chat" });
  }
});

// ---------- Streaming chat completion ----------

type ClientMessage = {
  role: "user" | "assistant";
  text: string;
  // Inline message images can be either user attachments or prior agent
  // generations carried forward as a "pinned" reference. `kind` is set to
  // "video" for inline video gens so vision builders can skip them.
  images?: {
    url: string;
    source?: "attachment" | "agent" | string;
    kind?: "image" | "video" | "music";
  }[];
};

type ChatBody = {
  modelKey?: string;
  workspace_id?: string;
  canvas_id?: string;
  messages?: ClientMessage[];
  // Where the user wants generations to land. When "on_canvas" the agent is
  // instructed to introduce each generation in chat with a one-line statement
  // and a suggested next action (the asset itself appears on the canvas, not
  // in the chat). Defaults to "in_chat" if missing.
  output_mode?: "in_chat" | "on_canvas";
  // Active Brand IQ profile for this turn. Resolution priority is:
  //   explicit body field → agent_chats.brand_profile_id (sticky per chat) →
  //   project_brand_overrides.brand_profile_id → workspace default profile.
  // The pseudo-value "__none__" pins "no brand" for this chat (suppresses
  // both project override + workspace default fallback).
  brand_profile_id?: string | null;
  // Explicit "no brand" toggle, separate from brand_profile_id, so callers
  // never have to overload the UUID field with a sentinel value.
  brand_disabled?: boolean;
  // Sticky-write hint: when true, persist `brand_profile_id` (or null) on
  // the agent_chats row keyed by `chat_id` so subsequent turns inherit the
  // selection without the client having to resend it.
  chat_id?: string;
  brand_sticky?: boolean;
  // Resolved "@product" mentions for this turn. Each id is an opaque
  // string of the form "axiom:<uuid>" (a user/workspace axiom) or
  // "platform:<uuid>" (a platform_item_contents row the user is
  // entitled to). The server validates access on every read.
  product_ids?: string[];
  // When true, persist product_ids onto the chat row so follow-up turns
  // inherit them. When omitted, the previously sticky set is reused
  // unless product_ids is explicitly the empty array.
  product_sticky?: boolean;
};

// ---------- @product mention infrastructure ----------
//
// A "product" is either a user/workspace axiom (axioms.id) or a platform
// product's content row (platform_item_contents.id). The wire format
// uses opaque "axiom:<uuid>" / "platform:<uuid>" prefixes so a single
// payload field can carry both kinds without an extra discriminator.

type ProductSourceKind = "user" | "workspace" | "platform";

type ProductContext = {
  // Opaque id as it appears on the wire ("axiom:<uuid>" or "platform:<uuid>").
  productId: string;
  // Underlying row id (axioms.id or platform_item_contents.id).
  rowId: string;
  sourceKind: ProductSourceKind;
  // Stable per-turn slug used in reference ids ("product:<slug>"). Derived
  // from the product name with a short hash suffix so name collisions
  // across the catalog don't collide.
  slug: string;
  name: string;
  description: string;
  imageUrls: string[];
};

function normalizeProductSlug(name: string): string {
  return (name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "product";
}

function uniquifyProductSlug(base: string, rowId: string, taken: Set<string>): string {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  // Append a 4-char id suffix on collision so the slug stays stable
  // across turns for the same product.
  const suffix = rowId.replace(/-/g, "").slice(0, 4);
  let candidate = `${base}-${suffix}`;
  let i = 2;
  while (taken.has(candidate)) {
    candidate = `${base}-${suffix}-${i++}`;
  }
  taken.add(candidate);
  return candidate;
}

function parseProductId(raw: unknown): { kind: "axiom" | "platform"; rowId: string } | null {
  if (typeof raw !== "string") return null;
  const m = raw.match(/^(axiom|platform):([0-9a-f-]{36})$/i);
  if (!m) return null;
  if (!isUuid(m[2])) return null;
  return { kind: m[1].toLowerCase() as "axiom" | "platform", rowId: m[2] };
}

function extractAxiomImageUrls(raw: unknown, cap = 4): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (out.length >= cap) break;
    if (!entry) continue;
    if (typeof entry === "string") {
      if (/^https?:\/\//i.test(entry) || entry.startsWith("/")) out.push(entry);
      continue;
    }
    if (typeof entry === "object") {
      const url = (entry as { url?: unknown; file_url?: unknown }).url
        || (entry as { url?: unknown; file_url?: unknown }).file_url;
      if (typeof url === "string" && (url.startsWith("http") || url.startsWith("/"))) {
        out.push(url);
      }
    }
  }
  return out;
}

/* Load and access-check every requested product id. Drops anything the
 * caller cannot see (cross-workspace axiom, un-entitled platform content,
 * unknown id). De-duplicates by row id and assigns stable slugs. */
async function resolveProducts(
  userId: string,
  workspaceId: string | undefined,
  rawIds: string[] | undefined,
): Promise<ProductContext[]> {
  if (!Array.isArray(rawIds) || rawIds.length === 0) return [];
  const seen = new Set<string>();
  const axiomIds: string[] = [];
  const platformIds: string[] = [];
  // Preserve the caller's order while de-duplicating.
  const order: Array<{ kind: "axiom" | "platform"; rowId: string; opaque: string }> = [];
  for (const raw of rawIds) {
    const p = parseProductId(raw);
    if (!p) continue;
    const opaque = `${p.kind}:${p.rowId}`;
    if (seen.has(opaque)) continue;
    seen.add(opaque);
    order.push({ ...p, opaque });
    if (p.kind === "axiom") axiomIds.push(p.rowId);
    else platformIds.push(p.rowId);
  }
  if (order.length === 0) return [];

  const axiomRows = new Map<string, { name: string; description: string; images: unknown }>();
  if (axiomIds.length > 0) {
    // Access: own user axiom OR workspace axiom in the active workspace
    // the user is a member of. We deliberately scope to the active
    // workspace only so a member of multiple workspaces can't pull
    // axioms from workspace B into a chat in workspace A.
    const params: unknown[] = [axiomIds, userId];
    let where = `id = ANY($1::uuid[]) AND (user_id = $2`;
    if (workspaceId && isUuid(workspaceId)) {
      params.push(workspaceId);
      where += ` OR workspace_id = $3)`;
    } else {
      where += `)`;
    }
    try {
      const r = await pool.query(
        `SELECT a.id, a.name, a.description, a.images, a.user_id, a.workspace_id
         FROM axioms a
         WHERE ${where}`,
        params
      );
      for (const row of r.rows) {
        axiomRows.set(row.id, {
          name: row.name || "Untitled product",
          description: row.description || "",
          images: row.images,
        });
      }
    } catch (err) {
      console.warn("[agent/products] axiom resolve failed:", err);
    }
  }

  const platformRows = new Map<string, { name: string; description: string; file_url: string }>();
  if (platformIds.length > 0) {
    // Access: the platform_item must be free OR the user / their workspace
    // has an active entitlement. Limit to axiom-type items per spec.
    try {
      const r = await pool.query(
        `SELECT pic.id, pic.name, pic.metadata, pic.file_url, pi.description AS item_description
         FROM platform_item_contents pic
         JOIN platform_items pi ON pi.id = pic.platform_item_id
         WHERE pic.id = ANY($1::uuid[])
           AND pi.is_published = true
           AND pi.type = 'axiom'
           AND (
             pi.is_free = true
             OR EXISTS (
               SELECT 1 FROM user_entitlements ue
               WHERE ue.platform_item_id = pi.id AND ue.user_id = $2
                 AND ue.is_active = true
                 AND (ue.expires_at IS NULL OR ue.expires_at > now())
             )
             OR EXISTS (
               SELECT 1 FROM org_entitlements oe
               JOIN workspace_members wm
                 ON wm.workspace_id = oe.workspace_id AND wm.user_id = $2
               WHERE oe.platform_item_id = pi.id
                 AND oe.is_active = true
                 AND (oe.expires_at IS NULL OR oe.expires_at > now())
             )
           )`,
        [platformIds, userId]
      );
      for (const row of r.rows) {
        const desc =
          (row.metadata && typeof row.metadata === "object"
            && typeof (row.metadata as { description?: unknown }).description === "string"
            ? (row.metadata as { description: string }).description
            : "")
          || row.item_description
          || "";
        platformRows.set(row.id, {
          name: row.name || "Platform product",
          description: desc,
          file_url: row.file_url || "",
        });
      }
    } catch (err) {
      console.warn("[agent/products] platform resolve failed:", err);
    }
  }

  // Determine each axiom's source kind from a second probe — the SELECT
  // above did not return user_id/workspace_id reliably for this purpose
  // because the WHERE clause may have OR-matched on either. We can derive
  // it cheaply here without a re-query by re-checking ownership.
  const axiomKindRows = new Map<string, ProductSourceKind>();
  if (axiomIds.length > 0 && axiomRows.size > 0) {
    try {
      const r = await pool.query(
        `SELECT id, user_id, workspace_id FROM axioms WHERE id = ANY($1::uuid[])`,
        [Array.from(axiomRows.keys())]
      );
      for (const row of r.rows) {
        axiomKindRows.set(row.id, row.user_id ? "user" : "workspace");
      }
    } catch { /* best-effort */ }
  }

  const taken = new Set<string>();
  const out: ProductContext[] = [];
  for (const item of order) {
    if (item.kind === "axiom") {
      const row = axiomRows.get(item.rowId);
      if (!row) continue;
      const slug = uniquifyProductSlug(normalizeProductSlug(row.name), item.rowId, taken);
      out.push({
        productId: item.opaque,
        rowId: item.rowId,
        sourceKind: axiomKindRows.get(item.rowId) || "user",
        slug,
        name: row.name,
        description: row.description,
        imageUrls: extractAxiomImageUrls(row.images),
      });
    } else {
      const row = platformRows.get(item.rowId);
      if (!row) continue;
      const slug = uniquifyProductSlug(normalizeProductSlug(row.name), item.rowId, taken);
      out.push({
        productId: item.opaque,
        rowId: item.rowId,
        sourceKind: "platform",
        slug,
        name: row.name,
        description: row.description,
        imageUrls: row.file_url ? [row.file_url] : [],
      });
    }
  }
  return out;
}

/* Build the prompt-injectable description block for the active products.
 * Lists each product's name, source, description, and the reference ids
 * the model can pass back via referenceImageIds. */
function buildProductsSystemBlock(products: ProductContext[]): string {
  if (products.length === 0) return "";
  const lines: string[] = ["", "--- ACTIVE PRODUCTS (mentioned with @product) ---"];
  for (const p of products) {
    const refIds: string[] = [];
    p.imageUrls.forEach((_u, i) => refIds.push(`product:${p.slug}${p.imageUrls.length > 1 ? `:${i + 1}` : ""}`));
    lines.push(
      `• "${p.name}" (id: product:${p.slug}, source: ${p.sourceKind})`,
      p.description ? `    Description: ${p.description.slice(0, 600)}` : "",
      refIds.length > 0
        ? `    Reference ids: ${refIds.join(", ")} — pass in referenceImageIds to attach the product's reference image(s).`
        : "    (no reference image available)",
    );
  }
  lines.push(
    "When the user mentions a product by name (or by @slug) and asks to put it in a scene, edit it, or otherwise generate from it, automatically include the product's reference id(s) in referenceImageIds and weave the product's name + description into the generation prompt so the result faithfully depicts that specific product."
  );
  return lines.filter(Boolean).join("\n");
}

/* Map ordered ProductContext list → flat URL list and the matching slug
 * map for resolveReferenceIds. */
function buildProductRefMap(products: ProductContext[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of products) {
    if (p.imageUrls.length === 0) continue;
    if (p.imageUrls.length === 1) {
      map.set(`product:${p.slug}`, p.imageUrls[0]);
    } else {
      // First image is the bare slug too, so the model can be lazy.
      map.set(`product:${p.slug}`, p.imageUrls[0]);
      p.imageUrls.forEach((url, i) => {
        map.set(`product:${p.slug}:${i + 1}`, url);
      });
    }
  }
  return map;
}

type BrandContext = {
  id: string;
  name: string;
  designMd: string;
  logoLightUrl: string | null;
  logoDarkUrl: string | null;
  graphicUrls: string[];
  palette: { hex: string; name?: string }[];
  typography: { display?: string; body?: string; mono?: string };
};

const BRAND_PIN_NONE = "__none__";

async function resolveBrandProfile(
  userId: string,
  workspaceId: string | undefined,
  canvasId: string | null,
  explicit: string | null | undefined,
): Promise<BrandContext | null> {
  // Explicit suppression — caller said "no brand for this turn".
  if (explicit === BRAND_PIN_NONE) return null;

  // Determine the *active* workspace for this turn. Brand profiles MUST
  // belong to that workspace — a user who is a member of multiple
  // workspaces should never be able to leak a brand from workspace B
  // into a chat happening in workspace A. We resolve the active ws as:
  //   1) explicit body.workspace_id if supplied,
  //   2) else the workspace owning the canvasId (project),
  //   3) else null (no scope to enforce — fall back to legacy behavior).
  let activeWsId: string | null = workspaceId && isUuid(workspaceId) ? workspaceId : null;
  if (!activeWsId && canvasId && isUuid(canvasId)) {
    try {
      const r = await pool.query(
        `SELECT workspace_id FROM canvas_states WHERE id = $1`,
        [canvasId]
      );
      const ws = r.rows[0]?.workspace_id;
      if (typeof ws === "string" && isUuid(ws)) activeWsId = ws;
    } catch { /* best-effort scope resolution */ }
  }

  const tryLoad = async (profileId: string | null | undefined): Promise<BrandContext | null> => {
    if (!profileId || !isUuid(profileId)) return null;
    const r = await pool.query(
      `SELECT bp.id, bp.workspace_id, bp.name, bp.design_md, bp.data
       FROM brand_iq_profiles bp
       JOIN workspace_members wm
         ON wm.workspace_id = bp.workspace_id AND wm.user_id = $2
       WHERE bp.id = $1 AND bp.archived_at IS NULL`,
      [profileId, userId]
    );
    if (r.rows.length === 0) return null;
    // Workspace boundary enforcement: when we know the active workspace,
    // reject any profile that doesn't belong to it. This is the
    // cross-workspace leak fix — without it, a member of workspaces A
    // and B chatting in A could pin a profile from B.
    if (activeWsId && r.rows[0].workspace_id !== activeWsId) {
      console.warn("[brand-iq] cross-workspace brand profile rejected", {
        userId, profileId, activeWsId, profileWsId: r.rows[0].workspace_id,
      });
      return null;
    }
    const profile = r.rows[0] as {
      id: string; workspace_id: string; name: string; design_md: string;
      data: Record<string, unknown>;
    };
    const assets = await pool.query(
      `SELECT bia.role, a.file_url
       FROM brand_iq_assets bia
       JOIN assets a ON a.id = bia.asset_id
       WHERE bia.profile_id = $1 AND a.deleted_at IS NULL
         AND bia.role IN ('logo_light', 'logo_dark', 'graphic')
       ORDER BY bia.role, bia.sort_order, bia.created_at`,
      [profile.id]
    );
    let logoLight: string | null = null;
    let logoDark: string | null = null;
    const graphics: string[] = [];
    for (const row of assets.rows as { role: string; file_url: string }[]) {
      if (!row.file_url) continue;
      if (row.role === "logo_light" && !logoLight) logoLight = row.file_url;
      else if (row.role === "logo_dark" && !logoDark) logoDark = row.file_url;
      else if (row.role === "graphic" && graphics.length < 4) graphics.push(row.file_url);
    }
    const data = profile.data || {};
    const palette = Array.isArray((data as { palette?: unknown }).palette)
      ? ((data as { palette: { hex?: string; name?: string }[] }).palette || [])
          .filter((p) => p && typeof p.hex === "string")
          .slice(0, 12)
          .map((p) => ({ hex: p.hex as string, name: p.name }))
      : [];
    const typo = (data as { typography?: { display?: string; body?: string; mono?: string } }).typography || {};
    return {
      id: profile.id,
      name: profile.name,
      designMd: profile.design_md || "",
      logoLightUrl: logoLight,
      logoDarkUrl: logoDark,
      graphicUrls: graphics,
      palette,
      typography: { display: typo.display, body: typo.body, mono: typo.mono },
    };
  };

  // 1. explicit body value wins
  const fromBody = await tryLoad(explicit ?? undefined);
  if (fromBody) return fromBody;

  // 2. project override (canvas_states is the project table)
  if (canvasId && isUuid(canvasId)) {
    const r = await pool.query(
      `SELECT brand_profile_id FROM project_brand_overrides WHERE project_id = $1`,
      [canvasId]
    );
    const fromProject = await tryLoad(r.rows[0]?.brand_profile_id);
    if (fromProject) return fromProject;
  }

  // 3. workspace default
  if (workspaceId && isUuid(workspaceId)) {
    const r = await pool.query(
      `SELECT id FROM brand_iq_profiles
       WHERE workspace_id = $1 AND archived_at IS NULL AND is_default = TRUE
       LIMIT 1`,
      [workspaceId]
    );
    const fromDefault = await tryLoad(r.rows[0]?.id);
    if (fromDefault) return fromDefault;
  }
  return null;
}

function buildBrandSystemBlock(brand: BrandContext): string {
  const palette = brand.palette.length > 0
    ? `\nPalette: ${brand.palette.map((p) => `${p.hex}${p.name ? ` (${p.name})` : ""}`).join(", ")}`
    : "";
  const typo = brand.typography.display || brand.typography.body || brand.typography.mono
    ? `\nTypography: display="${brand.typography.display || "—"}", body="${brand.typography.body || "—"}", mono="${brand.typography.mono || "—"}"`
    : "";
  const logos: string[] = [];
  if (brand.logoLightUrl) logos.push("brand:logo_light");
  if (brand.logoDarkUrl) logos.push("brand:logo_dark");
  brand.graphicUrls.forEach((_u, i) => logos.push(`brand:graphic:${i + 1}`));
  const logoLine = logos.length > 0
    ? `\nBrand reference ids you may pass in referenceImageIds: ${logos.join(", ")}.`
    : "";
  // Inject the *full* canonical design_md so mission, voice, do/don'ts,
  // typography rules, etc. all reach the model verbatim. We previously
  // sliced at 6000 chars which silently dropped later sections; if a
  // brief truly exceeds Claude's prompt headroom, the synthesize step
  // upstream is the right place to summarize, not this dispatch path.
  const designSnippet = brand.designMd
    ? `\n\nBrand brief (markdown — keep all generation on-brand):\n${brand.designMd}`
    : "";
  return [
    `Active Brand: "${brand.name}" (id: ${brand.id}). Every generation in this chat must respect the brand.`,
    palette + typo + logoLine,
    designSnippet,
  ].filter(Boolean).join("");
}

// ---------- generate_media tool ----------

type GenTier = "premium" | "quality" | "quick";
type GenKind = "image" | "video";
type GenQuality = "low" | "medium" | "high";

// Non-generative transforms exposed via the transform_media tool.
type TransformOp = "remove_background" | "upscale" | "resize";

const GEN_ALLOWED_AR = new Set([
  "1:1", "4:3", "3:4", "16:9", "9:16", "21:9", "3:2", "2:3",
]);

// Tier → concrete model. Image tier maps differ for t2i vs i2i.
// Video tier is text-to-video only for V1; image-to-video is reached by
// passing a reference image, which switches the resolved model accordingly.
function resolveImageModel(tier: GenTier, hasReference: boolean): string {
  if (tier === "quick") {
    return hasReference ? "seedream-edit" : "seedream-t2i";
  }
  // Premium image default: nano-banana-2 (matches Make-panel default).
  return hasReference ? "nano-banana-2" : "nano-banana-2-t2i";
}

// Tier → base video model family. The concrete variant (t2v / i2v / flf2v /
// r2v) is decided later by selectVideoVariant() based on the user-specified
// reference mode, so this only picks the family.
//
// Video is MiniMax H3 Max, full stop — no cheaper substitute. This used to hold
// only for text-to-video, because fal shipped no i2v/r2v endpoint for H3 Max and
// an attached reference had to be handed to another family. Both endpoints now
// exist, so the reason for that substitution is gone and references stay on H3
// Max too. An explicitly chosen non-default tier still names its own family, and
// `model` still overrides everything.
function resolveVideoModelFamily(
  tier: GenTier,
  _hasReference: boolean,
): "h3-max" | "veo3.1-lite" | "kling-o3-pro" | "seedance-2.0" {
  if (tier === "quick") return "veo3.1-lite";
  if (tier === "quality") return "kling-o3-pro";
  return "h3-max";
}

// Returns true if the user has completed Seedance geo verification and is in
// a permitted region. Mirrors the gate in /api/generate so the agent can
// auto-fall-back to Kling instead of dispatching a doomed request.
async function isSeedanceAllowed(_userId: string): Promise<boolean> {
  // Seedance 2.0 region/business-verification gate removed (2026-05) —
  // always allowed. Function retained so call sites and the cached
  // promise plumbing in /api/agent/chat keep working unchanged.
  return true;
}

// Quality is only meaningful for gpt-image-2*. Other models silently ignore
// it via /api/generate, but we still tag the tray entry with the requested
// quality for display in the chat caption. Premium defaults to "high" to
// match the Make-panel default; quick clamps to "low" so cheap intent stays
// cheap.
function defaultQualityForTier(tier: GenTier): GenQuality {
  return tier === "quick" ? "low" : "high";
}

function clampQuality(q: unknown, tier: GenTier): GenQuality {
  if (q === "low" || q === "medium" || q === "high") return q;
  return defaultQualityForTier(tier);
}

const FOLLOWUP_RE = /\b(this|that|it|the (last|previous|prior|earlier) (one|image|version)|make it|warmer|cooler|brighter|darker|again|same but|like (this|that|the (one|image|version) above))\b/i;

// Cheap-intent keywords: when Claude returns no tier (or an off-catalog one)
// and the user message contains any of these, fall back to the 'quick' tier.
const CHEAP_INTENT_RE = /\b(cheap|cheaper|cheapest|quick|quickly|fast|faster|draft|rough|low[\s-]?cost|low[\s-]?quality|save\s+credits?|budget|low[\s-]?fi|lo[\s-]?fi)\b/i;

// Silence-intent keywords (video only): when the user clearly asks for a
// muted / silent / no-audio video, flip the default audio toggle off.
// Defaults are audio-ON (matches the Make-panel default), so this regex
// only needs to catch the user explicitly opting OUT.
const SILENCE_INTENT_RE = /\b(no\s+(?:audio|sound|music)|without\s+(?:audio|sound|music)|silent|silence|muted?|mute\s+(?:the|it|audio|sound)|sound\s+off|audio\s+off|no\s+sfx)\b/i;

// Whitelist of explicit model values Claude is allowed to pick. Each entry
// maps a public-facing model name to the concrete generation backend type +
// model id used by /api/generate. We accept aliases (with/without -t2i / -i2v
// suffix) so Claude can use the same name regardless of whether a reference
// is attached.
// For video entries, the optional fields describe which concrete backend
// handles each user-specified reference mode. `i2` is always the
// image-to-video (single starting frame) variant; `i2_first_last` is the
// first-frame + last-frame morph (Veo only); `i2_multi` is the
// multi-reference blend (Seedance only). When the requested mode isn't
// supported by the chosen family we downgrade to `i2` and surface a notice.
// For image entries, `i2` is the edit / image-to-image variant; the
// flf/multi fields are unused.
// `label` is a short user-facing name used in fallback notices.
type ModelEntry = {
  kind: GenKind;
  tier: GenTier;
  label: string;
  t2: string;
  i2?: string;
  i2_first_last?: string;
  i2_multi?: string;
};
const MODEL_WHITELIST: Record<string, ModelEntry> = {
  // Image — premium pair: nano-banana-2 (Make-panel default) and gpt-image-2.
  "nano-banana-2": { kind: "image", tier: "premium", label: "Nano Banana 2", t2: "nano-banana-2-t2i", i2: "nano-banana-2" },
  "gpt-image-2": { kind: "image", tier: "premium", label: "GPT Image 2", t2: "gpt-image-2-t2i", i2: "gpt-image-2-edit" },
  "seedream": { kind: "image", tier: "quick", label: "Seedream", t2: "seedream-t2i", i2: "seedream-edit" },
  "seedream-5": { kind: "image", tier: "quick", label: "Seedream 5", t2: "seedream-5-t2i", i2: "seedream-5-edit" },
  // Video.
  "gemini-omni": { kind: "video", tier: "premium", label: "Gemini Omni Flash", t2: "gemini-omni-t2v", i2: "gemini-omni-i2v" },
  "seedance-2.5": { kind: "video", tier: "premium", label: "Seedance 2.5", t2: "seedance-2.5-t2v", i2: "seedance-2.5-i2v", i2_multi: "seedance-2.5-r2v" },
  "seedance-2.0": { kind: "video", tier: "premium", label: "Seedance 2.0", t2: "seedance-2.0-t2v", i2: "seedance-2.0-i2v", i2_multi: "seedance-2.0-r2v" },
  "kling-o3-pro": { kind: "video", tier: "quality", label: "Kling O3 Pro", t2: "kling-o3-pro-t2v", i2: "kling-o3-pro-i2v", i2_multi: "kling-o3-pro-r2v" },
  "kling-o3-4k": { kind: "video", tier: "quality", label: "Kling O3 4K", t2: "kling-o3-4k-t2v", i2: "kling-o3-4k-i2v", i2_multi: "kling-o3-4k-r2v" },
  "veo3.1-lite": { kind: "video", tier: "quick", label: "Veo 3.1 Lite", t2: "veo3.1-lite-t2v", i2: "veo3.1-lite-i2v", i2_first_last: "veo3.1-lite-flf2v" },
  // H3 Max does all three modes. i2_first_last shares the i2v endpoint: one
  // endpoint takes image_url and end_image_url, so the mode is which of the two
  // the caller fills, not a different model.
  "h3-max": { kind: "video", tier: "quick", label: "MiniMax H3 Max", t2: "h3-max-t2v", i2: "h3-max-i2v", i2_first_last: "h3-max-i2v", i2_multi: "h3-max-r2v" },
  // Turbo ships only t2v and i2v — no reference-to-video endpoint — so it has
  // no i2_multi and can't back seam="reference" chaining. Opt-in by name only;
  // it is never a tier default.
  "h3-turbo": { kind: "video", tier: "quick", label: "MiniMax H3 Max Turbo", t2: "h3-turbo-t2v", i2: "h3-turbo-i2v", i2_first_last: "h3-turbo-i2v" },
};

// Three explicit ways the user can want references attached to a video:
//   - "first_frame": single image is the starting frame (i2v)
//   - "first_last_frame": two images are the start and end frames (flf2v — Veo only)
//   - "references": 2-4 images blended as a reference set (r2v — Seedance and Kling O3)
// Required on the tool call when kind=video AND references are attached.
type VideoReferenceMode = "first_frame" | "first_last_frame" | "references";

// Pick the concrete video variant for a given family + user-specified mode.
// When the family doesn't support the requested mode, we downgrade to plain
// i2v (first frame only) and return a notice the chat can surface.
function selectVideoVariant(
  entry: ModelEntry,
  mode: VideoReferenceMode,
  refCount: number,
): { id: string; notice?: string } {
  // A family with no image-to-video endpoint can only ever run text-to-video.
  if (!entry.i2) {
    return { id: entry.t2, notice: `${entry.label} is text-to-video only — generated from the prompt without the reference.` };
  }
  if (mode === "first_frame") {
    return { id: entry.i2 };
  }
  if (mode === "first_last_frame") {
    if (entry.i2_first_last) {
      if (refCount < 2) {
        return { id: entry.i2, notice: `First/last-frame mode needs two references — used the single image as the starting frame.` };
      }
      return { id: entry.i2_first_last };
    }
    return { id: entry.i2, notice: `${entry.label} doesn't support first/last-frame mode — used the first image as the starting frame.` };
  }
  // references
  if (entry.i2_multi) {
    return { id: entry.i2_multi };
  }
  return { id: entry.i2, notice: `${entry.label} doesn't support reference blending — used the first image as the starting frame.` };
}
// Common natural-language aliases users (and Claude) say in chat — normalize
// them to canonical model keys before lookup.
const MODEL_ALIASES: Record<string, string> = {
  "nano-banana": "nano-banana-2",
  "nanobanana": "nano-banana-2",
  "nanobanana2": "nano-banana-2",
  "nano banana": "nano-banana-2",
  "nano banana 2": "nano-banana-2",
  "banana": "nano-banana-2",
  "gpt image": "gpt-image-2",
  "gpt-image": "gpt-image-2",
  "gptimage": "gpt-image-2",
  "kling": "kling-o3-pro",
  "kling pro": "kling-o3-pro",
  "kling video": "kling-o3-pro",
  "kling o3": "kling-o3-pro",
  "kling-o3": "kling-o3-pro",
  "kling o3 pro": "kling-o3-pro",
  "kling-o3-pro": "kling-o3-pro",
  "kling 4k": "kling-o3-4k",
  "kling o3 4k": "kling-o3-4k",
  "kling-o3-4k": "kling-o3-4k",
  "kling 4k pro": "kling-o3-4k",
  "veo": "veo3.1-lite",
  "veo 3.1": "veo3.1-lite",
  "veo3.1": "veo3.1-lite",
  "veo-3.1": "veo3.1-lite",
  "gemini omni": "gemini-omni",
  "gemini omni flash": "gemini-omni",
  "omni": "gemini-omni",
  "seedance": "seedance-2.5",
  "seedance 2.5": "seedance-2.5",
  "seedance2.5": "seedance-2.5",
  "seedance 2": "seedance-2.0",
  "seedance 2.0": "seedance-2.0",
  "seedance2": "seedance-2.0",
  "h3": "h3-max",
  "h3 max": "h3-max",
  "minimax": "h3-max",
  "minimax h3": "h3-max",
  "minimax h3 max": "h3-max",
  "hailuo": "h3-max",
  "turbo": "h3-turbo",
  "h3 turbo": "h3-turbo",
  "h3-turbo": "h3-turbo",
  "h3 max turbo": "h3-turbo",
  "minimax turbo": "h3-turbo",
  "minimax h3 turbo": "h3-turbo",
  "minimax h3 max turbo": "h3-turbo",
};
// Resolve an explicit-model name to a ModelEntry. The concrete variant
// (t2 / i2 / flf / multi) is picked later by the caller based on refs +
// reference mode — this function only normalizes the name to an entry.
function resolveExplicitModel(name: string | undefined): ModelEntry | null {
  if (!name) return null;
  let key = name.toLowerCase().trim();
  // Apply natural-language alias mapping first ("nano banana 2" → "nano-banana-2").
  if (MODEL_ALIASES[key]) key = MODEL_ALIASES[key];
  // Strip common suffixes so 'gpt-image-2-t2i' and 'gpt-image-2' both map.
  key = key.replace(/-(t2i|t2v|i2i|i2v|r2v|flf2v|edit)$/i, "");
  if (MODEL_ALIASES[key]) key = MODEL_ALIASES[key];
  return MODEL_WHITELIST[key] ?? null;
}

/**
 * Chunk-chained long-form video. Each call is one ordinary H3 Max generation
 * whose reference is the END of the previous clip, so a sequence of calls walks
 * a scene forward past any single clip's 15s ceiling.
 *
 * Not offered to the in-app agent panel: that path dispatches only
 * generate_media / transform_media / generate_music, so it is served to the MCP
 * bridge alone (see /api/agent/tools).
 */
/** Snap real pixel dimensions to the nearest aspect-ratio label we can send. */
function nearestAspectLabel(width: number, height: number): string {
  const presets: Array<[string, number]> = [
    ["1:1", 1], ["4:3", 4 / 3], ["3:4", 3 / 4],
    ["16:9", 16 / 9], ["9:16", 9 / 16],
    ["21:9", 21 / 9], ["3:2", 3 / 2], ["2:3", 2 / 3],
  ];
  const r = width / height;
  let bestLabel = "1:1";
  let bestDiff = Infinity;
  for (const [label, value] of presets) {
    const d = Math.abs(r - value);
    if (d < bestDiff) { bestDiff = d; bestLabel = label; }
  }
  return bestLabel;
}

const CONTINUE_VIDEO_TOOL: Tool = {
  name: "continue_video",
  description:
    "Continue an existing video clip with a new clip that picks up where it ended, using MiniMax H3 Max (default) or Seedance 2.5. Call this repeatedly — feeding each result's URL back in as the next `sourceUrl` — to build long-form video past the 15s per-clip limit. Use it whenever the user wants a video longer than 15 seconds, a multi-shot sequence, or 'what happens next' from a clip already on the canvas. The result lands on the canvas like any other generation.",
  input_schema: {
    type: "object",
    properties: {
      sourceUrl: {
        type: "string",
        description: "URL of the clip to continue from — usually the result URL of the previous continue_video or generate_media call. Get it from list_canvas if the user is pointing at something already on the canvas.",
      },
      prompt: {
        type: "string",
        description: "What happens in THIS chunk only. Open with the sequence's look and locked subject description repeated verbatim (the previous clip's tail shows the model the picture, not your words), name which beat of the arc this chunk serves, give ONE action, and end with what the chunk ends on — a holdable rest pose for seam='frame', or the motion the next chunk continues for seam='reference'. A changed adjective is how a sequence drifts.",
      },
      model: {
        type: "string",
        enum: ["h3-max", "h3-turbo", "seedance-2.5"],
        description: "Model family for this chunk. 'h3-max' (default), 'h3-turbo' (same ladder, faster/cheaper; frame seams only — a reference seam on it rides h3-max-r2v) or 'seedance-2.5' — seedance takes chunks up to 30s (fewer seams) and does native audio; keep the SAME model across every chunk of one sequence, mixing families drifts the look.",
      },
      seam: {
        type: "string",
        enum: ["frame", "reference"],
        description: "How to join the chunks. 'frame' (default) starts the new clip on the previous clip's exact final frame — a hard, invisible cut, best for continuous action within one shot. 'reference' feeds the previous clip's final seconds as a motion/subject reference — a softer join that carries movement and identity but not an exact frame, best across a cut or when the camera changes.",
      },
      durationSeconds: {
        type: "integer",
        minimum: 4,
        maximum: 30,
        description: "Length of this chunk in seconds (default 5). h3-max takes 5-15; seedance-2.5 takes 4-30. Out-of-range values snap. Longer chunks mean fewer seams for the same runtime.",
      },
      tailSeconds: {
        type: "number",
        minimum: 2,
        maximum: 15,
        description: "Only for seam='reference': how many seconds off the end of the source clip to use as the reference (2-15, default 6, clamped to the source clip's length). Longer carries more motion context and costs nothing extra.",
      },
      referenceUrls: {
        type: "array",
        items: { type: "string" },
        maxItems: 4,
        description: "Only for seam='reference': up to 4 image URLs of the sequence's locked subjects (character stills, palette frames) to pin alongside the tail. The tail only carries the last few seconds — these stills are what hold identity together once the sequence is many chunks long. Pass the SAME urls on every chunk.",
      },
      resolution: {
        type: "string",
        enum: ["480p", "720p", "768p", "1080p"],
        description: "Output resolution (h3-max: 480p/768p; seedance-2.5: 480p/720p/1080p — each model snaps to its nearest). Keep it the same across every chunk of one sequence.",
      },
      aspectRatio: {
        type: "string",
        enum: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
        description: "The sequence's aspect ratio. Defaults to the source clip's own shape on either seam; pass it only to change it, which you should never do mid-sequence.",
      },
      generateAudio: {
        type: "boolean",
        description: "Whether this chunk generates its own audio (default true). Pass false on every chunk of a scored piece — a bed that restarts at each seam is audible even when the picture joins cleanly.",
      },
    },
    required: ["sourceUrl", "prompt"],
  },
};

const GENERATE_MEDIA_TOOL: Tool = {
  name: "generate_media",
  description:
    "Fire an image or short video generation. The result will appear inline in the chat as a card the user can drag to the canvas. Call this whenever the user asks to make / generate / create an image, picture, illustration, render, photo, video, clip, or animation. Do NOT call it for prompt critique, brainstorming, or general chat. May be called up to 5 times in one turn (e.g. multiple variations or an image + matching video).",
  input_schema: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: ["image", "video"],
        description: "Whether to generate an image or a short video.",
      },
      prompt: {
        type: "string",
        description:
          "A concise, vivid English prompt (1–3 sentences) describing what to generate. Do not wrap in code fences.",
      },
      model: {
        type: "string",
        enum: ["nano-banana-2", "gpt-image-2", "seedream", "seedream-5", "seedance-2.5", "seedance-2.0", "gemini-omni", "kling-o3-pro", "kling-o3-4k", "veo3.1-lite", "h3-max", "h3-turbo"],
        description:
          "Optional explicit model override. Use ONLY when the user names a model directly. Otherwise omit and use `tier`. Image: 'nano-banana-2' (premium default), 'gpt-image-2' (premium alt with quality control), 'seedream' (quick, v4.5), 'seedream-5' (Seedream 5 Lite — newer, cheaper, 2K-4K native). Video: 'seedance-2.5' (premium default — up to 30s in one shot, native audio, up to 30 reference images), 'seedance-2.0' (previous generation), 'kling-o3-pro' (quality), 'kling-o3-4k' (quality, 4K resolution), 'veo3.1-lite' (quick), 'gemini-omni' (Gemini Omni Flash 1.1 — text-to-video and image-to-video with native audio, 3-10s, up to 4K), 'h3-max' (MiniMax H3 Max — text-to-video, image-to-video, and reference-to-video; the only family that can chain clips into long-form), 'h3-turbo' (MiniMax H3 Max Turbo — same ladder, faster, text-to-video and image-to-video only, no reference-to-video and no long-form chaining).",
      },
      tier: {
        type: "string",
        enum: ["premium", "quality", "quick"],
        description:
          "Model tier. Default 'premium' (best: nano-banana-2 for images, seedance-2.5 for video). 'quality' is the mid step (kling-o3-pro for video — image 'quality' falls back to nano-banana-2). 'quick' is the cheap/fast option (seedream for images) — only use it when the user explicitly asks for cheap, fast, draft, rough, or 'save credits'. Ignored when `model` is set. Tier does NOT affect text-to-video: video generated from a prompt alone is always MiniMax H3 Max. Tier only picks the video family when a reference image is attached.",
      },
      aspectRatio: {
        type: "string",
        enum: ["1:1", "4:3", "3:4", "16:9", "9:16", "21:9", "3:2", "2:3"],
        description: "Aspect ratio. Defaults to 1:1 if unspecified.",
      },
      quality: {
        type: "string",
        enum: ["low", "medium", "high"],
        description:
          "Optional explicit quality override. Only set this when the user explicitly requests a quality level; otherwise omit and the system will pick the default for the tier.",
      },
      resolution: {
        type: "string",
        enum: ["1k", "2k", "4k"],
        description:
          "Image output resolution. Set this whenever the user mentions a resolution (e.g. '2K', '4k', 'high res', 'ultra HD'). Defaults to '1k' when unspecified. Ignored for video.",
      },
      videoResolution: {
        type: "string",
        enum: ["480p", "720p", "768p", "1080p"],
        description:
          "Video output resolution. Set it when the user names one ('480p', 'draft res', '1080p', 'full HD'). Omit for the 720p default. Ignored for images. Each model clamps to what it actually supports (H3 Max/Turbo: 480p or 768p; 768p on other models renders 720p).",
      },
      durationSeconds: {
        type: "integer",
        minimum: 3,
        maximum: 15,
        description:
          "Video clip length in seconds. ONLY for kind='video'. Set this whenever the user mentions a clip length (e.g. '5 second video', '10s clip', 'make it 8 seconds long'). Omit when the user does not specify — the system will use the model's default (5s for Kling/Seedance, 6s for Veo3.1 Lite). Allowed range 3–15 (Kling O3 supports every integer in that range; Veo 3.1 Lite snaps to 4/6/8; Seedance accepts any integer 4–15); longer values cost more credits per second.",
      },
      referenceImageIds: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional ids of references to attach. Each id is one of the strings the system listed in the 'Available references' section of this turn (canvas attachments use ids like 'canvas:<n>'; prior agent generations use ids like 'agent:<n>' where n=1 is the most recent). For images: use ONLY when the user wants to iterate on a specific image; otherwise omit and the system will auto-attach the most recent inline image if the user is clearly referring to it. For video: ONLY pass when the user has clearly stated how the references should be used — see `videoReferenceMode` below; if the user attached an image to a video request without saying how to use it, do NOT call this tool, ASK them first.",
        maxItems: 4,
      },
      videoReferenceMode: {
        type: "string",
        enum: ["first_frame", "first_last_frame", "references"],
        description:
          "REQUIRED when kind='video' AND you're passing referenceImageIds. Tells the system how the user wants the references used. Three modes: 'first_frame' = single image becomes the starting frame of the clip (image-to-video). 'first_last_frame' = two images are the start and end frames (Veo 3.1 Lite only — the clip morphs from the first into the second). 'references' = 2-4 images are blended as a reference set (Seedance 2.0 supports up to 3; Kling O3 Pro / 4K supports up to 4 — subjects/styles are mixed into one clip). Infer the mode from explicit user words: 'starting from this' / 'animate this' / 'first frame' → first_frame; 'first and last frame' / 'morph from X to Y' / 'transition from A to B' → first_last_frame; 'use these as references' / 'blend these' / 'combine these subjects' → references. If the user attached an image to a video request but did NOT make the mode clear, do NOT call this tool — ASK them first in chat.",
      },
      generateAudio: {
        type: "boolean",
        description:
          "Optional, video-only. Whether the clip should have native generated audio. Defaults to true (audio ON) — leave unset for normal requests. Pass false ONLY when the user explicitly asks for a silent / muted / no-audio video (e.g. 'no sound', 'silent', 'mute the audio', 'without audio'). Ignored for image generations.",
      },
      use_logo: {
        type: "string",
        enum: ["auto", "light", "dark", "none"],
        description:
          "Brand IQ logo overlay control. 'auto' (default when an active brand is in scope and the user is asking for an on-brand asset — static ad, social post, banner, poster, marketing image, app icon, hero graphic, or anything they describe with 'our brand' / 'on-brand' / 'with our logo') = system composites the appropriate logo and picks light/dark from the dominant background tone in the prompt (e.g. 'on a dark navy background' → use dark-background variant). 'light' = force the light-background logo (the dark-colored mark). 'dark' = force the dark-background logo (the light-colored mark). 'none' = explicitly suppress logo overlay for this generation (e.g. user says 'no logo this time'). Do NOT include the logo in your prompt — overlay is handled at dispatch.",
      },
      respect_palette: {
        type: "boolean",
        description:
          "Brand IQ: when true (default when an active brand exists), the model is steered toward the brand's color palette in addition to whatever colors the user named. Pass false to ignore brand colors for this generation (e.g. 'completely off-brand for fun', 'use ONLY the colors I just listed').",
      },
      respect_typography: {
        type: "boolean",
        description:
          "Brand IQ: when true (default when an active brand exists AND the prompt requests on-image typography — text overlay, ad copy, headline, captions), the brand's display/body fonts are recorded in jobs.params so downstream renderers can apply them. Has no effect on prompts that don't include text.",
      },
    },
    required: ["kind", "prompt"],
  },
};

const GENERATE_MUSIC_TOOL: Tool = {
  name: "generate_music",
  description:
    "Generate a music track (song or instrumental). The result will appear inline in the chat as an audio card the user can drag to the canvas. Call this whenever the user asks to make / generate / create / compose a song, track, beat, jingle, anthem, soundtrack, or music. Do NOT call it for sound effects — those go through generate_media. Do NOT call it for prompt critique or brainstorming.",
  input_schema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "Style, mood, and genre description for the track (10–200 characters). Be specific: combine genre, mood, tempo, and instrumentation. Good: 'upbeat lo-fi hip hop with jazzy piano chords, warm vinyl crackle, 85 BPM chill vibes'. Bad: 'make some music'. This field drives the overall sound — lyrics drive the words.",
      },
      lyrics: {
        type: "string",
        description:
          "Song lyrics with structure tags that define the song's sections. ALWAYS use structure tags to mark each section — this is critical for good results. Available tags: [Intro], [Verse], [Pre Chorus], [Chorus], [Post Chorus], [Hook], [Bridge], [Interlude], [Transition], [Build Up], [Break], [Inst], [Solo], [Outro]. Example format:\n[Intro]\n(instrumental)\n\n[Verse]\nWalking through the city lights\nEvery shadow tells a story tonight\n\n[Chorus]\nWe're alive, we're on fire\nNothing's gonna stop us now\n\nOmit this field (or leave empty) when is_instrumental is true.",
      },
      is_instrumental: {
        type: "boolean",
        description:
          "Set to true for instrumental tracks with no vocals/lyrics. When true, omit the lyrics field. Defaults to false (vocal track with lyrics).",
      },
    },
    required: ["prompt"],
  },
};

const VOICE_IDS = [
  "Wise_Woman", "Friendly_Person", "Inspirational_girl", "Deep_Voice_Man", "Calm_Woman",
  "Casual_Guy", "Lively_Girl", "Patient_Man", "Young_Knight", "Determined_Man",
  "Lovely_Girl", "Decent_Boy", "Imposing_Manner", "Elegant_Man", "Abbess",
  "Sweet_Girl_2", "Exuberant_Girl",
] as const;

const GENERATE_VOICEOVER_TOOL: Tool = {
  name: "generate_voiceover",
  description:
    "Speak a line of script aloud — narration, voiceover, dialogue, an announcer read. Returns an audio URL you can lay on a cut's audio track with set_timeline. This is spoken words only: use generate_music for a music bed and generate_media for sound effects. Write the text the way it should be heard, punctuation and all — commas and full stops are what pace the read.",
  input_schema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description:
          "The exact words to speak, 1-3000 characters. Punctuate for delivery: a full stop is a beat, a comma is a breath. Don't include stage directions or speaker labels — everything here is read aloud.",
      },
      voice: {
        type: "string",
        enum: [...VOICE_IDS],
        description: "Which voice reads it. Defaults to Friendly_Person. Keep one voice per character across a whole piece.",
      },
      speed: {
        type: "number",
        description: "Delivery speed, 0.5-2.0 (default 1.0). Below 1 is slower and weightier; above 1 is brisk. A voiceover cut to picture usually wants 0.9-1.1.",
      },
      emotion: {
        type: "string",
        enum: ["neutral", "happy", "sad", "angry"],
        description: "Emotional colour of the read. Defaults to neutral.",
      },
    },
    required: ["text"],
  },
};

// ---------- generate_voiceover tool ----------

type AgentVoiceoverUse = {
  blockId: string;
  text: string;
  voice: string;
  speed: number;
  emotion: string;
};

function parseGenerateVoiceoverInput(
  block: ToolUseBlock,
): AgentVoiceoverUse | { error: string } {
  const input = (block.input ?? {}) as Record<string, unknown>;
  const text = typeof input.text === "string" ? input.text.trim().slice(0, 3000)
    : typeof input.prompt === "string" ? (input.prompt as string).trim().slice(0, 3000) : "";
  if (text.length < 1) return { error: "generate_voiceover needs `text` — the words to speak." };
  const voice = typeof input.voice === "string" && (VOICE_IDS as readonly string[]).includes(input.voice)
    ? input.voice : "Friendly_Person";
  const rawSpeed = Number(input.speed);
  const speed = isFinite(rawSpeed) && rawSpeed > 0 ? Math.max(0.5, Math.min(2, rawSpeed)) : 1;
  const emotion = typeof input.emotion === "string" && ["neutral", "happy", "sad", "angry"].includes(input.emotion)
    ? input.emotion : "neutral";
  return { blockId: block.id, text, voice, speed, emotion };
}

function buildVoiceoverBody(
  tool: AgentVoiceoverUse,
  canvasId: string,
  workspaceId: string | undefined,
): { type: string; body: Record<string, unknown>; resolvedModel: string } {
  return {
    type: "audio_tts",
    resolvedModel: "minimax-tts",
    body: {
      type: "audio_tts",
      model: "minimax-tts",
      // `prompt` is what the job row and the canvas card display; `text` is
      // what the model actually speaks.
      prompt: tool.text.slice(0, 300),
      text: tool.text,
      voice: tool.voice,
      speed: tool.speed,
      emotion: tool.emotion,
      canvas_id: canvasId,
      workspace_id: workspaceId,
      params: { source: "agent" },
    },
  };
}

// Static portion of the system prompt — identical across turns for a given
// (outputMode, includeMusicTool, includeVoiceoverTool) combination, so Anthropic
// can cache it.
// Excludes the per-turn reference catalog and the brand/product blocks
// (those go in the dynamic suffix).
function buildSystemPromptStatic(
  outputMode: "in_chat" | "on_canvas" = "in_chat",
  includeMusicTool: boolean = true,
  includeVoiceoverTool: boolean = false,
): string {
  // The user has chosen where their generations land this turn. In on-canvas
  // mode the chat does NOT show a media preview — the asset appears on the
  // canvas — so the agent must drop a single short status line so the chat
  // bubble isn't empty. For batch turns (>1 tool call) we hard-suppress
  // suggestions / follow-up questions / per-item narration — those are
  // sycophantic preamble that bloats output tokens and (worse) seems to
  // tempt the model into stopping after the first tool_use block to
  // "wait" for the user.
  const closingLine = outputMode === "on_canvas"
    ? [
        "CRITICAL OUTPUT FORMAT (on-canvas mode):",
        "Whenever you call generate_media, transform_media, or generate_music in this turn you MUST emit a short plain-text reply (one short status line) FIRST, then the tool_use block(s) — in that order, in the same assistant response. The text block is REQUIRED so the chat bubble isn't empty.",
        "Single tool call: one short sentence stating what's landing on the canvas (e.g. \"Putting a moody cyberpunk skyline at dusk onto your canvas.\"). You MAY add one short optional follow-up suggestion if it actually helps (e.g. \"Want a daytime version?\"). Keep it to 1–2 sentences total.",
        "Multiple tool calls (batch, >1): one short status line stating the count and gist (e.g. \"Putting 5 cat-surfing clips onto your canvas.\" or \"Generating 4 logo variations.\") and then ALL tool_use blocks back-to-back in the same reply. Do NOT narrate items individually, do NOT propose next steps, do NOT ask follow-up questions, do NOT offer variations — just the status line and the tool_use blocks.",
        "Forbidden in tool-calling turns: preamble (\"Sure!\", \"Of course\", \"Happy to\", \"Let me…\"), restating the prompt, listing tool parameters, narrating results, asking for confirmation, offering refinements beyond the single optional suggestion above. If you're not calling any tool this turn (pure chat / brainstorm / question), reply normally with no special formatting.",
      ].join("\n")
    : [
        "OUTPUT FORMAT (in-chat mode):",
        "Single tool call: write a short status line (one sentence) before the tool_use block, then end the turn. Do not narrate the result.",
        "Multiple tool calls (batch, >1): one short status line stating the count, then ALL tool_use blocks back-to-back. No per-item narration, no suggestions, no follow-up questions. End the turn.",
        "Forbidden in tool-calling turns: preamble (\"Sure!\", \"Of course\"), restating the prompt, listing tool parameters, narrating results, asking for confirmation.",
      ].join("\n");
  // Anti-phantom rule: a "phantom turn" is when the model writes narration
  // like "creating it now…" / "I'll generate that for you" but emits ZERO
  // tool_use blocks. The user sees a chat reply that promises a generation,
  // but nothing actually runs — the canvas stays empty and the agent often
  // self-corrects on the next turn ("I actually didn't call the tool last
  // time"). Calling this out explicitly in the system prompt is the cheapest
  // mitigation; the server-side detector below catches the residual cases
  // and surfaces a failed card.
  const toolList = [
    "generate_media", "transform_media",
    ...(includeMusicTool ? ["generate_music"] : []),
    ...(includeVoiceoverTool ? ["generate_voiceover"] : []),
  ].join(" + ");
  // Appended rather than woven into the numbered intro so the two gates stay
  // independent — a speech turn with no music intent still reads correctly.
  const voiceoverLine = includeVoiceoverTool
    ? "\n\nYou can also SPEAK: when the user asks for a voiceover, narration, a spoken line, dialogue, an announcer read, or text read aloud — call the generate_voiceover tool with the exact words to speak. It returns an audio card like generate_music does. generate_voiceover is for spoken words; generate_music is for a music bed. A request for both (\"a jingle with a voiceover over it\") is two tool calls in the same turn, not one."
    : "";
  const noPhantomLine =
    `Tool-call honesty (HARD RULE): if your reply says — or even implies — that you are creating, generating, making, rendering, drawing, composing, transforming, upscaling, or removing the background of something, you MUST emit a matching tool_use block (one of: ${toolList}) in the SAME turn. Narration without a tool_use block is a bug — it leaves the user with an empty promise. If you decide NOT to call a tool (asking a clarifying question, brainstorming, declining), do NOT use generation verbs in the present/future tense — say what you're doing instead (\"Want me to generate it?\" / \"Tell me X first\") rather than \"I'll create it now\".`;
  const noFalseRefusalLine =
    "Web-search honesty (HARD RULE): you have a working web_search tool available RIGHT NOW in this conversation. Do NOT claim you can't browse the web, can't look things up, don't have internet access, can't access live information, or that your knowledge is frozen at a training cutoff. If the user asks for current/recent info, news, today's date or weather, prices, scores, lyrics, specs, or anything that needs a citation or is past your training cutoff — call web_search instead of refusing or hedging. Refusing to search when a search would answer the question is a bug. The only acceptable reasons NOT to search are: (a) the answer is a stable well-known fact you already know, or (b) the user explicitly told you not to search.";
  const intro = includeMusicTool
    ? [
        "You are an AI co-pilot embedded in a creative canvas tool. You can do five things:",
        "  (1) hold a normal conversation: critique reference images, brainstorm prompt ideas, suggest variations.",
        "  (2) fire an image or short video generation directly into the chat by calling the generate_media tool.",
        "  (3) transform an existing image (background removal, upscale, resize) by calling the transform_media tool.",
        "  (4) create a music track (vocal song or instrumental) by calling the generate_music tool.",
        "  (5) look things up on the live web by calling the web_search tool — current events, fresh references, product specs, song lyrics / artists, anything past your training cutoff or that needs a citation. Cite the sources you used in your reply. Don't web-search for stable / well-known facts you already know.",
        "",
        "When the user clearly asks to make / generate / create / render an image, picture, illustration, photo, video, clip, or animation — call the generate_media tool. When they ask to remove a background, upscale, enlarge, resize / outpaint / expand to a new aspect ratio — call the transform_media tool instead. When they ask to make / generate / create / compose a song, track, beat, jingle, anthem, soundtrack, or music — call the generate_music tool. When they ask about something current, recent, or that needs a source — use web_search first, then answer (and feel free to feed what you learned into a follow-up generate_media / generate_music call in the same turn if they asked you to make something about it). Each generation tool streams its result inline as a card the user can drag to the canvas. Tool-calling turns are batch jobs, not dialogue — write one short status line, fire ALL tool_use blocks for the request in this single turn, then stop. No preamble, no acknowledgment beyond the status line, no commentary, no offers, no pasting the prompt back. The output format rules at the end of this prompt are authoritative.",
      ].join("\n")
    : [
        "You are an AI co-pilot embedded in a creative canvas tool. You can do four things:",
        "  (1) hold a normal conversation: critique reference images, brainstorm prompt ideas, suggest variations.",
        "  (2) fire an image or short video generation directly into the chat by calling the generate_media tool.",
        "  (3) transform an existing image (background removal, upscale, resize) by calling the transform_media tool.",
        "  (4) look things up on the live web by calling the web_search tool — current events, fresh references, product specs, anything past your training cutoff or that needs a citation. Cite the sources you used in your reply. Don't web-search for stable / well-known facts you already know.",
        "",
        "When the user clearly asks to make / generate / create / render an image, picture, illustration, photo, video, clip, or animation — call the generate_media tool. When they ask to remove a background, upscale, enlarge, resize / outpaint / expand to a new aspect ratio — call the transform_media tool instead. When they ask about something current, recent, or that needs a source — use web_search first, then answer (and feel free to feed what you learned into a follow-up generate_media call in the same turn if they asked you to make an image about it). Each generation tool streams its result inline as a card the user can drag to the canvas. Tool-calling turns are batch jobs, not dialogue — write one short status line, fire ALL tool_use blocks for the request in this single turn, then stop. No preamble, no acknowledgment beyond the status line, no commentary, no offers, no pasting the prompt back. The output format rules at the end of this prompt are authoritative.",
      ].join("\n");
  const multiCallLine = [
    `BATCH MODE (HARD RULE — read this before anything else): a tool-calling turn is a batch job, NOT a back-and-forth dialogue. When the user asks for N items (videos, images, songs, transforms, or any mix), you MUST emit all N tool_use blocks in THIS single assistant turn, back-to-back, before stopping. Do not pause for confirmation. Do not stop after the first tool_use block. Do not wait for the user to react. Do not split a batch across multiple turns. The system runs at most ${MAX_GENERATIONS_PER_TURN} generation tool calls per reply (${toolList} combined; web_search does NOT count).`,
    `  • If the user asks for N independent items (e.g. '5 video clips of a cat surfing', '10 logo ideas', '3 variations', 'an image and a matching video', '4 logo variations and a matching video', 'remove the bg and then upscale 2x', 'make a song and album cover'): emit exactly N tool_use blocks IN PARALLEL in this single reply (capped at ${MAX_GENERATIONS_PER_TURN}). All N must appear together. Video clips follow the same rule as images — '5 clips of X' fires 5 parallel generate_media calls in this same turn, no exceptions, no matter how heavy the operation feels.`,
    `  • Mixed batches ('3 clips of X and 2 of Y' = 5 calls; '4 logo variations and a matching video' = 5 calls): add the counts and emit that many tool_use blocks in this single turn.`,
    `  • If N > ${MAX_GENERATIONS_PER_TURN}, emit exactly ${MAX_GENERATIONS_PER_TURN} tool_use blocks and tell the user in your one-line status that you stopped at ${MAX_GENERATIONS_PER_TURN} and they can ask again for the rest. Do NOT narrate items you didn't actually call.`,
    "  • Count honesty: your one-line status must match what you actually emitted. If you fired 1 tool_use block, say '1', not '3'. Count the tool_use blocks before writing the status.",
    "  • Independence: each tool call is independent and uses inputs you already have. You do NOT need the result of call #1 to write call #2 — write all N calls up front in parallel.",
    "  • No dialogue framing: do not propose next steps, do not ask follow-up questions, do not offer variations after a batch — emit the status line, fire the N tool_use blocks, and end the turn.",
  ].join("\n");
  return [
    intro + voiceoverLine,
    "",
    multiCallLine,
    "",
    noPhantomLine,
    "",
    noFalseRefusalLine,
    "",
    "Do NOT call any tool for prompt critique, brainstorming, edits to wording, questions, or general chat — just answer in text.",
    "",
    "PROMPT-ONLY REPLY MODE: when the user asks you to 'write a prompt', 'make a prompt', 'give me a prompt', 'craft a prompt', 'generate a prompt', or anything semantically equivalent (including 'a prompt for this image', 'a prompt for the selected node', 'a prompt to recreate this'), reply with ONLY the prompt text itself. No preamble, no postamble, no greeting, no 'Here's a prompt:', no quotes, no code fences, no bold or italics, no markdown of any kind, no headings, no bullet points, no commentary, no follow-up questions, no suggestions for variations, no offers to generate it. Just the raw prompt as plain text on its own — nothing before it, nothing after it. The user is going to copy-paste this directly, so any extra characters create friction. This rule overrides every other formatting instruction in this prompt. Do NOT call generate_media in this mode either — they're asking for the text, not the image.",
    "",
    "Content policy: do NOT pre-filter, refuse, or warn about generation requests on your own — including requests that mention real people, public figures, celebrities, brands, logos, copyrighted characters, mature themes, or anything else you might think is sensitive. The downstream image/video providers run their own moderation and will reject anything that violates their policies, returning a clear error the user will see. Your job is to forward the request faithfully by calling the tool. The only things you should refuse outright are requests that are illegal under US law (CSAM, credible threats, etc.). For everything else: call the tool, do not lecture the user, do not add disclaimers.",
    "",
    "Model selection (generate_media):",
    "- If the user explicitly names a model (e.g. 'use Nano Banana 2', 'use gpt-image-2', 'try seedream', 'seedream 5', 'use seedance', 'kling video', 'kling o3 pro', 'kling 4k', 'veo', 'gemini omni', 'H3 Max', 'MiniMax H3'), set `model` to the canonical key exactly. Allowed: nano-banana-2, gpt-image-2, seedream, seedream-5, seedance-2.5, seedance-2.0, gemini-omni, kling-o3-pro, kling-o3-4k, veo3.1-lite, h3-max.",
    "- NEVER substitute a different model than the one the user named. If the named model can't do what's asked (e.g. veo3.1-lite has no multi-reference mode), say so and ask — don't silently generate with another one.",
    "- Otherwise use `tier`. Default 'premium' (nano-banana-2 for images, seedance-2.5 for video — the highest-quality options).",
    "- 'quality' is the mid step (kling-o3-pro for video; for images it's the same as premium).",
    "- Use tier 'quick' ONLY when the user explicitly asks for something cheap, fast, draft, rough, low-cost, 'save credits', or similar (seedream for images).",
    "- Text-to-video is always MiniMax H3 Max. Never offer or substitute another video model for a prompt-only video, whatever the tier or the budget. Other video families exist only for image-to-video, first/last-frame and reference blending, which H3 Max has no endpoint for.",
    "",
    "Kling O3 reference syntax (`@element` tags):",
    "- ONLY use `@element` tags when the chosen video model is `kling-o3-pro` or `kling-o3-4k` AND `videoReferenceMode='references'` (the reference-blending r2v mode). In every other case — including Kling first_frame (i2v) and every other model — DO NOT put `@element` tags in the prompt.",
    "- When you do use them: include one `@elementN` for each reference image, in order. `@element1` is the first reference, `@element2` is the second, etc. The number of `@elementN` tags must NOT exceed the number of references you are passing.",
    "- Example (references mode, two refs): \"A wide shot of @element1 standing in @element2 at sunset, cinematic lighting.\"",
    "- For Kling first_frame mode (single starting image), describe the subject in plain language — do NOT write `@element1`. The starting frame is implicit.",
    "",
    "Quality:",
    "- Omit `quality` unless the user explicitly asks for a level (e.g. 'high quality', 'low quality draft'). The system will pick the right default for the tier.",
    "",
    "Resolution (image only):",
    "- If the user mentions a resolution (e.g. '2K', '4k', 'high res', 'ultra HD'), set `resolution` to '1k', '2k', or '4k' accordingly.",
    "- Otherwise omit it and the system will default to '1k'.",
    "",
    "Duration (video only):",
    "- If the user names a video resolution ('480p', '720p', '1080p', 'full HD', 'draft quality'), set `videoResolution`. H3 Max only does 480p or 768p, so it renders 720p/1080p requests at 768p.",
    "- If the user mentions a clip length (e.g. '5 second video', '10s clip', 'make it 8 seconds long', 'short clip', 'long video'), set `durationSeconds` to an integer between 3 and 15.",
    "- Map vague words: 'short' → 5, 'medium' → 8, 'long' → 12. For unit-less numbers obviously meant as seconds in a video request ('a 7 video'), use that number.",
    "- Otherwise omit `durationSeconds` and the system will use the model's default (5s for Kling/Seedance, 6s for Veo3.1 Lite).",
    "- Per-model behavior: Kling O3 (Pro / 4K) accepts every integer 3–15. Veo 3.1 Lite snaps to 4, 6, or 8. Seedance accepts every integer 4–15.",
    "- Longer clips cost proportionally more credits (per-second pricing).",
    "",
    "Transform tool (transform_media):",
    "- operation='remove_background': just needs `referenceImageId`. No prompt, no aspect.",
    "- operation='upscale': set `referenceImageId` and optionally `upscaleFactor` (2 or 4, defaults to 2).",
    "- operation='resize': set `referenceImageId` and `aspectRatio` (the new shape). Optionally a short `prompt` describing what to fill the new edges with (e.g. 'extend the sky').",
    "- All three require a reference image — never guess an id, only use one listed in 'Available references' below. If no reference is available, ask the user to attach an image instead of calling the tool.",
    "",
    "References:",
    "(The list of available references for THIS turn is appended at the end of this prompt under 'Available references this turn'.)",
    "- For generate_media (image): set `referenceImageIds` ONLY when the user clearly wants to iterate on a specific image (e.g. 'edit this canvas one', 'go back to the first generation'). Otherwise omit it. When the user says 'make it warmer', 'try again', etc., you may omit `referenceImageIds` and the system will auto-attach the most recent inline generation.",
    "- For generate_media (video) — references are NEVER auto-attached. Only pass `referenceImageIds` when the user has clearly stated how the references should be used, AND set `videoReferenceMode` accordingly:",
    "    • 'first_frame' — single image is the starting frame (i2v). Triggers: 'animate this', 'starting from this image', 'use this as the first frame', 'image to video', 'make this move'.",
    "    • 'first_last_frame' — two images are the start and end frames (Veo 3.1 Lite only). Triggers: 'first frame and last frame', 'morph from this to that', 'transition from A to B', 'start with X end with Y'.",
    "    • 'references' — 2-4 images blended as a reference set (Seedance 2.0 up to 3, Kling O3 Pro / 4K up to 4). Triggers: 'use these as references', 'blend these', 'combine these subjects', 'mix these into a clip'.",
    "- IF the user asks for a video AND references are available BUT they have NOT clearly indicated which mode they want, do NOT call generate_media yet. Instead, reply in chat asking: 'Do you want to use this image as the starting frame, or as the first and last frames, or as references to blend? Let me know and I'll generate the video.' Wait for their answer before calling the tool.",
    "- For transform_media: `referenceImageId` is REQUIRED — pass exactly one id from the list above.",
    "",
    "Aspect ratio (generate_media): default to 1:1 unless the user asks otherwise or the subject obviously demands a different ratio (e.g. 'wallpaper' → 16:9, 'phone screen' → 9:16).",
    "",
    "Audio (generate_media, video only): native audio is ON by default — leave `generateAudio` unset for normal video requests. Pass `generateAudio: false` ONLY when the user clearly asks for a silent / muted / no-audio clip (e.g. 'no sound', 'silent video', 'mute the audio', 'without audio'). Audio enables voice/sound for Veo and Kling at a small per-second surcharge that the system charges automatically; for Seedance audio is included at no extra cost.",
    "",
    includeVoiceoverTool ? [
      "Voiceover generation (generate_voiceover tool):",
      "- Call generate_voiceover when the user asks for a voiceover, narration, a spoken line, dialogue, an announcer read, a VO track, or text read aloud.",
      "- `text` is the exact words spoken — no speaker labels, no stage directions, nothing the listener shouldn't hear. Punctuate for delivery: a full stop is a beat, a comma is a breath.",
      "- One call per line or paragraph you want as its own clip. A 4-line script the user wants to cut to picture is 4 calls in this turn, not one blob.",
      "- `voice` defaults to Friendly_Person. Keep the same voice for the same character across a whole piece; only switch voices for a different speaker.",
      "- `speed` defaults to 1.0 (0.5–2.0). Cut-to-picture narration usually wants 0.9–1.1. `emotion` defaults to neutral.",
      "- Spoken words only. Music beds are generate_music; sound effects are not this tool.",
      "",
    ].join("\n") : "",
    includeMusicTool ? [
      "Music generation (generate_music tool):",
      "- Call generate_music when the user asks to create a song, track, beat, jingle, anthem, soundtrack, composition, or music.",
      "- The `prompt` field is for style, mood, genre, and instrumentation (10–200 chars). Be specific and descriptive — combine genre + mood + tempo + key instruments. Example: 'ethereal indie dream pop with shimmering synths, reverb-drenched guitars, breathy female vocals, 120 BPM'.",
      "- The `lyrics` field MUST use structure tags to define song sections. Available tags: [Intro], [Verse], [Pre Chorus], [Chorus], [Post Chorus], [Hook], [Bridge], [Interlude], [Transition], [Build Up], [Break], [Inst], [Solo], [Outro].",
      "- Structure tag best practices:",
      "  • Start with [Intro] (can be instrumental: just write '(instrumental)' or describe the opening sound).",
      "  • Use [Verse] for narrative lines, [Chorus] for the main hook/repeated section.",
      "  • Add [Bridge] for contrast/emotional shift before the final chorus.",
      "  • Use [Inst], [Solo], or [Break] for instrumental passages within a vocal track.",
      "  • End with [Outro] for a clean finish.",
      "  • Each section tag goes on its own line, followed by the lyrics for that section.",
      "- For instrumental tracks: set `is_instrumental: true` and omit lyrics. The prompt alone drives the generation.",
      "- When the user provides lyrics without structure tags, add appropriate tags yourself based on the lyric flow.",
      "- When the user describes a song concept but doesn't write lyrics, compose fitting lyrics with proper structure tags.",
      "- Music generation costs more credits than images (~30 credits). Mention this only if the user asks about cost.",
      "",
    ].join("\n") : "",
    closingLine,
  ].filter(Boolean).join("\n");
}

// Dynamic suffix appended to the system prompt — varies per turn (reference
// catalog, brand, products) and is therefore NOT cached. Returns the empty
// string when there's nothing to append.
function buildSystemPromptDynamic(
  refCatalog: string[],
  brand: BrandContext | null = null,
  products: ProductContext[] = [],
): string {
  const parts: string[] = [];
  if (refCatalog.length > 0) {
    parts.push(
      "",
      "Available references this turn (use the id as a string in `referenceImageIds`):",
      ...refCatalog.map((line) => `  - ${line}`),
    );
  } else {
    parts.push("", "No references attached this turn.");
  }
  if (products.length > 0) {
    parts.push(buildProductsSystemBlock(products));
  }
  if (brand) {
    parts.push(
      `\n--- ACTIVE BRAND ---\n${buildBrandSystemBlock(brand)}\nWhen the user asks for brand-aligned output (logo placement, ad, promo, banner, social post, packaging, slide), automatically pass the relevant brand reference id(s) — \`brand:logo_light\`, \`brand:logo_dark\`, \`brand:graphic:N\` — in \`referenceImageIds\` so the generator sees them. Match the palette + typography in the brief.`
    );
  }
  return parts.filter(Boolean).join("\n");
}

// Walk the conversation in reverse and return the most recent inline-generated
// image URLs the agent should consider as implicit references. Only assistant
// messages with images of source 'agent' contribute. Cap to keep prompts bounded.
function collectInlineImageHistory(messages: ClientMessage[], cap = 3): string[] {
  const out: string[] = [];
  for (let i = messages.length - 1; i >= 0 && out.length < cap; i--) {
    const m = messages[i];
    if (m.role !== "assistant" || !Array.isArray(m.images)) continue;
    for (const img of m.images) {
      if (!img || typeof img.url !== "string" || !img.url) continue;
      if (img.source && img.source !== "agent") continue;
      // Skip non-image inline gens (videos) — they cannot be used as image
      // references for downstream image/video generation, and treating a
      // video URL as an image-ref would fail the model call.
      if (img.kind === "video") continue;
      // Treat assistant-attached images as agent generations by default.
      out.push(img.url);
      if (out.length >= cap) break;
    }
  }
  return out;
}

// Collect canvas/attachment images from the most recent user message so they
// can be addressed by structured ids ('canvas:1' = first attachment in the
// latest user turn). User-pinned "Edit with agent" refs (source === "agent")
// are listed FIRST so they get the lowest canvas:N indices and are visible
// to Claude as primary references. Capped to keep prompts bounded.
function collectCanvasAttachments(messages: ClientMessage[], cap = 4): string[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (!Array.isArray(m.images)) return [];
    const pinned: string[] = [];
    const attachments: string[] = [];
    for (const img of m.images) {
      if (!img || typeof img.url !== "string" || !img.url) continue;
      // Skip video refs — generation models can't accept a video as a
      // reference image. (A future video-to-video pipeline could relax this.)
      if (img.kind === "video") continue;
      if (img.source === "agent") pinned.push(img.url);
      else attachments.push(img.url);
    }
    return [...pinned, ...attachments].slice(0, cap);
  }
  return [];
}

// Return only the user-pinned ("Edit with agent") references from the latest
// user message, preserving order. Used as the highest-priority implicit
// fallback when Claude does not pass explicit referenceImageIds.
function collectPinnedRefs(messages: ClientMessage[], cap = 4): string[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (!Array.isArray(m.images)) return [];
    const out: string[] = [];
    for (const img of m.images) {
      if (!img || typeof img.url !== "string" || !img.url) continue;
      if (img.source !== "agent") continue;
      // Skip pinned video refs — they cannot be used as image references.
      if (img.kind === "video") continue;
      out.push(img.url);
      if (out.length >= cap) break;
    }
    return out;
  }
  return [];
}

// Build a human-readable catalog of the references available this turn so the
// system prompt can show Claude which ids it may pass back in
// `referenceImageIds`.
function buildReferenceCatalog(canvas: string[], inline: string[]): string[] {
  // De-duplicate by resolved URL while preserving stable IDs:
  //   - canvas IDs always keep their slot (canvas:N maps to the Nth
  //     attachment regardless of duplicates elsewhere — id stability is
  //     more important than catalog compactness for canvas refs).
  //   - agent IDs that point at a URL already represented by a canvas
  //     entry are suppressed (the user can address it via canvas:N).
  //   - duplicate inline agent URLs collapse to the earliest agent:N.
  const out: string[] = [];
  const seen = new Set<string>();
  canvas.forEach((url, i) => {
    out.push(`canvas:${i + 1} — attached canvas image ${i + 1}`);
    if (typeof url === "string" && url) seen.add(url);
  });
  inline.forEach((url, i) => {
    if (typeof url === "string" && url) {
      if (seen.has(url)) return;
      seen.add(url);
    }
    out.push(`agent:${i + 1} — prior agent generation (${i === 0 ? "most recent" : `${i + 1} ago`})`);
  });
  return out;
}

// Resolve a list of structured reference ids (canvas:N / agent:N) to URLs.
// Unknown ids are silently dropped. Returns up to `cap` URLs.
function resolveReferenceIds(
  ids: string[] | undefined,
  canvas: string[],
  inline: string[],
  cap = 4,
  brand: BrandContext | null = null,
  productMap: Map<string, string> | null = null,
): string[] {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const out: string[] = [];
  const brandLogos: Record<string, string | null> = brand
    ? { logo_light: brand.logoLightUrl, logo_dark: brand.logoDarkUrl }
    : {};
  for (const raw of ids) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim().toLowerCase();
    // product:<slug> / product:<slug>:<n>
    if (productMap && trimmed.startsWith("product:")) {
      const url = productMap.get(trimmed);
      if (url && !out.includes(url)) out.push(url);
      if (out.length >= cap) break;
      continue;
    }
    // brand:logo_light / brand:logo_dark / brand:graphic:N
    const brandLogo = trimmed.match(/^brand:(logo_light|logo_dark)$/);
    if (brandLogo && brand) {
      const url = brandLogos[brandLogo[1]];
      if (url && !out.includes(url)) out.push(url);
      if (out.length >= cap) break;
      continue;
    }
    const brandGraphic = trimmed.match(/^brand:graphic:(\d+)$/);
    if (brandGraphic && brand) {
      const n = parseInt(brandGraphic[1], 10);
      if (Number.isFinite(n) && n >= 1 && n <= brand.graphicUrls.length) {
        const url = brand.graphicUrls[n - 1];
        if (url && !out.includes(url)) out.push(url);
        if (out.length >= cap) break;
      }
      continue;
    }
    const m = trimmed.match(/^(canvas|agent):(\d+)$/);
    if (!m) continue;
    const n = parseInt(m[2], 10);
    if (!Number.isFinite(n) || n < 1) continue;
    const src = m[1] === "canvas" ? canvas : inline;
    if (n > src.length) continue;
    const url = src[n - 1];
    if (url && !out.includes(url)) out.push(url);
    if (out.length >= cap) break;
  }
  return out;
}

// Pick the URLs we'll actually attach, with the implicit fallback rules:
//   1. If Claude provided structured ids → use those (validated).
//   2. Else if the user explicitly pinned refs via "Edit with agent" → use
//      those (deterministic — overrides recency-based fallback).
//   3. Else if user's text shows follow-up wording → auto-attach newest inline.
//   4. Else no reference.
function resolveAgentReferences(
  ids: string[] | undefined,
  canvas: string[],
  inline: string[],
  pinned: string[],
  lastUserText: string,
  kind: GenKind,
  videoReferenceMode: VideoReferenceMode | null,
  brand: BrandContext | null = null,
  productMap: Map<string, string> | null = null,
): string[] {
  const explicit = resolveReferenceIds(ids, canvas, inline, 4, brand, productMap);
  if (explicit.length > 0) {
    // For video, refs are only honored when the user has been explicit about
    // how to use them. Without a mode, dispatch as text-to-video — Claude is
    // told to ask the user first via the system prompt, but if it ignores
    // that and passes refs anyway, dropping them here is the safety net.
    if (kind === "video" && videoReferenceMode == null) return [];
    return explicit;
  }
  // Pinned refs (from "Edit with agent") are an explicit user gesture for
  // images. For video they still need a mode to be applied — same rule.
  if (pinned.length > 0) {
    if (kind === "video" && videoReferenceMode == null) return [];
    return pinned.slice(0, 4);
  }
  // Implicit follow-up auto-attach is image-only. Video iterations like
  // "make it again" should not silently re-feed the prior clip's first
  // frame as an i2v starting image.
  if (kind === "image" && inline.length > 0 && FOLLOWUP_RE.test(lastUserText)) return [inline[0]];
  return [];
}

type AgentResolution = "1k" | "2k" | "4k";

type AgentToolUse = {
  blockId: string;
  kind: GenKind;
  prompt: string;
  explicitModel: string | null;
  tier: GenTier;
  aspectRatio: string;
  // True only when Claude explicitly passed an aspectRatio (or aspect_ratio)
  // value that parsed into the allowed set. False when we fell back to the
  // default ("1:1") because the field was missing or off-catalog. Used by
  // the dispatch step to decide whether to override AR with a probed value
  // from the source image for image-to-video generations (i2v / flf2v).
  aspectRatioExplicit: boolean;
  quality: GenQuality;
  resolution: AgentResolution;
  // Video clip length in seconds. Only meaningful when kind === "video";
  // null means "use the backend default for the chosen video model"
  // (5s for Kling/Seedance, 6s for Veo3.1 Lite).
  /** Video output resolution. null → the 720p default. */
  videoResolution: string | null;
  durationSeconds: number | null;
  referenceImageIds?: string[];
  // Required when kind === "video" AND references will be attached. Tells
  // the system how the user wants the references used. null means the user
  // didn't specify; for video this is treated as "no refs" (pure t2v) at
  // dispatch time and Claude is instructed via the system prompt to ASK
  // the user before calling the tool when they're ambiguous.
  videoReferenceMode: VideoReferenceMode | null;
  // Whether the chosen video model should generate native audio. Defaults
  // to true (matches the Make-panel default); flipped to false when Claude
  // explicitly passes generateAudio=false OR the user's message asks for
  // a silent/no-audio video. Only meaningful when kind === "video".
  generateAudio: boolean;
  // Brand IQ flags. Resolved against the active brand at dispatch time
  // (when `brandContext` exists). Defaults reflect intent: use_logo true
  // for static-ad / poster / banner / marketing prompts, palette true
  // when an active brand exists, typography true when the prompt asks
  // for on-image text. logo_variant 'auto' picks light/dark from the
  // dominant background tone described in the prompt.
  useLogo: boolean | null;
  logoVariant: "light" | "dark" | "auto";
  respectPalette: boolean | null;
  respectTypography: boolean | null;
};

// Match common ways a user spells out a clip length in their request.
// Captures things like:
//   "5 second video", "10s clip", "8 sec video", "make it 12 seconds long"
// Returns null when nothing duration-y is mentioned.
const DURATION_RE = /\b(\d{1,2})\s*(?:s|sec|secs|second|seconds)\b/i;
function inferDurationFromText(text: string): number | null {
  if (!text) return null;
  const m = text.match(DURATION_RE);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n)) return null;
  // All current video backends accept somewhere in the 3–15s range (Kling
  // O3 goes down to 3s; Veo / Seedance start at 4s and snap upward in
  // snapDurationForModel). Clamp to that window so we never blow past a
  // model's hard limit.
  return Math.max(3, Math.min(15, n));
}

// Only fires when the user explicitly mentions a resolution. We require either:
//   (a) a numeric form preceded by "in/at" or followed by a resolution noun
//       (resolution / res / quality / detail), e.g. "at 2k", "in 4K resolution".
//   (b) "ultra HD" / "UHD" → 4k.
// We deliberately do NOT match bare phrases like "high quality" — that's a
// quality request, not a resolution request, and would conflate the two.
const RESOLUTION_RE = /\b(?:in|at)\s*([124])\s*[kK]\b|\b([124])\s*[kK]\s+(?:resolution|res|quality|detail|image|images|render|renders|output)\b|\b(ultra[\s-]?hd|uhd)\b/i;
function inferResolutionFromText(text: string): AgentResolution | null {
  if (!text) return null;
  const m = text.match(RESOLUTION_RE);
  if (!m) return null;
  const digit = m[1] || m[2];
  if (digit === "4") return "4k";
  if (digit === "2") return "2k";
  if (digit === "1") return "1k";
  // "ultra HD" / "UHD" → 4k.
  if (m[3]) return "4k";
  return null;
}

// Parse a generate_media tool_use block. Tolerates both camelCase and
// snake_case property names for backwards compatibility, and applies a
// cheap-intent fallback derived from the latest user message when Claude
// returns no tier (or an off-catalog one).
function parseGenerateMediaInput(
  block: ToolUseBlock,
  lastUserText: string,
): AgentToolUse | { error: string } {
  const input = (block.input ?? {}) as Record<string, unknown>;
  const kindRaw = input.kind;
  const kind: GenKind = kindRaw === "video" ? "video" : "image";
  const prompt = typeof input.prompt === "string" ? input.prompt.trim().slice(0, 4000) : "";
  if (!prompt) return { error: "Missing or empty prompt." };

  // Tier fallback: explicit value wins; otherwise infer from user intent.
  let tier: GenTier;
  if (input.tier === "quick") tier = "quick";
  else if (input.tier === "quality") tier = "quality";
  else if (input.tier === "premium") tier = "premium";
  else tier = CHEAP_INTENT_RE.test(lastUserText) ? "quick" : "premium";

  // aspectRatio (preferred) or aspect_ratio (legacy).
  const arRaw = typeof input.aspectRatio === "string"
    ? input.aspectRatio
    : (typeof input.aspect_ratio === "string" ? input.aspect_ratio : "");
  const aspectRatioExplicit = GEN_ALLOWED_AR.has(arRaw);
  const aspectRatio = aspectRatioExplicit ? arRaw : "1:1";

  const quality = clampQuality(input.quality, tier);

  // Resolution: explicit value wins; otherwise sniff the user's message for
  // "2k", "4k", "high res" etc. Defaults to 1k.
  const resRaw = typeof input.resolution === "string" ? input.resolution.toLowerCase() : "";
  let resolution: AgentResolution;
  if (resRaw === "1k" || resRaw === "2k" || resRaw === "4k") {
    resolution = resRaw;
  } else {
    resolution = inferResolutionFromText(lastUserText) ?? "1k";
  }

  // Duration (video only): explicit value wins; otherwise sniff the user's
  // message for "5 second video" / "10s clip" etc. null = backend default.
  const vresRaw = typeof input.videoResolution === "string" ? input.videoResolution.toLowerCase().trim() : "";
  // 768p is H3's real tier; the skill names it, so the tool must take it.
  const videoResolution = ["480p", "720p", "768p", "1080p"].includes(vresRaw) ? vresRaw : null;
  let durationSeconds: number | null = null;
  if (kind === "video") {
    const durRaw = input.durationSeconds ?? input.duration_seconds ?? input.duration;
    const durNum = typeof durRaw === "number" ? durRaw : parseInt(String(durRaw ?? ""), 10);
    if (Number.isFinite(durNum) && durNum > 0) {
      durationSeconds = Math.max(3, Math.min(15, Math.round(durNum)));
    } else {
      durationSeconds = inferDurationFromText(lastUserText);
    }
  }

  // Explicit model (whitelist applied at dispatch time so we can also validate
  // kind compatibility).
  const explicitModel = typeof input.model === "string" && input.model.trim().length > 0
    ? input.model.trim()
    : null;

  // referenceImageIds (preferred) or legacy reference_image_index (1-based
  // into prior inline gens — translated to 'agent:N' form).
  let referenceImageIds: string[] | undefined;
  if (Array.isArray(input.referenceImageIds)) {
    referenceImageIds = input.referenceImageIds
      .filter((s): s is string => typeof s === "string")
      .slice(0, 4);
  } else if (typeof input.reference_image_index === "number" && Number.isFinite(input.reference_image_index)) {
    const n = Math.floor(input.reference_image_index);
    if (n >= 1 && n <= 8) referenceImageIds = [`agent:${n}`];
  }

  // videoReferenceMode (video only). Accept the three canonical values plus
  // a few common aliases Claude might produce. Defaults to null so the
  // dispatch step can decide whether to ask the user or drop the refs.
  let videoReferenceMode: VideoReferenceMode | null = null;
  if (kind === "video") {
    const modeRaw = typeof input.videoReferenceMode === "string"
      ? input.videoReferenceMode
      : (typeof input.video_reference_mode === "string" ? input.video_reference_mode : "");
    const m = modeRaw.toLowerCase().trim();
    if (m === "first_frame" || m === "first-frame" || m === "i2v" || m === "start_frame" || m === "start") {
      videoReferenceMode = "first_frame";
    } else if (m === "first_last_frame" || m === "first-last-frame" || m === "first_and_last_frame" || m === "flf2v" || m === "flf" || m === "first_last") {
      videoReferenceMode = "first_last_frame";
    } else if (m === "references" || m === "reference" || m === "reference_set" || m === "r2v" || m === "blend") {
      videoReferenceMode = "references";
    }
  }

  // generateAudio (video only). Defaults to true (audio ON) — matches the
  // Make-panel default. Flipped to false when Claude explicitly passes
  // generateAudio=false OR the most recent user message contains a clear
  // silence cue. Image generations ignore this field.
  let generateAudio = true;
  if (kind === "video") {
    const audioRaw = typeof input.generateAudio === "boolean"
      ? input.generateAudio
      : (typeof input.generate_audio === "boolean" ? input.generate_audio : null);
    if (audioRaw === false) {
      generateAudio = false;
    } else if (audioRaw === true) {
      generateAudio = true;
    } else if (SILENCE_INTENT_RE.test(lastUserText)) {
      generateAudio = false;
    }
  }

  // Brand IQ flags. The model passes a single use_logo enum which
  // collapses on/off + variant selection into one knob. Internally we
  // still split it into a boolean (useLogo) + a variant ('light' | 'dark'
  // | 'auto') so the dispatch heuristics can layer on top. Each value
  // may be null = "model didn't say, infer from prompt at dispatch time".
  let useLogo: boolean | null = null;
  let logoVariant: "light" | "dark" | "auto" = "auto";
  if (typeof input.use_logo === "string") {
    const ul = input.use_logo.toLowerCase();
    if (ul === "none") {
      useLogo = false;
    } else if (ul === "light" || ul === "dark") {
      useLogo = true;
      logoVariant = ul;
    } else if (ul === "auto") {
      useLogo = true;
      logoVariant = "auto";
    }
  } else if (typeof input.use_logo === "boolean") {
    // Backward compatibility for any prior tool-call still emitting bool.
    useLogo = input.use_logo;
  }
  // logo_variant kept as a tolerated legacy field — if the model still
  // sends it alongside use_logo, let it refine the variant choice but
  // never override an explicit 'none'.
  if (useLogo !== false && typeof input.logo_variant === "string") {
    const lv = input.logo_variant.toLowerCase();
    if (lv === "light" || lv === "dark") logoVariant = lv;
  }
  const respectPalette = typeof input.respect_palette === "boolean" ? input.respect_palette : null;
  const respectTypography = typeof input.respect_typography === "boolean" ? input.respect_typography : null;

  return {
    blockId: block.id,
    kind,
    prompt,
    explicitModel,
    tier,
    aspectRatio,
    aspectRatioExplicit,
    quality,
    resolution,
    videoResolution,
    durationSeconds,
    referenceImageIds,
    videoReferenceMode,
    generateAudio,
    useLogo,
    logoVariant,
    respectPalette,
    respectTypography,
  };
}

// Heuristics used at dispatch time to infer brand-flag defaults from the
// resolved prompt + kind. The model can override any of these by passing
// the explicit tool flag.
const STATIC_AD_INTENT_RE = /\b(static\s*ad|advert(?:isement)?\s*creative|poster|banner|social\s*post|hero\s*graphic|marketing\s*image|app\s*icon|on[-\s]?brand|with\s+(?:our|the)\s+logo|brand(?:ed)?\s*(?:asset|graphic|image))\b/i;
const ON_IMAGE_TEXT_INTENT_RE = /\b(headline|caption|tag\s*line|copy|text\s*overlay|with\s+the\s+text|that\s+says|reading\b|with\s+wording)\b/i;
const DARK_BG_INTENT_RE = /\b(on\s+(?:a\s+)?(?:dark|black|navy|midnight|charcoal|deep|night|moody|noir)\s+\w*background?|dark\s+background|black\s+background|night\s+scene|moody|noir)\b/i;
const LIGHT_BG_INTENT_RE = /\b(on\s+(?:a\s+)?(?:light|white|cream|pastel|sunlit|bright|airy)\s*background?|light\s+background|white\s+background|bright\s+scene|airy)\b/i;

function selectLogoUrl(
  brand: BrandContext,
  variant: "light" | "dark" | "auto",
  prompt: string,
): { url: string | null; variant: "light" | "dark" | null } {
  let chosen: "light" | "dark" | null = null;
  if (variant === "light" || variant === "dark") {
    chosen = variant;
  } else {
    if (DARK_BG_INTENT_RE.test(prompt)) chosen = "dark";
    else if (LIGHT_BG_INTENT_RE.test(prompt)) chosen = "light";
    else chosen = "light";
  }
  let url = chosen === "dark" ? brand.logoDarkUrl : brand.logoLightUrl;
  if (!url) {
    chosen = chosen === "dark" ? "light" : "dark";
    url = chosen === "dark" ? brand.logoDarkUrl : brand.logoLightUrl;
  }
  return { url: url || null, variant: url ? chosen : null };
}

// Snap a requested duration to a value the chosen video model actually
// accepts. Each fal video model has its own allowed set:
//   - kling-o3-pro / kling-o3-4k: every integer 3–15 (clamp only — fal
//                                 accepts the full enum "3".."15")
//   - veo3.1-lite:                4, 6, or 8 seconds (snap to nearest)
//   - seedance-2.0:               any integer 4–15 (already clamped upstream;
//                                 normalizeSeedanceDuration clamps again in fal.ts)
// We snap rather than reject so a "20-second Veo clip" silently becomes
// an 8-second one instead of a hard backend failure.
function snapDurationForModel(model: string, seconds: number): number {
  if (model.startsWith("gemini-omni")) return Math.max(3, Math.min(10, Math.round(seconds)));
  if (model.startsWith("seedance-2.5")) return Math.max(4, Math.min(30, Math.round(seconds)));
  if (model.startsWith("h3-")) return Math.max(5, Math.min(15, Math.round(seconds)));
  if (model.startsWith("kling-o3-")) {
    // Clamp to the fal-accepted range; pass every other integer through
    // unchanged so e.g. 8s requests stay at 8s instead of snapping to 5/10.
    return Math.max(3, Math.min(15, Math.round(seconds)));
  }
  const choices: number[] | null =
    model.startsWith("veo3.1-lite") ? [4, 6, 8]
    : null; // seedance + anything else: pass through (clamped 4-15)
  if (!choices) return seconds;
  let best = choices[0];
  let bestDist = Math.abs(seconds - best);
  for (const c of choices) {
    const d = Math.abs(seconds - c);
    if (d < bestDist) { best = c; bestDist = d; }
  }
  return best;
}

// gpt-image-2 rejects reference images whose long edge is more than 3x the
// short edge (a hard limit on OpenAI's side). Probe the refs and report the
// first one that violates that rule so we can route to a model that doesn't
// have this constraint instead of failing the whole generation downstream.
//
// Bounded by a short timeout per ref so we don't stall a turn if a host is
// slow — on any probe failure we conservatively allow the request through
// (the API call will surface the real error if there is one).
type ProbeResult = { width: number; height: number } | null;
async function findRefWithExtremeAspect(
  referenceUrls: string[],
  cache: Map<string, ProbeResult>,
  maxRatio = 3,
): Promise<{ url: string; width: number; height: number } | null> {
  for (const url of referenceUrls) {
    let meta: ProbeResult;
    if (cache.has(url)) {
      meta = cache.get(url)!;
    } else {
      try {
        const probed = await Promise.race([
          probe(url),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("probe timeout")), 4000)),
        ]);
        meta = probed && probed.width && probed.height
          ? { width: probed.width, height: probed.height }
          : null;
      } catch {
        meta = null;
      }
      cache.set(url, meta);
    }
    if (!meta) continue;
    const long = Math.max(meta.width, meta.height);
    const short = Math.min(meta.width, meta.height);
    if (short > 0 && long / short > maxRatio) {
      return { url, width: meta.width, height: meta.height };
    }
  }
  return null;
}

// Lazy-resolve a canvas to use for an agent-driven generation when the client
// didn't supply one (typical on mobile, where the user lives in the chat
// surface and may never have opened a canvas this session). Strategy:
//   1. Reuse the user's most recently touched canvas (any workspace).
//   2. Otherwise create an "Untitled Project" in the supplied workspace, or
//      in any workspace the user is a member of.
//   3. Return null only if the user genuinely has no workspace at all
//      (extremely rare; the signup flow seeds one).
async function resolveOrCreateCanvasForUser(
  userId: string,
  hintWorkspaceId: string | undefined,
): Promise<string | null> {
  try {
    const recent = await pool.query(
      `SELECT id FROM canvas_states
       WHERE user_id = $1 AND project_type = 'design'
       ORDER BY updated_at DESC
       LIMIT 1`,
      [userId],
    );
    if (recent.rows.length > 0) return recent.rows[0].id as string;

    let workspaceId = hintWorkspaceId;
    if (!workspaceId) {
      const ws = await pool.query(
        `SELECT workspace_id FROM workspace_members
         WHERE user_id = $1
         ORDER BY workspace_id ASC
         LIMIT 1`,
        [userId],
      );
      if (ws.rows.length === 0) return null;
      workspaceId = ws.rows[0].workspace_id as string;
    }
    const created = await pool.query(
      `INSERT INTO canvas_states (workspace_id, user_id, name, project_type)
       VALUES ($1, $2, $3, 'design')
       RETURNING id`,
      [workspaceId, userId, "Untitled Project"],
    );
    return created.rows[0].id as string;
  } catch (err) {
    console.error("resolveOrCreateCanvasForUser error:", err);
    return null;
  }
}

// Build a /api/generate request body from the resolved tool call. Returns
// null if the tool call doesn't translate to a supported generation type.
// Honors an explicit `model` override from Claude when it parses to a
// whitelisted entry whose kind matches; otherwise falls back to tier-based
// resolution. Resulting body always includes the resolved model id.
export function buildGenerateBody(
  tool: AgentToolUse,
  referenceUrls: string[],
  canvasId: string,
  workspaceId: string | undefined,
  seedanceAllowed: boolean,
): {
  type: string;
  body: Record<string, unknown>;
  resolvedModel: string;
  notice?: string;
} | null {
  const hasRef = referenceUrls.length > 0;
  const refCount = referenceUrls.length;

  // A custom (user/operator-added) model is one fal endpoint, not a t2/i2/r2v
  // family, so it can't go through the tier + variant machinery below. Its
  // schema-driven buildInput takes whatever of these params it declares and
  // drops the rest, which is the whole point of adding it this way.
  const custom = tool.explicitModel ? readCustomModel(tool.explicitModel) : undefined;
  if (custom && custom.type === tool.kind) {
    const type = custom.type === "video" ? "video_gen" : hasRef ? "image_to_image" : "text_to_image";
    const body: Record<string, unknown> = {
      type,
      model: custom.key,
      prompt: tool.prompt,
      aspect_ratio: tool.aspectRatio,
      resolution: tool.resolution,
      canvas_id: canvasId,
      workspace_id: workspaceId,
      params: { source: "agent" },
    };
    if (custom.type === "video") { if (tool.durationSeconds != null) body.duration = String(tool.durationSeconds); }
    else body.imageNumber = 1;
    if (hasRef) body.referenceImageUrls = referenceUrls;
    return { type, body, resolvedModel: custom.key };
  }

  const explicitEntry = resolveExplicitModel(tool.explicitModel ?? undefined);
  // If Claude named a model of the wrong kind, ignore the override.
  const useExplicit = explicitEntry && explicitEntry.kind === tool.kind ? explicitEntry : null;

  if (tool.kind === "image") {
    const model = useExplicit
      ? ((hasRef && useExplicit.i2) || useExplicit.t2)
      : resolveImageModel(tool.tier, hasRef);
    const type = hasRef ? "image_to_image" : "text_to_image";
    const body: Record<string, unknown> = {
      type,
      model,
      prompt: tool.prompt,
      aspect_ratio: tool.aspectRatio,
      imageNumber: 1,
      resolution: tool.resolution,
      canvas_id: canvasId,
      workspace_id: workspaceId,
      params: { source: "agent" },
    };
    if (hasRef) body.referenceImageUrls = referenceUrls;
    if (model.startsWith("gpt-image-2")) body.quality = tool.quality;
    return { type, body, resolvedModel: model };
  }
  // video — pick family first, then concrete variant from the user's mode.
  // resolveAgentReferences already drops refs when kind=video and mode is
  // unset, so by this point hasRef implies the user supplied a mode.
  // The explicit entry IS the family: a name-by-name chain here silently sent
  // every family it didn't list (h3-turbo) to Seedance 2.0 at $10 a clip.
  const family = useExplicit
    ?? MODEL_WHITELIST[resolveVideoModelFamily(tool.tier, hasRef && tool.videoReferenceMode != null)];
  let model: string;
  let notice: string | undefined;
  if (!hasRef || tool.videoReferenceMode == null) {
    model = family.t2;
  } else {
    const variant = selectVideoVariant(family, tool.videoReferenceMode, refCount);
    model = variant.id;
    notice = variant.notice;
  }
  // Seedance requires geo verification — silently fall back to Kling O3 Pro
  // if the user is not verified, so the request still succeeds. Kling O3 Pro
  // has no first-last-frame endpoint, so we map -t2v / -i2v / -r2v 1:1 and
  // surface a short note via the SSE event so the chat caption can explain
  // the swap.
  if (model.startsWith("seedance-") && !seedanceAllowed) {
    if (model.endsWith("-r2v")) model = "kling-o3-pro-r2v";
    else if (model.endsWith("-i2v")) model = "kling-o3-pro-i2v";
    else model = "kling-o3-pro-t2v";
    notice = "Seedance requires verification — generated with Kling O3 Pro instead. Verify in Settings to use Seedance.";
  }
  const type = "video_gen";
  // Per-model default duration when the user didn't specify one. Veo3.1 Lite
  // accepts 4/6/8s and defaults to 6s; Kling/Seedance default to 5s. Picking
  // the right default avoids silently snapping a user-asked length to a
  // model-incompatible value at the edges.
  const defaultDuration = model.startsWith("veo3.1-lite") ? 6 : 5;
  // If the user (or Claude) asked for a specific length, snap it to the
  // closest value the chosen model actually supports. Otherwise stick with
  // that model's default.
  const duration = tool.durationSeconds != null
    ? snapDurationForModel(model, tool.durationSeconds)
    : defaultDuration;
  // `@elementN` reference tags are only meaningful on Kling O3 r2v
  // endpoints (reference-to-video). Any other variant — Kling i2v / t2v,
  // Veo, Seedance — silently rejects them with "Invalid reference index N
  // for element. Only 0 elements provided." because those endpoints don't
  // ship an `image_urls` array. Strip the tags from the prompt as a safety
  // net so a stray `@element1` left behind by Claude (or by the user
  // themselves when typing in chat) doesn't fail the whole job. The
  // surrounding word boundary keeps tags like `@elementary` untouched.
  const isKlingR2v = model.endsWith("-r2v") && model.startsWith("kling-o3-");
  const safePrompt = isKlingR2v
    ? tool.prompt
    : (tool.prompt || "").replace(/@element\d+\b/gi, "").replace(/[ \t]{2,}/g, " ").trim();
  const body: Record<string, unknown> = {
    type,
    model,
    prompt: safePrompt,
    aspect_ratio: tool.aspectRatio,
    resolution: tool.videoResolution ?? "720p",
    duration: String(duration),
    generateAudio: tool.generateAudio,
    canvas_id: canvasId,
    workspace_id: workspaceId,
    params: { source: "agent" },
  };
  // Populate the right reference field for the resolved variant. Plain t2v
  // gets nothing (no refs). The branches below mirror what each upstream
  // builder in fal.ts reads.
  if (hasRef && tool.videoReferenceMode != null) {
    if (model.endsWith("-r2v")) {
      // Reference-to-video. Seedance accepts up to 3 reference images;
      // Kling O3 (Pro / 4K) accepts up to 4. fal.ts reads
      // `referenceImageUrls` and passes them as `image_urls`.
      const refCap = model.startsWith("kling-o3-") ? 4 : 3;
      body.referenceImageUrls = referenceUrls.slice(0, refCap);
    } else if (model.endsWith("-flf2v")) {
      // Veo first-last-frame: requires both a starting and an ending image.
      body.firstFrameUrl = referenceUrls[0];
      if (referenceUrls[1]) body.lastFrameUrl = referenceUrls[1];
    } else {
      // i2v variants: single starting frame. fal.ts reads `firstFrameUrl`
      // and translates to the backend-specific field (`image_url` for
      // Seedance/Veo, `start_image_url` for Kling).
      body.firstFrameUrl = referenceUrls[0];
    }
  }
  return { type, body, resolvedModel: model, notice };
}

// ---------- transform_media tool ----------
// Non-generative ops that take an existing image and transform it: background
// removal (Pixelcut), upscaling (SeedVR), and aspect-ratio expand (Bria).
// All three require a reference image and run through /api/generate just like
// the generative tool, so the same tray + credit pipeline applies.

const TRANSFORM_MEDIA_TOOL: Tool = {
  name: "transform_media",
  description:
    "Apply a non-generative transform to an existing image: remove background (Pixelcut), upscale (SeedVR), or resize / outpaint to a new aspect ratio (Bria). The result appears inline in the chat as a card the user can drag to the canvas. Requires a reference image — call this only when one is available in the 'Available references' list. Counts toward the 5-call-per-turn limit shared with generate_media.",
  input_schema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["remove_background", "upscale", "resize"],
        description:
          "Which transform to apply. 'remove_background' uses Pixelcut to cut out the subject. 'upscale' enlarges the image with SeedVR (specify upscaleFactor 2 or 4). 'resize' uses Bria to outpaint the image into a new aspect ratio (specify aspectRatio).",
      },
      referenceImageId: {
        type: "string",
        description:
          "Required. Id of the image to transform — one of the strings the system listed in 'Available references' (e.g. 'canvas:1' or 'agent:1'). Exactly one image at a time.",
      },
      upscaleFactor: {
        type: "number",
        enum: [2, 4],
        description:
          "Only for operation='upscale'. 2x or 4x. Defaults to 2 if omitted.",
      },
      aspectRatio: {
        type: "string",
        enum: ["1:1", "4:3", "3:4", "16:9", "9:16", "21:9", "3:2", "2:3"],
        description:
          "Only for operation='resize'. Target aspect ratio for the outpaint. Defaults to 16:9 if omitted.",
      },
      prompt: {
        type: "string",
        description:
          "Optional. For operation='resize' only — short hint about what should fill the new edges (e.g. 'extend the sky'). Ignored for the other operations.",
      },
    },
    required: ["operation", "referenceImageId"],
  },
};

type AgentTransformUse = {
  blockId: string;
  operation: TransformOp;
  referenceImageId: string;
  upscaleFactor: 2 | 4;
  aspectRatio: string;
  prompt: string;
};

function parseTransformMediaInput(
  block: ToolUseBlock,
): AgentTransformUse | { error: string } {
  const input = (block.input ?? {}) as Record<string, unknown>;
  const opRaw = input.operation;
  let operation: TransformOp;
  if (opRaw === "remove_background" || opRaw === "remove_bg") operation = "remove_background";
  else if (opRaw === "upscale") operation = "upscale";
  else if (opRaw === "resize") operation = "resize";
  else return { error: "Invalid operation. Must be remove_background, upscale, or resize." };

  const refId = typeof input.referenceImageId === "string" ? input.referenceImageId.trim() : "";
  if (!refId) return { error: "Missing referenceImageId — pick an image from the available references." };

  const factorRaw = input.upscaleFactor;
  const upscaleFactor: 2 | 4 = factorRaw === 4 ? 4 : 2;

  const arRaw = typeof input.aspectRatio === "string" ? input.aspectRatio : "";
  const aspectRatio = GEN_ALLOWED_AR.has(arRaw) ? arRaw : "16:9";

  const prompt = typeof input.prompt === "string" ? input.prompt.trim().slice(0, 500) : "";

  return { blockId: block.id, operation, referenceImageId: refId, upscaleFactor, aspectRatio, prompt };
}

function buildTransformBody(
  tool: AgentTransformUse,
  referenceUrl: string,
  canvasId: string,
  workspaceId: string | undefined,
): { type: string; body: Record<string, unknown>; resolvedModel: string } | null {
  if (tool.operation === "remove_background") {
    const model = "pixelcut_remove_bg";
    return {
      type: "remove_bg",
      resolvedModel: model,
      body: {
        type: "remove_bg",
        model,
        referenceImageUrls: [referenceUrl],
        canvas_id: canvasId,
        workspace_id: workspaceId,
        params: { source: "agent" },
      },
    };
  }
  if (tool.operation === "upscale") {
    const model = "seedvr-upscale";
    return {
      type: "upscale",
      resolvedModel: model,
      body: {
        type: "upscale",
        model,
        referenceImageUrls: [referenceUrl],
        upscaleFactor: tool.upscaleFactor,
        upscale_factor: tool.upscaleFactor,
        canvas_id: canvasId,
        workspace_id: workspaceId,
        params: { source: "agent" },
      },
    };
  }
  // resize
  const model = "bria_expand";
  return {
    type: "resize",
    resolvedModel: model,
    body: {
      type: "resize",
      model,
      prompt: tool.prompt,
      aspect_ratio: tool.aspectRatio,
      referenceImageUrls: [referenceUrl],
      canvas_id: canvasId,
      workspace_id: workspaceId,
      params: { source: "agent" },
    },
  };
}

// ---------- generate_music tool ----------

type AgentMusicUse = {
  blockId: string;
  prompt: string;
  lyrics: string;
  isInstrumental: boolean;
};

function parseGenerateMusicInput(
  block: ToolUseBlock,
): AgentMusicUse | { error: string } {
  const input = (block.input ?? {}) as Record<string, unknown>;
  const prompt = typeof input.prompt === "string" ? input.prompt.trim().slice(0, 300) : "";
  if (prompt.length < 5) {
    return { error: "Music prompt is too short. Describe the style, mood, and genre (at least 10 characters)." };
  }

  const isInstrumental = input.is_instrumental === true || input.isInstrumental === true;
  const lyrics = typeof input.lyrics === "string" ? input.lyrics.trim().slice(0, 5000) : "";

  if (!isInstrumental && !lyrics) {
    return { error: "Lyrics are required for vocal tracks. Provide lyrics with structure tags like [Verse], [Chorus], etc., or set is_instrumental to true." };
  }

  return {
    blockId: block.id,
    prompt,
    lyrics,
    isInstrumental,
  };
}

function buildMusicBody(
  tool: AgentMusicUse,
  canvasId: string,
  workspaceId: string | undefined,
): { type: string; body: Record<string, unknown>; resolvedModel: string } {
  return {
    type: "audio_music",
    resolvedModel: "minimax-music",
    body: {
      type: "audio_music",
      model: "minimax-music",
      prompt: tool.prompt,
      lyrics: tool.lyrics || undefined,
      is_instrumental: tool.isInstrumental,
      canvas_id: canvasId,
      workspace_id: workspaceId,
      params: { source: "agent" },
    },
  };
}

// Internal HTTP dispatch to /api/generate so the agent reuses the exact same
// pipeline (debit, validation, fal.ai dispatch) the Make panel uses. Forwards
// the user's auth cookie so requireAuth on the target route sees the same
// session.
async function dispatchAgentGeneration(
  req: AuthRequest,
  body: Record<string, unknown>,
): Promise<
  | { ok: true; jobId: string }
  | { ok: false; status: number; error: string }
> {
  const port = process.env.PORT ? parseInt(process.env.PORT) : 3001;
  const base = `http://127.0.0.1:${port}`;
  const cookie = req.headers.cookie || "";
  try {
    const r = await fetch(`${base}/api/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      let msg = `Generation failed (${r.status})`;
      try {
        const j = (await r.json()) as { error?: string };
        if (j?.error) msg = j.error;
      } catch { /* ignore */ }
      return { ok: false, status: r.status, error: msg };
    }
    const j = (await r.json()) as { job_id?: string };
    if (!j.job_id) return { ok: false, status: 502, error: "Missing job id from generation" };
    // Every agent-initiated job passes through here, so this is the one place
    // that can hand the operator's stop button something to cancel.
    if (req.userId) noteOperatorJob(req.userId, j.job_id);
    return { ok: true, jobId: j.job_id };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err instanceof Error ? err.message : "Internal generation error",
    };
  }
}

/**
 * Locally-served images (`/uploads/foo.png`) are neither `data:` nor `http(s)://`,
 * so they used to fall through both arms of the vision-block builder and vanish
 * silently — the model still got their ids in the reference catalog, so tools
 * worked and only *seeing* the image was broken. An absolute localhost URL is no
 * fix either: Anthropic fetches `source: {type:"url"}` from its own servers and
 * cannot reach this machine. So read the bytes off disk and inline them.
 *
 * ponytail: files over the per-image cap are left alone (and then skipped, as
 * before) rather than downscaled — add sharp resizing if users actually hit it.
 */
function localImageToDataUrl(url: string): string | null {
  const hit = resolveUploadPath(url, UPLOADS_DIR);
  if (!hit) return null;
  try {
    if (fs.statSync(hit.path).size > MAX_IMAGE_BYTES) return null;
    return `data:${hit.mime};base64,${fs.readFileSync(hit.path).toString("base64")}`;
  } catch {
    return null;
  }
}

function isHttpUrl(url: string): boolean {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

function isDataUrl(url: string): boolean {
  return typeof url === "string" && url.startsWith("data:image/");
}

function parseDataUrl(url: string): { mediaType: string; data: string } | null {
  const m = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  const mediaType = m[1];
  if (!mediaType.startsWith("image/")) return null;
  return { mediaType, data: m[2] };
}

type BuildResult =
  | { ok: true; messages: MessageParam[]; hasVision: boolean; totalChars: number; imageCount: number; droppedForWindow: number }
  | { ok: false; error: string };

function dataUrlByteSize(b64: string): number {
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

// Cheap per-message token estimate for the sliding window. Mirrors the
// reservation math (RESERVATION_CHARS_PER_TOKEN) plus a per-image surcharge.
function estimateMessageTokens(m: MessageParam): number {
  let chars = 0;
  let images = 0;
  const content = m.content;
  if (typeof content === "string") {
    chars += content.length;
  } else if (Array.isArray(content)) {
    for (const b of content) {
      if (b.type === "text") chars += (b.text || "").length;
      else if (b.type === "image") images += 1;
    }
  }
  return Math.ceil(chars / RESERVATION_CHARS_PER_TOKEN) + images * RESERVATION_TOKENS_PER_IMAGE;
}

function buildAnthropicMessages(messages: ClientMessage[]): BuildResult {
  // Identify which user-turn source indices retain their image blocks.
  // Older user turns get a short "[image omitted — see reference catalog]"
  // marker in place of the actual image bytes. The references the
  // generator actually needs are still surfaced via the reference catalog
  // in the dynamic system prompt suffix (canvas:N / agent:N etc.).
  const userIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") userIndices.push(i);
  }
  const retainImages = new Set(userIndices.slice(-RETAIN_IMAGES_LAST_N_USER));

  let hasVision = false;
  let totalChars = 0;
  let imageCount = 0;
  const out: MessageParam[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "user" && m.role !== "assistant") continue;
    const text = (m.text || "").slice(0, MAX_INPUT_CHARS);
    totalChars += text.length;
    const blocks: (TextBlockParam | ImageBlockParam)[] = [];
    let omittedImageCount = 0;
    if (m.role === "user" && Array.isArray(m.images) && m.images.length > 0) {
      const imgs = m.images.slice(0, MAX_IMAGES);
      const allowImages = retainImages.has(i);
      for (const img of imgs) {
        if (!img || typeof img.url !== "string") continue;
        // Skip non-image references (e.g. inline video gens that the user
        // pinned via "Edit with agent"). Anthropic vision blocks only accept
        // images; passing a video URL would fail the request. The video URL
        // is still preserved as a generation reference downstream — see
        // resolveAgentReferences / pinned-refs path.
        if (img.kind === "video") continue;
        if (!allowImages) {
          // Strip stale vision block from older user turns. We still want
          // the model to know an image *was* attached at that point in
          // the conversation, so it can resolve "the previous image"
          // style references via the reference catalog instead.
          omittedImageCount += 1;
          continue;
        }
        const url = isDataUrl(img.url) || isHttpUrl(img.url)
          ? img.url
          : (localImageToDataUrl(img.url) ?? img.url);
        if (isDataUrl(url)) {
          const parsed = parseDataUrl(url);
          if (!parsed) continue;
          if (dataUrlByteSize(parsed.data) > MAX_IMAGE_BYTES) {
            return { ok: false, error: "An attached image exceeds the 5 MB per-image limit." };
          }
          blocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: parsed.mediaType as ImageBlockParam.Base64ImageSource["media_type"],
              data: parsed.data,
            },
          });
          hasVision = true;
          imageCount += 1;
        } else if (isHttpUrl(url)) {
          blocks.push({
            type: "image",
            source: { type: "url", url },
          });
          hasVision = true;
          imageCount += 1;
        }
      }
    }
    let effectiveText = text;
    if (omittedImageCount > 0) {
      const marker = omittedImageCount === 1
        ? `[image omitted — see reference catalog]`
        : `[${omittedImageCount} images omitted — see reference catalog]`;
      effectiveText = effectiveText ? `${marker}\n${effectiveText}` : marker;
      totalChars += marker.length + (effectiveText !== text ? 1 : 0);
    }
    if (effectiveText.length > 0) {
      blocks.push({ type: "text", text: effectiveText });
    }
    // Anthropic rejects empty text blocks ("text content blocks must be
    // non-empty"). If a stored assistant turn produced only a tool call we
    // didn't round-trip (so it has no text and no images), skip it rather
    // than pushing an empty block. For user turns this also drops messages
    // that somehow ended up with neither text nor images.
    if (blocks.length === 0) continue;
    out.push({ role: m.role, content: blocks });
  }

  // Sliding window: drop oldest user+assistant pairs (preserving the very
  // first user turn for context) until the estimated input-token total
  // falls under SLIDING_WINDOW_TOKEN_THRESHOLD or we've kept only
  // [first turn] + last 4 messages (≈ two recent pairs).
  let estTokens = out.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  let droppedForWindow = 0;
  if (estTokens > SLIDING_WINDOW_TOKEN_THRESHOLD && out.length > 5) {
    const firstUserIdx = out.findIndex((m) => m.role === "user");
    const protectStart = firstUserIdx >= 0 ? firstUserIdx + 1 : 0;
    while (estTokens > SLIDING_WINDOW_TOKEN_THRESHOLD && out.length - protectStart > 4) {
      const removed = out.splice(protectStart, 1)[0];
      droppedForWindow += 1;
      estTokens -= estimateMessageTokens(removed);
      if (out.length - protectStart > 4 && out[protectStart]) {
        const removed2 = out.splice(protectStart, 1)[0];
        droppedForWindow += 1;
        estTokens -= estimateMessageTokens(removed2);
      }
    }
    // Recompute totals so the reservation math stays accurate.
    if (droppedForWindow > 0) {
      totalChars = 0;
      imageCount = 0;
      hasVision = false;
      for (const m of out) {
        if (Array.isArray(m.content)) {
          for (const b of m.content) {
            if (b.type === "text") totalChars += (b.text || "").length;
            else if (b.type === "image") { imageCount += 1; hasVision = true; }
          }
        }
      }
    }
  }
  return { ok: true, messages: out, hasVision, totalChars, imageCount, droppedForWindow };
}

router.post("/api/agent/chat", requireAuth, requireVerifiedEmail, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const referenceId = uuidv4();

  const anthropicClient = getAnthropicClient();
  if (!anthropicClient) {
    res.status(503).json({ error: "Anthropic is not configured. Add your Anthropic API key in Settings to enable the Agent panel." });
    return;
  }

  const body = (req.body || {}) as ChatBody;
  const modelKey = normalizeModelKey(body.modelKey);
  const modelEntry = CLAUDE_MODELS[modelKey];
  const workspaceId = typeof body.workspace_id === "string" && body.workspace_id ? body.workspace_id : undefined;
  if (workspaceId) {
    if (!isUuid(workspaceId)) {
      res.status(400).json({ error: "Invalid workspace_id" });
      return;
    }
    const ok = await userHasWorkspaceAccess(userId, workspaceId);
    if (!ok) {
      res.status(403).json({ error: "No access to workspace" });
      return;
    }
  }
  // Optional canvas_id. Required only when the agent fires a tool call;
  // we still let plain chat (no generation) work without one. Validate
  // ownership early so a forged canvas id can't be used for tool dispatch.
  let canvasId: string | null = null;
  if (typeof body.canvas_id === "string" && body.canvas_id) {
    if (!isUuid(body.canvas_id)) {
      res.status(400).json({ error: "Invalid canvas_id" });
      return;
    }
    try {
      const r = await pool.query(
        `SELECT id FROM canvas_states WHERE id = $1 AND user_id = $2`,
        [body.canvas_id, userId],
      );
      if (r.rows.length === 0) {
        res.status(403).json({ error: "No access to canvas" });
        return;
      }
      canvasId = body.canvas_id;
    } catch {
      res.status(500).json({ error: "Failed to validate canvas" });
      return;
    }
  }

  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  if (rawMessages.length === 0) {
    res.status(400).json({ error: "messages is required" });
    return;
  }
  if (rawMessages.length > 40) {
    res.status(400).json({ error: "Conversation too long; please start a new chat." });
    return;
  }

  let prepared: Extract<ReturnType<typeof buildAnthropicMessages>, { ok: true }>;
  try {
    const built = buildAnthropicMessages(rawMessages);
    if (!built.ok) {
      res.status(400).json({ error: built.error });
      return;
    }
    prepared = built;
  } catch {
    res.status(400).json({ error: "Invalid message payload" });
    return;
  }
  if (prepared.messages.length === 0) {
    res.status(400).json({ error: "No valid messages" });
    return;
  }
  if (prepared.totalChars === 0 && !prepared.hasVision) {
    res.status(400).json({ error: "Message text is empty" });
    return;
  }

  // Sonnet bills against real Anthropic input/output token usage. We
  // pre-debit a worst-case reservation here so the user sees the existing
  // 402 / "insufficient credits" UX up front; after stream.finalMessage()
  // we settle against the actual token counts.
  const isTokenBilled = !!modelEntry.tokenBilled;
  const estimatedInputTokens = isTokenBilled
    ? Math.ceil(prepared.totalChars / RESERVATION_CHARS_PER_TOKEN)
      + RESERVATION_TOKEN_OVERHEAD_BASE
      + prepared.imageCount * RESERVATION_TOKENS_PER_IMAGE
    : 0;

  const debitResult = isTokenBilled
    ? await reserveAgentCredits({
        userId,
        modelKey: modelEntry.pricingKey,
        estimatedInputTokens,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        referenceId,
        orgId: workspaceId,
      })
    : await checkAndDebit(
        userId,
        "agent_chat",
        1,
        referenceId,
        workspaceId,
        {
          modelKey: modelEntry.pricingKey,
          characters: prepared.totalChars,
          features: prepared.hasVision ? ["vision"] : undefined,
        }
      );
  if (!debitResult.success) {
    const status = debitResult.required ? 402 : 400;
    res.status(status).json({
      error: debitResult.error,
      required: debitResult.required,
      balance: debitResult.balance,
    });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (event: string, data: Record<string, unknown>) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let cancelled = false;
  let finishedOk = false;
  let stream: Awaited<ReturnType<typeof anthropicClient.messages.stream>> | null = null;

  req.on("close", () => {
    if (!finishedOk) {
      cancelled = true;
      try { stream?.controller.abort(); } catch {}
    }
  });

  send("start", { model: modelEntry.label, modelKey, cost: debitResult.cost });

  // Last user text drives implicit reference auto-attach (e.g. "make it warmer").
  const lastUserText = (() => {
    for (let i = rawMessages.length - 1; i >= 0; i--) {
      if (rawMessages[i].role === "user") return rawMessages[i].text || "";
    }
    return "";
  })();
  const inlineHistory = collectInlineImageHistory(rawMessages);
  const canvasAttachments = collectCanvasAttachments(rawMessages);
  const pinnedRefs = collectPinnedRefs(rawMessages);

  // Resolve the active brand for this turn. Order: explicit body field →
  // sticky agent_chats.brand_profile_id → project_brand_overrides → workspace
  // default. The pseudo-value "__none__" suppresses every fallback for this
  // chat (user explicitly opted out of brand context).
  let stickyBrandId: string | null = null;
  let stickyBrandDisabled = false;
  if (typeof body.chat_id === "string" && isUuid(body.chat_id)) {
    try {
      const r = await pool.query(
        `SELECT brand_profile_id, brand_disabled FROM agent_chats WHERE id = $1 AND user_id = $2`,
        [body.chat_id, userId]
      );
      if (r.rows.length > 0) {
        stickyBrandId = (r.rows[0].brand_profile_id as string) || null;
        stickyBrandDisabled = !!r.rows[0].brand_disabled;
      }
    } catch { /* best-effort */ }
  }
  // Effective explicit pin for resolveBrandProfile is one of:
  //   - BRAND_PIN_NONE  → user pinned "no brand"
  //   - a UUID string   → user pinned a specific profile
  //   - null            → fall through to project / workspace defaults
  // The wire field body.brand_profile_id may be the sentinel "__none__"
  // OR brand_disabled may be set independently — handle both.
  let explicitBrandPin: string | null | undefined;
  if (body.brand_disabled === true) {
    explicitBrandPin = BRAND_PIN_NONE;
  } else if (body.brand_profile_id === BRAND_PIN_NONE) {
    explicitBrandPin = BRAND_PIN_NONE;
  } else if (body.brand_profile_id === undefined && body.brand_disabled === undefined) {
    // No client-side override; use sticky chat-row state.
    explicitBrandPin = stickyBrandDisabled ? BRAND_PIN_NONE : stickyBrandId;
  } else {
    explicitBrandPin = body.brand_profile_id ?? null;
  }
  const brandContext = await resolveBrandProfile(userId, workspaceId, canvasId, explicitBrandPin);

  // Resolve "@product" mentions for this turn. Order:
  //   - explicit body.product_ids (current-turn mention) wins, even if
  //     empty (the empty array is "clear pins for this turn").
  //   - else fall back to the chat row's sticky last_product_ids.
  let stickyProductIds: string[] = [];
  if (typeof body.chat_id === "string" && isUuid(body.chat_id)) {
    try {
      const r = await pool.query(
        `SELECT last_product_ids FROM agent_chats WHERE id = $1 AND user_id = $2`,
        [body.chat_id, userId]
      );
      if (r.rows.length > 0 && Array.isArray(r.rows[0].last_product_ids)) {
        stickyProductIds = r.rows[0].last_product_ids.filter((x: unknown): x is string => typeof x === "string");
      }
    } catch { /* best-effort */ }
  }
  const turnProductIds = Array.isArray(body.product_ids)
    ? body.product_ids.filter((x): x is string => typeof x === "string")
    : stickyProductIds;
  const productContexts = await resolveProducts(userId, workspaceId, turnProductIds);
  const productMap = buildProductRefMap(productContexts);

  // Persist sticky product pins on the chat row whenever this turn
  // explicitly named (or cleared) products. Auto-inheriting from the
  // sticky set is not a write — the sticky state already reflects that.
  if (
    typeof body.chat_id === "string"
    && isUuid(body.chat_id)
    && Array.isArray(body.product_ids)
    && (body.product_sticky !== false)
  ) {
    try {
      const persistedIds = productContexts.map((p) => p.productId);
      await pool.query(
        `UPDATE agent_chats SET last_product_ids = $1::text[] WHERE id = $2 AND user_id = $3`,
        [persistedIds, body.chat_id, userId]
      );
    } catch { /* best-effort */ }
  }

  // Persist resolved brand context onto the chat row for every request
  // that has a chat_id, not only when the client flagged brand_sticky.
  // This means an auto-resolved project/workspace default also becomes
  // sticky for the conversation, matching the spec's "active brand
  // continues across turns" requirement. brand_sticky still controls the
  // *no-brand* opt-out: only when the user explicitly disables (or pins
  // "__none__") do we record brand_disabled=true. Never write the
  // sentinel string into the brand_profile_id UUID FK column.
  // resolveBrandProfile already filters archived_at IS NULL so brandContext
  // here is guaranteed to be a non-archived profile (or null).
  if (typeof body.chat_id === "string" && isUuid(body.chat_id)) {
    try {
      const explicitlyDisabled = explicitBrandPin === BRAND_PIN_NONE;
      const profileId = explicitlyDisabled ? null : (brandContext ? brandContext.id : null);
      // Only flip brand_disabled=true when the caller explicitly opted out
      // for this turn (sticky pin or one-off). Auto-resolved defaults must
      // not poison the chat row with brand_disabled.
      const disabled = explicitlyDisabled && !!body.brand_sticky;
      await pool.query(
        `UPDATE agent_chats SET brand_profile_id = $1, brand_disabled = $2 WHERE id = $3 AND user_id = $4`,
        [profileId, disabled, body.chat_id, userId]
      );
    } catch { /* best-effort */ }
  }

  const baseCatalog = buildReferenceCatalog(canvasAttachments, inlineHistory);
  // Brand / product / pinned ids go into a separate "always-keep" bucket so
  // the K-cap (REFERENCE_CATALOG_CAP) can't silently drop a reference the
  // user explicitly pinned for this turn.
  const pinnedCatalogEntries: string[] = [];
  if (brandContext) {
    if (brandContext.logoLightUrl) pinnedCatalogEntries.push("brand:logo_light — brand logo (light backgrounds)");
    if (brandContext.logoDarkUrl) pinnedCatalogEntries.push("brand:logo_dark — brand logo (dark backgrounds)");
    brandContext.graphicUrls.forEach((_u, i) => {
      pinnedCatalogEntries.push(`brand:graphic:${i + 1} — brand graphic ${i + 1}`);
    });
  }
  for (const p of productContexts) {
    if (p.imageUrls.length === 0) continue;
    if (p.imageUrls.length === 1) {
      pinnedCatalogEntries.push(`product:${p.slug} — "${p.name}" reference image`);
    } else {
      pinnedCatalogEntries.push(`product:${p.slug} — "${p.name}" reference image 1 (default)`);
      p.imageUrls.forEach((_u, i) => {
        pinnedCatalogEntries.push(`product:${p.slug}:${i + 1} — "${p.name}" reference image ${i + 1}`);
      });
    }
  }
  // Cap base entries (canvas:N / agent:N) to the most recent K so a
  // long-running chat with lots of inline gens doesn't bloat the system
  // prompt. Pinned ids (brand/product) are always preserved.
  const trimmedBase = baseCatalog.slice(0, REFERENCE_CATALOG_CAP);
  const referenceCatalog = [...trimmedBase, ...pinnedCatalogEntries];

  // Build the corpus of text we'll scan for context-gating heuristics.
  // We use the *retained* messages — i.e. what actually survives image
  // stripping + the sliding window — so a brand/product mention that
  // dropped out of the cap doesn't keep its block in the prompt. Pulled
  // from prepared.messages (post-buildAnthropicMessages) so it reflects
  // the same text Claude will see this turn. Lower-cased once.
  const retainedTextLower = (() => {
    const parts: string[] = [];
    for (const m of prepared.messages) {
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === "text" && b.text) parts.push(b.text);
        }
      } else if (typeof m.content === "string") {
        parts.push(m.content);
      }
    }
    return parts.join("\n").toLowerCase();
  })();

  // Detect audio references anywhere in the original conversation — even
  // if the message text didn't survive the sliding window, a pinned music
  // asset still implies music intent. Also walk pinned canvas refs.
  const hasAudioRef = rawMessages.some((m) =>
    Array.isArray(m.images) && m.images.some((img) => img && img.kind === "music"),
  );

  // Conditional music tool: keyword heuristic over the retained text OR
  // presence of any audio reference in the conversation. Image-only flows
  // skip the tool entirely (saves ~hundreds of input tokens per turn).
  const includeMusicTool = hasAudioRef || MUSIC_INTENT_RE.test(retainedTextLower);

  // Same gate for the voiceover tool. No audio-reference fallback: a pinned
  // music asset implies music intent, not speech intent.
  const includeVoiceoverTool = VOICEOVER_INTENT_RE.test(retainedTextLower);

  // Conditional brand context block. Inject when:
  //   - the user (or sticky chat row) explicitly pinned a brand for this
  //     turn, OR
  //   - any retained message references brand-shaped language (#brand,
  //     "brand:" / "logo:" catalog ids, or the words brand / logo), OR
  //   - any pinned reference id in retained text resolves to a brand:*
  //     entry the catalog actually surfaced.
  const brandExplicitlyPinned = !!explicitBrandPin && explicitBrandPin !== BRAND_PIN_NONE;
  const brandMentioned = retainedTextLower.includes("#brand")
    || retainedTextLower.includes("brand:")
    || /\bbrand\b/.test(retainedTextLower)
    || /\blogo\b/.test(retainedTextLower);
  const includeBrandBlock = !!brandContext && (brandExplicitlyPinned || brandMentioned);

  // Conditional product context block. Inject when:
  //   - body.product_ids is non-empty (explicit current-turn pin), OR
  //   - any retained message text mentions a resolved product by slug,
  //     "@slug", "product:slug" id, or the product's display name.
  const productExplicitlyPinned = Array.isArray(body.product_ids) && body.product_ids.length > 0;
  const productMentioned = productContexts.some((p) => {
    const slug = p.slug.toLowerCase();
    const name = p.name.toLowerCase();
    return retainedTextLower.includes(`@${slug}`)
      || retainedTextLower.includes(`product:${slug}`)
      || (name.length >= 3 && retainedTextLower.includes(name));
  });
  const visibleProducts = (productExplicitlyPinned || productMentioned) ? productContexts : [];
  // Tell the client which brand was actually used this turn so the
  // composer chip can stay in sync (and surface "fell back to project /
  // workspace default" UX without an extra round trip).
  send("brand", brandContext
    ? { profile_id: brandContext.id, name: brandContext.name, source: explicitBrandPin && explicitBrandPin !== BRAND_PIN_NONE ? "explicit" : "auto" }
    : { profile_id: null });

  // Build cache-aware system prompt: a stable static prefix (cached) plus
  // a dynamic suffix (per-turn references / brand / products — not cached).
  const staticSystem = buildSystemPromptStatic(
    body.output_mode === "on_canvas" ? "on_canvas" : "in_chat",
    includeMusicTool,
    includeVoiceoverTool,
  );
  const dynamicSystem = buildSystemPromptDynamic(
    referenceCatalog,
    includeBrandBlock ? brandContext : null,
    visibleProducts,
  );
  const systemBlocks: TextBlockParam[] = [
    {
      type: "text",
      text: staticSystem,
      // Cache breakpoint: everything up to and including this block (the
      // tools schema + this static system text) is reused across turns.
      cache_control: { type: "ephemeral" },
    },
  ];
  if (dynamicSystem) {
    systemBlocks.push({ type: "text", text: dynamicSystem });
  }

  // Conditionally include the music / voiceover tools. Mark the *last* tool with
  // cache_control so the entire tools block becomes part of the cached
  // prefix.
  const baseTools: Tool[] = [
    GENERATE_MEDIA_TOOL,
    TRANSFORM_MEDIA_TOOL,
    ...(includeMusicTool ? [GENERATE_MUSIC_TOOL] : []),
    ...(includeVoiceoverTool ? [GENERATE_VOICEOVER_TOOL] : []),
  ];
  const cachedBaseTools: Tool[] = baseTools.map((t, i, arr) =>
    i === arr.length - 1
      ? ({ ...t, cache_control: { type: "ephemeral" } } as Tool)
      : t,
  );
  // Anthropic's server-side web_search tool. The model can fire it
  // mid-turn to look things up; the SDK injects the results back into
  // the same response automatically (we don't dispatch it on our side
  // — it never enters processToolBlock and is not counted against
  // MAX_GENERATIONS_PER_TURN). Cache-controlled with the rest of the
  // tools block so the prompt prefix stays cacheable. max_uses bounds
  // per-turn cost since each search is billed by Anthropic.
  const webSearchTool: WebSearchTool20250305 = {
    type: "web_search_20250305",
    name: "web_search",
    max_uses: MAX_WEB_SEARCHES_PER_TURN,
  };
  const tools: ToolUnion[] = [...cachedBaseTools, webSearchTool];

  // History caching: when there are at least 4 messages, mark a cache
  // breakpoint on the second-to-last user message so prior turns hit the
  // cache on subsequent requests. Mutate a shallow copy of the prepared
  // messages so we don't pollute callers' references.
  const messagesForApi: MessageParam[] = prepared.messages.map((m) => ({ ...m }));
  if (messagesForApi.length >= 4) {
    let lastUserIdx = -1;
    let prevUserIdx = -1;
    for (let i = messagesForApi.length - 1; i >= 0; i--) {
      if (messagesForApi[i].role === "user") {
        if (lastUserIdx === -1) lastUserIdx = i;
        else { prevUserIdx = i; break; }
      }
    }
    if (prevUserIdx >= 0) {
      const target = messagesForApi[prevUserIdx];
      if (Array.isArray(target.content) && target.content.length > 0) {
        const newContent = target.content.map((b, i, arr) =>
          i === arr.length - 1
            ? ({ ...b, cache_control: { type: "ephemeral" } } as typeof b)
            : b,
        );
        messagesForApi[prevUserIdx] = { ...target, content: newContent };
      }
    }
  }

  try {
    stream = anthropicClient.messages.stream({
      model: modelEntry.id,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: systemBlocks,
      tools,
      messages: messagesForApi,
    });

    stream.on("text", (delta: string) => {
      if (cancelled) return;
      send("delta", { text: delta });
    });

    // Track tool_use blocks we've already dispatched via the streaming
    // contentBlock event so the post-finalMessage safety loop doesn't fire
    // them a second time. Cap fan-out per turn so a runaway tool loop can't
    // drain credits — Claude can fire up to MAX_GENERATIONS_PER_TURN
    // generate_media calls in a single reply (e.g. "make 3 variations" or
    // "image + matching video"); extras are dropped with a tool_use error
    // event so the client can surface a friendly message.
    const handledToolUseIds = new Set<string>();
    let dispatchedCount = 0;
    const inFlightDispatches: Promise<void>[] = [];

    // Per-turn tool-call accounting so we can confirm whether the
    // "agent narrated 3 but only 1 placeholder appeared" bug is the
    // model emitting fewer calls than expected, the server capping,
    // a parse/dispatch failure, or events lost between server and
    // client. Mirrored to the SSE stream as a `tool_summary` event
    // at end-of-turn so the browser console can correlate it with
    // the placements it made.
    const toolCounts = {
      streamed: 0,      // contentBlock tool_use events received from the SDK
      finalOnly: 0,     // tool_use blocks found only via the final-message safety net (SDK dropped the streaming event)
      dispatched: 0,    // accepted under cap and entered processGenerate/Transform/Music (NOT a guarantee the generation backend was actually called — parseFailed/dispatchFailed below subtract from this)
      capped: 0,        // dropped because dispatchedCount already hit MAX_GENERATIONS_PER_TURN
      parseFailed: 0,   // parseGenerate/Transform/Music returned an error before any build/dispatch work
      dispatchFailed: 0,// build/dispatch returned not-ok (model unresolvable, no-canvas resolve failed, no reference, dispatch.ok===false)
      succeeded: 0,     // tool_use SSE event sent with a jobId (real generation kicked off)
      sendErrored: 0,   // tool_use SSE event sent with an error string (any reason)
    };
    // Outcome category each call site declares so we get unambiguous
    // per-failure-mode counts (parse vs dispatch) instead of guessing
    // from a derived "preDispatchFailed" subtraction. Every sendToolUse
    // MUST pass one of these so the per-turn summary is auditable.
    type ToolOutcome = "success" | "parse_error" | "dispatch_error" | "cap";
    const sendToolUse = (payload: Record<string, unknown>, outcome: ToolOutcome): void => {
      if (outcome === "parse_error") toolCounts.parseFailed += 1;
      else if (outcome === "dispatch_error") toolCounts.dispatchFailed += 1;
      // "cap" is counted at the cap branch in processToolBlock so the
      // counter increments even before sendToolUse is reached.
      if (typeof payload.error === "string" && payload.error.length > 0) {
        toolCounts.sendErrored += 1;
      } else if (payload.jobId) {
        toolCounts.succeeded += 1;
      }
      send("tool_use", payload);
    };

    // Cache reference-image probes for the duration of this turn so a
    // multi-variation prompt ("make 3 variations") doesn't re-fetch the
    // same image headers repeatedly.
    const aspectProbeCache = new Map<string, ProbeResult>();

    // Lazy + memoized — only hits the DB if Claude actually calls a video
    // generation in this turn.
    let seedanceAllowedPromise: Promise<boolean> | null = null;
    const getSeedanceAllowed = (): Promise<boolean> => {
      if (!seedanceAllowedPromise) seedanceAllowedPromise = isSeedanceAllowed(userId);
      return seedanceAllowedPromise;
    };

    const processGenerateBlock = async (block: ToolUseBlock): Promise<void> => {
      const parsed = parseGenerateMediaInput(block, lastUserText);
      if ("error" in parsed) {
        sendToolUse({ id: block.id, error: parsed.error }, "parse_error");
        return;
      }
      if (!canvasId) {
        // Mobile (and any surface where the user lives outside a canvas) won't
        // have a canvas selected. Lazy-resolve the user's most recent canvas
        // — or create one — so generation just works. The resolved id flows
        // back to the client in the tool_use event so polling targets the
        // right tray.
        const resolved = await resolveOrCreateCanvasForUser(userId, workspaceId);
        if (!resolved) {
          sendToolUse({
            id: block.id,
            kind: parsed.kind,
            prompt: parsed.prompt,
            tier: parsed.tier,
            aspectRatio: parsed.aspectRatio,
            quality: parsed.quality,
            error: "Couldn't find a canvas to generate into. Try refreshing.",
            errorCode: "no_canvas",
          }, "dispatch_error");
          return;
        }
        canvasId = resolved;
      }
      // Pre-resolve brand overlay decisions so we can:
      //   (a) attach the chosen logo as a real reference image to the
      //       generation request (not only as metadata), and
      //   (b) reuse the same selection in the brand_overlay params block
      //       below — single source of truth.
      //
      // Defaults are deterministic when a brand is active and the
      // generation is an image: use_logo / respect_palette /
      // respect_typography all default to ON unless the caller
      // explicitly opted out (false). Previously these were regex-gated
      // on prompt phrasing, which made on-brand application brittle
      // ("make me a static instagram post" worked but "design a
      // campaign visual" did not). The user (or Claude on their
      // behalf) can still pass false to disable any individual channel
      // for a turn.
      const promptText = parsed.prompt || "";
      const brandActive = !!brandContext && parsed.kind === "image";
      const wantUseLogo = parsed.useLogo !== null ? parsed.useLogo : brandActive;
      const wantRespectPalette = parsed.respectPalette !== null ? parsed.respectPalette : brandActive;
      const wantRespectTypography = parsed.respectTypography !== null
        ? parsed.respectTypography
        : brandActive;
      const brandLogoSel = (brandContext && wantUseLogo)
        ? selectLogoUrl(brandContext, parsed.logoVariant, promptText)
        : { url: null as string | null, variant: null as "light" | "dark" | null };

      // Augment the *generation* prompt with a brand block so the image
      // model sees palette / typography / do-don't guidance even when the
      // user wrote a short prompt. This is in addition to the system
      // prompt steering Claude. Only fired when there's an active brand
      // and at least one channel is intended (logo/palette/typography).
      if (brandContext && parsed.kind === "image" && (wantUseLogo || wantRespectPalette || wantRespectTypography)) {
        const augmentations: string[] = [];
        if (wantRespectPalette && brandContext.palette.length > 0) {
          const swatches = brandContext.palette
            .slice(0, 5)
            .map((p) => p.name ? `${p.name} ${p.hex}` : p.hex)
            .join(", ");
          augmentations.push(`Brand palette: ${swatches}.`);
        }
        if (wantRespectTypography && (brandContext.typography.display || brandContext.typography.body)) {
          const fonts: string[] = [];
          if (brandContext.typography.display) fonts.push(`headlines in ${brandContext.typography.display}`);
          if (brandContext.typography.body) fonts.push(`body in ${brandContext.typography.body}`);
          if (fonts.length > 0) augmentations.push(`Typography: ${fonts.join(", ")}.`);
        }
        if (wantUseLogo && brandLogoSel.url) {
          augmentations.push(`Place the brand logo cleanly in the composition — DO NOT redraw it, use the attached logo reference image as-is.`);
        }
        if (augmentations.length > 0) {
          parsed.prompt = `${parsed.prompt}\n\n[Brand: ${brandContext.name}] ${augmentations.join(" ")}`;
        }
      }

      let referenceUrls = resolveAgentReferences(
        parsed.referenceImageIds,
        canvasAttachments,
        inlineHistory,
        pinnedRefs,
        lastUserText,
        parsed.kind,
        parsed.videoReferenceMode,
        brandContext,
        productMap,
      );
      // Ensure the brand logo is actually attached as a reference image to
      // the dispatched generation when use_logo is on — without this the
      // image model only sees the prompt augmentation, which can't render
      // the logo correctly. Image kind only; capped at 4 refs total.
      if (brandLogoSel.url && parsed.kind === "image" && !referenceUrls.includes(brandLogoSel.url) && referenceUrls.length < 4) {
        referenceUrls = [...referenceUrls, brandLogoSel.url];
      }
      // Auto-attach product reference images when products are pinned
      // for this turn. Two cases:
      //   - parsed.kind === "image": always (covers generate, image-edit
      //     i.e. img2img — same code path on the model side).
      //   - parsed.kind === "video" AND parsed.videoReferenceMode is set:
      //     the user has explicitly told us how refs should be applied
      //     (start_frame / first_last / blend), so flowing the pinned
      //     product image into that slot is what they want.
      // Without a videoReferenceMode the product is intentionally NOT
      // attached — the system prompt instructs Claude to ask the user
      // first, and silent attachment would surprise them.
      // Capped at 4 refs total (shared with brand logo + canvas +
      // inline).
      const productAttachKind: "image" | "video" | null =
        parsed.kind === "image"
          ? "image"
          : (parsed.kind === "video" && parsed.videoReferenceMode != null ? "video" : null);
      if (productAttachKind && productContexts.length > 0) {
        for (const p of productContexts) {
          if (referenceUrls.length >= 4) break;
          for (const url of p.imageUrls) {
            if (referenceUrls.length >= 4) break;
            if (!referenceUrls.includes(url)) referenceUrls = [...referenceUrls, url];
          }
        }
        // Prepend product names + descriptions to the prompt so the model
        // depicts the right subject even when the user wrote a terse
        // follow-up. Skip when the prompt already cites every product
        // by name (case-insensitive substring match).
        const promptLower = (parsed.prompt || "").toLowerCase();
        const annotations: string[] = [];
        for (const p of productContexts) {
          const named = promptLower.includes(p.name.toLowerCase());
          const desc = p.description ? p.description.slice(0, 240) : "";
          if (!named || desc) {
            annotations.push(
              named
                ? `"${p.name}": ${desc || "(see reference image)"}`
                : `Subject "${p.name}"${desc ? ` — ${desc}` : ""} (see attached reference image).`
            );
          }
        }
        if (annotations.length > 0) {
          parsed.prompt = `${parsed.prompt}\n\n[Products] ${annotations.join(" ")}`;
        }
      }
      // transform_media (background removal, upscale, resize) takes a
      // single referenceImageId. When Claude passes a product:<slug>
      // id there, resolveReferenceIds (called via the transform path)
      // already maps it through productMap, so no extra plumbing is
      // needed here — this comment is the contract.
      const seedanceAllowed = parsed.kind === "video" ? await getSeedanceAllowed() : true;
      let built = buildGenerateBody(parsed, referenceUrls, canvasId, workspaceId, seedanceAllowed);

      // For image-to-video (i2v) and first-last-frame (flf2v) variants, the
      // reference image becomes the actual frame of the video, so its aspect
      // ratio must match the output. When Claude didn't pick an AR explicitly
      // we default to "1:1" up in parseGenerateMediaInput, which lands a
      // square placeholder and tells the upstream backend to render a square
      // — wrong for a 16:9 source. Probe the first ref's true dimensions and
      // snap to the nearest allowed AR. r2v (reference-blending) is left
      // alone because there the AR is a creative output choice, not a frame
      // match. We only override when the AR was *not* explicit so an explicit
      // user / Claude choice always wins.
      if (
        built &&
        parsed.kind === "video" &&
        !parsed.aspectRatioExplicit &&
        referenceUrls.length > 0 &&
        (built.resolvedModel.endsWith("-i2v") || built.resolvedModel.endsWith("-flf2v"))
      ) {
        try {
          let meta = aspectProbeCache.get(referenceUrls[0]) ?? null;
          if (!aspectProbeCache.has(referenceUrls[0])) {
            try {
              const probed = await Promise.race([
                probe(referenceUrls[0]),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error("probe timeout")), 4000)),
              ]);
              meta = probed && probed.width && probed.height
                ? { width: probed.width, height: probed.height }
                : null;
            } catch {
              meta = null;
            }
            aspectProbeCache.set(referenceUrls[0], meta);
          }
          if (meta) {
            const bestLabel = nearestAspectLabel(meta.width, meta.height);
            built.body.aspect_ratio = bestLabel;
            parsed.aspectRatio = bestLabel;
          }
        } catch (err) {
          console.warn("[agent] i2v/flf2v AR probe failed for", referenceUrls[0], err);
        }
      }

      // Pre-flight: gpt-image-2 rejects reference images whose long edge is
      // more than 3x the short edge (an OpenAI-side hard limit). When the
      // resolved model is gpt-image-2-edit and any reference violates that
      // ratio, swap to nano-banana-2 (same premium tier, no AR limit) and
      // surface a notice so the chat can explain the swap. Checking the
      // *resolved* model — not just the explicit name — keeps this correct
      // if gpt-image-2 ever becomes a tier-default in the future.
      if (
        built &&
        parsed.kind === "image" &&
        referenceUrls.length > 0 &&
        built.resolvedModel.startsWith("gpt-image-2")
      ) {
        const offender = await findRefWithExtremeAspect(referenceUrls, aspectProbeCache);
        if (offender) {
          parsed.explicitModel = "nano-banana-2";
          built = buildGenerateBody(parsed, referenceUrls, canvasId, workspaceId, seedanceAllowed);
          if (built) {
            const swapNotice =
              `GPT Image 2 can't accept reference images wider than 3:1 ` +
              `(yours is ${offender.width}×${offender.height}). ` +
              `Generated with Nano Banana 2 instead.`;
            built.notice = built.notice ? `${built.notice} ${swapNotice}` : swapNotice;
          }
        }
      }

      if (!built) {
        sendToolUse({
          id: block.id,
          kind: parsed.kind,
          prompt: parsed.prompt,
          tier: parsed.tier,
          aspectRatio: parsed.aspectRatio,
          quality: parsed.quality,
          error: "Could not resolve a generation model for this request.",
        }, "dispatch_error");
        return;
      }
      // Brand IQ application. Resolve each flag against the active brand:
      //   use_logo            → true for static-ad / poster / banner /
      //                         marketing / on-brand prompts, otherwise
      //                         model decides.
      //   logo_variant        → 'auto' picks light/dark from the prompt's
      //                         described background.
      //   respect_palette     → true whenever an active brand exists.
      //   respect_typography  → true when the prompt requests on-image
      //                         text (headline, caption, "that says ...").
      // The resolved flags + brand assets are stored on jobs.params so the
      // fal.ai dispatcher / static-ad renderer can apply them. The brand
      // profile id is also tagged on jobs.params so /api/generate can lift
      // it onto jobs.metadata for analytics + filtering.
      if (brandContext) {
        // Reuse the brand-overlay decisions computed above so params and
        // the actual reference attachment / prompt augmentation stay in
        // sync (single source of truth).
        const existing = (built.body.params as Record<string, unknown> | undefined) || {};
        built.body.params = {
          ...existing,
          brand_profile_id: brandContext.id,
          brand_overlay: {
            use_logo: wantUseLogo,
            logo_url: brandLogoSel.url,
            logo_variant: brandLogoSel.variant,
            logo_light_url: brandContext.logoLightUrl,
            logo_dark_url: brandContext.logoDarkUrl,
            respect_palette: wantRespectPalette,
            palette: wantRespectPalette ? brandContext.palette : [],
            respect_typography: wantRespectTypography,
            typography: wantRespectTypography ? brandContext.typography : {},
          },
        };
      }
      const dispatch = await dispatchAgentGeneration(req, built.body);
      if (!dispatch.ok) {
        sendToolUse({
          id: block.id,
          kind: parsed.kind,
          prompt: parsed.prompt,
          tier: parsed.tier,
          aspectRatio: parsed.aspectRatio,
          quality: parsed.quality,
          model: built.resolvedModel,
          error: dispatch.error,
          errorCode: dispatch.status === 402 ? "insufficient_credits" : undefined,
        }, "dispatch_error");
        return;
      }
      sendToolUse({
        id: block.id,
        kind: parsed.kind,
        prompt: parsed.prompt,
        tier: parsed.tier,
        aspectRatio: parsed.aspectRatio,
        quality: parsed.quality,
        resolution: parsed.resolution,
        model: built.resolvedModel,
        notice: built.notice,
        referenceUrls,
        jobId: dispatch.jobId,
        canvasId,
      }, "success");
    };

    const processTransformBlock = async (block: ToolUseBlock): Promise<void> => {
      const parsed = parseTransformMediaInput(block);
      if ("error" in parsed) {
        sendToolUse({ id: block.id, error: parsed.error }, "parse_error");
        return;
      }
      if (!canvasId) {
        // Same lazy-resolve path as processGenerateBlock so transforms work
        // from the chat surface even when no canvas is selected.
        const resolved = await resolveOrCreateCanvasForUser(userId, workspaceId);
        if (!resolved) {
          sendToolUse({
            id: block.id,
            operation: parsed.operation,
            error: "Couldn't find a canvas to generate into. Try refreshing.",
            errorCode: "no_canvas",
          }, "dispatch_error");
          return;
        }
        canvasId = resolved;
      }
      // Resolve the single reference id Claude named.
      const refs = resolveReferenceIds([parsed.referenceImageId], canvasAttachments, inlineHistory, 1, brandContext, productMap);
      const refUrl = refs[0];
      if (!refUrl) {
        sendToolUse({
          id: block.id,
          operation: parsed.operation,
          error: `Could not find reference image '${parsed.referenceImageId}'. Available: ${[...canvasAttachments.map((_, i) => `canvas:${i+1}`), ...inlineHistory.map((_, i) => `agent:${i+1}`)].join(", ") || "none"}.`,
          errorCode: "no_reference",
        }, "dispatch_error");
        return;
      }
      const built = buildTransformBody(parsed, refUrl, canvasId, workspaceId);
      if (!built) {
        sendToolUse({ id: block.id, operation: parsed.operation, error: "Could not resolve a transform model." }, "dispatch_error");
        return;
      }
      if (brandContext) {
        const existing = (built.body.params as Record<string, unknown> | undefined) || {};
        built.body.params = { ...existing, brand_profile_id: brandContext.id };
      }
      const dispatch = await dispatchAgentGeneration(req, built.body);
      if (!dispatch.ok) {
        sendToolUse({
          id: block.id,
          operation: parsed.operation,
          model: built.resolvedModel,
          error: dispatch.error,
          errorCode: dispatch.status === 402 ? "insufficient_credits" : undefined,
        }, "dispatch_error");
        return;
      }
      // Surface as a kind="image" tool_use so the existing inline-card
      // renderer (which keys off `kind`) shows a shimmer + result image
      // identical to a generate_media call. Resize/upscale/remove-bg all
      // produce a single image output.
      sendToolUse({
        id: block.id,
        kind: "image",
        operation: parsed.operation,
        prompt: parsed.operation === "remove_background"
          ? "Remove background"
          : parsed.operation === "upscale"
            ? `Upscale ${parsed.upscaleFactor}x`
            : `Resize to ${parsed.aspectRatio}`,
        tier: "premium",
        aspectRatio: parsed.aspectRatio,
        quality: "high",
        model: built.resolvedModel,
        referenceUrls: [refUrl],
        jobId: dispatch.jobId,
        canvasId,
      }, "success");
    };

    // Voiceover rides the "music" card kind on purpose: the client's inline
    // audio card, the audio canvas node and the .mp3 download are all keyed
    // off it. `audioKind` is the only thing that distinguishes the two, and
    // it only changes the card label and the Audio Studio clip type.
    const processVoiceoverBlock = async (block: ToolUseBlock): Promise<void> => {
      const parsed = parseGenerateVoiceoverInput(block);
      if ("error" in parsed) {
        sendToolUse({ id: block.id, kind: "music", audioKind: "voiceover", error: parsed.error }, "parse_error");
        return;
      }
      if (!canvasId) {
        const resolved = await resolveOrCreateCanvasForUser(userId, workspaceId);
        if (!resolved) {
          sendToolUse({
            id: block.id,
            kind: "music",
            audioKind: "voiceover",
            prompt: parsed.text,
            error: "Couldn't find a canvas to generate into. Try refreshing.",
            errorCode: "no_canvas",
          }, "dispatch_error");
          return;
        }
        canvasId = resolved;
      }
      const built = buildVoiceoverBody(parsed, canvasId, workspaceId);
      const dispatch = await dispatchAgentGeneration(req, built.body);
      if (!dispatch.ok) {
        sendToolUse({
          id: block.id,
          kind: "music",
          audioKind: "voiceover",
          prompt: parsed.text,
          model: built.resolvedModel,
          error: dispatch.error,
          errorCode: dispatch.status === 402 ? "insufficient_credits" : undefined,
        }, "dispatch_error");
        return;
      }
      sendToolUse({
        id: block.id,
        kind: "music",
        audioKind: "voiceover",
        prompt: parsed.text,
        model: built.resolvedModel,
        jobId: dispatch.jobId,
        canvasId,
      }, "success");
    };

    const processMusicBlock = async (block: ToolUseBlock): Promise<void> => {
      const parsed = parseGenerateMusicInput(block);
      if ("error" in parsed) {
        sendToolUse({ id: block.id, kind: "music", error: parsed.error }, "parse_error");
        return;
      }
      if (!canvasId) {
        const resolved = await resolveOrCreateCanvasForUser(userId, workspaceId);
        if (!resolved) {
          sendToolUse({
            id: block.id,
            kind: "music",
            prompt: parsed.prompt,
            error: "Couldn't find a canvas to generate into. Try refreshing.",
            errorCode: "no_canvas",
          }, "dispatch_error");
          return;
        }
        canvasId = resolved;
      }
      const built = buildMusicBody(parsed, canvasId, workspaceId);
      const dispatch = await dispatchAgentGeneration(req, built.body);
      if (!dispatch.ok) {
        sendToolUse({
          id: block.id,
          kind: "music",
          prompt: parsed.prompt,
          model: built.resolvedModel,
          error: dispatch.error,
          errorCode: dispatch.status === 402 ? "insufficient_credits" : undefined,
        }, "dispatch_error");
        return;
      }
      sendToolUse({
        id: block.id,
        kind: "music",
        prompt: parsed.prompt,
        model: built.resolvedModel,
        jobId: dispatch.jobId,
        canvasId,
        isInstrumental: parsed.isInstrumental,
      }, "success");
    };

    // Counts how many times processToolBlock entered its synchronous
    // bookkeeping prologue (the `handledToolUseIds.add()` line). Cross-
    // checked against handledToolUseIds.size at end-of-turn as an
    // executable invariant: if a future refactor accidentally moves the
    // add() past an `await`, the prologue counter won't keep pace with
    // the set size and we'll throw — surfacing the dispatch-race
    // regression loudly instead of silently double-dispatching.
    let preAwaitBookkeepingReached = 0;
    const processToolBlock = async (block: ToolUseBlock): Promise<void> => {
      // ── BEGIN synchronous prologue (no `await` allowed below until the
      // explicit handoff comment marks the end of the prologue). ──
      // Idempotency + bookkeeping must stay synchronous, before any
      // await, so the streaming contentBlock path and the final-message
      // safety-net path can never double-dispatch the same id when both
      // run in the same turn.
      if (handledToolUseIds.has(block.id)) return;
      const sizeBefore = handledToolUseIds.size;
      handledToolUseIds.add(block.id);
      preAwaitBookkeepingReached += 1;
      // Microtask-safe assertion: add() is a synchronous Set operation,
      // so the size MUST have grown by exactly one before we yield. If
      // it didn't, the Set has been swapped out from under us. We log
      // (rather than throw) so a regression doesn't abort the user's
      // turn — the end-of-turn cross-check below will also surface it,
      // and it's grep-able in the server logs.
      if (handledToolUseIds.size !== sizeBefore + 1) {
        console.error(
          `[agent/tool] INVARIANT BROKEN: handledToolUseIds.add(${block.id}) did not register synchronously (size ${sizeBefore} → ${handledToolUseIds.size}) — dispatch race regressed`,
        );
      }
      // ── END synchronous prologue ──
      if (dispatchedCount >= MAX_GENERATIONS_PER_TURN) {
        toolCounts.capped += 1;
        console.warn(
          `[agent/tool] tool-call cap reached (${MAX_GENERATIONS_PER_TURN}) — ignoring extra call ${block.id}`,
        );
        sendToolUse({
          id: block.id,
          error: `Limit reached: the agent can run at most ${MAX_GENERATIONS_PER_TURN} actions per reply. Ask again to do more.`,
          errorCode: "too_many_generations",
        }, "cap");
        // Append a short note to the assistant text so the chat
        // narration matches what actually ran. Only the FIRST capped
        // block emits the note (subsequent ones would just repeat
        // it). Sent as a `delta` event so the client's existing text
        // accumulator picks it up without any new wiring.
        if (toolCounts.capped === 1) {
          send("delta", {
            text: `\n\n_Stopped at ${MAX_GENERATIONS_PER_TURN} — ask again to run more._`,
          });
        }
        return;
      }
      dispatchedCount += 1;
      toolCounts.dispatched += 1;
      if (block.name === "generate_media") {
        await processGenerateBlock(block);
      } else if (block.name === "transform_media") {
        await processTransformBlock(block);
      } else if (block.name === "generate_music") {
        await processMusicBlock(block);
      } else if (block.name === "generate_voiceover") {
        await processVoiceoverBlock(block);
      }
    };

    // Dispatch tool_use blocks the moment Claude finishes streaming them.
    stream.on("contentBlock", (block) => {
      if (cancelled) return;
      if (block.type !== "tool_use") return;
      if (block.name !== "generate_media" && block.name !== "transform_media"
        && block.name !== "generate_music" && block.name !== "generate_voiceover") return;
      toolCounts.streamed += 1;
      const p = processToolBlock(block as ToolUseBlock).catch((err) => {
        console.error("[agent/tool] streaming dispatch failed", err);
      });
      inFlightDispatches.push(p);
    });

    const final = await stream.finalMessage();
    if (cancelled) {
      // refund (user aborted) — include model metadata so /api/usage's
      // per-model attribution stays correct (refund row would otherwise
      // group as `unknown` and inflate the model's apparent net cost).
      if (debitResult.cost > 0) {
        await refundCreditsWithFallback(
          userId,
          debitResult.cost,
          "agent_chat_cancelled",
          referenceId,
          workspaceId,
          { model: modelEntry.pricingKey, reservedCost: debitResult.cost },
        );
      }
      try { res.end(); } catch {}
      return;
    }

    // Safety net: if any tool_use slipped past contentBlock (older SDK / odd
    // message shape), still process it from the final aggregated message.
    // Both `generate_media` AND `transform_media` are primary agent
    // capabilities — replaying only generate_media here was a regression
    // risk that could silently drop background-removal / upscale /
    // outpaint calls if the streaming event was missed.
    const toolUses = final.content.filter(
      (b): b is ToolUseBlock =>
        b.type === "tool_use" &&
        (b.name === "generate_media" || b.name === "transform_media"
          || b.name === "generate_music" || b.name === "generate_voiceover"),
    );
    for (const block of toolUses) {
      if (handledToolUseIds.has(block.id)) continue;
      // This block was never delivered via the streaming `contentBlock`
      // event — log it explicitly so we can tell when the SDK drops
      // streaming events vs. when the model genuinely emits fewer calls
      // than we expected.
      toolCounts.finalOnly += 1;
      console.warn(
        `[agent/tool] block found ONLY via final-message safety net (streaming event was dropped) id=${block.id} name=${block.name}`,
      );
      await processToolBlock(block);
    }
    // Make sure all streaming dispatches finish before we close the SSE
    // stream so their tool_use SSE event reaches the client.
    if (inFlightDispatches.length > 0) {
      await Promise.all(inFlightDispatches);
    }

    // Executable invariant cross-check: every tool_use block from the
    // final aggregated message must now be in handledToolUseIds, and
    // the count of synchronous-prologue entries must equal the set
    // size. A divergence means the dispatch race in processToolBlock
    // has regressed (the synchronous bookkeeping is no longer reaching
    // pre-await, allowing double-dispatch). We log loudly rather than
    // throwing so the user-facing turn still completes — but the
    // condition is grep-able.
    if (preAwaitBookkeepingReached !== handledToolUseIds.size) {
      console.error(
        `[agent/tool] INVARIANT BROKEN: preAwaitBookkeepingReached=${preAwaitBookkeepingReached} != handledToolUseIds.size=${handledToolUseIds.size} — processToolBlock prologue race regressed`,
      );
    }
    for (const block of toolUses) {
      if (!handledToolUseIds.has(block.id)) {
        console.error(
          `[agent/tool] INVARIANT BROKEN: final-message block ${block.id} (${block.name}) is not in handledToolUseIds after both streaming + safety-net dispatch — processToolBlock skipped a block`,
        );
      }
    }

    // Phantom-tool-turn detection. The model sometimes narrates a
    // generation ("creating it now…", "I'll generate that for you") but
    // emits ZERO tool_use blocks for the entire turn — the SDK didn't
    // drop them, the model genuinely never called the tool. The streaming
    // safety net above only catches blocks Claude emitted, so it can't
    // recover this case. When we see narration with generation intent and
    // no dispatched/streamed/finalOnly tool blocks, we synthesize a
    // tool_use SSE error event so the client drops a visible "failed"
    // card on the canvas + chat (matching the dispatch-error UX from
    // Task #492) instead of leaving the user with an empty promise. We
    // do NOT auto-retry — keep it simple: surface clearly and let the
    // user resend.
    let phantomToolTurn = false;
    if (handledToolUseIds.size === 0 && toolUses.length === 0) {
      const assistantText = final.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof (b as { text?: unknown }).text === "string")
        .map((b) => b.text)
        .join(" ")
        .toLowerCase();
      // Generation-intent verbs in the present/future tense (i.e. the
      // model is claiming it IS doing something, not asking whether to).
      // Word-boundary anchored so "image" or "creative" alone don't
      // trigger; the verb plus an object pattern is what we want.
      // Both branches require BOTH (a) a generation-intent verb in the
      // present/future tense, AND (b) a generation object (image/video/
      // clip/song/picture/etc.). Without the object requirement, ordinary
      // chat like "I'll make a plan" or "I'll create a checklist" trips
      // the detector and injects a false phantom error card. The object
      // list is intentionally narrow — only nouns the generation tools
      // actually produce, plus the canvas/chat-specific surface words.
      const objectRe = /\b(?:image|images|picture|pictures|photo|photos|render|renders|rendering|illustration|illustrations|video|videos|clip|clips|animation|animations|song|songs|track|tracks|music|jingle|anthem|soundtrack|composition|beat|beats|logo|logos|icon|banner|poster|wallpaper|portrait|landscape|painting|drawing|sketch|graphic|graphics|artwork|art piece|cover art|album art|variation|variations|version|versions)\b/;
      const intentVerbRe = /\b(?:i'?ll|i am|i'm|let me|going to|gonna|now)\b[^.?!]{0,80}\b(?:creat|generat|mak|render|draw|paint|compos|design|produc|put(?:ting)?|drop(?:ping)?|whip(?:ping)?|cook(?:ing)?|spin(?:ning)? up|firing|kick(?:ing)? off)\w*\b/;
      const directVerbRe = /\b(?:creating|generating|making|rendering|drawing|composing|designing|producing|putting|placing|dropping|firing off|kicking off|whipping up|cooking up|spinning up)\b/;
      // Conditional / hypothetical clauses ("if you want me to generate…",
      // "let me know if you want…", "would you like me to make…") are NOT
      // promises to execute — they're offers waiting for user confirmation.
      // Suppress the phantom flag when the matching narration sits inside
      // one of these patterns to avoid false-positive failed cards.
      const conditionalRe = /\b(?:if you (?:want|'?d like|'?d prefer)|would you like|do you want|let me know if|want me to|happy to|can (?:also )?(?:make|create|generate|render|draw)|could (?:also )?(?:make|create|generate|render|draw))\b/;
      const hasVerb = intentVerbRe.test(assistantText) || directVerbRe.test(assistantText);
      const hasObject = objectRe.test(assistantText);
      const hasConditional = conditionalRe.test(assistantText);
      if (hasVerb && hasObject && !hasConditional) {
        phantomToolTurn = true;
        console.warn(
          `[agent/tool] phantom_tool_turn detected — assistant narrated a generation but emitted 0 tool_use blocks (userId=${userId}, model=${modelKey}, stopReason=${final.stop_reason ?? "null"})`,
        );
        // Synthetic tool_use error event. id is namespaced so the client
        // can tell it apart from a real Anthropic block id if it ever
        // matters. The client's existing "tool_use with error" handler
        // (Task #492) drops a failed card on the canvas + chat for us.
        send("tool_use", {
          id: `phantom-${referenceId}`,
          error: "The agent said it would generate something but didn't actually call the tool. Try asking again — usually fixes it.",
          errorCode: "phantom_tool_turn",
        });
      }
    }

    // Per-turn tool-call summary. Sent to the browser as a `tool_summary`
    // SSE event AND logged server-side so a single repro of the
    // "narrated 3 / placed 1" bug is enough to attribute the gap to the
    // right failure mode (model emitted fewer calls, server capped,
    // parse failed, dispatch failed, phantom turn, or events lost between
    // server and client). `finalToolBlocks` is the authoritative count
    // from Anthropic's aggregated message — the truth the model actually
    // emitted. parseFailed / dispatchFailed / phantomToolTurn are
    // explicit (not derived) so the failure mode is unambiguous.
    const finalToolBlocks = toolUses.length;
    const toolSummary = {
      finalToolBlocks,
      streamed: toolCounts.streamed,
      finalOnly: toolCounts.finalOnly,
      dispatched: toolCounts.dispatched,
      capped: toolCounts.capped,
      parseFailed: toolCounts.parseFailed,
      dispatchFailed: toolCounts.dispatchFailed,
      succeeded: toolCounts.succeeded,
      sendErrored: toolCounts.sendErrored,
      phantomToolTurn,
      stopReason: final.stop_reason ?? null,
      cap: MAX_GENERATIONS_PER_TURN,
    };
    console.log("[agent/tool_summary]", { userId, modelKey, ...toolSummary });
    send("tool_summary", toolSummary);

    finishedOk = true;
    // Compute conversation context usage so the client can warn the user
    // when they're approaching the model's input window. We use only the
    // input-side count (input_tokens + cache_read + cache_creation) because
    // that's what gets re-sent on the next turn — output tokens are not
    // carried forward as input on the following request.
    const u = final.usage as unknown as {
      input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      output_tokens?: number;
    };
    const inputTokensUsed =
      (u?.input_tokens ?? 0) +
      (u?.cache_read_input_tokens ?? 0) +
      (u?.cache_creation_input_tokens ?? 0);
    const limit = modelEntry.inputTokenLimit;
    const fraction = limit > 0 ? inputTokensUsed / limit : 0;

    // Lightweight observability: log per-turn token usage so we can
    // measure prompt-cache hit rates and savings post-deploy. Plain
    // server-side logging only — no UI surface.
    console.log("[agent/usage]", {
      userId,
      modelKey,
      input_tokens: u?.input_tokens ?? 0,
      cache_read_input_tokens: u?.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: u?.cache_creation_input_tokens ?? 0,
      output_tokens: u?.output_tokens ?? 0,
      total_input_window: inputTokensUsed,
      messages: messagesForApi.length,
      images: prepared.imageCount,
      droppedForWindow: prepared.droppedForWindow,
      includeMusicTool,
      includeVoiceoverTool,
      includeBrandBlock,
      includeProductBlock: visibleProducts.length > 0,
      refCatalogSize: referenceCatalog.length,
    });

    // Settle token-billed models against real Anthropic usage. If usage is
    // missing entirely (older SDK shape, mid-stream truncation), refund the
    // full reservation rather than charging for an uncertain call. Cache
    // reads/creations are billed at the same input rate as fresh input
    // tokens — we deliberately do not discount them because Anthropic
    // already passes the savings through in lower input_tokens counts.
    let billedCost = debitResult.cost;
    if (isTokenBilled) {
      const outTok = u?.output_tokens ?? 0;
      if (inputTokensUsed === 0 && outTok === 0) {
        if (debitResult.cost > 0) {
          await refundCreditsWithFallback(
            userId,
            debitResult.cost,
            "agent_chat_no_usage",
            referenceId,
            workspaceId,
            { model: modelEntry.pricingKey, reservedCost: debitResult.cost },
          );
        }
        billedCost = 0;
      } else {
        const settled = await settleAgentCredits({
          userId,
          modelKey: modelEntry.pricingKey,
          reservedCost: debitResult.cost,
          reservationLedgerId: debitResult.ledgerId,
          actualInputTokens: inputTokensUsed,
          actualOutputTokens: outTok,
          referenceId,
          orgId: workspaceId,
        });
        billedCost = settled.actualCost;
      }
    }

    send("done", {
      stop_reason: final.stop_reason,
      usage: final.usage,
      billedCost,
      contextUsage: {
        inputTokensUsed,
        outputTokens: u?.output_tokens ?? 0,
        inputTokenLimit: limit,
        fraction,
        warnFraction: CONTEXT_WARN_FRACTION,
        criticalFraction: CONTEXT_CRITICAL_FRACTION,
      },
    });
    res.end();
  } catch (err) {
    const errorMsg = friendlyAnthropicError(err);
    console.error("[agent/chat] error:", err);
    if (!finishedOk && debitResult.cost > 0) {
      await refundCreditsWithFallback(
        userId,
        debitResult.cost,
        "agent_chat_failed",
        referenceId,
        workspaceId,
        { model: modelEntry.pricingKey, reservedCost: debitResult.cost },
      );
    }
    try {
      send("error", { error: errorMsg });
      res.end();
    } catch {
      try { res.end(); } catch {}
    }
  }
});

// ---------------------------------------------------------------------------
// Programmatic tool endpoints (MCP bridge — Phase J).
//
// These expose the SAME tuned tool schemas + input→job mapping the in-app agent
// uses, but driven by an out-of-process caller (the stdio MCP server in
// server/mcp/) instead of the Anthropic streaming loop. Because that MCP server
// is a separate process, the sharing boundary is HTTP — it GETs the schemas and
// POSTs a tool call, and we reuse the existing parse*/build*/dispatch functions
// in this module verbatim. References arrive as already-resolved URLs (the MCP
// server's canvas tools resolve ids→urls), so the in-app reference-catalog
// resolver is intentionally bypassed here. In LOCAL_MODE the loopback call is
// authenticated as the local superadmin with no cookie.

/**
 * Place a "generating" placeholder node on the canvas for a server-initiated
 * (MCP operator) generation and broadcast it live. Operator generations are
 * dispatched server-side, so they never went through the frontend's node
 * creation — this is what makes them actually LAND on the canvas. The frontend
 * canvas poller then resolves the placeholder to the finished asset on job
 * completion. Best-effort: a placement failure never fails the generation.
 */
async function placeAgentGenerationOnCanvas(
  userId: string,
  canvasId: string,
  jobId: string,
  kind: "image" | "video",
  prompt: string,
  sizeHint: { aspectRatio?: string; resolution?: string | null; size?: { w: number; h: number } },
): Promise<void> {
  try {
    // Size the placeholder to the REQUESTED aspect ratio (mirrors the frontend's
    // placeholderSize) so the finished image drops in at true proportions with
    // no resize. "quality" tier + resolution matches startGeneration's call.
    // An explicit `size` wins: a continuation has to match the clip it
    // continues, whatever tier that one happened to be generated at.
    const size = sizeHint.size ?? placeholderSize("quality", sizeHint.aspectRatio, kind, sizeHint.resolution ?? null);

    // Existing occupancy (skip frames/groups — they're containers, not obstacles).
    const existing = await pool.query(
      `SELECT x, y, width, height, node_type FROM canvas_nodes WHERE canvas_id = $1`,
      [canvasId],
    );
    const occupied: Rect[] = existing.rows
      .filter((r) => r.node_type !== "frame" && r.node_type !== "group")
      .map((r) => ({ x: Number(r.x), y: Number(r.y), w: Number(r.width), h: Number(r.height) }));

    // Prefer the viewport the user reported when they sent the message (so the
    // first generation lands on-screen); fall back to a synthesized one.
    const ctx = getOperatorContext(userId);
    const viewport = ctx?.viewport ?? fallbackViewport(occupied, size);
    const rect = placeNext({ viewport, occupied, size });

    const zRes = await pool.query(
      `SELECT COALESCE(MAX(z_index), 0) AS z FROM canvas_nodes WHERE canvas_id = $1`,
      [canvasId],
    );
    const z = ((zRes.rows[0]?.z as number) ?? 0) + 1;
    const id = uuidv4();
    const metadata = { source: "agent", kind, prompt: (prompt || "").slice(0, 300), status: "generating" };
    const res = await pool.query(
      `INSERT INTO canvas_nodes (id, canvas_id, node_type, x, y, width, height, rotation, z_index, locked, visible, label, src, gradient, metadata, asset_id, job_id)
       VALUES ($1, $2, 'generating', $3, $4, $5, $6, 0, $7, false, true, $8, '', '', $9, NULL, $10)
       RETURNING *`,
      [id, canvasId, rect.x, rect.y, size.w, size.h, z, (prompt || "Generating").slice(0, 80), JSON.stringify(metadata), jobId],
    );
    const node = res.rows[0];
    if (redisClient && node) {
      redisSetNodes(canvasId, [node as RedisNodeUpdate]).catch(() => { /* cache best-effort */ });
      scheduleCanvasFlush();
    }
    broadcastCanvasUpdate(canvasId, "");
  } catch (err) {
    console.error("[agent/tool] failed to place generation node on canvas:", err);
  }
}

// Schema discovery: framework-neutral shape (MCP wants `inputSchema`; Anthropic
// wants `input_schema`). The MCP server fetches this to register its tools.
router.get("/api/agent/tools", requireMcpToken, requireAuth, (_req: AuthRequest, res) => {
  const tools = [GENERATE_MEDIA_TOOL, CONTINUE_VIDEO_TOOL, GENERATE_MUSIC_TOOL, GENERATE_VOICEOVER_TOOL, TRANSFORM_MEDIA_TOOL].map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.input_schema,
  }));
  res.json({ tools });
});

// MCP: enumerate available generation models + their media type. Backs the
// `list_models` tool so Claude can self-document what's installed.
router.get("/api/agent/models", requireMcpToken, requireAuth, (_req: AuthRequest, res) => {
  res.json({ models: listAvailableModels() });
});

// MCP: what fal would actually charge for a generation, in USD, at cost. Backs
// the `estimate_cost` tool so Claude can answer "what would this cost?" and
// compare models before spending the user's own fal balance.
router.post("/api/agent/cost", requireMcpToken, requireAuth, (req: AuthRequest, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const requested = typeof body.model === "string" ? body.model : null;
  // No model named -> price the whole catalog for the given params, so the
  // agent can say which is cheapest rather than guessing.
  // A family name ("h3-turbo", "h3 max turbo") prices its text variant: the
  // skills teach family names, so the estimator must take them too.
  const keys = requested
    ? [estimateFalCost(requested) ? requested : resolveExplicitModel(requested)?.t2 ?? requested]
    : falPricedModelKeys();
  const num = (v: unknown) => {
    const n = Number(v);
    return isFinite(n) && n > 0 ? n : undefined;
  };
  const params = {
    resolution: typeof body.resolution === "string" ? body.resolution : undefined,
    features: Array.isArray(body.features) ? (body.features as string[]) : undefined,
    duration: num(body.duration),
    quantity: num(body.quantity),
    characters: num(body.characters),
  };
  const estimates = keys
    .map((modelKey) => ({
      model: modelKey,
      ...estimateFalCost(modelKey, params, unitPriceFor(modelKey)),
    }))
    .filter((e) => typeof e.usd === "number");
  if (requested && estimates.length === 0) {
    res.status(404).json({ error: `No fal pricing for model "${requested}".` });
    return;
  }
  res.json({ estimates, pricing: falPricingStatus() });
});

// MCP: list recent completed generations for the local user (optionally scoped
// to a canvas/workspace). These are the assets on the canvas Claude can iterate
// on — it passes a returned `url` back in `referenceUrls`. Backs `list_canvas`.
router.get("/api/agent/assets", requireMcpToken, requireAuth, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "20"), 10) || 20, 1), 50);
  const canvasId = typeof req.query.canvas_id === "string" ? req.query.canvas_id : undefined;
  let workspaceId = typeof req.query.workspace_id === "string" ? req.query.workspace_id : undefined;
  try {
    // Canvas placement isn't recorded on the job row, so scope by workspace. If a
    // canvas_id is given, resolve its owning workspace and filter on that.
    if (!workspaceId && canvasId) {
      const ws = await pool.query(`SELECT workspace_id FROM canvas_states WHERE id = $1`, [canvasId]);
      workspaceId = ws.rows[0]?.workspace_id as string | undefined;
    }
    const clauses = ["user_id = $1", "status = 'complete'", "result_url IS NOT NULL"];
    const vals: unknown[] = [userId];
    if (workspaceId) { vals.push(workspaceId); clauses.push(`workspace_id = $${vals.length}`); }
    vals.push(limit);
    const result = await pool.query(
      `SELECT id, type, model, result_url, params, created_at
         FROM jobs
        WHERE ${clauses.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT $${vals.length}`,
      vals,
    );
    const assets = result.rows.map((r) => ({
      id: r.id as string,
      type: r.type as string,
      model: r.model as string,
      url: r.result_url as string,
      prompt: typeof (r.params as Record<string, unknown> | null)?.prompt === "string"
        ? ((r.params as Record<string, unknown>).prompt as string)
        : undefined,
      createdAt: r.created_at,
    }));
    res.json({ assets });
  } catch (err) {
    console.error("[agent/assets] error:", err);
    res.status(500).json({ error: "Failed to list assets." });
  }
});

// MCP: fetch a single asset's metadata by job id. Backs `get_asset`; the MCP
// server additionally loopback-fetches the url bytes to hand Claude a thumbnail.
router.get("/api/agent/asset/:id", requireMcpToken, requireAuth, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const jobId = req.params.id;
  try {
    const result = await pool.query(
      `SELECT id, user_id, type, model, status, result_url, params, error, created_at
         FROM jobs WHERE id = $1`,
      [jobId],
    );
    if (result.rows.length === 0) { res.status(404).json({ error: "Asset not found." }); return; }
    const row = result.rows[0];
    if (row.user_id !== userId) { res.status(403).json({ error: "Forbidden" }); return; }
    const params = (row.params || {}) as Record<string, unknown>;
    res.json({
      id: row.id,
      type: row.type,
      model: row.model,
      status: row.status,
      url: row.result_url,
      prompt: typeof params.prompt === "string" ? params.prompt : undefined,
      error: row.error,
      createdAt: row.created_at,
    });
  } catch (err) {
    console.error("[agent/asset] error:", err);
    res.status(500).json({ error: "Failed to fetch asset." });
  }
});

// Single tool invocation: parse → build /api/generate body → dispatch. Returns
// the jobId; the caller polls /api/job/:id (the MCP server does this and blocks
// until the result lands).
router.post("/api/agent/tool", requireMcpToken, requireAuth, requireVerifiedEmail, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const reqBody = (req.body || {}) as {
    tool?: string;
    input?: Record<string, unknown>;
    referenceUrls?: unknown;
    canvas_id?: string;
    workspace_id?: string;
  };
  const toolName = reqBody.tool;
  const input = (reqBody.input && typeof reqBody.input === "object") ? reqBody.input : {};
  const bodyRefs: string[] = Array.isArray(reqBody.referenceUrls)
    ? reqBody.referenceUrls.filter((u): u is string => typeof u === "string" && u.length > 0)
    : [];
  // Merge the references the user attached in the operator panel (canvas
  // selection + uploads, stashed at message send time) ahead of any the model
  // discovered itself — the user's picks are the stronger signal. Dedupe, cap 4.
  // Local/loopback URLs are made fal-reachable at dispatch (makeReferencesFalReachable).
  const ctxRefs = getOperatorContext(userId)?.referenceUrls ?? [];
  const referenceUrls: string[] = Array.from(new Set([...ctxRefs, ...bodyRefs])).slice(0, 4);

  // Resolve a canvas (+ its workspace) for placement. Priority: an explicit
  // canvas_id from the caller → the canvas the operator user currently has open
  // (captured at message send time) → reuse/create the local user's canvas. The
  // middle step makes operator generations land on the project the user is
  // actually looking at rather than a default one.
  let canvasId = reqBody.canvas_id;
  if (!canvasId) {
    const ctxCanvas = getOperatorContext(userId)?.canvasId;
    if (ctxCanvas) {
      const owns = await pool.query(`SELECT 1 FROM canvas_states WHERE id = $1 AND user_id = $2`, [ctxCanvas, userId]);
      if (owns.rows.length > 0) canvasId = ctxCanvas;
    }
  }
  if (!canvasId) canvasId = await resolveOrCreateCanvasForUser(userId, reqBody.workspace_id);
  if (!canvasId) {
    res.status(400).json({ error: "No canvas available to place the result. Open a project in the app first." });
    return;
  }
  let workspaceId = reqBody.workspace_id;
  if (!workspaceId) {
    try {
      const ws = await pool.query(`SELECT workspace_id FROM canvas_states WHERE id = $1`, [canvasId]);
      workspaceId = ws.rows[0]?.workspace_id as string | undefined;
    } catch { /* leave undefined */ }
  }

  // parse* expect an Anthropic ToolUseBlock; only .id and .input are read.
  const mkBlock = (name: string): ToolUseBlock =>
    ({ type: "tool_use", id: `mcp-${Date.now()}`, name, input } as unknown as ToolUseBlock);

  try {
    if (toolName === "generate_media") {
      const parsed = parseGenerateMediaInput(mkBlock("generate_media"), "");
      if ("error" in parsed) { res.status(400).json({ error: parsed.error }); return; }
      // Lineage: when a canvas image is attached and neither the user nor the
      // model pinned an aspect ratio, inherit the reference's AR so the new
      // generation matches the source it's derived from.
      const ctxAr = getOperatorContext(userId)?.referenceAspectRatio;
      if (!parsed.aspectRatioExplicit && ctxAr && GEN_ALLOWED_AR.has(ctxAr)) {
        parsed.aspectRatio = ctxAr;
      }
      // Over the bridge a reference is the OPERATOR's own choice (a keyframe it
      // just generated), not an ambiguous image the user dropped on a video
      // request — so the in-app "ask which mode" rule doesn't apply. Default the
      // mode instead of asking: without one, buildGenerateBody silently drops
      // the reference and dispatches text-to-video, which is exactly how a
      // keyframe-chained sequence loses continuity shot by shot.
      if (parsed.kind === "video" && referenceUrls.length > 0 && parsed.videoReferenceMode == null) {
        parsed.videoReferenceMode = referenceUrls.length === 1 ? "first_frame" : "references";
      }
      // A clip handed in as an image reference (the operator "continuing" a
      // video through generate_media instead of continue_video) fails at fal
      // as an unreadable image. Hand over its last frame instead.
      if (parsed.kind === "video") {
        for (let i = 0; i < referenceUrls.length; i++) {
          if (/\.(mp4|mov|webm|m4v)(\?|$)/i.test(referenceUrls[i])) {
            try { referenceUrls[i] = await extractLastFrame(referenceUrls[i]); }
            catch (err) { res.status(400).json({ error: `Couldn't read a frame from ${referenceUrls[i]}: ${err instanceof Error ? err.message : String(err)}` }); return; }
          }
        }
      }
      const seedanceAllowed = parsed.kind === "video" ? await isSeedanceAllowed(userId) : true;
      const built = buildGenerateBody(parsed, referenceUrls, canvasId, workspaceId, seedanceAllowed);
      if (!built) { res.status(400).json({ error: "This request couldn't be mapped to a supported generation." }); return; }
      const dispatch = await dispatchAgentGeneration(req, built.body);
      if (!dispatch.ok) { res.status(dispatch.status).json({ error: dispatch.error }); return; }
      await placeAgentGenerationOnCanvas(
        userId, canvasId, dispatch.jobId!, parsed.kind === "video" ? "video" : "image", parsed.prompt,
        { aspectRatio: parsed.aspectRatio, resolution: parsed.resolution },
      );
      res.json({ jobId: dispatch.jobId, type: built.type, model: built.resolvedModel, canvasId });
      return;
    }
    if (toolName === "continue_video") {
      const src = typeof input.sourceUrl === "string" ? input.sourceUrl.trim() : "";
      const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
      if (!src) { res.status(400).json({ error: "continue_video requires `sourceUrl` — the clip to continue from." }); return; }
      if (!prompt) { res.status(400).json({ error: "continue_video requires a `prompt` describing what happens next." }); return; }
      const seam = input.seam === "reference" ? "reference" : "frame";
      // seam='frame' rides each family's i2v endpoint (the seed frame is the
      // link); seam='reference' rides its r2v endpoint (tail clip + stills).
      const family = input.model === "seedance-2.5" ? "seedance-2.5" : input.model === "h3-turbo" ? "h3-turbo" : "h3-max";
      const duration = snapDurationForModel(family, Number(input.durationSeconds) || 5);

      // Pull the handoff off the previous clip. This is the whole technique:
      // the next chunk is an ordinary H3 generation whose reference IS the end
      // of the last one, so continuity is carried by the model's own inputs.
      let handoff: string;
      try {
        handoff = seam === "reference"
          ? await extractTailClip(src, Number(input.tailSeconds) || DEFAULT_TAIL_SECONDS)
          : await extractLastFrame(src);
      } catch (err) {
        // A bad seam is worth failing on: continuing from the wrong frame
        // silently produces a cut, which is the exact failure this tool exists
        // to prevent.
        const msg = err instanceof VideoTailError ? err.message : "Couldn't read the end of that clip.";
        res.status(400).json({ error: msg });
        return;
      }

      // The source clip's node, read BEFORE dispatch: it carries the geometry
      // of the clip being continued, and that geometry has to reach the
      // generation, not just the placeholder.
      const prevNode = await pool.query(
        `SELECT width, height FROM canvas_nodes WHERE canvas_id = $1 AND src = $2 ORDER BY z_index DESC LIMIT 1`,
        [canvasId, src],
      );
      const prev = prevNode.rows[0];

      // seam='frame' pins the shape for free — the seed frame IS the aspect
      // ratio. seam='reference' gets only a tail clip, does NOT read the
      // dimensions off it, and falls back to a 16:9 default, so a portrait
      // sequence turns landscape mid-cut. Send the ratio explicitly: whatever
      // the caller asked for, else the source clip's own shape.
      const askedAr = typeof input.aspectRatio === "string" && GEN_ALLOWED_AR.has(input.aspectRatio)
        ? input.aspectRatio
        : undefined;
      const sourceAr = prev && Number(prev.width) > 0 && Number(prev.height) > 0
        ? nearestAspectLabel(Number(prev.width), Number(prev.height))
        : undefined;
      const aspectRatio = askedAr ?? sourceAr;

      const body: Record<string, unknown> = {
        type: "video_gen",
        // Turbo has no r2v endpoint; its reference seam borrows H3 Max's.
        model: seam === "reference" ? `${family === "h3-turbo" ? "h3-max" : family}-r2v` : `${family}-i2v`,
        prompt,
        duration,
        // Inherit the source clip's resolution tier when the caller doesn't
        // name one — otherwise undefined falls to each family's own default
        // and a chain can jump tiers mid-sequence. Snapped to the family's
        // ladder here because probeMinDimension returns raw pixels.
        resolution: typeof input.resolution === "string" ? input.resolution
          : await probeMinDimension(src).then((d) => d === undefined ? undefined
            : family === "seedance-2.5"
              ? (d <= 480 ? "480p" : d <= 720 ? "720p" : "1080p")
              : (d <= 480 ? "480p" : "768p")),
        aspect_ratio: aspectRatio,
        // fal.ts checks generateAudio === true strictly; leaving it unset made
        // every continuation chunk silent. Default on, like generate_media.
        generateAudio: input.generateAudio !== false,
        canvas_id: canvasId,
        workspace_id: workspaceId,
        // seam recorded so set_timeline can auto-trim the duplicated frame a
        // seam='frame' continuation starts on (see routes/agentTimeline.ts).
        params: { source: "agent", continuedFrom: src, seam },
      };
      if (seam === "reference") {
        body.referenceVideoUrls = [handoff];
        // Pinned stills (characters, palette) ride along on every chunk, which
        // is what holds identity together once the tail is many chunks behind.
        if (referenceUrls.length) body.referenceImageUrls = referenceUrls;
      } else {
        body.firstFrameUrl = handoff;
      }

      const dispatch = await dispatchAgentGeneration(req, body);
      if (!dispatch.ok) { res.status(dispatch.status).json({ error: dispatch.error }); return; }
      // Match the clip being continued, node for node. Without this the
      // continuation is sized from the default "quality" tier and a chunk-one
      // clip generated at any other tier gets a sibling twice its size.
      await placeAgentGenerationOnCanvas(
        userId, canvasId, dispatch.jobId!, "video", prompt,
        {
          aspectRatio,
          resolution: null,
          size: prev ? { w: Number(prev.width), h: Number(prev.height) } : undefined,
        },
      );
      res.json({
        jobId: dispatch.jobId, type: "video_gen",
        model: body.model, canvasId, seam, handoffUrl: handoff, durationSeconds: duration, aspectRatio,
      });
      return;
    }
    if (toolName === "transform_media") {
      const parsed = parseTransformMediaInput(mkBlock("transform_media"));
      if ("error" in parsed) { res.status(400).json({ error: parsed.error }); return; }
      const refUrl = referenceUrls[0];
      if (!refUrl) { res.status(400).json({ error: "transform_media requires a reference image URL in referenceUrls." }); return; }
      const built = buildTransformBody(parsed, refUrl, canvasId, workspaceId);
      if (!built) { res.status(400).json({ error: "Unsupported transform operation." }); return; }
      const dispatch = await dispatchAgentGeneration(req, built.body);
      if (!dispatch.ok) { res.status(dispatch.status).json({ error: dispatch.error }); return; }
      // A 'resize' outputs the requested aspect ratio; other transforms keep the
      // source's shape — probe the reference so the placeholder matches it.
      let transformAr: string | undefined;
      if (parsed.operation === "resize") {
        transformAr = parsed.aspectRatio;
      } else {
        try {
          const dim = await probe(refUrl);
          if (dim?.width && dim?.height) transformAr = `${dim.width}:${dim.height}`;
        } catch { /* fall back to square placeholder */ }
      }
      await placeAgentGenerationOnCanvas(
        userId, canvasId, dispatch.jobId!, "image", parsed.prompt || "Transform",
        { aspectRatio: transformAr },
      );
      res.json({ jobId: dispatch.jobId, type: built.type, model: built.resolvedModel, canvasId });
      return;
    }
    if (toolName === "generate_music") {
      const parsed = parseGenerateMusicInput(mkBlock("generate_music"));
      if ("error" in parsed) { res.status(400).json({ error: parsed.error }); return; }
      const built = buildMusicBody(parsed, canvasId, workspaceId);
      if (!built) { res.status(400).json({ error: "Couldn't build the music request." }); return; }
      const dispatch = await dispatchAgentGeneration(req, built.body);
      if (!dispatch.ok) { res.status(dispatch.status).json({ error: dispatch.error }); return; }
      res.json({ jobId: dispatch.jobId, type: built.type, model: built.resolvedModel, canvasId });
      return;
    }
    if (toolName === "generate_voiceover") {
      const parsed = parseGenerateVoiceoverInput(mkBlock("generate_voiceover"));
      if ("error" in parsed) { res.status(400).json({ error: parsed.error }); return; }
      const built = buildVoiceoverBody(parsed, canvasId, workspaceId);
      const dispatch = await dispatchAgentGeneration(req, built.body);
      if (!dispatch.ok) { res.status(dispatch.status).json({ error: dispatch.error }); return; }
      res.json({ jobId: dispatch.jobId, type: built.type, model: built.resolvedModel, canvasId });
      return;
    }
    res.status(400).json({ error: `Unknown tool: ${toolName ?? "(none)"}. Expected generate_media, continue_video, transform_media, generate_music, or generate_voiceover.` });
  } catch (err) {
    console.error("[agent/tool] error:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "Internal error" });
  }
});

// ---------------------------------------------------------------------------
// Canvas layout, for the operator. `list_canvas` shows *generations*; these two
// show and move the *nodes* — the operator's eyes and hands for tidying up.
// Both act on the canvas the user is currently looking at (the operator context
// set at the top of the turn), so neither takes a canvas id.
// ---------------------------------------------------------------------------

/** Resolve the canvas this operator turn is looking at, or answer 400. */
function operatorCanvas(userId: string, res: Response): string | null {
  const canvasId = getOperatorContext(userId)?.canvasId;
  if (!canvasId) {
    res.status(400).json({ error: "No canvas in view. Open a project first." });
    return null;
  }
  return canvasId;
}

// Backs `see_canvas`.
router.get("/api/agent/canvas", requireMcpToken, requireAuth, async (req: AuthRequest, res) => {
  const canvasId = operatorCanvas(req.userId!, res);
  if (!canvasId) return;
  try {
    const { rows } = await pool.query(
      `SELECT id, node_type, label, x, y, width, height, locked
         FROM canvas_nodes WHERE canvas_id = $1 ORDER BY created_at`,
      [canvasId],
    );
    res.json({
      canvasId,
      viewport: getOperatorContext(req.userId!)?.viewport ?? null,
      nodes: rows.map((r) => ({
        id: r.id as string,
        type: r.node_type as string,
        label: (r.label as string | null) ?? "",
        x: Number(r.x), y: Number(r.y),
        width: Number(r.width), height: Number(r.height),
        locked: !!r.locked,
      })),
    });
  } catch (err) {
    console.error("[agent/canvas] list error:", err);
    res.status(500).json({ error: "Failed to read the canvas" });
  }
});

export type ArrangeMove = { id: string; x?: number; y?: number; width?: number; height?: number };

const MAX_MOVES = 200;
const STEP_MS = 250;

/** Validate an `arrange_canvas` payload. Exported for the self-check in
 *  agent.arrange.test.ts — the model sends these ids and numbers straight from
 *  its own head, so this is a trust boundary. */
export function parseArrangeMoves(moves: unknown): { moves: ArrangeMove[] } | { errors: string[] } {
  if (!Array.isArray(moves) || moves.length === 0) return { errors: ["moves must be a non-empty array"] };
  if (moves.length > MAX_MOVES) return { errors: [`Too many moves (${moves.length}); max ${MAX_MOVES}.`] };
  const errors: string[] = [];
  const typed: ArrangeMove[] = [];
  for (const raw of moves as ArrangeMove[]) {
    const id = typeof raw?.id === "string" ? raw.id : "";
    if (!UUID_RE.test(id)) { errors.push(`Bad node id: ${JSON.stringify(raw?.id)}`); continue; }
    let bad = false;
    for (const k of ["x", "y", "width", "height"] as const) {
      const v = raw[k];
      if (v === undefined) continue;
      if (typeof v !== "number" || !Number.isFinite(v)) { errors.push(`Node ${id}: ${k} must be a finite number`); bad = true; }
      else if ((k === "width" || k === "height") && v < 0) { errors.push(`Node ${id}: ${k} must be >= 0`); bad = true; }
    }
    if (bad) continue;
    if (raw.x === undefined && raw.y === undefined && raw.width === undefined && raw.height === undefined) {
      errors.push(`Node ${id}: nothing to change`);
      continue;
    }
    typed.push({ id, x: raw.x, y: raw.y, width: raw.width, height: raw.height });
  }
  return errors.length > 0 ? { errors } : { moves: typed };
}

// Backs `arrange_canvas`. Applies the moves one at a time, with the bot's
// presence cursor hopping to each node first — so the user watches it walk the
// canvas rather than everything teleporting at once.
router.post("/api/agent/canvas/arrange", requireMcpToken, requireAuth, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const canvasId = operatorCanvas(userId, res);
  if (!canvasId) return;

  const parsed = parseArrangeMoves((req.body || {}).moves);
  if ("errors" in parsed) { res.status(400).json({ error: "Invalid moves", details: parsed.errors }); return; }
  const typed = parsed.moves;

  const sessionId = crypto.randomUUID();
  let joined = false;
  try {
    const { rows } = await pool.query(
      `SELECT id, x, y, width, height, locked FROM canvas_nodes
        WHERE canvas_id = $1 AND id = ANY($2::uuid[])`,
      [canvasId, typed.map((m) => m.id)],
    );
    const byId = new Map(rows.map((r) => [r.id as string, r]));

    const moved: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    const applicable: ArrangeMove[] = [];
    for (const m of typed) {
      const node = byId.get(m.id);
      if (!node) skipped.push({ id: m.id, reason: "not on this canvas" });
      else if (node.locked) skipped.push({ id: m.id, reason: "locked" });
      else applicable.push(m);
    }

    const transport = getPresenceTransport();
    if (applicable.length > 0) {
      const add = presenceAddSession(canvasId, {
        sessionId,
        userId,
        displayName: getOperatorContext(userId)?.botName || "Agent",
        avatarUrl: null,
        role: "owner",
        bindingToken: crypto.randomBytes(24).toString("hex"),
      });
      joined = true;
      broadcastPresenceJoin(transport, canvasId, add.user, sessionId);
    }

    for (const m of applicable) {
      const node = byId.get(m.id)!;
      const x = m.x ?? Number(node.x);
      const y = m.y ?? Number(node.y);
      const w = m.width ?? Number(node.width);
      const h = m.height ?? Number(node.height);

      // Cursor first, then the move — the user sees the bot reach for the node.
      presenceSetCursor(canvasId, sessionId, x + w / 2, y + h / 2);
      broadcastPresenceCursor(transport, canvasId, { sessionId, userId, x: x + w / 2, y: y + h / 2 });

      const updated = await pool.query(
        `UPDATE canvas_nodes SET x = $1, y = $2, width = $3, height = $4
          WHERE canvas_id = $5 AND id = $6 RETURNING *`,
        [x, y, w, h, canvasId, m.id],
      );
      if (updated.rows[0] && redisClient) {
        redisSetNodes(canvasId, [updated.rows[0] as RedisNodeUpdate]).catch(() => { /* cache best-effort */ });
        scheduleCanvasFlush();
      }
      broadcastCanvasUpdate(canvasId, "");
      moved.push(m.id);
      await new Promise((r) => setTimeout(r, STEP_MS));
    }

    res.json({ moved, skipped });
  } catch (err) {
    console.error("[agent/canvas] arrange error:", err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to arrange the canvas" });
  } finally {
    if (joined) {
      presenceRemoveSession(canvasId, sessionId);
      broadcastPresenceLeave(getPresenceTransport(), canvasId, sessionId, userId);
    }
  }
});

export default router;
