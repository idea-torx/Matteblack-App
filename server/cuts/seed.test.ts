// Run: MATTEBLACK_DATA_DIR=$(mktemp -d) npx tsx server/cuts/seed.test.ts
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { seedBuiltinSkills, markSeeded, BUILTIN_SKILLS, OPERATOR_SKILL_SLUG } from "../skills/builtin.js";
import { SKILLS_DIR } from "../skills/skillStore.js";

// This test WRITES to SKILLS_DIR — including a fake "user edit" — so run it
// against a throwaway data dir or it overwrites the real operator system
// prompt with test junk and marks it as the user's, which seeding then
// refuses to repair.
if (!process.env.MATTEBLACK_DATA_DIR) {
  throw new Error("Refusing to run: set MATTEBLACK_DATA_DIR=$(mktemp -d) — this test writes to the skills dir.");
}

const p = path.join(SKILLS_DIR, `${OPERATOR_SKILL_SLUG}.md`);
const factory = BUILTIN_SKILLS[OPERATOR_SKILL_SLUG];

// 1. Fresh install: seeds the factory text.
seedBuiltinSkills();
assert.equal(fs.readFileSync(p, "utf8"), factory);

// 2. Untouched copy goes stale: next boot updates it.
fs.writeFileSync(p, "OLD FACTORY TEXT", "utf8");
markSeeded(OPERATOR_SKILL_SLUG, "OLD FACTORY TEXT"); // pretend that was what we shipped
seedBuiltinSkills();
assert.equal(fs.readFileSync(p, "utf8"), factory, "unedited copy should update");

// 3. A user edit is never clobbered.
fs.writeFileSync(p, "MY OWN PROMPT", "utf8");
seedBuiltinSkills();
assert.equal(fs.readFileSync(p, "utf8"), "MY OWN PROMPT", "user edit must survive");

// 4. Pre-bookkeeping install: unknown provenance is left alone, then tracked.
fs.rmSync(path.join(process.env.MATTEBLACK_DATA_DIR!, "skills-seeded.json"), { force: true });
fs.writeFileSync(p, "UNKNOWN", "utf8");
seedBuiltinSkills();
assert.equal(fs.readFileSync(p, "utf8"), "UNKNOWN", "unknown copy left alone");
seedBuiltinSkills();
assert.equal(fs.readFileSync(p, "utf8"), "UNKNOWN", "…and still left alone, forever — it may be an edit");

// 5. Pre-bookkeeping copy that is byte-identical to what we ship IS adoptable,
//    so those users do get the next update.
fs.rmSync(path.join(process.env.MATTEBLACK_DATA_DIR!, "skills-seeded.json"), { force: true });
fs.writeFileSync(p, factory, "utf8");
seedBuiltinSkills();
markSeeded(OPERATOR_SKILL_SLUG, factory);
fs.writeFileSync(p, factory, "utf8");
seedBuiltinSkills();
assert.equal(fs.readFileSync(p, "utf8"), factory, "adopted copy tracks factory");

console.log("all seeding checks passed");

// 5. skills/*.md in the repo mirrors the shipped constants. They exist so the
// recipes are readable and diffable outside the app; the bundle still ships the
// TS constants, so this is what stops the two from drifting.
// ponytail: mirror + check, not a build-time .md import — tsx (dev server, this
// test) can't import .md, so single-sourcing would need an esbuild loader AND a
// dev-time shim. Revisit if the skill list grows past a handful.
const repoSkills = path.join(import.meta.dirname, "../../skills");
for (const [slug, body] of Object.entries(BUILTIN_SKILLS)) {
  assert.equal(
    fs.readFileSync(path.join(repoSkills, `${slug}.md`), "utf8"),
    body,
    `skills/${slug}.md is out of sync with BUILTIN_SKILLS — copy one onto the other`,
  );
}
