import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode, type KeyboardEvent } from "react";
import { QuantumThinking } from "./QuantumThinking";
import { ClaudePixel } from "./ClaudePixel";
import { ThinkingPill } from "./ThinkingPill";
import { renderMarkdown } from "../utils/markdown";
import type { ReferenceImage } from "../types/canvas";
import { desktopBridge } from "../desktop";
import "./AgentPanel.css";
import "./OperatorPanel.css";

/** Slug from the doc's own title line — same rule the Skills panel uses, so a
 *  re-uploaded file overwrites its earlier version instead of piling up. */
function slugFrom(body: string, fallback: string): string {
  const title = /^(?:name|title):\s*(.+)$/mi.exec(body)?.[1]
    || /^#\s+(.+)$/m.exec(body)?.[1]
    || fallback;
  return title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64)
    || "pinned-instructions";
}

/**
 * OperatorPanel (Phase K) — the Matte agent console. Reuses the AgentPanel visual
 * design (light paper card, hero, bubbles, glow composer) but instead of the
 * retired BYOK Anthropic chat it drives the user's **Claude Code** subscription
 * headlessly (server/operator) via SSE. Claude calls the matteblack MCP tools;
 * generations land on the canvas; the conversation streams here.
 */

type OperatorStatus = { binaryFound: boolean; binaryPath: string };

const GEN_TOOLS = new Set(["generate_media", "generate_music", "transform_media"]);

// The models the operator may drive Claude Code with (--model). Opus 5 is the
// default (first entry); Fable is the cheaper/faster alternative.
const OPERATOR_MODELS: { id: string; label: string }[] = [
  { id: "claude-opus-5", label: "Opus 5" },
  { id: "claude-opus-4-8", label: "Opus 4.8" },
  { id: "claude-fable-5", label: "Fable" },
];
// Bumped to v3 so the prior Opus 4.8 default doesn't stick.
const MODEL_STORAGE_KEY = "mb-operator-model-v3";

/**
 * Claude Code's `--effort` levels — how much the model is allowed to think before
 * answering. Exposed as a slider because thinking is flat-rate on the user's
 * subscription: it costs nothing extra, so there's no reason to hide it.
 */
const EFFORT_LEVELS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra high" },
  // Matteblack's answer to Claude Code's "Ultracode" — this app generates, it doesn't code.
  { id: "max", label: "Ultra Gen" },
] as const;
/** Default to High: reasoning is free at the margin, generations are not. */
const DEFAULT_EFFORT = 2;
const EFFORT_STORAGE_KEY = "mb-operator-effort-v1";
// Conversation persistence. The panel unmounts whenever the rail switches view,
// which used to throw the whole thread away; claude's own session survives (we
// pass --resume), so only this side was losing it. Capped so a long-running
// install can't grow localStorage without bound.
const CHAT_STORAGE_KEY = "mb-operator-chat-v1";
const CHATS_STORAGE_KEY = "mb-operator-chats-v1";
const CHAT_MAX_MESSAGES = 200;
/** Keep a month of threads, not a career. Oldest fall off the end. */
const CHAT_MAX_SESSIONS = 30;
/** ponytail: fixed throttle — a serialise every few seconds is cheap next to losing the thread. */
const CHAT_SAVE_THROTTLE_MS = 3000;

/**
 * Ordered (Bayer) dither ramp for the effort track, matching Claude Code's own
 * slider. Density rises left→right, so the fill dissolves from flat grey into
 * solid accent through a pixel checker rather than a smooth gradient — which
 * also happens to rhyme with the pixel sprite in the header.
 */
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

const DITHER_COLS = 38;
const DITHER_ROWS = 4;

/**
 * Cell grid for the ramp, computed once. Opacity rises left→right with Bayer
 * jitter, so cells are *partly* transparent rather than on/off — that's what
 * gives the dissolve its softness. Each cell also carries:
 *   delay   — staggered by (1 - t) so the colour fills in from the right
 *   twinkle — a sparse subset that flashes pale, scattered across the ramp
 */
const DITHER_CELLS = (() => {
  const out: { x: number; y: number; o: number; delay: number; twinkle: number | null }[] = [];
  for (let x = 0; x < DITHER_COLS; x++) {
    const t = x / (DITHER_COLS - 1);
    for (let y = 0; y < DITHER_ROWS; y++) {
      const jitter = BAYER[y % 4][x % 4] / 16;
      const o = Math.max(0, Math.min(1, (t - jitter * 0.55) * 1.6));
      if (o <= 0.002) continue;
      out.push({
        x,
        y,
        o,
        delay: (1 - t) * 0.42,
        // Deterministic scatter — no Math.random, so it never reshuffles on render.
        twinkle: (x * 7 + y * 3) % 11 === 0 ? ((x * 13 + y * 5) % 42) / 10 : null,
      });
    }
  }
  return out;
})();

