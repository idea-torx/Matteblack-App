// Run: npx tsx --test server/operator/connectors.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClaudeMcpList, parseCodexMcpList } from "./connectors.ts";
import { claudeRunner, mcpKey } from "./runners/claude.ts";
import { codexRunner } from "./runners/codex.ts";
import type { RunnerContext } from "./claudeOperator.ts";

// Captured verbatim from `claude mcp list` (there is no --json).
const CLAUDE_OUT = [
  "Checking MCP server health…",
  "",
  "claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ✔ Connected",
  "claude.ai monday.com: https://mcp.monday.com/mcp - ! Needs authentication",
  "claude.ai Clockwise: https://mcp.getclockwise.com/mcp - ✘ Failed to connect — HTTP 502: Error 502 - bad gateway",
  "pencil: /Applications/Pencil.app/Contents/Resources/out/mcp-server --app desktop - ✔ Connected",
  "falforge: /Applications/Fal Forge.app/Contents/MacOS/Fal Forge /x/dist-mcp/index.js - ✔ Connected",
].join("\n");

test("claude mcp list: banner dropped, status + target split, our own server hidden", () => {
  const rows = parseClaudeMcpList(CLAUDE_OUT);
  assert.deepEqual(rows.map((r) => r.name), ["claude.ai Google Drive", "claude.ai monday.com", "claude.ai Clockwise", "pencil"]);
  assert.deepEqual(rows.map((r) => r.status), ["connected", "needs_auth", "unknown", "connected"]);
  assert.equal(rows[0].url, "https://drivemcp.googleapis.com/mcp/v1");
  // A failure message containing " - " must not eat the target.
  assert.equal(rows[2].url, "https://mcp.getclockwise.com/mcp");
  // stdio servers report the command, not a url.
  assert.equal(rows[3].url, undefined);
  assert.match(rows[3].command!, /^\/Applications\/Pencil.*--app desktop$/);
});

test("codex mcp list --json: url vs stdio, auth, disabled dropped", () => {
  const rows = parseCodexMcpList(JSON.stringify([
    { name: "notion", enabled: true, transport: { type: "streamable_http", url: "https://mcp.notion.com/mcp" }, auth_status: "unauthenticated" },
    { name: "pencil", enabled: true, transport: { type: "stdio", command: "/bin/pencil", args: ["--app"] }, auth_status: "unsupported" },
    { name: "off", enabled: false, transport: { type: "stdio", command: "/bin/x" }, auth_status: "unsupported" },
  ]));
  assert.deepEqual(rows.map((r) => r.name), ["notion", "pencil"]);
  assert.equal(rows[0].status, "needs_auth");
  assert.equal(rows[1].status, "connected");
  assert.equal(rows[1].command, "/bin/pencil --app");
  assert.deepEqual(parseCodexMcpList("not json"), []);
});

// --- connector → command line -------------------------------------------------
const ctx = (over: Partial<RunnerContext> = {}): RunnerContext => ({
  message: "hi", review: false, systemPrompt: "sys", allowedTools: ["mcp__falforge__generate_media"],
  mcp: { command: "/bin/node", args: ["/x/index.js"], env: { MB_TOOLS: "generate_media" } },
  mcpConfigPath: "/x/cfg.json", ...over,
});

test("claude: no connectors keeps --strict-mcp-config and the grant untouched", () => {
  const a = claudeRunner.spawnArgs(ctx());
  assert.ok(a.includes("--strict-mcp-config"));
  assert.equal(a[a.indexOf("--allowedTools") + 1], "mcp__falforge__generate_media");
});

test("claude: an enabled connector drops --strict and adds a bare server grant", () => {
  const a = claudeRunner.spawnArgs(ctx({ connectors: [{ name: "claude.ai Figma" }] }));
  assert.ok(!a.includes("--strict-mcp-config"));
  assert.equal(a[a.indexOf("--allowedTools") + 1], "mcp__falforge__generate_media,mcp__claude_ai_Figma");
  assert.equal(mcpKey("claude.ai Figma"), "claude_ai_Figma");
});

test("codex: connectors are re-declared as -c overrides, since --ignore-user-config drops them", () => {
  const a = codexRunner.spawnArgs(ctx({
    connectors: [
      { name: "notion", url: "https://mcp.notion.com/mcp" },
      { name: "local", command: "/bin/x", args: ["--y"], env: { K: "v" } },
    ],
  })).join(" ");
  assert.ok(a.includes("--ignore-user-config"));
  assert.match(a, /mcp_servers\.notion\.url="https:\/\/mcp\.notion\.com\/mcp"/);
  assert.match(a, /mcp_servers\.notion\.default_tools_approval_mode="approve"/);
  assert.match(a, /mcp_servers\.local\.command="\/bin\/x" -c mcp_servers\.local\.args=\["--y"\] -c mcp_servers\.local\.env=\{K="v"\}/);
});
