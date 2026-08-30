/**
 * GitHub connection — brokered entirely through the user's own `gh` CLI.
 *
 * Same principle as the Claude operator: the app never holds a credential. `gh`
 * keeps the OAuth token in the OS keyring, we shell out to it, and "connect"
 * means running gh's own device-code web login rather than asking anyone to
 * paste a personal access token.
 *
 * Repos the user picks are shallow-cloned under <dataDir>/repos so the operator
 * (which runs on this machine) can read them with its normal file tools.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config/runtime.js";

export const REPOS_DIR = path.join(DATA_DIR, "repos");
const STORE_PATH = path.join(DATA_DIR, "repos.json");

export type Repo = {
  /** owner/name — the natural id; also the clone directory (slashes flattened). */
  nameWithOwner: string;
  description: string;
  defaultBranch: string;
  private: boolean;
  /** Absolute clone path, or "" while the clone is still running / failed. */
  dir: string;
  addedAt: string;
  syncedAt: string;
  /** Last clone/pull failure, surfaced in the panel. */
  error?: string;
};

// ---------------------------------------------------------------------------
// Locating gh
// ---------------------------------------------------------------------------

/** GUI apps don't inherit the login shell's PATH, so bare `gh` often misses. */
export function resolveGhBinary(): string | null {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const win = process.platform === "win32";
  const candidates = [
    process.env.MB_GH_PATH || "",
    win ? "C:\\Program Files\\GitHub CLI\\gh.exe" : "/opt/homebrew/bin/gh",
    win ? "" : "/usr/local/bin/gh",
    win ? "" : "/usr/bin/gh",
    path.join(home, ".local", "bin", win ? "gh.exe" : "gh"),
  ];
  for (const c of candidates) {
    if (!c) continue;
    try { if (fs.existsSync(c)) return c; } catch { /* unreadable path */ }
  }
  return null;
}

export function run(bin: string, args: string[], opts: { cwd?: string; input?: string; timeoutMs?: number } = {}):
  Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, opts.timeoutMs ?? 120_000);
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(e) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
    if (opts.input !== undefined) { child.stdin.write(opts.input); }
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Status + auth
// ---------------------------------------------------------------------------

export type GhStatus = { installed: boolean; authenticated: boolean; login: string };

export async function ghStatus(): Promise<GhStatus> {
  const bin = resolveGhBinary();
  if (!bin) return { installed: false, authenticated: false, login: "" };
  const r = await run(bin, ["auth", "status"], { timeoutMs: 15_000 });
  // gh prints the account line to stderr on older versions, stdout on newer.
  const out = `${r.stdout}\n${r.stderr}`;
  const login = /account (\S+)/.exec(out)?.[1] || "";
  return { installed: true, authenticated: r.code === 0 && !!login, login };
}

/** One `gh api` call, parsed. Throws with gh's own message on failure. */
export async function ghApi<T>(apiPath: string): Promise<T> {
  const bin = resolveGhBinary();
  if (!bin) throw new Error("The GitHub CLI (gh) isn't installed.");
  const r = await run(bin, ["api", apiPath, "--paginate"], { timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(r.stderr.trim() || `gh api ${apiPath} failed`);
  // --paginate concatenates one JSON array per page; stitch them back together.
  const text = r.stdout.trim().replace(/\]\s*\[/g, ",");
  return JSON.parse(text) as T;
}

/**
 * Start gh's device-code login and return the one-time code to show the user.
 * The child is left running: it polls GitHub and writes the token to the
 * keyring once the user finishes in the browser, so the caller just polls
 * ghStatus() until `authenticated` flips.
 */
export function ghLoginStart(): Promise<{ code: string; url: string }> {
  const bin = resolveGhBinary();
  if (!bin) return Promise.reject(new Error("The GitHub CLI (gh) isn't installed."));
  return new Promise((resolve, reject) => {
    const child = spawn(
      bin,
      ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--scopes", "repo,read:org"],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    let buf = "";
    const settle = setTimeout(() => { try { child.kill(); } catch { /* gone */ } reject(new Error("gh didn't return a login code in time.")); }, 30_000);
    const scan = (chunk: string) => {
      buf += chunk;
      const m = /one-time code:\s*([A-Z0-9-]{4,})/i.exec(buf);
      if (m) {
        clearTimeout(settle);
        // Leave the child alive to finish the poll; unref so it can't hold the
        // server open. gh opens the browser itself once it emits the code.
        child.unref();
        resolve({ code: m[1], url: "https://github.com/login/device" });
      }
    };
    child.stdout.on("data", (d) => scan(d.toString()));
    child.stderr.on("data", (d) => scan(d.toString()));
    child.on("error", (e) => { clearTimeout(settle); reject(e); });
    child.on("close", () => { clearTimeout(settle); reject(new Error(buf.trim() || "gh auth login exited without a code.")); });
    // gh waits on "Press Enter to open github.com in your browser".
    child.stdin.write("\n");
  });
}

// ---------------------------------------------------------------------------
// The user's chosen repos
// ---------------------------------------------------------------------------

/** owner/name → a single flat directory name, safe on every filesystem. */
export function repoDirName(nameWithOwner: string): string {
  return nameWithOwner.replace(/[^A-Za-z0-9._-]+/g, "__").slice(0, 128);
}

export function readStore(): Repo[] {
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as Repo[]) : [];
  } catch { return []; }
}

export function writeStore(repos: Repo[]): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(repos, null, 2));
}

/**
 * Shallow-clone (or fast-forward) a repo into REPOS_DIR via `gh repo clone`,
 * which reuses gh's credential so private repos work without a token here.
 */
export async function cloneOrPull(nameWithOwner: string): Promise<{ dir: string; error?: string }> {
  const bin = resolveGhBinary();
  if (!bin) return { dir: "", error: "The GitHub CLI (gh) isn't installed." };
  fs.mkdirSync(REPOS_DIR, { recursive: true });
  const dir = path.join(REPOS_DIR, repoDirName(nameWithOwner));
  if (fs.existsSync(path.join(dir, ".git"))) {
    const r = await run(bin, ["repo", "sync", "--source", nameWithOwner], { cwd: dir, timeoutMs: 300_000 });
    return r.code === 0 ? { dir } : { dir, error: r.stderr.trim() || "sync failed" };
  }
  // ponytail: depth-1 clone — enough for reading current code as context.
  // Drop --depth if history/blame ever becomes part of the ask.
  const r = await run(bin, ["repo", "clone", nameWithOwner, dir, "--", "--depth", "1"], { timeoutMs: 600_000 });
  if (r.code !== 0) return { dir: "", error: r.stderr.trim() || "clone failed" };
  return { dir };
}

export function removeClone(nameWithOwner: string): void {
  const dir = path.join(REPOS_DIR, repoDirName(nameWithOwner));
  // Only ever inside REPOS_DIR — repoDirName strips separators, so a crafted
  // name can't escape via ../ .
  if (dir.startsWith(REPOS_DIR + path.sep)) fs.rmSync(dir, { recursive: true, force: true });
}

/** Rough size + file count, for the panel. Cheap enough at depth-1. */
export function repoStats(dir: string): { files: number; bytes: number } {
  let files = 0, bytes = 0;
  const walk = (d: string, depth: number) => {
    if (depth > 12) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else { files++; try { bytes += fs.statSync(p).size; } catch { /* raced */ } }
    }
  };
  if (dir) walk(dir, 0);
  return { files, bytes };
}