/** The Ultracode ramp: semi-transparent pixels that fill right→left and shimmer. */
function EffortDither({ active }: { active: boolean }) {
  return (
    <svg
      className={`operator-effort-pop__dither${active ? " is-on" : ""}`}
      viewBox={`0 0 ${DITHER_COLS} ${DITHER_ROWS}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="matteblack-effort-ramp" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#007AFF" stopOpacity="0" />
          <stop offset="45%" stopColor="#007AFF" stopOpacity="0.18" />
          <stop offset="100%" stopColor="#007AFF" stopOpacity="0.38" />
        </linearGradient>
      </defs>
      {/* Bed under the cells so the gaps between pixels read as a dimmer blue
        * rather than bare grey track. Ramps with position like the cells do. */}
      <rect
        className="px px--bed"
        x={0}
        y={0}
        width={DITHER_COLS}
        height={DITHER_ROWS}
        fill="url(#matteblack-effort-ramp)"
      />
      {DITHER_CELLS.map((c) => (
        <rect
          key={`${c.x}-${c.y}`}
          className={c.twinkle !== null ? "px px--tw" : "px"}
          x={c.x + 0.08}
          y={c.y + 0.08}
          width={0.84}
          height={0.84}
          style={{
            opacity: c.o,
            animationDelay: c.twinkle !== null ? `${c.delay}s, ${c.twinkle}s` : `${c.delay}s`,
          }}
        />
      ))}
    </svg>
  );
}

type Gen = {
  id: string;
  tool: string;
  status: "running" | "ready" | "failed";
  url?: string;
  error?: string;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  streaming: boolean;
  gens: Gen[];
  error?: string;
};

function loadChat(): { messages: ChatMessage[]; sessionId?: string } {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) return { messages: [] };
    const p = JSON.parse(raw) as { messages?: ChatMessage[]; sessionId?: string };
    if (!Array.isArray(p.messages)) return { messages: [] };
    // A turn interrupted by a reload would otherwise restore stuck on a
    // spinner that nothing will ever resolve.
    return { messages: p.messages.map((m) => ({ ...m, streaming: false })), sessionId: p.sessionId };
  } catch { return { messages: [] }; }
}

/**
 * Many threads, not one. Each carries claude's own `sessionId`, so picking an
 * old conversation and typing resumes it on claude's side too rather than
 * starting cold with a transcript pasted above it.
 */
type ChatSession = { id: string; title: string; sessionId?: string; messages: ChatMessage[]; updatedAt: number };
type ChatStore = { activeId: string; sessions: ChatSession[] };

function chatTitle(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user")?.text.trim() || "";
  return first ? first.slice(0, 60) : "New chat";
}

function newChatId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function loadChats(): ChatStore {
  try {
    const raw = localStorage.getItem(CHATS_STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<ChatStore>;
      if (Array.isArray(p.sessions)) {
        const sessions = p.sessions.map((s) => ({
          ...s,
          // A turn interrupted by a reload would otherwise restore stuck on a
          // spinner that nothing will ever resolve.
          messages: (s.messages ?? []).map((m) => ({ ...m, streaming: false })),
        }));
        return { activeId: p.activeId || sessions[0]?.id || newChatId(), sessions };
      }
    }
  } catch { /* corrupt store — fall through to the migration below */ }
  // One-time migration off the single-thread store.
  const old = loadChat();
  const id = newChatId();
  return old.messages.length
    ? { activeId: id, sessions: [{ id, title: chatTitle(old.messages), sessionId: old.sessionId, messages: old.messages, updatedAt: Date.now() }] }
    : { activeId: id, sessions: [] };
}

function saveChats(store: ChatStore) {
  try {
    localStorage.setItem(CHATS_STORAGE_KEY, JSON.stringify(store));
  } catch { /* quota / private mode — history is a convenience, not state */ }
}

type ServerEvent =
  | { type: "ping" }
  | { type: "session"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; tool: string; input: unknown }
  | { type: "tool_result"; id: string; text: string; isError: boolean }
  | { type: "done"; sessionId?: string; result: string; isError: boolean }
  | { type: "error"; message: string };

const IMG_URL_RE = /(\/uploads\/\S+?\.(?:png|jpe?g|webp|gif|avif)|https?:\/\/\S+?\.(?:png|jpe?g|webp|gif|avif))/i;
const ANY_URL_RE = /(\/uploads\/\S+|https?:\/\/\S+)/i;
function extractUrl(text: string): string | undefined {
  const img = text.match(IMG_URL_RE);
  if (img) return img[1];
  const any = text.match(ANY_URL_RE);
  return any ? any[1] : undefined;
}

const MAX_REFS = 4; // /api/agent/tool caps referenceUrls at 4.

// An image attached to the next generation — either uploaded via the (+) button
// or a live reflection of the canvas selection. `url` is what we send as a
// reference; `preview` is what the chip shows (a local object URL while an
// upload is still in flight).
type Attachment = {
  id: string;
  url: string;
  preview: string;
  label: string;
  source: "upload" | "canvas";
  uploading?: boolean;
  aspectRatio?: string; // snapped AR label for canvas selections (lineage)
};

/** Absolutize a possibly-relative image URL so the server can fetch it. */
function absolutizeUrl(u: string): string {
  if (!u) return u;
  if (u.startsWith("//")) return `${window.location.protocol}${u}`;
  if (u.startsWith("/")) return `${window.location.origin}${u}`;
  return u;
}

/** Resolve a canvas ReferenceImage to a concrete image URL (mirrors the legacy
 *  AgentPanel's refToImageUrl). Prefers an axiom image, else the node's
 *  gradient/src (unwrapping a `url(...)` wrapper). Returns null if unusable. */
function referenceToUrl(ref: ReferenceImage): string | null {
  if (ref.axiomImages && ref.axiomImages.length > 0 && ref.axiomImages[0]) {
    return absolutizeUrl(ref.axiomImages[0]);
  }
  let g = ref.gradient || "";
  if (g.startsWith("url(")) {
    const m = g.match(/url\((['"]?)([^'")]+)\1\)/);
    g = m ? m[2] : "";
  }
  if (!g || g.startsWith("blob:")) return null;
  return absolutizeUrl(g);
}

const HERO_CARDS: { icon: ReactNode; label: string; desc: string; prompt: string }[] = [
  { icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8" /><path d="M12 17v4" /></svg>, label: "Short film", desc: "Multi-shot scenes", prompt: "Create a short film with multiple scenes" },
  { icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>, label: "UGC Avatar", desc: "Selfie-style portraits", prompt: "Create a UGC-style avatar portrait" },
  { icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" /></svg>, label: "Photoshoot", desc: "Photoreal", prompt: "Create a photoreal photoshoot" },
  { icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>, label: "Concerto", desc: "Generate music", prompt: "Generate music" },
  { icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /></svg>, label: "Product mockup", desc: "3D-style renders", prompt: "Create a product mockup" },
  { icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" /><polyline points="16 6 12 2 8 6" /><line x1="12" y1="2" x2="12" y2="15" /></svg>, label: "Social campaign", desc: "Multi-format posts", prompt: "Create a social media campaign" },
];

let msgSeq = 0;
const nextId = () => `op-${Date.now()}-${msgSeq++}`;

export function OperatorPanel({
  onClose,
  onBusyChange,
  getCanvasContext,
  canvasReferenceImages,
  seedPrompt,
}: {
  onClose: () => void;
  onBusyChange?: (busy: boolean) => void;
  // Supplies the canvas the user has open + their current viewport (world
  // coords), captured at send time so operator generations land on-screen.
  getCanvasContext?: () => { canvasId?: string; viewport?: { cx: number; cy: number; w: number; h: number } };
  // The image(s) currently selected on the canvas — shown as removable chips in
  // the composer and sent as the generation reference (→ fal img2img).
  canvasReferenceImages?: ReferenceImage[];
  /** Text dropped into the composer from elsewhere (e.g. the Skills panel).
   *  Carries a nonce so sending the same text twice still re-seeds. */
  seedPrompt?: { text: string; nonce: number } | null;
}) {
  const [status, setStatus] = useState<OperatorStatus | null>(null);
  // Both of these have to come from the SAME store read. Seeding `messages`
  // from the legacy single-thread key (which nothing writes any more) meant the
  // panel remounted empty, and the save effect then wrote that emptiness over
  // the active session — reopening the agent deleted the thread it should have
  // restored.
  const initialChats = useRef<ChatStore>(loadChats()).current;
  const [messages, setMessages] = useState<ChatMessage[]>(
    () => initialChats.sessions.find((s) => s.id === initialChats.activeId)?.messages ?? []
  );
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [model, setModel] = useState<string>(() => {
    try {
      const v = localStorage.getItem(MODEL_STORAGE_KEY) || "";
      return OPERATOR_MODELS.some((m) => m.id === v) ? v : OPERATOR_MODELS[0].id;
    } catch { return OPERATOR_MODELS[0].id; }
  });
  const [effortIndex, setEffortIndex] = useState<number>(() => {
    try {
      // Guard the null case explicitly: Number(null) is 0, which would pass the
      // range check below and silently pin a first-run user to the lowest level.
      const raw = localStorage.getItem(EFFORT_STORAGE_KEY);
      if (raw === null) return DEFAULT_EFFORT;
      const v = Number(raw);
      return Number.isInteger(v) && v >= 0 && v < EFFORT_LEVELS.length ? v : DEFAULT_EFFORT;
    } catch { return DEFAULT_EFFORT; }
  });
  const [effortOpen, setEffortOpen] = useState(false);
  const effortWrapRef = useRef<HTMLDivElement | null>(null);
  // Uploaded attachments (via the + button). Canvas-selected references come
  // from the prop and are tracked separately (with a per-id dismiss set).
  const [uploads, setUploads] = useState<Attachment[]>([]);
  const [dismissedCanvasRefs, setDismissedCanvasRefs] = useState<Set<string>>(() => new Set());
  const [chats, setChats] = useState<ChatStore>(initialChats);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [pins, setPins] = useState<{ slug: string; title: string }[]>([]);
  const [pinError, setPinError] = useState("");
  const chatIdRef = useRef<string>(chats.activeId);
  const sessionIdRef = useRef<string | undefined>(
    chats.sessions.find((s) => s.id === chats.activeId)?.sessionId,
  );
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const docInputRef = useRef<HTMLInputElement | null>(null);
  // In-flight upload promises (resolve to the hosted URL, or null on failure).
  // send() awaits these so a reference is never dropped just because its upload
  // hadn't finished when the user hit enter.
  const pendingUploadsRef = useRef<Promise<string | null>[]>([]);

  useEffect(() => { onBusyChange?.(streaming); }, [streaming, onBusyChange]);

  // Live chips for the current canvas selection (minus any the user dismissed).
  const canvasChips = useMemo<Attachment[]>(() => {
    const out: Attachment[] = [];
    const seen = new Set<string>();
    for (const ref of canvasReferenceImages ?? []) {
      if (dismissedCanvasRefs.has(ref.id)) continue;
      const url = referenceToUrl(ref);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push({ id: ref.id, url, preview: url, label: ref.label || "Selected", source: "canvas", aspectRatio: ref.aspectRatio });
    }
    return out;
  }, [canvasReferenceImages, dismissedCanvasRefs]);

  // All chips shown in the composer: uploads first (explicit intent), then the
  // canvas selection. Capped to what the backend accepts.
  const attachments = useMemo<Attachment[]>(
    () => [...uploads, ...canvasChips].slice(0, MAX_REFS),
    [uploads, canvasChips],
  );

  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/operator/status", { credentials: "include" });
      if (res.ok) setStatus(await res.json());
    } catch { /* offline */ }
  }, []);
  useEffect(() => { refreshStatus(); }, [refreshStatus]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // A restored chat opens at its LAST message, not its first — on first load
  // AND on every switch from the history list, which is why this keys off the
  // active chat id rather than running once on mount.
  // The effect above isn't enough on its own: the transcript is still laying out —
  // markdown, code blocks, thumbnails — so scrollHeight is a fraction of its
  // final value and the one jump lands near the top of a very long scroll.
  // Re-pin while the content is still growing, and stop the moment the user
  // scrolls, so this can never fight them.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || el.scrollHeight <= el.clientHeight) return;
    const pin = () => { el.scrollTop = el.scrollHeight; };
    pin();
    const ro = new ResizeObserver(pin);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    const stop = () => ro.disconnect();
    el.addEventListener("wheel", stop, { passive: true });
    el.addEventListener("pointerdown", stop);
    // ponytail: 2s ceiling — long enough for images to settle, short enough
    // that it can't outlive the user's first interaction with the panel.
    const t = setTimeout(stop, 2000);
    return () => { clearTimeout(t); stop(); el.removeEventListener("wheel", stop); el.removeEventListener("pointerdown", stop); };
  }, [chats.activeId]);

  const patchAssistant = useCallback((fn: (m: ChatMessage) => ChatMessage) => {
    setMessages((prev) => {
      const idx = [...prev].reverse().findIndex((m) => m.role === "assistant");
      if (idx === -1) return prev;
      const realIdx = prev.length - 1 - idx;
      const copy = [...prev];
      copy[realIdx] = fn(copy[realIdx]);
      return copy;
    });
  }, []);

  const handleEvent = useCallback((ev: ServerEvent) => {
    switch (ev.type) {
      case "session":
        sessionIdRef.current = ev.sessionId;
        break;
      case "text":
        patchAssistant((m) => ({ ...m, text: (m.text ? m.text + "\n" : "") + ev.text }));
        break;
      case "tool_use":
        if (GEN_TOOLS.has(ev.tool)) {
          patchAssistant((m) => ({ ...m, gens: [...m.gens, { id: ev.id, tool: ev.tool, status: "running" }] }));
        }
        break;
      case "tool_result":
        patchAssistant((m) => ({
          ...m,
          gens: m.gens.map((g) =>
            g.id === ev.id
              ? { ...g, status: ev.isError ? "failed" : "ready", url: extractUrl(ev.text), error: ev.isError ? ev.text : undefined }
              : g,
          ),
        }));
        break;
      case "done":
        if (ev.sessionId) sessionIdRef.current = ev.sessionId;
        if (ev.result) patchAssistant((m) => (m.text.trim() ? m : { ...m, text: ev.result }));
        break;
      case "error":
        patchAssistant((m) => ({ ...m, error: ev.message }));
        break;
      default:
        break;
    }
  }, [patchAssistant]);

  const handlePickFile = useCallback(() => fileInputRef.current?.click(), []);

  const handleFileChosen = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    if (!file.type.startsWith("image/")) return;
    if (file.size > 10 * 1024 * 1024) return; // 10MB, matches /api/upload-to-fal
    const id = `up-${Date.now()}-${msgSeq++}`;
    const preview = URL.createObjectURL(file);
    // Optimistic chip while the upload is in flight.
    setUploads((prev) => [...prev, { id, url: "", preview, label: file.name, source: "upload", uploading: true }]);
    // Track the upload promise so send() can await it — a reference must never
    // be dropped just because its upload hadn't finished when the user hit send.
    const p = (async (): Promise<string | null> => {
      try {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch("/api/upload-to-fal", { method: "POST", credentials: "include", body: form });
        if (!res.ok) throw new Error(`upload failed (${res.status})`);
        const data = (await res.json()) as { url?: string };
        if (!data.url) throw new Error("no url");
        setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, url: data.url!, uploading: false } : u)));
        return data.url;
      } catch {
        URL.revokeObjectURL(preview);
        setUploads((prev) => prev.filter((u) => u.id !== id));
        return null;
      }
    })();
    pendingUploadsRef.current.push(p);
  }, []);

  /** Pinned instruction docs. They live in the one skill library (so they also
   *  show up in the Skills panel) and the server inlines them into every run's
   *  system prompt. */
  const refreshPins = useCallback(async () => {
    try {
      const res = await fetch("/api/skills", { credentials: "include" });
      const data = (await res.json()) as { skills?: { slug: string; title: string; pinned?: boolean }[] };
      setPins((data.skills ?? []).filter((s) => s.pinned).map((s) => ({ slug: s.slug, title: s.title })));
    } catch { /* panel still works without the list */ }
  }, []);

  useEffect(() => { void refreshPins(); }, [refreshPins]);

  const handlePickDoc = useCallback(() => docInputRef.current?.click(), []);

  const handleDocChosen = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    // ponytail: 200KB ceiling — the whole doc is inlined into every run's
    // system prompt. Raise it only alongside the server-side cap.
    if (file.size > 200 * 1024) { setPinError("That file is too big to pin (200KB max)."); return; }
    setPinError("");
    try {
      const body = await file.text();
      const slug = slugFrom(body, file.name.replace(/\.mdx?$/i, ""));
      const put = await fetch(`/api/skills/${slug}`, {
        method: "PUT", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (!put.ok) throw new Error(((await put.json()) as { error?: string }).error || "save failed");
      const pin = await fetch(`/api/skills/${slug}/pin`, {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pinned: true }),
      });
      if (!pin.ok) throw new Error("pin failed");
      await refreshPins();
    } catch (err) {
      setPinError(err instanceof Error ? err.message : String(err));
    }
  }, [refreshPins]);

  const unpin = useCallback(async (slug: string) => {
    setPins((prev) => prev.filter((p) => p.slug !== slug));
    try {
      await fetch(`/api/skills/${slug}/pin`, {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pinned: false }),
      });
    } finally { void refreshPins(); }
  }, [refreshPins]);

  const removeAttachment = useCallback((att: Attachment) => {
    if (att.source === "upload") {
      setUploads((prev) => {
        const gone = prev.find((u) => u.id === att.id);
        if (gone?.preview?.startsWith("blob:")) URL.revokeObjectURL(gone.preview);
        return prev.filter((u) => u.id !== att.id);
      });
    } else {
      setDismissedCanvasRefs((prev) => new Set(prev).add(att.id));
    }
  }, []);

  const send = useCallback(async () => {
    const message = input.trim();
    if (!message) return;
    // Interrupt, don't refuse. Aborting the fetch closes the SSE stream, and the
    // route kills the `claude` child on close — so this is a real interrupt of
    // the CLI, not just the UI letting go of it. The dying run's `finally` is
    // guarded below so it can't switch off the run replacing it.
    if (streaming) abortRef.current?.abort();
    setInput("");
    // `/login` is the only command the panel answers itself: connecting is an
    // OS dialog (subscription sign-in + MCP registration), not a prompt to
    // forward to Claude — and it's the first thing an unconnected user types.
    if (message.toLowerCase() === "/login") {
      const bridge = desktopBridge();
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: "user", text: message, streaming: false, gens: [] },
        {
          id: nextId(),
          role: "assistant",
          text: bridge?.connectToClaude
            ? "Opening the Claude connection dialog. It signs in with the Claude subscription you already have — no API key, no token."
            : "`/login` only works in the desktop app. In the browser build, install Claude Code and run `claude` once in a terminal to sign in.",
          streaming: false,
          gens: [],
        },
      ]);
      await bridge?.connectToClaude?.();
      void refreshStatus();
      return;
    }
    // Held so the finally can patch THIS run's bubble. patchAssistant targets the
    // last assistant message, which after an interrupt is the new turn's — the
    // dying run would otherwise switch off its replacement's thinking pill.
    const assistantId = nextId();
    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: "user", text: message, streaming: false, gens: [] },
      { id: assistantId, role: "assistant", text: "", streaming: true, gens: [] },
    ]);
    setStreaming(true);
    const ac = new AbortController();
    abortRef.current = ac;
    let ctx: { canvasId?: string; viewport?: { cx: number; cy: number; w: number; h: number } } = {};
    try { ctx = getCanvasContext?.() || {}; } catch { /* canvas not ready */ }
    // Wait for any in-flight uploads so their references are never dropped.
    const uploadedUrls = (await Promise.allSettled(pendingUploadsRef.current))
      .map((r) => (r.status === "fulfilled" ? r.value : null))
      .filter((u): u is string => !!u);
    pendingUploadsRef.current = [];
    const canvasUrls = canvasChips.map((c) => c.url);
    const referenceUrls = Array.from(new Set([...uploadedUrls, ...canvasUrls])).slice(0, MAX_REFS);
    // Inherit the selected canvas image's aspect ratio so the new generation
    // keeps the lineage (unless the user asks for a different shape — Claude
    // decides that from the wording; this is just the default).
    const referenceAspectRatio = canvasChips.find((c) => c.aspectRatio)?.aspectRatio;
    // Uploads are consumed by this turn; canvas chips keep tracking the selection.
    setUploads((prev) => {
      prev.forEach((u) => { if (u.preview.startsWith("blob:")) URL.revokeObjectURL(u.preview); });
      return [];
    });
    try {
      const res = await fetch("/api/operator/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          message,
          sessionId: sessionIdRef.current,
          model: model || undefined,
          effort: EFFORT_LEVELS[effortIndex]?.id,
          canvasId: ctx.canvasId,
          viewport: ctx.viewport,
          referenceUrls: referenceUrls.length > 0 ? referenceUrls : undefined,
          referenceAspectRatio,
        }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const txt = await res.text().catch(() => "");
        handleEvent({ type: "error", message: txt || `Request failed (${res.status})` });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          for (const line of frame.split("\n")) {
            const trimmed = line.startsWith("data:") ? line.slice(5).trim() : "";
            if (!trimmed) continue;
            try { handleEvent(JSON.parse(trimmed) as ServerEvent); } catch { /* keep-alive */ }
          }
        }
      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        handleEvent({ type: "error", message: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      // Only the run that still owns the controller may clear the busy state —
      // an interrupted run finishes AFTER its replacement has already started.
      setMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, streaming: false } : m));
      if (abortRef.current === ac) {
        setStreaming(false);
        abortRef.current = null;
      }
    }
  }, [input, streaming, refreshStatus, model, effortIndex, handleEvent, patchAssistant, canvasChips, getCanvasContext]);

  const changeModel = useCallback((value: string) => {
    setModel(value);
    try { localStorage.setItem(MODEL_STORAGE_KEY, value); } catch { /* ignore */ }
  }, []);

  const changeEffort = useCallback((value: number) => {
    setEffortIndex(value);
    try { localStorage.setItem(EFFORT_STORAGE_KEY, String(value)); } catch { /* ignore */ }
  }, []);

  // Dismiss the effort popover on outside click or Escape.
  useEffect(() => {
    if (!effortOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!effortWrapRef.current?.contains(e.target as Node)) setEffortOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setEffortOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [effortOpen]);

  // Seed the composer from outside (Skills → "use with the agent"). Keyed on the
  // nonce, not the text, so handing over the same skill twice still lands.
  useEffect(() => {
    if (!seedPrompt?.text) return;
    setInput(seedPrompt.text);
    textareaRef.current?.focus();
  }, [seedPrompt?.nonce, seedPrompt?.text]);

  // Persisted mid-stream, throttled. Saving only at turn boundaries meant a
  // reload during a long agent run — exactly when the user is most likely to
  // reload, because the canvas looks stale — dropped the whole thread, and an
  // empty store also greys out the history button that would have restored it.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const commitChats = useCallback(() => {
    setChats((prev) => {
      const id = chatIdRef.current;
      const msgs = messagesRef.current;
      const rest = prev.sessions.filter((s) => s.id !== id);
      const next: ChatStore = msgs.length
        ? {
            activeId: id,
            sessions: [
              { id, title: chatTitle(msgs), sessionId: sessionIdRef.current, messages: msgs.slice(-CHAT_MAX_MESSAGES), updatedAt: Date.now() },
              ...rest,
            ].slice(0, CHAT_MAX_SESSIONS)
          }
        // An empty draft must never erase what's stored: only switch the
        // pointer. Deleting is an explicit user action (deleteChat).
        : { activeId: id, sessions: prev.sessions };
      saveChats(next);
      return next;
    });
  }, []);

  // Throttle, not debounce: a debounce whose timer resets on every token would
  // never fire during a fast stream, which is the case that loses the thread.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); }, []);
  useEffect(() => {
    if (!streaming) {
      if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
      commitChats();
      return;
    }
    if (saveTimerRef.current) return;
    saveTimerRef.current = setTimeout(() => { saveTimerRef.current = null; commitChats(); }, CHAT_SAVE_THROTTLE_MS);
  }, [messages, streaming, commitChats]);

  const stop = useCallback(() => { abortRef.current?.abort(); }, []);
  const newChat = useCallback(() => {
    if (streaming) return;
    setHistoryOpen(false);
    chatIdRef.current = newChatId();
    setMessages([]);
    sessionIdRef.current = undefined;
    setUploads((prev) => {
      prev.forEach((u) => { if (u.preview.startsWith("blob:")) URL.revokeObjectURL(u.preview); });
      return [];
    });
    setDismissedCanvasRefs(new Set());
  }, [streaming]);

  /** Switch threads. The save effect has already stored the outgoing one.
   *  A turn in flight is aborted rather than blocking the switch — a run that
   *  never finishes used to lock the user out of their own history. */
  const openChat = useCallback((id: string) => {
    const s = chats.sessions.find((x) => x.id === id);
    if (!s) return;
    if (streaming) { commitChats(); abortRef.current?.abort(); }
    setHistoryOpen(false);
    chatIdRef.current = s.id;
    sessionIdRef.current = s.sessionId;
    setMessages(s.messages);
    setChats((prev) => { const next = { ...prev, activeId: s.id }; saveChats(next); return next; });
  }, [chats.sessions, streaming, commitChats]);

  // Back / forward walk the thread list (newest first), so ← is "older".
  const chatIndex = chats.sessions.findIndex((s) => s.id === chatIdRef.current);
  const step = useCallback((delta: number) => {
    const i = chats.sessions.findIndex((s) => s.id === chatIdRef.current);
    const target = chats.sessions[(i < 0 ? -1 : i) + delta];
    if (target) openChat(target.id);
  }, [chats.sessions, openChat]);

  const deleteChat = useCallback((id: string) => {
    setChats((prev) => { const next = { ...prev, sessions: prev.sessions.filter((s) => s.id !== id) }; saveChats(next); return next; });
    if (id === chatIdRef.current) newChat();
  }, [newChat]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
  };

  const ready = status?.binaryFound === true;
  const aliveLabel = streaming ? "Claude is thinking" : "Claude is online";

  return (
    <aside className="agent-panel">
      <div className="agent-panel__header agent-panel__header--with-alive">
        <div
          className={`agent-panel__alive${streaming ? " agent-panel__alive--busy" : ""}`}
          aria-label={aliveLabel}
          title={streaming ? "Claude is thinking…" : "Claude is online"}
        >
          <ClaudePixel size={28} thinking={streaming} ariaLabel="Claude" />
        </div>
        <div className="operator-brand">
          <span className="operator-brand__name">Claude</span>
        </div>
        <div className="agent-panel__header-actions">
          <button
            type="button"
            className="agent-panel__new agent-panel__new--icon"
            onClick={() => step(1)}
            disabled={chatIndex < 0 || chatIndex >= chats.sessions.length - 1}
            aria-label="Older chat"
            title="Older chat"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <button
            type="button"
            className="agent-panel__new agent-panel__new--icon"
            onClick={() => step(-1)}
            disabled={chatIndex <= 0}
            aria-label="Newer chat"
            title="Newer chat"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
          <button
            type="button"
            className={`agent-panel__new agent-panel__new--icon${historyOpen ? " agent-panel__new--on" : ""}`}
            onClick={() => setHistoryOpen((v) => !v)}
            disabled={chats.sessions.length === 0}
            aria-label="Chat history"
            title="Chat history"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15 14" />
            </svg>
          </button>
          <button
            type="button"
            className="agent-panel__new agent-panel__new--icon"
            onClick={newChat}
            disabled={messages.length === 0 || streaming}
            aria-label="New chat"
            title="New chat"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <button type="button" className="agent-panel__close" onClick={onClose} aria-label="Close" title="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {historyOpen && (
        <div className="operator-history">
          {chats.sessions.map((s) => (
            <div key={s.id} className={`operator-history__row${s.id === chatIdRef.current ? " operator-history__row--active" : ""}`}>
              <button type="button" className="operator-history__open" onClick={() => openChat(s.id)}>
                <span className="operator-history__title">{s.title}</span>
                <span className="operator-history__meta">{new Date(s.updatedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · {s.messages.length} messages</span>
              </button>
              <button type="button" className="operator-history__del" onClick={() => deleteChat(s.id)} aria-label="Delete chat" title="Delete chat">×</button>
            </div>
          ))}
        </div>
      )}

      {!ready ? (
        <div className="agent-panel__messages">
          <div className="agent-panel__hero">
            <h1 className="agent-panel__hero-title">Install Claude Code</h1>
            <p className="agent-panel__hero-sub">Matte runs on your Claude subscription — no API key, no token to copy.</p>
            <ol className="operator-setup__steps">
              <li>Install <a href="https://claude.com/code" target="_blank" rel="noreferrer">Claude Code</a>.</li>
              <li>Run <code>claude</code> once and sign in to your subscription.</li>
              <li>Come back and type <code>/login</code> here.</li>
            </ol>
            <button type="button" className="agent-panel__hero-signin" onClick={() => { void refreshStatus(); }}>
              Check again
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></svg>
            </button>
          </div>
        </div>
      ) : (
        <div className="agent-panel__messages" ref={scrollRef}>
          {messages.length === 0 ? (
            <div className="agent-panel__hero">
              <h1 className="agent-panel__hero-title">Let's make something amazing together.</h1>
              <p className="agent-panel__hero-sub">Pick a starting point — or describe it yourself.</p>
              <div className="agent-panel__hero-grid">
                {HERO_CARDS.map((card) => (
                  <button
                    key={card.label}
                    type="button"
                    className="agent-panel__hero-card"
                    onClick={() => { setInput(card.prompt); textareaRef.current?.focus(); }}
                  >
                    <span className="agent-panel__hero-card-icon">{card.icon}</span>
                    <span className="agent-panel__hero-card-label">{card.label}</span>
                    <span className="agent-panel__hero-card-desc">{card.desc}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m) => {
              const isUser = m.role === "user";
              const hasText = !!m.text.trim();
              const showBubble = hasText || (m.streaming && m.gens.length === 0);
              return (
                <div key={m.id} className={`agent-panel__msg agent-panel__msg--${isUser ? "user" : "assistant"}`}>
                  {showBubble && (
                    <div className="agent-panel__bubble">
                      {isUser ? (
                        m.text
                      ) : m.streaming && !hasText ? (
                        <ThinkingPill className="agent-panel__thinking" size={20} />
                      ) : (
                        <>
                          <div className="agent-panel__markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }} />
                          {m.streaming && <ThinkingPill size={18} className="agent-panel__thinking agent-panel__thinking--inline" />}
                        </>
                      )}
                    </div>
                  )}
                  {m.gens.length > 0 && (
                    <div className="agent-panel__gens">
                      {m.gens.map((g) => (
                        <div key={g.id} className={`agent-gen agent-gen--on-canvas agent-gen--${g.status}`}>
                          <div className={`agent-gen__placed-chip ${g.status === "failed" ? "agent-gen__placed-chip--failed" : ""}`}>
                            {g.status === "running" ? (
                              <QuantumThinking size={14} ariaLabel="Generating" />
                            ) : (
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="1.5" /></svg>
                            )}
                            {g.status === "running" ? "Generating on canvas…" : g.status === "failed" ? (g.error?.slice(0, 60) || "Failed") : "Placed on canvas"}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {m.error && <div className="agent-panel__bubble agent-panel__bubble--error">{m.error}</div>}
                </div>
              );
            })
          )}
        </div>
      )}

      {ready && (
        <div className="agent-panel__composer">
          {attachments.length > 0 && (
            <div className="agent-panel__refs">
              {attachments.map((att) => (
                <div
                  key={att.id}
                  className={`agent-panel__ref${att.source === "canvas" ? " agent-panel__ref--agent" : ""}${att.uploading ? " operator-ref--uploading" : ""}`}
                  style={{ backgroundImage: `url(${att.preview})`, backgroundSize: "cover" }}
                  title={att.label}
                >
                  {att.uploading && <span className="operator-ref__spinner"><QuantumThinking size={16} ariaLabel="Uploading" /></span>}
                  <button
                    type="button"
                    className="agent-panel__ref-x"
                    aria-label={`Remove ${att.label}`}
                    onClick={() => removeAttachment(att)}
                  >×</button>
                </div>
              ))}
            </div>
          )}
          {(pins.length > 0 || pinError) && (
            <div className="agent-panel__pins">
              {pinError && <span className="agent-panel__pin agent-panel__pin--error">{pinError}</span>}
              {pins.map((p) => (
                <span key={p.slug} className="agent-panel__pin" title={`${p.title} — applied to every message`}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <line x1="12" y1="17" x2="12" y2="22" /><path d="M9 2h6l-1 8 4 3v2H6v-2l4-3z" />
                  </svg>
                  {p.title}
                  <button type="button" className="agent-panel__ref-x" aria-label={`Unpin ${p.title}`} onClick={() => void unpin(p.slug)}>×</button>
                </span>
              ))}
            </div>
          )}
          <div className={`agent-panel__textarea-wrap${streaming ? " agent-panel__textarea-wrap--generating" : ""}`}>
            <div className="agent-panel__glow agent-panel__glow--sharp" aria-hidden="true" />
            <div className="agent-panel__glow-blur" aria-hidden="true"><div className="agent-panel__glow agent-panel__glow--soft" /></div>
            <textarea
              ref={textareaRef}
              className="agent-panel__textarea"
              placeholder={ready ? "Describe what you want to create.." : "Type /login to connect Claude"}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={4}
            />
            {/* Attach-image (+) button, bottom-left inside the pill. */}
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
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
            {/* Pin an instructions .md — saved into the skill library and
              * appended to the operator's system prompt on every run. */}
            <input
              ref={docInputRef}
              type="file"
              accept=".md,.markdown,.mdx,text/markdown"
              className="agent-panel__file-input"
              onChange={(e) => void handleDocChosen(e)}
              tabIndex={-1}
              aria-hidden="true"
            />
            <button
              type="button"
              className="agent-panel__upload agent-panel__upload--doc"
              onClick={handlePickDoc}
              aria-label="Pin instructions markdown"
              title="Pin an instructions .md"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="12" y1="17" x2="12" y2="22" /><path d="M9 2h6l-1 8 4 3v2H6v-2l4-3z" />
              </svg>
            </button>
            {/* Send/stop lives INSIDE the pill (textarea-wrap is position:relative)
              * so it nestles into the rounded corner. */}
            {streaming && !input.trim() ? (
              <button type="button" className="agent-panel__send agent-panel__send--stop" onClick={stop} aria-label="Stop" title="Stop">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2" /></svg>
              </button>
            ) : (
              <button type="button" className="agent-panel__send" disabled={!input.trim()} onClick={() => void send()} aria-label="Send" title="Send">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="12" y1="19" x2="12" y2="5" /><polyline points="6 11 12 5 18 11" /></svg>
              </button>
            )}
          </div>

          {/* Model + effort, under the composer, laid out like Claude Code's own
            * footer: plain model select, then an effort chip that opens the
            * slider popover. Effort is a slider because it's an intensity, not a
            * choice between unrelated things. */}
          <div className="operator-controls" ref={effortWrapRef}>
            <select
              className="operator-controls__model"
              value={model}
              onChange={(e) => changeModel(e.target.value)}
              disabled={streaming}
              title="Model Claude uses to operate"
              aria-label="Operator model"
            >
              {OPERATOR_MODELS.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>

            <button
              type="button"
              className="operator-effort-chip"
              onClick={() => setEffortOpen((v) => !v)}
              disabled={streaming}
              aria-expanded={effortOpen}
              aria-haspopup="dialog"
              title={`Effort: ${EFFORT_LEVELS[effortIndex].label}`}
            >
              {EFFORT_LEVELS[effortIndex].label}
            </button>

            {effortOpen && (
              <div className="operator-effort-pop" role="dialog" aria-label="Effort">
                <div className="operator-effort-pop__head">
                  <span className="operator-effort-pop__title">Effort</span>
                  <span
                    className={`operator-effort-pop__level${
                      effortIndex === EFFORT_LEVELS.length - 1 ? " is-max" : ""
                    }`}
                  >
                    {EFFORT_LEVELS[effortIndex].label}
                  </span>
                  <span
                    className="operator-effort-pop__help"
                    title="How long Claude may think before answering. Higher is slower but more thorough — and costs nothing extra on your subscription."
                    aria-hidden="true"
                  >
                    ?
                  </span>
                </div>
                <div className="operator-effort-pop__ends">
                  <span>Faster</span>
                  <span>Smarter</span>
                </div>
                <div
                  className={`operator-effort-pop__slider${
                    effortIndex === EFFORT_LEVELS.length - 1 ? " is-max" : ""
                  }`}
                  style={{
                    ["--fill" as string]: `${(effortIndex / (EFFORT_LEVELS.length - 1)) * 100}%`,
                  }}
                >
                  <div className="operator-effort-pop__track">
                    <div className="operator-effort-pop__fill" />
                    {/* The ramp belongs to the top tier only, and fills in when you
                      * reach it — arriving at Ultra Gen should feel like arriving
                      * somewhere, not like one more notch. */}
                    <EffortDither active={effortIndex === EFFORT_LEVELS.length - 1} />
                    <div className="operator-effort-pop__ticks" aria-hidden="true">
                      {EFFORT_LEVELS.map((lvl, i) => (
                        <span
                          key={lvl.id}
                          className={`operator-effort-pop__tick${
                            i === EFFORT_LEVELS.length - 1 ? " is-max" : ""
                          }`}
                          style={{ left: `${(i / (EFFORT_LEVELS.length - 1)) * 100}%` }}
                        />
                      ))}
                    </div>
                  </div>
                  <input
                    className="operator-effort-pop__range"
                    type="range"
                    min={0}
                    max={EFFORT_LEVELS.length - 1}
                    step={1}
                    value={effortIndex}
                    onChange={(e) => changeEffort(Number(e.target.value))}
                    aria-label="Effort"
                    aria-valuetext={EFFORT_LEVELS[effortIndex].label}
                    autoFocus
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
