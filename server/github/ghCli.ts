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
  /** User-granted authoring. Off by default; the only thing that lets the
   *  agent commit and open a PR. Never enables merging. */
  writable?: boolean;
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

// ---------------------------------------------------------------------------
// Git — real status, branch switching, and the one authoring path
// ---------------------------------------------------------------------------

/** Same PATH problem as gh: a GUI app doesn't inherit the login shell. */
export function resolveGitBinary(): string | null {
  const win = process.platform === "win32";
  for (const c of [
    process.env.MB_GIT_PATH || "",
    win ? "C:\\Program Files\\Git\\cmd\\git.exe" : "/opt/homebrew/bin/git",
    win ? "" : "/usr/bin/git",
    win ? "" : "/usr/local/bin/git",
  ]) {
    if (!c) continue;
    try { if (fs.existsSync(c)) return c; } catch { /* unreadable */ }
  }
  return null;
}

export type GitInfo = {
  branch: string;
  sha: string;
  subject: string;
  author: string;
  committedAt: string;
  /** Uncommitted files in the working tree. */
  dirty: number;
  ahead: number;
  behind: number;
  shallow: boolean;
};

async function git(dir: string, args: string[], timeoutMs = 60_000) {
  const bin = resolveGitBinary();
  if (!bin) return { code: -1, stdout: "", stderr: "git isn't installed." };
  return run(bin, args, { cwd: dir, timeoutMs });
}

/** Live git state for one clone. null when the dir isn't a checkout. */
export async function gitInfo(dir: string): Promise<GitInfo | null> {
  if (!dir || !fs.existsSync(path.join(dir, ".git"))) return null;
  // One log call for the commit, one status for the tree — %x1f separated so a
  // commit subject containing anything can't break the split.
  const log = await git(dir, ["log", "-1", "--format=%h%x1f%s%x1f%an%x1f%cI"]);
  const [sha = "", subject = "", author = "", committedAt = ""] = log.stdout.trim().split("\x1f");
  const branch = (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  const dirty = (await git(dir, ["status", "--porcelain"])).stdout.trim().split("\n").filter(Boolean).length;
  // No upstream (a fresh local branch) → git errors; 0/0 is the honest answer.
  const counts = (await git(dir, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"])).stdout.trim().split(/\s+/);
  const shallow = fs.existsSync(path.join(dir, ".git", "shallow"));
  return {
    branch, sha, subject, author, committedAt,
    dirty,
    behind: Number(counts[0]) || 0,
    ahead: Number(counts[1]) || 0,
    shallow,
  };
}

/** Remote branches, newest-committed first. Straight from GitHub, so it lists
 *  branches this shallow clone has never fetched. */
export async function listBranches(nameWithOwner: string): Promise<string[]> {
  const rows = await ghApi<{ name: string }[]>(`repos/${nameWithOwner}/branches?per_page=100`);
  return rows.map((b) => b.name);
}

/**
 * Point a clone at a branch. Refuses on a dirty tree rather than discarding the
 * agent's uncommitted work — the caller commits or resets first.
 */
export async function checkoutBranch(dir: string, branch: string): Promise<{ error?: string }> {
  const info = await gitInfo(dir);
  if (!info) return { error: "Not a checkout." };
  if (info.dirty) return { error: `${info.dirty} uncommitted change(s) on ${info.branch}. Commit or discard them first.` };
  const f = await git(dir, ["fetch", "origin", branch], 300_000);
  if (f.code !== 0) return { error: f.stderr.trim() || "fetch failed" };
  const c = await git(dir, ["checkout", "-B", branch, "FETCH_HEAD"]);
  if (c.code !== 0) return { error: c.stderr.trim() || "checkout failed" };
  // Track the remote branch so ahead/behind means something afterwards.
  await git(dir, ["branch", "--set-upstream-to", `origin/${branch}`, branch]);
  return {};
}

/** Deepen a shallow clone. Authoring needs it: GitHub rejects a push whose
 *  history stops at a shallow boundary. */
export async function unshallow(dir: string): Promise<{ error?: string }> {
  if (!fs.existsSync(path.join(dir, ".git", "shallow"))) return {};
  const r = await git(dir, ["fetch", "--unshallow"], 900_000);
  return r.code === 0 ? {} : { error: r.stderr.trim() || "fetch --unshallow failed" };
}

/**
 * The ONLY path from this app back to GitHub: stage everything, commit, push
 * the branch, and open a PR if one isn't already open.
 *
 * Hard rules, enforced here rather than in a prompt:
 *  - the repo must be marked writable by the user (checked by the caller),
 *  - never on the default branch — a working branch or nothing,
 *  - merging is not implemented anywhere, deliberately. No `gh pr merge`, no
 *    `git merge`, no push to the default branch. A human merges the PR.
 */
export async function commitAndPush(opts: {
  dir: string; nameWithOwner: string; defaultBranch: string; message: string; branch?: string;
}): Promise<{ branch: string; sha: string; pushed: boolean; prUrl?: string; error?: string }> {
  const bin = resolveGhBinary();
  const { dir, nameWithOwner, defaultBranch, message } = opts;
  const info = await gitInfo(dir);
  if (!info) return { branch: "", sha: "", pushed: false, error: "Not a checkout." };

  const branch = (opts.branch || info.branch).trim();
  if (!/^[\w.\-/]{1,120}$/.test(branch)) return { branch, sha: "", pushed: false, error: "Invalid branch name." };
  if (branch === defaultBranch) {
    return { branch, sha: "", pushed: false, error: `Refusing to commit to ${defaultBranch}. Work on a branch; a human merges the PR.` };
  }
  if (branch !== info.branch) {
    const c = await git(dir, ["checkout", "-B", branch]);
    if (c.code !== 0) return { branch, sha: "", pushed: false, error: c.stderr.trim() || "checkout failed" };
  }

  const un = await unshallow(dir);
  if (un.error) return { branch, sha: "", pushed: false, error: un.error };

  await git(dir, ["add", "-A"]);
  const staged = await git(dir, ["diff", "--cached", "--name-only"]);
  if (!staged.stdout.trim()) return { branch, sha: info.sha, pushed: false, error: "Nothing to commit." };

  const { login } = await ghStatus();
  const who = login || "falforge";
  const c = await git(dir, [
    "-c", `user.name=${who}`, "-c", `user.email=${who}@users.noreply.github.com`,
    "commit", "-m", message,
  ]);
  if (c.code !== 0) return { branch, sha: "", pushed: false, error: c.stderr.trim() || "commit failed" };
  const sha = (await git(dir, ["rev-parse", "--short", "HEAD"])).stdout.trim();

  const p = await git(dir, ["push", "-u", "origin", branch], 600_000);
  if (p.code !== 0) {
    return { branch, sha, pushed: false, error: `${p.stderr.trim() || "push failed"} (if this is an auth error, run \`gh auth setup-git\` once).` };
  }

  if (!bin) return { branch, sha, pushed: true };
  const view = await run(bin, ["pr", "view", branch, "--json", "url", "-q", ".url"], { cwd: dir, timeoutMs: 60_000 });
  if (view.code === 0 && view.stdout.trim()) return { branch, sha, pushed: true, prUrl: view.stdout.trim() };
  const pr = await run(bin, ["pr", "create", "--base", defaultBranch, "--head", branch, "--title", message.split("\n")[0], "--body", message], { cwd: dir, timeoutMs: 120_000 });
  return { branch, sha, pushed: true, prUrl: pr.code === 0 ? pr.stdout.trim().split("\n").pop() : undefined };
}
