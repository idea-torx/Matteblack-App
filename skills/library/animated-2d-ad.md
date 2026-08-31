---
name: Animated 2D Ad Skill
description: Build a 15s 2D hand-drawn animated ad for any brand — fill the slots, paste one prompt. Model MiniMax H3 Max, prompt expansion disabled, ~16.6s per run so reroll freely.
---

# Animated 2D Ad Skill

Single-shot 15-second 2D animated ad. One model call produces picture, voice-over, music and sound design together, so everything is carried in one prompt.

**Model:** MiniMax H3 Max. **Prompt Expansion: disabled** (it will paraphrase the constraints away). ~16.6s per generation — cheap, so reroll rather than negotiate with a bad take.

## How to use it

1. Fill the slot table below from the brief, the brand repo (`house.css`, brand docs, README) or the user's answers. Don't invent a palette if a repo has one.
2. Paste the filled template as one prompt. Nothing else in the call.
3. Generate 10–15 takes. Assemble the best passages; trim ~1s of motion ramp off any inserted clip.

## Slots

| Slot | What it is | Trove example |
|---|---|---|
| `{STYLE}` | Drawing style, 5–8 words | warm storybook, flat cel, pencil and crayon texture |
| `{GROUND}` | Background paper/field colour | cream `#faf8f2` |
| `{INK}` | Line colour, never pure black fills | charcoal `#1a1a1a` |
| `{ACCENTS}` | 4–6 flat accent colours | `#fdd554 #ffc25e #94d2fa #add473 #d4a373` |
| `{RATIONED}` | One colour used exactly once, and where | rose `#d473bc`, one handwritten word |
| `{ENVIRONMENT}` | The recurring setting | rolling green hills under a soft sky ramp |
| `{CHARACTERS}` | What they are made of, how many, how they move, what they must NOT have | four yarn tots, dot eyes, no mouths, hop and squash |
| `{MOTIF}` | **The single continuous element present in every passage.** The spine of the whole film | one unbroken amber thread `#fdd554` |
| `{PHRASES}` | Exactly 4 on-screen phrases, sentence case, in order | "You've done this before." … |
| `{ACCENT}` | Voice-over accent, named twice | Australian, Sydney/Melbourne |
| `{VO}` | 5 lines with explicit second-ranges, last line = brand + payoff | see timings in template |
| `{MUSIC}` | Genre, instruments, and its 3 timing beats | pizzicato, marimba, whistle |
| `{ENDCARD}` | The final still shape and its colour — never a dark button | rounded amber pill |
| `{STORY}` | 5 passages mapping the product story to picture | tangle → walk → choice → record → pill |

## Template

