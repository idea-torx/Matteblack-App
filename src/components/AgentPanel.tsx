import { useEffect, useMemo, useRef, useState, useCallback, forwardRef, useImperativeHandle } from "react";
import "./AgentPanel.css";
import type { ReferenceImage, CanvasNode } from "../types/canvas";
import { renderMarkdown } from "../utils/markdown";
import { QuantumThinking } from "./QuantumThinking";
import { ThinkingPill } from "./ThinkingPill";
import { useGenerationSound } from "../hooks/useGenerationSound";
import { findEmptySlots, layout, placeholderSize } from "../utils/canvasPlacement";
import {
  type Brand as MentionBrand,
  type BrandSuggestion,
  getMentionAtCursor,
  rankBrands,
  resolveFirstMention,
  normalizeToken,
} from "../lib/brandMention";
import {
  type Product as MentionProduct,
  type ProductSuggestion,
  getProductMentionAtCursor,
  rankProducts,
  resolveAllProductMentions,
} from "../lib/productMention";

export type AgentModelKey = "sonnet" | "haiku";

export type AgentHandoff = {
  prompt: string;
  videoMode: boolean;
  musicMode?: boolean;
  references: ReferenceImage[];
};

// A reference picked from a prior inline generation OR uploaded via the
// composer's "+" button. Survives until the next user send (then is
// consumed and cleared). `source` discriminates between the two so the
// upload path mirrors the canvas-attached reference behavior visually
// and on the server, while "Edit with agent" stays an agent-source carry.
export type AgentExtraRef = {
  id: string;
  url: string;
  label: string;
  kind: "image" | "video";
  source?: "edit" | "upload";
};

// Minimal shape of a tray-style payload we synthesize for canvas drag-and-
// drop. The cinema timeline drop handler expects this `application/x-tray-
// item` JSON shape, so we keep the contract even though the server-side
// generation tray is gone.
type TrayItemPayload = {
  id: string;
  canvas_id: string;
  job_id: string | null;
  status: "pending" | "generating" | "ready" | "done" | "failed" | "cancelled";
  position_x: number;
  position_y: number;
  metadata: Record<string, unknown>;
  created_at: string;
  job_type?: string | null;
  job_params?: Record<string, unknown> | null;
  result_url?: string | null;
  job_status?: string | null;
  prompt?: string;
  asset_type?: string | null;
  error_message?: string | null;
  error_type?: string | null;
  svg_content?: string | null;
};

// Per-job response shape from GET /api/job/:job_id (after T001).
type JobResponse = {
  job_id: string;
  type?: string;
  status: "pending" | "running" | "complete" | "failed" | "cancelled";
  result_url?: string | null;
  error?: string | null;
  error_type?: string | null;
  metadata?: Record<string, unknown> | null;
};

type AgentPanelProps = {
  workspaceId: string | null;
  canvasId: string | null;
  canvasReferenceImages: ReferenceImage[];
  isGuest: boolean;
  onClose: () => void;
  onFullCanvas?: () => void;
  onSettingsOpen?: (section?: string) => void;
  onSignInRequest?: () => void;
  onHandoffToMake: (handoff: AgentHandoff) => void;
  // Optional library save shortcut. If omitted the action button is hidden.
  onSaveToLibrary?: (args: { url: string; kind: "image" | "video" | "music"; prompt: string; canvasId: string }) => void;
  /**
   * Mobile mode adapts the panel to fill the viewport, hides its built-in
   * header (the parent shell renders one), and trims the inline-image action
   * row so canvas-only affordances ("Add to canvas", drag) are not shown.
   */
  mobileMode?: boolean;
  /**
   * Canvas API used by the "On canvas" output mode to drop a generating
   * placeholder node, mutate it on completion, and center on it from the
   * inline chat chip. Optional — when missing, the toggle stays in "In chat".
   */
  canvasApi?: import("../types/canvas").CanvasApi | null;
  /**
   * Lifts the panel's "busy" signal up to the shell so the canvas-area can
   * paint its animated edge gradient when the agent is thinking, streaming,
   * or has an in-flight inline generation. Also true on first paint (no
   * messages) so the welcome state reads as alive.
   */
  onBusyChange?: (busy: boolean) => void;
  onMusicGenerationStarted?: (clip: { id: string; prompt: string; jobId: string }) => void;
};

export type AgentPanelHandle = {
  newChat: () => void;
  openHistory: () => void;
};

type StoredImage = {
  url: string;
  label?: string;
  source?: "attachment" | "agent";
  kind?: "image" | "video" | "music";
  trayItemId?: string;
  jobId?: string;
  trayCanvasId?: string;
  canvasNodeId?: string;
  model?: string;
  quality?: string;
  resolution?: string;
  aspectRatio?: string;
  tier?: "premium" | "quality" | "quick";
  status?: "pending" | "generating" | "ready" | "failed";
  // Output mode chosen at request time. When "on_canvas" the chat shows a
  // slim chip instead of an inline media preview — the asset lives on the
  // canvas, not in the chat. Persisted so reload preserves the chip-only UX.
  outputMode?: "in_chat" | "on_canvas";
};

// Runtime representation of an inline agent generation attached to an
// assistant message. Pending → resolves to ready/failed via tray polling.
export type InlineGeneration = {
  id: string;            // tray item id (the canonical id; doubles as React key)
  jobId: string | null;
  kind: "image" | "video" | "music";
  status: "pending" | "generating" | "ready" | "failed";
  prompt: string;
  model: string;
  tier: "premium" | "quality" | "quick";
  quality?: string;
  resolution?: string;
  aspectRatio: string;
  url: string | null;    // result url once ready
  error?: string;
  errorCode?: string;    // e.g. "no_canvas" | "insufficient_credits"
  notice?: string;       // soft fallback note (e.g. seedance → kling swap)
  // The canvas the server actually dispatched into. May differ from the
  // panel's active canvas when the server lazy-resolved one (mobile/no-canvas
  // surfaces). Polling and place-on-canvas use this so the result lands in
  // the right tray.
  canvasId?: string | null;
  createdAt: number;
  // When the user chose "On canvas" output mode at request time, we drop a
  // generating placeholder node onto the canvas immediately and remember its
  // id so we can mutate it on completion (or center on it via the chip).
  canvasNodeId?: string | null;
  // For image gens that resolved as SVG (via job metadata.svg_content),
  // captured by the polling effect so the backup reconciliation pass can
  // re-apply the swap with the correct node_type ("svg" instead of
  // "image") when the first attempt missed its tick. Undefined for raster
  // images, video, and music.
  svgContent?: string | null;
  // True once the polling effect has successfully swapped the on-canvas
  // placeholder to its final image/video/audio node (or marked it failed).
  // Tracked separately from `status` because the chat card flips to "ready"
  // the instant the server reports `complete`, but the canvas update can
  // miss its tick if the canvas isn't mounted at that exact moment — leaving
  // the placeholder stuck on the spinner. The reconciliation effect below
  // re-tries the swap on every tick until this flips true.
  canvasReconciled?: boolean;
  // Output mode chosen at request time. When "on_canvas" the chat shows a
  // slim chip instead of the full media card — the asset itself lives on
  // the canvas. Defaults to "in_chat" for legacy / undefined entries so
  // existing conversations render the same as before.
  outputMode?: AgentOutputMode;
};

export type AgentOutputMode = "in_chat" | "on_canvas";

type Message = {
  id: string;
  role: "user" | "assistant" | "error";
  text: string;
  images?: StoredImage[];
  generations?: InlineGeneration[];
  streaming?: boolean;
  failed?: boolean;
};

type ModelInfo = { key: AgentModelKey; label: string };

type ChatSummary = {
  id: string;
  title: string;
  modelKey: AgentModelKey;
  workspaceId: string | null;
  createdAt: string;
  updatedAt: string;
};

const DEFAULT_MODELS: ModelInfo[] = [
  { key: "haiku", label: "Claude Haiku 4.5" },
  { key: "sonnet", label: "Claude Sonnet 4.6" },
];

const DEFAULT_MODEL_KEY: AgentModelKey = "sonnet";

const STORAGE_PREFIX = "agentChat:";
const MAX_STORED_MESSAGES = 50;
const MIGRATION_FLAG_KEY = "agentChat:migratedToServer:v1";
const PERSIST_DEBOUNCE_MS = 700;

function legacyStorageKeyFor(workspaceId: string | null, canvasId: string | null): string | null {
  if (!workspaceId) return null;
  const c = canvasId || "_global";
  return `${STORAGE_PREFIX}${workspaceId}:${c}`;
}

// Returns every legacy "agentChat:WORKSPACEID:CANVASID" key currently in
// localStorage, excluding metadata keys like "agentChat:model:..." and the
// migration flag. Used during one-time migration so chats from any workspace
// or canvas the user previously visited are uploaded — not just the current one.
function listLegacyChatKeys(): { key: string; workspaceId: string }[] {
  const out: { key: string; workspaceId: string }[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(STORAGE_PREFIX)) continue;
      const rest = key.slice(STORAGE_PREFIX.length);
      // Skip non-chat metadata keys: "model:...", "migratedToServer:..."
      if (rest.startsWith("model:") || rest.startsWith("migratedToServer:")) continue;
      const colon = rest.indexOf(":");
      if (colon <= 0) continue;
      const workspaceId = rest.slice(0, colon);
      // Defensive: workspace ids in this app are UUIDs.
      if (!/^[0-9a-f-]{8,}$/i.test(workspaceId)) continue;
      out.push({ key, workspaceId });
    }
  } catch { /* ignore */ }
  return out;
}

function modelStorageKey(workspaceId: string | null): string | null {
  if (!workspaceId) return null;
  return `${STORAGE_PREFIX}model:${workspaceId}`;
}

function isMobileViewport(): boolean {
  if (typeof window === "undefined") return false;
  try { return window.matchMedia("(max-width: 768px)").matches; } catch { return false; }
}

function normalizeStoredModel(value: string | null): AgentModelKey {
  if (value === "sonnet" || value === "haiku") return value;
  if (value === "opus") return "sonnet";
  return DEFAULT_MODEL_KEY;
}

function loadLegacyMessages(key: string | null): Message[] {
  if (!key) return [];
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(-MAX_STORED_MESSAGES).filter((m): m is Message =>
      m && typeof m === "object" && (m.role === "user" || m.role === "assistant" || m.role === "error") && typeof m.text === "string"
    );
  } catch {
    return [];
  }
}

function extractUrlFromGradient(gradient: string): string | null {
  if (!gradient) return null;
  const m = gradient.match(/url\((['"]?)(.*?)\1\)/);
  return m ? m[2] : null;
}

function refToImageUrl(ref: ReferenceImage): string | null {
  if (!ref) return null;
  let candidate: string | null = null;
  if (Array.isArray(ref.axiomImages) && ref.axiomImages.length > 0) {
    const first = ref.axiomImages[0];
    if (typeof first === "string" && first) {
      candidate = first.startsWith("url(") ? extractUrlFromGradient(first) : first;
    }
  }
  if (!candidate && ref.gradient) {
    if (ref.gradient.startsWith("url(")) {
      candidate = extractUrlFromGradient(ref.gradient);
    } else if (/^https?:\/\//i.test(ref.gradient) || ref.gradient.startsWith("data:image/") || ref.gradient.startsWith("/")) {
      candidate = ref.gradient;
    }
  }
  if (!candidate) return null;
  if (candidate.startsWith("//")) {
    candidate = `${window.location.protocol}${candidate}`;
  } else if (candidate.startsWith("/") && !candidate.startsWith("//")) {
    candidate = `${window.location.origin}${candidate}`;
  }
  return candidate;
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB per image (Anthropic limit)

// Anthropic's vision endpoint only accepts JPEG, PNG, GIF, WebP. The browser's
// `file.type` is derived from the file extension, so a HEIC photo from an
// iPhone renamed `.jpg` still claims to be `image/jpeg`. Anthropic decodes the
// actual bytes and rejects the request with a confusing
// "file format is invalid or unsupported" error. We sniff the real magic
// bytes and, when the format isn't natively supported, transcode through a
// canvas to a real JPEG before upload.
const ANTHROPIC_OK_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  // GIF: 47 49 46 38
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
  // RIFF....WEBP
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  // HEIC/HEIF: bytes 4-11 = "ftyp" + brand (heic/heix/hevc/mif1/msf1/heim/heis/hevm/hevs)
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]).toLowerCase();
    if (["heic", "heix", "hevc", "mif1", "msf1", "heim", "heis", "hevm", "hevs"].includes(brand)) {
      return "image/heic";
    }
    if (brand === "avif" || brand === "avis") return "image/avif";
  }
  // BMP: 42 4D
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
  // TIFF: 49 49 2A 00 or 4D 4D 00 2A
  if ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[3] === 0x2a)) return "image/tiff";
  return null;
}

