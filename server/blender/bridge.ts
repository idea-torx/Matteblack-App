import crypto from "node:crypto";

/**
 * The headless Blender harness, as a string.
 *
 * ponytail: a string constant, not a loose .py file. The server is bundled by
 * esbuild into a single dist-server/index.js and electron-builder ships only
 * dist/, dist-server/, dist-mcp/, electron/ — a server/blender/bridge.py would
 * never reach the packaged app. The route writes this out beside the session
 * .blend before each run, so it is also the file a traceback points at.
 */
export const BRIDGE_PY = String.raw`"""Headless Blender harness for the Matteblack agent bridge.

Run as:  blender --background [scene.blend] --python bridge.py -- <step.py> <session dir> [render json]

Exposes a module 'mb' (importable from the step) with the grey-box, camera,
keyframe and render helpers. State lives in the .blend: the harness saves
<session dir>/scene.blend when the step succeeds, so the next step opens it.
"""
import contextlib
import io
import json
import math
import os
import re
import sys
import traceback
import types

import bpy
from mathutils import Vector

mb = types.ModuleType("mb")
sys.modules["mb"] = mb

_PRIMS = {
    "cube": bpy.ops.mesh.primitive_cube_add,
    "sphere": bpy.ops.mesh.primitive_uv_sphere_add,
    "cylinder": bpy.ops.mesh.primitive_cylinder_add,
    "plane": bpy.ops.mesh.primitive_plane_add,
    "cone": bpy.ops.mesh.primitive_cone_add,
}


def _rad(v):
    return [math.radians(a) for a in v]


def _aim(loc, target):
    """Euler that points a camera at 'target' from 'loc' (cameras look down -Z)."""
    return (Vector(loc) - Vector(target)).to_track_quat("Z", "Y").to_euler()


def greybox(kind, name, location=(0, 0, 0), scale=(1, 1, 1), rotation=(0, 0, 0)):
    """Add a primitive. 'rotation' is in DEGREES."""
    add = _PRIMS.get(kind)
    if add is None:
        raise ValueError("greybox kind must be one of %s" % ", ".join(sorted(_PRIMS)))
    add(location=tuple(location))
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = tuple(scale)
    obj.rotation_euler = _rad(rotation)
    return obj


def camera(name="Camera", location=(7, -7, 5), look_at=(0, 0, 0), lens=50):
    # Same name = re-pose (keys cleared), so re-aiming a camera is one call, not a cam.001.
    obj = bpy.data.objects.get(name)
    if obj is None or obj.type != "CAMERA":
        obj = bpy.data.objects.new(name, bpy.data.cameras.new(name))
        bpy.context.scene.collection.objects.link(obj)
    obj.animation_data_clear()
    obj.data.lens = lens
    obj.location = tuple(location)
    obj.rotation_euler = _aim(location, look_at)
    obj["mb_target"] = list(look_at)
    bpy.context.scene.camera = obj
    return obj


def _cam():
    obj = bpy.context.scene.camera
    if obj is None:
        raise RuntimeError("No camera in the scene — call mb.camera(...) first.")
    return obj


def _key(obj, frame):
    obj.keyframe_insert("location", frame=frame)
    obj.keyframe_insert("rotation_euler", frame=frame)


_EASING = {"linear": ("LINEAR", "AUTO"), "ease_in": ("QUAD", "EASE_IN"),
           "ease_out": ("QUAD", "EASE_OUT"), "smooth": ("QUAD", "EASE_IN_OUT")}


def _ease_t(t, easing):
    """0..1 -> 0..1 for moves keyed every frame (orbit), where per-key interpolation cannot ease."""
    if easing == "ease_in":
        return t * t
    if easing == "ease_out":
        return 1 - (1 - t) * (1 - t)
    if easing == "smooth":
        return t * t * (3 - 2 * t)
    return t


def _ease(obj, frame, easing):
    """Set how the key at 'frame' runs to the next key: linear|ease_in|ease_out|smooth."""
    if easing is None:
        return
    if easing not in _EASING:
        raise ValueError("easing must be one of linear, ease_in, ease_out, smooth")
    interp, ease = _EASING[easing]
    for fc in _fcurves(obj.animation_data.action):
        for kp in fc.keyframe_points:
            if abs(kp.co.x - frame) < 0.5:
                kp.interpolation = interp
                kp.easing = ease


def group(name, members, location=(0, 0, 0)):
    """Parent 'members' (names) under one empty so keyframe(name, ...) moves them as one.
    Members keep their world position. An existing group of that name just gains the members."""
    empty = bpy.data.objects.get(name)
    if empty is None:
        empty = bpy.data.objects.new(name, None)
        bpy.context.scene.collection.objects.link(empty)
        empty.location = tuple(location)
        bpy.context.view_layer.update()
    for m in members:
        child = bpy.data.objects.get(m)
        if child is None:
            raise ValueError("No object named %r" % m)
        child.parent = empty
        child.matrix_parent_inverse = empty.matrix_world.inverted()
    return empty


def camera_move(kind, frames, **params):
    """Keyframe a camera move. 'frames' is (start, end) or an int frame count.
    easing: linear|ease_in|ease_out|smooth (default: Blender's bezier for two-key moves, linear for orbit)."""
    obj = _cam()
    start, end = (1, frames) if isinstance(frames, (int, float)) else (frames[0], frames[1])
    target = Vector(obj.get("mb_target", (0.0, 0.0, 0.0)))
    loc = obj.location.copy()
    rot = obj.rotation_euler.copy()
    _key(obj, start)

    dist = float(params.get("distance", 3.0))
    deg = float(params.get("degrees", 30.0))
    easing = params.get("easing")
    if easing is not None and easing not in _EASING:
        raise ValueError("easing must be one of linear, ease_in, ease_out, smooth")
    if kind in ("dolly", "push_in", "pull_out"):
        if kind == "pull_out":
            dist = -dist
        forward = (target - loc)
        if forward.length == 0:
            forward = Vector((0, 1, 0))
        obj.location = loc + forward.normalized() * dist
        obj.rotation_euler = _aim(obj.location, target)
    elif kind == "orbit":
        # Keyed every frame: a two-key 360 would land on the start pose and not move.
        rel = loc - target
        for f in range(int(start) + 1, int(end)):
            a = math.radians(deg) * _ease_t((f - start) / (end - start), easing)
            obj.location = target + Vector((
                rel.x * math.cos(a) - rel.y * math.sin(a),
                rel.x * math.sin(a) + rel.y * math.cos(a),
                rel.z,
            ))
            obj.rotation_euler = _aim(obj.location, target)
            _key(obj, f)
        a = math.radians(deg)
        obj.location = target + Vector((
            rel.x * math.cos(a) - rel.y * math.sin(a),
            rel.x * math.sin(a) + rel.y * math.cos(a),
            rel.z,
        ))
        obj.rotation_euler = _aim(obj.location, target)
    elif kind == "crane":
        obj.location = loc + Vector((0, 0, float(params.get("height", 3.0))))
        obj.rotation_euler = _aim(obj.location, target)
    elif kind == "truck":
        right = obj.matrix_world.to_3x3() @ Vector((1, 0, 0))
        obj.location = loc + right.normalized() * dist
    elif kind == "pan":
        rot.z += math.radians(deg)
        obj.rotation_euler = rot
    elif kind == "tilt":
        rot.x += math.radians(deg)
        obj.rotation_euler = rot
    else:
        raise ValueError("camera_move kind must be dolly/push_in/pull_out/orbit/crane/pan/tilt/truck")

    _key(obj, end)
    if kind != "orbit":
        _ease(obj, start, easing)
    return obj


def keyframe(obj_name, frame, location=None, rotation=None, scale=None, easing=None):
    """easing sets how THIS key runs to the next one: linear|ease_in|ease_out|smooth."""
    obj = bpy.data.objects.get(obj_name)
    if obj is None:
        raise ValueError("No object named %r" % obj_name)
    if location is not None:
        obj.location = tuple(location)
        obj.keyframe_insert("location", frame=frame)
    if rotation is not None:
        obj.rotation_euler = _rad(rotation)
        obj.keyframe_insert("rotation_euler", frame=frame)
    if scale is not None:
        obj.scale = tuple(scale)
        obj.keyframe_insert("scale", frame=frame)
    _ease(obj, frame, easing)
    return obj


def set_range(start, end, fps=None):
    sc = bpy.context.scene
    sc.frame_start = int(start)
    sc.frame_end = int(end)
    sc.render.fps = int(_FPS if fps is None else fps)
    sc.render.fps_base = 1.0


# Defaults from the app's Blender panel. Look is reset every run (not saved in the
# .blend); resolution seeds a new session only; fps is set_range's default.
_LOOK = "grey"
_RES = (1280, 720)
_FPS = 24


def look(mode):
    """'grey' (default): flat Workbench. 'lit': Eevee with the scene's own lights,
    shadows and materials — for when the blockout needs to read light direction."""
    global _LOOK
    if mode not in ("grey", "lit"):
        raise ValueError("look must be 'grey' or 'lit'")
    _LOOK = mode


def resolution(width, height):
    """Render size, e.g. resolution(1080, 1920) for a vertical shot. Plain scene state:
    saved in the .blend, never overridden by the bridge (the panel default only seeds a new session)."""
    sc = bpy.context.scene
    sc.render.resolution_x, sc.render.resolution_y = int(width), int(height)
    sc.render.resolution_percentage = 100


def _grey_setup():
    """Workbench flat unless look('lit') asked for Eevee. Resolution is the scene's own."""
    sc = bpy.context.scene
    if _LOOK == "lit":
        sc.render.engine = "BLENDER_EEVEE" if "BLENDER_EEVEE" in {e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items} else "BLENDER_EEVEE_NEXT"
        sc.eevee.taa_render_samples = 16  # ponytail: fixed low sample count, a knob if it looks noisy
    else:
        sc.render.engine = "BLENDER_WORKBENCH"
        sc.display.shading.light = "FLAT"
        sc.display.shading.color_type = "MATERIAL"
    return sc


def playblast(path):
    """Render the frame range to an H264 MP4 at 'path'."""
    sc = _grey_setup()
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    stem = os.path.splitext(path)[0] + "_tmp"
    sc.render.filepath = stem
    if hasattr(sc.render.image_settings, "media_type"):
        sc.render.image_settings.media_type = "VIDEO"  # Blender 5.x gates FFMPEG behind this
    sc.render.image_settings.file_format = "FFMPEG"
    sc.render.ffmpeg.format = "MPEG4"
    sc.render.ffmpeg.codec = "H264"
    sc.render.ffmpeg.constant_rate_factor = "MEDIUM"
    sc.render.use_file_extension = True
    bpy.ops.render.render(animation=True)
    # Blender names an FFMPEG render "<filepath><start>-<end>.mp4"; normalise it.
    produced = "%s%04d-%04d.mp4" % (stem, sc.frame_start, sc.frame_end)
    if not os.path.exists(produced):
        folder = os.path.dirname(stem) or "."
        base = os.path.basename(stem)
        hits = [f for f in os.listdir(folder) if f.startswith(base)]
        if not hits:
            raise RuntimeError("playblast produced no file at %s*" % stem)
        produced = os.path.join(folder, hits[0])
    os.replace(produced, path)
    return path


def still(path, frame):
    sc = _grey_setup()
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    sc.frame_set(int(frame))
    if hasattr(sc.render.image_settings, "media_type"):
        sc.render.image_settings.media_type = "IMAGE"
    sc.render.image_settings.file_format = "PNG"
    sc.render.use_file_extension = False
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    sc.render.use_file_extension = True
    return path


_VIEW_DIRS = {"top": (0, 0, 1), "front": (0, -1, 0), "back": (0, 1, 0), "left": (-1, 0, 0), "right": (1, 0, 0), "iso": (0.6, -0.6, 0.5)}


def view(path, spec):
    """One frame from a vantage that is NOT the shot camera: the model's viewport.
    spec: {"view": preset} (orthographic, framed on every mesh) or {"from": xyz, "at": xyz, "lens": mm}."""
    sc = _grey_setup()
    prev, prev_frame = sc.camera, sc.frame_current
    cam = bpy.data.objects.new("_mb_view", bpy.data.cameras.new("_mb_view"))
    sc.collection.objects.link(cam)
    try:
        if "from" in spec:
            cam.location = tuple(spec["from"])
            at = tuple(spec.get("at", (0, 0, 0)))
            cam.data.lens = float(spec.get("lens", 35))
        else:
            preset = spec.get("view", "iso")
            if preset not in _VIEW_DIRS:
                raise ValueError("view must be one of %s, or {from, at}" % "|".join(_VIEW_DIRS))
            pts = [o.matrix_world @ Vector(c) for o in sc.objects if o.type == "MESH" for c in o.bound_box]
            lo = Vector([min(p[i] for p in pts) for i in range(3)]) if pts else Vector((-5, -5, 0))
            hi = Vector([max(p[i] for p in pts) for i in range(3)]) if pts else Vector((5, 5, 5))
            at = (lo + hi) / 2
            size = max(max(hi - lo), 1.0)
            cam.location = at + Vector(_VIEW_DIRS[preset]).normalized() * size * 2
            cam.data.type = "ORTHO"
            cam.data.ortho_scale = size * 1.1 * max(1.0, sc.render.resolution_x / sc.render.resolution_y)  # ortho_scale spans the wide axis; fit the short one too
            cam.data.clip_end = size * 10
        cam.rotation_euler = _aim(cam.location, at)
        if spec.get("view") == "top":
            cam.rotation_euler = (0.0, 0.0, 0.0)  # _aim flips a straight-down camera 180°; keep +Y at the top of the image
        sc.camera = cam
        still(path, spec.get("frame", prev_frame))
        return {"from": [round(v, 2) for v in cam.location], "rot": [round(math.degrees(v), 1) for v in cam.rotation_euler]}
    finally:
        sc.camera = prev
        sc.frame_set(prev_frame)
        bpy.data.objects.remove(cam, do_unlink=True)


def _fcurves(action):
    try:
        curves = list(action.fcurves)
        if curves:
            return curves
    except (AttributeError, RuntimeError):
        pass
    out = []
    for layer in getattr(action, "layers", []):
        for strip in layer.strips:
            for slot in action.slots:
                bag = strip.channelbag(slot)
                if bag:
                    out.extend(bag.fcurves)
    return out


def _camera_keyframes():
    """Camera pose at its first and last key (plus the total). A per-frame orbit
    has hundreds of keys; the model only needs where the move starts and ends."""
    obj = bpy.context.scene.camera
    if obj is None or obj.animation_data is None or obj.animation_data.action is None:
        return [], 0
    frames = sorted({int(round(kp.co[0])) for fc in _fcurves(obj.animation_data.action) for kp in fc.keyframe_points})
    out = []
    current = bpy.context.scene.frame_current
    for f in frames[:1] + frames[-1:] if len(frames) > 2 else frames:
        bpy.context.scene.frame_set(f)
        out.append({
            "frame": f,
            "location": [round(v, 2) for v in obj.location],
            "rotation": [round(math.degrees(v), 1) for v in obj.rotation_euler],
        })
    bpy.context.scene.frame_set(current)
    return out, len(frames)




def summary():
    """Compact scene digest: what exists, where the camera is and goes, timing."""
    sc = bpy.context.scene
    sc.frame_set(sc.frame_start)  # rest pose, so the reply's diff does not flag animated objects after every render
    objs = list(sc.objects)
    out = []
    for o in objs:  # every object: the reply diff (agentBlender) is what caps the size
        d = {"name": o.name, "type": o.type, "loc": [round(v, 2) for v in o.location]}
        if o.parent is not None:
            d["in"] = o.parent.name
        if o.type == "CAMERA":
            d["lens"] = round(o.data.lens, 1)
        elif o.type == "LIGHT":
            d["light"] = o.data.type
        elif any(abs(s - 1.0) > 0.005 for s in o.scale):
            d["scale"] = [round(v, 2) for v in o.scale]
        if o.type == "MESH" and any(abs(r) > 0.005 for r in o.rotation_euler):
            d["rot"] = [round(math.degrees(v), 1) for v in o.rotation_euler]
        out.append(d)
    keys, nkeys = _camera_keyframes()
    return {
        "objects": out,
        "objects_total": len(objs),
        "camera": sc.camera.name if sc.camera else None,
        "camera_keyframes": keys,
        "camera_key_count": nkeys,
        "frame_range": [sc.frame_start, sc.frame_end],
        "fps": sc.render.fps,
        "resolution": [sc.render.resolution_x, sc.render.resolution_y],
        "look": _LOOK,
    }


def stamp(session, canvas_id=None, runner=None, model=None, step=None):
    sc = bpy.context.scene
    sc["matteblack_session"] = session or ""
    sc["matteblack_canvas_id"] = canvas_id or ""
    sc["matteblack_runner"] = runner or ""
    sc["matteblack_model"] = model or ""
    sc["matteblack_step"] = step or ""


for _name in (
    "greybox", "camera", "camera_move", "keyframe", "group", "set_range",
    "playblast", "still", "summary", "stamp", "look", "resolution", "_fcurves",
):
    setattr(mb, _name, globals()[_name])
mb.bpy = bpy


def _main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if len(argv) < 2:
        raise SystemExit("usage: blender -b --python bridge.py -- <step.py> <session dir> [render json]")
    step_path, session_dir = argv[0], argv[1]
    render = json.loads(argv[2]) if len(argv) > 2 and argv[2] else {}
    cfg = render.get("config") or {}
    global _RES, _FPS
    _RES = (cfg.get("width") or _RES[0], cfg.get("height") or _RES[1])
    _FPS = cfg.get("fps") or _FPS
    if cfg.get("look"):
        look(cfg["look"])
    out_dir = os.path.join(session_dir, "out")
    os.makedirs(out_dir, exist_ok=True)
    mb.out_dir = out_dir
    mb.session_dir = session_dir

    # A fresh session starts empty, not with Blender's default cube+light.
    if not bpy.data.filepath:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        resolution(*_RES)

    with open(step_path, "r", encoding="utf-8") as fh:
        code = fh.read()

    # The step's own print() output is what the model asked to see; Blender's
    # render chatter is not. Capture the former, ship it in the summary block.
    buf = io.StringIO()
    rendered = []
    views = []
    try:
        with contextlib.redirect_stdout(buf):
            exec(compile(code, step_path, "exec"), {"__name__": "__mb_step__", "mb": mb})
        for frame in render.get("stills") or []:
            rendered.append(still(os.path.join(out_dir, "still-%04d.png" % int(frame)), int(frame)))
        if render.get("playblast"):
            rendered.append(playblast(os.path.join(out_dir, "playblast.mp4")))
        for i, spec in enumerate(render.get("views") or []):
            spec = {"view": spec} if isinstance(spec, str) else dict(spec)
            label = str(spec.get("label") or spec.get("view") or "view%d" % (i + 1))
            file = os.path.join(out_dir, "view-%s.png" % re.sub(r"[^a-z0-9]+", "-", label.lower()))
            views.append(dict(view(file, spec), label=label, file=file))
    except Exception as e:  # noqa: BLE001 — every failure must reach the model as one short block
        _emit({"error": _compact_error(e, step_path), "stdout": buf.getvalue()[-2000:]})
        sys.exit(1)

    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(session_dir, "scene.blend"))
    _emit({"summary": summary(), "rendered": rendered, "views": views, "stdout": buf.getvalue()[-2000:]})


def _emit(payload):
    print("MB_SUMMARY_BEGIN")
    print(json.dumps(payload))
    print("MB_SUMMARY_END")


def _compact_error(e, step_path):
    """'ExcType: message' plus only the step's own frames — bridge internals and
    Blender's operator noise are not what the model has to fix."""
    lines = ["%s: %s" % (type(e).__name__, e)]
    for fr in traceback.extract_tb(e.__traceback__):
        if fr.filename == step_path:
            lines.append("  step line %d: %s" % (fr.lineno, fr.line or ""))
    if isinstance(e, (AttributeError, NameError)):
        lines.append("  mb helpers: " + ", ".join(n for n in sorted(dir(mb)) if not n.startswith("_")))
    return "\n".join(lines)


_main()
`;

