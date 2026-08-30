/**
 * Cuts — a local git repo per video project, holding the *recipe* for each cut.
 *
 * The premise: generation isn't cheap and isn't deterministic, so the thing
 * worth keeping isn't the mp4 (it's already re-hosted and durable) but the
 * decisions that produced it — the look, the shot list, the exact prompts, the
 * settings, and the order they were laid in. That's small, diffable text, which
 * is precisely what git is good at and video is not.
 *
 *   <dataDir>/repos/_cuts/<project>/     one git repo per project
 *     INDEX.md                           newest first — the recall surface
 *     2026-08-29-rooftop-teaser.md       one commit per cut
 *
 * Two deliberate choices:
 *
 * - It lives under REPOS_DIR because the operator's cwd is pinned there, so its
 *   own Read/Grep/Glob reach past cuts with no new tool and no index service.
 *   Recall is grep over files it can already see.
 * - It is NOT the user's attached GitHub clones. Those are depth-1, read-only
 *   context; committing into them would break `gh repo sync` and put our writes
 *   in someone's real history. These repos are ours, local, and never pushed.
 */
import fs from "node:fs";
import path from "node:path";
import { REPOS_DIR, run as runProc } from "../github/ghCli.js";
import { slugify } from "../skills/skillStore.js";

export const CUTS_DIR = path.join(REPOS_DIR, "_cuts");

export type Shot = {
  label?: string;
  prompt?: string;
  /** Keyframe / reference URL this shot was generated from, if any. */
  reference?: string;
  /** The finished clip URL. */
  src?: string;
  durationSeconds?: number;
  /** The bridge: what carries over from the previous shot. */
  bridge?: string;
};

export type Cut = {
  project: string;
  title: string;
  /** Prose. Grep only matches words that are present, so this is what makes a
   *  cut findable six months later ("the one with the neon rain"). */
  description: string;
  status?: string;
  model?: string;
  aspectRatio?: string;
  resolution?: string;
  look?: string;
  subjects?: string;
  notes?: string;
  shots: Shot[];
  music?: { prompt?: string; src?: string } | null;
};

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

function gitBinary(): string {
  for (const c of ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"]) {
    try { if (fs.existsSync(c)) return c; } catch { /* unreadable */ }
  }
  return "git"; // fall back to PATH
}

/** Our own identity and no signing: these repos are never pushed, and a user
 *  whose global config sets neither (or sets gpgsign) must not break saving. */
const GIT_ID = [
  "-c", "user.name=Fal Forge",
  "-c", "user.email=falforge@local",
  "-c", "commit.gpgsign=false",
];

function git(dir: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return runProc(gitBinary(), [...GIT_ID, ...args], { cwd: dir, timeoutMs: 30_000 });
}

async function ensureRepo(dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(path.join(dir, ".git"))) return;
  const r = await git(dir, ["init", "-b", "main"]);
  if (r.code !== 0) await git(dir, ["init"]); // older git: no -b
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** YYYY-MM-DD in local time — the sort key, and it has to match the user's
 *  idea of "today" rather than UTC's. */
function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Frontmatter is single-line `key: value` only, so the index can be rebuilt
 *  with a regex instead of a YAML parser. Values are quoted and newlines
 *  flattened to keep that true whatever the agent sends. */
