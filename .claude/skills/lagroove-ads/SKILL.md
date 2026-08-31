---
name: lagroove-ads
description: >-
  Design system and ad-generation kit for Lagroove — "Boulder's grooviest
  fitness studio," a Lagree/Megaformer Pilates studio (lagroove.com, Boulder
  CO). Use this skill whenever Leo wants to create, design, draft, mock up, or
  brief ANY Lagroove static ad, Instagram post/story, social graphic,
  promotional flyer, class announcement, carousel slide, quote card, or any
  on-brand Lagroove visual — even when he doesn't say "ad" or name the brand
  explicitly but the context is clearly Lagroove marketing. Also use it when he
  asks for image-generation prompts (Higgsfield, Midjourney, nano-banana, etc.)
  for Lagroove, when he wants to recreate or riff on an existing Lagroove
  graphic, or when he asks what's on-brand for Lagroove. It outputs either (a)
  ready-to-paste image-gen prompts or (b) directly buildable HTML/SVG for
  typography-driven layouts. When in doubt and the work touches Lagroove or
  Lagree-in-Boulder, use it.
metadata:
  type: reference
---

# Lagroove Ads

This skill turns a request like *"make a Lagroove ad for our new Saturday class"*
into an **on-brand static graphic** — either a paste-ready image-generation
prompt, or buildable HTML/SVG when the layout is typographic. It encodes the
full Lagroove visual system distilled from 32 real brand graphics.

> **Words pair with the `lagroove-voice` skill.** This skill owns the *visual*.
> Whenever the deliverable also needs **copy** — an Instagram caption, the
> on-image headline, a class announcement, a promo line — use **`lagroove-voice`**
> for the wording so it sounds like the brand. For a full post (image + caption),
> run both: build the graphic here, write the caption there.

## The one-paragraph brand

**Lagroove** is *"Boulder's grooviest fitness studio"* — a **Lagree / Megaformer
Pilates** studio at 1657 28th St, Boulder CO (`lagroove.com`). The whole brand
is a pun-rich collision of **70s disco grooviness** and **modern Pilates-studio
wellness**, rendered almost entirely in **greens**. Core message: ***"It's not
Pilates, it's Lagree."*** Tone is warm, playful, body-positive, and a little
cheeky ("Let's Lagree," "bigger booty," "which move humbles you most"). The mood
board is the "clean green girl" aesthetic — matcha, sage activewear, disco
balls, daisies, gold jewelry.

## How to use this skill

1. **Clarify the job** if it's ambiguous: what's the ad *for* (class launch,
   schedule change, promo, motivational/quote post, educational carousel,
   testimonial), and roughly what it should *say*.
2. **Pick a template.** Read `references/templates.md` — it catalogs the ~16
   recurring ad layouts with "use when" guidance. Match the message to a
   template; don't invent a layout from scratch when one fits.
3. **Apply the system.** Pull palette, type, motifs, and textures from
   `references/visual-system.md`. Every ad obeys the same DNA: green-dominant,
   disco-meets-wellness, retro-but-clean.
4. **Look at the real thing.** The chosen template names an exemplar in
   `assets/reference-images/`. **Actually read that image file** before
   generating — it's the ground truth, and matching it beats matching my prose.
5. **Produce output** in the right mode (below).
6. **Pull copy** from `references/brand.md` (taglines, voice, recurring lines,
   facts like address/handle/site) so wording stays in-voice and factually
   correct.

## Two output modes — pick deliberately

**Mode A — Image-generation prompt** (for photographic, textured, collage, or
illustration-heavy templates: anything with models, duotone photos, halftone
collage, silk/swirl textures, neon-on-foliage). These can't be faithfully made
in CSS. Write a detailed, paste-ready prompt for **Higgsfield** (Leo's renderer;
keep it portable to Midjourney/nano-banana). Always specify: aspect ratio (4:5
feed / 9:16 story / 1:1), the exact green palette, type treatment, motif,
texture, mood, and **leave clean negative space for the logo + text overlay**
(state where). See `references/generation-prompts.md` for prompt skeletons.

