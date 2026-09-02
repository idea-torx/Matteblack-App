/**
 * Skill library — markdown files on disk under <dataDir>/skills.
 *
 * A "skill" is a reusable generation recipe the user (or Claude) writes down:
 * a video creation script, a house style, a prompt formula. Deliberately NOT in
 * the database — they're documents the user should be able to open, diff, sync,
 * and hand to someone else, and the MCP bridge already runs beside the same
 * data dir. Frontmatter is optional; a bare .md file is a valid skill.
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config/runtime.js";

export const SKILLS_DIR = path.join(DATA_DIR, "skills");

export type SkillMeta = {
  slug: string;
  title: string;
  description: string;
  updatedAt: string;
  bytes: number;
  /** Section the panel files it under. From `label:` in the frontmatter when
   *  the author set one, otherwise read off the skill's own words. */
  label: string;
  /** First lines of the body, for the card face. */
  preview: string;
};
export type Skill = SkillMeta & { body: string };

/** Filename-safe id. Also the trust boundary: the result can never contain a
 *  path separator or dots, so a slug from an API caller cannot escape
 *  SKILLS_DIR no matter what it contains. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/\.md$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function skillPath(slug: string): string {
  const safe = slugify(slug);
  if (!safe) throw new Error("Invalid skill name.");
  return path.join(SKILLS_DIR, `${safe}.md`);
}

/** Pull `title`/`name` and `description` out of optional YAML-ish frontmatter,
 *  falling back to the first `# heading` and first prose line. Not a YAML
 *  parser — two flat string keys is all a skill header ever needs. */
