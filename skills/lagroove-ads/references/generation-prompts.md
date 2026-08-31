# Lagroove Image-Generation Prompts

Paste-ready skeletons for Mode-A (and hybrid) templates. Default phrasing targets
**Higgsfield**; they port fine to Midjourney/nano-banana (drop the `--ar`, append
`--ar 4:5` for MJ). Fill the `<brackets>`.

## Best practice: select the Moodboard first

If the **"Lagroove" Higgsfield Moodboard** is set up (from
`assets/moodboard-refs/` — see `higgsfield-workflow.md`), select it and you can
drop most of the style suffix below; the moodboard carries palette/mood. The
suffix is the fallback for when no moodboard is active or for other renderers.

## Global style suffix (append when not using the moodboard)

> …Lagroove brand aesthetic: rich **monochromatic green** palette — deep emerald
> `#2E6B3E`, deep olive-forest `#3D4D1A`, forest `#3A5A34` grounds; soft muted
> sage `#9DB870` and light pistachio `#C8E2A2` for type/fills; warm kraft cream
> `#EFEAD6`. **Greens are rich and clean but NOT neon/electric and NOT muddy/khaki
> — boutique-matcha, not highlighter.** Chartreuse-lime `#C7F04A` only as a rare
> tiny glow accent, never a fill. Retro-disco-meets-modern-pilates mood; clean,
> editorial, lots of negative space. Type leans groovy bubble / handwritten
> script / tight all-caps serif. 4:5 vertical, 1080×1350.

## Text-in-image warning

Image models misspell. For any ad with real words, EITHER (a) generate a
**clean background with empty negative space** and set the type in code/editor on
top (preferred, exact + editable), OR (b) if generating text directly, keep it to
a few short words and tell Leo to proof every character. State in the prompt
*where* to leave space (e.g. "upper third empty for headline").

## House photography (the foundation asset)

> Editorial fitness studio photograph. A <woman / two women> with <hair> in a
> form-fitting <sage green / lime green> activewear <unitard / set>, <posing on a
> black Lagree Megaformer reformer machine / standing holding a silver mirror
> disco ball>, bright airy studio, soft natural light, white seamless backdrop,
> white grip socks, delicate gold jewelry, natural skin texture, candid strong
> posture. Clean green wellness aesthetic. Shot on 50mm, shallow depth. 4:5.

For **green duotone**, add: *"graded as a green duotone — forest-green shadows,
pale-sage highlights, no other colors."*
For a **cutout**, add: *"isolated subject on a plain background for easy
masking, full body in frame with margin."*

## Per-template skeletons

**Duotone headline poster** (hybrid — bg object):
> A single <object: vintage megaphone overflowing with flowers / matcha drink /
> bouquet>, isolated on a solid sage-green `#A9C089` background, graded as a
> green duotone, soft shadow, centered in the lower-right, upper-left third left
> empty for a headline. Editorial, minimal. [+ global suffix]

**Vintage halftone collage** (Mode A — hero):
> Retro 1970s halftone cut-paper collage. A <hand with red nail polish dangling
> a silver mirror-ball by a string / …>, visible halftone print dots and grain,
> flat olive-green `#6E7F3B` background, one bright 4-point sparkle, vintage
> magazine-cutout texture. Nostalgic, groovy. [+ suffix]

**Psychedelic swirl ground** (texture for overlay):
> Seamless 1970s psychedelic liquid-swirl / marbled paper texture in tonal
> greens (sage, moss, olive), groovy retro pattern, flat even lighting, no text.
> 1:1. — *then set arched/circular text + a small sunburst on top in code.*

**Silk-texture disco** (bg):
> Draped glossy emerald-and-sage satin silk fabric, soft folds and sheen, studio
> light, luxurious, no text, space in the center. [+ suffix] — *add hanging
> checkered disco balls + type in editor.*

**Dark disco** (bg/hero):
> Photographic silver disco balls glowing green, on a pure black background, lens
> sparkles and bokeh, dramatic, 70s party energy, negative space upper-right for
> a headline. 4:5.

**Aura gradient** (Mode B — but if generating): 
> Soft radial aura gradient, forest-green center blooming to pale lime and cream
> at the edges, dreamy haze, no text, no objects. 4:5. *(Trivial in CSS —
> prefer Mode B.)*

**Polaroid on texture** (hybrid):
> Background: green embossed crocodile-leather texture, even studio light, no
> text. *(Composite a clipped polaroid photo + script caption on top.)*

**Moodboard grid** (Mode A — tiles):
> A 3×3 mood board of green-aesthetic lifestyle photos: matcha latte, sage
> activewear flat-lay, mint-green vintage car, palm trees, green satin dress,
> avocado, green vinyl record, swirl pattern, disco ball. Cohesive sage/olive
> grade, clean, Pinterest collage. 1:1.

**Form-cue diagram / scrapbook / carousel cover / repeated headline / info-card /
engagement question:** generate the **cutout model** (house photography +
"cutout") and/or the **duotone class photo** as the background asset, then build
the type, cards, arrows, and doodles in code per `references/visual-system.md`.

## Doodles & motifs to add in editor (not gen)

Hand-drawn marker circles, curvy arrows, hearts, 4-point sparkles; the line-art
disco ball; the sunburst/daisy; `LAGROOVE · BOULDER` roundel badge. Keep these
as crisp vector overlays — image models render them mushy.
