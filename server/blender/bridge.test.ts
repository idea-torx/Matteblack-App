/**
 * The two things that actually break: the sandbox that keeps path imports
 * inside <dataDir>/blender, and the harness contract with real Blender.
 *
 * Run: npx tsx --test server/blender/bridge.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BRIDGE_PY, digestLog, diffObjects, pixelDigest, tellMessage } from "./bridge.ts";
import { underBlenderDir } from "../utils/blenderPath.ts";

test("path sandbox: inside allowed, outside and traversal refused", () => {
  const fake = (p: string) => path.resolve(p); // stand in for realpathSync
  const root = "/data/blender";
  assert.deepEqual(underBlenderDir("/data/blender/s/out/a.png", root, fake), { path: "/data/blender/s/out/a.png" });
  assert.ok("error" in underBlenderDir("/data/blender/../uploads/a.png", root, fake));
  assert.ok("error" in underBlenderDir("/etc/passwd", root, fake));
  assert.ok("error" in underBlenderDir("/data/blender-evil/a.png", root, fake));
});

const BLENDER = "/Applications/Blender.app/Contents/MacOS/Blender";

test("mesh edits are observable and previews restore the artist's settings on success and failure", { skip: !fs.existsSync(BLENDER) }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mb-blender-state-"));
  try {
    fs.writeFileSync(path.join(dir, "bridge.py"), BRIDGE_PY);
    fs.writeFileSync(path.join(dir, "step.py"), [
      "import mb, os",
      "bpy = mb.bpy",
      "o = mb.greybox('cube', 'Hero')",
      "mb.camera()",
      "mb.resolution(64, 64)",
      "sc = bpy.context.scene",
      "sc.frame_set(9)",
      "sc.render.engine = 'CYCLES'",
      "sc.render.filepath = '//artist-output'",
      "sc.render.image_settings.file_format = 'JPEG'",
      "before = mb.summary()['objects'][0]['mesh']['hash']",
      "o.data.vertices[0].co.x += 0.25",
      "o.data.update()",
      "after = mb.summary()['objects'][0]['mesh']['hash']",
      "assert before != after, 'geometry edit was hidden'",
      "o.modifiers.new('Edges', 'BEVEL').width = 0.1",
      "assert mb.summary()['objects'][0]['modifiers'][0]['settings']['width'] > 0",
      "mb.look('grey')",
      "mb.still(os.path.join(mb.out_dir, 'preview.png'), 1)",
      "assert sc.frame_current == 9",
      "assert sc.render.engine == 'CYCLES'",
      "assert sc.render.filepath == '//artist-output'",
      "assert sc.render.image_settings.file_format == 'JPEG'",

      "try: mb.still(os.path.join(mb.out_dir, 'broken.png'), 'invalid-frame')",
      "except ValueError: pass",
      "else: raise AssertionError('invalid frame should fail')",
      "assert sc.frame_current == 9 and sc.render.engine == 'CYCLES'",
      "assert sc.render.filepath == '//artist-output'",
      "print('state checks passed')",
    ].join("\n"));
    const log = execFileSync(BLENDER, ["--background", "--python", path.join(dir, "bridge.py"), "--", path.join(dir, "step.py"), dir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
    assert.match(log, /state checks passed/);
  } catch (err) {
    assert.fail((err as { stdout?: string }).stdout || String(err));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("harness: cube + push_in renders a still and a playblast", { skip: !fs.existsSync(BLENDER) }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mb-blender-"));
  const bridge = path.join(dir, "bridge.py");
  fs.writeFileSync(bridge, BRIDGE_PY);
  fs.writeFileSync(path.join(dir, "step.py"), [
    "import mb",
    "mb.greybox('cube', 'Hero', location=(0, 0, 1))",
    "mb.camera('Cam', location=(8, -8, 5), look_at=(0, 0, 1), lens=35)",
    "mb.set_range(1, 12, fps=24)",
    "mb.resolution(320, 480)", // portrait: the step's own size beats the panel default on every render
    "mb.camera_move('push_in', (1, 12), distance=4)",
    "mb.camera('Cam', location=(0, -8, 2), look_at=(0, 0, 0))", // same name: re-pose, keys cleared, no Cam.001
    "mb.camera_move('orbit', (1, 12), degrees=90, easing='smooth')",
    "mb.greybox('cube', 'Head', location=(0, 0, 2.5), scale=(0.4, 0.4, 0.4))",
    "mb.group('person', ['Hero', 'Head'])", // one empty moves both; children keep world position
    "mb.keyframe('person', 1, location=(0, 0, 0), easing='ease_out')",
    "mb.keyframe('person', 12, location=(3, 0, 0))",
    "kp = [k for fc in mb._fcurves(mb.bpy.data.objects['person'].animation_data.action) for k in fc.keyframe_points if k.co.x == 1][0]",
    "print('hello from step', mb.bpy.data.objects['Head'].parent.name, kp.interpolation, kp.easing)",
  ].join("\n"));
  const log = execFileSync(BLENDER, [
    "--background", "--python", bridge, "--",
    path.join(dir, "step.py"), dir, JSON.stringify({ playblast: true, stills: [1], views: ["top", { from: [0, -6, 2], at: [0, 0, 1], label: "side" }] }),
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  const m = /MB_SUMMARY_BEGIN\n([\s\S]*?)\nMB_SUMMARY_END/.exec(log);
  assert.ok(m, "harness printed no summary block");
  const { summary, views, stdout } = JSON.parse(m[1]) as { summary: { frame_range: number[]; fps: number; camera_keyframes: unknown[]; objects: { name: string }[] }; views: Array<{ label: string; file: string; rot: number[] }>; stdout: string };
  // views render from a temp camera that is gone afterwards; the scene camera is untouched.
  assert.deepEqual(views.map((v) => v.label), ["top", "side"]);
  assert.deepEqual(views[0].rot, [0, 0, 0]); // straight down
  assert.ok(fs.statSync(views[1].file).size > 0);
  assert.ok(!summary.objects.some((o) => o.name.startsWith("_mb_view")));
  assert.equal(stdout.trim(), "hello from step person QUAD EASE_OUT");
  assert.deepEqual(summary.frame_range, [1, 12]);
  assert.equal(summary.fps, 24);
  assert.equal(summary.camera_keyframes.length, 2);
  assert.equal(summary.objects.filter((o) => o.name.startsWith("Cam")).length, 1);
  assert.deepEqual((summary.camera_keyframes[0] as { location: number[] }).location, [0, -8, 2]);
  assert.equal((summary.objects.find((o) => o.name === "Head") as { in?: string }).in, "person");
  assert.ok(fs.statSync(path.join(dir, "out", "playblast.mp4")).size > 0);
  const png = fs.readFileSync(path.join(dir, "out", "still-0001.png"));
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [320, 480]); // IHDR width, height
  assert.deepEqual((summary as { resolution?: number[] }).resolution, [320, 480]);
  assert.ok(fs.existsSync(path.join(dir, "scene.blend")), "scene.blend was not saved");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("harness: a failing step reports one short error block, not a traceback", { skip: !fs.existsSync(BLENDER) }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mb-blender-"));
  fs.writeFileSync(path.join(dir, "bridge.py"), BRIDGE_PY);
  fs.writeFileSync(path.join(dir, "step.py"), "import mb\nprint('before')\nmb.greybox('box', 'X')\n");
  let log = "";
  try {
    execFileSync(BLENDER, ["--background", "--python", path.join(dir, "bridge.py"), "--", path.join(dir, "step.py"), dir],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.fail("Blender should exit non-zero");
  } catch (e) { log = (e as { stdout: string }).stdout; }
  const m = /MB_SUMMARY_BEGIN\n([\s\S]*?)\nMB_SUMMARY_END/.exec(log);
  assert.ok(m, "harness printed no error block");
  const { error, stdout } = JSON.parse(m[1]) as { error: string; stdout: string };
  assert.match(error, /^ValueError: greybox kind must be one of/);
  assert.match(error, /step line 3: mb\.greybox\('box', 'X'\)/);
  assert.ok(!error.includes("bridge.py"), "bridge frames must not leak into the error");
  assert.equal(stdout.trim(), "before");
  assert.ok(!fs.existsSync(path.join(dir, "scene.blend")), "a failed step must not save");
  fs.rmSync(dir, { recursive: true, force: true });

  // Blender died without its block: progress lines and banners drop, the rest stays.
  const raw = "Blender 5.1.2 (hash x)\n00:01.2  render | Video append frame 3\nFra:3 Mem:1M\nSegmentation fault\nBlender quit\n";
  assert.equal(digestLog(raw), "Segmentation fault");
});

test("pixelDigest ignores Blender's metadata chunks but not the pixels", () => {
  // Minimal PNG shape: signature, then <len><type><data><crc> chunks.
  const chunk = (type: string, data: string): Buffer => {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0);
    b.write(type, 4, "latin1");
    b.write(data, 8, "latin1");
    return b;
  };
  const png = (text: string, pixels: string) =>
    Buffer.concat([Buffer.alloc(8), chunk("IHDR", "wh"), chunk("tEXt", text), chunk("IDAT", pixels), chunk("IEND", "")]);

  assert.equal(pixelDigest(png("Frame:1", "aaa")), pixelDigest(png("Frame:2", "aaa")));
  assert.notEqual(pixelDigest(png("Frame:1", "aaa")), pixelDigest(png("Frame:1", "bbb")));
});

test("diffObjects reports only added, changed and removed objects", () => {
  const a = { name: "a", loc: [0, 0, 0] }, b = { name: "b", loc: [1, 0, 0] };
  assert.deepEqual(diffObjects(undefined, [a, b]), { objects: [a, b], objects_unchanged: 0, objects_removed: [] });
  const b2 = { name: "b", loc: [2, 0, 0] }, c = { name: "c", loc: [0, 0, 0] };
  assert.deepEqual(diffObjects([a, b], [a, b2, c]), { objects: [b2, c], objects_unchanged: 1, objects_removed: [] });
  assert.deepEqual(diffObjects([a, b], [a]), { objects: [], objects_unchanged: 1, objects_removed: ["b"] });
  // Big scene: the cap applies to what changed, so an edit past object 30 is still reported.
  const many = Array.from({ length: 40 }, (_, i) => ({ name: `o${i}`, loc: [0, 0, 0] }));
  const edited = many.map((o) => o.name === "o39" ? { ...o, loc: [9, 0, 0] } : o);
  assert.deepEqual(diffObjects(many, edited), { objects: [{ name: "o39", loc: [9, 0, 0] }], objects_unchanged: 39, objects_removed: [] });
  assert.equal(diffObjects(undefined, many).objects.length, 30);
  assert.equal(diffObjects(undefined, many).objects_more, 10);
});

test("tellMessage: selection, viewport and note become one Continue message", () => {
  const m = tellMessage("house-1", {
    selected: [{ name: "roof_L", loc: [1, 2, 3], rot: [0, -32, 0], scale: [1, 1, 1] }],
    viewport: { from: [10, -10, 5], at: [0, 0, 2] },
    note: "make this roof steeper",
  });
  assert.match(m, /^Continue Blender session "house-1"/);
  assert.match(m, /roof_L loc \[1,2,3\] rot \[0,-32,0\]°/);
  assert.match(m, /from \[10,-10,5\] at \[0,0,2\]/);
  assert.match(m, /They say: "make this roof steeper"/);
  assert.match(tellMessage("s", {}), /Nothing is selected/);
});
