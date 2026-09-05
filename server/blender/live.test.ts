import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { livePid, runLiveStep } from "./live.ts";

// Opt in because this check opens a real Blender window. Only its disposable
// test process is closed afterwards: MB_TEST_VISIBLE=1 node --import tsx --test server/blender/live.test.ts
test("visible session keeps artist edits, supports native Undo, restores checkpoints, and cancels queued work", {
  skip: process.env.MB_TEST_VISIBLE !== "1",
  timeout: 60_000,
}, async () => {
  const bin = process.env.MB_BLENDER_PATH || "/Applications/Blender.app/Contents/MacOS/Blender";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mb-visible-test-"));
  let id = 0;
  const run = async (step: string, options = {}, signal?: AbortSignal) => {
    const n = ++id;
    fs.writeFileSync(path.join(dir, `step-${n}.py`), step);
    return runLiveStep<{ error?: string; summary?: { objects: Array<{ name: string; mesh?: { hash: string } }> }; stdout?: string }>(bin, dir, { id: n, render: {}, ...options }, signal);
  };
  const until = async (name: string) => {
    for (let i = 0; i < 100 && !fs.existsSync(path.join(dir, name)); i++) await delay(50);
    assert.ok(fs.existsSync(path.join(dir, name)), `${name} was not written`);
    return JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
  };
  try {
    const first = await run([
      "import mb, os, json",
      "bpy = mb.bpy",
      "assert not bpy.app.background",
      "mb.greybox('cube', 'Hero')",
      "mb.camera()",
      "def artist_edit():",
      "    o = bpy.data.objects['Hero']",
      "    o.location.x = 2",
      "    o.data.vertices[0].co.x += 0.25",
      "    o.data.update()",
      "    bpy.ops.ed.undo_push(message='Artist edit')",
      "    json.dump(True, open(os.path.join(mb.session_dir, 'artist.json'), 'w'))",
      "bpy.app.timers.register(artist_edit, first_interval=0.5)",
    ].join("\n"));
    assert.equal(first.error, undefined);
    await until("artist.json");
    const next = await run([
      "import mb, os, json",
      "bpy = mb.bpy",
      "o = bpy.data.objects['Hero']",
      "assert o.location.x == 2",
      "o.scale.y = 0.5",
      "def undo_step():",
      "    area = next(a for a in bpy.context.screen.areas if a.type == 'VIEW_3D')",
      "    region = next(r for r in area.regions if r.type == 'WINDOW')",
      "    with bpy.context.temp_override(area=area, region=region): bpy.ops.ed.undo()",
      "    o = bpy.data.objects['Hero']",
      "    json.dump([o.location.x, o.scale.y], open(os.path.join(mb.session_dir, 'undo.json'), 'w'))",
      "bpy.app.timers.register(undo_step, first_interval=0.5)",
    ].join("\n"));
    assert.equal(next.error, undefined);
    assert.notEqual(first.summary?.objects[0].mesh?.hash, next.summary?.objects[0].mesh?.hash);
    assert.deepEqual(await until("undo.json"), [2, 1]);
    const failure = await run("import mb\nmb.greybox('sphere', 'Partial')\nraise ValueError('test failure')");
    assert.match(failure.error!, /test failure/);
    assert.ok(fs.existsSync(path.join(dir, "before-3.blend")));
    const restored = await run("import mb\nassert 'Partial' not in mb.bpy.data.objects\nassert mb.bpy.data.objects['Hero'].location.x == 0", { revert: 1 });
    assert.equal(restored.error, undefined);
    await run("import mb\nmb.bpy.context.scene['matteblack_paused'] = True");
    const ac = new AbortController();
    const queued = run("raise ValueError('cancelled work ran')", {}, ac.signal);
    setTimeout(() => ac.abort(), 300);
    await assert.rejects(queued, /abort/i);
    assert.ok(!fs.existsSync(path.join(dir, "command.json")));
    assert.ok(!fs.existsSync(path.join(dir, "running.json")));
  } finally {
    const pid = livePid(dir);
    if (pid) process.kill(pid, "SIGTERM");
    await delay(500);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