/**
 * What the model should read when Blender died without printing its summary
 * block (crash, bad binary, killed on timeout): the log minus render progress
 * and startup banners, tail-capped. The happy and Python-error paths never
 * come through here — the harness ships those as one short JSON block.
 */
const NOISE = /^(\s*$|\d\d:\d\d\.\d+\s+(render|blend)\s+\||Fra:|Blender \d|Blender quit|Info: Saved|Read blend|Read prefs)/;
export function digestLog(log: string, max = 3000): string {
  return log.split("\n").filter((l) => !NOISE.test(l)).join("\n").slice(-max);
}

/**
 * Hash of a PNG's pixels, not its bytes: Blender stamps metadata text chunks
 * into every render, so two renders of the same frozen scene differ on disk
 * while being pixel-identical. IHDR (size/format) + IDAT (the image) is what
 * "identical still" actually means.
 */
export function pixelDigest(png: Buffer): string {
  const h = crypto.createHash("sha256");
  for (let i = 8; i + 8 <= png.length; ) {
    const len = png.readUInt32BE(i);
    const type = png.toString("latin1", i + 4, i + 8);
    if (type === "IHDR" || type === "IDAT") h.update(png.subarray(i + 8, i + 8 + len));
    if (type === "IEND") break;
    i += 12 + len;
  }
  return h.digest("hex");
}

