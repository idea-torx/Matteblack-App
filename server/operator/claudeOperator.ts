/**
 * The Matte operator (Phase K) — drives the user's **Claude Code** (their Claude
 * subscription) headlessly so the in-app Matte panel becomes the agent console.
 *
 *   panel message ─▶ runOperator() ─▶ spawn `claude -p --output-format stream-json`
 *                       │                 (with the matteblack MCP server + the
 *                       │                  user's CLAUDE_CODE_OAUTH_TOKEN)
 *                       ◀── parsed events (text / tool_use / tool_result / done)
 *
 * Claude calls the matteblack MCP tools (generate_media, …) which loop back into
 * this same app over HTTP and land results on the canvas. We only expose the
 * matteblack tools (`--allowedTools`) and load only our MCP server
 * (`--strict-mcp-config`), so the operator can generate but not touch the
 * filesystem or the user's other MCP servers.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR, ensureDataDir } from "../config/runtime.js";
import { getClaudeCodeToken, getClaudeCodePath } from "../config/userConfig.js";

// ---------------------------------------------------------------------------
// Locating the `claude` binary
// ---------------------------------------------------------------------------

/** Candidate locations for the Claude Code CLI, most-specific first. */
function claudeCandidates(): string[] {
  const home = os.homedir();
  const list = [
    getClaudeCodePath(),
    path.join(home, ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude"),
    process.platform === "win32" ? path.join(process.env.APPDATA || "", "npm", "claude.cmd") : null,
    process.platform === "win32" ? path.join(process.env.LOCALAPPDATA || "", "Programs", "claude", "claude.exe") : "/usr/local/bin/claude",
  ].filter((p): p is string => !!p);
  return list;
}

/** Resolve the claude binary path, or "claude" to fall back to PATH lookup. */
export function resolveClaudeBinary(): { path: string; found: boolean } {
  for (const c of claudeCandidates()) {
    try {
      if (fs.existsSync(c)) return { path: c, found: true };
    } catch { /* ignore */ }
  }
  return { path: "claude", found: false }; // last resort: rely on PATH
}

// ---------------------------------------------------------------------------
// MCP config for the spawned claude
// ---------------------------------------------------------------------------

/** The matteblack MCP tools we let the operator call (nothing else). */
export const OPERATOR_ALLOWED_TOOLS = [
  "generate_media",
  "generate_music",
  "transform_media",
  "list_models",
  "list_canvas",
  "get_asset",
].map((t) => `mcp__falforge__${t}`);

/** Path + command to run the bundled MCP server. Electron main passes these via
 *  env (MB_APP_EXEC / MB_MCP_SCRIPT); dev falls back to this process + cwd. */
function mcpServerSpec(): { command: string; args: string[]; env: Record<string, string> } {
  const command = process.env.MB_APP_EXEC || process.execPath;
  const script = process.env.MB_MCP_SCRIPT || path.join(process.cwd(), "dist-mcp", "index.js");
  return {
    command,
    args: [script],
    // ELECTRON_RUN_AS_NODE makes the app binary behave as Node (no-op for real
    // node); MATTEBLACK_DATA_DIR points the MCP server at this app's discovery file.
    env: { ELECTRON_RUN_AS_NODE: "1", MATTEBLACK_DATA_DIR: DATA_DIR },
  };
}

/** Write the --mcp-config file claude loads. Returns its path. */
function writeMcpConfig(): string {
  ensureDataDir();
  const spec = mcpServerSpec();
  const cfg = { mcpServers: { matteblack: { command: spec.command, args: spec.args, env: spec.env } } };
  const p = path.join(DATA_DIR, "operator-mcp-config.json");
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), "utf8");
  return p;
}

const OPERATOR_SYSTEM_PROMPT = [
  "You are the generation operator inside the Matteblack desktop app — Claude, driving the app for the user.",
  "You drive image/video/music generation for the user through the matteblack MCP tools:",
  "generate_media, generate_music, transform_media, plus list_models / list_canvas / get_asset.",
  "When the user asks to make, create, generate, edit, upscale, or remix visuals or audio, call the",
  "appropriate tool. Results land on the user's canvas automatically. To build on existing work, call",
  "list_canvas to get a url and pass it in referenceUrls. Keep replies short: say what you're generating,",
  "then let the tool run. You do not have file or shell access — only the matteblack tools.",
  "If the user attaches a reference image (you'll see a bracketed system note saying so), it is supplied",
  "to the generation tools automatically — just call generate_media (or transform_media) right away; never",
  "ask the user to put it on the canvas or for a URL.",
].join(" ");

// ---------------------------------------------------------------------------
// Event model + stream-json parsing
// ---------------------------------------------------------------------------

export type OperatorEvent =
  | { type: "session"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; tool: string; input: unknown }
  | { type: "tool_result"; id: string; text: string; isError: boolean }
  | { type: "done"; sessionId?: string; result: string; isError: boolean }
  | { type: "error"; message: string };

/** Turn one parsed stream-json object into zero or more OperatorEvents. Exported
 *  for unit testing against recorded fixtures (no live claude needed). */
