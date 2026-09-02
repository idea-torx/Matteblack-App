// Run: npx tsx server/skills/selfImprovement.test.ts
//
// The operator's self-improvement loop: patch_skill's exact-match rule, the
// version history writeSkill keeps, and the guard that stops the unattended
// after-turn review pass from overwriting the user's own documents.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyExactPatch } from "./patchText.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "falforge-skills-"));
process.env.MATTEBLACK_DATA_DIR = tmp;
// Imported after the data dir is pointed at a scratch dir — SKILLS_DIR is a
// module constant.
const { writeSkill, readSkill, listSkills, listSkillHistory, readSkillVersion, readActors, reviewMayWrite } =
  await import("./skillStore.ts");

// --- patch_skill exact match -----------------------------------------------
const doc = "alpha\nbeta\ngamma\nbeta\n";
{
  const r = applyExactPatch(doc, "nope", "x");
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /does not appear/);
}
{
  const r = applyExactPatch(doc, "beta", "x");
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /appears 2 times/);
}
{
  const r = applyExactPatch(doc, "gamma", "GAMMA");
  assert.equal(r.ok, true);
  assert.equal((r as { body: string }).body, "alpha\nbeta\nGAMMA\nbeta\n");
}
// An empty `new` deletes, and `$&`-style replacement patterns stay literal.
assert.equal((applyExactPatch(doc, "gamma\n", "") as { body: string }).body, "alpha\nbeta\nbeta\n");
assert.equal((applyExactPatch("a-b", "-", "$&$&") as { body: string }).body, "a$&$&b");

// --- history + restore ------------------------------------------------------
writeSkill("demo", "v1", "user");
assert.deepEqual(listSkillHistory("demo"), [], "first write has nothing to version");
writeSkill("demo", "v2", "operator");
writeSkill("demo", "v3", "operator");
const versions = listSkillHistory("demo");
assert.equal(versions.length, 2);
assert.equal(readSkillVersion("demo", versions[0]), "v2", "newest first");
assert.equal(readSkillVersion("demo", versions[1]), "v1");
assert.equal(readSkillVersion("demo", "../../etc/passwd"), null);

// Restoring is itself a write, so it is itself undoable.
writeSkill("demo", readSkillVersion("demo", versions[1])!, "user");
assert.equal(readSkill("demo")?.body, "v1");
assert.equal(listSkillHistory("demo").length, 3);
assert.equal(readActors().demo, "user");

// The .history dir must not show up as a skill.
assert.deepEqual(listSkills().map((s) => s.slug), ["demo"]);

// ponytail: last 20 kept.
for (let i = 0; i < 25; i++) writeSkill("demo", `bulk-${i}`, "operator");
assert.equal(listSkillHistory("demo").length, 20);

// --- review-pass write guard ------------------------------------------------
// Factory text: the review may improve it.
assert.equal(reviewMayWrite({ pinned: false, lastActor: "user", isFactoryText: true }), true);
// Pinned is off limits no matter who wrote it last.
assert.equal(reviewMayWrite({ pinned: true, lastActor: "operator", isFactoryText: true }), false);
// Diverged from factory and last touched by the user = hand-edited.
assert.equal(reviewMayWrite({ pinned: false, lastActor: "user", isFactoryText: false }), false);
// Diverged because WE wrote it — ours to keep improving.
assert.equal(reviewMayWrite({ pinned: false, lastActor: "operator", isFactoryText: false }), true);
assert.equal(reviewMayWrite({ pinned: false, lastActor: "review", isFactoryText: false }), true);
// No actor recorded predates the sidecar: assume the user.
assert.equal(reviewMayWrite({ pinned: false, isFactoryText: false }), false);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("self-improvement checks passed");
