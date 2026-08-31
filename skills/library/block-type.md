---
name: Block Type
description: 5s kinetic typography spot — huge flat block words transforming in 3D, morphing word into word, hard graphic wipes between eight rapid scenes, with one photoreal subject as the only three-dimensional thing in frame. Swiss-modernist, three colours. Model MiniMax H3 Max, text-to-video, prompt expansion disabled.
---

# Block Type

Sibling to `animated-2d-ad`. There the drawing carried it and the type stayed quiet. Here **the type is the performance** — huge words thrown through three-dimensional space and morphing into each other on the beat — while one photoreal subject anchors the frame.

**Model:** MiniMax H3 Max (`h3-max`), text-to-video. **Prompt expansion: disabled.** 16:9, 5s, 720p. Cheap and fast — generate several and keep the clean ones.

Text-to-video is the whole point: H3 Max composes new scenes freely, which is what makes eight distinct compositions in five seconds possible. Do not reach for image-to-video unless you need a **specific real person's likeness** — see the last section for that route and what it costs you.

## The two planes

The style is one sustained contrast. Break it in either direction and the look collapses: illustrate the subject and it reads as a cartoon; texture or extrude the type and it reads as a 2008 title sequence.

| | Type plane | Subject plane |
|---|---|---|
| Render | Absolutely flat colour — no texture, gradient, outline, bevel, extrusion, glow | Fully photoreal — studio light, specular highlights, real depth |
| Space | A flat sheet *transformed* in 3D, like coloured paper rotating | Genuinely three-dimensional — the only such thing in the film |
| Motion | Violent: rotate, tilt, spin, stretch, crush, fly past camera, morph | Physical and weighted |
| Scale | Cap height taller than the frame; letters crop off top and bottom | As large as the letters it covers; occludes them |

## Slots

| Slot | What it is | Gyoza | Sneaker |
|---|---|---|---|
| `{WORDS}` | 5 words, 3–6 letters each, uppercase, in order | HOT! SPICY GYOZA CRISP MORE | FAST LIGHT GRIP AIR GO |
| `{GROUND}` `{TYPECOLOR}` `{THIRD}` | Exactly three pure flat colours | red `#d81f1f` · black `#000000` · white `#ffffff` | same |
| `{SUBJECT}` | The photoreal hero, described materially | pan-fried gyoza | a running shoe |
| `{VARIETY}` | **The states/variants matrix** — see below | 4 flavours × 5 states | 3 colourways × 4 states |
| `{SLOWMO}` | The one macro breath at ~2s | chili oil crawling down a pleat | a lace whipping in slow motion |
| `{MUSIC}` | Genre and the instrument on the beat | percussive electronic, woodblock and clap | same |

### The variety matrix

The single biggest quality jump. A subject repeated identically eight times looks like a stock loop; the same subject in eight *states* looks like a campaign. Write two axes and cross them:

- **Food** — flavours (different wrapper colours, sears, fillings) × states (whole / sliced in cross-section showing the filling / gripped in chopsticks / plunging into sauce / lifting out with sauce trailing).
- **An object** — variants (colourways, materials, finishes) × states (whole hero / exploded into parts / mid-air spinning / extreme macro of one detail / cross-section).
- **A person** — poses (arms crossed heroic / mid-gesture / enormous shrug / leaping) × framings (heroic low angle / extreme macro of one feature / tiny in an empty field).

Put two or three variants in one frame in at least one scene so the range actually reads in five seconds.

## Template

Fill the slots and paste as one prompt. Nothing else in the call.

