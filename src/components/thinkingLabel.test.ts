import assert from "node:assert/strict";
import { humanizeTool, stepLabel, type Step } from "./thinkingLabel.ts";

// The pill's label across one turn: idle -> tool -> back to idle -> next tool.
const steps: Step[] = [];
assert.equal(stepLabel(steps), undefined, "no steps reads Thinking…");

steps.push({ id: "a", kind: "thinking", text: "planning" });
assert.equal(stepLabel(steps), undefined, "reasoning alone is not a tool label");

steps.push({ id: "1", kind: "tool", label: "Reading skill: watercolour", status: "running" });
assert.equal(stepLabel(steps), "Reading skill: watercolour");

steps[1] = { ...(steps[1] as Extract<Step, { kind: "tool" }>), status: "ready" };
assert.equal(stepLabel(steps), undefined, "finished tool falls back to Thinking…");

steps.push({ id: "2", kind: "tool", label: "Searching skills", status: "running" });
assert.equal(stepLabel(steps), "Searching skills", "newest running tool wins");

steps.push({ id: "3", kind: "tool", label: "Checking canvas", status: "running" });
assert.equal(stepLabel(steps), "Checking canvas", "two in flight -> the newer one");

steps[3] = { ...(steps[3] as Extract<Step, { kind: "tool" }>), status: "failed" };
assert.equal(stepLabel(steps), "Searching skills", "failed tool drops out, older runner shows");

assert.equal(humanizeTool("list_local_dir"), "List local dir");
assert.equal(humanizeTool("mcp__falforge__get_timeline"), "Get timeline");

console.log("thinkingLabel: ok");
