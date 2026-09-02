import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLine, opencodeRunner } from "./opencode.ts";
import type { OperatorEvent, RunnerContext } from "../claudeOperator.ts";

// Captured verbatim from `opencode run --format json` (opencode 1.18.21),
// against our own MCP server. Trimmed only where noted.
const LINES = [
  `{"type":"step_start","timestamp":1788323876000,"sessionID":"ses_f9f9747cdffeMgiDkKCqi5ePG1","part":{"id":"prt_a","messageID":"msg_a","sessionID":"ses_f9f9747cdffeMgiDkKCqi5ePG1","type":"step-start"}}`,
  `{"type":"text","timestamp":1788323876100,"sessionID":"ses_f9f9747cdffeMgiDkKCqi5ePG1","part":{"id":"prt_b","messageID":"msg_a","sessionID":"ses_f9f9747cdffeMgiDkKCqi5ePG1","type":"text","text":"I'll call the list_models tool.","time":{"start":1788323876050,"end":1788323876099}}}`,
  `{"type":"tool_use","timestamp":1788323876760,"sessionID":"ses_f9f9747cdffeMgiDkKCqi5ePG1","part":{"type":"tool","tool":"falforge_list_models","callID":"call_8387aab705724ac49c39e533","state":{"status":"completed","input":{},"output":"Available generation models:","time":{"start":1,"end":2}},"id":"prt_c","sessionID":"ses_f9f9747cdffeMgiDkKCqi5ePG1","messageID":"msg_a"}}`,
  `{"type":"step_finish","timestamp":1788323876800,"sessionID":"ses_f9f9747cdffeMgiDkKCqi5ePG1","part":{"id":"prt_d","reason":"tool-calls","type":"step-finish","tokens":{"total":5632},"cost":0}}`,
  `{"type":"text","timestamp":1788323880000,"sessionID":"ses_f9f9747cdffeMgiDkKCqi5ePG1","part":{"id":"prt_e","messageID":"msg_b","type":"text","text":"50+ models across image, video and audio.","time":{"start":1788323879000,"end":1788323879900}}}`,
  `{"type":"step_finish","timestamp":1788323880100,"sessionID":"ses_f9f9747cdffeMgiDkKCqi5ePG1","part":{"id":"prt_f","reason":"stop","type":"step-finish","tokens":{"total":9000},"cost":0}}`,
].map((l) => JSON.parse(l) as Record<string, unknown>);

const evts = LINES.flatMap(parseLine);
const find = (t: string) => evts.find((e) => e.type === t) as OperatorEvent;

test("step_start → session", () => {
  assert.equal((find("session") as { sessionId: string }).sessionId, "ses_f9f9747cdffeMgiDkKCqi5ePG1");
});

test("text parts become text events", () => {
  const texts = evts.filter((e) => e.type === "text") as { text: string }[];
  assert.equal(texts.length, 2);
  assert.match(texts[1].text, /50\+ models/);
});

test("a completed tool part yields tool_use + tool_result, bare name", () => {
  const use = find("tool_use") as { id: string; tool: string };
  assert.equal(use.tool, "list_models"); // falforge_ prefix stripped, like Claude's mcp__falforge__
  const res = find("tool_result") as { id: string; text: string; isError: boolean };
  assert.equal(res.id, use.id);
  assert.match(res.text, /Available generation models/);
  assert.equal(res.isError, false);
});

test("only step_finish reason=stop ends the turn", () => {
  const dones = evts.filter((e) => e.type === "done");
  assert.equal(dones.length, 1);
  assert.equal((dones[0] as { isError: boolean }).isError, false);
});

test("a failed tool call carries the error text", () => {
  // Captured live with the app unreachable.
  const out = parseLine(JSON.parse(
    `{"type":"tool_use","sessionID":"s","part":{"type":"tool","tool":"falforge_list_models","callID":"call_1","state":{"status":"error","input":{},"error":"Could not reach the Fal Forge app at http://127.0.0.1:3001 (fetch failed). Is the Fal Forge app still open?","time":{"start":1,"end":2}},"id":"p"}}`,
  ));
  assert.equal(out.length, 2);
  assert.deepEqual(out[1], { type: "tool_result", id: "call_1", text: "Could not reach the Fal Forge app at http://127.0.0.1:3001 (fetch failed). Is the Fal Forge app still open?", isError: true });
});

