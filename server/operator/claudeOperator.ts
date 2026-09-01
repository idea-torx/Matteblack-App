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
import { REPOS_DIR, readStore as readRepoStore } from "../github/ghCli.js";
import { operatorSystemPrompt } from "../skills/builtin.js";
import { pinnedInstructions } from "../skills/skillStore.js";
import { memoryInstructions } from "../skills/agentMemory.js";
import { DATA_DIR, ensureDataDir } from "../config/runtime.js";
import { getClaudeCodePath } from "../config/userConfig.js";

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

/** The key our MCP server is registered under in the --mcp-config we write.
 *  claude namespaces every tool as mcp__<serverKey>__<tool>, so this single
 *  constant has to drive the config key, the --allowedTools grant, and the
 *  display-name stripping below. When they drifted apart, every tool call came
 *  back as unpermitted. */
const MCP_SERVER_KEY = "falforge";

/** Claude's own read-only file tools. Granted so an attached GitHub repo can be
 *  used as real context — the spawned claude runs with cwd pinned to REPOS_DIR,
 *  so this reaches the user's checked-out repos and nothing else. */
const FILE_TOOLS = ["Read", "Grep", "Glob"];

/** Editing, granted per run and only while at least one attached repo has
 *  authoring turned on by the user. Bash is never granted: no installs, no
 *  builds, no `git merge` — the only way anything leaves this machine is
 *  `commit_repo`, which refuses the default branch and cannot merge. */
const AUTHOR_TOOLS = ["Write", "Edit"];

/** The web, read-only. A link the user pastes is context — a brand page, a
 *  product listing, a reference article — and without these the operator has to
 *  ask the user to paste the contents in by hand. Fetching is a read: it cannot
 *  write anything here, and the pixels it informs are still made by our tools. */
const WEB_TOOLS = ["WebFetch", "WebSearch"];

/** The Fal Forge MCP tools we let the operator call. */
export const OPERATOR_MCP_TOOLS = [
  "generate_media",
  "continue_video",
  "generate_music",
  "generate_voiceover",
  "transform_media",
  "list_models",
  "list_canvas",
  "get_asset",
  "list_skills",
  "get_skill",
  "save_skill",
  "list_repos",
  "checkout_branch",
  "commit_repo",
  // Programmatic HTML/CSS art. Left out of this list when they were added, so
  // every render_html call came back unpermitted no matter what the user
  // approved — the prompt never reaches a tool the operator was not granted.
  "render_html",
  "get_html",
  "get_timeline",
  "set_timeline",
  "save_cut",
  "list_cuts",
  "estimate_cost",
  // Self-improvement: the memory block is injected into the prompt, but without
  // these the operator could only ever read it — every correction it was given
  // died with the session.
  "recall",
  "remember",
  "forget",
].map((t) => `mcp__${MCP_SERVER_KEY}__${t}`);

export const OPERATOR_ALLOWED_TOOLS = [...OPERATOR_MCP_TOOLS, ...FILE_TOOLS, ...WEB_TOOLS];

/** The grant for one run. Editing appears only when the user has opted a repo
 *  in, so a read-only library keeps exactly the permissions it had before. */
export function allowedToolsFor(writable: boolean): string[] {
  return writable ? [...OPERATOR_ALLOWED_TOOLS, ...AUTHOR_TOOLS] : OPERATOR_ALLOWED_TOOLS;
}

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
  const cfg = { mcpServers: { [MCP_SERVER_KEY]: { command: spec.command, args: spec.args, env: spec.env } } };
  const p = path.join(DATA_DIR, "operator-mcp-config.json");
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), "utf8");
  return p;
}

/** The operator's standing instructions live in the editable `operator-system`
 *  skill, so the user can change how the agent behaves from the Skills panel.
 *  Read per run — an edit takes effect on the next message, no restart. */

// ---------------------------------------------------------------------------
// Event model + stream-json parsing
// ---------------------------------------------------------------------------

/** Strips the mcp__<serverKey>__ namespace off a tool name for display. */
const TOOL_PREFIX_RE = new RegExp(`^mcp__${MCP_SERVER_KEY}__`);

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
            tool: b.name.replace(TOOL_PREFIX_RE, ""),
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
  const bin = resolveClaudeBinary();
  if (!bin.found) {
    return Promise.reject(
      new OperatorNotConfiguredError(
        "Claude Code isn't installed. Install it, run `claude` once to sign in to your subscription, then reopen this panel.",
      ),
    );
  }

  const mcpConfigPath = writeMcpConfig();

  // Attached repos are checked out here; pin cwd so Read/Grep/Glob reach them
  // and nothing else on the user's disk. Constant regardless of how many repos
  // are attached, so claude's session store stays stable across turns.
  fs.mkdirSync(REPOS_DIR, { recursive: true });
  const repos = readRepoStore();
  const writable = repos.filter((r) => r.writable);
  const repoNote = repos.length
    ? ` The user has attached these repos, in priority order: ${repos
        .map((r) => `${r.nameWithOwner} (./${path.basename(r.dir || r.nameWithOwner)}${r.writable ? ", authoring enabled" : ", read-only"})`)
        .join(", ")}.${
        writable.length
          ? " On the authoring-enabled repos you may Write/Edit files and then call commit_repo, which commits to a working branch and opens a PR. Never commit to the default branch, never merge, and never install or run the project — you have no shell. On every other repo you are read-only."
          : " All of them are read-only: read the code, do not attempt to change it."
      }`
    : " The user has not attached any repos yet.";

  const args = [
    "-p", opts.message,
    "--output-format", "stream-json",
    "--verbose", // required for stream-json to emit intermediate events
    "--mcp-config", mcpConfigPath,
    "--strict-mcp-config",
    "--allowedTools", allowedToolsFor(writable.length > 0).join(","),
    "--append-system-prompt", operatorSystemPrompt() + repoNote + pinnedInstructions() + memoryInstructions(),
  ];
  if (opts.sessionId) args.push("--resume", opts.sessionId);
  if (opts.model) args.push("--model", opts.model);
  if (opts.effort) args.push("--effort", opts.effort);

  // .cmd/.bat shims (npm global) need a shell; native .exe does not.
  const useShell = /\.(cmd|bat)$/i.test(bin.path);

  // The spawned `claude` authenticates itself, off the same subscription login
  // the user already has in their terminal — this app never handles, stores, or
  // passes a credential. DELETE any ambient Anthropic vars so an API key in the
  // environment can't silently take over and bill the user per-token instead.
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.ANTHROPIC_API_KEY;
  delete childEnv.ANTHROPIC_AUTH_TOKEN;
  delete childEnv.ANTHROPIC_BASE_URL;
  delete childEnv.ANTHROPIC_MODEL;
  delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin.path, args, {
        env: childEnv,
        cwd: REPOS_DIR,
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

/** Whether the operator is usable — i.e. whether the `claude` CLI is present. */
export function operatorStatus(): { binaryFound: boolean; binaryPath: string } {
  const bin = resolveClaudeBinary();
  return { binaryFound: bin.found, binaryPath: bin.path };
}
