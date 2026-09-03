import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { QuantumThinking } from "./QuantumThinking";
import { ClaudePixel } from "./ClaudePixel";
import { CodexMark } from "./CodexMark";
import { ThinkingPill } from "./ThinkingPill";
import { humanizeTool, stepLabel, type Step } from "./thinkingLabel";
import { StreamingText } from "./StreamingText";
import { renderMarkdown } from "../utils/markdown";
import type { ReferenceImage, PickedElement } from "../types/canvas";
import { desktopBridge } from "../desktop";
import { useAuth } from "../contexts/AuthContext";
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

type OperatorModel = { id: string; label: string };
type OperatorStatus = {
  binaryFound: boolean; binaryPath: string; runner?: string;
  runners?: { id: string; label: string; models?: OperatorModel[] }[];
};

const GEN_TOOLS = new Set(["generate_media", "generate_music", "transform_media"]);

// Fallback until /api/operator/status reports the active runner's models.
const OPERATOR_MODELS: OperatorModel[] = [{ id: "claude-opus-5", label: "Opus 5" }];
// Per-runner key so switching Claude ↔ Codex remembers each side's pick.
const modelStorageKey = (runner = "claude") => `mb-operator-model-v4:${runner}`;

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
/** Default to Medium: High made every turn think hard, and HTML art re-renders free in 90ms. */
const DEFAULT_EFFORT = 1;
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

const STEP_LABELS: Record<string, (input: Record<string, unknown>) => string> = {
  list_skills: () => "Searching skills",
  get_skill: (i) => `Reading skill: ${i.slug ?? i.name ?? ""}`,
  save_skill: (i) => `Saving skill: ${i.slug ?? i.name ?? ""}`,
  patch_skill: (i) => `Improving skill: ${i.slug ?? ""}`,
  recall: () => "Recalling memory",
  remember: (i) => `Remembering: ${i.slug ?? i.title ?? ""}`,
  forget: (i) => `Forgetting: ${i.slug ?? ""}`,
  list_canvas: () => "Checking canvas",
  search_fal_models: (i) => `Searching fal: ${i.query ?? i.q ?? ""}`,
  save_asset: (i) => `Saving to ${i.path ?? "Downloads"}`,
  higgsfield: (i) => `Higgsfield: ${Array.isArray(i.args) ? (i.args as string[]).slice(0, 3).join(" ") : ""}`,
  schedule_job: (i) => `Scheduling: ${i.name ?? ""}`,
  list_jobs: () => "Checking scheduled runs",
  delete_job: () => "Deleting scheduled run",
};

/** Expandable reasoning blocks only. Tool calls used to render here as a chip
 * row above the bubble; they now drive the Thinking pill's label instead —
 * one live line saying what the agent is doing, not a growing list. */
function Steps({ steps }: { steps: Step[] }) {
  const thinking = steps.filter((st) => st.kind === "thinking");
  if (thinking.length === 0) return null;
  return (
    <div className="agent-panel__steps">
      {thinking.map((st) => (
        <details key={st.id} className="agent-step agent-step--thinking">
          <summary>Thinking</summary>
          <div className="agent-step__text">{st.kind === "thinking" ? st.text : ""}</div>
        </details>
      ))}
    </div>
  );
}

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  streaming: boolean;
  gens: Gen[];
  steps?: Step[];
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
type ChatSession = { id: string; title: string; sessionId?: string; messages: ChatMessage[]; updatedAt: number;
  /** Which project this thread belongs to. Threads are scoped so switching
   *  project switches the agent's context with it — one canvas's conversation
   *  is noise in another. Undefined only on threads written before scoping;
   *  those are adopted by whichever project is open when they're first seen. */
  projectId?: string;
  /** Archived threads stay in the store but leave the panel: they're hidden
   *  from the scoped list (and so from the activity grid and the empty-state
   *  card) and only surface under History's Archived filter. */
  archived?: boolean };
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
  | { type: "thinking"; text: string }
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


/** Local midnight for a timestamp, as a day key. */
function dayKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * Three months of activity, laid out the way GitHub's is: one column per week,
 * Sunday at the top, newest week on the right. Pared back to the grid, the
 * month ticks, and a legend — no weekday labels, no headline count.
 *
 * "Local history" is the chat store: one thread touched on a day is one square.
 * ponytail: a session carries a single updatedAt, so a thread worked on across
 * three days only lights the last one. Store per-message timestamps if that
 * ever matters more than the shape of the quarter.
 */
/** A full year, wider than the panel — the card scrolls, pinned to today. */
const GRID_WEEKS = 53;

type Cell = { key: string; count: number; label: string } | null;

