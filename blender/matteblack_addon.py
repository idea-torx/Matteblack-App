"""Matteblack inside Blender: connection, skills, session, send-to-canvas.

Talks to the running Matteblack desktop app over loopback using the discovery
file the app publishes at <dataDir>/mcp-endpoint.json ({baseUrl, token}).
Stdlib only, no threads: every HTTP result is cached for 10s and every socket
gets a 1s timeout, so a panel redraw costs at most one short blocking call.
"""

bl_info = {
    "name": "Matteblack",
    "author": "Matteblack",
    "version": (0, 3, 0),
    "blender": (4, 2, 0),
    "location": "View3D > Sidebar (N) > Matteblack",
    "description": "Matteblack connection, skills and send-to-canvas inside Blender.",
    "category": "3D View",
}

import glob
import json
import math
import os
import re
import struct
import time
import uuid
import urllib.error
import urllib.request

import bpy

# The packaged app keeps state under Electron's userData; a source checkout
# uses ~/.matteblack. Whichever has the freshest endpoint file is the live one.
_HOME = os.path.expanduser("~")
_CANDIDATES = (
    os.path.join(_HOME, "Library", "Application Support", "Matteblack", "data"),
    os.path.join(_HOME, ".matteblack"),
)


def _data_dir():
    if os.environ.get("MATTEBLACK_DATA_DIR"):
        return os.environ["MATTEBLACK_DATA_DIR"]
    live = [d for d in _CANDIDATES if os.path.exists(os.path.join(d, "mcp-endpoint.json"))]
    return max(live, key=lambda d: os.path.getmtime(os.path.join(d, "mcp-endpoint.json"))) if live else _CANDIDATES[1]


def _endpoint_path():
    return os.path.join(_data_dir(), "mcp-endpoint.json")
PINNED = ("blender-blockout", "cinematographer", "storyboard", "action")
CACHE_TTL = 10.0
TIMEOUT = 1.0

_cache = {}  # url -> (expires_at, value|None)


def _endpoint():
    """(baseUrl, token, version) or (None, None, None) when Matteblack was never run."""
    try:
        with open(_endpoint_path(), "r", encoding="utf-8") as f:
            d = json.load(f)
        return d.get("baseUrl"), d.get("token"), d.get("version")
    except Exception:
        return None, None, None


def _get(path):
    """Cached GET. None means "not running" — every failure looks the same."""
    base, token, _ = _endpoint()
    if not base:
        return None
    url = base + path
    now = time.time()
    hit = _cache.get(url)
    if hit and hit[0] > now:
        return hit[1]
    req = urllib.request.Request(url, headers={"x-matteblack-token": token or ""})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            value = json.loads(r.read().decode("utf-8"))
    except Exception:
        value = None
    _cache[url] = (now + CACHE_TTL, value)
    return value


def _post(path, payload, timeout=60.0):
    """(json, None) or (None, message). Not cached — these have side effects."""
    base, token, _ = _endpoint()
    if not base:
        return None, "Matteblack is not running."
    req = urllib.request.Request(
        base + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-matteblack-token": token or ""},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8")), None
    except urllib.error.HTTPError as e:
        return None, "HTTP %s: %s" % (e.code, e.read().decode("utf-8", "replace")[:200])
    except Exception as e:
        return None, str(e)


def _status():
    """('installed'|'running'|'connected', label)."""
    base, _, version = _endpoint()
    if not base:
        return "installed", "Not installed"
    if _get("/api/skills") is None:
        return "running", "Not running"
    return "connected", ("Connected · v%s" % version) if version else "Connected"


def _skills():
    data = _get("/api/skills") or {}
    skills = data.get("skills") or []
    order = {slug: i for i, slug in enumerate(PINNED)}
    return sorted(skills, key=lambda s: (order.get(s.get("slug"), len(PINNED)), s.get("title") or ""))


def _out_dir(scene):
    session = str(scene.get("matteblack_session") or "manual")
    path = os.path.join(_data_dir(), "blender", session, "out")
    os.makedirs(path, exist_ok=True)
    return path


class MATTEBLACK_OT_reconnect(bpy.types.Operator):
    bl_idname = "matteblack.reconnect"
    bl_label = "Reconnect"
    bl_description = "Re-read the Matteblack endpoint and clear the cache"

    def execute(self, context):
        _cache.clear()
        self.report({"INFO"}, "Matteblack: %s" % _status()[1])
        return {"FINISHED"}


