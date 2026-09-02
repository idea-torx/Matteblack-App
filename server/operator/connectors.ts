/**
 * Connectors — the user's OWN external MCP servers (Google Drive, Gmail, Figma,
 * Notion, …), surfaced to the in-app operator.
 *
 * The app never sees a credential: every server here is one the user already
 * authorised in their `claude` / `codex` CLI (or on claude.ai, which syncs into
 * Claude Code automatically). We only read the CLIs' server lists, ask them to
 * add a catalog entry, and hand the enabled names back to the runners at spawn
 * time. OAuth happens in the CLI's own browser flow.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { cleanEnv, RUNNERS, type RunnerId } from "./claudeOperator.js";
import { DATA_DIR, ensureDataDir } from "../config/runtime.js";
import { getEnabledConnectors } from "../config/userConfig.js";

export type ConnectorStatus = "connected" | "needs_auth" | "unknown";

export interface Connector {
  runner: RunnerId;
  name: string;
  /** Remote servers. */
  url?: string;
  /** Local stdio servers (command + args, joined for display). */
  command?: string;
  status: ConnectorStatus;
  enabled: boolean;
}

/** What a runner needs at spawn time to wire one enabled connector back in. */
export interface RuntimeConnector {
  name: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Popular remote MCP servers, one click to register with both CLIs.
 *  `id` doubles as the server name: bare-key safe for Codex's TOML overrides
 *  and for Claude's mcp__<key>__ namespacing, which a label like "monday.com"
 *  is not. */
export const CATALOG: { id: string; label: string; url: string; blurb: string }[] = [
  { id: "google-drive", label: "Google Drive", url: "https://drivemcp.googleapis.com/mcp/v1", blurb: "Read docs, sheets and files from Drive." },
  { id: "dropbox", label: "Dropbox", url: "https://mcp.dropbox.com/mcp", blurb: "Files and folders in your Dropbox (open beta)." },
  { id: "gmail", label: "Gmail", url: "https://gmailmcp.googleapis.com/mcp/v1", blurb: "Search and read mail." },
  { id: "higgsfield", label: "Higgsfield", url: "https://mcp.higgsfield.ai/mcp", blurb: "30+ image and video models (Sora, Veo, Kling, Soul) on your Higgsfield plan." },
  { id: "figma", label: "Figma", url: "https://mcp.figma.com/mcp", blurb: "Pull frames, screenshots and design tokens." },
  { id: "notion", label: "Notion", url: "https://mcp.notion.com/mcp", blurb: "Read and write pages and databases." },
  { id: "linear", label: "Linear", url: "https://mcp.linear.app/mcp", blurb: "Issues, projects and cycles." },
  { id: "github", label: "GitHub", url: "https://api.githubcopilot.com/mcp/", blurb: "Repos, issues and pull requests." },
  { id: "atlassian", label: "Atlassian", url: "https://mcp.atlassian.com/v1/mcp", blurb: "Jira and Confluence." },
  { id: "canva", label: "Canva", url: "https://mcp.canva.com/mcp", blurb: "Designs and brand assets." },
  { id: "cloudflare", label: "Cloudflare", url: "https://bindings.mcp.cloudflare.com/mcp", blurb: "Workers, KV, R2 and D1." },
  { id: "monday", label: "monday.com", url: "https://mcp.monday.com/mcp", blurb: "Boards, items and updates." },
];

/** Our own MCP server is registered in the user's CLIs too; it is wired in
 *  separately and is not a "connector". */
const SELF = "falforge";

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/**
 * One line of `claude mcp list` (there is no --json):
 *   `claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ✔ Connected`
 *   `pencil: /path/to/bin --app desktop - ✔ Connected`
 * Anchoring the tail on the status glyph is what keeps a URL or an argument
 * containing " - " from being mistaken for the separator. Everything that does
 * not match (the "Checking MCP server health…" banner, blank lines) is dropped.
 * Exported for the unit test.
 */
export function parseClaudeMcpList(stdout: string): Connector[] {
  const out: Connector[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^(.+?): (.*?) - ([✔!✘])/.exec(line.trim());
    if (!m) continue;
    const [, name, target, glyph] = m;
    if (name === SELF) continue;
    out.push({
      runner: "claude",
      name,
      ...(/^https?:\/\//.test(target) ? { url: target } : { command: target.trim() }),
      status: glyph === "✔" ? "connected" : glyph === "!" ? "needs_auth" : "unknown",
      enabled: false,
    });
  }
  return out;
}

/** `codex mcp list --json` → connectors. Disabled-in-their-config servers are
 *  dropped: Codex won't start them, so offering them here would be a lie. */
export function parseCodexMcpList(stdout: string): Connector[] {
  let rows: unknown;
  try { rows = JSON.parse(stdout); } catch { return []; }
  if (!Array.isArray(rows)) return [];
  const out: Connector[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    const name = typeof r.name === "string" ? r.name : "";
    if (!name || name === SELF || r.enabled === false) continue;
    const t = (r.transport ?? {}) as Record<string, unknown>;
    const auth = String(r.auth_status ?? "");
    out.push({
      runner: "codex",
      name,
      ...(typeof t.url === "string"
        ? { url: t.url }
        : { command: [t.command, ...(Array.isArray(t.args) ? t.args : [])].filter(Boolean).join(" ") }),
      status: /unauthenticated|needs/i.test(auth) ? "needs_auth" : "connected",
      enabled: false,
    });
  }
  return out;
}

/** Run one CLI subcommand with a clean env. Resolves ({stdout:"",code:127}) when
 *  the binary isn't installed, so a missing runner is just an empty list. */
function cli(id: RunnerId, args: string[], timeoutMs = 60_000): Promise<{ stdout: string; code: number | null }> {
  const runner = RUNNERS.find((r) => r.id === id);
  const bin = runner?.resolveBinary();
  if (!bin?.found) return Promise.resolve({ stdout: "", code: 127 });
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawn(bin.path, args, { env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"], shell: /\.(cmd|bat)$/i.test(bin.path) });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stdout += d; });
    child.on("error", () => { clearTimeout(timer); resolve({ stdout, code: 127 }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ stdout, code }); });
  });
}

/** Every MCP server both CLIs know about, with the user's on/off state applied. */
export async function listConnectors(): Promise<Connector[]> {
  const [claude, codex] = await Promise.all([
    // `claude mcp list` health-checks every server, so it is slow (~10s). Only
    // Settings calls this; the operator's hot path reads userConfig instead.
    cli("claude", ["mcp", "list"]).then((r) => parseClaudeMcpList(r.stdout)),
    cli("codex", ["mcp", "list", "--json"]).then((r) => parseCodexMcpList(r.stdout)),
  ]);
  const on = getEnabledConnectors();
  return [...claude, ...codex].map((c) => ({ ...c, enabled: on[c.runner].includes(c.name) }));
}

/** The enabled connectors for one runner, ready to spawn with. Codex needs the
 *  full transport (its `--ignore-user-config` drops the user's own file), so it
 *  pays for a `codex mcp list --json` — cheap, no health checks. */
export async function runtimeConnectors(runner: RunnerId): Promise<RuntimeConnector[]> {
  const names = getEnabledConnectors()[runner];
  if (!names.length) return [];
  if (runner === "claude") return names.map((name) => ({ name })); // tool grant only
  const { stdout } = await cli("codex", ["mcp", "list", "--json"], 20_000);
  let rows: Record<string, unknown>[] = [];
  try { const j = JSON.parse(stdout); if (Array.isArray(j)) rows = j; } catch { /* no codex */ }
  return rows
    .filter((r) => names.includes(r.name as string) && r.enabled !== false && BARE_KEY.test(r.name as string))
    .map((r) => {
      const t = (r.transport ?? {}) as Record<string, unknown>;
      return {
        name: r.name as string,
        url: typeof t.url === "string" ? t.url : undefined,
        command: typeof t.command === "string" ? t.command : undefined,
        args: Array.isArray(t.args) ? (t.args as string[]) : undefined,
        env: t.env && typeof t.env === "object" ? (t.env as Record<string, string>) : undefined,
      };
    });
}

/** Codex takes servers as `-c mcp_servers.<name>.…` dotted paths, where a dot or
 *  a quote in the name would change what key is being set. ponytail: such
 *  servers are skipped rather than escaped — add quoting if a real one shows up. */
const BARE_KEY = /^[A-Za-z0-9_-]+$/;

// ---------------------------------------------------------------------------
// Mutating
// ---------------------------------------------------------------------------

/** Register a catalog entry with every installed CLI. Already-present is a
 *  success, not an error — this button is idempotent by design. */
export async function addConnector(id: string): Promise<{ ok: boolean; error?: string }> {
  const entry = CATALOG.find((c) => c.id === id);
  if (!entry) return { ok: false, error: "unknown connector" };
  const results = await Promise.all([
    cli("claude", ["mcp", "add", "--transport", "http", "-s", "user", entry.id, entry.url], 30_000),
    cli("codex", ["mcp", "add", entry.id, "--url", entry.url], 30_000),
  ]);
  const failed = results.filter((r) => r.code !== 0 && r.code !== 127 && !/already exists/i.test(r.stdout));
  if (failed.length === results.length) return { ok: false, error: failed[0]?.stdout.trim().slice(0, 200) || "both CLIs failed" };
  return { ok: true };
}

/**
 * Start the CLI's own sign-in for one server. Both are fire-and-forget: the user
 * finishes in a browser (Codex) or in the interactive CLI (Claude, which has no
 * headless `mcp auth` — /mcp is the only way in).
 */
export function loginConnector(runner: RunnerId, name: string): void {
  if (runner === "codex") {
    const bin = RUNNERS.find((r) => r.id === "codex")?.resolveBinary();
    if (!bin?.found) return;
    const child = spawn(bin.path, ["mcp", "login", name], { env: cleanEnv(), stdio: "ignore", detached: true });
    child.unref();
    return;
  }
  // Same Terminal trick as the setup installer: an interactive CLI needs a real
  // TTY, and the user needs to see the OAuth prompt.
  ensureDataDir();
  const script = path.join(DATA_DIR, "connector-login.command");
  fs.writeFileSync(
    script,
    `#!/bin/bash\nexport PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"\n` +
      `echo "Type  /mcp  , pick ${JSON.stringify(name)}, and choose Authenticate."\necho\nclaude\n`,
    { mode: 0o755 },
  );
  fs.chmodSync(script, 0o755);
  execFile("open", ["-a", "Terminal", script], (err) => {
    if (err) console.error("[connectors] failed to open Terminal:", err);
  });
}