**Crucial — use the brand assets as real image context, don't text-describe the
brand.** Higgsfield Soul has a **Moodboard** feature that learns the Lagroove
aesthetic from reference images and applies it to every generation; a ready,
face-free reference set is at `assets/moodboard-refs/`. And the **logo must be
composited, not generated** — diffusion mangles the wordmark even with the PNG
attached. Read `references/higgsfield-workflow.md` for the full pipeline
(moodboard for style → generate with negative space → overlay the real logo PNG
for fidelity). This is the heart of how Leo wants to use these assets.

**Mode B — Build it directly in HTML/SVG** (for pure-typography templates:
quote cards, affirmations, motivational type posters, info-card-over-solid,
memo cards, circular/arched text, "repeated headline"). These are deterministic
layout + the brand fonts, so build them as code and render — no image model
needed, and the text is always spelled right and editable. Use the font stack
and tokens in `references/visual-system.md`. If a preview tool is available,
render it so Leo sees the result; otherwise hand him the file.

Many ads are **hybrid**: a Mode-A photographic/textured background with a
Mode-B text layer composited on top. That's the highest-fidelity path for
template families like info-card-over-photo, duotone headline poster, and
carousel covers — generate the background, set the type in code/editor.

## Non-negotiable brand rules (the stuff that makes it read as Lagroove)

- **Green is the brand — rich, clean, and slightly sophisticated.** Deep emerald,
  deep olive-forest, and forest **grounds**; soft muted sage + pistachio for
  type; warm kraft cream. Aim for **matcha/sage richness — NOT neon/highlighter
  bright, NOT muddy/khaki/grayed.** Chartreuse-lime is a rare glow accent only,
  never a fill. Never introduce off-brand hues (blue, red, etc.) except tiny
  realistic accents inside photos (a disco ball's silver, red nail polish).
- **Disco ball is the hero motif** — recurring as line-art, photographic prop,
  checkered illustration, or vintage halftone. When an ad needs an "icon," reach
  for the disco ball first, then the sunburst/daisy.
- **Retro-groovy, but clean.** 70s warmth (swash serifs, wavy bubble type,
  daisies, halftone) balanced against lots of negative space and crisp modern
  layout. It should feel like a boutique wellness studio that loves disco — not
  a cluttered flyer.
- **Wordmark + signoff.** The "Lagroove" groovy-serif wordmark and/or
  `www.LAGROOVE.com` typically anchor a corner or the footer — use the real PNG
  from `assets/logos/`, never a retyped approximation. Real CTAs: "BOOK NOW AT
  www.LAGROOVE.com", "MORE INFO >", "Swipe →".
- **Copy is warm and punny**, never corporate. Lean on the Lagree-not-Pilates
  framing and body-positive affirmations.

## Reference files

- `references/visual-system.md` — palette hex tokens, full type stack with free
  Google-Font substitutes, motifs, textures, layout grammar. **Read for any ad.**
- `references/templates.md` — the ~16 ad templates: what each looks like, when
  to use it, which exemplar image to study, and Mode A vs B.
- `references/generation-prompts.md` — paste-ready image-gen prompt skeletons
  per template, plus the house photography art-direction brief.
- `references/higgsfield-workflow.md` — **how to use the brand assets as real
  image context in Higgsfield**: Moodboard for style, Soul Reference per-image,
  and compositing the logo for fidelity. Read this for any Higgsfield job.
- `references/brand.md` — facts, voice, taglines, copy bank, do/don't.
- `assets/reference-images/` — 25 curated exemplars, named by template. Always
  open the relevant one before generating.
- `assets/logos/` — the **official brand kit**: real Lagroove wordmark, the
  sunburst-daisy flower logo, full lockups, and the "TUNE IN · TONE UP" stamp,
  in 6 green/neutral colorways. **Composite these PNGs into ads — never retype
  or redraw the wordmark/logo.** See `visual-system.md` for which lockup/colorway.

The full original 32-image set lives at `~/La-groove-context/r2-images/` and the
complete logo kit at `~/La-groove-context/brand-assets/` (both pulled from the
`lagroove-graphics` R2 bucket via rclone remote `r2:`).
