/**
 * Runner-independent tool allowlisting for the stdio MCP server.
 *
 * Claude Code has `--allowedTools`; other CLIs (Codex, …) have nothing
 * equivalent for MCP tools, so the restriction has to live where every runner
 * meets it — inside this server. `MB_TOOLS=generate_media,remember` limits both
 * tools/list and tools/call to those names for the lifetime of the process.
 * Unset (or empty) means "everything", which is what Claude Desktop gets.
 */
export function parseToolAllowlist(v: string | undefined): Set<string> | null {
  const names = (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return names.length > 0 ? new Set(names) : null;
}