class MATTEBLACK_OT_skill(bpy.types.Operator):
    bl_idname = "matteblack.skill"
    bl_label = "Show skill"
    bl_description = "Show this skill's markdown"

    slug: bpy.props.StringProperty()

    def execute(self, context):
        skill = _get("/api/skills/%s" % self.slug)
        if not skill:
            self.report({"ERROR"}, "Could not read skill %s." % self.slug)
            return {"CANCELLED"}
        lines = (skill.get("body") or "").splitlines()[:60] or ["(empty)"]

        def draw(menu, _context):
            for line in lines:
                menu.layout.label(text=line[:120])

        context.window_manager.popup_menu(draw, title=skill.get("title") or self.slug, icon="TEXT")
        return {"FINISHED"}


def _send(op, path):
    """POST the rendered file to the canvas. The route takes a local path under
    <dataDir>/blender/."""
    data, err = _post("/api/agent/import-url", {"path": path})
    if err:
        op.report({"ERROR"}, "Send failed: %s" % err)
        return {"CANCELLED"}
    op.report({"INFO"}, "Sent to canvas: %s" % (data.get("nodeId") or os.path.basename(path)))
    return {"FINISHED"}


class MATTEBLACK_OT_send_still(bpy.types.Operator):
    bl_idname = "matteblack.send_still"
    bl_label = "Send still"
    bl_description = "Render the current frame with Workbench and put it on the canvas"

    def execute(self, context):
        scene = context.scene
        r = scene.render
        saved = (r.engine, r.filepath, r.image_settings.file_format)
        out = os.path.join(_out_dir(scene), "still_%04d_%d.png" % (scene.frame_current, int(time.time())))
        try:
            r.engine = "BLENDER_WORKBENCH"
            r.image_settings.file_format = "PNG"
            r.filepath = out
            bpy.ops.render.render(write_still=True)
        except Exception as e:
            self.report({"ERROR"}, "Render failed: %s" % e)
            return {"CANCELLED"}
        finally:
            r.engine, r.filepath, r.image_settings.file_format = saved
        return _send(self, out)


class MATTEBLACK_OT_send_playblast(bpy.types.Operator):
    bl_idname = "matteblack.send_playblast"
    bl_label = "Send playblast"
    bl_description = "Render the frame range with Workbench to MP4 and put it on the canvas"

    def execute(self, context):
        scene = context.scene
        r = scene.render
        saved = (r.engine, r.filepath, r.image_settings.file_format,
                 r.resolution_x, r.resolution_y, r.resolution_percentage,
                 r.ffmpeg.format, r.ffmpeg.codec)
        stem = os.path.join(_out_dir(scene), "playblast_%d" % int(time.time()))
        try:
            r.engine = "BLENDER_WORKBENCH"
            r.resolution_x, r.resolution_y, r.resolution_percentage = 1280, 720, 100
            r.image_settings.file_format = "FFMPEG"
            r.ffmpeg.format = "MPEG4"
            r.ffmpeg.codec = "H264"
            r.filepath = stem + ".mp4"
            bpy.ops.render.render(animation=True)
        except Exception as e:
            self.report({"ERROR"}, "Render failed: %s" % e)
            return {"CANCELLED"}
        finally:
            (r.engine, r.filepath, r.image_settings.file_format,
             r.resolution_x, r.resolution_y, r.resolution_percentage,
             r.ffmpeg.format, r.ffmpeg.codec) = saved
        # Blender may append the frame range to a movie filename.
        hits = [stem + ".mp4"] if os.path.exists(stem + ".mp4") else sorted(glob.glob(stem + "*"))
        if not hits:
            self.report({"ERROR"}, "Render produced no file.")
            return {"CANCELLED"}
        return _send(self, hits[0])


# ---- Live session: the agent's steps land in this window, the user's notes go back ----

def _session_blend():
    fp = bpy.data.filepath
    root = os.path.join(_data_dir(), "blender") + os.sep
    return fp if fp and fp.startswith(root) and os.path.basename(fp) == "scene.blend" else None


class MATTEBLACK_OT_pause(bpy.types.Operator):
    bl_idname = "matteblack.pause"
    bl_label = "Pause / resume agent edits"
    bl_description = "Hold queued steps while you inspect or edit the scene"

    def execute(self, context):
        context.scene["matteblack_paused"] = not context.scene.get("matteblack_paused", False)
        return {"FINISHED"}


def _view_area(context):
    if context.area and context.area.type == "VIEW_3D":
        return context.area
    return next((a for a in context.screen.areas if a.type == "VIEW_3D"), None)


