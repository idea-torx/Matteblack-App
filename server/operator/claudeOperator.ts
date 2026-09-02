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
import path from "node:path";
import { REPOS_DIR, readStore as readRepoStore } from "../github/ghCli.js";
import { operatorSystemPrompt } from "../skills/builtin.js";
import { skillIndex, pinnedInstructions } from "../skills/skillStore.js";
import { memoryInstructions } from "../skills/agentMemory.js";
import { DATA_DIR, ensureDataDir } from "../config/runtime.js";
import { getOperatorRunner } from "../config/userConfig.js";
import { claudeRunner, resolveClaudeBinary } from "./runners/claude.js";
import { codexRunner } from "./runners/codex.js";

export { resolveClaudeBinary };
/** Claude's stream-json parser, re-exported from where it now lives. */
export { parseStreamJsonLine } from "./runners/claude.js";

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

/** The Fal Forge MCP tools we let the operator call, bare (un-namespaced). */
export const OPERATOR_MCP_TOOL_NAMES = [
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
  "patch_skill",
  "search_fal_models",
  "get_fal_model_schema",
  "add_model",
];

export const OPERATOR_MCP_TOOLS = OPERATOR_MCP_TOOL_NAMES.map((t) => `mcp__${MCP_SERVER_KEY}__${t}`);

/** The after-turn review pass's grant: it may only write down what it learned.
 *  No generation, no repos, no web, no files. */
export const REVIEW_MCP_TOOL_NAMES = [
  "remember",
  "forget",
  "recall",
  "list_skills",
  "get_skill",
  "patch_skill",
  "save_skill",
];

export const REVIEW_MCP_TOOLS = REVIEW_MCP_TOOL_NAMES.map((t) => `mcp__${MCP_SERVER_KEY}__${t}`);

export const OPERATOR_ALLOWED_TOOLS = [...OPERATOR_MCP_TOOLS, ...FILE_TOOLS, ...WEB_TOOLS];

/** The grant for one run. Editing appears only when the user has opted a repo
 *  in, so a read-only library keeps exactly the permissions it had before. */
export function allowedToolsFor(writable: boolean): string[] {
  return writable ? [...OPERATOR_ALLOWED_TOOLS, ...AUTHOR_TOOLS] : OPERATOR_ALLOWED_TOOLS;
}

/** Path + command to run the bundled MCP server. Electron main passes these via
 *  env (MB_APP_EXEC / MB_MCP_SCRIPT); dev falls back to this process + cwd. */
export function mcpServerSpec(review: boolean, mcpTools: string[]): { command: string; args: string[]; env: Record<string, string> } {
  const command = process.env.MB_APP_EXEC || process.execPath;
  const script = process.env.MB_MCP_SCRIPT || path.join(process.cwd(), "dist-mcp", "index.js");
  return {
    command,
    args: [script],
    // ELECTRON_RUN_AS_NODE makes the app binary behave as Node (no-op for real
    // node); MATTEBLACK_DATA_DIR points the MCP server at this app's discovery file.
    // MB_SKILL_ACTOR tells the bridge which actor header to stamp on skill
    // writes — the review pass is not allowed to touch the user's own docs.
    // MB_TOOLS is the runner-independent allowlist: Claude also gets
    // --allowedTools, but Codex has no equivalent, so the restriction is
    // enforced inside the MCP server itself.
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      MATTEBLACK_DATA_DIR: DATA_DIR,
      MB_TOOLS: mcpTools.join(","),
      ...(review ? { MB_SKILL_ACTOR: "review" } : {}),
    },
  };
}

/** Write the --mcp-config file claude loads. Returns its path. */
function writeMcpConfig(review: boolean, spec: { command: string; args: string[]; env: Record<string, string> }): string {
  ensureDataDir();
  const cfg = { mcpServers: { [MCP_SERVER_KEY]: { command: spec.command, args: spec.args, env: spec.env } } };
  // Separate file per actor: a foreground turn rewriting the shared one while a
  // review is in flight would hand the review the wrong env.
  const p = path.join(DATA_DIR, review ? "operator-mcp-config-review.json" : "operator-mcp-config.json");
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), "utf8");
  return p;
}

/** The operator's standing instructions live in the editable `operator-system`
 *  skill, so the user can change how the agent behaves from the Skills panel.
 *  Read per run — an edit takes effect on the next message, no restart. */

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

// ---------------------------------------------------------------------------
// Running the operator
// ---------------------------------------------------------------------------

export class OperatorNotConfiguredError extends Error {}

