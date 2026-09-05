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
Use the label menu on each reference thumbnail to identify front/side/back/top,
proportions, material, detail, or style. Labels survive subsequent Blender turns
and follow the file when reordered. `referenceLabels` accepts one label per saved
reference; Python receives the path-to-label mapping in `mb.reference_labels`.
An explicit `references` array replaces the set and `[]` clears it. Image/video
generation retains its existing provider limits.

Use the N-sidebar's Matteblack tab to **Tell the agent** what should change,
including the selected objects and an actual viewport screenshot taken before
the note dialog opens, or **Pause agent edits** while
working. The conversation continues in the existing Operator. Modeling skills
are optional guidance; raw `bpy`/BMesh remains available and the blockout skill is
only for previs.

The note includes a capture ID. After a meaningful change, the agent passes
`render: { viewport: "tell-…" }` to receive before/after screenshots from that
saved view, with image URLs to show in its reply. This captures Blender's editor,
including selection outlines and overlays. The current view and frame are
restored afterwards. Viewport evidence is kept separate from modeling references,
and a Blender note does not consume pending attachments or canvas selections.
The conversation shows the artist's note, selection, and screenshot; file paths
and tool instructions are supplied to the agent separately.

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
- Comparisons need the original viewport to remain open at the same size in
  the same Blender process. Quad views are not supported. If the shot camera
  moves, send a fresh note. A comparison failure is reported separately from a
  successful edit; it does not ask the agent to repeat the edit. Viewport shading
  and overlays are evidence of the working scene, not a final render.

## Checks

```sh
node --import tsx --test server/blender/bridge.test.ts server/blender/sessions.test.ts server/utils/referenceFiles.test.ts
MB_TEST_VISIBLE=1 node --import tsx --test server/blender/live.test.ts
MB_TEST_VISIBLE=1 node --import tsx --test server/blender/viewport.test.ts
```

The second command opens and closes its own disposable Blender window. It checks
visible execution, preservation of artist edits, native Undo, checkpoint restore,
and cancellation of queued steps. Set `MB_BLENDER_PATH` for a non-default install.
