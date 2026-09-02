/**
 * Self-check for agent memory. Run: `npx tsx server/skills/agentMemory.test.ts`
 * The case that matters is the empty one: if an untouched install gets no
 * instructions, the agent never learns that memory exists and never writes the
 * first note, so it stays empty forever.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { MEMORY_DIR, memorySlug, memoryDir, memoryInstructions, writeMemory, deleteMemory, listMemory } from "./agentMemory.js";

// Slug is the trust boundary — it can never escape MEMORY_DIR.
assert.equal(memorySlug("../../etc/passwd"), "etc-passwd");
assert.equal(memorySlug("Prefers Two Options.md"), "prefers-two-options");

const before = new Set(listMemory().map((n) => n.slug));
const scratch = "selfcheck-tmp-note";

// Empty (or at least: with no notes of ours) still teaches the write path.
assert.match(memoryInstructions(), /`remember`/, "howto must be present");

writeMemory(scratch, "Always price a sequence once, then shoot it all.");
const withNote = memoryInstructions();
assert.match(withNote, /`remember`/, "howto must survive alongside notes");
assert.match(withNote, /price a sequence once/, "the note itself must be inlined");

assert.equal(deleteMemory(scratch), true);
assert.equal(deleteMemory(scratch), false);
assert.deepEqual(new Set(listMemory().map((n) => n.slug)), before, "must leave the store as we found it");
assert.ok(fs.existsSync(MEMORY_DIR));

// ── Bot-scoped memory ─────────────────────────────────────────────────────────
// A bot's notes live in their own directory and must never show up in the
// shared session memory (or in another bot's).
const bot = "11111111-2222-3333-4444-555555555555";
assert.equal(memoryDir(), MEMORY_DIR);
assert.equal(memoryDir(bot), path.join(MEMORY_DIR, "bots", bot));

// The bot id is a trust boundary too: it arrives on the run request and ends up
// in a path, so it can never climb out of the memory directory.
for (const evil of ["../../etc", "a/../../b", "./x", "bots/../../x"]) {
  const dir = memoryDir(evil);
  assert.ok(dir.startsWith(path.join(MEMORY_DIR, "bots") + path.sep), `escaped: ${evil} -> ${dir}`);
  assert.ok(!path.relative(MEMORY_DIR, dir).includes(".."), `escaped: ${evil} -> ${dir}`);
}
// An id with nothing filename-safe left in it is rejected outright rather than
// silently falling back to the shared session memory.
for (const empty of ["..", "///", "."]) assert.throws(() => memoryDir(empty), /Invalid bot id/);

writeMemory(scratch, "The brand never says 'sweat'.", bot);
assert.deepEqual(listMemory(bot).map((n) => n.slug), [scratch]);
assert.match(memoryInstructions(bot), /never says/);
assert.ok(!listMemory().some((n) => n.slug === scratch), "bot notes must not leak into session memory");
assert.ok(!memoryInstructions().includes("never says"), "bot notes must not leak into the session prompt");
assert.equal(deleteMemory(scratch, bot), true);
fs.rmSync(path.join(MEMORY_DIR, "bots", bot), { recursive: true, force: true });
assert.deepEqual(new Set(listMemory().map((n) => n.slug)), before, "must leave the store as we found it");

console.log("agentMemory: all checks passed");