export function parseStreamJsonLine(obj: Record<string, unknown>): OperatorEvent[] {
  const out: OperatorEvent[] = [];
  const t = obj.type;

  if (t === "system" && obj.subtype === "init" && typeof obj.session_id === "string") {
    out.push({ type: "session", sessionId: obj.session_id });
    return out;
  }

  if (t === "assistant" && obj.message && typeof obj.message === "object") {
    const content = (obj.message as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
          out.push({ type: "text", text: b.text });
        } else if (b.type === "tool_use" && typeof b.name === "string") {
          out.push({
            type: "tool_use",
            id: typeof b.id === "string" ? b.id : "",
            tool: b.name.replace(/^mcp__falforge__/, ""),
            input: b.input,
          });
        }
      }
    }
    return out;
  }

  if (t === "user" && obj.message && typeof obj.message === "object") {
    const content = (obj.message as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type === "tool_result") {
          out.push({
            type: "tool_result",
            id: typeof b.tool_use_id === "string" ? b.tool_use_id : "",
            text: extractResultText(b.content),
            isError: b.is_error === true,
          });
        }
      }
    }
    return out;
  }

  if (t === "result") {
    out.push({
      type: "done",
      sessionId: typeof obj.session_id === "string" ? obj.session_id : undefined,
      result: typeof obj.result === "string" ? obj.result : "",
      isError: obj.is_error === true || obj.subtype === "error_max_turns" || obj.subtype === "error_during_execution",
    });
    return out;
  }

  return out;
}

function extractResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? (c as { text?: string }).text ?? "" : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

// ---------------------------------------------------------------------------
// Running the operator
// ---------------------------------------------------------------------------

export class OperatorNotConfiguredError extends Error {}

/** Claude Code's `--effort` levels, weakest to strongest. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export interface RunOperatorOptions {
  message: string;
  sessionId?: string; // resume a prior conversation
  model?: string; // optional model override
  /** Thinking budget for the turn (`--effort`). Omitted → the CLI's own default. */
  effort?: EffortLevel;
  onEvent: (e: OperatorEvent) => void;
  signal?: AbortSignal;
}

/**
 * Run one operator turn: spawn `claude -p`, stream parsed events via onEvent,
 * resolve when the process exits. Rejects only on spawn/parse failure — tool and
 * generation errors surface as events.
 */
export function runOperator(opts: RunOperatorOptions): Promise<{ sessionId?: string }> {
  const token = getClaudeCodeToken();
  if (!token) {
    return Promise.reject(
      new OperatorNotConfiguredError(
        "Claude Code token not set. Run `claude setup-token` and add it in Settings to enable the Matte operator.",
      ),
    );
  }

  const bin = resolveClaudeBinary();
  const mcpConfigPath = writeMcpConfig();

  const args = [
    "-p", opts.message,
    "--output-format", "stream-json",
    "--verbose", // required for stream-json to emit intermediate events
    "--mcp-config", mcpConfigPath,
    "--strict-mcp-config",
    "--allowedTools", OPERATOR_ALLOWED_TOOLS.join(","),
    "--append-system-prompt", OPERATOR_SYSTEM_PROMPT,
  ];
  if (opts.sessionId) args.push("--resume", opts.sessionId);
  if (opts.model) args.push("--model", opts.model);
  if (opts.effort) args.push("--effort", opts.effort);

  // .cmd/.bat shims (npm global) need a shell; native .exe does not.
  const useShell = /\.(cmd|bat)$/i.test(bin.path);

  // Build the child env from ours, then DELETE any ambient Anthropic vars so
  // they can't override the subscription token / redirect the endpoint. (Managed
  // Claude Code environments inject ANTHROPIC_BASE_URL / auth at launch; if
  // inherited, the spawned claude would try the wrong auth and 401.)
  const childEnv: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token };
  delete childEnv.ANTHROPIC_API_KEY;
  delete childEnv.ANTHROPIC_AUTH_TOKEN;
  delete childEnv.ANTHROPIC_BASE_URL;
  delete childEnv.ANTHROPIC_MODEL;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin.path, args, {
        env: childEnv,
        // Close stdin (the prompt is passed via -p) so claude doesn't wait ~3s
        // for piped input; capture stdout/stderr.
        stdio: ["ignore", "pipe", "pipe"],
        shell: useShell,
        windowsHide: true,
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let lastSessionId: string | undefined = opts.sessionId;
    let stderrBuf = "";
    let stdoutBuf = "";

    const onAbort = () => { try { child.kill(); } catch { /* already gone */ } };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(line);
        } catch {
          continue; // non-JSON noise
        }
        for (const ev of parseStreamJsonLine(obj)) {
          if (ev.type === "session" || (ev.type === "done" && ev.sessionId)) {
            lastSessionId = ev.type === "session" ? ev.sessionId : ev.sessionId ?? lastSessionId;
          }
          try { opts.onEvent(ev); } catch { /* consumer error — keep parsing */ }
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => { stderrBuf += chunk.toString(); });

    child.on("error", (err) => {
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (code !== 0 && code !== null) {
        const detail = stderrBuf.trim().split("\n").slice(-3).join(" ").slice(0, 400);
        opts.onEvent({
          type: "error",
          message: detail || `claude exited with code ${code}`,
        });
      }
      resolve({ sessionId: lastSessionId });
    });
  });
}

/** Whether the operator is usable (token present + binary locatable). */
export function operatorStatus(): { hasToken: boolean; binaryFound: boolean; binaryPath: string } {
  const bin = resolveClaudeBinary();
  return { hasToken: !!getClaudeCodeToken(), binaryFound: bin.found, binaryPath: bin.path };
}
