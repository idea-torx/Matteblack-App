/**
 * The Claude Code runner — `claude -p --output-format stream-json`.
 *
 * This is the original (and default) operator backend; everything here was
 * lifted verbatim out of claudeOperator.ts when the second runner arrived, so
 * the spawned command line is byte-for-byte what it always was.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getClaudeCodePath } from "../../config/userConfig.js";
import type { OperatorEvent, Runner, RunnerContext } from "../claudeOperator.js";

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

/** claude namespaces a server's tools as mcp__<key>__<tool>, where <key> is the
 *  server name with every non-alphanumeric replaced. A bare `mcp__<key>` in
 *  --allowedTools grants every tool that server has. */
export const mcpKey = (name: string) => name.replace(/[^a-zA-Z0-9]/g, "_");

/** Strips the mcp__<serverKey>__ namespace off a tool name for display. */
const TOOL_PREFIX_RE = /^mcp__falforge__/;

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
        } else if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) {
          out.push({ type: "thinking", text: b.thinking });
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

export const claudeRunner: Runner = {
  id: "claude",
  label: "Claude Code",
  models: [
    { id: "claude-opus-5", label: "Opus 5" },
    { id: "claude-opus-4-8", label: "Opus 4.8" },
    { id: "claude-fable-5-1", label: "Fable 5.1" },
  ],
  resolveBinary: resolveClaudeBinary,
  loginArgs: ["auth", "login", "--claudeai"],
  statusArgs: ["auth", "status", "--json"],
  loggedIn: (out) => /"loggedIn":\s*true/.test(out),
  notFoundMessage:
    "Claude Code isn't installed. Install it, run `claude` once to sign in to your subscription, then reopen this panel.",
  spawnArgs(ctx: RunnerContext): string[] {
    // The user's own MCP servers (Settings → Connectors). --strict-mcp-config
    // loads ONLY --mcp-config, so it has to come off for any of them to exist —
    // which also readmits the rest of the user's servers. They stay unusable:
    // --allowedTools is still an explicit allowlist, and only the connectors the
    // user switched on get a grant. A `falforge` entry in their own config is
    // shadowed by ours, same name, so the tool namespace is unchanged.
    const grants = (ctx.connectors ?? []).map((c) => `mcp__${mcpKey(c.name)}`);
    const args = [
      "-p", ctx.message,
      "--output-format", "stream-json",
      "--verbose", // required for stream-json to emit intermediate events
      "--mcp-config", ctx.mcpConfigPath,
      ...(grants.length ? [] : ["--strict-mcp-config"]),
      "--allowedTools", [...ctx.allowedTools, ...grants].join(","),
      "--append-system-prompt", ctx.systemPrompt,
      // 350k: below this the operator (50-60k base context + tool output)
      // re-compacted every few calls, 1-2 min each. User-set ceiling.
      "--autocompact", "350000",
    ];
    if (ctx.sessionId) args.push("--resume", ctx.sessionId);
    // ponytail: cheapest model for the bookkeeping pass, unless one was asked for.
    const model = ctx.model ?? (ctx.review ? "haiku" : undefined);
    if (model) args.push("--model", model);
    if (ctx.effort) args.push("--effort", ctx.effort);
    return args;
  },
  parseLine: parseStreamJsonLine,
};
