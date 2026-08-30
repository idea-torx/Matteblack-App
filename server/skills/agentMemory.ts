/**
 * Agent memory — what Claude has learned about how this user wants things done.
 *
 * Deliberately NOT part of the skill library. Skills are the user's documents:
 * they're listed, edited, pinned and deleted in the Skills panel. Memory is the
 * agent's own working notes — corrections it was given, defaults it inferred,
 * approaches that failed — and a note like "user rejects my first cut most of
 * the time, offer two" is only honest while nobody is reading over its
 * shoulder. So this lives in its own directory, is served only to the MCP
 * bridge, and has no user-facing route or panel to leak through.
 *
 * Same on-disk markdown shape as skillStore for the same reasons (greppable,
 * diffable, no migration), but a separate dir so `listSkills()` can never pick
 * a memory file up by accident.
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config/runtime.js";

export const MEMORY_DIR = path.join(DATA_DIR, "agent-memory");

/** ponytail: whole memory is inlined into every operator run, so this is a real
 *  token budget. Past it, oldest notes are dropped. Switch to retrieval if the
 *  agent ever accumulates enough that recency stops being a good filter. */
const MEMORY_MAX_CHARS = 24_000;

export type MemoryNote = {
  slug: string;
  body: string;
  updatedAt: string;
};

/** Filename-safe id, and the trust boundary: the result can never contain a
 *  path separator or dots, so a slug from the bridge cannot escape MEMORY_DIR. */
export function memorySlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/\.md$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function notePath(slug: string): string {
  const safe = memorySlug(slug);
  if (!safe) throw new Error("Invalid memory name.");
  return path.join(MEMORY_DIR, `${safe}.md`);
}

function ensureDir(): void {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

/** Newest first — recency is the ranking, and the budget cut takes from the end. */
export function listMemory(): MemoryNote[] {
  ensureDir();
  return fs
    .readdirSync(MEMORY_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const full = path.join(MEMORY_DIR, f);
      const stat = fs.statSync(full);
      return {
        slug: f.slice(0, -3),
        body: fs.readFileSync(full, "utf8").trim(),
        updatedAt: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function writeMemory(slug: string, body: string): MemoryNote {
  ensureDir();
  const p = notePath(slug);
  fs.writeFileSync(p, body, "utf8");
  return { slug: memorySlug(slug), body: body.trim(), updatedAt: fs.statSync(p).mtime.toISOString() };
}

export function deleteMemory(slug: string): boolean {
  const p = notePath(slug);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

/** The memory block appended to every operator run's system prompt. */
export function memoryInstructions(): string {
  const HOWTO =
    "\n\nYOUR PRIVATE MEMORY. `remember` (slug + note) writes one fact you have learned about " +
    "working with this user; reusing a slug replaces a stale note; `forget` drops one. Write a note " +
    "whenever they correct you, state a preference, reject an option, or a workflow lands well — as a " +
    "directive to your future self (\"lead with two options, they reject the first cut\"), not a diary " +
    "entry. This is not shown anywhere in the app and is not the user's document: apply it silently, " +
    "never read it back or announce that you are saving to it. It is how you get better across " +
    "sessions instead of restarting from zero.";

  const notes = listMemory();
  // Still emitted when empty: otherwise a fresh install is never told the memory
  // exists, so the first note never gets written and it stays empty forever.
  if (notes.length === 0) return HOWTO;
  const parts: string[] = [];
  let budget = MEMORY_MAX_CHARS;
  for (const n of notes) {
    if (!n.body) continue;
    if (n.body.length > budget) break;
    budget -= n.body.length;
    parts.push(`- (${n.slug}) ${n.body}`);
  }
  if (!parts.length) return HOWTO;
  return (
    HOWTO +
    "\n\nYOUR OWN NOTES ON THIS USER, from earlier sessions. These are private working " +
    "memory, not the user's documents — they are not shown anywhere in the app, so do not " +
    "read the list back verbatim or treat it as something they wrote. Apply it silently. " +
    "When a note turns out to be wrong, correct it with `remember` (same slug) or drop it " +
    "with `forget`.\n\n" +
    parts.join("\n")
  );
}
