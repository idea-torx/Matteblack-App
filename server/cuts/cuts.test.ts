// Run: MATTEBLACK_DATA_DIR=$(mktemp -d) npx tsx server/cuts/cuts.test.ts
import { execFileSync } from "node:child_process";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { saveCut, readIndex, readCut, listProjects, CUTS_DIR } from "./cutStore.js";


async function main() {
  const base = (n: number) => ({
    project: "Acme Launch",
    title: "Rooftop Teaser",
    description: "Neon rain over a rooftop chase, warm tungsten key against cold city fill.",
    model: "fal-ai/veo3", aspectRatio: "16:9", resolution: "1080p",
    shots: Array.from({ length: n }, (_, i) => ({
      label: `Shot ${i + 1}`, prompt: `prompt ${i + 1}`, src: `/uploads/generations/video/${i}.mp4`, durationSeconds: 5,
    })),
  });
  
  const a = await saveCut(base(3));
  assert.equal(a.project, "acme-launch", "project slugified");
  assert.match(a.file, /^\d{4}-\d{2}-\d{2}-rooftop-teaser\.md$/);
  assert.equal(a.runtime, 15);
  assert.equal(a.committed, true, `commit failed: ${a.gitError}`);
  
  // Same project + title same day must not clobber the first.
  const b = await saveCut({ ...base(2), title: "Rooftop Teaser" });
  assert.match(b.file, /-rooftop-teaser-2\.md$/, `got ${b.file}`);
  assert.ok(fs.existsSync(a.path) && fs.existsSync(b.path));
  
  const idx = readIndex("acme-launch")!;
  assert.ok(idx.includes("Rooftop Teaser") && idx.includes("Neon rain"), "index carries title + prose");
  assert.ok(idx.indexOf(b.file) < idx.indexOf(a.file), "newest first");
  assert.ok(idx.includes("15s") && idx.includes("3 shots"), "index carries runtime/shots");
  
  const body = readCut("acme-launch", a.file)!;
  assert.ok(body.includes("prompt 2") && body.includes("/uploads/generations/video/1.mp4"));
  
  // Path traversal via `file` must not escape the project dir.
  assert.equal(readCut("acme-launch", "../../../../etc/passwd"), null);
  assert.equal(readCut("acme-launch", "INDEX.md"), null);
  
  assert.deepEqual(listProjects(), [{ project: "acme-launch", cuts: 2 }]);
  
  // Validation.
  await assert.rejects(saveCut({ ...base(1), description: "  " }), /description is required/);
  await assert.rejects(saveCut({ ...base(0) }), /at least one shot/);
  
  // git actually has two commits, and the working tree is clean.
  const dir = path.join(CUTS_DIR, "acme-launch");
  assert.equal(execFileSync("git", ["log", "--oneline"], { cwd: dir, encoding: "utf8" }).trim().split("\n").length, 2);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).trim(), "");
  
  console.log("all cut store checks passed");
  
}
main().catch((e) => { console.error(e); process.exit(1); });