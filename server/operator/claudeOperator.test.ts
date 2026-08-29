import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStreamJsonLine, type OperatorEvent } from "./claudeOperator.ts";

// Realistic `claude -p --output-format stream-json --verbose` event shapes.
const FIXTURES: Record<string, Record<string, unknown>> = {
  init: { type: "system", subtype: "init", session_id: "sess-123", tools: ["mcp__falforge__generate_media"], model: "claude-sonnet-4-6" },
  assistantText: { type: "assistant", message: { content: [{ type: "text", text: "Generating a red cube for you." }] }, session_id: "sess-123" },
  assistantToolUse: {
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "toolu_1", name: "mcp__falforge__generate_media", input: { kind: "image", prompt: "red cube", tier: "quick" } }] },
    session_id: "sess-123",
  },
  toolResult: {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "✅ text_to_image complete.\nResult: /uploads/x.jpg" }], is_error: false }] },
    session_id: "sess-123",
  },
  result: { type: "result", subtype: "success", result: "Done — the cube is on your canvas.", session_id: "sess-123", is_error: false, total_cost_usd: 0.01 },
  resultError: { type: "result", subtype: "error_during_execution", result: "", session_id: "sess-123", is_error: true },
};

function first(evts: OperatorEvent[], type: string): OperatorEvent {
  const e = evts.find((x) => x.type === type);
  assert.ok(e, `expected an event of type ${type}, got: ${JSON.stringify(evts)}`);
  return e;
}

test("init → session event", () => {
  const e = first(parseStreamJsonLine(FIXTURES.init), "session");
  assert.equal((e as { sessionId: string }).sessionId, "sess-123");
});

test("assistant text → text event", () => {
  const e = first(parseStreamJsonLine(FIXTURES.assistantText), "text");
  assert.match((e as { text: string }).text, /red cube/);
});

test("assistant tool_use → tool_use with stripped name", () => {
  const e = first(parseStreamJsonLine(FIXTURES.assistantToolUse), "tool_use") as { tool: string; id: string; input: { kind: string } };
  assert.equal(e.tool, "generate_media"); // mcp__falforge__ prefix stripped
  assert.equal(e.id, "toolu_1");
  assert.equal(e.input.kind, "image");
});

test("tool_result → tool_result event with text + id", () => {
  const e = first(parseStreamJsonLine(FIXTURES.toolResult), "tool_result") as { id: string; text: string; isError: boolean };
  assert.equal(e.id, "toolu_1");
  assert.match(e.text, /complete/);
  assert.equal(e.isError, false);
});

test("result success → done event (not error)", () => {
  const e = first(parseStreamJsonLine(FIXTURES.result), "done") as { result: string; sessionId: string; isError: boolean };
  assert.match(e.result, /canvas/);
  assert.equal(e.sessionId, "sess-123");
  assert.equal(e.isError, false);
});

test("result error subtype → done event flagged isError", () => {
  const e = first(parseStreamJsonLine(FIXTURES.resultError), "done") as { isError: boolean };
  assert.equal(e.isError, true);
});

test("unknown/ignored types → no events", () => {
  assert.equal(parseStreamJsonLine({ type: "stream_event", event: {} }).length, 0);
  assert.equal(parseStreamJsonLine({ type: "system", subtype: "other" }).length, 0);
});

test("assistant with both text and tool_use → two events in order", () => {
  const mixed = {
    type: "assistant",
    message: { content: [{ type: "text", text: "Making it now." }, { type: "tool_use", id: "t2", name: "mcp__falforge__generate_media", input: {} }] },
    session_id: "s",
  };
  const evts = parseStreamJsonLine(mixed);
  assert.equal(evts.length, 2);
  assert.equal(evts[0].type, "text");
  assert.equal(evts[1].type, "tool_use");
});
