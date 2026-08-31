---
name: Bridge — long-form continuity
description: Chain many short generations into one continuous long-form video that holds character, style and story.
---

# Bridge — long-form continuity

Use this whenever the ask is longer than one generation: a story, an ad, an explainer, "a 2 minute video",
or any sequence of shots that must feel like one piece. Video models produce 5–15 second clips with no
memory of each other, so continuity is something you carry, not something the model provides.

## 1. Write the bible first (before generating anything)

Produce a short block and keep it verbatim for the whole job. Do not paraphrase it later — drift in the
words is drift in the picture.

- **Look:** one sentence of film stock / lens / grade / lighting. e.g. "shot on 35mm, 40mm anamorphic, warm
  tungsten key with cool practical fill, soft grain".
- **Subjects:** one locked description per recurring subject, 15–25 words, always repeated identically —
  age, build, hair, wardrobe with colours, one distinguishing detail.
- **World:** location, time of day, weather, era.
- **Motion grammar:** how the camera behaves (handheld, locked tripod, slow push).

Show the bible to the user and get a nod before spending generations on shots.

## 2. Beat sheet

Break the story into shots of 5–8 seconds each. For each shot write: beat (what changes), subject action,
camera move, and the **bridge** — the visual element that carries over from the previous shot. A shot with
no bridge is a cut to a different film.

Bridges that work, in order of reliability:
1. **Same subject, new angle** — the locked subject description does the work.
2. **Match on motion** — the previous shot ends on a movement the next shot continues (a hand rising, a
   door swinging, a car leaving frame left → entering frame left).
3. **Match on element** — a colour, prop or shape repeats (the red coat, the neon sign, the horizon line).
4. **Match on light** — the same key direction and colour temperature.

## 3. Keyframe, then animate

Do not chain video-to-video; quality falls off a cliff. Chain through stills:

1. Generate shot 1's **keyframe** as an image (`generate_media` kind: image) using: bible look + subject
   lock + shot description.
2. Animate it: `generate_media` kind: video, the same prompt plus the camera move, with that keyframe's
   URL in `referenceUrls` — that selects the image-to-video path so the clip starts on the frame you
   approved.
3. For shot N, generate the keyframe with shot N-1's keyframe URL in `referenceUrls` and the bridge line
   in the prompt ("same woman, same red coat, now seen from behind as she reaches the door"). Then animate
   as above.
4. Keep every shot the same aspect ratio, resolution and model. Mixing models mid-sequence is the single
   most common cause of a sequence that doesn't cut together.

## 4. Prompt template (use verbatim, fill the brackets)

```
[LOOK]. [SUBJECT LOCK]. [SHOT: what happens, one action only]. [CAMERA: move and framing].
[BRIDGE: what continues from the previous shot]. [WORLD: place, time, weather].
```

One action per shot. Two actions in one prompt is how you get a clip that does neither.

## 5. Assemble the cut

Generate shots in order, and after each one tell the user the shot number, the bridge you used, and the
URL. When every shot exists, call `set_timeline` with the full ordered clip list — src, durationSeconds
and a short label per shot, plus the music bed — and the clips are laid end to end on the user's cinema
timeline. That call IS the edit: send the whole list every time.

If a shot breaks continuity, regenerate that shot only, then re-send the list with the new URL in its
place. Never re-run the whole sequence. Use `get_timeline` to read back what's on the timeline before
you change it. Then tell the user the total runtime and that they can play and export it from the cinema
frame.

## 6. Audio

If the piece needs a bed, call `generate_music` once for the whole sequence with the mood and the total
duration, not per shot — a new track per clip is the fastest way to make eight good shots sound like eight
different films.

## 7. Record the cut

Once the timeline is set, call `save_cut` with the project slug, the title, a couple of sentences describing
what the piece looks like, the bible's look and subject locks, and every shot — its exact prompt, its bridge,
its reference URL and its clip URL. That writes one markdown manifest into the user's local, git-backed cut
history, so the piece can be revisited, varied or rebuilt later without regenerating anything.

Reuse the same `project` across related cuts — that grouping is what makes the history usable. Before
starting a follow-up, call `list_cuts` for that project and read the manifest you're continuing from, so
the new work inherits the same look rather than drifting.

## Save what worked

When the user likes the result, call `save_skill` with the filled-in bible, the beat sheet and the exact
prompts used, so the same world can be revisited later.