def _viewport(context):
    """Where the user is looking: the 3D view's eye and the point it orbits."""
    area = _view_area(context)
    if area:
        r3d = area.spaces.active.region_3d
        eye = r3d.view_matrix.inverted().translation
        return {"from": [round(v, 2) for v in eye], "at": [round(v, 2) for v in r3d.view_location]}
    return None


_VIEW_PROPS = ("view_rotation", "view_location", "view_distance", "view_perspective",
               "view_camera_zoom", "view_camera_offset")


def _view_state(area):
    space = area.spaces.active
    state = {}
    for key in _VIEW_PROPS:
        value = getattr(space.region_3d, key)
        state[key] = list(value) if hasattr(value, "__len__") and not isinstance(value, str) else value
    return {"region": state, "lens": space.lens, "shading": space.shading.type}


def _apply_view(area, state):
    space = area.spaces.active
    for key, value in state["region"].items():
        setattr(space.region_3d, key, value)
    space.lens = state["lens"]
    space.shading.type = state["shading"]
    space.region_3d.update()


def _camera_state(context, area):
    space = area.spaces.active
    camera = space.camera if space.use_local_camera else context.scene.camera
    if not camera:
        return None
    r = context.scene.render
    return [str(camera.matrix_world), camera.data.type, camera.data.lens,
            camera.data.ortho_scale, camera.data.shift_x, camera.data.shift_y,
            r.resolution_x, r.resolution_y, r.pixel_aspect_x, r.pixel_aspect_y]


def _screenshot(context, area, file):
    if area.spaces.active.region_quadviews:
        raise RuntimeError("Use a single 3D view for a viewport comparison.")
    region = next(r for r in area.regions if r.type == "WINDOW")
    window, screen = context.window, context.screen
    context.view_layer.update()
    area.tag_redraw()
    with context.temp_override(window=window, screen=screen, area=area, region=region):
        bpy.ops.wm.redraw_timer(type="DRAW_WIN_SWAP", iterations=1)
    # redraw_timer clears the area context in Blender 5.1. Re-enter it, or
    # screenshot_area silently writes a 1x1 crop of the previous framebuffer.
    with context.temp_override(window=window, screen=screen, area=area, region=region):
        result = bpy.ops.screen.screenshot_area("EXEC_AREA", filepath=file, hide_props_region=False, check_existing=False)
    if "FINISHED" not in result or not os.path.exists(file):
        raise RuntimeError("Blender could not capture the viewport.")
    with open(file, "rb") as f:
        header = f.read(24)
    if len(header) < 24 or min(struct.unpack(">II", header[16:24])) < 100:
        raise RuntimeError("Blender returned an empty viewport capture. Try again once the view has drawn.")


def capture_tell(context):
    """Capture before opening the note dialog, keeping overlays and selection."""
    area = _view_area(context)
    if not area:
        raise RuntimeError("Open a 3D viewport first.")
    capture = "tell-" + uuid.uuid4().hex
    out = _out_dir(context.scene)
    file = os.path.join(out, capture + ".png")
    _screenshot(context, area, file)
    state = {"view": _view_state(area), "area": area.as_pointer(),
             "size": [area.width, area.height], "frame": context.scene.frame_current,
             "subframe": context.scene.frame_subframe, "camera": _camera_state(context, area)}
    with open(os.path.join(out, capture + ".json"), "w", encoding="utf-8") as f:
        json.dump(state, f)
    return capture


def compare_viewport(capture, out_dir):
    """Use the artist's saved view; restore their current view afterwards."""
    if not isinstance(capture, str) or not re.fullmatch(r"tell-[a-f0-9]{32}", capture):
        raise ValueError("viewport must be the capture ID from Tell the agent.")
    with open(os.path.join(out_dir, capture + ".json"), encoding="utf-8") as f:
        saved = json.load(f)
    context = bpy.context
    area = next((a for a in context.screen.areas if a.as_pointer() == saved["area"] and a.type == "VIEW_3D"), None)
    if not area or [area.width, area.height] != saved["size"]:
        raise RuntimeError("The captured viewport was closed or resized. Send a new note from that view.")
    current, frame, subframe = _view_state(area), context.scene.frame_current, context.scene.frame_subframe
    file = os.path.join(out_dir, capture + "-after-" + uuid.uuid4().hex + ".png")
    try:
        context.scene.frame_set(saved["frame"], subframe=saved.get("subframe", 0))
        if saved["view"]["region"]["view_perspective"] == "CAMERA" and saved["camera"] != _camera_state(context, area):
            raise RuntimeError("The shot camera or framing changed. Send a new note for a matching comparison.")
        _apply_view(area, saved["view"])
        _screenshot(context, area, file)
    finally:
        _apply_view(area, current)
        context.scene.frame_set(frame, subframe=subframe)
        area.tag_redraw()
    return {"before": os.path.join(out_dir, capture + ".png"), "after": file}


