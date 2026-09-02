/**
 * The OpenCode CLI runner — `opencode run --format json`.
 *
 * Differences from the other two that shaped this file:
 *  - No config flag and no per-server approval mode: the whole config (our MCP
 *    server + the permission table) goes in through OPENCODE_CONFIG_CONTENT,
 *    which outranks the user's ~/.config/opencode/opencode.json. Verified live:
 *    the user's own `pencil` server does not appear in the spawned toolset.
 *  - `permission` is the only allowlist, and a `"*": "deny"` default drops
 *    bash/edit/write/webfetch/task out of the toolset entirely (the model is
 *    told it has no bash tool rather than being prompted mid-run). MB_TOOLS
 *    still bounds our own tools inside the MCP server.
 *  - The prompt is a positional argv (no stdin form).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OperatorEvent, Runner, RunnerContext } from "../claudeOperator.js";

function opencodeCandidates(): string[] {
  const home = os.homedir();
  return [
    process.env.MB_OPENCODE_PATH,
    path.join(home, ".opencode", "bin", "opencode"),
    path.join(home, ".npm-global", "bin", "opencode"),
    "/opt/homebrew/bin/opencode",
    "/usr/local/bin/opencode",
  ].filter((p): p is string => !!p);
}

export function resolveOpencodeBinary(): { path: string; found: boolean } {
  for (const c of opencodeCandidates()) {
    try {
      if (fs.existsSync(c)) return { path: c, found: true };
    } catch { /* ignore */ }
  }
  return { path: "opencode", found: false };
}

/** OpenCode namespaces an MCP server's tools as <server>_<tool>. */
const TOOL_PREFIX_RE = /^falforge_/;

/** The config OPENCODE_CONFIG_CONTENT carries for one run. */
function configContent(ctx: RunnerContext): string {
  const mcp: Record<string, unknown> = {
    falforge: {
      type: "local",
      command: [ctx.mcp.command, ...ctx.mcp.args],
      environment: ctx.mcp.env,
      enabled: true,
    },
  };
  // Deny-by-default: read/glob/grep mirror Claude's FILE_TOOLS grant, and
  // everything else (bash, edit, write, webfetch, websearch, task) is refused.
  const permission: Record<string, string> = {
    "*": "deny", read: "allow", glob: "allow", grep: "allow", "falforge_*": "allow",
  };
  for (const c of ctx.connectors ?? []) {
    if (c.url) mcp[c.name] = { type: "remote", url: c.url, enabled: true };
    else if (c.command) mcp[c.name] = { type: "local", command: [c.command, ...(c.args ?? [])], environment: c.env ?? {}, enabled: true };
    else continue;
    permission[`${c.name}_*`] = "allow";
  }
  return JSON.stringify({ mcp, permission });
}

export const opencodeRunner: Runner = {
  id: "opencode",
  label: "OpenCode",
  // ponytail: static list, same as Codex; `opencode models` prints the live
  // catalog if this ever needs to follow the user's plan.
  models: [
    { id: "opencode/big-pickle", label: "Big Pickle" },
    { id: "opencode-go/deepseek-v4-pro", label: "DeepSeek V4 Pro" },
    { id: "opencode-go/deepseek-v4-flash", label: "DeepSeek V4 Flash" },
    { id: "opencode-go/glm-5.3", label: "GLM 5.3" },
    { id: "opencode-go/kimi-k3", label: "Kimi K3" },
    { id: "opencode-go/qwen3.8-max", label: "Qwen 3.8 Max" },
  ],
  resolveBinary: resolveOpencodeBinary,
  loginArgs: ["auth", "login"],
  statusArgs: ["auth", "list"],
  loggedIn: (out, code) => code === 0 && Number(/(\d+)\s+credentials?/.exec(out)?.[1] ?? 0) > 0,
  notFoundMessage:
    "The OpenCode CLI isn't installed. Install it (`curl -fsSL https://opencode.ai/install | bash`), run `opencode auth login` once, then reopen this panel.",
  env: (ctx) => ({ OPENCODE_CONFIG_CONTENT: configContent(ctx) }),
  spawnArgs(ctx: RunnerContext): string[] {
    const args = ["run", "--format", "json"];
    if (ctx.sessionId) args.push("-s", ctx.sessionId);
    // Everything not explicitly allowed above is denied, and an explicit deny
    // holds under --auto — this only stops the run blocking on a prompt.
    args.push("--auto");
    const model = (!ctx.review && ctx.model) || opencodeRunner.models[0].id;
    args.push("-m", model);
    const variant = ctx.effort === "max" ? "max" : ctx.effort === "high" || ctx.effort === "xhigh" ? "high" : undefined;
    if (variant) args.push("--variant", variant);
    args.push(ctx.message);
    return args;
  },
  parseLine,
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** OpenCode `--format json` JSONL → Falforge events. Exported for the unit test. */
export function parseLine(obj: Record<string, unknown>): OperatorEvent[] {
  const t = obj.type;
  const part = (obj.part ?? {}) as Record<string, unknown>;

  if (t === "error") {
    const e = (obj.error ?? {}) as Record<string, unknown>;
    const data = (e.data ?? {}) as Record<string, unknown>;
    return [{ type: "error", message: str(data.message) || str(e.name) || "opencode error" }];
  }
  if (t === "step_start") {
    // Repeats once per step; the consumer stores the same id each time.
    return typeof obj.sessionID === "string" ? [{ type: "session", sessionId: obj.sessionID }] : [];
  }
  if (t === "step_finish") {
    // "tool-calls" means another step follows; only "stop" ends the turn.
    return part.reason === "stop" ? [{ type: "done", result: "", isError: false }] : [];
  }
  if (t === "text" || t === "reasoning") {
    const text = str(part.text);
    // A part still streaming has no time.end yet; wait for the finished one so
    // deltas and their final aren't both rendered.
    const time = part.time as { end?: unknown } | undefined;
    if (!text.trim() || (time && time.end === undefined)) return [];
    return [{ type: t === "text" ? "text" : "thinking", text }];
  }
  if (part.type === "tool") {
    const id = str(part.callID);
    const tool = str(part.tool).replace(TOOL_PREFIX_RE, "");
    const state = (part.state ?? {}) as Record<string, unknown>;
    const status = str(state.status);
    const use: OperatorEvent = { type: "tool_use", id, tool, input: state.input };
    if (status !== "completed" && status !== "error") return [use];
    // A terminal state arrives in one line, so both halves are emitted at once.
    return [use, {
      type: "tool_result",
      id,
      text: status === "error" ? str(state.error) || "tool failed" : str(state.output),
      isError: status === "error",
    }];
  }
  return [];
}
