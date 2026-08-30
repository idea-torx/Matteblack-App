/**
 * Self-check for agent memory. Run: `npx tsx server/skills/agentMemory.test.ts`
 * The case that matters is the empty one: if an untouched install gets no
 * instructions, the agent never learns that memory exists and never writes the
 * first note, so it stays empty forever.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { MEMORY_DIR, memorySlug, memoryInstructions, writeMemory, deleteMemory, listMemory } from "./agentMemory.js";

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

console.log("agentMemory: all checks passed");
