import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { livePid, runLiveStep } from "./live.ts";
import { tellCapture } from "../utils/blenderPath.ts";
import { tellMessage } from "./bridge.ts";

test("viewport handoff confines screenshots to their session and keeps them separate from references", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mb-capture-"));
  const id = "tell-" + "a".repeat(32);
  const out = path.join(root, "speaker", "out");
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, id + ".png");
  fs.writeFileSync(file, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  try {
    assert.equal(tellCapture(root, "speaker", id), fs.realpathSync(file));
    assert.throws(() => tellCapture(root, "other", id), /No such file/);
    assert.throws(() => tellCapture(root, "speaker", "../private"), /Invalid/);
    fs.rmSync(file);
    const outside = path.join(root, "private.png");
    fs.writeFileSync(outside, "private");
    fs.symlinkSync(outside, file);
    assert.throws(() => tellCapture(root, "speaker", id), /outside/);
    const text = tellMessage("speaker", { capture: id, imagePath: "/staged/viewport.png", imageUrl: "/uploads/view.png", note: "Soften this edge" });
    assert.match(text, /Read the actual Blender viewport screenshot/);
    assert.match(text, /not a replacement for the saved references/);
    assert.match(text, /render.viewport="tell-/);
    assert.match(text, /!\[Artist's Blender viewport\]/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("visible viewport captures selection, compares an edit, and restores the artist's changed view and settings", {
  skip: process.env.MB_TEST_VISIBLE !== "1", timeout: 60_000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mb-viewport-"));
  const dir = path.join(root, "blender", "speaker");
  fs.mkdirSync(dir, { recursive: true });
  let id = 0;
  type Result = { error?: string; stdout?: string; warnings?: string[]; comparison?: { before: string; after: string } };
  const run = async (step: string, render = {}) => {
    const n = ++id;
    fs.writeFileSync(path.join(dir, `step-${n}.py`), step);
    const result = await runLiveStep<Result>(process.env.MB_BLENDER_PATH || "/Applications/Blender.app/Contents/MacOS/Blender", dir, { id: n, render });
    assert.equal(result.error, undefined);
    return result;
  };
  try {
    const first = await run(`import bpy, mb, matteblack_addon as addon
from mathutils import Quaternion
body = mb.greybox('cube', 'Speaker enclosure', scale=(1, 0.65, 1.6))
area = addon._view_area(bpy.context)
area.spaces.active.region_3d.view_distance = 9
area.spaces.active.region_3d.view_location = (0, 0, 0)
area.spaces.active.region_3d.view_perspective = 'ORTHO'
area.spaces.active.region_3d.view_rotation = Quaternion((1, 0, 0), 1.25)
bpy.context.scene.render.engine = 'CYCLES'
bpy.context.scene.render.filepath = '//artist-output'
bpy.context.scene.frame_set(7)
print(addon.capture_tell(bpy.context))`);
    const capture = /tell-[a-f0-9]{32}/.exec(first.stdout!)![0];
    const result = await run(`import bpy, matteblack_addon as addon
body = bpy.data.objects['Speaker enclosure']
body.modifiers.new('Soft edges', 'BEVEL').width = 0.25
body.modifiers['Soft edges'].segments = 6
area = addon._view_area(bpy.context)
area.spaces.active.region_3d.view_distance = 14
bpy.context.scene.frame_set(19)`, { viewport: capture });
    assert.deepEqual(result.warnings, []);
    assert.ok(result.comparison);
    const before = fs.readFileSync(result.comparison.before), after = fs.readFileSync(result.comparison.after);
    assert.deepEqual(before.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.ok(before.readUInt32BE(16) > 100 && before.readUInt32BE(20) > 100, "capture must contain the editor, not a placeholder");
    assert.deepEqual(before.subarray(16, 24), after.subarray(16, 24), "matching image dimensions");
    assert.notDeepEqual(before, after, "the geometry change is visible");
    await run(`import bpy, matteblack_addon as addon
assert addon._view_area(bpy.context).spaces.active.region_3d.view_distance == 14
assert bpy.context.scene.frame_current == 19
assert bpy.context.scene.render.engine == 'CYCLES'
assert bpy.context.scene.render.filepath == '//artist-output'
# Both captures must show the enclosure, not a stale empty viewport.
for file in ${JSON.stringify([result.comparison.before, result.comparison.after])}:
    image = bpy.data.images.load(file, check_existing=False)
    w, h = image.size
    pixel = (int(h * 0.6) * w + w // 2) * 4
    assert min(image.pixels[pixel:pixel+3]) > 0.3, 'captured a stale empty view'
    bpy.data.images.remove(image)`);
    const failed = await run("pass", { viewport: "../../private" });
    assert.match(failed.warnings![0], /capture ID/);
    if (process.env.MB_KEEP_VIEWPORT_TEST === "1") console.log("Viewport artifacts:", dir);
  } finally {
    const pid = livePid(dir);
    if (pid) process.kill(pid, "SIGTERM");
    await delay(500);
    if (process.env.MB_KEEP_VIEWPORT_TEST !== "1") fs.rmSync(root, { recursive: true, force: true });
  }
});