```
Create a 5-second Swiss-modernist kinetic typography advertisement for {SUBJECT}, 16:9. Rigorous graphic design in violent motion: eight rapid scenes, aggressive 3D type transformation, word-into-word morphing, and a different hard graphic wipe between every scene. Everything hits on the beat. International Style poster design brought to life.

COLOUR — STRICT. Only three pure colours in the graphics: {GROUND}, {TYPECOLOR}, {THIRD}. Flat, clean, fully saturated, no gradients, no tints, no texture. Each scene uses a different pairing, flipping hard on every wipe. The only other colour anywhere is the natural colour of the real {SUBJECT}.

THE SUBJECT — MANY VARIANTS, MANY STATES. {VARIETY}. Every one is extremely high definition, fully three-dimensional and completely photoreal, with real studio lighting, real specular highlights and real depth. Several scenes show two or three variants together in one frame so the range reads. They overlap and occlude the letters, are as large as the letters they cover, and cast clean hard contact shadows.

MODERNIST DESIGN LANGUAGE. Every composition is built on a strict invisible grid and is deliberately asymmetric, never centred by default. Type locks flush to the grid: hard left alignment, flush edges, type bleeding off the frame edges, huge blocks of empty flat colour held against type crammed tight into one corner. Extreme scale contrast between scenes — one scene a single letter filling the entire frame, the next a tight word in a vast empty field. Words sometimes rotate ninety degrees and run vertically up the side. Pure geometric elements share the frame: hard rule lines, thick solid bars, one perfect circle, a hard diagonal split — all flat, all in the three colours, all snapping into place on the beat.

TYPE — 3D TRANSFORMATION AND MORPHING. Words are enormous, in one extremely heavy condensed grotesk sans, very tight letterspacing, flat single-colour fill. They are flat sheets of colour violently transformed in three-dimensional space: rotating on the vertical axis like a swinging door, tilting back and forward on the horizontal, spinning on Z, flying past camera in extreme perspective foreshortening where the nearest letter is gigantic and the furthest shrinks to a point. Words stretch enormously wide on one axis while crushing narrow on the other, then snap back. And words morph directly into one another, letterforms elongating, bending and flowing as one word becomes the next, elastic and alive, each morph fast and violent at about a fifth of a second.

IMPORTANT: the type stays FLAT COLOUR throughout — a flat sheet moving in 3D, like coloured paper rotating in space. Never extruded lettering, never beveled, never chrome, never metallic, never shiny, never lit, never with thickness or side faces. No drop shadow, no glow, no outline, no gradient on the type. The {SUBJECT} is the only three-dimensional thing in the film.

RESOLVING. However extreme the transformation or morph, each word passes through a moment square to camera where it is sharp, crisp, perfectly typeset, correctly spelled and completely legible, locked to the grid, holding on a beat. Distortion lives only in the transitions.

THE WORDS. The only words in the entire film are these five, in this exact order and spelling, one at a time, never two on screen together: {WORDS}. No other words, letters, numbers, logos, wordmarks, captions or symbols appear anywhere.

WIPES. Every scene change is a hard graphic wipe, never a dissolve or fade, always two or three frames, always exactly on a beat, always a different one: a solid bar of colour sweeping edge to edge, a word sliding out and dragging the next scene in behind it, a single letter scaling up until its counter becomes the next frame, the frame splitting into horizontal bands sliding opposite ways, a hard diagonal edge sweeping through, a circle expanding from a point, the subject crossing frame and leaving a new colour in its wake.

STRUCTURE — EIGHT SCENES. Zero to zero point five: {GROUND} field, word one rotating in edge-on and snapping flat, locked hard to the bottom left, vast empty field above, one variant of the subject in the corner. Wipe. Zero point five to one point zero: second colour pairing, word two stretched enormously wide, two different variants occluding the middle. Wipe. One point zero to one point four: third pairing, word three rotated ninety degrees running vertically up the right edge, a thin rule line beside it. Wipe. One point four to one point eight: a single variant nested perfectly inside the round counter of a giant letter O filling the frame. Wipe. One point eight to two point seven: the breath — one heavy slow-motion photoreal macro of {SLOWMO}, no type on screen. Wipe. Two point seven to three point three: word four flying past camera in extreme perspective, near letter gigantic, a hard diagonal bar cutting the frame, a variant shown in cross-section or extreme detail. Wipe. Three point three to four point two: all variants arranged in a tight radial burst around a central point, type tilting up from below. Wipe. Four point two to five: word five morphs in and slams square to camera, flush left, filling the frame, and everything freezes.

ENDING. The final half second is completely frozen — all motion, all type and all music stopping dead on the same frame. The final word is sharp, square to camera, locked to the grid, fully legible and correctly spelled.

MUSIC AND SOUND. {MUSIC}, punchy, driving, alive. Every wipe, every word landing and every transformation exactly on a beat. The music drops to one sustained low tone under the slow-motion shot, then slams back harder, and stops dead on the final frozen frame. Underneath, dry close-mic sound design from the subject itself, and a sharp whoosh on each wipe. No voice-over, no narration, no singing.

Negative prompt: sentence, paragraph, caption, subtitle, two words on screen at once, extra text, gibberish text in the held state, misspelled word, unreadable final word, word that never resolves, extruded 3D text, beveled text, chrome text, metallic text, shiny text, text with thickness, lit text, outlined text, drop shadow on text, glowing text, textured text, gradient text, small text, text that fits inside the frame, logo, wordmark, numbers, symbols, dissolve, crossfade, fade to black, soft transition, centred symmetrical composition, cluttered layout, decorative flourishes, ornament, script font, serif font, rounded font, identical repeated subjects, one variant only, flat 2D subject, illustrated subject, cartoon, drawing, collage, halftone, paper texture, film grain, CGI, plastic, lens flare, bokeh, depth of field, camera shake, room, table, background scene, gradient background, fourth colour in the graphics, pastel, neon, glitch, strobing, slow drifting motion, sluggish pacing, single static composition, voice-over, narration, singing, motion in the final frame.
```

## Rules that are not slots

These cost rerolls to find. Changing them makes takes worse.

