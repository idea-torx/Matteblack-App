---
name: character-led-2d-ad
description: 15s 9:16 animated ad where two on-screen puppet/animated characters carry the whole script as dialogue — no narrator, no voice-over. Nine scenes cutting on the beat, a single accent-colour ripple transforming each scene into the next, one undistorting product tile, and a still end-card quote. Use when the ad should feel like someone showing you something rather than being told about it.
---

# Character-led animated ad (15s · 9:16)

Sibling of `animated-2d-ad`. Same nine-scene skeleton, same ripple grammar — but the
narrator is deleted and two characters in the room speak every word. Derived from the
NearField felt grandpa/grandson cut (2026-08-29), which is the reference.

## Locked settings

| | |
|---|---|
| tool | `generate_media` |
| kind | `video` |
| model | `h3-max` (MiniMax H3 Max — text-to-video only) |
| aspectRatio | `9:16` |
| durationSeconds | `15` |
| videoResolution | `768p` |

One call produces picture + all dialogue + music + sound design together. Everything
must be carried in the prompt. ~17s per run, cheap enough to reroll rather than fight.

## Why it works

H3 Max weights the **top** of the prompt heavily. The two rules most likely to break —
"no narrator" and "who is allowed to speak" — go in all-caps blocks in the first two
paragraphs, and get restated in the negatives. If you bury them, you get a disembodied
announcer talking over your characters.

## The prompt (slots in `{{ }}`)

```
THERE IS NO NARRATOR. No voice-over of any kind. Every word in this film is spoken on
screen by one of two {{MEDIUM_NOUN, e.g. puppet}} characters, in the room, to each other
and to camera. Do not add a narrator. Do not add a third speaker.

THE VOICES. {{CHARACTER_A_NAME}}: {{age, gender, accent, temperament — the one who
speaks most, and slowly}}. {{CHARACTER_B_NAME}}: {{who says almost nothing, only short
delighted reactions}}. Two voices total, nothing else.

{{STYLE BLOCK — the physical medium in obsessive material detail: what it is made of,
how it is lit, how it moves. 3–5 sentences.}}

STORY: {{one line — who is showing what to whom, and where}}.
Scene 1: {{establish — the space, asleep/ordinary}}.
Scene 2: {{A points at the product tile}} — the tile is the only object in the film with
clean crisp edges, it never distorts.
Scene 3: {{B taps the phone to the tile, a {{ACCENT}} concentric ripple bursts out}}.
Scene 4: {{first transformation washes across the space}}.
Scene 5: {{escalation — something flies/rises}}.
Scene 6: {{the big one — the largest, most impossible thing}}.
Scene 7: {{a second ripple sweeps through and swaps the scene into something completely
different — this is how "it changes every day" is shown, not said}}.
Scene 8: {{the two characters together in the {{ACCENT}} glow}}.
Scene 9: END CARD — a still, locked-off, flat {{ACCENT}} field, all motion stopped,
never dark, holding one line of clean sentence-case typeset text: "{{END QUOTE}}" with a
small "{{BRAND}}" beneath it. That is the ONLY typography in the entire film.

A {{ACCENT}} concentric ripple is visibly present in every single scene and is what
physically transforms one scene into the next. One rationed accent colour,
{{RATIONED_HEX}}, used exactly once: {{a single object, not a word}} — the only thing
that colour anywhere in the film.

THE DIALOGUE IS SPARSE. Six short lines, about thirty words total. The picture is fast;
the talking is slow and warm. Nobody talks over anybody.
0.0–2.8s   A: "{{invitation}}"
3.0–5.5s   A: "{{the instruction — names the product action}}"
5.8–6.6s   B: "{{one-word reaction}}"
7.0–10.5s  A: "{{the payoff + the objection-killers, said plainly}}"
11.0–12.0s B: "{{ask for more}}"
12.3–14.5s A: "{{the repeatability line}}"
That is the complete script. Nothing further is said. Nobody reads the end card aloud.

Music mixed low under the dialogue: {{score}}. Sound design: {{3–4 diegetic textures}}.

Negative: narrator, voice-over, disembodied narrator, third speaker, adult reading the
end card aloud, subtitles, captions, gibberish text, extra text on screen, signage,
watermarks{{, + medium-specific inversions}}.
```

## Rules that took rerolls to find

1. **Say "THERE IS NO NARRATOR" first, then again in the negatives.** Once is not enough.
2. **Two speakers, and say "two voices total."** Otherwise a third voice arrives to explain.
3. **Give the child almost no lines.** A kid narrating infantilises the whole ad. Reactions
   only — the adult carries the words. This was a direct note from Leo on an early cut.
4. **Timecode every line.** Near-contiguous ranges with small gaps, ending by ~14.5s.
   Without timings H3 Max rushes the read and crams in extra dialogue.
