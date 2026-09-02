/**
 * Exact-match text patch, shared by the `patch_skill` MCP tool.
 *
 * Its own file (with no imports) because the MCP bridge is a standalone bundle
 * that must not pull in the server's config/boot side-effects, and because
 * mcp/index.ts starts a stdio server on import so a test can't reach into it.
 */
export type PatchResult = { ok: true; body: string } | { ok: false; error: string };

export function applyExactPatch(body: string, oldText: string, newText: string): PatchResult {
  const n = body.split(oldText).length - 1;
  if (n === 0) {
    return { ok: false, error: `\`old\` does not appear in the skill. Read it with get_skill and copy the text exactly, whitespace included.` };
  }
  if (n > 1) {
    return { ok: false, error: `\`old\` appears ${n} times. Include more surrounding lines so it matches exactly once.` };
  }
  return { ok: true, body: body.replace(oldText, () => newText) };
}
