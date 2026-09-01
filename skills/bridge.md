---
name: Bridge — long-form continuity
description: Chain short generations into one continuous long-form video that holds character, style and story — and know exactly where each narrative unit ends.
---

# Bridge — long-form continuity

Use this whenever the ask is longer than one generation: a story, an ad, an explainer, "a 2 minute video",
or any sequence of shots that must feel like one piece. Video models produce short clips with no memory of
each other, so continuity is something you carry, not something the model provides.

## 0. Fewest seams wins

Every join is a place the piece can break. Before planning any chain, take the highest rung that fits:

1. **One generation, zero seams.** A continuous piece up to ~30s fits in a single seedance-2.5 clip
   (up to 30s, native audio). If the whole ask fits in one clip, chain nothing.
2. **`continue_video` for everything inside a scene.** It reads the real end of the previous clip — its
   exact last frame (`seam='frame'`) or its final seconds (`seam='reference'`) — and feeds it into the
   next H3 Max generation. This is the strongest join in the toolbox: the model literally starts from
   where the picture left off.
3. **Keyframe + `generate_media` for hard cuts only.** A fresh still animated with `first_frame` is how
   you start a NEW scene — it is a cut, and it should only appear where the story cuts.

## 1. Draw the lines first: where does each narrative unit end?

The single most common failure is joining two chunks with the wrong seam. Decide every boundary before
generating anything, from what changes across it:

| Boundary between chunk N and N+1 | Join |
|---|---|
| Same shot, action continuing | `continue_video` `seam='frame'` — invisible, starts on the exact last frame |
| Same scene, new angle or camera reposition | `continue_video` `seam='reference'` — carries motion and identity, not the frame |
| New scene, new location, or a time jump | Hard cut: new keyframe + `generate_media` (`first_frame`), then keep chaining inside the new scene |
| The rest of the piece fits in one clip | One generation, no join |

A seam across a scene boundary smears two scenes into each other; a hard cut mid-action breaks the shot.
If you cannot say which beat of the arc a chunk serves, the narrative unit ended a chunk ago — stop
chaining and cut.

## 2. Write the bible (before generating anything)

Produce a short block and keep it verbatim for the whole job. Do not paraphrase it later — drift in the
words is drift in the picture.

- **Look:** one sentence of film stock / lens / grade / lighting. e.g. "shot on 35mm, 40mm anamorphic, warm
  tungsten key with cool practical fill, soft grain".
- **Subjects:** one locked description per recurring subject, 15–25 words, always repeated identically —
  age, build, hair, wardrobe with colours, one distinguishing detail. Generate one still of each recurring
  subject up front (`generate_media` kind: image) and keep its URL — that still is the identity anchor for
  the whole chain.
- **World:** location, time of day, weather, era.
- **Motion grammar:** how the camera behaves (handheld, locked tripod, slow push).

Show the bible to the user and get a nod before spending generations on shots.

## 3. Beat sheet — plan every seam at a rest point

Break the story into chunks of 5–15 seconds. Prefer longer chunks when the beat allows: fewer seams for
the same runtime. For each chunk write: beat (what changes, as `[before] → [after]`), the one action, the
camera, the join to the next chunk (from the table above), and **what the chunk ends on**.

The end matters because `seam='frame'` restarts generation from a single still frame — a boundary placed
in the middle of fast motion halts or reverses that motion on screen. So:

- End each chunk on a **holdable pose**: a stance, a look, a landed gesture — something a paused frame
  can carry into the next generation.
- When motion must cross the boundary (a run, a fall, a pan), use `seam='reference'` — its tail clip
  carries the motion vector a still cannot.

## 4. Generate the chain

1. **Shot 1:** keyframe as an image (bible + shot description), then animate it (`generate_media` kind:
   video, `first_frame`) — or straight text-to-video if the piece is t2v.
2. **Every following chunk in the same scene:** `continue_video` with `sourceUrl` = the previous chunk's
   result URL and the seam from your table. Never regenerate the source; the tool reads its end for you.
3. **On every `seam='reference'` chunk, pass the subject stills from step 2 of the bible in
   `referenceUrls`.** The tail only carries the last few seconds; the pinned stills are what hold
   identity together once the opening frames are many chunks behind.
4. **At a hard cut:** new keyframe with the bible + the new scene, animate with `first_frame`, then
   resume chaining inside the new scene.
5. Keep `resolution` identical on every chunk, and pass `aspectRatio` explicitly on every
   `seam='reference'` chunk of a non-16:9 piece — that path cannot read the shape off the tail.

## 5. Per-chunk prompt (use verbatim, fill the brackets)

```
[LOOK]. [SUBJECT LOCK, repeated character for character].
BEAT [n] of [N]: [before] → [after].
[ACTION: what happens in this chunk, one action only].
[CAMERA: move and framing].
END ON: [the rest pose this chunk holds, or the motion the next chunk continues].
```

The bible is pasted verbatim on every chunk — the previous clip's tail shows the model the picture, not
your words, and unrepeated words drift. Naming the beat and its position (`BEAT 3 of 7`) is what keeps
the arc from dissolving into "and then more happens": every chunk must move its beat's before to its
after, and a chunk that moves nothing is cut from the sheet, not padded with adjectives.

One action per chunk. Two actions in one prompt is how you get a clip that does neither.

## 6. Assemble the cut

Generate chunks in order, reporting the chunk number, the join used, and the URL as each lands. When every
chunk exists, call `set_timeline` with the full ordered clip list — src, durationSeconds and a short label
per chunk, plus the music bed. That call IS the edit: send the whole list every time.

If a chunk breaks continuity, regenerate that chunk only — with the same sourceUrl and seam — then re-send
the list with the new URL in its place. Never re-run the whole sequence. Use `get_timeline` to read back
what's on the timeline before you change it. Then tell the user the total runtime and that they can play
and export it from the cinema frame.

## 7. Audio

If the piece needs a bed, call `generate_music` once for the whole sequence with the mood and the total
duration, not per chunk — a new track per clip is the fastest way to make eight good chunks sound like
eight different films.

## 8. Record the cut

Once the timeline is set, call `save_cut` with the project slug, the title, a couple of sentences describing
what the piece looks like, the bible's look and subject locks, and every chunk — its exact prompt, its join
(seam or cut), its reference URL and its clip URL. That writes one markdown manifest into the user's local,
git-backed cut history, so the piece can be revisited, varied or rebuilt later without regenerating anything.

Reuse the same `project` across related cuts — that grouping is what makes the history usable. Before
starting a follow-up, call `list_cuts` for that project and read the manifest you're continuing from, so
the new work inherits the same look rather than drifting.

## Save what worked

When the user likes the result, call `save_skill` with the filled-in bible, the beat sheet with its joins,
and the exact prompts used, so the same world can be revisited later.