function parseHeader(body: string, slug: string): { title: string; description: string; label: string } {
  let title = "";
  let description = "";
  let label = "";
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body);
  if (fm) {
    for (const line of fm[1].split(/\r?\n/)) {
      const m = /^(name|title|description|label):\s*(.*)$/.exec(line.trim());
      if (!m) continue;
      const value = m[2].trim().replace(/^["']|["']$/g, "");
      if (m[1] === "description") description ||= value;
      else if (m[1] === "label") label ||= value;
      else title ||= value;
    }
  }
  const rest = fm ? body.slice(fm[0].length) : body;
  if (!title) title = (/^#\s+(.+)$/m.exec(rest)?.[1] ?? "").trim();
  if (!description) {
    description = (rest
      .split(/\r?\n/)
      .find((l) => l.trim() && !l.trim().startsWith("#")) ?? "").trim().slice(0, 200);
  }
  return { title: title || slug, description, label: label || classify(`${title} ${description} ${rest.slice(0, 1200)}`) };
}

/** What kind of skill this is, from its own words. First rule that matches
 *  wins, so the order is the priority: a video recipe that happens to mention
 *  its voice-over is still a video recipe.
 *  ponytail: keywords, not a model call — the panel needs a section header, not
 *  a taxonomy. Authors who disagree write `label:` in the frontmatter. */
const LABEL_RULES: Array<[string, RegExp]> = [
  // Prefixes, not whole words — "animat" has to catch "animated" and "animation".
  ["Video", /\b(video|clip|shot|scene|storyboard|animat|footage|cinemat|second|t2v|i2v|h3 max|veo|kling|seedance|minimax)/i],
  ["Image", /\b(image|photo|poster|logo|still|thumbnail|illustration|seedream|nano banana|gpt-image|aspect ratio)/i],
  ["Writing", /\b(writing|copy|caption|voice|tone|prose|headline|humaniz)/i],
];

export function classify(text: string): string {
  for (const [label, re] of LABEL_RULES) if (re.test(text)) return label;
  return "Creative";
}

/** Body without frontmatter or markdown furniture — what the card face shows. */
function previewOf(body: string): string {
  return body
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[*_`>]/g, "")
    .trim()
    .slice(0, 320);
}

export function ensureSkillsDir(): void {
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
}

export function listSkills(): SkillMeta[] {
  ensureSkillsDir();
  return fs
    .readdirSync(SKILLS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const slug = f.slice(0, -3);
      const full = path.join(SKILLS_DIR, f);
      const stat = fs.statSync(full);
      const body = fs.readFileSync(full, "utf8");
      const { title, description, label } = parseHeader(body, slug);
      return { slug, title, description, label, preview: previewOf(body), updatedAt: stat.mtime.toISOString(), bytes: stat.size };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function readSkill(slug: string): Skill | null {
  const p = skillPath(slug);
  if (!fs.existsSync(p)) return null;
  const body = fs.readFileSync(p, "utf8");
  const stat = fs.statSync(p);
  const safe = slugify(slug);
  const { title, description, label } = parseHeader(body, safe);
  return { slug: safe, title, description, label, preview: previewOf(body), updatedAt: stat.mtime.toISOString(), bytes: stat.size, body };
}

export const HISTORY_DIR = path.join(SKILLS_DIR, ".history");
/** Who last wrote each skill. `user` = the panel or a foreground request,
 *  `operator` = Claude during a live turn, `review` = the after-turn pass. */
const ACTORS_PATH = path.join(SKILLS_DIR, ".actors.json");
export type Actor = "user" | "operator" | "review";

export function readActors(): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(ACTORS_PATH, "utf8")) as Record<string, string>; } catch { return {}; }
}

/** Versions of one skill, newest first. Filenames are the version ids. */
export function listSkillHistory(slug: string): string[] {
  const dir = path.join(HISTORY_DIR, slugify(slug));
  try { return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort().reverse(); }
  catch { return []; }
}

export function readSkillVersion(slug: string, version: string): string | null {
  if (!listSkillHistory(slug).includes(version)) return null; // also the path guard
  try { return fs.readFileSync(path.join(HISTORY_DIR, slugify(slug), `${version}.md`), "utf8"); } catch { return null; }
}

/** May the after-turn review pass overwrite this skill? Pure — the caller
 *  supplies the facts, so this stays testable and out of builtin.ts's import
 *  cycle. Foreground writes never go through here: the user is present. */
export function reviewMayWrite(o: { pinned: boolean; lastActor?: string; isFactoryText: boolean }): boolean {
  if (o.pinned) return false;
  // Hand-edited: text that isn't the shipped factory copy and whose last write
  // wasn't ours. No actor recorded means it predates this bookkeeping — assume
  // the user, which is the safe direction to be wrong in.
  return o.isFactoryText || (o.lastActor ?? "user") !== "user";
}

/** Write (create or overwrite) a skill. Returns its metadata. */
export function writeSkill(slug: string, body: string, actor?: Actor): SkillMeta {
  ensureSkillsDir();
  const p = skillPath(slug);
  const safe = slugify(slug);
  // Version the outgoing body before it's gone, so a bad agent patch is one
  // click to undo. ponytail: last 20 per skill, flat files, no index.
  try {
    const prev = fs.readFileSync(p, "utf8");
    const dir = path.join(HISTORY_DIR, safe);
    fs.mkdirSync(dir, { recursive: true });
    // ISO instant, colons out (Windows-safe filename). Two writes inside one
    // millisecond get a -1, -2 … suffix rather than eating each other.
    const stamp = new Date().toISOString().replace(/:/g, "-");
    let name = stamp;
    for (let n = 1; fs.existsSync(path.join(dir, `${name}.md`)); n++) name = `${stamp}-${n}`;
    fs.writeFileSync(path.join(dir, `${name}.md`), prev, "utf8");
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".md")).sort().slice(0, -20)) {
      fs.unlinkSync(path.join(dir, f));
    }
  } catch { /* first write of this skill — nothing to keep */ }
  fs.writeFileSync(p, body, "utf8");
  if (actor) {
    const actors = readActors();
    actors[safe] = actor;
    try { fs.writeFileSync(ACTORS_PATH, JSON.stringify(actors), "utf8"); } catch { /* sidecar is advisory */ }
  }
  const stat = fs.statSync(p);
  const { title, description, label } = parseHeader(body, safe);
  return { slug: safe, title, description, label, preview: previewOf(body), updatedAt: stat.mtime.toISOString(), bytes: stat.size };
}

export function deleteSkill(slug: string): boolean {
  const p = skillPath(slug);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

// ---------------------------------------------------------------------------
// Pinned instructions
// ---------------------------------------------------------------------------

/** Pinned skills are prepended to the operator's standing instructions on every
 *  run — the user's "always do it this way" document. Slugs only; the markdown
 *  stays in the one skill library. */
const PINS_PATH = path.join(DATA_DIR, "skills-pinned.json");

/** ponytail: whole pinned docs are inlined into every run's system prompt, so
 *  the cap is a real budget, not a formality. Raise it (or switch to letting
 *  Claude read the file) if anyone pins a novel. */
const PINNED_MAX_CHARS = 40_000;

export function readPins(): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(PINS_PATH, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch { return []; }
}

export function setPin(slug: string, pinned: boolean): string[] {
  const safe = slugify(slug);
  if (!safe) throw new Error("Invalid skill name.");
  const next = readPins().filter((s) => s !== safe);
  if (pinned) next.push(safe);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PINS_PATH, JSON.stringify(next), "utf8");
  return next;
}

/** Strip optional frontmatter — it's panel metadata, not instruction. */
function stripFrontmatter(body: string): string {
  return body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

/** One line per skill so the operator knows what exists before deciding to get_skill. */
export function skillIndex(): string {
  // ponytail: the index rides on every turn; 100 chars per row keeps 60+ skills under ~1k tokens.
  const rows = listSkills().map((s) => `- ${s.slug}: ${(s.description || s.title).slice(0, 100)}`);
  if (!rows.length) return "";
  return `\n\nYOUR SKILL LIBRARY (get_skill <slug> for the full text):\n${rows.join("\n")}`;
}

/** The pinned documents, ready to append to a system prompt. Empty when none. */
export function pinnedInstructions(): string {
  const parts: string[] = [];
  let budget = PINNED_MAX_CHARS;
  for (const slug of readPins()) {
    const skill = readSkill(slug);
    if (!skill) continue;
    const body = stripFrontmatter(skill.body).slice(0, budget);
    if (!body) continue;
    budget -= body.length;
    parts.push(`--- PINNED INSTRUCTIONS: ${skill.title} (${skill.slug}) ---\n${body}`);
    if (budget <= 0) break;
  }
  if (!parts.length) return "";
  return `\n\nThe user has pinned the following instructions. They apply to every request in this conversation and outrank your general defaults; follow them unless the user overrides one directly.\n\n${parts.join("\n\n")}`;
}
