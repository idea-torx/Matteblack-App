---
name: Realism — weight, skin and speech
description: Make realistic H3/seedance clips read as footage instead of render — fixes rubbery motion, strange dialogue and wooden, surreal takes. Use alongside cinematographer (structure) on every live-action shot.
---

# Realism — weight, skin and speech

`cinematographer` decides the shot's structure, lens and light. This skill decides whether the result
reads as FOOTAGE or as a render. It ports the discipline that makes `animated-2d-ad` reliable — material
physics stated obsessively, timing stated explicitly, failure modes banned by name — onto live action.

The three complaints it exists to kill, and their causes:

- **Rubbery motion** — the prompt never mentioned mass. The model defaults to easing curves, not muscle.
- **Strange dialogue** — the voice was unspecified and untimed, so it drifts, crams late, or floats free
  of the mouth.
- **Wooden / surreal takes** — the subject was given a pose instead of behavior, and nothing banned the
  dream-drift the model falls into when under-constrained.

## 1. Weight paragraph (the anti-rubber block — include verbatim, always)

The 2D skill's "Pace" paragraph, translated to flesh. Paste it into every realistic prompt, early:

```
Movement is driven by muscle and weight. Every motion has a wind-up, an effort and a settle: feet plant
and take weight, shoulders lead turns, hands grip with pressure, nothing glides or floats. The body is
never perfectly still — breathing is visible, weight shifts between feet, eyes make small refocusing
movements. Cloth and hair obey gravity and momentum, trailing a beat behind the body. All motion plays
at true speed, no slow motion, no speed ramps.
```

## 2. Materials, named (the anti-plastic block)

The 2D prompt names yarn, felt, paper grain. A realistic prompt must name its materials with the same
obsession, or everything renders as the same waxy default:

- **Skin:** "natural skin texture with visible pores, slight asymmetry, faint sheen on forehead and
  nose" — never "flawless", never "beautiful skin". The model's beauty prior hits women hardest: it
  airbrushes them toward a poreless makeup-commercial finish unless the prompt pushes back harder
  than it does for men. For women, state the texture twice — once in the subject description, once as
  light interacting with it: "visible pores and fine facial down catching the sidelight, uneven skin
  tone, faint under-eye shadow, lived-in skin, no retouched look". Words like "gorgeous" or
  "stunning" re-trigger the airbrush; describe the person, never their rating.
- **Fabric:** name the actual textile and how it behaves — "a creased cotton work shirt", "heavy wool
  coat that swings with her stride". "Nice clothes" is what produces vinyl.
- **Environment:** two or three surfaces with wear — "scuffed linoleum", "rain-spotted glass",
  "chipped enamel mug". Wear is what separates a location from a set.

## 3. Dialogue (the fix for strange speech)

Every rule here is lifted from the 2D skills' VO discipline, which took rerolls to find:

- **Cast the voice fully, top of prompt:** age, gender, accent, temperament, mic feel — "a woman in her
  50s, low flat Ohio accent, tired but warm, close-mic, dry, no reverb". **State the accent twice** —
  once when the voice is introduced, once beside the lines. One mention gets ignored.
- **Time every line in seconds**, exactly like the template: `From 1.0 to 3.2 seconds she says: "..."`.
  Untimed lines cram into the back half or trail past the cut.
- **First words land inside the first second.** "Speech begins immediately, no silent opening."
- **Write speech as it is spoken:** contractions, a hesitation, a breath — "Well — no. Not this time."
  Grammatically perfect lines are read like a press release, and that IS the wooden delivery.
- **On camera, name the sync:** "her lips form these exact words, in sync." Off camera, say the mouth is
  not visible — half-visible mouths are where sync breaks.
- **Two voices maximum per clip**, and say "no other voices, no narrator" — or one arrives anyway.

## 4. Behavior, not poses (the anti-wooden block)

A subject "standing in a kitchen" is a mannequin. Give every person on screen one piece of continuous
BUSINESS that runs under the beat — drying the same glass, worrying a ring, peeling a label — and an
eye-line ("she watches the door, not the camera"). The 2D motif rule, embodied: something specific is
always in motion, so the frame never dies. One business per person; two reads as chaos.

## 5. Ground the camera and the grade

- The camera is a physical object: "handheld with slight breathing sway" or "locked off on sticks" —
  never unmotivated drift, which is the single strongest surreal tell.
- Grade by naming real acquisition, not a mood: "shot on 35mm, natural halation, soft grain" or
  "documentary digital, neutral grade". "Cinematic" and "dreamlike" are how takes go surreal.

## 6. Forbidden throughout (paste and keep)

```
Negative prompt: slow motion, speed ramp, floaty weightless movement, rubbery bending limbs, morphing
hands, extra fingers, waxy plastic skin, beauty-filter smoothness, airbrushed face, poreless doll skin, dead glassy eyes,
thousand-yard stare, frozen background extras, dreamlike drift, unmotivated camera float, objects
teleporting or morphing, warped text, gibberish signage, lip-sync mismatch, robotic line delivery,
narrator, extra voices, silent opening, delayed dialogue, speech crammed into the second half, reverb,
echo, music over dialogue.
```

Trim entries that conflict with an intended effect (keep "slow motion" out of it if the shot IS slo-mo);
never trim the hands, skin, sync or extra-voice entries.

## 7. Reroll, don't negotiate

Same economics as the 2D skill: a take is ~17s. A take with rubber physics, drifted accent or dead eyes
is a REROLL of the same prompt, not an edit note. Two identical failures in a row means the prompt is
missing its block — reread sections 1, 3 and 6 and find which one you softened. Prompt expansion stays
disabled; it paraphrases exactly these constraints away first.