/** Claude Code's `--effort` levels, weakest to strongest. Codex's three levels
 *  are mapped onto these in its runner. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

// ---------------------------------------------------------------------------
// Runner registry
// ---------------------------------------------------------------------------

export type RunnerId = "claude" | "codex";

/** Everything a runner needs to build one command line. Assembled below so the
 *  runners stay pure argv-and-parse: no config reads, no filesystem. */
export interface RunnerContext {
  message: string;
  /** Runner-native session id (the `codex:` prefix already stripped). */
  sessionId?: string;
  model?: string;
  effort?: EffortLevel;
  review: boolean;
  systemPrompt: string;
  /** Claude-style namespaced grant, incl. its native Read/Grep/WebFetch tools. */
  allowedTools: string[];
  /** How to launch our MCP server, incl. the MB_TOOLS allowlist in `env`. */
  mcp: { command: string; args: string[]; env: Record<string, string> };
  /** The written --mcp-config file (Claude only; Codex takes -c overrides). */
  mcpConfigPath: string;
}

export interface Runner {
  id: RunnerId;
  label: string;
  /** Models the panel may pick; first is the default. */
  models: { id: string; label: string }[];
  /** Subscription sign-in (opens the browser) and a status probe that exits 0 + prints when signed in. */
  loginArgs: string[];
  statusArgs: string[];
  loggedIn(stdout: string, code: number | null): boolean;
  resolveBinary(): { path: string; found: boolean };
  notFoundMessage: string;
  spawnArgs(ctx: RunnerContext): string[];
  /** Prompt on stdin instead of argv, when the CLI prefers it. */
  stdinText?(ctx: RunnerContext): string;
  parseLine(obj: Record<string, unknown>): OperatorEvent[];
}

export const RUNNERS: Runner[] = [claudeRunner, codexRunner];

/** Session ids are runner-specific — handing a Claude id to `codex exec resume`
 *  is a hard error — so every non-default runner's ids carry its prefix. */
function tagSession(runner: RunnerId, id: string): string {
  return runner === "claude" ? id : `${runner}:${id}`;
}
function untagSession(runner: RunnerId, id: string | undefined): string | undefined {
  if (!id) return undefined;
  const i = id.indexOf(":");
  const owner = i === -1 ? "claude" : id.slice(0, i);
  // A session from the other runner is simply not resumable here: drop it and
  // start fresh rather than feed a foreign id to the CLI.
  if (owner !== runner) return undefined;
  return i === -1 ? id : id.slice(i + 1);
}

export interface RunOperatorOptions {
  message: string;
  sessionId?: string; // resume a prior conversation
  model?: string; // optional model override
  /** Thinking budget for the turn (`--effort`). Omitted → the CLI's own default. */
  effort?: EffortLevel;
  onEvent: (e: OperatorEvent) => void;
  signal?: AbortSignal;
  /** Replaces the computed allowlist outright. Used by the after-turn review
   *  pass, which may only write memory and skills. */
  allowedTools?: string[];
  /** This IS the after-turn review pass. Never set by the panel; the route
   *  only starts a review for a turn that had it unset, so it cannot recurse. */
  review?: boolean;
  /** Override the configured runner for this turn. */
  runner?: RunnerId;
}

/**
 * Run one operator turn: spawn the configured CLI, stream parsed events via
 * onEvent, resolve when the process exits. Rejects only on spawn failure — tool
 * and generation errors surface as events.
 */
