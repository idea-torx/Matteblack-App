---
name: Action bridge — chaining continuous action without killing it
description: Owns continue_video chains for fights, chases, creature and kaiju action. Replaces bridge's chaining flow for action — protects momentum across every seam so clips don't open on a pause, reverse their motion, or change camera mid-take.
---

# Action bridge — chaining continuous action without killing it

`bridge` chains scenes where people talk; its seams rest, its beats hand off narratively, its camera
varies. Chained ACTION dies by exactly those rules. When a fight, chase, monster rampage or any
continuous physical take must be built from `continue_video` chunks, this skill replaces bridge's
chaining flow. `action` still owns the choreography inside each chunk; `bridge` still owns the bible
and the assembly; this owns the seams.

The three ways a chained action take dies — every rule below exists to kill one of them:

1. **The opening pause.** The continuation settles, breathes, re-establishes — seconds of a monster
   standing still before it acts.
2. **The reversal.** The tail hands the model an ambiguous few frames; unnamed, the motion vector gets
   re-invented, often backwards — a swing that retracts, a step that un-steps.
3. **The jarring camera.** Each chunk invents its own camera, and the take reads as five different
   shots pretending to be one.

## 1. Frame one is mid-action — the pacing budget, physical

Every chunk after the first opens with the inherited motion ALREADY completing. State it as the first
timecoded beat and as an explicit budget line:

```
PACING: [SUBJECT] is already mid-[motion] as the very first frame begins — no pause, no settling, no
re-establishing, no beat of stillness. 0-1s: [the tail's motion completes — the swing lands, the
stride plants]. 1-3s: [next action]. ...
```

Negative prompt, every chunk: `pause at the start, standing still, frozen subject, waiting,
re-settling, slow start, subject resetting its stance, motionless first second`.

A chunk that opens with a pause anyway is a REROLL, not a trim problem — the pause also poisons the
motion that follows it.

## 2. Re-declare the motion vector, verbatim, every chunk

Reversal happens because the prompt never says which way things were moving. Carry a MOTION line in
the bible and restate it in every chunk, updated only when the action genuinely changes it:

```
MOTION: Godzilla advances screen left-to-right, tail sweeping behind him right-to-left, buildings
collapsing toward camera.
```

- Name the direction of every moving mass — body, limbs, tail, debris, vehicles. The model cannot
  reverse what the prompt has pinned.
- Screen direction holds across every seam. It changes ONLY at a hard cut, never through a chain.
- A chunk whose motion plays backwards against its MOTION line is a reroll with the line moved to the
  front of the prompt, stated twice.

## 3. One camera for the whole chain

Inside one chained take the camera is BORING ON PURPOSE. Write one camera sentence into the bible and
paste it verbatim into every chunk — same framing, same height, same move (or same locked-off), same
lens:

```
CAMERA (every chunk, verbatim): low-angle wide from street level, 24mm, locked-off, horizon level.
```

- The subject carries all the energy; camera variety is what hard cuts are for. If you want a new
  angle, that is a CUT — end the chain, cut, start a new chain.
- Never let a chunk "improve" the framing. A slightly different height or angle per chunk is exactly
  the jarring drift between clips.
- Negative prompt, every chunk: `camera reframing, camera drift, new camera angle, camera height
  changing, zoom, orbit`.

## 4. Every second has motion — action beat density

Dialogue clips hold reactions; action clips that hold anything die. Timecode the full runtime with
continuous physical beats — no gaps, each beat flowing out of the last one's follow-through:

```
0-1s: the tail swing completes, smashing the facade. 1-3s: he wades forward through the rubble,
shoulders driving. 3-5s: his head snaps toward the jets banking in from frame right.
```

"Then he pauses", "he surveys the destruction", "he stands amid the smoke" — these are how the model
buys itself a rest. If a survey beat is wanted, it is its own shot on a hard cut, not a beat inside a
chain.

## 5. Seams

- Every join is `seam='reference'`. Never `seam='frame'` inside continuous action — a still frame has
  no velocity and the re-invented motion is where reversals come from.
- Pass the subject stills in `referenceUrls` on every chunk (bridge's identity rule — doubly needed
  for creatures, whose anatomy drifts fast).
- Chunks end ON a motion, named: "END ON: the tail still mid-sweep, debris still airborne". Debris and
  destruction are momentum too — rubble that settles at a seam reads as a pause.
- The chain earns at most ONE rest seam, at the sequence's turn, and it is one breath, not a survey.

## 6. Keep the chain short

Each seam compounds risk: three chunks chain well, six drift. Plan action as SHORT chains between hard
cuts — chain the continuous take that needs it (the charge, the building collapse, the exchange), cut
to a new angle, start fresh. The cut resets every accumulated error for free, and `action`'s coverage
grammar wants the angle change anyway. A 60-second rampage is five short chains and four cuts, not one
eleven-chunk chain.

## 7. Assemble

Trim every seam's dead frames on the timeline even when the chain behaves — the first and last half
second of each chunk are where the model eases in and out, and the trim is what makes the take read
as one motion. Then `set_timeline`, `save_cut` with the MOTION and CAMERA lines recorded per chunk, so
the next sequence in this world inherits the vectors and not just the look.