// Decode `file` via an <img> tag and re-encode it as a JPEG data URL. Returns
// null if the browser can't decode the format (typical for HEIC in Chromium).
async function transcodeToJpegDataUrl(file: Blob): Promise<string | null> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement | null>((resolve) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => resolve(null);
      el.src = objectUrl;
    });
    if (!img) return null;
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) return null;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    return canvas.toDataURL("image/jpeg", 0.92);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function dataUrlByteSize(url: string): number {
  const m = url.match(/^data:[^;]+;base64,(.+)$/);
  if (!m) return 0;
  const b64 = m[1];
  const padding = (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
  return Math.floor((b64.length * 3) / 4) - padding;
}

function findOversizedRef(refs: ReferenceImage[]): { ref: ReferenceImage; bytes: number } | null {
  for (const r of refs) {
    const url = refToImageUrl(r);
    if (!url) continue;
    if (url.startsWith("data:")) {
      const bytes = dataUrlByteSize(url);
      if (bytes > MAX_IMAGE_BYTES) return { ref: r, bytes };
    }
  }
  return null;
}

function stripCodeFences(text: string): string {
  let s = text.trim();
  const fence = s.match(/^```(?:[a-zA-Z]+)?\n([\s\S]*?)\n```$/);
  if (fence) s = fence[1].trim();
  return s;
}

function extractCleanPrompt(text: string): string {
  return stripCodeFences(text);
}

// Convert a server-stored message row into the runtime Message shape.
// Assistant messages with `images` of source 'agent' are rehydrated into
// the runtime `generations` array as already-completed inline gens; other
// images stay on `images` for the bubble's user-attached strip.
function hydrateStoredMessage(m: { id: string; role: string; text: string; images?: StoredImage[] }): Message {
  const role: Message["role"] =
    m.role === "assistant" || m.role === "error" ? (m.role as Message["role"]) : "user";
  const allImages = Array.isArray(m.images) ? m.images : [];
  if (role !== "assistant") {
    return {
      id: m.id,
      role,
      text: m.text || "",
      images: allImages.length > 0 ? allImages : undefined,
    };
  }
  const generations: InlineGeneration[] = [];
  const otherImages: StoredImage[] = [];
  for (const img of allImages) {
    if (img.source === "agent" && (img.url || img.trayItemId)) {
      // Reload-time status: explicit 'failed' stays failed; rows with a URL
      // are 'ready'; rows without a URL but with a tray id are 'pending' and
      // the polling effect will resolve them.
      const status: InlineGeneration["status"] =
        img.status === "failed" ? "failed"
        : img.url ? "ready"
        : (img.status === "generating" ? "generating" : "pending");
      generations.push({
        canvasNodeId: img.canvasNodeId || null,
        id: img.trayItemId || img.url || crypto.randomUUID(),
        jobId: img.jobId || null,
        kind: img.kind === "video" ? "video" : img.kind === "music" ? "music" : "image",
        status,
        prompt: img.label || "",
        model: img.model || "",
        tier: img.tier === "quick" ? "quick" : img.tier === "quality" ? "quality" : "premium",
        quality: img.quality,
        resolution: img.resolution,
        aspectRatio: img.aspectRatio || "1:1",
        url: img.url || null,
        canvasId: img.trayCanvasId || null,
        createdAt: 0,
        outputMode: img.outputMode === "on_canvas" ? "on_canvas" : "in_chat",
      });
    } else {
      otherImages.push(img);
    }
  }
  return {
    id: m.id,
    role,
    text: m.text || "",
    images: otherImages.length > 0 ? otherImages : undefined,
    generations: generations.length > 0 ? generations : undefined,
  };
}

// Inverse: build the persistable images[] array for an assistant message
// from its inline generations. Persists every generation (including failed
// and pending) so a page reload mid-generation still shows the card with the
// tray id; the polling effect picks the job back up via tray status.
// Pending entries with no URL still carry trayItemId/jobId so reload knows
// what to poll for.
function generationsToStoredImages(gens?: InlineGeneration[]): StoredImage[] {
  if (!gens || gens.length === 0) return [];
  const out: StoredImage[] = [];
  for (const g of gens) {
    out.push({
      // Empty url is allowed for not-yet-completed gens; hydrateStoredMessage
      // treats those as 'pending' and the polling effect resolves them.
      url: g.url || "",
      label: g.prompt,
      source: "agent",
      kind: g.kind,
      trayItemId: g.id,
      jobId: g.jobId || undefined,
      model: g.model,
      quality: g.quality,
      resolution: g.resolution,
      aspectRatio: g.aspectRatio,
      // Preserve all three tier buckets so reload-time placement matches
      // the original generation footprint.
      tier: g.tier,
      status: g.status,
      trayCanvasId: g.canvasId || undefined,
      canvasNodeId: g.canvasNodeId || undefined,
      outputMode: g.outputMode,
    });
  }
  return out;
}

// Build the images[] array we persist for a message of any role.
function persistImagesFor(m: Message): StoredImage[] | undefined {
  if (m.role === "user") return m.images && m.images.length > 0 ? m.images : undefined;
  if (m.role === "assistant") {
    const gens = generationsToStoredImages(m.generations);
    if (gens.length > 0) return gens;
  }
  return undefined;
}

// Map a JobResponse into an InlineGeneration patch (used by polling).
function jobPatchToInline(job: JobResponse): Partial<InlineGeneration> {
  const status: InlineGeneration["status"] =
    job.status === "complete" ? "ready"
    : job.status === "failed" || job.status === "cancelled" ? "failed"
    : job.status === "running" ? "generating"
    : "pending";
  return {
    status,
    url: job.result_url || null,
    error: job.error || undefined,
  };
}

// Friendly display labels for the model id strings the agent surfaces.
// Keep in sync with the MODEL_WHITELIST in server/routes/agent.ts plus the
// transform-tool models (pixelcut/seedvr/bria).
function prettyAgentModelLabel(model: string | undefined | null): string {
  if (!model) return "";
  const m = model.toLowerCase();
  if (m.startsWith("nano-banana-2")) return "Nano Banana 2";
  if (m.startsWith("gpt-image-2")) return "GPT Image 2";
  if (m.startsWith("seedream-5")) return "Seedream 5";
  if (m.startsWith("seedream")) return "Seedream";
  if (m.startsWith("seedance-2.5")) return "Seedance 2.5";
  if (m.startsWith("seedance-2.0")) return "Seedance 2.0";
  if (m.startsWith("kling-o3-pro")) return "Kling O3 Pro";
  if (m.startsWith("kling-o3-4k")) return "Kling O3 4K";
  if (m.startsWith("veo3.1-lite")) return "Veo 3.1 Lite";
  if (m.startsWith("pixelcut")) return "Pixelcut · Remove BG";
  if (m.startsWith("seedvr")) return "SeedVR · Upscale";
  if (m.startsWith("bria")) return "Bria · Resize";
  if (m.startsWith("minimax-music")) return "MiniMax Music";
  return model;
}

function formatRelativeTime(iso: string): string {
  const d = new Date(iso).getTime();
  if (!Number.isFinite(d)) return "";
  const diff = Date.now() - d;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export const AgentPanel = forwardRef<AgentPanelHandle, AgentPanelProps>(function AgentPanel({
  workspaceId,
  canvasId,
  canvasReferenceImages,
  isGuest,
  onClose,
  onFullCanvas,
  onSettingsOpen,
  onSignInRequest,
  onHandoffToMake,
  onSaveToLibrary,
  mobileMode = false,
  canvasApi,
  onBusyChange,
  onMusicGenerationStarted,
}, ref) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [models, setModels] = useState<ModelInfo[]>(DEFAULT_MODELS);
  const [modelKey, setModelKey] = useState<AgentModelKey>(DEFAULT_MODEL_KEY);
  // Same chimes used by the main generation tray. We play them locally for
  // agent-fired generations because those items are intentionally hidden
  // from the tray (which would otherwise drive the sounds).
  const { playStart, playComplete, playError } = useGenerationSound();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  // Set when the most recent reply pushed conversation context above the
  // server's warn/critical thresholds. The server emits this on the `done`
  // SSE event using the model's actual input window.
  const [contextWarning, setContextWarning] = useState<{
    level: "warn" | "critical";
    fraction: number;
  } | null>(null);
  const [excludedRefIds, setExcludedRefIds] = useState<Set<string>>(new Set());
  const [splitMenuFor, setSplitMenuFor] = useState<string | null>(null);
  // "Edit with agent" populates these; they ride along on the next user
  // message as `images` of source 'agent', then are cleared.
  const [agentExtraRefs, setAgentExtraRefs] = useState<AgentExtraRef[]>([]);
  // Lightweight image / video viewer for inline gens.
  const [viewerMedia, setViewerMedia] = useState<{ url: string; kind: "image" | "video" } | null>(null);
  // Per-generation Use-in-Make split menu open state (keyed by gen id).
  const [genSplitMenuFor, setGenSplitMenuFor] = useState<string | null>(null);
  // Mobile-only: which inline generation is currently "tapped open" so its
  // overlay (darkening + action buttons) is visible. Desktop reveals the
  // overlay on hover, but coarse-pointer devices have no hover state, so we
  // toggle it on tap. Tapping outside or tapping the same card again closes.
  const [activeGenId, setActiveGenId] = useState<string | null>(null);

  // Server-backed chat state.
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyChats, setHistoryChats] = useState<ChatSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // Tracks whether this user has seen the long welcome message before.
  // Persisted in localStorage so the introduction only animates in on
  // the very first load; subsequent new chats show a quiet
  // "What would you like to create?" placeholder bubble instead.
  const WELCOMED_KEY = "matteblack.agent.welcomed";
  const [hasWelcomedBefore, setHasWelcomedBefore] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try { return window.localStorage.getItem(WELCOMED_KEY) === "1"; }
    catch { return false; }
  });
  useEffect(() => {
    if (hasWelcomedBefore) return;
    // Mark as welcomed only when we actually render the long welcome
    // (i.e. when the conversation is empty on this mount). Wait until
    // after the slide-in completes so a fast remount still shows it.
    if (messages.length !== 0) return;
    const t = window.setTimeout(() => {
      try { window.localStorage.setItem(WELCOMED_KEY, "1"); } catch { /* ignore */ }
      setHasWelcomedBefore(true);
    }, 1200);
    return () => window.clearTimeout(t);
  }, [hasWelcomedBefore, messages.length]);

  // Brand IQ wiring for the agent's outgoing payload. There is no longer a
  // composer-level brand UI in the agent — brands are managed entirely from
  // the Brand IQ panel. We still hydrate brandPin/brandDisabled from the
  // active chat row so the agent's request payload (brand_profile_id,
  // brand_disabled) and per-chat persistence remain correct. The server
  // authoritatively resolves the active brand on every request.
  //   brandPin: string UUID = pin to that brand
  //              null         = follow workspace/project default
  //   brandDisabled: true    = explicitly suppress brand for this chat
  const [brandPin, setBrandPin] = useState<string | null>(null);
  const [brandDisabled, setBrandDisabled] = useState<boolean>(false);

  // Brand list for the composer's #mention picker. The picker is the
  // primary way to attach a brand to the agent's reply: typing `#` opens
  // a popover of workspace brands; on send we resolve any #token in the
  // message (fuzzy, typo-tolerant) to a brand and use that as the
  // request's brand_profile_id, overriding the chat's sticky pin for
  // that single turn.
  const [brands, setBrands] = useState<MentionBrand[]>([]);
  // Workspace + entitled products (axioms) for the @mention picker.
  // Same UX as #brand: typing `@` opens a popover, accepting fills
  // `@<slug>` into the textarea, and on send we resolve every @token
  // back to a product id and pass `product_ids` so the server attaches
  // the matching reference image(s) to generation tool calls.
  const [products, setProducts] = useState<MentionProduct[]>([]);
  // Sticky-pinned products for the active chat. Hydrated from the chat
  // row's last_product_ids on load and updated when the user @-mentions
  // products in their next send. Format: opaque server ids
  // ("axiom:<uuid>" / "platform:<uuid>"), not slugs.
  const [productPins, setProductPins] = useState<string[]>([]);
  // Open mention popover state. tokenStart/tokenEnd are character offsets
  // in `input` for the trigger token under the cursor; selectedIndex
  // tracks keyboard navigation. `kind` discriminates brand (#) vs
  // product (@) so the suggestions / accept / persist paths can branch.
  const [mention, setMention] = useState<{
    kind: "brand" | "product";
    open: boolean;
    query: string;
    tokenStart: number;
    tokenEnd: number;
    selectedIndex: number;
  } | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const splitMenuRef = useRef<HTMLDivElement>(null);
  const genSplitMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistInFlightRef = useRef<boolean>(false);
  const lastPersistedRef = useRef<string>("");
  const skipNextPersistRef = useRef<boolean>(false);
  // Tracks the total count of inline generations across all assistant
  // messages on the previous persist-effect run, so we can detect when a
  // brand-new generation card just appeared and flush persistence with no
  // debounce (rather than the standard 700ms).
  const lastGenCountRef = useRef<number>(0);
  const initializedKeyRef = useRef<string>("");

  const mKey = modelStorageKey(workspaceId);
  // Output mode is no longer user-configurable — the surface decides:
  //   • desktop / wide viewport → "on_canvas" (generations drop straight
  //     onto the canvas, where there's room to see them).
  //   • mobile / narrow viewport → "in_chat" (no live canvas next to the
  //     composer, so the result has to live in the chat thread).
  // Re-evaluated on every render so a real viewport change (resize across
  // the breakpoint, mobile prop flip) takes effect immediately.
  const effectiveOutputMode: AgentOutputMode =
    mobileMode || isMobileViewport() ? "in_chat" : "on_canvas";

  // The polling effect's setInterval closure can't depend on every prop
  // change (it's keyed on the pendingJobIds set so it re-binds only when
  // a new canvas needs polling). Keeping a ref means the latest API is
  // always available without flapping the timer.
  const canvasApiRef = useRef(canvasApi);
  canvasApiRef.current = canvasApi;
  const onMusicGenerationStartedRef = useRef(onMusicGenerationStarted);
  onMusicGenerationStartedRef.current = onMusicGenerationStarted;

  // Load model preference per workspace.
  useEffect(() => {
    if (!mKey) return;
    try {
      const stored = localStorage.getItem(mKey);
      setModelKey(normalizeStoredModel(stored));
    } catch {
      setModelKey(DEFAULT_MODEL_KEY);
    }
  }, [mKey]);

  // Persist model preference (and migrate legacy 'opus' if it slipped in).
  useEffect(() => {
    if (!mKey) return;
    try { localStorage.setItem(mKey, modelKey); } catch { /* ignore */ }
  }, [modelKey, mKey]);

  // Probe availability + model list.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/agent/status", { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) {
          if (!cancelled) setAvailable(false);
          return null;
        }
        return r.json();
      })
      .then((j) => {
        if (cancelled || !j) return;
        if (typeof j.available === "boolean") setAvailable(j.available);
        if (Array.isArray(j.models) && j.models.length > 0) {
          setModels(
            j.models.filter((m: { key?: string; label?: string }) =>
              m.key === "sonnet" || m.key === "haiku"
            ) as ModelInfo[]
          );
        }
      })
      .catch(() => { if (!cancelled) setAvailable(false); });
    return () => { cancelled = true; };
  }, []);

  // Fetch history list for the current workspace (drawer view).
  const refreshHistory = useCallback(async () => {
    if (isGuest || available === false) return;
    setHistoryLoading(true);
    try {
      const url = workspaceId
        ? `/api/agent/chats?workspace_id=${encodeURIComponent(workspaceId)}`
        : "/api/agent/chats";
      const r = await fetch(url, { credentials: "include" });
      if (!r.ok) return;
      const j = await r.json();
      const list: ChatSummary[] = Array.isArray(j.chats)
        ? j.chats.map((c: {
            id: string; title: string; modelKey: string; workspaceId: string | null;
            createdAt: string; updatedAt: string;
          }) => ({
            id: c.id,
            title: c.title || "Untitled",
            modelKey: normalizeStoredModel(c.modelKey),
            workspaceId: c.workspaceId,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
          }))
        : [];
      setHistoryChats(list);
    } finally {
      setHistoryLoading(false);
    }
  }, [isGuest, available, workspaceId]);

  // On workspace/canvas switch: load most recent chat from server (and migrate legacy).
  useEffect(() => {
    if (isGuest || available !== true) return;
    let cancelled = false;
    setSplitMenuFor(null);
    setExcludedRefIds(new Set());

    const initKey = `${workspaceId || ""}:${canvasId || ""}`;
    if (initializedKeyRef.current === initKey) return;
    initializedKeyRef.current = initKey;

    (async () => {
      // 1. Migrate ALL legacy localStorage chats to the server (one-time).
      // We iterate every "agentChat:WS:CANVAS" key so chats from other
      // workspaces/canvases the user previously visited aren't dropped.
      const migrated = (() => {
        try { return localStorage.getItem(MIGRATION_FLAG_KEY) === "1"; } catch { return true; }
      })();
      if (!migrated) {
        // Always include the current workspace+canvas key first (it may
        // not yet exist as a legacy key but loadLegacyMessages handles missing).
        const candidates = listLegacyChatKeys();
        const explicit = legacyStorageKeyFor(workspaceId, canvasId);
        if (explicit && !candidates.some((c) => c.key === explicit)) {
          candidates.push({ key: explicit, workspaceId: workspaceId || "" });
        }
        let attemptedAny = false;
        let allSucceeded = true;
        for (const { key, workspaceId: ws } of candidates) {
          const legacyMsgs = loadLegacyMessages(key);
          if (legacyMsgs.length === 0) continue;
          attemptedAny = true;
          try {
            const payload = {
              modelKey,
              workspace_id: ws || undefined,
              messages: legacyMsgs.map((m) => ({
                role: m.role,
                text: m.text,
                images: m.role === "user" ? m.images : undefined,
              })),
            };
            const resp = await fetch("/api/agent/chats", {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });
            if (!resp.ok) {
              allSucceeded = false;
              console.warn("[agent migration] upload failed for", key, resp.status);
            }
          } catch (err) {
            allSucceeded = false;
            console.warn("[agent migration] upload threw for", key, err);
          }
        }
        // Only mark migration complete when there was either nothing to
        // migrate, OR every legacy chat we tried to upload succeeded.
        // Otherwise we'll retry on the next mount so users don't lose history.
        if (!attemptedAny || allSucceeded) {
          try { localStorage.setItem(MIGRATION_FLAG_KEY, "1"); } catch { /* ignore */ }
        }
      }

      // 2. Fetch the most recent chat for the current workspace and load it.
      try {
        const listUrl = workspaceId
          ? `/api/agent/chats?workspace_id=${encodeURIComponent(workspaceId)}`
          : "/api/agent/chats";
        const r = await fetch(listUrl, { credentials: "include" });
        if (!r.ok) return;
        const j = await r.json();
        const chats: { id: string; updatedAt: string; modelKey: string }[] = Array.isArray(j.chats) ? j.chats : [];
        if (cancelled) return;
        if (chats.length === 0) {
          // Fresh state.
          skipNextPersistRef.current = true;
          setMessages([]);
          setActiveChatId(null);
          lastPersistedRef.current = "";
          return;
        }
        const newest = chats[0];
        const detail = await fetch(`/api/agent/chats/${newest.id}`, { credentials: "include" });
        if (!detail.ok) return;
        const dj = await detail.json();
        if (cancelled) return;
        const msgs: Message[] = Array.isArray(dj.messages)
          ? dj.messages.map(hydrateStoredMessage)
          : [];
        skipNextPersistRef.current = true;
        setMessages(msgs);
        setActiveChatId(newest.id);
        if (dj.chat?.modelKey) {
          setModelKey(normalizeStoredModel(dj.chat.modelKey));
        }
        // Hydrate the per-chat brand pin + disabled flag from the chat row.
        const stickyBrand = dj.chat?.brandProfileId;
        setBrandPin(typeof stickyBrand === "string" && stickyBrand.length > 0 ? stickyBrand : null);
        setBrandDisabled(!!dj.chat?.brandDisabled);
        // Hydrate sticky product pins (server stores opaque ids in
        // last_product_ids, exposed as productIds on the chat row).
        const stickyProducts = Array.isArray(dj.chat?.productIds) ? dj.chat.productIds : [];
        setProductPins(stickyProducts.filter((x: unknown): x is string => typeof x === "string"));
        // Use the same image-serializer the persist effect uses, so loading
        // a chat that already has inline generations doesn't immediately
        // re-persist on first render due to fingerprint mismatch.
        lastPersistedRef.current = JSON.stringify(msgs.map((m) => ({ role: m.role, text: m.text, images: persistImagesFor(m) || [] })));
      } catch { /* ignore */ }
    })();

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, canvasId, available, isGuest]);

  // Persist messages to server (debounced upsert).
  useEffect(() => {
    if (isGuest || available !== true) return;
    if (skipNextPersistRef.current) {
      skipNextPersistRef.current = false;
      return;
    }
    // We persist any assistant message with at least one inline generation
    // (ready/pending/failed) IMMEDIATELY — even while the stream is still
    // running — so a tab close / reload between tool_use and stream-end still
    // preserves the tool call + tray id and the polling effect can resume.
    // Pure-text streaming assistant messages still wait for stream-end to
    // avoid spamming the persistence endpoint with partial text.
    const hasInFlightGen = messages.some(
      (m) => m.role === "assistant" && (m.generations || []).length > 0,
    );
    if (streaming && !hasInFlightGen) return;
    const persistable = messages.filter((m) => {
      if (m.role !== "assistant") return true;
      const hasText = !!m.text && m.text.trim().length > 0;
      const hasGen = (m.generations || []).length > 0;
      // Mid-stream: persist any assistant message that already has a gen card,
      // even if its text is still empty. After stream-end the standard rule
      // (text OR gen present) applies and pure-empty assistants are dropped.
      if (m.streaming) return hasGen;
      return hasText || hasGen;
    });
    const fingerprint = JSON.stringify(persistable.map((m) => ({
      role: m.role, text: m.text, images: persistImagesFor(m) || [],
    })));
    if (fingerprint === lastPersistedRef.current) return;

    // If a NEW inline generation just appeared on a streaming message
    // (count went up), flush immediately (0ms) instead of waiting for the
    // 700ms debounce — protects tray linkage against very fast tab close
    // right after the tool_use event arrives.
    const totalGenCount = persistable.reduce(
      (sum, m) => sum + (m.role === "assistant" ? (m.generations || []).length : 0),
      0,
    );
    const newGenAppeared = totalGenCount > lastGenCountRef.current;
    lastGenCountRef.current = totalGenCount;
    const debounceMs = newGenAppeared ? 0 : PERSIST_DEBOUNCE_MS;

    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(async () => {
      persistTimerRef.current = null;
      if (persistInFlightRef.current) return;
      persistInFlightRef.current = true;
      try {
        if (persistable.length === 0) return; // nothing meaningful to save yet
        const payload = {
          modelKey,
          workspace_id: workspaceId || undefined,
          messages: persistable.map((m) => ({
            role: m.role,
            text: m.text,
            images: persistImagesFor(m),
          })),
        };
        if (!activeChatId) {
          const r = await fetch("/api/agent/chats", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (r.ok) {
            const j = await r.json();
            if (j?.chat?.id) {
              setActiveChatId(j.chat.id);
              lastPersistedRef.current = fingerprint;
            }
          }
        } else {
          const r = await fetch(`/api/agent/chats/${activeChatId}/messages`, {
            method: "PUT",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (r.ok) lastPersistedRef.current = fingerprint;
          else if (r.status === 404) {
            // Chat was deleted elsewhere; create fresh.
            setActiveChatId(null);
            lastPersistedRef.current = "";
          }
        }
      } catch { /* ignore */ }
      finally { persistInFlightRef.current = false; }
    }, debounceMs);

    return () => {
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
    };
  }, [messages, modelKey, workspaceId, activeChatId, available, isGuest, streaming]);

  // Auto-scroll on new messages.
  //
  // Setting scrollTop once is not enough on a restored chat: the effect runs
  // before the transcript has laid out — images, generation cards and code
  // blocks all arrive later — so it pins to a scrollHeight that is about to
  // triple, and the user lands at the first prompt. A ResizeObserver on the
  // content keeps re-pinning as it grows, and stops the moment the user
  // scrolls up, so reading back never fights it.
  const stickToBottomRef = useRef(true);
  useEffect(() => {
    const el = messagesScrollRef.current;
    if (!el) return;
    const atBottom = () => el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    const onScroll = () => { stickToBottomRef.current = atBottom(); };
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => {
      if (stickToBottomRef.current) el.scrollTop = el.scrollHeight;
    });
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [messages]);

  useEffect(() => {
    const el = messagesScrollRef.current;
    if (!el) return;
    stickToBottomRef.current = true;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Lift the panel's "busy" state up so the canvas-area can paint an
  // animated blue gradient along its right edge. The pulse should ONLY
  // fire when the agent is actually working (streaming a reply or has an
  // in-flight inline generation) or when the viewer is signed out (so
  // guests get a clear visual invitation to sign in). Idle signed-in
  // users — including the welcome state — see a normal resting shadow.
  const agentWorking = useMemo(() => {
    const hasInFlightGen = messages.some(
      (m) =>
        m.role === "assistant" &&
        (m.generations || []).some((g) => g.status === "pending" || g.status === "generating"),
    );
    return streaming || hasInFlightGen;
  }, [messages, streaming]);

  useEffect(() => {
    if (!onBusyChange) return;
    onBusyChange(agentWorking);
  }, [agentWorking, onBusyChange]);

  // Auto-grow textarea (larger min/max). Mobile mode uses a tighter range
  // so the composer leaves room for the keyboard.
  //
  // When the field is empty we DON'T set an inline height — that lets the
  // CSS idle-pill rule (`:not(:focus):placeholder-shown { height: 40px }`)
  // collapse the composer to a slim 40px pill. As soon as the user types
  // (input becomes non-empty) we resume measuring scrollHeight and growing
  // between minH/maxH for the expanded square box.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    if (!input) {
      ta.style.height = "";
      return;
    }
    ta.style.height = "auto";
    const minH = mobileMode ? 56 : 96;
    const maxH = mobileMode ? 160 : 260;
    ta.style.height = `${Math.min(maxH, Math.max(minH, ta.scrollHeight))}px`;
  }, [input, mobileMode]);

  // Click outside to close split menu.
  useEffect(() => {
    if (!splitMenuFor) return;
    const handler = (e: MouseEvent) => {
      if (splitMenuRef.current && !splitMenuRef.current.contains(e.target as Node)) {
        setSplitMenuFor(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [splitMenuFor]);

  // Click outside to close per-generation split menu.
  useEffect(() => {
    if (!genSplitMenuFor) return;
    const handler = (e: MouseEvent) => {
      if (genSplitMenuRef.current && !genSplitMenuRef.current.contains(e.target as Node)) {
        setGenSplitMenuFor(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [genSplitMenuFor]);

  // Mobile: tap anywhere outside the active generation to close its overlay.
  // We listen on the document and clear whenever the tap is not inside an
  // .agent-gen card. The card's own onClick (which toggles or closes) runs
  // first because of capture/bubble ordering — this only catches taps on
  // empty space, other messages, the composer, etc.
  useEffect(() => {
    if (!mobileMode || !activeGenId) return;
    const handler = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target || !target.closest(".agent-gen")) {
        setActiveGenId(null);
      }
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [mobileMode, activeGenId]);

  // Cleanup on unmount.
  useEffect(() => () => {
    abortRef.current?.abort();
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
  }, []);

  const activeRefs = useMemo(() => {
    return canvasReferenceImages.filter((r) => !excludedRefIds.has(r.id) && refToImageUrl(r) != null);
  }, [canvasReferenceImages, excludedRefIds]);

  // The single guiding reference image — the "Axiom" — used for the next send.
  // Priority order (most explicit user intent first):
  //   1. Most recent + upload (explicit composer action)
  //   2. Canvas selection (explicit click on the canvas)
  //   3. Most recent carry-forward from a prior agent generation (implicit)
  // This guarantees a fresh canvas pick is never silently shadowed by a stale
  // carry-forward sitting in agentExtraRefs.
  const axiomRef = useMemo<
    | { source: "extra"; id: string; url: string; label: string; ref: AgentExtraRef }
    | { source: "canvas"; id: string; url: string; label: string; ref: ReferenceImage }
    | null
  >(() => {
    let lastUpload: AgentExtraRef | null = null;
    let lastCarry: AgentExtraRef | null = null;
    for (const r of agentExtraRefs) {
      if (r.source === "upload") lastUpload = r;
      else lastCarry = r;
    }
    if (lastUpload) {
      return { source: "extra", id: lastUpload.id, url: lastUpload.url, label: lastUpload.label, ref: lastUpload };
    }
    for (const r of activeRefs) {
      const url = refToImageUrl(r);
      if (url) return { source: "canvas", id: r.id, url, label: r.label, ref: r };
    }
    if (lastCarry) {
      return { source: "extra", id: lastCarry.id, url: lastCarry.url, label: lastCarry.label, ref: lastCarry };
    }
    return null;
  }, [agentExtraRefs, activeRefs]);

  // The full ordered set of refs we surface in the panel UI — up to 8.
  // Order mirrors the send-logic so the visible thumbs match what gets sent:
  //   1. axiomRef (primary)
  //   2. remaining agentExtraRefs (uploads + carry-forwards)
  //   3. remaining canvas selections
  // Deduped by URL.
  const displayRefs = useMemo<
    Array<
      | { kind: "extra"; id: string; url: string; label: string; ref: AgentExtraRef }
      | { kind: "canvas"; id: string; url: string; label: string; ref: ReferenceImage }
    >
  >(() => {
    const MAX_DISPLAY_REFS = 8;
    const out: Array<
      | { kind: "extra"; id: string; url: string; label: string; ref: AgentExtraRef }
      | { kind: "canvas"; id: string; url: string; label: string; ref: ReferenceImage }
    > = [];
    const seen = new Set<string>();
    if (axiomRef) {
      out.push(
        axiomRef.source === "extra"
          ? { kind: "extra", id: axiomRef.id, url: axiomRef.url, label: axiomRef.label, ref: axiomRef.ref }
          : { kind: "canvas", id: axiomRef.id, url: axiomRef.url, label: axiomRef.label, ref: axiomRef.ref }
      );
      seen.add(axiomRef.url);
    }
    for (const r of agentExtraRefs) {
      if (out.length >= MAX_DISPLAY_REFS) break;
      if (!r.url || seen.has(r.url)) continue;
      out.push({ kind: "extra", id: r.id, url: r.url, label: r.label, ref: r });
      seen.add(r.url);
    }
    for (const r of activeRefs) {
      if (out.length >= MAX_DISPLAY_REFS) break;
      const url = refToImageUrl(r);
      if (!url || seen.has(url)) continue;
      out.push({ kind: "canvas", id: r.id, url, label: r.label, ref: r });
      seen.add(url);
    }
    return out;
  }, [axiomRef, agentExtraRefs, activeRefs]);

  const handleNewChat = useCallback(async () => {
    abortRef.current?.abort();
    skipNextPersistRef.current = true;
    setMessages([]);
    setInput("");
    setErrorBanner(null);
    setContextWarning(null);
    setStreaming(false);
    setActiveChatId(null);
    lastPersistedRef.current = "";
    setHistoryOpen(false);
    // Reset per-chat brand override so a new chat starts on the workspace
    // (or project) default rather than silently inheriting the previous
    // chat's pin. There is no longer a composer-level brand UI to surface
    // the carryover.
    setBrandPin(null);
    setBrandDisabled(false);
    setProductPins([]);

    // Create a fresh server-side chat record immediately so the new
    // conversation has an id even before the first message is sent.
    if (isGuest || available !== true) return;
    try {
      const r = await fetch("/api/agent/chats", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelKey,
          workspace_id: workspaceId || undefined,
          title: "New chat",
          messages: [],
        }),
      });
      if (r.ok) {
        const j = await r.json();
        if (j?.chat?.id) {
          setActiveChatId(j.chat.id);
          // Keep the history drawer in sync so the new chat shows up
          // immediately if the user opens History next.
          refreshHistory().catch(() => { /* ignore */ });
        }
      }
    } catch { /* user can still send — persist effect will create one */ }
  }, [isGuest, available, modelKey, workspaceId, refreshHistory]);

  // Persist brand pin onto the active chat row whenever the user changes
  // it from the composer (so reloads remember the choice). The /api/agent/chat
  // call already does sticky-write when streaming a message, but we also
  // mirror it here so an unused-yet new chat retains the chosen brand.
  useEffect(() => {
    if (!activeChatId) return;
    const ctrl = new AbortController();
    fetch(`/api/agent/chats/${activeChatId}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brand_profile_id: brandPin, brand_disabled: brandDisabled }),
      signal: ctrl.signal,
    }).catch(() => { /* ignore */ });
    return () => ctrl.abort();
  }, [brandPin, brandDisabled, activeChatId]);

  // Persist sticky product pins onto the active chat row whenever the
  // resolved set changes. Mirrors the brand_profile_id sticky-write so a
  // reload of the chat hydrates the same @product references.
  useEffect(() => {
    if (!activeChatId) return;
    const ctrl = new AbortController();
    fetch(`/api/agent/chats/${activeChatId}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product_ids: productPins }),
      signal: ctrl.signal,
    }).catch(() => { /* ignore */ });
    return () => ctrl.abort();
  }, [productPins, activeChatId]);

  // Load workspace + entitled products for the @mention picker. Refetch
  // when the workspace changes (or on a guest → signed-in transition).
  useEffect(() => {
    if (isGuest || available !== true) { setProducts([]); return; }
    const ctrl = new AbortController();
    const qs = workspaceId ? `?workspace_id=${encodeURIComponent(workspaceId)}` : "";
    fetch(`/api/agent/products${qs}`, { credentials: "include", signal: ctrl.signal })
      .then((r) => r.ok ? r.json() : null)
      .then((j) => {
        if (!j || !Array.isArray(j.products)) return;
        setProducts(
          j.products.map((p: {
            id: string; slug: string; name: string;
            description?: string; thumbnail?: string | null;
            sourceKind?: "user" | "workspace" | "platform";
          }) => ({
            id: p.id,
            slug: p.slug,
            name: p.name,
            description: p.description || "",
            thumbnail: p.thumbnail || null,
            sourceKind: p.sourceKind || "user",
          }))
        );
      })
      .catch(() => { /* ignore */ });
    return () => ctrl.abort();
  }, [workspaceId, isGuest, available]);

  // Load the workspace's brand profiles for the #mention picker. Refetch
  // when the workspace changes; archived brands are filtered out by the
  // endpoint by default.
  useEffect(() => {
    if (!workspaceId) { setBrands([]); return; }
    const ctrl = new AbortController();
    fetch(`/api/brand-iq?workspace_id=${encodeURIComponent(workspaceId)}`, {
      credentials: "include",
      signal: ctrl.signal,
    })
      .then((r) => r.ok ? r.json() : null)
      .then((j) => {
        if (!j || !Array.isArray(j.profiles)) return;
        setBrands(
          j.profiles.map((p: { id: string; name: string; slug: string; avatar_color?: string | null }) => ({
            id: p.id,
            name: p.name,
            slug: p.slug,
            avatar_color: p.avatar_color || null,
          }))
        );
      })
      .catch(() => { /* ignore */ });
    return () => ctrl.abort();
  }, [workspaceId]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleRemoveRef = useCallback((id: string) => {
    setExcludedRefIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const handleRemoveAgentExtraRef = useCallback((id: string) => {
    setAgentExtraRefs((prev) => prev.filter((r) => r.id !== id));
  }, []);

  // "+" button in the composer: open the hidden file picker. The chosen
  // image is read as a data URL and attached to the next message via the
  // existing agentExtraRefs mechanism.
  const handlePickFile = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChosen = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setErrorBanner("Please choose an image file.");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      const mb = (file.size / (1024 * 1024)).toFixed(1);
      setErrorBanner(`"${file.name}" is ${mb} MB — over the 5 MB per-image limit.`);
      return;
    }
    try {
      // Sniff the actual magic bytes — file.type is just an extension guess
      // and lies about iPhone HEIC files renamed `.jpg`, AVIF screenshots,
      // BMP/TIFF mislabeled as JPEG, etc. Anthropic decodes the real bytes
      // and rejects anything that isn't JPEG/PNG/GIF/WebP.
      const headBytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
      const sniffed = sniffImageMime(headBytes);
      const realMime = sniffed || file.type;

      let dataUrl: string;
      if (ANTHROPIC_OK_MIME.has(realMime)) {
        dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });
        // If the file extension lied about its type, the data URL prefix will
        // claim the wrong MIME — rewrite it to the real one so the server
        // declares the correct media_type to Anthropic.
        const prefix = `data:${realMime};base64,`;
        if (!dataUrl.startsWith(prefix)) {
          const commaIdx = dataUrl.indexOf(",");
          if (commaIdx > 0) dataUrl = prefix + dataUrl.slice(commaIdx + 1);
        }
      } else {
        // Format Anthropic won't accept (HEIC, AVIF, BMP, TIFF, ...). Try to
        // transcode it through a canvas to a real JPEG.
        const transcoded = await transcodeToJpegDataUrl(file);
        if (!transcoded) {
          const label = sniffed ? sniffed.replace("image/", "").toUpperCase() : "this format";
          setErrorBanner(
            `"${file.name}" is ${label} — your browser can't read it. Convert it to JPEG or PNG and try again.`
          );
          return;
        }
        dataUrl = transcoded;
        if (dataUrlByteSize(dataUrl) > MAX_IMAGE_BYTES) {
          setErrorBanner(`"${file.name}" is over the 5 MB per-image limit after conversion.`);
          return;
        }
      }
      setAgentExtraRefs((prev) => [
        ...prev,
        { id: crypto.randomUUID(), url: dataUrl, label: file.name, kind: "image", source: "upload" },
      ]);
      setErrorBanner(null);
    } catch {
      setErrorBanner("Could not read that image.");
    }
  }, []);

  // ----- Inline-generation tray polling -----
  // Resolve the *current* live node id for a generation. The id we stored
  // in `g.canvasNodeId` may have been a temporary local id that the canvas
  // later replaced with a server UUID once it persisted. We always re-look
  // up by stable keys (jobId / trayItemId) on the live node set so polling,
  // sync, and the chip click stay correct after the remap.
  const resolveLiveNodeId = useCallback((g: InlineGeneration): string | null => {
    const liveApi = canvasApiRef.current;
    // When the canvas isn't actually mounted, getNodes() on the proxy
    // returns []. Treating that as authoritative would clobber a perfectly
    // valid stored id, so fall back to the stored value instead.
    if (!liveApi?.isLive?.() || !liveApi?.getNodes) return g.canvasNodeId || null;
    let nodes: CanvasNode[] = [];
    try { nodes = liveApi.getNodes() || []; } catch { return g.canvasNodeId || null; }
    if (g.canvasNodeId) {
      const direct = nodes.find((n) => n.id === g.canvasNodeId);
      if (direct) return direct.id;
    }
    // Stable-key lookup on the node metadata. Match jobId first (most
    // specific), then trayItemId.
    if (g.jobId) {
      const m = nodes.find(
        (n) => (n.metadata as Record<string, unknown> | undefined)?.jobId === g.jobId
          || n.job_id === g.jobId
      );
      if (m) return m.id;
    }
    if (g.id) {
      const m = nodes.find(
        (n) => (n.metadata as Record<string, unknown> | undefined)?.trayItemId === g.id
      );
      if (m) return m.id;
    }
    return null;
  }, []);

  // Card↔node sync: when the user deletes a generating placeholder (or its
  // resolved image/video) directly from the canvas, the chip on the chat
  // card must fall back to its "Add to canvas" affordance. We poll the live
  // canvas node set on a slow tick. For each gen with a stored canvasNodeId
  // we first try to find the matching node by stable key (jobId/trayItemId)
  // — this handles the local→server id remap that happens after the canvas
  // saves a freshly-added node — and only clear linkage if no matching node
  // exists. If the underlying id changed, we update the stored id to the
  // remapped one so subsequent updates/focus jumps stay correct.
  useEffect(() => {
    const liveApi = canvasApiRef.current;
    if (!liveApi?.getNodes) return;
    const sync = () => {
      // Only treat the canvas's node set as authoritative when the canvas
      // is actually mounted. With the proxy, getNodes() always exists but
      // returns [] when there's no live canvas — which would incorrectly
      // clear every card's stored canvasNodeId on mobile / no-canvas
      // surfaces and during the brief window before mount. Skip the sync
      // entirely until the canvas is live.
      if (!liveApi.isLive?.()) return;
      let nodes: CanvasNode[] = [];
      try { nodes = liveApi.getNodes!() || []; } catch { return; }
      const byId = new Map<string, CanvasNode>(nodes.map((n) => [n.id, n] as const));
      const byJob = new Map<string, CanvasNode>();
      const byTray = new Map<string, CanvasNode>();
      for (const n of nodes) {
        const md = (n.metadata as Record<string, unknown> | undefined) || {};
        const jobId = (md.jobId as string | undefined) || n.job_id || undefined;
        if (jobId) byJob.set(jobId, n);
        const trayId = md.trayItemId as string | undefined;
        if (trayId) byTray.set(trayId, n);
      }
      setMessages((prev) => {
        let outerChanged = false;
        const next = prev.map((m) => {
          if (!m.generations || m.generations.length === 0) return m;
          let innerChanged = false;
          const gens = m.generations.map((g) => {
            if (!g.canvasNodeId) return g;
            // Direct id hit: still mounted, nothing to do.
            if (byId.has(g.canvasNodeId)) return g;
            // Remap path: the original id is gone, but a node with the same
            // jobId/trayItemId exists (the canvas swapped local→server id).
            // Migrate the stored id instead of clearing linkage.
            const remapped =
              (g.jobId && byJob.get(g.jobId)) ||
              (g.id && byTray.get(g.id)) ||
              null;
            if (remapped) {
              if (remapped.id === g.canvasNodeId) return g;
              innerChanged = true;
              return { ...g, canvasNodeId: remapped.id };
            }
            // Truly gone: drop the linkage so the chip flips back to "Add to canvas".
            innerChanged = true;
            return { ...g, canvasNodeId: null };
          });
          if (!innerChanged) return m;
          outerChanged = true;
          return { ...m, generations: gens };
        });
        return outerChanged ? next : prev;
      });
    };
    const id = setInterval(sync, 1500);
    return () => clearInterval(id);
  }, [canvasApi]);

  // Per-job polling: for each in-flight inline generation we hit
  // GET /api/job/:job_id and convert the response into an InlineGeneration
  // patch + a canvas-node mutation. This replaces the old tray polling now
  // that the generation_tray table is gone.
  const pendingJobIds = useMemo(() => {
    const out = new Set<string>();
    for (const m of messages) {
      if (!m.generations) continue;
      for (const g of m.generations) {
        if (g.status !== "pending" && g.status !== "generating") continue;
        if (g.jobId) out.add(g.jobId);
      }
    }
    return Array.from(out);
  }, [messages]);

  useEffect(() => {
    if (pendingJobIds.length === 0) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const results = await Promise.all(
          pendingJobIds.map((jid) =>
            fetch(`/api/job/${jid}`, { credentials: "include" })
              .then((r) => r.ok ? r.json() as Promise<JobResponse> : null)
              .catch(() => null)
          )
        );
        if (cancelled) return;
        const byJob = new Map<string, JobResponse>();
        for (const j of results) {
          if (j?.job_id) byJob.set(j.job_id, j);
        }
        if (byJob.size === 0) return;
        let completedCount = 0;
        let failedCount = 0;
        const nodeMutations: { genIdHint: string; patch: Partial<InlineGeneration>; gen: InlineGeneration; svgContent?: string }[] = [];
        setMessages((prev) => prev.map((m) => {
          if (!m.generations || m.generations.length === 0) return m;
          let changed = false;
          const next = m.generations.map((g) => {
            if (g.status === "ready" || g.status === "failed") return g;
            if (!g.jobId) return g;
            const job = byJob.get(g.jobId);
            if (!job) return g;
            const patch = jobPatchToInline(job);
            if (patch.status === g.status && patch.url === g.url && patch.error === g.error) return g;
            changed = true;
            if (patch.status === "ready") completedCount++;
            else if (patch.status === "failed") failedCount++;
            let svgContent: string | undefined;
            if (patch.status === "ready" || patch.status === "failed") {
              const jobMeta = (job.metadata as Record<string, unknown> | null) || {};
              svgContent = (jobMeta.svg_content as string | undefined) || undefined;
              nodeMutations.push({ genIdHint: g.canvasNodeId || "", patch, gen: g, svgContent });
            }
            // Persist svgContent onto the gen so the backup reconciliation
            // pass can re-apply with node_type="svg" if the first attempt
            // misses its tick.
            return { ...g, ...patch, ...(svgContent !== undefined ? { svgContent } : {}) } as InlineGeneration;
          });
          return changed ? { ...m, generations: next } : m;
        }));
        // Best-effort first attempt at applying each terminal mutation to
        // the on-canvas placeholder. We do NOT set canvasReconciled here
        // even on apparent success — updateNode is fire-and-forget and can
        // be clobbered by a racing sync write, so the only reliable signal
        // is the next getNodes() read confirming the swap landed. The
        // reconciliation tick below owns the canvasReconciled flip after
        // observing canvas state. When the canvas isn't mounted or the id
        // isn't resolvable yet, we just defer — the tick will catch it.
        const liveApi = canvasApiRef.current;
        for (const mut of nodeMutations) {
          if (!liveApi?.isLive?.() || !liveApi?.updateNode) {
            console.warn(`[agent/canvas-swap] deferred — canvas not live (genId=${mut.gen.id}, jobId=${mut.gen.jobId})`);
            continue;
          }
          const liveId = resolveLiveNodeId(mut.gen) || mut.genIdHint;
          if (!liveId) {
            console.warn(`[agent/canvas-swap] deferred — no live node id resolved (genId=${mut.gen.id}, jobId=${mut.gen.jobId})`);
            continue;
          }
          const isReady = mut.patch.status === "ready" && !!mut.patch.url;
          const isFailed = mut.patch.status === "failed";
          if (isReady) {
            const nodeType =
              mut.gen.kind === "music" ? "audio"
              : mut.gen.kind === "video" ? "video"
              : mut.svgContent ? "svg"
              : "image";
            liveApi.updateNode(liveId, {
              node_type: nodeType,
              src: mut.patch.url || "",
              label: mut.gen.prompt || mut.gen.kind,
              metadata: {
                source: "agent",
                status: "ready",
                prompt: mut.gen.prompt,
                trayItemId: mut.gen.id,
                jobId: mut.gen.jobId,
                ...(mut.svgContent ? { svg_content: mut.svgContent } : {}),
              },
            });
          } else if (isFailed) {
            liveApi.updateNode(liveId, {
              metadata: {
                source: "agent",
                status: "failed",
                errorMsg: mut.patch.error || "Generation failed",
                prompt: mut.gen.prompt,
                trayItemId: mut.gen.id,
                jobId: mut.gen.jobId,
              },
            });
          }
        }
        if (completedCount > 0) playComplete();
        else if (failedCount > 0) playError();
      } catch { /* ignore network blips */ }
    };
    void poll();
    const id = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingJobIds.join(",")]);

  // Backup reconciliation effect for stuck on-canvas placeholders. The
  // polling effect above flips a gen's status to "ready" the instant the
  // server reports complete — but the matching canvas updateNode call can
  // miss its tick when the canvas isn't mounted (mobile, route change) or
  // when the placeholder id can't be resolved yet (local→server id remap
  // hasn't fired). The interval ALWAYS installs and re-checks isLive() on
  // each tick — gating effect setup on isLive at mount time would fail to
  // recover from "completed before canvas ever mounted" because canvasApi
  // is a stable proxy ref and the effect deps would never re-run. Each
  // tick: scan ready/failed gens whose canvasReconciled is still false,
  // observe canvas state via getNodes, and only flip canvasReconciled
  // true after CONFIRMING the swap landed (node_type/src match for ready,
  // metadata.status==="failed" for failed). If the swap hasn't landed,
  // re-issue updateNode and wait for the next tick to confirm. This makes
  // the loop tolerant of dropped/clobbered writes from sync races.
  useEffect(() => {
    // Always install — the canvas can mount AFTER a generation completes
    // (route change, mobile→desktop, late mount). isLive is checked per
    // tick so we lazily start working once the canvas appears.
    const tick = () => {
      const liveApi = canvasApiRef.current;
      if (!liveApi?.isLive?.() || !liveApi?.updateNode || !liveApi?.getNodes) return;
      // Build the work list of unreconciled terminal gens.
      const todo: { gen: InlineGeneration }[] = [];
      for (const m of messages) {
        if (!m.generations) continue;
        for (const g of m.generations) {
          if (g.canvasReconciled) continue;
          if (g.status !== "ready" && g.status !== "failed") continue;
          if (!g.canvasNodeId) continue;
          if (g.status === "ready" && !g.url) continue;
          todo.push({ gen: g });
        }
      }
      if (todo.length === 0) return;
      let nodes: CanvasNode[] = [];
      try { nodes = liveApi.getNodes!() || []; } catch { return; }
      const byId = new Map<string, CanvasNode>(nodes.map((n) => [n.id, n] as const));
      const confirmed = new Set<string>();
      for (const { gen } of todo) {
        const liveId = resolveLiveNodeId(gen);
        if (!liveId) continue;
        const node = byId.get(liveId);
        if (gen.status === "ready") {
          const wantType =
            gen.kind === "music" ? "audio"
            : gen.kind === "video" ? "video"
            : gen.svgContent ? "svg"
            : "image";
          // Confirmation: canvas already shows the final node_type AND
          // src. Only then is it safe to mark reconciled.
          if (node && node.node_type === wantType && node.src === gen.url) {
            confirmed.add(gen.id);
            continue;
          }
          // User swapped the placeholder out for an unrelated node type
          // (deleted + recreated, or manual replace). Treat as terminal so
          // we stop trying — re-applying would clobber their edit.
          if (node && node.node_type !== "generating" && node.node_type !== wantType) {
            console.warn(`[agent/canvas-swap] giving up — node type changed by user (genId=${gen.id}, was=${wantType}, now=${node.node_type})`);
            confirmed.add(gen.id);
            continue;
          }
          // Not confirmed yet — (re-)issue the swap. canvasReconciled stays
          // false; the next tick will read getNodes again and confirm.
          console.warn(`[agent/canvas-swap] reconciling stuck placeholder (genId=${gen.id}, jobId=${gen.jobId}, kind=${gen.kind}, type=${wantType})`);
          liveApi.updateNode!(liveId, {
            node_type: wantType,
            src: gen.url || "",
            label: gen.prompt || gen.kind,
            metadata: {
              source: "agent",
              status: "ready",
              prompt: gen.prompt,
              trayItemId: gen.id,
              jobId: gen.jobId,
              ...(gen.svgContent ? { svg_content: gen.svgContent } : {}),
            },
          });
        } else if (gen.status === "failed") {
          const md = (node?.metadata as Record<string, unknown> | undefined) || {};
          if (md.status === "failed") {
            confirmed.add(gen.id);
            continue;
          }
          console.warn(`[agent/canvas-swap] reconciling stuck failed placeholder (genId=${gen.id}, jobId=${gen.jobId})`);
          liveApi.updateNode!(liveId, {
            metadata: {
              source: "agent",
              status: "failed",
              errorMsg: gen.error || "Generation failed",
              prompt: gen.prompt,
              trayItemId: gen.id,
              jobId: gen.jobId,
            },
          });
        }
      }
      if (confirmed.size === 0) return;
      setMessages((prev) => prev.map((m) => {
        if (!m.generations || m.generations.length === 0) return m;
        let changed = false;
        const next = m.generations.map((g) => {
          if (!confirmed.has(g.id) || g.canvasReconciled) return g;
          changed = true;
          return { ...g, canvasReconciled: true };
        });
        return changed ? { ...m, generations: next } : m;
      }));
    };
    const id = setInterval(tick, 1500);
    return () => clearInterval(id);
  }, [messages, resolveLiveNodeId]);

  // ----- Inline generation actions -----

  // Build a TrayItem-shaped payload for drag and the canvas placement
  // handler. We synthesize the minimum the canvas drop hook needs.
  const buildTrayPayload = useCallback((g: InlineGeneration): TrayItemPayload => {
    const jobType =
      g.kind === "music"
        ? "audio_music"
        : g.kind === "video"
          ? "video_gen"
          : (g.model?.includes("edit") ? "image_to_image" : "text_to_image");
    return {
      id: g.id,
      canvas_id: canvasId || "",
      job_id: g.jobId,
      status: g.status === "ready" ? "ready" : g.status === "failed" ? "failed" : "generating",
      position_x: 0,
      position_y: 0,
      metadata: { source: "agent", prompt: g.prompt, model: g.model },
      created_at: new Date(g.createdAt || Date.now()).toISOString(),
      job_type: jobType,
      result_url: g.url,
      job_status: g.status === "ready" ? "complete" : g.status,
      prompt: g.prompt,
    };
  }, [canvasId]);

  const handlePlaceGen = useCallback((g: InlineGeneration) => {
    if (!g.url || !canvasId) return;
    const api = canvasApiRef.current;
    if (!api?.isLive?.() || !api.addNode || !api.getNodes || !api.getViewport) return;
    const baseSize = placeholderSize(g.tier, g.aspectRatio || "1:1", g.kind, g.resolution);
    const slot = findEmptySlots(api.getViewport(), [baseSize], api.getNodes())[0];
    if (!slot) return;
    const nodeType = g.kind === "music" ? "audio" : g.kind === "video" ? "video" : "image";
    const node = api.addNode(slot.x, slot.y, {
      node_type: nodeType,
      width: slot.w,
      height: slot.h,
      src: g.url,
      label: g.prompt || g.kind,
      job_id: g.jobId || undefined,
      metadata: {
        source: "agent",
        status: "ready",
        prompt: g.prompt,
        trayItemId: g.id,
        jobId: g.jobId,
      },
    });
    if (node?.id) {
      // Link the placed node back onto the inline gen so the chip flips
      // from "Add to canvas" → "Placed on canvas".
      setMessages((prev) => prev.map((m) => {
        if (!m.generations) return m;
        let changed = false;
        const next = m.generations.map((x) => {
          if (x.id !== g.id) return x;
          changed = true;
          return { ...x, canvasNodeId: node.id };
        });
        return changed ? { ...m, generations: next } : m;
      }));
    }
  }, [canvasId]);

  // Pan/zoom the canvas to the placeholder (or finished) node that the
  // agent dropped for this generation. Used by the "Placed on canvas" chip
  // when the user is in on_canvas output mode. Resolves via stable-key
  // lookup so it stays correct after the local→server id remap.
  const handleFocusPlacedNode = useCallback((g: InlineGeneration) => {
    const id = resolveLiveNodeId(g);
    if (!id) return;
    canvasApiRef.current?.centerOnNode?.(id);
  }, [resolveLiveNodeId]);

  const handleEditWithAgent = useCallback((g: InlineGeneration) => {
    if (!g.url) return;
    if (g.kind !== "image" && g.kind !== "video") return;
    const kind: "image" | "video" = g.kind;
    setAgentExtraRefs((prev) => {
      if (prev.some((r) => r.url === g.url)) return prev;
      return [...prev, { id: g.id, url: g.url!, label: g.prompt || "agent generation", kind, source: "edit" }];
    });
    textareaRef.current?.focus();
  }, []);

  const handleSaveGen = useCallback((g: InlineGeneration) => {
    if (!g.url || !canvasId || !onSaveToLibrary) return;
    onSaveToLibrary({
      url: g.url,
      kind: g.kind,
      prompt: g.prompt || "Agent generation",
      canvasId,
    });
  }, [canvasId, onSaveToLibrary]);

  const handleOpenGen = useCallback((g: InlineGeneration) => {
    if (!g.url) return;
    if (g.kind === "music") {
      const a = document.createElement("a");
      a.href = g.url;
      a.download = `${(g.prompt || "music").slice(0, 40).replace(/[^a-zA-Z0-9 _-]/g, "").trim()}.mp3`;
      a.click();
      return;
    }
    setViewerMedia({ url: g.url, kind: g.kind });
  }, []);

  // Mirror the tray's drag setup: same data type, same DOM marker so
  // useCanvasDrop measures dimensions and shows a placeholder.
  const dragMarkerRef = useRef<HTMLDivElement | null>(null);
  const handleGenDragStart = useCallback((e: React.DragEvent, g: InlineGeneration) => {
    if (!g.url || g.status !== "ready") {
      e.preventDefault();
      return;
    }
    const payload = buildTrayPayload(g);
    e.dataTransfer.setData("application/x-tray-item", JSON.stringify(payload));
    e.dataTransfer.effectAllowed = "move";
    const transparentImg = new Image(1, 1);
    transparentImg.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    e.dataTransfer.setDragImage(transparentImg, 0, 0);
    const marker = document.createElement("div");
    marker.dataset.trayDragUrl = g.url;
    marker.dataset.trayDragVideo = g.kind === "video" ? "true" : "false";
    marker.dataset.trayDragAudio = "false";
    marker.style.display = "none";
    document.body.appendChild(marker);
    dragMarkerRef.current = marker;
  }, [buildTrayPayload]);

  const handleGenDragEnd = useCallback(() => {
    if (dragMarkerRef.current) {
      dragMarkerRef.current.remove();
      dragMarkerRef.current = null;
    }
  }, []);

  // Cancel an in-flight generation or dismiss a finished one. Tray endpoint
  // is gone, so:
  //   - in-flight → POST /api/job/:job_id/cancel + delete the placeholder node
  //   - finished  → just drop locally (and delete the placeholder if any)
  // We only clear the chat-side card on a successful server response for
  // in-flight cases so a user thinking they cancelled doesn't keep getting
  // billed for a still-running job.
  const handleRemoveGen = useCallback(async (g: InlineGeneration, msgId: string) => {
    const isInFlight = g.status === "pending" || g.status === "generating";
    const targetCanvasId = g.canvasId || canvasId;
    const removeLocal = () => {
      setMessages((prev) => prev.map((m) => {
        if (m.id !== msgId) return m;
        const next = (m.generations || []).filter((x) => x.id !== g.id);
        return { ...m, generations: next.length > 0 ? next : undefined };
      }));
    };
    // Best-effort placeholder-node delete: hit the server delete endpoint;
    // the live canvas picks up the change on its next reconcile.
    const deletePlaceholder = async () => {
      const liveId = resolveLiveNodeId(g);
      if (!liveId || !targetCanvasId) return;
      try {
        await fetch(`/api/canvas/${targetCanvasId}/nodes/${liveId}`, {
          method: "DELETE",
          credentials: "include",
        });
      } catch { /* ignore */ }
    };
    if (!isInFlight) {
      await deletePlaceholder();
      removeLocal();
      return;
    }
    if (!g.jobId) {
      await deletePlaceholder();
      removeLocal();
      return;
    }
    try {
      const res = await fetch(`/api/job/${g.jobId}/cancel`, {
        method: "POST",
        credentials: "include",
      });
      if (res.ok || res.status === 404 || res.status === 409) {
        await deletePlaceholder();
        removeLocal();
      } else {
        setErrorBanner("Couldn't cancel that generation. Try again in a moment.");
      }
    } catch {
      setErrorBanner("Network error cancelling generation.");
    }
  }, [canvasId, resolveLiveNodeId]);

  const sendChat = useCallback(async (overrideMessages?: Message[]) => {
    // Interrupt, don't refuse. A turn can run for minutes (a video job blocks the
    // whole tool call), and having to hit Stop, wait, then send is the same two
    // steps every time. Aborting here fires the in-flight run's own catch, which
    // marks that message cancelled — so the transcript still shows where it was
    // cut off. The `finally` below only clears state if it still owns
    // abortRef, otherwise the dying run would switch off the run replacing it.
    if (streaming) abortRef.current?.abort();
    if (available === false) return;

    const baseMessages = overrideMessages ?? messages;
    const text = input.trim();
    let userMsg: Message | null = null;
    let nextMessages: Message[];
    if (!overrideMessages) {
      if (!text) return;
      // The agent receives up to MAX_AGENT_REFS images. The axiom (most recent
      // extra, else first canvas ref) leads the array so the model treats it
      // as the primary reference; remaining refs follow.
      const MAX_AGENT_REFS = 8;
      const oversized = findOversizedRef(activeRefs);
      if (oversized) {
        const mb = (oversized.bytes / (1024 * 1024)).toFixed(1);
        setErrorBanner(
          `"${oversized.ref.label || "Image"}" is ${mb} MB — over the 5 MB per-image limit. Remove it or resize before sending.`
        );
        return;
      }
      const canvasImgs: StoredImage[] = activeRefs
        .map((r) => ({ url: refToImageUrl(r) || "", label: r.label, source: "attachment" as const }))
        .filter((i) => i.url);
      const extraImgs: StoredImage[] = agentExtraRefs.map((r) => ({
        url: r.url,
        label: r.label,
        source: r.source === "upload" ? ("attachment" as const) : ("agent" as const),
        kind: r.kind,
      }));
      // Lead with the axiom so the agent treats it as the primary reference.
      const ordered: StoredImage[] = [];
      const seen = new Set<string>();
      const push = (img: StoredImage | undefined) => {
        if (!img || !img.url || seen.has(img.url)) return;
        seen.add(img.url);
        ordered.push(img);
      };
      if (axiomRef) {
        if (axiomRef.source === "canvas") {
          push({ url: axiomRef.url, label: axiomRef.label, source: "attachment" });
        } else {
          const r = axiomRef.ref;
          push({
            url: r.url,
            label: r.label,
            source: r.source === "upload" ? "attachment" : "agent",
            kind: r.kind,
          });
        }
      }
      for (const img of [...extraImgs, ...canvasImgs]) push(img);
      const combined = ordered.slice(0, MAX_AGENT_REFS);
      userMsg = {
        id: crypto.randomUUID(),
        role: "user",
        text,
        images: combined.length > 0 ? combined : undefined,
      };
      nextMessages = [...baseMessages, userMsg];
    } else {
      nextMessages = baseMessages;
    }

    const assistantId = crypto.randomUUID();
    const assistantMsg: Message = { id: assistantId, role: "assistant", text: "", streaming: true };
    setMessages([...nextMessages, assistantMsg]);
    if (!overrideMessages) {
      setInput("");
      setAgentExtraRefs([]); // consumed
    }
    setErrorBanner(null);
    setStreaming(true);

    // Capture the user's choice at request time. If they flip the toggle
    // mid-stream we still honor the original choice for this request — the
    // alternative (mutating mid-flight) would be confusing.
    const requestOutputMode: AgentOutputMode = effectiveOutputMode;
    const requestCanvasApi = canvasApi || null;

    // Rects placed during this turn. The live canvas already reports its own
    // new nodes, but the server-POST path reads a node list fetched once per
    // turn, so without this two tool_use events in one turn would be handed the
    // same slot. Placement itself needs no other turn state — it anchors off
    // the canvas, not off a remembered cursor.
    const turnPlaced: { x: number; y: number; w: number; h: number }[] = [];
    // Cached existing-node bounds for the no-canvas (server-POST) fallback
    // path. We fetch the canvas's current node list once per turn so smart
    // placement can avoid overlapping persisted nodes even when no live
    // canvas API is mounted.
    let turnFallbackNodesPromise: Promise<CanvasNode[]> | null = null;
    let turnFallbackNodes: CanvasNode[] | null = null;
    const fetchFallbackNodes = async (cid: string): Promise<CanvasNode[]> => {
      if (turnFallbackNodes) return turnFallbackNodes;
      if (!turnFallbackNodesPromise) {
        turnFallbackNodesPromise = (async () => {
          try {
            const r = await fetch(`/api/canvas/${cid}/load`, { credentials: "include" });
            if (!r.ok) return [];
            const j = await r.json();
            const nodes: CanvasNode[] = Array.isArray(j?.nodes) ? j.nodes : [];
            return nodes;
          } catch {
            return [];
          }
        })();
      }
      turnFallbackNodes = await turnFallbackNodesPromise;
      return turnFallbackNodes;
    };

    const controller = new AbortController();
    abortRef.current = controller;

    // Forward both user attachments AND prior assistant inline generations so
    // the server can:
    //   - send user images to Claude as vision blocks
    //   - resolve implicit references from prior agent generations on tool_use
    const payloadMessages = nextMessages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => {
        if (m.role === "user") {
          return { role: "user" as const, text: m.text, images: m.images };
        }
        // For assistant messages, only forward generations that completed
        // (have a URL Anthropic can actually fetch). Pending/failed entries
        // are persisted client-side but not sent to Claude.
        const ready = generationsToStoredImages(m.generations).filter((i) => !!i.url);
        return {
          role: "assistant" as const,
          text: m.text,
          images: ready.length > 0 ? ready : undefined,
        };
      });

    let updateBuffer = "";
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (!updateBuffer) return;
      const chunk = updateBuffer;
      updateBuffer = "";
      setMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, text: m.text + chunk } : m));
    };
    const scheduleFlush = () => {
      if (flushTimer) return;
      flushTimer = setTimeout(() => { flushTimer = null; flush(); }, 30);
    };

    // Resolve any #brand mention in the message once, outside the JSON
    // serializer, so the work happens deterministically before the
    // request goes out. A successful fuzzy match overrides the chat's
    // sticky pin for this single turn.
    const mentionedBrand = brands.length > 0 ? resolveFirstMention(text, brands) : null;
    const effectiveBrandProfileId = mentionedBrand?.id || brandPin || undefined;

    // Resolve every @product mention in the message. The sticky pin set
    // is the carrier between turns: when the user @-mentions explicitly,
    // those products override + replace the sticky set for this turn
    // and become the new sticky set. When they don't, we keep the
    // existing sticky pins flowing.
    const mentionedProducts = products.length > 0
      ? resolveAllProductMentions(text, products)
      : [];
    const turnProductIds = mentionedProducts.length > 0
      ? mentionedProducts.map((p) => p.id)
      : productPins;
    if (
      mentionedProducts.length > 0
      && (
        mentionedProducts.length !== productPins.length
        || mentionedProducts.some((p, i) => p.id !== productPins[i])
      )
    ) {
      setProductPins(mentionedProducts.map((p) => p.id));
    }

    try {
      const resp = await fetch("/api/agent/chat", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelKey,
          workspace_id: workspaceId,
          canvas_id: canvasId || undefined,
          messages: payloadMessages,
          output_mode: requestOutputMode,
          chat_id: activeChatId || undefined,
          // brand_disabled is the canonical "no brand" flag — never
          // overload brand_profile_id with a sentinel string.
          brand_profile_id: effectiveBrandProfileId,
          brand_disabled: brandDisabled || undefined,
          brand_sticky: !!brandPin || brandDisabled,
          // Always send product_ids so an empty array clears the sticky
          // pins on the server side too. product_sticky defaults true on
          // the server, which is what we want here.
          product_ids: turnProductIds,
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        let msg = `Request failed (${resp.status})`;
        try {
          const j = await resp.json();
          if (j?.error) msg = j.error;
          if (resp.status === 402 && typeof j?.required === "number") {
            msg = `Insufficient credits — need ${j.required}, balance ${j.balance ?? 0}.`;
          }
        } catch { /* ignore */ }
        setMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, role: "error", text: msg, streaming: false, failed: true } : m));
        setErrorBanner(msg);
        setStreaming(false);
        return;
      }

      if (!resp.body) {
        setStreaming(false);
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let sawError: string | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const eventBlock = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let evName = "message";
          let dataStr = "";
          for (const line of eventBlock.split("\n")) {
            if (line.startsWith("event:")) evName = line.slice(6).trim();
            else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
          }
          if (!dataStr) continue;
          let data: Record<string, unknown> = {};
          try { data = JSON.parse(dataStr); } catch { continue; }
          if (evName === "delta" && typeof data.text === "string") {
            updateBuffer += data.text;
            scheduleFlush();
          } else if (evName === "error" && typeof data.error === "string") {
            sawError = data.error;
          } else if (evName === "done") {
            // Server reports the input-token usage for this turn against the
            // model's input window. We promote it to a banner so the user
            // knows when to start a new chat.
            const cu = data.contextUsage as
              | { fraction?: number; warnFraction?: number; criticalFraction?: number }
              | undefined;
            if (cu && typeof cu.fraction === "number") {
              const warnAt = typeof cu.warnFraction === "number" ? cu.warnFraction : 0.75;
              const critAt = typeof cu.criticalFraction === "number" ? cu.criticalFraction : 0.9;
              if (cu.fraction >= critAt) {
                setContextWarning({ level: "critical", fraction: cu.fraction });
              } else if (cu.fraction >= warnAt) {
                setContextWarning({ level: "warn", fraction: cu.fraction });
              } else {
                setContextWarning(null);
              }
            }
          } else if (evName === "tool_summary") {
            // Per-turn diagnostic summary from the server. Logged so a
            // single repro of the "narrated 3 / placed 1" bug surfaces
            // which failure mode fired (model emitted fewer calls,
            // server capped, parse failed, dispatch failed, or events
            // lost between server and client).
            console.log("[agent/tool_summary]", data);
          } else if (evName === "tool_use") {
            // Inline generation kicked off (or rejected) by the server.
            // Flush any pending text first so the gen card slots in after
            // whatever Claude said before calling the tool.
            if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
            flush();
            const toolErr = typeof data.error === "string" ? data.error : null;
            const toolErrCode = typeof data.errorCode === "string" ? data.errorCode : undefined;
            const jobId = typeof data.jobId === "string" ? data.jobId : null;
            const resolvedCanvasId = typeof data.canvasId === "string" ? data.canvasId : null;
            const kind: "image" | "video" | "music" = data.kind === "video" ? "video" : data.kind === "music" ? "music" : "image";
            const tier: InlineGeneration["tier"] =
              data.tier === "quick" ? "quick" : data.tier === "quality" ? "quality" : "premium";
            const aspectRatio = typeof data.aspectRatio === "string" ? data.aspectRatio : "1:1";
            const resolutionStr = typeof data.resolution === "string" ? data.resolution : undefined;
            const promptStr = typeof data.prompt === "string" ? data.prompt : "";
            // In "on_canvas" mode we drop a generating placeholder node onto
            // the canvas immediately so the user sees something landing in
            // their viewport while the job runs. Polling later mutates the
            // same node into image/video on completion. When the live canvas
            // API isn't mounted (e.g. mobile or non-canvas surface) we POST
            // the placeholder to the server so it shows up the next time the
            // user opens that canvas; the load-time orphan reconciliation
            // upgrades it to image/video if the job already finished.
            let placedNodeId: string | null = null;
            const targetCanvasId = resolvedCanvasId || canvasId;
            // Always drop a canvas placeholder for every `tool_use` event we
            // receive in on-canvas mode — even when the server reported an
            // error (parse failure, dispatch failure, hit-the-cap, etc).
            // Previously the canvas was silently undercounted on errors,
            // which made the "agent narrated 3 / placed 1" bug invisible:
            // the chat shows a failed card, but the canvas stayed empty so
            // the user assumed the agent never tried. With this change the
            // visible canvas count always equals the number of tool calls
            // the model emitted.
            if (requestOutputMode === "on_canvas" && targetCanvasId) {
              try {
                // Size the placeholder to match the actual generation. When
                // the server resolved a concrete resolution (1k/2k/3k/4k)
                // we honor that long-edge; otherwise we fall back to the
                // tier mapping so older paths still place sensibly.
                // Failed placeholders are sized small (a compact tile) so a
                // parse/dispatch failure doesn't drop a huge empty box on the
                // canvas. Successful placeholders keep the real generation
                // footprint so the user sees the true scale immediately.
                const size = toolErr
                  ? { w: 512, h: 512 }
                  : placeholderSize(tier, aspectRatio, kind, resolutionStr);
                let placeX = 0;
                let placeY = 0;
                // Resolve liveness from the proxy at call time (the prop is
                // a stable proxy whose isLive() reads the current ref). If
                // the canvas isn't currently mounted, force the server-POST
                // fallback even if the proxy still exposes addNode.
                const liveNow = !!requestCanvasApi?.isLive?.();
                // Resolve the existing-node set + viewport for placement.
                // Live path uses the in-process canvas; server-POST path
                // fetches the canvas's persisted nodes once per turn so
                // smart placement can still avoid overlap on mobile / no-
                // canvas surfaces. The synthetic viewport for the no-canvas
                // path centers around (0,0) with a generous window so the
                // first slot sits near the canvas origin (where users tend
                // to start), instead of stacking everything at exactly
                // (0,0).
                let existingNodes: CanvasNode[];
                let placementViewport: { cx: number; cy: number; w: number; h: number };
                if (liveNow && requestCanvasApi?.getViewport && requestCanvasApi.getNodes) {
                  existingNodes = requestCanvasApi.getNodes();
                  const vp = requestCanvasApi.getViewport();
                  placementViewport = { cx: vp.cx, cy: vp.cy, w: vp.w, h: vp.h };
                } else {
                  existingNodes = await fetchFallbackNodes(targetCanvasId);
                  placementViewport = { cx: 0, cy: 0, w: 1280, h: 720 };
                }
                const occupiedRects = existingNodes
                  .filter((n) => n.node_type !== "frame" && n.node_type !== "group")
                  .map((n) => ({ x: n.x, y: n.y, w: n.width, h: n.height }));
                const slot = layout(placementViewport, [size], occupiedRects.concat(turnPlaced))[0];
                placeX = slot.x;
                placeY = slot.y;
                turnPlaced.push(slot);
                const nodeMetadata: Record<string, unknown> = {
                  source: "agent",
                  status: toolErr ? "failed" : "pending",
                  kind,
                  prompt: promptStr,
                  aspectRatio,
                  tier,
                  jobId,
                };
                if (toolErr) {
                  nodeMetadata.error = toolErr;
                  if (toolErrCode) nodeMetadata.errorCode = toolErrCode;
                }
                if (liveNow && requestCanvasApi?.addNode) {
                  // Live canvas path: add to in-process canvas immediately.
                  const node = requestCanvasApi.addNode(placeX, placeY, {
                    node_type: "generating",
                    width: size.w,
                    height: size.h,
                    job_id: jobId,
                    metadata: nodeMetadata,
                  });
                  if (node?.id) placedNodeId = node.id;
                } else {
                  // Server-POST fallback (mobile / no-canvas surface). The
                  // canvas isn't mounted, so we create the placeholder node
                  // server-side; opening the canvas later loads it (and the
                  // orphan reconciler upgrades or fails it as appropriate).
                  try {
                    const r = await fetch(`/api/canvas/${targetCanvasId}/nodes`, {
                      method: "POST",
                      credentials: "include",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        node_type: "generating",
                        x: placeX,
                        y: placeY,
                        width: size.w,
                        height: size.h,
                        job_id: jobId,
                        metadata: nodeMetadata,
                      }),
                    });
                    if (r.ok) {
                      const j = await r.json();
                      if (j?.node?.id) placedNodeId = j.node.id as string;
                    }
                  } catch (postErr) {
                    console.warn("[agent] server placeholder POST failed:", postErr);
                  }
                }
                // NOTE: Intentionally do NOT auto-center on the placeholder.
                // The user pans/zooms only when they explicitly click the
                // "Placed on canvas" chip in the chat card.
              } catch (e) {
                console.warn("[agent] failed to drop generating node:", e);
              }
            }
            const gen: InlineGeneration = {
              id: jobId || (typeof data.id === "string" ? data.id : crypto.randomUUID()),
              jobId,
              kind,
              status: toolErr ? "failed" : "pending",
              prompt: promptStr,
              model: typeof data.model === "string" ? data.model : "",
              tier,
              quality: typeof data.quality === "string" ? data.quality : undefined,
              resolution: resolutionStr,
              aspectRatio,
              url: null,
              error: toolErr || undefined,
              errorCode: toolErrCode,
              notice: typeof data.notice === "string" ? data.notice : undefined,
              canvasId: resolvedCanvasId || canvasId || null,
              createdAt: Date.now(),
              canvasNodeId: placedNodeId,
              outputMode: requestOutputMode,
            };
            setMessages((prev) => prev.map((m) =>
              m.id === assistantId
                ? { ...m, generations: [...(m.generations || []), gen] }
                : m
            ));
            if (kind === "music" && jobId && !toolErr && onMusicGenerationStartedRef.current) {
              onMusicGenerationStartedRef.current({ id: gen.id, prompt: promptStr, jobId });
            }
            // Sound parity: start chime when a job kicks off, error chime
            // if the tool call was rejected outright (e.g. no canvas).
            if (toolErr) {
              playError();
            } else {
              playStart();
            }
          }
        }
      }
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      flush();

      if (sawError) {
        setMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, role: "error", text: sawError as string, streaming: false, failed: true } : m));
        setErrorBanner(sawError);
      } else {
        setMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, streaming: false } : m));
      }
    } catch (err) {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      flush();
      const aborted = (err instanceof DOMException && err.name === "AbortError") || (err as Error)?.name === "AbortError";
      if (aborted) {
        setMessages((prev) => prev.map((m) => m.id === assistantId
          ? (m.text ? { ...m, streaming: false } : { ...m, role: "error", text: "Cancelled", streaming: false, failed: true })
          : m));
      } else {
        const msg = err instanceof Error ? err.message : "Network error";
        setMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, role: "error", text: msg, streaming: false, failed: true } : m));
        setErrorBanner(msg);
      }
    } finally {
      // Only the run that still owns the controller may clear the busy state —
      // an interrupted run finishes AFTER its replacement has already started.
      if (abortRef.current === controller) {
        setStreaming(false);
        abortRef.current = null;
      }
    }
  }, [activeRefs, agentExtraRefs, available, canvasId, input, messages, modelKey, streaming, workspaceId, effectiveOutputMode, canvasApi, activeChatId, brandPin, brandDisabled, brands, products, productPins]);

  const handleRetryFailed = useCallback((failedMsgId: string) => {
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === failedMsgId);
      if (idx < 0) return prev;
      const trimmed = prev.slice(0, idx);
      setTimeout(() => { void sendChat(trimmed); }, 0);
      return trimmed;
    });
  }, [sendChat]);

  // Suggestions for the open mention popover. Recomputes whenever the
  // typed query or brand list changes. Capped at 8 to keep the popover
  // a quick glance rather than a scrolling list.
  const mentionSuggestions = useMemo<Array<BrandSuggestion | ProductSuggestion>>(() => {
    if (!mention?.open) return [];
    if (mention.kind === "brand") {
      if (brands.length === 0) return [];
      return rankBrands(mention.query, brands).slice(0, 8);
    }
    if (products.length === 0) return [];
    return rankProducts(mention.query, products).slice(0, 8);
  }, [mention?.open, mention?.kind, mention?.query, brands, products]);

  // Replace the trigger-prefixed token under the cursor with the picked
  // suggestion's `<trigger><slug> ` and close the popover. Cursor is
  // restored just after the inserted space so typing continues naturally.
  const acceptMention = useCallback((pick: BrandSuggestion | ProductSuggestion) => {
    setMention((curr) => {
      if (!curr) return null;
      const slug = pick.slug || normalizeToken(pick.name);
      const trigger = curr.kind === "brand" ? "#" : "@";
      const before = input.slice(0, curr.tokenStart);
      const after = input.slice(curr.tokenEnd);
      const replacement = `${trigger}${slug} `;
      const next = before + replacement + after;
      setInput(next);
      // Push a sticky pin update for products immediately on accept so the
      // chip-style behavior is reflected in the sticky set even if the
      // user edits the prompt before sending. (resolveAllProductMentions
      // on send remains the source of truth.)
      if (curr.kind === "product") {
        const id = (pick as ProductSuggestion).id;
        setProductPins((prev) => prev.includes(id) ? prev : [...prev, id]);
      }
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (ta) {
          const pos = before.length + replacement.length;
          ta.focus();
          ta.setSelectionRange(pos, pos);
        }
      });
      return null;
    });
  }, [input]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Mention popover navigation takes priority over the Enter-to-send
    // handler so picking a brand suggestion never sends the message.
    if (mention?.open && mentionSuggestions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMention((m) => m ? { ...m, selectedIndex: Math.min(m.selectedIndex + 1, mentionSuggestions.length - 1) } : m);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMention((m) => m ? { ...m, selectedIndex: Math.max(m.selectedIndex - 1, 0) } : m);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const pick = mentionSuggestions[Math.max(0, Math.min(mention.selectedIndex, mentionSuggestions.length - 1))];
        if (pick) acceptMention(pick);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (isGuest) {
        onSignInRequest?.();
        return;
      }
      void sendChat();
    }
  }, [sendChat, isGuest, onSignInRequest, mention, mentionSuggestions, acceptMention]);

  // Recompute mention popover state from the current textarea value and
  // caret position. Called from onChange and onSelect (caret moves via
  // arrow keys / mouse clicks). Closes the popover when the cursor
  // leaves a #token.
  const refreshMention = useCallback((value: string, cursor: number) => {
    // # takes priority when both a # and @ token surround the cursor (in
    // practice they never both can — only one trigger char survives the
    // start-of-token check at any cursor position).
    const brandM = getMentionAtCursor(value, cursor);
    if (brandM) {
      setMention((prev) =>
        prev && prev.kind === "brand" && prev.tokenStart === brandM.start && prev.query === brandM.query
          ? prev
          : { kind: "brand", open: true, query: brandM.query, tokenStart: brandM.start, tokenEnd: brandM.end, selectedIndex: 0 }
      );
      return;
    }
    const productM = getProductMentionAtCursor(value, cursor);
    if (productM) {
      setMention((prev) =>
        prev && prev.kind === "product" && prev.tokenStart === productM.start && prev.query === productM.query
          ? prev
          : { kind: "product", open: true, query: productM.query, tokenStart: productM.start, tokenEnd: productM.end, selectedIndex: 0 }
      );
      return;
    }
    if (mention) setMention(null);
  }, [mention]);

  const handleCopy = useCallback(async (text: string) => {
    try { await navigator.clipboard.writeText(extractCleanPrompt(text)); } catch { /* ignore */ }
  }, []);

  const handleHandoff = useCallback((text: string, videoMode: boolean, musicMode?: boolean) => {
    onHandoffToMake({
      prompt: extractCleanPrompt(text),
      videoMode,
      musicMode,
      references: activeRefs,
    });
    setSplitMenuFor(null);
  }, [activeRefs, onHandoffToMake]);

  const handleOpenHistory = useCallback(() => {
    setHistoryOpen(true);
    void refreshHistory();
  }, [refreshHistory]);

  // Expose imperative methods so an external (mobile) shell can drive the
  // built-in "new chat" and "history" affordances without duplicating state.
  useImperativeHandle(ref, () => ({
    newChat: () => { void handleNewChat(); },
    openHistory: () => { handleOpenHistory(); },
  }), [handleNewChat, handleOpenHistory]);

  const handleSelectChat = useCallback(async (chatId: string) => {
    if (streaming) abortRef.current?.abort();
    try {
      const r = await fetch(`/api/agent/chats/${chatId}`, { credentials: "include" });
      if (!r.ok) return;
      const j = await r.json();
      const msgs: Message[] = Array.isArray(j.messages)
        ? j.messages.map(hydrateStoredMessage)
        : [];
      skipNextPersistRef.current = true;
      setMessages(msgs);
      setActiveChatId(chatId);
      if (j.chat?.modelKey) setModelKey(normalizeStoredModel(j.chat.modelKey));
      // Hydrate per-chat brand pin + disabled flag so brand state does not
      // leak between conversations when switching from history.
      const stickyBrand = j.chat?.brandProfileId;
      setBrandPin(typeof stickyBrand === "string" && stickyBrand.length > 0 ? stickyBrand : null);
      setBrandDisabled(!!j.chat?.brandDisabled);
      const stickyProducts = Array.isArray(j.chat?.productIds) ? j.chat.productIds : [];
      setProductPins(stickyProducts.filter((x: unknown): x is string => typeof x === "string"));
      lastPersistedRef.current = JSON.stringify(msgs.map((m) => ({ role: m.role, text: m.text, images: persistImagesFor(m) || [] })));
      setHistoryOpen(false);
      setErrorBanner(null);
    } catch { /* ignore */ }
  }, [streaming]);

  const handleDeleteChat = useCallback(async (chatId: string) => {
    if (!confirm("Delete this conversation? This cannot be undone.")) return;
    try {
      const r = await fetch(`/api/agent/chats/${chatId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok && r.status !== 404) return;
      setHistoryChats((prev) => prev.filter((c) => c.id !== chatId));
      if (activeChatId === chatId) {
        skipNextPersistRef.current = true;
        setActiveChatId(null);
        setMessages([]);
        lastPersistedRef.current = "";
      }
    } catch { /* ignore */ }
  }, [activeChatId]);

  const handleStartRename = useCallback((chat: ChatSummary) => {
    setRenamingChatId(chat.id);
    setRenameValue(chat.title);
  }, []);

  const handleCommitRename = useCallback(async () => {
    const id = renamingChatId;
    const title = renameValue.trim();
    setRenamingChatId(null);
    setRenameValue("");
    if (!id || !title) return;
    try {
      const r = await fetch(`/api/agent/chats/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (r.ok) {
        const j = await r.json();
        if (j?.chat) {
          setHistoryChats((prev) => prev.map((c) => c.id === id ? { ...c, title: j.chat.title, updatedAt: j.chat.updatedAt } : c));
        }
      }
    } catch { /* ignore */ }
  }, [renamingChatId, renameValue]);

  const rootClassName = `agent-panel${mobileMode ? " agent-panel--mobile" : ""}`;

  // Empty state: signed-in user, but platform API key is missing.
  // (Signed-out users now share the full chat shell below — the composer's
  // send button is replaced with a "Sign in" call-to-action and clicking
  // any of the welcome chips also routes to the sign-in flow.)
  if (available === false) {
    return (
      <aside className={rootClassName} aria-label="Matte panel">
        {!mobileMode && (
          <div className="agent-panel__header">
            <div className="agent-panel__header-actions">
              <button
                type="button"
                className="agent-panel__close"
                onClick={onClose}
                aria-label="Close agent panel"
                title="Close"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </div>
        )}
        <div className="agent-panel__messages">
          <div className="agent-panel__empty">
            <div className="agent-panel__empty-title">Matte is unavailable</div>
            <div className="agent-panel__empty-body">
              The Claude-powered chat assistant is temporarily unavailable. Please try again later
              {onSettingsOpen ? <> or check <button onClick={() => onSettingsOpen("account")}>Settings</button></> : null}.
            </div>
          </div>
        </div>
      </aside>
    );
  }

  return (
    <aside className={rootClassName} aria-label="Matte panel">
      {!mobileMode && (
      <div className="agent-panel__header agent-panel__header--with-alive">
        <div
          className={`agent-panel__alive${streaming ? " agent-panel__alive--busy" : ""}`}
          aria-label={streaming ? "Matte is thinking" : "Matte is online"}
          title={streaming ? "Matte is thinking…" : "Matte is online"}
        >
          <QuantumThinking size={28} ariaLabel={streaming ? "Matte is thinking" : "Matte is online"} />
        </div>
        <div className="agent-panel__header-actions">
          <button
            type="button"
            className="agent-panel__new agent-panel__new--icon"
            onClick={onFullCanvas || onClose}
            aria-label="Full canvas mode"
            title="Full canvas"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
          <button
            type="button"
            className="agent-panel__new"
            onClick={handleOpenHistory}
            aria-label="Open chat history"
          >
            History
          </button>
          <button
            type="button"
            className="agent-panel__new agent-panel__new--icon"
            onClick={handleNewChat}
            disabled={messages.length === 0 && !streaming && !activeChatId}
            aria-label="New chat"
            title="New chat"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <button
            type="button"
            className="agent-panel__close"
            onClick={onClose}
            aria-label="Close agent panel"
            title="Close"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>
      )}

      {historyOpen && (
        <div className="agent-panel__history" role="dialog" aria-label="Chat history">
          <div className="agent-panel__history-header">
            <span>History</span>
            <button
              type="button"
              className="agent-panel__history-close"
              onClick={() => setHistoryOpen(false)}
              aria-label="Close history"
            >×</button>
          </div>
          <div className="agent-panel__history-list">
            {historyLoading && historyChats.length === 0 ? (
              <div className="agent-panel__history-empty">Loading…</div>
            ) : historyChats.length === 0 ? (
              <div className="agent-panel__history-empty">No saved conversations yet.</div>
            ) : (
              historyChats.map((c) => {
                const isRenaming = renamingChatId === c.id;
                const isActive = activeChatId === c.id;
                return (
                  <div
                    key={c.id}
                    className={`agent-panel__history-item${isActive ? " agent-panel__history-item--active" : ""}`}
                  >
                    {isRenaming ? (
                      <input
                        autoFocus
                        className="agent-panel__history-rename"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => void handleCommitRename()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); void handleCommitRename(); }
                          else if (e.key === "Escape") { setRenamingChatId(null); setRenameValue(""); }
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        className="agent-panel__history-title"
                        onClick={() => void handleSelectChat(c.id)}
                        title={c.title}
                      >
                        <span className="agent-panel__history-title-text">{c.title}</span>
                        <span className="agent-panel__history-meta">
                          {(models.find((m) => m.key === c.modelKey)?.label || c.modelKey)} · {formatRelativeTime(c.updatedAt)}
                        </span>
                      </button>
                    )}
                    {!isRenaming && (
                      <div className="agent-panel__history-actions">
                        <button
                          type="button"
                          className="agent-panel__history-action"
                          onClick={() => handleStartRename(c)}
                          aria-label="Rename"
                          title="Rename"
                        >Rename</button>
                        <button
                          type="button"
                          className="agent-panel__history-action agent-panel__history-action--danger"
                          onClick={() => void handleDeleteChat(c.id)}
                          aria-label="Delete"
                          title="Delete"
                        >Delete</button>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      <div className="agent-panel__messages" ref={messagesScrollRef}>
        {messages.length === 0 && available === null && !isGuest ? (
          <div className="agent-panel__empty"><div className="agent-panel__welcome-body">Loading…</div></div>
        ) : messages.length === 0 ? (
          // Empty conversation state — render a faux assistant message
          // that reads as if the agent has already greeted the user. On
          // very first load (no prior `welcomed` flag) it's the longer
          // intro and slides in; on subsequent new chats it's just a
          // quiet "What would you like to create?" prompt with no
          // animation. Both are styled identically to a real assistant
          // reply (bare text, left-aligned, no chips) so the panel
          // never reads as "placeholder text."
          //
          // Signed-out (guest) users ALWAYS see the warm welcome — the
          // localStorage flag is per-browser and the welcome message is
          // the panel's strongest invitation to sign in, so we never
          // demote it to the short version for guests.
          <div className={`agent-panel__hero ${hasWelcomedBefore && !isGuest ? "agent-panel__hero--short" : ""}`} aria-live="polite">
            <h1 className="agent-panel__hero-title">
              {hasWelcomedBefore && !isGuest ? "What should we make?" : "Let's make something amazing together."}
            </h1>
            <p className="agent-panel__hero-sub">
              {hasWelcomedBefore && !isGuest
                ? "Pick a starting point or describe it yourself."
                : "Pick a starting point \u2014 or describe it yourself."}
            </p>
            <div className="agent-panel__hero-grid">
              {[
                { icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8" /><path d="M12 17v4" /></svg>, label: "Short film", desc: "Multi-shot scenes", prompt: "Create a short film with multiple scenes" },
                { icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>, label: "UGC Avatar", desc: "Selfie-style portraits", prompt: "Create a UGC-style avatar portrait" },
                { icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" /></svg>, label: "Photoshoot", desc: "Photoreal", prompt: "Create a photoreal photoshoot" },
                { icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>, label: "Concerto", desc: "Generate music", prompt: "Generate music" },
                { icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /></svg>, label: "Product mockup", desc: "3D-style renders", prompt: "Create a product mockup" },
                { icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" /><polyline points="16 6 12 2 8 6" /><line x1="12" y1="2" x2="12" y2="15" /></svg>, label: "Social campaign", desc: "Multi-format posts", prompt: "Create a social media campaign" },
              ].map((card) => (
                <button
                  key={card.label}
                  type="button"
                  className="agent-panel__hero-card"
                  onClick={() => {
                    if (isGuest) {
                      onSignInRequest?.();
                    } else {
                      setInput(card.prompt);
                      textareaRef.current?.focus();
                    }
                  }}
                >
                  <span className="agent-panel__hero-card-icon">{card.icon}</span>
                  <span className="agent-panel__hero-card-label">{card.label}</span>
                  <span className="agent-panel__hero-card-desc">{card.desc}</span>
                </button>
              ))}
            </div>
            {isGuest && onSignInRequest && (
              <button type="button" className="agent-panel__hero-signin" onClick={onSignInRequest}>
                Sign in to start
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></svg>
              </button>
            )}
          </div>
        ) : (
          messages.map((m) => {
            if (m.role === "error") {
              return (
                <div key={m.id} className="agent-panel__msg agent-panel__msg--assistant">
                  <div className="agent-panel__bubble agent-panel__bubble--error">{m.text}</div>
                  <div className="agent-panel__actions">
                    <button className="agent-panel__action" onClick={() => handleRetryFailed(m.id)}>Retry</button>
                  </div>
                </div>
              );
            }
            const isUser = m.role === "user";
            const hasGens = !isUser && (m.generations?.length || 0) > 0;
            const hasText = m.text.trim().length > 0;
            // Bottom Copy / Use-in-Make row only appears for text-only
            // assistant turns. When the turn has generations, those actions
            // live as icon buttons on each generation card.
            const showActions = !isUser && !m.streaming && hasText && !hasGens;
            return (
              <div key={m.id} className={`agent-panel__msg agent-panel__msg--${isUser ? "user" : "assistant"}`}>
                {isUser && m.images && m.images.length > 0 && (
                  <div className="agent-panel__msg-images">
                    {m.images.map((img, i) => (
                      <div
                        key={i}
                        className={`agent-panel__msg-img${img.source === "agent" ? " agent-panel__msg-img--agent" : ""}`}
                        style={{ backgroundImage: `url(${img.url})` }}
                        title={img.source === "agent" ? `${img.label || "Agent generation"} (carried forward)` : img.label}
                      />
                    ))}
                  </div>
                )}
                {(hasText || (m.streaming && !hasGens)) && (
                  <div className="agent-panel__bubble">
                    {isUser ? (
                      m.text
                    ) : m.streaming && !m.text ? (
                      <ThinkingPill className="agent-panel__thinking" size={20} />
                    ) : (
                      <>
                        <div
                          className="agent-panel__markdown"
                          dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }}
                        />
                        {m.streaming && (
                          <ThinkingPill
                            size={18}
                            className="agent-panel__thinking agent-panel__thinking--inline"
                          />
                        )}
                      </>
                    )}
                  </div>
                )}
                {hasGens && (
                  <div className="agent-panel__gens">
                    {m.generations!.map((g) => {
                      const ready = g.status === "ready" && !!g.url;
                      const failed = g.status === "failed";
                      const tierLabel = g.tier === "quick" ? "Quick" : "Premium";
                      const qualityLabel = g.quality
                        ? g.quality.charAt(0).toUpperCase() + g.quality.slice(1)
                        : null;
                      const modelLabel = prettyAgentModelLabel(g.model) || g.kind;
                      const captionParts = [modelLabel, qualityLabel, g.aspectRatio, tierLabel]
                        .filter(Boolean)
                        .join(" · ");
                      // On-canvas mode: the asset itself lives on the canvas,
                      // so the chat shows just a slim status chip (with the
                      // prompt as a subtitle) instead of the full media card.
                      // Clicking pans/zooms the canvas to the placeholder.
                      if (g.outputMode === "on_canvas") {
                        const inFlight = !ready && !failed;
                        const chipLabel = ready
                          ? (g.kind === "music" ? "Added to Audio Studio" : "Placed on canvas")
                          : failed
                          ? (g.error || (g.kind === "music" ? "Failed" : "Failed on canvas"))
                          : (g.kind === "music" ? "Generating to Audio Studio" : "Generating on canvas…");
                        return (
                          <div
                            key={g.id}
                            className={`agent-gen agent-gen--on-canvas agent-gen--${g.status}`}
                          >
                            <button
                              type="button"
                              className={`agent-gen__placed-chip ${failed ? "agent-gen__placed-chip--failed" : ""}`}
                              onClick={() => handleFocusPlacedNode(g)}
                              title={ready ? "Show on canvas" : failed ? "Show error on canvas" : "Show placeholder on canvas"}
                              disabled={!g.canvasNodeId}
                            >
                              {inFlight ? (
                                <QuantumThinking size={14} ariaLabel="Generating" />
                              ) : (
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <rect x="3" y="3" width="18" height="18" rx="2" />
                                  <circle cx="9" cy="9" r="1.5" />
                                </svg>
                              )}
                              {chipLabel}
                            </button>
                            {failed && (
                              <button
                                type="button"
                                className="agent-gen__action agent-gen__action--ghost"
                                onClick={() => handleRemoveGen(g, m.id)}
                              >Dismiss</button>
                            )}
                          </div>
                        );
                      }
                      return (
                        <div
                          key={g.id}
                          className={`agent-gen agent-gen--${g.status}${
                            mobileMode && ready && activeGenId === g.id ? " agent-gen--active" : ""
                          }`}
                          draggable={ready}
                          onDragStart={(e) => handleGenDragStart(e, g)}
                          onDragEnd={handleGenDragEnd}
                          onDoubleClick={() => ready && handlePlaceGen(g)}
                          onClick={(e) => {
                            // Mobile: tapping the card toggles its overlay so
                            // the menu icons are visible against any image
                            // backdrop. Tapping a button inside still fires
                            // that button (and the click bubbles up here,
                            // which conveniently also closes the overlay).
                            if (!mobileMode || !ready) return;
                            const target = e.target as HTMLElement;
                            // If the user tapped a button (or any control
                            // inside the card), let that handler run and
                            // also close the overlay.
                            if (target.closest("button, a, [role='button']")) {
                              setActiveGenId(null);
                              return;
                            }
                            setActiveGenId((cur) => (cur === g.id ? null : g.id));
                          }}
                        >
                          <div
                            className={`agent-gen__media${g.kind === "music" ? " agent-gen__media--music" : ""}`}
                            style={ready && g.kind !== "music" && g.aspectRatio
                              ? { aspectRatio: g.aspectRatio.replace(":", " / ") }
                              : undefined}
                          >
                            {ready ? (
                              g.kind === "music" ? (
                                <div className="agent-gen__audio-wrap">
                                  <audio
                                    src={g.url!}
                                    controls
                                    preload="metadata"
                                    className="agent-gen__audio"
                                  />
                                </div>
                              ) : g.kind === "video" ? (
                                <video
                                  src={g.url!}
                                  className="agent-gen__img"
                                  muted
                                  loop
                                  playsInline
                                  autoPlay
                                />
                              ) : (
                                <img src={g.url!} alt={g.prompt || "Agent generation"} className="agent-gen__img" />
                              )
                            ) : failed ? (
                              <div className="agent-gen__failed" title={g.error || "Generation failed"}>
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <circle cx="12" cy="12" r="10" />
                                  <line x1="15" y1="9" x2="9" y2="15" />
                                  <line x1="9" y1="9" x2="15" y2="15" />
                                </svg>
                                <span className="agent-gen__failed-msg">{g.error || "Generation failed"}</span>
                                {g.errorCode === "insufficient_credits" && onSettingsOpen && (
                                  <button
                                    type="button"
                                    className="agent-gen__cta"
                                    onClick={() => onSettingsOpen("billing")}
                                    title="Open billing to top up credits"
                                  >Buy credits</button>
                                )}
                                {g.errorCode === "no_canvas" && (
                                  <span className="agent-gen__cta-hint">Open or create a canvas to generate.</span>
                                )}
                              </div>
                            ) : g.kind === "music" ? (
                              <div className="agent-gen__music-generating">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <path d="M9 18V5l12-2v13" />
                                  <circle cx="6" cy="18" r="3" />
                                  <circle cx="18" cy="16" r="3" />
                                </svg>
                                <span>Generating to Audio Studio</span>
                              </div>
                            ) : (
                              <div className="agent-gen__shimmer" aria-label="Generating" />
                            )}
                          </div>
                          <div className="agent-gen__meta">
                            <div className="agent-gen__caption" title={g.prompt}>
                              {g.prompt || (g.kind === "music" ? "Music" : g.kind === "video" ? "Video" : "Image")}
                            </div>
                            {captionParts && <div className="agent-gen__sub">{captionParts}</div>}
                            {g.notice && <div className="agent-gen__notice">{g.notice}</div>}
                            {g.canvasNodeId && (
                              <button
                                type="button"
                                className={`agent-gen__placed-chip ${failed ? "agent-gen__placed-chip--failed" : ""}`}
                                onClick={(e) => { e.stopPropagation(); handleFocusPlacedNode(g); }}
                                title={ready ? "Show on canvas" : failed ? "Show error on canvas" : "Show placeholder on canvas"}
                              >
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <rect x="3" y="3" width="18" height="18" rx="2" />
                                  <circle cx="9" cy="9" r="1.5" />
                                </svg>
                                {ready
                                  ? (g.kind === "music" ? "Added to Audio Studio" : "Placed on canvas")
                                  : failed
                                  ? (g.kind === "music" ? "Failed" : "Failed on canvas")
                                  : (g.kind === "music" ? "Generating to Audio Studio" : "Generating on canvas")}
                              </button>
                            )}
                          </div>
                          {ready ? (
                            <div className="agent-gen__actions">
                              {canvasApi?.isLive?.() && canvasId && !g.canvasNodeId && (
                                <button
                                  type="button"
                                  className="agent-gen__icon-btn"
                                  onClick={() => handlePlaceGen(g)}
                                  aria-label="Add to canvas"
                                  title="Add to canvas"
                                >
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <rect x="3" y="3" width="18" height="18" rx="2" />
                                    <line x1="12" y1="8" x2="12" y2="16" />
                                    <line x1="8" y1="12" x2="16" y2="12" />
                                  </svg>
                                </button>
                              )}
                              {g.kind !== "music" && (
                                <button
                                  type="button"
                                  className="agent-gen__icon-btn"
                                  onClick={() => handleEditWithAgent(g)}
                                  aria-label="Edit with agent"
                                  title="Edit with agent"
                                >
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <path d="M12 20h9" />
                                    <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                                  </svg>
                                </button>
                              )}
                              {onSaveToLibrary && (
                                <button
                                  type="button"
                                  className="agent-gen__icon-btn"
                                  onClick={() => handleSaveGen(g)}
                                  aria-label="Save to library"
                                  title="Save to library"
                                >
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                                  </svg>
                                </button>
                              )}
                              <button
                                type="button"
                                className="agent-gen__icon-btn"
                                onClick={() => handleOpenGen(g)}
                                aria-label={g.kind === "music" ? "Download" : "Open full size"}
                                title={g.kind === "music" ? "Download" : "Open"}
                              >
                                {g.kind === "music" ? (
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                    <polyline points="7 10 12 15 17 10" />
                                    <line x1="12" y1="15" x2="12" y2="3" />
                                  </svg>
                                ) : (
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <path d="M15 3h6v6" />
                                    <path d="M9 21H3v-6" />
                                    <line x1="21" y1="3" x2="14" y2="10" />
                                    <line x1="3" y1="21" x2="10" y2="14" />
                                  </svg>
                                )}
                              </button>
                              <button
                                type="button"
                                className="agent-gen__icon-btn"
                                onClick={() => handleCopy(g.prompt || m.text || "")}
                                aria-label="Copy prompt"
                                title="Copy prompt"
                              >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <rect x="9" y="9" width="13" height="13" rx="2" />
                                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                                </svg>
                              </button>
                              <button
                                type="button"
                                className="agent-gen__icon-btn agent-gen__icon-btn--danger"
                                onClick={() => handleRemoveGen(g, m.id)}
                                aria-label="Discard"
                                title="Discard"
                              >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <polyline points="3 6 5 6 21 6" />
                                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                                  <path d="M10 11v6" />
                                  <path d="M14 11v6" />
                                  <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
                                </svg>
                              </button>
                              <div
                                className="agent-gen__split"
                                ref={genSplitMenuFor === g.id ? genSplitMenuRef : undefined}
                              >
                                <button
                                  type="button"
                                  className="agent-gen__icon-btn"
                                  onClick={() => {
                                    setGenSplitMenuFor(null);
                                    handleHandoff(m.text || g.prompt, g.kind === "video", g.kind === "music");
                                  }}
                                  onContextMenu={(e) => {
                                    e.preventDefault();
                                    setGenSplitMenuFor(genSplitMenuFor === g.id ? null : g.id);
                                  }}
                                  aria-label="Use in Make"
                                  title="Use in Make"
                                >
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                                  </svg>
                                </button>
                                <button
                                  type="button"
                                  className="agent-gen__split-caret"
                                  aria-label="Choose Make target"
                                  title="Choose Make target"
                                  onClick={() => setGenSplitMenuFor(genSplitMenuFor === g.id ? null : g.id)}
                                >
                                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <polyline points="6 9 12 15 18 9" />
                                  </svg>
                                </button>
                                {genSplitMenuFor === g.id && (
                                  <div className="agent-panel__split-menu">
                                    <button onClick={() => { handleHandoff(m.text || g.prompt, false); setGenSplitMenuFor(null); }}>Use as Image prompt</button>
                                    <button onClick={() => { handleHandoff(m.text || g.prompt, true); setGenSplitMenuFor(null); }}>Use as Video prompt</button>
                                    <button onClick={() => { handleHandoff(m.text || g.prompt, false, true); setGenSplitMenuFor(null); }}>Use as Music prompt</button>
                                  </div>
                                )}
                              </div>
                            </div>
                          ) : failed ? (
                            <div className="agent-gen__actions">
                              <button
                                type="button"
                                className="agent-gen__action"
                                onClick={() => handleRetryFailed(m.id)}
                              >Retry</button>
                              <button
                                type="button"
                                className="agent-gen__action agent-gen__action--ghost"
                                onClick={() => handleRemoveGen(g, m.id)}
                              >Discard</button>
                            </div>
                          ) : (
                            <div className="agent-gen__actions">
                              <button
                                type="button"
                                className="agent-gen__action agent-gen__action--ghost"
                                onClick={() => handleRemoveGen(g, m.id)}
                              >Cancel</button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                {showActions && (
                  <div className="agent-panel__actions">
                    <button className="agent-panel__action" onClick={() => handleCopy(m.text)}>Copy</button>
                    {!mobileMode && (
                      <div className="agent-panel__action agent-panel__action--split" ref={splitMenuFor === m.id ? splitMenuRef : undefined}>
                        <button className="agent-panel__split-main" onClick={() => handleHandoff(m.text, false)}>Use in Make</button>
                        <button
                          className="agent-panel__split-toggle"
                          aria-label="Choose target"
                          onClick={() => setSplitMenuFor(splitMenuFor === m.id ? null : m.id)}
                        >▾</button>
                        {splitMenuFor === m.id && (
                          <div className="agent-panel__split-menu">
                            <button onClick={() => handleHandoff(m.text, false)}>Use as Image prompt</button>
                            <button onClick={() => handleHandoff(m.text, true)}>Use as Video prompt</button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {displayRefs.length > 0 && (
        <div className="agent-panel__refs">
          {displayRefs.map((ref) => (
            <div
              key={ref.id}
              className={
                ref.kind === "extra" && (ref.ref as AgentExtraRef).source !== "upload"
                  ? "agent-panel__ref agent-panel__ref--agent"
                  : "agent-panel__ref"
              }
              style={{ backgroundImage: `url(${ref.url})` }}
              title={ref.label}
            >
              <button
                type="button"
                className="agent-panel__ref-x"
                aria-label={`Remove ${ref.label}`}
                onClick={() => {
                  if (ref.kind === "canvas") handleRemoveRef(ref.id);
                  else handleRemoveAgentExtraRef(ref.id);
                }}
              >×</button>
            </div>
          ))}
        </div>
      )}

      {viewerMedia && (
        <div
          className="agent-panel__viewer"
          role="dialog"
          aria-modal="true"
          aria-label="Media viewer"
          onClick={() => setViewerMedia(null)}
        >
          <button
            type="button"
            className="agent-panel__viewer-close"
            aria-label="Close"
            onClick={(e) => { e.stopPropagation(); setViewerMedia(null); }}
          >×</button>
          {viewerMedia.kind === "video" ? (
            <video
              src={viewerMedia.url}
              className="agent-panel__viewer-media"
              controls
              autoPlay
              loop
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <img
              src={viewerMedia.url}
              alt=""
              className="agent-panel__viewer-media"
              onClick={(e) => e.stopPropagation()}
            />
          )}
        </div>
      )}

      <div className="agent-panel__composer">
        {productPins.length > 0 && products.length > 0 && (() => {
          // Resolve sticky pins to live product objects so the chips show
          // the same name + thumbnail + source-kind badge as the popover.
          // Pins that no longer correspond to a visible product (e.g. an
          // axiom was deleted, entitlement revoked, or workspace switched)
          // are silently dropped from the rail — the server still drops
          // them too on the next send.
          const byId = new Map(products.map((p) => [p.id, p] as const));
          const chips = productPins
            .map((id) => byId.get(id))
            .filter((p): p is MentionProduct => !!p);
          if (chips.length === 0) return null;
          return (
            <div className="agent-panel__product-chips" aria-label="Pinned products">
              {chips.map((p) => (
                <span
                  key={p.id}
                  className={`agent-panel__product-chip agent-panel__product-chip--${p.sourceKind}`}
                  title={p.description || `${p.name} · @${p.slug}`}
                >
                  {p.thumbnail ? (
                    <img className="agent-panel__product-chip-thumb" src={p.thumbnail} alt="" aria-hidden="true" />
                  ) : (
                    <span className="agent-panel__product-chip-thumb agent-panel__product-chip-thumb--placeholder" aria-hidden="true">
                      {(p.name || "?").slice(0, 1).toUpperCase()}
                    </span>
                  )}
                  <span className="agent-panel__product-chip-name">@{p.slug}</span>
                  <button
                    type="button"
                    className="agent-panel__product-chip-x"
                    aria-label={`Unpin ${p.name}`}
                    onClick={() => setProductPins((prev) => prev.filter((id) => id !== p.id))}
                  >×</button>
                </span>
              ))}
            </div>
          );
        })()}
        {errorBanner && <div className="agent-panel__error">{errorBanner}</div>}
        {contextWarning && (
          <div
            className={`agent-panel__context-warning agent-panel__context-warning--${contextWarning.level}`}
            role="status"
          >
            <span>
              {contextWarning.level === "critical"
                ? "This conversation is near the model's context limit — start a new chat for best results."
                : "This conversation is getting long. Start a new chat soon to keep replies sharp."}
              {" "}
              ({Math.round(contextWarning.fraction * 100)}% used)
            </span>
            <button
              type="button"
              className="agent-panel__context-warning-btn"
              onClick={handleNewChat}
              disabled={streaming}
            >
              New chat
            </button>
          </div>
        )}
        <div className={`agent-panel__textarea-wrap${agentWorking ? " agent-panel__textarea-wrap--generating" : ""}`}>
          <div className="agent-panel__glow agent-panel__glow--sharp" aria-hidden="true" />
          <div className="agent-panel__glow-blur" aria-hidden="true">
            <div className="agent-panel__glow agent-panel__glow--soft" />
          </div>
          <textarea
            ref={textareaRef}
            className="agent-panel__textarea"
            placeholder="Describe what you want to create.."
            value={input}
            onChange={(e) => {
              const v = e.target.value;
              setInput(v);
              const cursor = e.target.selectionStart ?? v.length;
              refreshMention(v, cursor);
            }}
            onSelect={(e) => {
              const ta = e.currentTarget;
              refreshMention(ta.value, ta.selectionStart ?? ta.value.length);
            }}
            onBlur={() => {
              // Defer so a click on a popover row registers before close.
              window.setTimeout(() => setMention(null), 120);
            }}
            onKeyDown={handleKeyDown}
            rows={4}
          />
          {!input && (
            <span
              className="agent-panel__placeholder-sweep"
              aria-hidden="true"
              onClick={() => textareaRef.current?.focus()}
            >
              Describe what you want to create..
              <span className="agent-panel__placeholder-hint">&nbsp;&nbsp;type # for a brand &nbsp;·&nbsp; @ for a product</span>
            </span>
          )}
          {mention?.open && mentionSuggestions.length > 0 && (
            <div
              className="agent-panel__mention"
              role="listbox"
              aria-label={mention.kind === "brand" ? "Brand suggestions" : "Product suggestions"}
              onMouseDown={(e) => e.preventDefault()}
            >
              <div className="agent-panel__mention-header">
                {mention.kind === "brand" ? "Brand for this message" : "Product for this message"}
              </div>
              <ul className="agent-panel__mention-list">
                {mentionSuggestions.map((s, i) => {
                  const isProduct = mention.kind === "product";
                  const trigger = isProduct ? "@" : "#";
                  const product = isProduct ? (s as ProductSuggestion) : null;
                  const brand = !isProduct ? (s as BrandSuggestion) : null;
                  return (
                    <li
                      key={s.id}
                      className={`agent-panel__mention-item${i === mention.selectedIndex ? " agent-panel__mention-item--active" : ""}`}
                      role="option"
                      aria-selected={i === mention.selectedIndex}
                      onMouseEnter={() => setMention((m) => m ? { ...m, selectedIndex: i } : m)}
                      onClick={() => acceptMention(s)}
                    >
                      {product ? (
                        product.thumbnail ? (
                          <img
                            className="agent-panel__mention-thumb"
                            src={product.thumbnail}
                            alt=""
                            aria-hidden="true"
                          />
                        ) : (
                          <span className="agent-panel__mention-thumb agent-panel__mention-thumb--placeholder" aria-hidden="true">
                            {(product.name || "?").slice(0, 1).toUpperCase()}
                          </span>
                        )
                      ) : (
                        <span
                          className="agent-panel__mention-dot"
                          style={{ background: brand?.avatar_color || "#9ca3af" }}
                          aria-hidden="true"
                        />
                      )}
                      <span className="agent-panel__mention-name">{s.name}</span>
                      {product && (
                        <span className={`agent-panel__mention-source agent-panel__mention-source--${product.sourceKind}`}>
                          {product.sourceKind === "platform" ? "Platform" : product.sourceKind === "workspace" ? "Workspace" : "You"}
                        </span>
                      )}
                      <span className="agent-panel__mention-slug">{trigger}{s.slug}</span>
                    </li>
                  );
                })}
              </ul>
              <div className="agent-panel__mention-hint">
                <kbd>↑</kbd><kbd>↓</kbd> navigate &nbsp;·&nbsp; <kbd>↵</kbd> select &nbsp;·&nbsp; <kbd>esc</kbd> close
              </div>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="agent-panel__file-input"
            onChange={handleFileChosen}
            tabIndex={-1}
            aria-hidden="true"
          />
          <button
            type="button"
            className="agent-panel__upload"
            onClick={handlePickFile}
            aria-label="Attach reference image"
            title="Attach reference image"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          {streaming && !input.trim() ? (
            <button
              type="button"
              className="agent-panel__send agent-panel__send--stop"
              onClick={handleStop}
              aria-label="Stop generating"
              title="Stop"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <rect x="5" y="5" width="14" height="14" rx="2" />
              </svg>
            </button>
          ) : isGuest ? (
            <button
              type="button"
              className="agent-panel__send agent-panel__send--text"
              onClick={() => onSignInRequest?.()}
              aria-label="Sign in to chat"
              title="Sign in"
            >
              {/* Icon shown only when the composer is in pill (idle)
                * state — CSS hides the label and reveals this so the
                * Sign-in slot reads as a clean blue circle. */}
              <svg
                className="agent-panel__send-icon"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <line x1="12" y1="19" x2="12" y2="5" />
                <polyline points="6 11 12 5 18 11" />
              </svg>
              <span className="agent-panel__send-label">Sign in</span>
            </button>
          ) : (
            <button
              type="button"
              className="agent-panel__send"
              disabled={!input.trim() || available !== true}
              onClick={() => void sendChat()}
              aria-label="Send message"
              title="Send"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="12" y1="19" x2="12" y2="5" />
                <polyline points="6 11 12 5 18 11" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </aside>
  );
});
