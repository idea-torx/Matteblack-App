// Run: MATTEBLACK_DATA_DIR=$(mktemp -d) npx tsx server/cuts/seed.test.ts
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { seedBuiltinSkills, markSeeded, BUILTIN_SKILLS, OPERATOR_SKILL_SLUG } from "../skills/builtin.js";
import { SKILLS_DIR } from "../skills/skillStore.js";

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
