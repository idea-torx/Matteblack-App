# Higgsfield Workflow — using the brand assets as real image context

The goal: get Higgsfield generations that are **on-brand in style** AND carry an
**accurate logo**. Higgsfield (Soul 2.0) gives us two reference mechanisms; the
logo needs a third (compositing). Use all three deliberately.

## 1. Moodboard = brand STYLE (do this once, reuse forever)

Soul 2.0 **Moodboards** learn an aesthetic from uploaded references and apply it
to every subsequent generation, so you stop re-describing "green retro-disco
pilates" in text each time. Up to 80 images; **10–30 is the sweet spot**.

**Use the ready-made set in `assets/moodboard-refs/`** (17 curated, face-free
images: textures, typography, motifs, the swirl/silk/paper grounds, disco balls,
the moodboard grid, plus the wordmark + flower for color/shape cues).

Higgsfield's moodboard rules, and why this set respects them:
- **No faces in the batch** — Soul moodboards get confused by faces. That's why
  this set excludes every model/portrait exemplar (they live in
  `reference-images/` for human study, not for the moodboard).
- **Visually coherent, high quality** — all share the green palette and
  retro-disco-wellness mood, so Soul extracts a clean, consistent style.

Setup: create a Moodboard named "Lagroove", upload the whole `moodboard-refs/`
folder, save. Then select it on every Lagroove generation. Optionally make two
variants — "Lagroove · Light" (cream/sage grounds) and "Lagroove · Dark"
(black/forest) — by splitting the set, if you want tighter control per post.

## 2. Soul Reference = per-image composition / a specific element

For a single generation you can attach a reference image (Soul Reference) to
guide composition or bring in a specific element — combinable with the moodboard.
Use it when one ad needs a particular thing the moodboard won't reliably give:
e.g. attach `logos/E Logo/...` (the **flower mark**) to place the sunburst on a
wall/tote, or attach a specific disco-ball or texture reference for a hero shot.

## 3. The logo — composite for fidelity (the important rule)

**Diffusion will not reproduce the "Lagroove" wordmark accurately**, even with the
PNG attached — the swash serif letterforms get mangled. So:

- **Default (crisp logo): generate clean, composite after.** Prompt Higgsfield
  for the background/scene with **empty negative space where the logo goes**
  (say exactly where), generate, then **overlay the real PNG** from
  `assets/logos/` in an editor — or, for typographic ads, build the whole thing
  in HTML/SVG (Mode B) with the PNG placed. This is pixel-perfect every time.
- **Acceptable in-scene mark:** if you want the logo physically in the world
  (printed on a tote, etched on a mirror, on studio signage) and small
  imperfection is fine, attach the **flower mark** (not the wordmark — the
  radial shape survives generation far better) via Soul Reference.
- **Never** rely on Higgsfield to render `www.LAGROOVE.com` or any small text —
  set all fine text in the editor/code layer.

Pick the logo **colorway** from `assets/logos/` for contrast: White / Light Green
on dark grounds; Primary / Dark Green on cream/sage. Pick the **lockup** by need:
plain wordmark (`A`) for a footer, the `H` stamp for a playful seal, the `D`
city lockup for a formal header.

## Putting it together (recommended pipeline)

1. One-time: build the "Lagroove" Moodboard from `assets/moodboard-refs/`.
2. Per ad: pick a template (`templates.md`), write the Higgsfield prompt
   (`generation-prompts.md`) with the moodboard selected and **negative space
   reserved for the logo/text**.
3. Generate the background/scene in Higgsfield.
4. Composite the real logo PNG + any fine text on top (editor or Mode-B code).

This gets you the model doing what it's good at (on-brand imagery, texture,
mood) and keeps the logo doing what diffusion is bad at (crisp letterforms) out
of its hands.