```
Create a 15-second 2D hand-drawn animated advertisement in a {STYLE} style, flat cel animation with visible pencil and crayon texture, gentle paper grain, no 3D, no photographic footage, no live action, no camera lens effects.

The entire voice-over is spoken in {ACCENT}-accented English. This applies to every line without exception.

Pace. This is unhurried and warm, the opposite of a hard-cutting tech ad. Movement is continuous and springy rather than snappy: things bounce, settle, and breathe. Cuts are soft and infrequent, roughly one every three seconds, and each new scene grows out of the {MOTIF} already on screen rather than replacing it. Nothing strobes, nothing flickers, nothing whip-pans.

Art direction. The ground of the film is {GROUND} with a faint drawn texture. {ENVIRONMENT}. Ink is {INK}, always soft-edged, never pure black fills. The accent palette is strictly {ACCENTS}, and {RATIONED}. Colours are flat with occasional crayon shading inside the outline, slightly overshooting the line the way a child's colouring does. Everything drawn has a hand-inked, slightly uneven contour with a faint pencil under-sketch showing through. Round corners, soft shapes, no hard geometry, no rectangles with sharp corners, no grids, no charts, no dashboards, no UI chrome, no phone bezels, no cursors.

Characters. {CHARACTERS}. They never speak and their eyes never become expressive faces.

Forbidden throughout: photorealism, 3D render, CGI shading, glossy plastic surfaces, lens flare, bokeh, depth of field, film grain, glitch, neon, dark mode, near-black backgrounds, sharp-cornered rectangles, charts, graphs, progress bars, dashboards, phone or laptop screens, keyboards, cursors, brains, lightbulbs, gears, human faces, hands, uppercase type.

Signature motif. {MOTIF} is present in every single passage without exception. It is never cut, never duplicated, never recoloured. It only changes role, becoming in turn each of the things the passages below need it to be. Its motion is always a smooth travelling draw-on, drawn by an unseen hand, one continuous stroke.

Typography. Use a warm geometric sans with generous round counters, semibold, tight leading, soft {INK} on {GROUND}, and one word per film set instead in a loose handwritten marker script. Every phrase is set in sentence case — an initial capital on the first word only, every other letter lowercase. Do not render any phrase in uppercase, all caps or small caps. Type is always sharp and still, never blurred, extruded, outlined or shadowed, and it never rotates or bends.

Text handling. Render every phrase as one complete, professionally typeset, precomposed layer that fades up whole over about four frames and holds. Never construct, scramble, morph, glitch or animate individual letters, with one exception named below. The only phrases that appear in the entire film are exactly these four, in this order and in this exact casing: {PHRASES}. No other words, letters, numbers, logos, wordmarks or symbols appear anywhere at any time. Anywhere writing would normally sit — on pages, cards, signs or labels — leave the surface blank or use soft featureless pencil squiggles instead of letters. The single exception is phrase three, where the last word only is drawn in {RATIONED} handwritten marker script by {MOTIF} travelling as a pen, completing in about half a second; the words before it are typeset and already in place.

Passage one, zero to three seconds. Camera slowly pushes in. {STORY 1 — the problem, stated as one object doing one thing.} Phrase one fades up beneath it in soft {INK}.

Passage two, three to six point five seconds. Camera pans gently. {STORY 2 — movement through {ENVIRONMENT}, characters joining.} Phrase two fades up above the horizon.

Passage three, six point five to ten seconds. Camera holds still. {STORY 3 — the choice: three options appear, one is taken, the others dissolve back into the motif.} Phrase three appears on the ground, its final word drawn live in handwritten marker.

Passage four, ten to thirteen seconds. Camera pulls back slowly. {STORY 4 — accumulation: the chosen thing multiplies or is bound into something larger.} Phrase four fades up above it.

Passage five, thirteen to fifteen seconds, then hold. Camera locked, no movement. Everything settles out of frame and {MOTIF} lifts free, travels across the empty ground and draws itself into {ENDCARD}, centred, occupying about half the frame width, filled and holding a soft warm inner glow. It is never black and never dark. Nothing is written on it. All movement stops completely and the final frame is a still, sharp frame with {ENDCARD} centred in it, unchanged through to the very end of the clip.

Transitions. Every transition is carried by {MOTIF}: it draws the next scene on, or reels the previous one in as loose fibre. There are no dissolves, no wipes, no flashes, no cuts to a blank frame. The motif is never absent from screen.

Voice-over, a single {ACCENT} voice, male or female, speaking {ACCENT}-accented English throughout, never American, never British, never a neutral or transatlantic accent, and the accent never drifts or changes between lines, warm, dry and quirky, quietly amused, unhurried, close-mic, no reverb, mixed clearly above the music. Speech begins immediately at the very start of the clip, on the first frame, with no silent opening and no instrumental introduction, and is spread evenly across the entire fifteen seconds, never crammed into the second half and never rushed. The gaps between lines are short and even. Lines: from zero to two point eight seconds, "{VO 1}" From three point two to six seconds, "{VO 2}" From six point four to nine point four seconds, "{VO 3}" From nine point eight to twelve point four seconds, "{VO 4}" From twelve point eight to fourteen point six seconds, "{VO 5 — brand name, then payoff}"

Music, {MUSIC}, mixed low, always under the voice and never competing with it. Dynamics kept gentle throughout. It picks up its bounce as movement starts at three point two seconds, hesitates for a beat at the choice around seven point five seconds, and lands on one soft cheerful resolving chord as {ENDCARD} forms at thirteen point two seconds. No drum kit, no big build, no epic swell.

Sound design, soft and tactile, sitting on the animation rather than on cuts. One characteristic sound per passage, drawn from the materials on screen. A soft felt-tip squeak as the handwritten word is drawn. One warm low chime as {ENDCARD} fills, then quiet room tone under the final hold.

Negative prompt: uppercase, all caps, capital letters, small caps, extra text, gibberish text, warping letters, morphing type, logo, wordmark, brand name, numbers, symbols, human faces, hands, people, mouths, expressive cartoon faces, 3D, CGI, photorealism, plastic sheen, lens flare, bokeh, depth of field, film grain, glitch, strobing, neon, dark background, near-black, black button, sharp-cornered rectangles, phone screen, laptop, keyboard, cursor, UI panels, charts, graphs, progress bars, dashboards, brain, lightbulb, gears, fast cutting, whip pan, camera shake, motion at the end of the clip, American accent, British accent, neutral accent, transatlantic accent, accent drift, multiple voices, silent opening, instrumental intro, delayed voice-over, rushed speech, voice-over crammed into the second half.
```

## Rules that are not slots

These are the parts that took rerolls to find. Change them and the takes get worse.

- **One motif, on screen always.** Every passage transition is the motif changing role. Drop it from one passage and the cuts stop reading as one continuous drawing.
- **Accent is stated twice** — once in paragraph two, once in the voice-over paragraph. Models weight the top of the prompt heavily and ignore an accent named only at the bottom. If a take still comes back wrong, reroll; do not soften either mention.
- **VO timing is stated explicitly** because takes hold the voice back and then cram it late. Keep "starts on the first frame, spread evenly" and keep line one short.
- **Casing is mirrored from the prompt.** Write the phrases in sentence case in the prompt itself and the model follows.
- **Precomposed type, one animated word.** Letters are the first thing to break. If takes come back with scrambled or morphing type anywhere, delete the exception and set phrase three fully typeset too.
- **Four phrases, no wordmark.** The brand name is carried by the last VO line only. On-screen logos come back as gibberish.
- **The end card is a shape, not a button.** Never dark, never black, nothing written on it, no motion in the final second.
- **Story order matters.** Problem → movement → choice → accumulation → mark. If a passage has to go for time, cut passage two, not three — the choice is the product.
- Music always mixed low. A take with the bed over the VO is a reroll, not an edit fix.

## Worked example

`trove-video-prompt` — the Trove 15s ad this was generalized from. Read it for a fully filled version of every slot.