function activityGrid(sessions: { updatedAt: number }[]): { cells: Cell[]; months: string[] } {
  const counts = new Map<string, number>();
  for (const s of sessions) counts.set(dayKey(s.updatedAt), (counts.get(dayKey(s.updatedAt)) || 0) + 1);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // Back to the Sunday that opens the oldest week shown, so every column is a
  // whole Sun-Sat week and a row means the same weekday all the way across.
  const start = new Date(today);
  start.setDate(start.getDate() - today.getDay() - (GRID_WEEKS - 1) * 7);

  const cells: Cell[] = [];
  const months: string[] = [];
  // A tick sits above the first week that opens in a new month — but a name is
  // three columns wide, so one that would land on top of the previous tick is
  // dropped rather than drawn over it.
  let lastTick = -3;
  for (let w = 0; w < GRID_WEEKS; w++) {
    const first = new Date(start);
    first.setDate(start.getDate() + w * 7);
    const prev = new Date(start);
    prev.setDate(start.getDate() + (w - 1) * 7);
    const newMonth = w > 0 && first.getMonth() !== prev.getMonth();
    if (newMonth && w - lastTick >= 3) {
      months.push(first.toLocaleDateString(undefined, { month: "short" }));
      lastTick = w;
    } else {
      months.push("");
    }

    for (let d = 0; d < 7; d++) {
      const day = new Date(start);
      day.setDate(start.getDate() + w * 7 + d);
      // Days that haven't happened yet hold their slot but stay blank.
      if (day.getTime() > today.getTime()) { cells.push(null); continue; }
      const k = dayKey(day.getTime());
      const count = counts.get(k) || 0;
      const when = day.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      cells.push({ key: k, count, label: `${count || "No"} session${count === 1 ? "" : "s"} on ${when}` });
    }
  }
  return { cells, months };
}

let msgSeq = 0;
const nextId = () => `op-${Date.now()}-${msgSeq++}`;

type PanelMode = "sessions" | "bots";
/** A named, persistent collaborator: its own durable memory, its own face, and
 *  a brief it works to. Budget is recorded server-side only; nothing spends
 *  against it yet, and it is no longer asked for up front. */
type Bot = { id: string; name: string; budgetCents: number; icon?: string; description?: string };

/** The icon set. Emoji rather than bespoke artwork: it renders everywhere, needs
 *  no asset pipeline, and the user picks a face in one tap. */
const BOT_ICONS = [
  "🤖", "👾", "🧠", "🪄", "🎬", "🎨", "📷", "🎧",
  "✨", "🔮", "🚀", "📈", "🗞", "🧵", "🌱", "🐙",
  "🦊", "🐝", "🦉", "🐳", "🍊", "🌊", "🔥", "🌙",
];

/** A stable tint per bot, so two bots with the same emoji still read apart.
 *  Hue off the id, not a stored column — one less thing to pick. */
function botTint(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return `hsl(${h} 70% 62%)`;
}

const MODE_STORAGE_KEY = "matteblack.operator.mode";
const BOT_STORAGE_KEY = "matteblack.operator.botId";

