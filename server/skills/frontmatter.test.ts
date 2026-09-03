/**
 * Frontmatter round-trip: what the library reads off a skill file, and what the
 * editor's `meta` merge writes back. Run: npx tsx server/skills/frontmatter.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// DATA_DIR is read at import time, so point it at a temp dir first.
process.env.MATTEBLACK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "skills-fm-"));
const store = await import("./skillStore.js");
const { frontmatterOf, mergeFrontmatter } = store;
store.ensureSkillsDir();

/** Write a skill file and read it back through the real parse path. */
function readSkillFrom(slug: string, body: string) {
  fs.writeFileSync(path.join(store.SKILLS_DIR, `${slug}.md`), body, "utf8");
  return store.readSkill(slug)!;
}

// --- parse of the new fields -----------------------------------------------
const full = readSkillFrom("promo-loop", `---
name: Promo loop
description: A 6s product loop.
kind: script
tags: promo, loop, veo
cover: /files/a.png
examples: /files/b.mp4, /files/c.mp4
version: 3
author: Leo
source: registry/abc-123
visibility: public
---

# Promo loop
Six seconds, one product.
`);
assert.equal(full.title, "Promo loop");
assert.equal(full.kind, "script");
assert.deepEqual(full.tags, ["promo", "loop", "veo"]);
assert.equal(full.cover, "/files/a.png");
assert.deepEqual(full.examples, ["/files/b.mp4", "/files/c.mp4"]);
assert.equal(full.version, "3");
assert.equal(full.author, "Leo");
assert.equal(full.source, "registry/abc-123");
assert.equal(full.visibility, "public");

// --- kind fallback ----------------------------------------------------------
assert.equal(readSkillFrom("help", "# Help\nHow to use the app.").kind, "system", "builtin plumbing slug");
assert.equal(readSkillFrom("moody", "# Moody\nA cinematic video look with 6 second shots.").kind, "script", "video words");
assert.equal(readSkillFrom("weekly", "# Weekly\nEvery day at 9am, post the digest.").kind, "workflow", "trigger words");
assert.equal(readSkillFrom("botly", "---\nbot: Scout\n---\n\n# Botly\nDo the thing.").kind, "workflow", "bot: header");
assert.equal(readSkillFrom("tone", "# Tone\nKeep the words plain and warm.").kind, "general", "nothing matches");
// An explicit kind always wins over the guess.
assert.equal(readSkillFrom("forced", "---\nkind: general\n---\n\n# Forced\nA cinematic video shot.").kind, "general");

// --- meta merge on PUT (serialisation round-trip) ---------------------------
const merged = mergeFrontmatter(full.body, { tags: ["promo", "hero"], version: "4", author: "", cover: "/files/z.png" });
const head = frontmatterOf(merged);
assert.equal(head.tags, "promo, hero");
assert.equal(head.version, "4");
assert.equal(head.cover, "/files/z.png");
assert.equal(head.author, undefined, "empty value clears the key");
assert.equal(head.description, "A 6s product loop.", "untouched keys survive");
assert.ok(merged.includes("Six seconds, one product."), "body survives");
assert.deepEqual(readSkillFrom("promo-loop", merged).tags, ["promo", "hero"], "reads back what it wrote");

// A file with no frontmatter gets a block, keeping its markdown.
const added = mergeFrontmatter("# Bare\n\nJust prose.\n", { kind: "workflow", tags: ["ops"] });
assert.ok(added.startsWith("---\nkind: workflow\ntags: ops\n---\n"), added.slice(0, 60));
assert.equal(readSkillFrom("bare", added).kind, "workflow");

console.log("frontmatter.test.ts ok");