/**
 * summary.objects only for what this step touched: the model already saw the
 * rest last turn, and re-reading 30 objects every call is the bulk of the
 * reply text. Names missing from `now` are reported as removed.
 */
export const MAX_DIFF_OBJECTS = 30;
export function diffObjects<T extends { name: string }>(prev: T[] | undefined, now: T[]): { objects: T[]; objects_more?: number; objects_unchanged: number; objects_removed: string[] } {
  const before = new Map((prev ?? []).map((o) => [o.name, JSON.stringify(o)]));
  const changed = now.filter((o) => before.get(o.name) !== JSON.stringify(o));
  const seen = new Set(now.map((o) => o.name));
  // Cap the changed list, never the scene: capping before the diff hid every edit past object 30 in a big scene.
  const more = changed.length - MAX_DIFF_OBJECTS;
  return { objects: changed.slice(0, MAX_DIFF_OBJECTS), ...(more > 0 ? { objects_more: more } : {}), objects_unchanged: now.length - changed.length, objects_removed: [...before.keys()].filter((n) => !seen.has(n)) };
}

// What "Tell the agent" in the Blender add-on turns into: one Continue message for the open Operator session.
export function tellMessage(session: string, b: { selected?: Array<{ name: string; loc: number[]; rot: number[]; scale: number[] }>; viewport?: { from: number[]; at: number[] }; note?: string }): string {
  const sel = (b.selected ?? []).slice(0, 40).map((o) => `${o.name} loc ${JSON.stringify(o.loc)} rot ${JSON.stringify(o.rot)}° scale ${JSON.stringify(o.scale)}`);
  return [
    `Continue Blender session "${session}": the user is in Blender with the scene open.`,
    sel.length ? `They selected ${sel.length} object(s): ${sel.join("; ")}.` : "Nothing is selected.",
    b.viewport ? `Their viewport looks from ${JSON.stringify(b.viewport.from)} at ${JSON.stringify(b.viewport.at)} — pass that as a render view to see what they see.` : "",
    b.note?.trim() ? `They say: "${b.note.trim()}"` : "",
    "Their own edits are already saved in scene.blend: read the summary before editing, then do what they asked and render one peek so they can check.",
  ].filter(Boolean).join(" ");
}