export function OperatorPanel({
  onClose,
  onBusyChange,
  getCanvasContext,
  canvasReferenceImages,
  seedPrompt,
  projectId,
  projects,
}: {
  onClose: () => void;
  onBusyChange?: (busy: boolean) => void;
  // Supplies the canvas the user has open + their current viewport (world
  // coords), captured at send time so operator generations land on-screen.
  getCanvasContext?: () => { canvasId?: string; viewport?: { cx: number; cy: number; w: number; h: number }; selectedNodeIds?: string[]; selectedElements?: PickedElement[] };
  // The image(s) currently selected on the canvas — shown as removable chips in
  // the composer and sent as the generation reference (→ fal img2img).
  canvasReferenceImages?: ReferenceImage[];
  /** Text dropped into the composer from elsewhere (e.g. the Skills panel).
   *  Carries a nonce so sending the same text twice still re-seeds. */
  seedPrompt?: { text: string; nonce: number } | null;
  /** The open project. Threads are filtered and stamped with it. */
  projectId?: string;
  /** Every project in the workspace — History groups threads under their names. */
  projects?: { id: string; name: string }[];
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
  const [model, setModel] = useState<string>(OPERATOR_MODELS[0].id);
  const runner = status?.runner ?? "claude";
  const models = status?.runners?.find((r) => r.id === runner)?.models ?? OPERATOR_MODELS;
  // Runner (re)loaded → restore that runner's saved pick, else its default.
  useEffect(() => {
    let v = "";
    try { v = localStorage.getItem(modelStorageKey(runner)) || ""; } catch { /* ignore */ }
    setModel(models.some((m) => m.id === v) ? v : models[0].id);
  }, [runner, models]);
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
  const [showArchived, setShowArchived] = useState(false);
  const [pins, setPins] = useState<{ slug: string; title: string }[]>([]);
  const [pinError, setPinError] = useState("");
  const chatIdRef = useRef<string>(chats.activeId);
  // Sessions | Bots. A session is a chat thread on the open project, sharing
  // the one agent memory; a bot is a named collaborator with its own durable
  // memory and budget. Both use the same thread store — a bot's threads are
  // keyed by its id exactly as a project's are keyed by the project's.
  const [mode, setMode] = useState<PanelMode>(() => {
    try { return localStorage.getItem(MODE_STORAGE_KEY) === "bots" ? "bots" : "sessions"; } catch { return "sessions"; }
  });
  const [bots, setBots] = useState<Bot[]>([]);
  const [botId, setBotId] = useState<string>(() => {
    try { return localStorage.getItem(BOT_STORAGE_KEY) || ""; } catch { return ""; }
  });
  const [newBotOpen, setNewBotOpen] = useState(false);
  const [newBotName, setNewBotName] = useState("");
  const [newBotDesc, setNewBotDesc] = useState("");
  const [newBotIcon, setNewBotIcon] = useState(BOT_ICONS[0]);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [botError, setBotError] = useState("");
  const activeBot = bots.find((b) => b.id === botId);

  // Everything the user navigates — history list, back/forward, the activity
  // grid, the "last chat" card — reads this, not the raw store. Writes still
  // go through the whole store so another project's threads survive.
  // In Bots mode the scope is the bot rather than the project, so switching to
  // a bot swaps in that bot's conversations and nothing else. "bot:" prefixed
  // so a bot's scope can never collide with a project id.
  const pid = mode === "bots" ? `bot:${botId || "none"}` : projectId || undefined;
  const sessions = useMemo(
    () => chats.sessions.filter((s) => s.projectId === pid && !s.archived),
    [chats.sessions, pid],
  );
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
      if (res.ok) { setStatus(await res.json()); return true; }
    } catch { /* offline */ }
    return false;
  }, []);
  // Boot: the server may still be coming up; retry until it answers so a
  // logged-in user never sees the install gate on restart.
  useEffect(() => {
    let alive = true;
    (async () => { for (let i = 0; i < 20 && alive; i++) { if (await refreshStatus()) return; await new Promise((r) => setTimeout(r, 500)); } })();
    return () => { alive = false; };
  }, [refreshStatus]);

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
      case "thinking":
        patchAssistant((m) => ({ ...m, steps: [...(m.steps ?? []), { id: `${ev.text.length}-${(m.steps ?? []).length}`, kind: "thinking", text: ev.text }] }));
        break;
      case "tool_use":
        if (GEN_TOOLS.has(ev.tool)) {
          patchAssistant((m) => ({ ...m, gens: [...m.gens, { id: ev.id, tool: ev.tool, status: "running" }] }));
        } else {
          // Every non-generation tool gets a line. STEP_LABELS phrases the ones
          // worth phrasing; anything else falls back to its own name, so a tool
          // added later still narrates instead of silently reading "Thinking…".
          const input = (ev.input && typeof ev.input === "object" ? ev.input : {}) as Record<string, unknown>;
          const label = STEP_LABELS[ev.tool] ? STEP_LABELS[ev.tool](input) : humanizeTool(ev.tool);
          patchAssistant((m) => ({ ...m, steps: [...(m.steps ?? []), { id: ev.id, kind: "tool", label, status: "running" }] }));
        }
        break;
      case "tool_result":
        patchAssistant((m) => ({
          ...m,
          steps: (m.steps ?? []).map((st) =>
            st.kind === "tool" && st.id === ev.id ? { ...st, status: ev.isError ? "failed" : "ready" } : st,
          ),
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
      let body = await file.text();
      // The chip is named after the file: stamp the file name in as the first
      // frontmatter title, which wins over any title the doc carries itself.
      body = body.startsWith("---\n")
        ? body.replace("---\n", `---\ntitle: ${file.name}\n`)
        : `---\ntitle: ${file.name}\n---\n${body}`;
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

  const send = useCallback(async (override?: string) => {
    // Starter chips pass their text; the composer's onClick passes an event.
    const message = (typeof override === "string" ? override : input).trim();
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
    let ctx: ReturnType<NonNullable<typeof getCanvasContext>> = {};
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
          botId: mode === "bots" && botId ? botId : undefined,
          canvasId: ctx.canvasId,
          viewport: ctx.viewport,
          selectedNodeIds: ctx.selectedNodeIds?.length ? ctx.selectedNodeIds : undefined,
          selectedElements: ctx.selectedElements?.length ? ctx.selectedElements : undefined,
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
  }, [input, streaming, refreshStatus, model, effortIndex, mode, botId, handleEvent, patchAssistant, canvasChips, getCanvasContext]);

  const changeModel = useCallback((value: string) => {
    setModel(value);
    try { localStorage.setItem(modelStorageKey(runner), value); } catch { /* ignore */ }
  }, [runner]);

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
  const pidRef = useRef(pid);
  pidRef.current = pid;
  // The scope of the *open* thread. Usually `pid`, but History can open a
  // thread belonging to another project, and saving it must not silently
  // re-file it under whatever is open now.
  const chatPidRef = useRef(pid);
  const commitChats = useCallback(() => {
    setChats((prev) => {
      const id = chatIdRef.current;
      const msgs = messagesRef.current;
      const rest = prev.sessions.filter((s) => s.id !== id);
      const next: ChatStore = msgs.length
        ? {
            activeId: id,
            // The cap is per project: a global slice would let a busy canvas
            // evict a quiet one's history.
            sessions: [
              { ...prev.sessions.find((s) => s.id === id), id, title: chatTitle(msgs), sessionId: sessionIdRef.current, messages: msgs.slice(-CHAT_MAX_MESSAGES), updatedAt: Date.now(), projectId: chatPidRef.current },
              ...rest.filter((s) => s.projectId === chatPidRef.current),
            ].slice(0, CHAT_MAX_SESSIONS)
              .concat(rest.filter((s) => s.projectId !== chatPidRef.current))
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

  // Switching project swaps the whole conversation. The outgoing thread is
  // already committed by the save effect; we adopt any pre-scoping threads into
  // whatever project is open the first time they're seen, then open this
  // project's most recent thread, or a blank one if it has none yet.
  // null (not undefined) so the very first run always reconciles: the stored
  // activeId can belong to a project other than the one open at mount.
  const prevPidRef = useRef<string | undefined | null>(null);
  useEffect(() => {
    let store = chats;
    // Pre-scoping threads belong to a project, never to a bot: adopt them only
    // while a project is what's open.
    if (mode === "sessions" && store.sessions.some((s) => s.projectId === undefined)) {
      store = { ...store, sessions: store.sessions.map((s) => (s.projectId === undefined ? { ...s, projectId: pid } : s)) };
      saveChats(store);
      setChats(store);
    }
    if (prevPidRef.current === pid) return;
    prevPidRef.current = pid;
    abortRef.current?.abort();
    const mine = store.sessions.filter((s) => s.projectId === pid).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    chatIdRef.current = mine?.id ?? newChatId();
    chatPidRef.current = pid;
    sessionIdRef.current = mine?.sessionId;
    setMessages(mine?.messages ?? []);
    setHistoryOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid]);

  // ── Bots ───────────────────────────────────────────────────────────────────
  const loadBots = useCallback(async () => {
    try {
      const res = await fetch("/api/bots", { credentials: "include" });
      if (!res.ok) return;
      const data = (await res.json()) as { bots?: Bot[] };
      const list = data.bots ?? [];
      setBots(list);
      // A remembered pick that no longer exists (deleted elsewhere) would send a
      // botId the server rejects — drop back to the list rather than silently
      // opening someone else's bot.
      setBotId((prev) => (list.some((b) => b.id === prev) ? prev : ""));
    } catch { /* the panel still works in Sessions mode */ }
  }, []);
  useEffect(() => { void loadBots(); }, [loadBots]);
  useEffect(() => { try { localStorage.setItem(MODE_STORAGE_KEY, mode); } catch { /* ignore */ } }, [mode]);
  useEffect(() => { try { localStorage.setItem(BOT_STORAGE_KEY, botId); } catch { /* ignore */ } }, [botId]);

  const createBot = useCallback(async () => {
    const name = newBotName.trim();
    if (!name) { setBotError("Name your bot."); return; }
    setBotError("");
    try {
      const res = await fetch("/api/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name, icon: newBotIcon, description: newBotDesc.trim() }),
      });
      if (!res.ok) { setBotError("Couldn't create that bot."); return; }
      const { bot } = (await res.json()) as { bot: Bot };
      setBots((prev) => [...prev, bot]);
      setNewBotOpen(false);
      setIconPickerOpen(false);
      setNewBotName("");
      setNewBotDesc("");
      setNewBotIcon(BOT_ICONS[0]);
    } catch { setBotError("Couldn't create that bot."); }
  }, [newBotName, newBotDesc, newBotIcon]);

  const deleteBot = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/bots/${id}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) return;
      setBots((prev) => {
        const next = prev.filter((b) => b.id !== id);
        setBotId((cur) => (cur === id ? next[0]?.id ?? "" : cur));
        return next;
      });
    } catch { /* leave the picker as it was */ }
  }, []);

  const stop = useCallback(() => { abortRef.current?.abort(); }, []);
  const newChat = useCallback(() => {
    if (streaming) return;
    setHistoryOpen(false);
    chatIdRef.current = newChatId();
    chatPidRef.current = pidRef.current;
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
    // Searched across the whole store, not just the open scope: History lists
    // every project's threads, and picking one has to actually open it.
    const s = chats.sessions.find((x) => x.id === id);
    if (!s) return;
    if (streaming) { commitChats(); abortRef.current?.abort(); }
    setHistoryOpen(false);
    chatIdRef.current = s.id;
    chatPidRef.current = s.projectId;
    sessionIdRef.current = s.sessionId;
    setMessages(s.messages);
    setChats((prev) => { const next = { ...prev, activeId: s.id }; saveChats(next); return next; });
  }, [chats.sessions, streaming, commitChats]);

  const { user } = useAuth();
  const firstName = (user?.displayName || "").trim().split(/\s+/)[0] || "";

  // The thread the empty state offers to reopen: the most recently touched one
  // that actually has something in it, and never the blank one being looked at.
  const cardRef = useRef<HTMLDivElement>(null);

  const activity = useMemo(() => activityGrid(sessions), [sessions]);

  /** History is the whole app's threads, not the open scope's: grouped under
   *  the project (or bot) each belongs to, newest group first. */
  const historyGroups = useMemo(() => {
    const label = (key: string | undefined) => {
      if (!key) return "Unassigned";
      if (key.startsWith("bot:")) {
        const b = bots.find((x) => x.id === key.slice(4));
        return b ? `${b.name} (bot)` : "Bot";
      }
      return projects?.find((p) => p.id === key)?.name || "Project";
    };
    const by = new Map<string, { key: string; label: string; items: ChatSession[] }>();
    for (const sn of chats.sessions) {
      if (!!sn.archived !== showArchived) continue;
      if (sn.messages.length === 0) continue;
      const key = sn.projectId ?? "";
      let g = by.get(key);
      if (!g) by.set(key, (g = { key, label: label(sn.projectId), items: [] }));
      g.items.push(sn);
    }
    const groups = [...by.values()];
    for (const g of groups) g.items.sort((a, b) => b.updatedAt - a.updatedAt);
    // The scope the user is in sits on top; everything else by recency.
    groups.sort((a, b) =>
      (a.key === (pid ?? "") ? -1 : 0) - (b.key === (pid ?? "") ? -1 : 0)
      || b.items[0].updatedAt - a.items[0].updatedAt);
    return groups;
  }, [chats.sessions, showArchived, bots, projects, pid]);

  // Own tooltip rather than the native title attribute: title waits about a
  // second before it shows and is easy to miss on an 11px square.
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);

  const lastChat = sessions
    .filter((s) => s.id !== chats.activeId && s.messages.length > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];

  const deleteChat = useCallback((id: string) => {
    setChats((prev) => { const next = { ...prev, sessions: prev.sessions.filter((s) => s.id !== id) }; saveChats(next); return next; });
    if (id === chatIdRef.current) newChat();
  }, [newChat]);

  /** Out of the way, still recoverable — the middle ground between keeping a
   *  finished thread in the list forever and deleting it. */
  const archiveChat = useCallback((id: string, archived: boolean) => {
    setChats((prev) => {
      const next = { ...prev, sessions: prev.sessions.map((s) => (s.id === id ? { ...s, archived } : s)) };
      saveChats(next);
      return next;
    });
    if (archived && id === chatIdRef.current) newChat();
  }, [newChat]);

  // "/" in an otherwise-empty composer opens the skill picker; typing filters it.
  const slashQuery = /^\/(?!login\b)([^\n]*)$/.exec(input)?.[1];
  const [slashSkills, setSlashSkills] = useState<Array<{ slug: string; title: string; description: string; kind?: string }> | null>(null);
  const [slashIdx, setSlashIdx] = useState(0);
  useEffect(() => {
    if (slashQuery === undefined || slashSkills) return;
    fetch("/api/skills", { credentials: "include" }).then((r) => r.json())
      .then((j) => setSlashSkills(j.skills ?? [])).catch(() => setSlashSkills([]));
  }, [slashQuery, slashSkills]);
  const slashHits = slashQuery === undefined ? [] : (slashSkills ?? [])
    .filter((s) => `${s.slug} ${s.title}`.toLowerCase().includes(slashQuery.trim().toLowerCase())).slice(0, 8);
  useEffect(() => { setSlashIdx(0); }, [slashQuery]);
  const pickSlash = (s: { slug: string; title: string }) => {
    setInput(`Use my "${s.title}" skill (slug: ${s.slug}) — read it with get_skill first, then follow it. `);
    textareaRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashHits.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSlashIdx((i) => (i + 1) % slashHits.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSlashIdx((i) => (i - 1 + slashHits.length) % slashHits.length); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickSlash(slashHits[slashIdx]); return; }
      if (e.key === "Escape") { e.preventDefault(); setInput(""); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
  };

  const ready = status?.binaryFound === true;
  const runnerLabel = status?.runners?.find((r) => r.id === status.runner)?.label ?? "Claude Code";
  // The header brands the route that's actually running, not the app's default.
  const isCodex = runner === "codex";
  const isOpenCode = runner === "opencode";
  const brand = isCodex ? "Codex" : isOpenCode ? "OpenCode" : "Claude";
  const aliveLabel = streaming ? `${brand} is thinking` : `${brand} is online`;

  return (
    <aside className="agent-panel">
      <div className="agent-panel__header agent-panel__header--with-alive">
        <div
          className={`agent-panel__alive${streaming ? " agent-panel__alive--busy" : ""}`}
          aria-label={aliveLabel}
          title={streaming ? `${brand} is thinking…` : `${brand} is online`}
        >
          {isOpenCode
            ? <svg width={22} height={22} viewBox="0 0 24 24" fill="currentColor" aria-label="OpenCode" role="img" style={{ opacity: streaming ? 0.6 : 1 }}><path d="M4 2h16v20H4zM8 6v12h8V6z" /></svg>
            : isCodex
              ? <CodexMark size={24} thinking={streaming} ariaLabel="Codex" />
              : <ClaudePixel size={28} color="currentColor" thinking={streaming} ariaLabel="Claude" />}
        </div>
        {/* Sessions | Bots rides the header line: the runner's name came out of
            here (the sprite already brands it), and the back/forward thread
            chevrons went with it — History does that job properly now. */}
        <div className="operator-brand">
          {ready && (mode === "bots" && activeBot ? (
            <button
              type="button"
              className="operator-crumb"
              onClick={() => setBotId("")}
              title="All bots"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="15 18 9 12 15 6" />
              </svg>
              <span className="operator-crumb__name">{activeBot.name}</span>
            </button>
          ) : (
            <div className="operator-seg" role="group" aria-label="Agent mode">
              <button
                type="button"
                className="operator-seg__btn"
                aria-pressed={mode === "sessions"}
                onClick={() => { setMode("sessions"); setHistoryOpen(false); }}
              >
                Sessions
              </button>
              <button
                type="button"
                className="operator-seg__btn"
                aria-pressed={mode === "bots"}
                onClick={() => { setMode("bots"); setBotId(""); setHistoryOpen(false); }}
              >
                Bots
              </button>
            </div>
          ))}
        </div>
        <div className="agent-panel__header-actions">
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

      {/* Bots — a vertical list of collaborators. Picking one opens its own
          thread and its own history; the header crumb walks back here. */}
      {ready && mode === "bots" && !botId && (
        <div className="operator-page">
          <div className="operator-page__head">
            <span className="operator-page__title">Bots</span>
            <button
              type="button"
              className={`agent-panel__new agent-panel__new--icon${newBotOpen ? " agent-panel__new--on" : ""}`}
              onClick={() => { setNewBotOpen((v) => !v); setBotError(""); }}
              aria-label="New bot"
              title="New bot"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </div>
          {newBotOpen && (
            <div className="operator-bot-new">
              <div className="operator-bot-new__top">
                <button
                  type="button"
                  className="operator-bot-face operator-bot-face--pick"
                  style={{ background: botTint(newBotIcon) }}
                  onClick={() => setIconPickerOpen((v) => !v)}
                  aria-label="Choose an icon"
                  title="Choose an icon"
                >
                  {newBotIcon}
                </button>
                <input
                  className="operator-bot-input"
                  placeholder="Name"
                  value={newBotName}
                  autoFocus
                  onChange={(e) => setNewBotName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void createBot(); if (e.key === "Escape") setNewBotOpen(false); }}
                />
              </div>
              {iconPickerOpen && (
                <div className="operator-icons" role="group" aria-label="Bot icon">
                  {BOT_ICONS.map((ic) => (
                    <button
                      key={ic}
                      type="button"
                      className={`operator-icons__cell${ic === newBotIcon ? " is-on" : ""}`}
                      onClick={() => { setNewBotIcon(ic); setIconPickerOpen(false); }}
                      aria-pressed={ic === newBotIcon}
                    >
                      {ic}
                    </button>
                  ))}
                </div>
              )}
              {/* The brief. It goes into the bot's system prompt on every turn,
                  so it is worth more than a label — hence a textarea. */}
              <textarea
                className="operator-bot-input operator-bot-input--desc"
                placeholder="What is this bot for? It reads this on every turn."
                rows={3}
                value={newBotDesc}
                onChange={(e) => setNewBotDesc(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") setNewBotOpen(false); }}
              />
              <div className="operator-bot-new__actions">
                <button type="button" className="operator-btn" onClick={() => { setNewBotOpen(false); setIconPickerOpen(false); setBotError(""); }}>Cancel</button>
                <button type="button" className="operator-btn operator-btn--primary" onClick={() => void createBot()} disabled={!newBotName.trim()}>Create bot</button>
              </div>
            </div>
          )}
          {botError && <div className="operator-bot-error">{botError}</div>}
          <div className="operator-page__body">
            {bots.length === 0 ? (
              <p className="operator-page__empty">No bots yet. A bot is a named collaborator with its own memory and monthly budget.</p>
            ) : bots.map((b) => {
              const threads = chats.sessions.filter((x) => x.projectId === `bot:${b.id}` && !x.archived);
              return (
                <div key={b.id} className="operator-botrow">
                  <button type="button" className="operator-botrow__open" onClick={() => setBotId(b.id)}>
                    <span className="operator-bot-face" style={{ background: botTint(b.icon || b.id) }} aria-hidden="true">
                      {b.icon || "🤖"}
                    </span>
                    <span className="operator-botrow__lines">
                      <span className="operator-botrow__name">{b.name}</span>
                      <span className="operator-botrow__meta">
                        {b.description || `${threads.length} conversation${threads.length === 1 ? "" : "s"}`}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="operator-row__icon operator-row__icon--danger"
                    onClick={() => { if (window.confirm(`Delete ${b.name} and everything it has learned?`)) void deleteBot(b.id); }}
                    aria-label={`Delete ${b.name}`}
                    title="Delete bot"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="3 6 21 6" /><path d="M8 6V4h8v2" /><path d="M6 6l1 14h10l1-14" />
                    </svg>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* History — the whole panel, not a 30% drawer. Every thread the app
          holds, grouped under the project (or bot) it belongs to. */}
      {historyOpen && (
        <div className="operator-page">
          <div className="operator-page__head">
            <span className="operator-page__title">History</span>
            <div className="operator-seg operator-seg--sm" role="group" aria-label="History filter">
              <button type="button" className="operator-seg__btn" aria-pressed={!showArchived} onClick={() => setShowArchived(false)}>Active</button>
              <button type="button" className="operator-seg__btn" aria-pressed={showArchived} onClick={() => setShowArchived(true)}>Archived</button>
            </div>
            <button type="button" className="operator-row__icon" onClick={() => setHistoryOpen(false)} aria-label="Close history" title="Close">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <div className="operator-page__body">
            {historyGroups.length === 0 ? (
              <p className="operator-page__empty">{showArchived ? "Nothing archived yet." : "No conversations yet."}</p>
            ) : historyGroups.map((g) => (
              <section key={g.key} className="operator-hist__group">
                <h3 className="operator-hist__project">{g.label}</h3>
                {g.items.map((sn) => (
                  <div key={sn.id} className={`operator-hist__row${sn.id === chatIdRef.current ? " is-active" : ""}`}>
                    <button type="button" className="operator-hist__open" onClick={() => openChat(sn.id)}>
                      <span className="operator-hist__title">{sn.title}</span>
                      <span className="operator-hist__meta">
                        {new Date(sn.updatedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · {sn.messages.length} messages
                      </span>
                    </button>
                    <button
                      type="button"
                      className="operator-row__icon"
                      onClick={() => archiveChat(sn.id, !sn.archived)}
                      aria-label={sn.archived ? "Unarchive" : "Archive"}
                      title={sn.archived ? "Unarchive" : "Archive"}
                    >
                      {sn.archived ? (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <rect x="3" y="4" width="18" height="4" /><path d="M5 8v12h14V8" /><polyline points="9 14 12 11 15 14" />
                        </svg>
                      ) : (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <rect x="3" y="4" width="18" height="4" /><path d="M5 8v12h14V8" /><polyline points="9 12 12 15 15 12" />
                        </svg>
                      )}
                    </button>
                    <button
                      type="button"
                      className="operator-row__icon operator-row__icon--danger"
                      onClick={() => deleteChat(sn.id)}
                      aria-label="Delete chat"
                      title="Delete chat"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polyline points="3 6 21 6" /><path d="M8 6V4h8v2" /><path d="M6 6l1 14h10l1-14" />
                      </svg>
                    </button>
                  </div>
                ))}
              </section>
            ))}
          </div>
        </div>
      )}

      {!status ? (
        <div className="agent-panel__messages" />
      ) : !ready ? (
        <div className="agent-panel__messages">
          <div className="agent-panel__hero">
            <h1 className="agent-panel__hero-title">Install {runnerLabel}</h1>
            <p className="agent-panel__hero-sub">Matte runs on your Claude subscription — no API key, no token to copy.</p>
            <ol className="operator-setup__steps">
              <li>Install <a href="https://claude.com/code" target="_blank" rel="noreferrer">Claude Code</a>.</li>
              <li>Run <code>claude</code> once and sign in to your subscription.</li>
              <li>Come back and type <code>/login</code> here.</li>
            </ol>
            <button
              type="button"
              className="agent-panel__hero-signin"
              onClick={() => {
                // Same installer Settings → Setup uses: our command, in a Terminal window.
                void fetch("/api/setup/install", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: status?.runner ?? "claude" }) });
              }}
            >
              Install {runnerLabel} in Terminal
            </button>
            <button type="button" className="agent-panel__hero-signin agent-panel__hero-signin--quiet" onClick={() => { void refreshStatus(); }}>
              Check again
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></svg>
            </button>
          </div>
        </div>
      ) : (
        <div className="agent-panel__messages" ref={scrollRef}>
          {messages.length === 0 ? (
            <div className="agent-panel__hero operator-hero">
              <h1 className="agent-panel__hero-title">
                {activeBot ? `Hey, I'm ${activeBot.name}.` : `Welcome back${firstName ? `, ${firstName}` : ""}.`}
              </h1>
              <p className="agent-panel__hero-sub">
                {activeBot ? "What do you wanna work on?" : "Your recent work here."}
              </p>

              {/* The activity year is the user's, not the bot's — a bot greets
                  you and gets to work instead. */}
              {!activeBot && (
              <div className="operator-streak-card" ref={cardRef}>
                <div className="operator-streak__scroll">
                  <div className="operator-streak__inner">
                <div className="operator-streak__months">
                  {activity.months.map((m, i) => <span key={i}>{m}</span>)}
                </div>
                <div className="operator-streak" onMouseLeave={() => setTip(null)}>
                  {activity.cells.map((c, i) => (
                    <span
                      key={c ? c.key : `x${i}`}
                      className={`operator-streak__cell${c ? "" : " operator-streak__cell--empty"}`}
                      // 0-3, so one busy day doesn't wash the rest of the quarter out.
                      data-level={c ? Math.min(c.count, 3) : 0}
                      onMouseEnter={(e) => {
                        if (!c) return setTip(null);
                        const cell = e.currentTarget.getBoundingClientRect();
                        const card = cardRef.current!.getBoundingClientRect();
                        setTip({ text: c.label, x: cell.left - card.left + cell.width / 2, y: cell.top - card.top });
                      }}
                    />
                  ))}
                </div>
                  </div>
                </div>
                {/* Outside the scroller: it clips overflow, and the tip has to
                    sit above the top row. Coordinates come off live rects, so
                    scrolling the year keeps it on its square. */}
                {tip && (
                  <div className="operator-streak__tip" style={{ left: tip.x, top: tip.y }}>{tip.text}</div>
                )}
                <div className="operator-streak__legend">
                  <span>Less</span>
                  {[0, 1, 2, 3].map((l) => <i key={l} className="operator-streak__cell" data-level={l} />)}
                  <span>More</span>
                </div>
              </div>
              )}

              {!activeBot && (
                <div className="operator-starters">
                  {["Set me up with fal.ai", "What can you make?", "20 s clip, H3 Turbo, 480p, 9:16"].map((t) => (
                    <button key={t} type="button" className="operator-resume operator-starter" onClick={() => void send(t)}>{t}</button>
                  ))}
                </div>
              )}

              {lastChat && (
                <>
                  <span className="operator-resume-tag">Continue project</span>
                  <button type="button" className="operator-resume" onClick={() => openChat(lastChat.id)}>
                    {lastChat.title}
                  </button>
                </>
              )}
            </div>
          ) : (
            messages.map((m) => {
              const isUser = m.role === "user";
              const hasText = !!m.text.trim();
              const steps = m.steps ?? [];
              const showBubble = hasText || (m.streaming && m.gens.length === 0) || steps.length > 0;
              return (
                <div key={m.id} className={`agent-panel__msg agent-panel__msg--${isUser ? "user" : "assistant"}`}>
                  {showBubble && (
                    <div className="agent-panel__bubble">
                      {isUser ? (
                        m.text
                      ) : m.streaming && !hasText ? (
                        <>
                          <Steps steps={steps} />
                          <ThinkingPill className="agent-panel__thinking" label={stepLabel(steps)} />
                        </>
                      ) : (
                        <>
                          <Steps steps={steps} />
                          {m.streaming ? (
                            <StreamingText text={m.text} />
                          ) : (
                            <div className="agent-panel__markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }} />
                          )}
                          {m.streaming && <ThinkingPill className="agent-panel__thinking agent-panel__thinking--inline" label={stepLabel(steps)} />}
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
            {slashHits.length > 0 && (
              <div className="operator-slash" role="listbox">
                {slashHits.map((s, i) => (
                  <button
                    key={s.slug}
                    type="button"
                    role="option"
                    aria-selected={i === slashIdx}
                    className={`operator-slash__item${i === slashIdx ? " is-active" : ""}`}
                    onMouseDown={(e) => { e.preventDefault(); pickSlash(s); }}
                  >
                    <span className="operator-slash__slug">/{s.slug}</span>
                    <span className="operator-slash__desc">{s.description || s.title}</span>
                  </button>
                ))}
              </div>
            )}
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
              title="Model the agent uses to operate"
              aria-label="Operator model"
            >
              {models.map((m) => (
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
