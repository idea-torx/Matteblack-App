/**
 * The OpenAI Codex CLI runner — `codex exec --json`.
 *
 * Differences from Claude that shaped this file:
 *  - Codex has no `--allowedTools`. The only allowlist is MB_TOOLS, enforced
 *    inside our own MCP server (server/mcp/toolAllowlist.ts).
 *  - Codex has no `--mcp-config`; servers come from `-c mcp_servers.<name>.*`
 *    TOML overrides. `--ignore-user-config` keeps the user's own ~/.codex
 *    servers, model and (danger-full-access!) sandbox out of these runs without
 *    editing their file.
 *  - MCP calls are refused as "requires approval" unless the server is marked
 *    `default_tools_approval_mode="approve"`.
 *  - `codex exec resume` accepts neither -C nor -s, so cwd comes from the spawn
 *    and the sandbox from a `-c` override — both set the same way for both paths.
 *  - The prompt goes in on stdin (`-`), so a long turn can't hit an argv limit.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OperatorEvent, Runner, RunnerContext } from "../claudeOperator.js";

function codexCandidates(): string[] {
  const home = os.homedir();
  return [
    process.env.MB_CODEX_PATH,
    path.join(home, ".npm-global", "bin", "codex"),
    path.join(home, ".local", "bin", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ].filter((p): p is string => !!p);
}

export function resolveCodexBinary(): { path: string; found: boolean } {
  for (const c of codexCandidates()) {
    try {
      if (fs.existsSync(c)) return { path: c, found: true };
    } catch { /* ignore */ }
  }
  return { path: "codex", found: false };
}

/** `model = "..."` from ~/.codex/config.toml, or undefined. Read-only; never written. */
function userCodexModel(): string | undefined {
  try {
    const toml = fs.readFileSync(path.join(os.homedir(), ".codex", "config.toml"), "utf8");
    return /^model\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
  } catch { return undefined; }
}

/** Falforge's five effort levels onto Codex's four (max → xhigh). */
function codexEffort(effort: string | undefined): string | undefined {
  if (!effort) return undefined;
  return effort === "max" ? "xhigh" : effort;
}

/** A TOML basic string. JSON's escaping is a subset of TOML's, so this is exact
 *  for the paths and identifiers we put through it. */
const tomlStr = (v: string) => JSON.stringify(v);

