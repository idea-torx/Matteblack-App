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
   next generation. This is the strongest join in the toolbox: the model literally starts from where the
   picture left off. It runs on H3 Max (default, 5–15s chunks) or `model='seedance-2.5'` (4–30s chunks,
   native audio) — seedance's longer chunks mean fewer seams for the same runtime, so prefer it for long
   pieces with dialogue or sound. Pick ONE model for the whole sequence and never mix families mid-chain;
   each family has its own look and a switch reads as a grade change.
3. **Keyframe + `generate_media` for hard cuts only.** A fresh still animated with `first_frame` is how
   you start a NEW scene — it is a cut, and it should only appear where the story cuts.

## 1. Draw the lines first: where does each narrative unit end?

The single most common failure is joining two chunks with the wrong seam. Decide every boundary before
generating anything, from what changes across it:

| Boundary between chunk N and N+1 | Join |
|---|---|
| Same shot, action continuing | `continue_video` `seam='frame'` — invisible, starts on the exact last frame. For fight/chase chains use `seam='reference'` — see the action override in §3 |
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

**Shape the arc to the runtime before chunking it.** Give each chunk ONE story function — establish,
build, turn, payoff — and place the turn at roughly two-thirds of the total runtime, the payoff in the
final chunk only. In a 4-chunk piece: chunk 1 establishes, chunks 2–3 escalate (the turn lands late in
3), chunk 4 pays off. A middle chunk raises pressure and *withholds* — it never resolves, reveals, or
lands the ending early; if the story is over by chunk 2, the remaining chunks are padding and it will
feel like it. When a chunk's share of story feels thin, that is correct: the clip fills its seconds with
behavior and texture, the arc only needs one change per chunk.

**Hold screen direction and camera direction inside a scene.** A subject moving left-to-right keeps
moving left-to-right across every seam; a camera move continues or comes to rest across a join — it never
reverses. Write the direction into every chunk's CAMERA line. A direction flip reads as a cut even when
the seam itself is invisible; save flips for the hard cuts, where they belong.

This is a rule about **joins**, not about clips. It applies where one chunk continues into the next under
`seam='frame'`. A standalone clip, or one that ends on a hard cut, joins nothing — it can move
throughout and end mid-move. Do not carry rest-at-the-seam into work that has no seam.

Break the story into chunks of 5–15 seconds. Prefer longer chunks when the beat allows: fewer seams for
the same runtime. For each chunk write: beat (what changes, as `[before] → [after]`), the one action, the
camera, the join to the next chunk (from the table above), and **what the chunk ends on**.

The end matters because `seam='frame'` restarts generation from a single still frame — a boundary placed
in the middle of fast motion halts or reverses that motion on screen. So:

- End each chunk on a **holdable pose**: a stance, a look, a landed gesture — something a paused frame
  can carry into the next generation.
- When motion must cross the boundary (a run, a fall, a pan), use `seam='reference'` — its tail clip
  carries the motion vector a still cannot.

**Action sequences INVERT the rest-pose rule.** In a fight or chase, a rest-point seam is the failure
mode: told to end holdable, the model manufactures one — a fighter falls over, lies there, then the
next chunk opens with seconds of him getting back up. The pacing dies at every join. For any chain
`action` applies to:

- Every join inside the fight is `seam='reference'`, never `seam='frame'` — the tail carries the
  momentum, and motion crosses the seam still in flight.
- `END ON:` names a motion, not a pose: "END ON: his cross still travelling toward the jaw". The next
  chunk's ACTION line opens by completing it ("the cross lands —") so frame one is mid-strike.
- Never write "falls", "collapses", "drops", "staggers back and pauses" at a chunk end unless it is
  the fight's finish. A body on the floor is a rest point the model will milk.
- The only legal rest-point seams in a fight: the turn (the one breath `action` §3 allows) and after
  the finish.
- Prefer `action`'s native mode — separate 5s clips hard-cut and trimmed on the timeline — over a
  continue chain at all; chain only when one take must genuinely continue, and trim the seam's dead
  frames out regardless.

## 4. Generate the chain

1. **Shot 1:** keyframe as an image (bible + shot description), then animate it (`generate_media` kind:
   video, `first_frame`) — or straight text-to-video if the piece is t2v.
2. **Every following chunk in the same scene:** `continue_video` with `sourceUrl` = the previous chunk's
   result URL, the seam from your table, and the sequence's one `model` repeated on every call. Never
   regenerate the source; the tool reads its end for you.
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

Narration is `generate_voiceover`: one call per line or paragraph, the same voice throughout, so each
line can be placed against the picture it belongs to. Write the words as they should be heard — the
punctuation is what paces the read.

A cut can carry several audio tracks at once, and `set_timeline`'s `audio` list is how you lay them:
each entry takes a `track` (0-7), a `startSeconds` and a `volume`. Keep one thing per track — the bed
on track 0, the voiceover on track 1, effects on track 2 — because two entries on the SAME track play
one after the other, not together. Place each VO line at the second its shot starts, and duck the bed
under it (`volume` around 0.25 against the voice's 1.0) or the words disappear into the music. The list
is declarative like the clips: send every bed you want, every time, or leave the key out to keep what's
already there.

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
