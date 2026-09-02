/** A visible step in the "thinking" space: a reasoning block or a tool call. */
export type Step =
  | { id: string; kind: "thinking"; text: string }
  | { id: string; kind: "tool"; label: string; status: "running" | "ready" | "failed" };

/** "list_local_dir" -> "List local dir". Last resort for a tool with no phrase. */
export function humanizeTool(tool: string): string {
  const words = tool.replace(/^mcp__[^_]*__/, "").replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** What the Thinking pill says: the newest tool call still running, or
 * undefined — which the pill renders as "Thinking…". Between two tool calls,
 * and while the reply streams, nothing is running and the label falls back, so
 * the line tracks the agent instead of freezing on the last thing it did. */
export function stepLabel(steps: Step[]): string | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const st = steps[i];
    if (st.kind === "tool" && st.status === "running") return st.label;
  }
  return undefined;
}
