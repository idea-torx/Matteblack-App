/**
 * Resolving a user-or-agent supplied filesystem path for the MCP bridge's
 * read_local_file / list_local_dir tools.
 *
 * ponytail: the guard is a secrets blocklist, not a sandbox. This is the user's
 * own machine and they asked for reach across it, so a root allowlist would
 * just be a list of everywhere they work. What it does stop is the boring
 * accident — a brief or README that talks the agent into opening .env or an ssh
 * key and quoting it into a chat transcript. Swap in an explicit allowlist if
 * this ever runs anywhere but a single user's desktop.
 */
import os from "node:os";
import path from "node:path";

export const SECRET_PATH_RE =
  /(^|\/)(\.env(\.|$)|\.ssh(\/|$)|\.aws(\/|$)|\.gnupg(\/|$)|id_rsa|id_ed25519|\.netrc$|\.pgpass$|credentials(\.json)?$|keychain)/i;

export type ResolvedPath = { path: string } | { error: string };

export function resolveLocalPath(raw: unknown, homeDir: string = os.homedir()): ResolvedPath {
  const input = typeof raw === "string" ? raw.trim() : "";
  if (!input) return { error: "A `path` is required." };
  const expanded = input.startsWith("~/") ? path.join(homeDir, input.slice(2)) : input;
  if (!path.isAbsolute(expanded)) {
    return { error: `Path must be absolute (or start with ~/): ${input}` };
  }
  // Resolve BEFORE the secrets check so `/home/u/project/../.ssh/id_rsa`
  // is tested as the path it actually reaches, not as it was written.
  const resolved = path.resolve(expanded);
  if (SECRET_PATH_RE.test(resolved)) {
    return {
      error: `Refusing to read ${resolved} — it looks like a credentials file. Ask the user to paste what they need from it.`,
    };
  }
  return { path: resolved };
}
