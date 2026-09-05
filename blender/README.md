# Visible Blender collaboration

Start or continue a session from Matteblack's Blender panel. `blender_run` opens a
visible Blender window once, then edits that window's in-memory scene. **Open in
Blender** uses the same connection. Existing sessions retain their scene settings.
The bridge does not run modeling in a background process or reload a file over
the artist's unsaved edits.

Select up to 16 reference images on the canvas or attach them to the Operator.
They are staged as immutable, content-addressed files and saved with the Blender
session's reference manifest. Subsequent turns keep them. The model can inspect
them with `inspectReferences: true`; Python receives their paths in `mb.references`.
An explicit `references` array replaces the set and `[]` clears it. Image/video
generation retains its existing provider limits.

Use the N-sidebar's Matteblack tab to **Tell the agent** what should change,
including the selected objects and viewport, or **Pause agent edits** while
working. The conversation continues in the existing Operator. Modeling skills
are optional guidance; raw `bpy`/BMesh remains available and the blockout skill is
only for previs.

Each short step is a native Blender undo operation (Cmd/Ctrl Z). A
`before-N.blend` checkpoint includes the artist's unsaved edits; successful steps
also save `scene.step-N.blend`. A Python failure can leave partial visible edits:
Undo restores the pre-step state. Explicit `revert: N` opens a saved checkpoint,
retaining a before-step recovery copy, and resets Blender's native undo history.

Preview rendering preserves the engine, output settings and current frame.
`render.look` can temporarily request `grey`, `lit`, or `scene` (the default).
Scene summaries include mesh fingerprints, dimensions, modifiers, selection and
current mode so the agent can detect geometry changes without a render.

## Current limits

- Python executes on Blender's UI thread. Keep steps short: a long script or
  synchronous render blocks interaction until it returns. Stop cancels queued
  work; it never kills the artist's window or preempts a running Python call.
- Steps wait while the session is paused, in Edit/Sculpt mode, playing animation,
  or running a modal operator. A queued step expires after 15 minutes.
- A session has one visible owner. Open it through Matteblack to attach the live
  bridge. A separately opened copy is not connected to that owner.
- Checkpoints and referenced attachment files are retained without automatic
  pruning. Mesh fingerprinting scans mesh coordinates and topology each step;
  very dense meshes may need incremental change tracking later.

## Checks

```sh
node --import tsx --test server/blender/bridge.test.ts server/blender/sessions.test.ts server/utils/referenceFiles.test.ts
MB_TEST_VISIBLE=1 node --import tsx --test server/blender/live.test.ts
```

The second command opens and closes its own disposable Blender window. It checks
visible execution, preservation of artist edits, native Undo, checkpoint restore,
and cancellation of queued steps. Set `MB_BLENDER_PATH` for a non-default install.