5. **State the word count.** "Six short lines, about thirty words total" holds the pace.
6. **"Nobody reads the end card aloud."** It will otherwise.
7. **One piece of typography, on the end card only.** With no VO the brand has nowhere
   else to land — but more than one text element and the model starts inventing signage.
8. **Ration the accent colour to an object, never a word.** A drawn word is typography and
   fights rule 7.
9. **Put the propositions in the character's mouth.** "No app, nothing to reprint" and
   "tomorrow it's a different one" read as warmth when a grandfather says them and as
   marketing when a narrator does.
10. **Negate the neighbouring mediums.** Felt needs `CGI smoothness, plastic, clay, 3D
    render`. Anime needs `sound-effect lettering, kanji, speech bubbles`.

## Reference cut — NearField, felt grandpa and grandson

Verbatim prompt as sent, for reproduction:

```
THERE IS NO NARRATOR. No voice-over of any kind. Every word in this film is spoken on screen by one of two puppet characters, in the room, to each other and to camera. Do not add a narrator. Do not add a third speaker.

THE VOICES. GRANDPA: an elderly MALE British character, warm, gentle, unhurried, a little twinkly — he speaks most of the words and he speaks slowly. THE BOY: a small grandson who says almost nothing, only short delighted reactions. Two voices total, nothing else.

Stop-motion felt-and-yarn puppet animation, Jim Henson workshop craft: hand-sewn characters with visible stitching, felt seams, pipe-cleaner arms, googly wobbling eyes, fuzzy pilled fabric texture, fingerprints in the felt, everything lit like a real physical miniature set with soft practical lamps and real shallow depth of field. Museum built from cardboard, wool, cotton-wool clouds, felt leaves, pom-pom stones. Slight handmade jitter frame to frame, puppets bobbing as they speak, mouths flapping.

STORY: a felt grandpa gives his small grandson a tour of a sleepy museum, holding a phone.
Scene 1: dusty felt museum hall, grandpa crouches to the boy, holds up the phone. Scene 2: he points a stitched finger at a small marigold #FFA32D square tile on the wall — the tile is the only object in the film with clean crisp edges, it never distorts, never gets fuzzy. Scene 3: the boy taps the phone to the tile, a marigold concentric ripple bursts out of it. Scene 4: the ripple washes across the hall and felt vines, wool ferns and pom-pom flowers erupt over the walls. Scene 5: yarn birds burst out of the ceiling and loop over their heads, grandpa laughing. Scene 6: a huge friendly felt dinosaur skeleton stands up and shakes itself, googly eyes rolling. Scene 7: the boy spins with his arms out, another marigold ripple sweeps the room and swaps the whole exhibit into something completely different — a felt ocean with wool waves — showing it changes every day. Scene 8: grandpa and boy stand together in the marigold glow, the boy tugging his sleeve. Scene 9: END CARD — a still, locked-off, flat marigold #FFA32D field, all motion stopped, never dark, holding one line of clean sentence-case typeset text: "Tap to magic." with a small "NearField" beneath it. That is the ONLY typography in the entire film.

A marigold #FFA32D concentric ripple is visibly present in every single scene and is what physically transforms one scene into the next. One rationed accent colour, hot magenta #FF3D9A, used exactly once: a single magenta pom-pom flower that pops open in the boy's hand — the only thing that colour anywhere in the film.

THE DIALOGUE IS SPARSE. Six short lines, about thirty words total. The picture is fast; the talking is slow and warm. Nobody talks over anybody.
0.0–2.8s GRANDPA: "Come here. Let me show you something."
3.0–5.5s GRANDPA: "See that little square? Give it a tap."
5.8–6.6s BOY: "Whoa!"
7.0–10.5s GRANDPA: "Every wall in here has a story in it now. No app. Nothing to reprint."
11.0–12.0s BOY: "Can we do it again?"
12.3–14.5s GRANDPA: "Tomorrow it's a different one."
That is the complete script. Nothing further is said. Nobody reads the end card aloud.

Music mixed low under the dialogue: a small playful acoustic sesame-street shuffle, ukulele, upright bass, brushed snare, one warm resolving chord on the end card. Sound design: felt scuffs, a soft tap chime, fabric rustle, wooden clatter.

Negative: narrator, voice-over, disembodied narrator, third speaker, female voice, adult reading the end card aloud, subtitles, captions, gibberish text, extra text on screen, signage, watermarks, CGI smoothness, plastic, clay, 3D render.
```

Output: `/uploads/generations/video/eb09823d-a210-41c1-8aaa-786cb3716f5c/1788070168811-muutofjw.mp4`

## Swapping the medium

The skeleton is medium-agnostic — only the style block, the score, and the last clause of
the negatives change. Proven on: riso, claymation, felt/muppet, hair, anime noir,
shonen/One Piece, Ghibli watercolour. Change one variable per run so cuts stay comparable.
