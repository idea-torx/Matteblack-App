import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLine, codexRunner } from "./codex.ts";
import type { OperatorEvent, RunnerContext } from "../claudeOperator.ts";

// Captured verbatim from `codex exec --json` (codex-cli 0.149.0).
const LINES = [
  `{"type":"thread.started","thread_id":"01a05faf-9380-7e92-9626-acc3c44599ef"}`,
  `{"type":"turn.started"}`,
  `{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I’m checking the available tools."}}`,
  `{"type":"item.started","item":{"id":"item_1","type":"mcp_tool_call","server":"falforge","tool":"list_skills","arguments":{},"result":null,"error":null,"status":"in_progress"}}`,
  `{"type":"item.completed","item":{"id":"item_1","type":"mcp_tool_call","server":"falforge","tool":"list_skills","arguments":{},"result":{"content":[{"type":"text","text":"17 skill(s):"}]},"status":"completed"}}`,
  `{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"There are 17 skills."}}`,
  `{"type":"turn.completed","usage":{"input_tokens":48146,"output_tokens":138}}`,
].map((l) => JSON.parse(l) as Record<string, unknown>);

const evts = LINES.flatMap(parseLine);
const find = (t: string) => evts.find((e) => e.type === t) as OperatorEvent;

test("thread.started → session", () => {
  assert.equal((find("session") as { sessionId: string }).sessionId, "01a05faf-9380-7e92-9626-acc3c44599ef");
});

test("agent_message → text, only on completion", () => {
  const texts = evts.filter((e) => e.type === "text") as { text: string }[];
  assert.equal(texts.length, 2);
  assert.match(texts[1].text, /17 skills/);
});

test("mcp_tool_call start/end → tool_use + tool_result with the bare name", () => {
  const use = find("tool_use") as { id: string; tool: string };
  assert.equal(use.tool, "list_skills"); // matches Claude's stripped mcp__falforge__ name
  const res = find("tool_result") as { id: string; text: string; isError: boolean };
  assert.equal(res.id, use.id);
  assert.match(res.text, /17 skill/);
  assert.equal(res.isError, false);
});

test("turn.completed → done, not an error", () => {
  assert.equal((find("done") as { isError: boolean }).isError, false);
});

test("a failed tool call carries the error text", () => {
  const [e] = parseLine(JSON.parse(
    `{"type":"item.completed","item":{"id":"i","type":"mcp_tool_call","server":"falforge","tool":"x","result":null,"error":{"message":"nope"},"status":"failed"}}`,
  ));
  assert.deepEqual(e, { type: "tool_result", id: "i", text: "nope", isError: true });
});

test("turn.failed / error → done(isError) and error", () => {
  assert.equal((parseLine({ type: "turn.failed", error: { message: "at capacity" } })[0] as { isError: boolean }).isError, true);
  assert.equal((parseLine({ type: "error", message: "boom" })[0] as { message: string }).message, "boom");
  assert.equal(parseLine({ type: "item.completed", item: { type: "reasoning", id: "r" } }).length, 0);
});

// --- the command line ---------------------------------------------------------
const ctx = (over: Partial<RunnerContext> = {}): RunnerContext => ({
  message: "hi", review: false, systemPrompt: "sys", allowedTools: [],
  mcp: { command: "/bin/node", args: ["/x/index.js"], env: { MB_TOOLS: "list_skills" } },
  mcpConfigPath: "/x/cfg.json", ...over,
});

test("spawnArgs: read-only sandbox, our MCP server, prompt on stdin", () => {
  const a = codexRunner.spawnArgs(ctx()).join(" ");
  assert.match(a, /^exec --json/);
  assert.match(a, /sandbox_mode="read-only"/);
  assert.match(a, /mcp_servers\.falforge\.default_tools_approval_mode="approve"/);
  assert.match(a, /mcp_servers\.falforge\.env=\{MB_TOOLS="list_skills"\}/);
  assert.equal(codexRunner.spawnArgs(ctx()).at(-1), "-");
  assert.equal(codexRunner.stdinText?.(ctx()), "hi");
});

test("spawnArgs: resume comes before the flags; max effort becomes xhigh", () => {
  const a = codexRunner.spawnArgs(ctx({ sessionId: "sess", effort: "max" }));
  assert.deepEqual(a.slice(0, 3), ["exec", "resume", "sess"]);
  assert.ok(a.includes('model_reasoning_effort="xhigh"'));
});

test("reasoning item → thinking, only on completion", () => {
  assert.deepEqual(parseLine({ type: "item.started", item: { id: "r1", type: "reasoning", text: "" } }), []);
  assert.deepEqual(parseLine({ type: "item.completed", item: { id: "r1", type: "reasoning", text: "use bridge" } }), [{ type: "thinking", text: "use bridge" }]);
});