export function runOperator(opts: RunOperatorOptions): Promise<{ sessionId?: string }> {
  const runnerId = opts.runner ?? getOperatorRunner();
  const runner = RUNNERS.find((r) => r.id === runnerId) ?? claudeRunner;
  const bin = runner.resolveBinary();
  if (!bin.found) return Promise.reject(new OperatorNotConfiguredError(runner.notFoundMessage));

  // Attached repos are checked out here; pin cwd so file tools reach them and
  // nothing else on the user's disk. Constant regardless of how many repos are
  // attached, so the CLI's session store stays stable across turns.
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

  const systemPrompt = operatorSystemPrompt() + repoNote + skillIndex() + pinnedInstructions() + memoryInstructions();
  // Codex reads AGENTS.md out of its cwd; Claude keeps --append-system-prompt
  // (it reads CLAUDE.md, and duplicating the doc into its context helps nobody).
  // Rewritten every turn — memory and the skill index move. Safe to drop in
  // REPOS_DIR: attached repos are enumerated from repos.json, never by listing
  // this directory, so a stray file here is not mistaken for a repo.
  try { fs.writeFileSync(path.join(REPOS_DIR, "AGENTS.md"), systemPrompt, "utf8"); } catch { /* not fatal */ }

  const allowedTools = opts.allowedTools ?? allowedToolsFor(writable.length > 0);
  // The same grant, bare, for MB_TOOLS — the runner-independent half.
  const mcpTools = allowedTools
    .filter((t) => t.startsWith(`mcp__${MCP_SERVER_KEY}__`))
    .map((t) => t.slice(`mcp__${MCP_SERVER_KEY}__`.length));
  const mcp = mcpServerSpec(opts.review === true, mcpTools);

  const ctx: RunnerContext = {
    message: opts.message,
    sessionId: untagSession(runner.id, opts.sessionId),
    model: opts.model,
    effort: opts.effort,
    review: opts.review === true,
    systemPrompt,
    allowedTools,
    mcp,
    mcpConfigPath: writeMcpConfig(opts.review === true, mcp),
  };
  const args = runner.spawnArgs(ctx);
  const stdinText = runner.stdinText?.(ctx);

  // .cmd/.bat shims (npm global) need a shell; native .exe does not.
  const useShell = /\.(cmd|bat)$/i.test(bin.path);

  // The spawned CLI authenticates itself, off the same subscription login the
  // user already has in their terminal — this app never handles, stores, or
  // passes a credential. DELETE any ambient Anthropic vars so an API key in the
  // environment can't silently take over and bill the user per-token instead.
  const childEnv = cleanEnv();

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin.path, args, {
        env: childEnv,
        cwd: REPOS_DIR,
        // Close stdin unless the runner writes the prompt there (claude takes it
        // via -p and otherwise waits ~3s for piped input).
        stdio: [stdinText === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        shell: useShell,
        windowsHide: true,
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (stdinText !== undefined && child.stdin) {
      child.stdin.on("error", () => { /* child died first */ });
      child.stdin.end(stdinText);
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
        for (const raw of runner.parseLine(obj)) {
          // Re-tag ids on the way out so the client only ever holds ids this
          // same runner can resume.
          const ev: OperatorEvent =
            raw.type === "session" ? { ...raw, sessionId: tagSession(runner.id, raw.sessionId) }
            : raw.type === "done" ? { ...raw, sessionId: raw.sessionId ? tagSession(runner.id, raw.sessionId) : lastSessionId }
            : raw;
          if (ev.type === "session") lastSessionId = ev.sessionId;
          else if (ev.type === "done" && ev.sessionId) lastSessionId = ev.sessionId;
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
          message: detail || `${runner.id} exited with code ${code}`,
        });
      }
      resolve({ sessionId: lastSessionId });
    });
  });
}

/** process.env minus every API-key/base-url override: subscription login only, never per-token billing. */
export function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY"]) delete env[k];
  return env;
}

function runCli(runner: Runner, args: string[], timeoutMs: number): Promise<{ stdout: string; code: number | null }> {
  const bin = runner.resolveBinary();
  if (!bin.found) return Promise.resolve({ stdout: "", code: 127 });
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawn(bin.path, args, { env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"], shell: /\.(cmd|bat)$/i.test(bin.path) });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (d) => { stdout += d; });
    child.on("error", () => { clearTimeout(timer); resolve({ stdout, code: 127 }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ stdout, code }); });
  });
}

/** Per-runner sign-in state, by asking each CLI (cheap, ~1s). */
export async function operatorAuth(): Promise<Record<RunnerId, boolean>> {
  const out = {} as Record<RunnerId, boolean>;
  await Promise.all(RUNNERS.map(async (r) => {
    const res = await runCli(r, r.statusArgs, 15_000);
    out[r.id] = r.loggedIn(res.stdout, res.code);
  }));
  return out;
}

/** Run the CLI's own browser sign-in and wait for it to finish (or 3 min). */
export async function operatorLogin(id: RunnerId): Promise<boolean> {
  const r = RUNNERS.find((x) => x.id === id);
  if (!r) return false;
  await runCli(r, r.loginArgs, 180_000);
  return (await operatorAuth())[id];
}

/** Whether the operator is usable, and what each runner's binary looks like. */
export function operatorStatus(): {
  binaryFound: boolean; binaryPath: string; runner: RunnerId;
  runners: { id: RunnerId; label: string; binaryFound: boolean; binaryPath: string; models: Runner["models"] }[];
} {
  const active = getOperatorRunner();
  const runners = RUNNERS.map((r) => {
    const bin = r.resolveBinary();
    return { id: r.id, label: r.label, binaryFound: bin.found, binaryPath: bin.path, models: r.models };
  });
  // binaryFound/binaryPath stay the ACTIVE runner's, which is what the panel's
  // "not configured" banner has always keyed off.
  const cur = runners.find((r) => r.id === active) ?? runners[0];
  return { binaryFound: cur.binaryFound, binaryPath: cur.binaryPath, runner: active, runners };
}