- **Flat sheet in 3D, not 3D type.** The single most important line. "A flat sheet moving in 3D, like coloured paper rotating in space" plus the explicit ban on extruded / beveled / chrome / shiny / thickness. Without it you get shiny 3D lettering and the graphic cleanliness dies.
- **Name one thing as the only 3D object.** "The {SUBJECT} is the only three-dimensional thing in the film" gives the model somewhere to put the dimensionality so it stops leaking into the type.
- **Words resolve.** However violent the morph, each word passes square to camera, sharp and correctly spelled, holding on a beat. Distortion lives only in the transitions. Without this a take never lands on a readable word.
- **Short words, 3–6 letters, one at a time.** Not taste — more letters at speed means more to get wrong. Two words on screen at once is the most common way a take invents a third, garbled one.
- **Cap height taller than the frame.** The crop at top and bottom is what makes type read *huge* rather than merely large. Omit it and you get a polite word with margins.
- **Write all eight scenes out with times.** "Many scenes" gets you one composition with things moving in it. Each scene needs its own colour pairing, word, and subject state.
- **Shot size changes by hard cut, never a camera move.** Keeps the graphic flatness; allow a zoom and the model invents perspective and a table.
- **Fast / slow / fast.** The slow-motion macro at ~2s is what makes the fast passes feel fast. Cut it and the whole thing reads at one flat speed.
- **Exactly three colours, counted and named**, with the pairing flipping on each wipe. "A limited palette" gets you five and a gradient. Put the specific unwanted colours in the negative prompt — rust and orange crept in for several takes.
- **Wipes listed individually.** Give the menu, not "use wipes". `dissolve`, `crossfade` and `fade to black` go in the negative prompt.
- **Everything stops dead together.** Music and picture freeze on the same frame.
- **Expect spelling rerolls.** At this speed some takes garble a word and no prompt fully fixes it. That is the cost of the motion.
- **The subject slot is genuinely free.** Proven by porting the identical eight-scene spine from food to a person with no other changes. Food, objects, people all work.

## Worked example — gyoza

`{WORDS}` HOT! SPICY GYOZA CRISP MORE · `{SUBJECT}` pan-fried gyoza dumplings · `{VARIETY}` four flavours — classic pork with a blistered golden-brown seared base and pale pleated wrapper; spicy chili with a deep red-orange wrapper glossy with chili oil; vegetable with a pale green translucent wrapper showing the filling; black sesame with a matte charcoal wrapper — in states: whole and steaming; sliced cleanly in half in cross-section with the packed filling and steam visible; held mid-air in black chopsticks; plunging into a dark bowl of dipping sauce; lifting out with sauce running off in thick strands · `{SLOWMO}` chili oil crawling down the pleats of one dumpling · `{MUSIC}` tight percussive electronic, woodblock and clap

Derived from a three-frame dumpling campaign. Note those source frames carry a small logo top-left; this model returns on-screen logos as gibberish, so composite it in post.

## Worked example — a product

The same spine with an object instead of food, to show the subject slot carries.

`{WORDS}` FAST LIGHT GRIP AIR GO · `{SUBJECT}` a running shoe · `{VARIETY}` three colourways — one all-white, one with a red sole, one matte black — in states: whole hero on the ground; mid-air spinning slowly; sole-on to camera showing the tread; exploded into upper, midsole and outsole hanging apart; extreme macro of the knit weave · `{SLOWMO}` a lace whipping in slow motion · `{MUSIC}` tight percussive electronic, woodblock and clap

Scene beats worth stealing for any subject: one variant nested inside the round counter of a giant letter O; a tall narrow variant stretched to match a vertically-running word; all variants in a radial burst with one lifted clear of the group.

## When the subject is a person

The spine works unchanged — swap the flavour/state matrix for a pose/framing one. Two additions:

- Add to the negative prompt: `cartoon, illustrated character, video game character, animated character, CGI human, waxy skin, plastic skin, uncanny face, distorted face, extra limbs, extra fingers`.
- **Describe the look rather than naming a character or celebrity the model might recognise**, or it reaches for that likeness instead of building a person from the description.

For a **specific real person**, H3 Max cannot help — it is text-to-video only and takes no reference photo. That route:

1. **Build a hero still** with `nano-banana-2`, their photo as the reference: one word, huge, cap height taller than the frame, flat colour on the flat ground, them cut out cleanly in front with a hard contact shadow, one thin rule line. Stills hold spelling far better than video, so a long name is safe here.
2. **Animate it** with `seedance-2.0` or `kling-o3-pro`, `videoReferenceMode: first_frame`.

What it costs: a first-frame animation inherits its composition from that one still, so expect three wipes and one or two words rather than eight scenes and five words. **You can have the real likeness or the full kinetic structure in one generation, not both.** For both, generate several stills in different scenes from the matrix, animate each to 1–2s, and cut with `set_timeline`.

Two traps, both found the hard way:

- **Seedance can silently drop the reference.** Its moderation rejects some real faces at the video stage and the bridge falls back to text-to-video without erroring — you get a "successful" clip of a stranger. **Always check the model suffix on the result line: `-i2v` means the reference took, `-t2v` means it did not.**
- **Kling is the fallback and it worked where Seedance refused** — same still, same words. But its prompt cap is **2500 characters**, so the template above must be cut to a short form: keep poses, angles, the word list, the flat-in-3D rule, the wipe menu, the freeze, and a trimmed negative prompt.
