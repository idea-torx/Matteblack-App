/**
 * Sessions listing: only dirs with a scene.blend count, steps are counted from
 * step-N.py, renders come back newest-first and capped at 4.
 *
 * Run: npx tsx --test server/blender/sessions.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listSessions, SESSION_RE } from "../utils/blenderPath.ts";

function make(root: string, id: string, opts: { scene?: boolean; steps?: number; renders?: string[] }) {
  const dir = path.join(root, id);
  fs.mkdirSync(path.join(dir, "out"), { recursive: true });
  if (opts.scene !== false) fs.writeFileSync(path.join(dir, "scene.blend"), "x");
  for (let i = 1; i <= (opts.steps ?? 0); i++) fs.writeFileSync(path.join(dir, `step-${i}.py`), "x");
  (opts.renders ?? []).forEach((f, i) => {
    const p = path.join(dir, "out", f);
    fs.writeFileSync(p, "x");
    fs.utimesSync(p, new Date(), new Date(Date.now() + i * 1000)); // later name = newer
  });
}

test("listSessions: scene.blend required, steps + renders counted", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mb-blender-sessions-"));
  make(root, "kitchen", { steps: 3, renders: ["still-0001.png", "still-0002.png", "playblast.mp4", "still-0003.png", "still-0004.png"] });
  make(root, "no-scene", { scene: false, steps: 2 });
  make(root, "Bad_Slug", { steps: 1 });
  fs.writeFileSync(path.join(root, "loose.txt"), "x");

  const out = listSessions(root);
  assert.deepEqual(out.map((s) => s.id), ["kitchen"]);
  assert.equal(out[0].steps, 3);
  assert.equal(out[0].renderCount, 5);
  assert.equal(out[0].renders.length, 4);
  assert.equal(out[0].renders[0], "still-0004.png"); // newest first
  assert.ok(!Number.isNaN(Date.parse(out[0].updatedAt)));

  assert.deepEqual(listSessions(path.join(root, "nope")), []);
});

test("slug guard rejects traversal and stray characters", () => {
  assert.ok(SESSION_RE.test("kitchen-blockout"));
  for (const bad of ["..", "a/b", "a b", "A", "", "x".repeat(41), ".hidden"]) {
    assert.ok(!SESSION_RE.test(bad), bad);
  }
});
