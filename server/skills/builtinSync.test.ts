// Run: npx tsx server/skills/builtinSync.test.ts
//
// The built-in skills exist twice on purpose: as TS constants (bundled by
// esbuild, shipped everywhere) and as skills/*.md in the repo (readable,
// diffable, greppable). This is the check that keeps them byte-identical —
// edit either one, mirror it into the other, or this fails.
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_SKILLS } from "./builtin.js";

const repoSkillsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");

for (const [slug, body] of Object.entries(BUILTIN_SKILLS)) {
  const md = fs.readFileSync(path.join(repoSkillsDir, `${slug}.md`), "utf8");
  assert.equal(md.trim(), body.trim(), `skills/${slug}.md has drifted from the ${slug} constant in server/skills/builtin.ts`);
}
console.log(`builtin skill sync checks passed (${Object.keys(BUILTIN_SKILLS).length} skills)`);