test("a running tool part is tool_use only; a streaming text part waits for time.end", () => {
  const running = parseLine({ type: "tool_use", part: { type: "tool", tool: "falforge_generate_media", callID: "c", state: { status: "running", input: { prompt: "x" } } } });
  assert.deepEqual(running, [{ type: "tool_use", id: "c", tool: "generate_media", input: { prompt: "x" } }]);
  assert.deepEqual(parseLine({ type: "text", part: { type: "text", text: "half", time: { start: 1 } } }), []);
  assert.deepEqual(parseLine({ type: "reasoning", part: { type: "reasoning", text: "hm", time: { start: 1, end: 2 } } }), [{ type: "thinking", text: "hm" }]);
});

test("error line → error event", () => {
  assert.equal(
    (parseLine(JSON.parse(`{"type":"error","sessionID":"s","error":{"name":"UnknownError","data":{"message":"model at capacity"}}}`))[0] as { message: string }).message,
    "model at capacity",
  );
});

// --- the command line + config -----------------------------------------------
const ctx = (over: Partial<RunnerContext> = {}): RunnerContext => ({
  message: "hi", review: false, systemPrompt: "sys", allowedTools: [],
  mcp: { command: "/bin/node", args: ["/x/index.js"], env: { MB_TOOLS: "list_skills" } },
  mcpConfigPath: "/x/cfg.json", ...over,
});

test("spawnArgs: json stream, --auto, prompt last", () => {
  const a = opencodeRunner.spawnArgs(ctx());
  assert.deepEqual(a.slice(0, 3), ["run", "--format", "json"]);
  assert.ok(a.includes("--auto"));
  assert.equal(a.at(-1), "hi");
  assert.equal(a[a.indexOf("-m") + 1], "opencode/big-pickle");
  assert.ok(!a.includes("--variant"));
});

test("spawnArgs: resume by session id; max effort → variant", () => {
  const a = opencodeRunner.spawnArgs(ctx({ sessionId: "ses_1", effort: "max", model: "opencode-go/glm-5.3" }));
  assert.deepEqual(a.slice(3, 5), ["-s", "ses_1"]);
  assert.equal(a[a.indexOf("--variant") + 1], "max");
  assert.equal(a[a.indexOf("-m") + 1], "opencode-go/glm-5.3");
  assert.equal(opencodeRunner.spawnArgs(ctx({ effort: "xhigh" }))[
    opencodeRunner.spawnArgs(ctx({ effort: "xhigh" })).indexOf("--variant") + 1], "high");
});

test("env: our MCP server, deny-by-default permissions, connectors re-declared", () => {
  const cfg = JSON.parse(opencodeRunner.env!(ctx({ connectors: [{ name: "notion", url: "https://mcp.notion.com/mcp" }] })).OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(cfg.mcp.falforge, { type: "local", command: ["/bin/node", "/x/index.js"], environment: { MB_TOOLS: "list_skills" }, enabled: true });
  assert.deepEqual(cfg.mcp.notion, { type: "remote", url: "https://mcp.notion.com/mcp", enabled: true });
  assert.equal(cfg.permission["*"], "deny");
  assert.equal(cfg.permission["falforge_*"], "allow");
  assert.equal(cfg.permission["notion_*"], "allow");
  assert.equal(cfg.permission.bash, undefined); // covered by the "*" deny
});

test("loggedIn reads the credential count", () => {
  assert.equal(opencodeRunner.loggedIn("┌  Credentials\n│\n●  OpenCode Go api\n│\n└  1 credentials", 0), true);
  assert.equal(opencodeRunner.loggedIn("└  0 credentials", 0), false);
  assert.equal(opencodeRunner.loggedIn("1 credentials", 1), false);
});