export const codexRunner: Runner = {
  id: "codex",
  label: "OpenAI Codex",
  // ponytail: static list; read `codex` model catalog when it grows one.
  models: [
    { id: "gpt-5.6-luna", label: "Luna" },
    { id: "gpt-5.6-terra", label: "Terra" },
    { id: "gpt-5.6-sol", label: "Sol" },
    { id: "gpt-5.5", label: "GPT-5.5" },
  ],
  resolveBinary: resolveCodexBinary,
  loginArgs: ["login"],
  statusArgs: ["login", "status"],
  loggedIn: (out, code) => code === 0 && /logged in/i.test(out),
  notFoundMessage:
    "The Codex CLI isn't installed. Install it (`npm i -g @openai/codex`), run `codex login` once, then reopen this panel.",
  stdinText: (ctx) => ctx.message,
  spawnArgs(ctx: RunnerContext): string[] {
    const env = Object.entries(ctx.mcp.env).map(([k, v]) => `${k}=${tomlStr(v)}`).join(",");
    const args = ["exec"];
    if (ctx.sessionId) args.push("resume", ctx.sessionId);
    args.push(
      "--json",
      // Keep the user's own MCP servers, model default and sandbox_mode out of
      // operator runs without touching their config file.
      "--ignore-user-config",
      "--skip-git-repo-check", // REPOS_DIR is not a git repo
      "-c", `mcp_servers.falforge.command=${tomlStr(ctx.mcp.command)}`,
      "-c", `mcp_servers.falforge.args=[${ctx.mcp.args.map(tomlStr).join(",")}]`,
      "-c", `mcp_servers.falforge.env={${env}}`,
      "-c", `mcp_servers.falforge.default_tools_approval_mode="approve"`,
      // No shell writes and no Codex-native web search: the operator generates
      // through our tools, it doesn't run the user's machine.
      "-c", `sandbox_mode="read-only"`,
      "-c", `tools.web_search=false`,
    );
    // The user's own MCP servers, re-declared: --ignore-user-config drops their
    // config.toml wholesale, so anything they switched on in Settings has to be
    // handed back in as overrides. ponytail: the OAuth token store is assumed to
    // survive --ignore-user-config — unverified, no signed-in Codex to test
    // against. If a connector comes back needing auth mid-run, that is the bug.
    for (const c of ctx.connectors ?? []) {
      const k = `mcp_servers.${c.name}`;
      if (c.url) args.push("-c", `${k}.url=${tomlStr(c.url)}`);
      else if (c.command) {
        args.push("-c", `${k}.command=${tomlStr(c.command)}`);
        if (c.args?.length) args.push("-c", `${k}.args=[${c.args.map(tomlStr).join(",")}]`);
        if (c.env && Object.keys(c.env).length) {
          args.push("-c", `${k}.env={${Object.entries(c.env).map(([n, v]) => `${n}=${tomlStr(v)}`).join(",")}}`);
        }
      } else continue;
      args.push("-c", `${k}.default_tools_approval_mode="approve"`);
    }
    const effort = codexEffort(ctx.effort ?? (ctx.review ? "low" : undefined));
    if (effort) args.push("-c", `model_reasoning_effort=${tomlStr(effort)}`);
    // --ignore-user-config also drops the user's chosen model, and Codex's
    // compiled-in default answered "at capacity" in testing. Fall back to the
    // model line in ~/.codex/config.toml, read-only. The review pass rides on
    // low effort rather than a cheap-model guess.
    const model = (!ctx.review && ctx.model) || userCodexModel();
    if (model) args.push("-m", model);
    args.push("-"); // prompt on stdin
    return args;
  },
  parseLine,
};

function textOf(result: unknown): string {
  const content = (result as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? (c as { text?: string }).text ?? "" : ""))
    .filter(Boolean)
    .join("\n");
}

function msgOf(v: unknown): string {
  if (typeof v === "string") return v;
  const m = (v as { message?: unknown } | null)?.message;
  return typeof m === "string" ? m : "";
}

/** Codex `--json` JSONL → Falforge events. Exported for the unit test. */
export function parseLine(obj: Record<string, unknown>): OperatorEvent[] {
  const t = obj.type;

  if (t === "thread.started" && typeof obj.thread_id === "string") {
    return [{ type: "session", sessionId: obj.thread_id }];
  }
  if (t === "error") {
    return [{ type: "error", message: msgOf(obj) || "codex error" }];
  }
  if (t === "turn.completed") {
    return [{ type: "done", result: "", isError: false }];
  }
  if (t === "turn.failed") {
    return [{ type: "done", result: msgOf(obj.error), isError: true }];
  }

  if (t === "item.started" || t === "item.completed") {
    const item = obj.item as Record<string, unknown> | undefined;
    if (!item || typeof item !== "object") return [];
    const id = typeof item.id === "string" ? item.id : "";
    if (item.type === "agent_message") {
      // Only on completion — item.started carries no text yet.
      const text = typeof item.text === "string" ? item.text : "";
      return t === "item.completed" && text.trim() ? [{ type: "text", text }] : [];
    }
    if (item.type === "reasoning") {
      const text = typeof item.text === "string" ? item.text : "";
      return t === "item.completed" && text.trim() ? [{ type: "thinking", text }] : [];
    }
    if (item.type === "mcp_tool_call") {
      // Codex reports the bare tool name plus the server separately; the client
      // renders the same bare name Claude's mcp__falforge__ prefix strips to.
      const tool = typeof item.tool === "string" ? item.tool : "";
      if (t === "item.started") return [{ type: "tool_use", id, tool, input: item.arguments }];
      const err = item.error ? msgOf(item.error) : "";
      return [{
        type: "tool_result",
        id,
        text: err || textOf(item.result),
        isError: item.status === "failed" || !!err,
      }];
    }
  }
  return [];
}