class MATTEBLACK_OT_tell(bpy.types.Operator):
    bl_idname = "matteblack.tell"
    bl_label = "Tell the agent"
    bl_description = "Send the selected objects, your viewport and a note to the Operator as the next step of this session"

    note: bpy.props.StringProperty(name="Note", description="What should change")

    def invoke(self, context, event):
        try:
            self.capture = capture_tell(context)
        except Exception as e:
            self.report({"ERROR"}, str(e))
            return {"CANCELLED"}
        return context.window_manager.invoke_props_dialog(self, width=420)

    def execute(self, context):
        scene = context.scene
        session = str(scene.get("matteblack_session") or "")
        if not session:
            self.report({"ERROR"}, "This file is not a Matteblack session.")
            return {"CANCELLED"}
        selected = [{
            "name": o.name,
            "loc": [round(v, 2) for v in o.matrix_world.translation],
            "rot": [round(math.degrees(v), 1) for v in o.rotation_euler],
            "scale": [round(v, 2) for v in o.scale],
        } for o in context.selected_objects]
        try:
            capture = getattr(self, "capture", None) or capture_tell(context)
        except Exception as e:
            self.report({"ERROR"}, str(e))
            return {"CANCELLED"}
        _, err = _post("/api/agent/blender/tell", {
            "session": session, "canvasId": scene.get("matteblack_canvas_id"), "selected": selected, "viewport": _viewport(context), "note": self.note,
            "capture": capture,
        }, timeout=15.0)
        if err:
            self.report({"ERROR"}, "Tell failed: %s" % err)
            return {"CANCELLED"}
        self.report({"INFO"}, "Sent to the Operator (%d selected)." % len(selected))
        return {"FINISHED"}


class MATTEBLACK_PT_panel(bpy.types.Panel):
    bl_label = "Matteblack"
    bl_idname = "MATTEBLACK_PT_panel"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Matteblack"

    def draw(self, context):
        layout = self.layout
        state, label = _status()

        box = layout.box()
        box.label(text=label, icon="LINKED" if state == "connected" else "UNLINKED")
        box.operator("matteblack.reconnect", icon="FILE_REFRESH")

        if state == "connected":
            box = layout.box()
            box.label(text="Skills")
            for s in _skills():
                box.operator("matteblack.skill", text=s.get("title") or s.get("slug"),
                             icon="TEXT").slug = s.get("slug") or ""

        scene = context.scene
        box = layout.box()
        box.label(text="Session")
        fields = [("Session", "matteblack_session"), ("Canvas", "matteblack_canvas_id"),
                  ("Runner", "matteblack_runner"), ("Model", "matteblack_model"),
                  ("Step", "matteblack_step")]
        shown = [(name, scene.get(key)) for name, key in fields if scene.get(key)]
        if shown:
            for name, value in shown:
                box.label(text="%s: %s" % (name, value))
        else:
            box.label(text="No Matteblack session")
        box.label(text="Frames %d–%d @ %g fps" % (
            scene.frame_start, scene.frame_end, scene.render.fps / scene.render.fps_base))

        if scene.get("matteblack_session"):
            box = layout.box()
            box.label(text="Live with the agent")
            paused = scene.get("matteblack_paused", False)
            box.label(text="Agent edits paused" if paused else "Agent edits this visible scene", icon="PAUSE" if paused else "LINKED")
            box.operator("matteblack.pause", text="Resume agent edits" if paused else "Pause agent edits")
            box.label(text="Cmd/Ctrl Z: undo the last step")
            box.operator("matteblack.tell", icon="OUTLINER_OB_SPEAKER")

        box = layout.box()
        box.label(text="Send to canvas")
        box.operator("matteblack.send_still", icon="RENDER_STILL")
        box.operator("matteblack.send_playblast", icon="RENDER_ANIMATION")


CLASSES = (
    MATTEBLACK_OT_reconnect,
    MATTEBLACK_OT_pause,
    MATTEBLACK_OT_tell,
    MATTEBLACK_OT_skill,
    MATTEBLACK_OT_send_still,
    MATTEBLACK_OT_send_playblast,
    MATTEBLACK_PT_panel,
)


def register():
    for cls in CLASSES:
        bpy.utils.register_class(cls)


def unregister():
    for cls in reversed(CLASSES):
        bpy.utils.unregister_class(cls)
