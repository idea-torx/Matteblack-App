/**
 * Pure helpers for the `higgsfield` MCP tool (see index.ts) — kept apart so
 * they can be tested without the MCP bundle.
 */

/** Media URLs printed by `higgsfield … --wait` (or any subcommand), deduped, in order. */
export function mediaUrls(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) {
    const u = m[0].replace(/[.,;]+$/, "");
    if (/\.(png|jpe?g|webp|gif|mp4|webm|mov|mp3|wav|m4a|glb)(\?|$)/i.test(u) && !out.includes(u)) out.push(u);
  }
  return out;
}

/** The subcommands the operator may not run. `auth` prints/rotates the user's
 *  token; `workspace` changes who gets billed. Everything else is a job or a listing. */
export function guardArgs(args: unknown): string[] | { error: string } {
  if (!Array.isArray(args) || !args.length || !args.every((a) => typeof a === "string")) {
    return { error: "`args` must be a non-empty array of strings — the words after `higgsfield` on the command line." };
  }
  const list = args as string[];
  if (list[0] === "auth" || list[0] === "workspace") {
    return { error: `\`higgsfield ${list[0]}\` is the user's to run, not yours. Ask them to sign in from Settings > Connectors.` };
  }
  return list;
}