function fm(key: string, value: string | number): string {
  const v = String(value).replace(/\s+/g, " ").trim().replace(/"/g, "'");
  return `${key}: "${v}"`;
}

function runtimeOf(cut: Cut): number {
  return cut.shots.reduce((n, s) => n + (Number(s.durationSeconds) || 0), 0);
}

export function renderManifest(cut: Cut, date: string): string {
  const runtime = runtimeOf(cut);
  const head = [
    "---",
    fm("project", cut.project),
    fm("title", cut.title),
    fm("date", date),
    fm("status", cut.status || "draft"),
    fm("shots", cut.shots.length),
    fm("runtime", `${Math.round(runtime)}s`),
    cut.model ? fm("model", cut.model) : "",
    cut.aspectRatio ? fm("aspectRatio", cut.aspectRatio) : "",
    cut.resolution ? fm("resolution", cut.resolution) : "",
    fm("summary", cut.description),
    "---",
  ].filter(Boolean); // drops the optional lines above; keep "---" last

  const body: string[] = [`# ${cut.title}`, "", cut.description, ""];
  if (cut.look) body.push("## Look", "", cut.look, "");
  if (cut.subjects) body.push("## Subjects", "", cut.subjects, "");

  body.push("## Settings", "");
  body.push(
    `- Model: ${cut.model || "—"}`,
    `- Aspect ratio: ${cut.aspectRatio || "—"}`,
    `- Resolution: ${cut.resolution || "—"}`,
    `- Runtime: ${Math.round(runtime)}s across ${cut.shots.length} shot(s)`,
    "",
  );

  body.push("## Shots", "");
  cut.shots.forEach((s, i) => {
    body.push(`### ${i + 1}. ${s.label || `Shot ${i + 1}`}${s.durationSeconds ? ` (${s.durationSeconds}s)` : ""}`, "");
    if (s.prompt) body.push("**Prompt:**", "", "```", s.prompt, "```", "");
    if (s.bridge) body.push(`**Bridge:** ${s.bridge}`, "");
    if (s.reference) body.push(`**Reference:** ${s.reference}`, "");
    if (s.src) body.push(`**Clip:** ${s.src}`, "");
  });

  if (cut.music) {
    body.push("## Music", "");
    if (cut.music.prompt) body.push(`**Prompt:** ${cut.music.prompt}`, "");
    if (cut.music.src) body.push(`**Track:** ${cut.music.src}`, "");
  }
  if (cut.notes) body.push("## Notes", "", cut.notes, "");

  body.push(
    "---",
    "",
    "Restoring this cut: pass every **Clip** URL above to `set_timeline` in this order.",
    "",
  );
  return `${head.join("\n")}\n\n${body.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

const MANIFEST_RE = /^\d{4}-\d{2}-\d{2}-.+\.md$/;

function readFrontmatter(file: string): Record<string, string> {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return {}; }
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!block) return {};
  const out: Record<string, string> = {};
  for (const line of block[1].split(/\r?\n/)) {
    const m = /^([A-Za-z][A-Za-z0-9_]*):\s*"?(.*?)"?\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export function manifestFiles(projectDir: string): string[] {
  let names: string[] = [];
  try { names = fs.readdirSync(projectDir); } catch { return []; }
  // The date prefix orders across days as a plain string compare. Within a day
  // it can't, so fall back to mtime — the only recency signal a filename that
  // differs solely by a collision counter actually carries.
  // ponytail: mtime is wrong if the directory is ever copied without -p; the
  // date prefix still dominates, so the damage is confined to one day's order.
  const stat = (n: string) => { try { return fs.statSync(path.join(projectDir, n)).mtimeMs; } catch { return 0; } };
  return names
    .filter((n) => MANIFEST_RE.test(n))
    .map((n) => ({ n, t: stat(n) }))
    .sort((a, b) => b.n.slice(0, 10).localeCompare(a.n.slice(0, 10)) || b.t - a.t)
    .map((x) => x.n);
}

/** Rebuild INDEX.md — the file the agent reads before anything else, so it can
 *  see the whole project in one read and open only what it needs. */
export function writeIndex(project: string): string {
  const dir = path.join(CUTS_DIR, project);
  const files = manifestFiles(dir);
  const lines = [
    `# Cuts — ${project}`,
    "",
    `${files.length} cut(s), newest first. Read this before starting related work, then open only the manifests you need.`,
    "",
  ];
  for (const f of files) {
    const meta = readFrontmatter(path.join(dir, f));
    const bits = [meta.runtime, meta.shots ? `${meta.shots} shots` : "", meta.model].filter(Boolean).join(", ");
    lines.push(
      `- **${meta.date || f.slice(0, 10)}** — [${meta.title || f}](${f})` +
      `${bits ? ` — ${bits}` : ""}${meta.status && meta.status !== "draft" ? ` — _${meta.status}_` : ""}` +
      `${meta.summary ? `\n  ${meta.summary}` : ""}`,
    );
  }
  const body = lines.join("\n") + "\n";
  fs.writeFileSync(path.join(dir, "INDEX.md"), body, "utf8");
  return body;
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

export type SavedCut = { project: string; file: string; path: string; runtime: number; committed: boolean; gitError?: string };

export async function saveCut(input: Cut): Promise<SavedCut> {
  const project = slugify(input.project || "untitled");
  const titleSlug = slugify(input.title || "cut") || "cut";
  if (!project) throw new Error("A project name is required.");
  if (!input.description?.trim()) throw new Error("A description is required — it is how this cut gets found later.");
  if (!Array.isArray(input.shots) || input.shots.length === 0) throw new Error("A cut needs at least one shot.");

  const dir = path.join(CUTS_DIR, project);
  await ensureRepo(dir);

  const date = today();
  let file = `${date}-${titleSlug}.md`;
  for (let n = 2; fs.existsSync(path.join(dir, file)); n++) file = `${date}-${titleSlug}-${n}.md`;

  const cut = { ...input, project };
  fs.writeFileSync(path.join(dir, file), renderManifest(cut, date), "utf8");
  writeIndex(project);

  const runtime = runtimeOf(cut);
  const subject = `${cut.title} — ${cut.shots.length} shot(s), ${Math.round(runtime)}s`;
  const add = await git(dir, ["add", "--", file, "INDEX.md"]);
  const commit = add.code === 0
    ? await git(dir, ["commit", "-m", subject, "-m", cut.description])
    : add;

  return {
    project, file, path: path.join(dir, file), runtime,
    committed: commit.code === 0,
    gitError: commit.code === 0 ? undefined : (commit.stderr || commit.stdout).trim().slice(0, 300),
  };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export function listProjects(): { project: string; cuts: number }[] {
  let names: string[] = [];
  try { names = fs.readdirSync(CUTS_DIR); } catch { return []; }
  return names
    .filter((n) => { try { return fs.statSync(path.join(CUTS_DIR, n)).isDirectory(); } catch { return false; } })
    .map((project) => ({ project, cuts: manifestFiles(path.join(CUTS_DIR, project)).length }))
    .filter((p) => p.cuts > 0)
    .sort((a, b) => a.project.localeCompare(b.project));
}

export function readIndex(project: string): string | null {
  const p = path.join(CUTS_DIR, slugify(project), "INDEX.md");
  try { return fs.readFileSync(p, "utf8"); } catch { return null; }
}

/** One manifest, by its filename. Rejects anything that isn't a manifest name,
 *  so `file` can never walk out of the project directory. */
export function readCut(project: string, file: string): string | null {
  if (!MANIFEST_RE.test(file)) return null;
  try { return fs.readFileSync(path.join(CUTS_DIR, slugify(project), file), "utf8"); } catch { return null; }
}
