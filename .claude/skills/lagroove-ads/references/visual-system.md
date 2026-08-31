# Lagroove Visual System

Everything here is distilled from the 32-graphic reference set. Hex values are
eyedropper approximations — close enough to design with, nudge to taste.

## Palette

Lagroove is a **monochromatic-green** brand with a cream neutral and one zingy
lime accent. An ad almost always lives in ONE of these grounds, with the others
as type/graphic colors.

**The greens are RICH, CLEAN, and slightly sophisticated — a Goldilocks zone
between two failure modes:**
- ❌ **too muddy** — grayed mid-khaki (`#6E7F3B`), drab and dull.
- ❌ **too neon** — electric kelly/lime-bright (`#2F8A4E`, `#9CC15F` as fills),
  looks like a sports drink, not a boutique studio.
- ✅ **just right** — deep forest, deep olive, deep emerald **grounds**; soft
  muted **sage** and forest as **type**; warm kraft cream. Saturated but never
  fluorescent. Think matcha + sage activewear, not highlighter.

| Token | Hex (approx) | Role |
|---|---|---|
| `--cream` | `#EFEAD6` | Warm kraft/cream — **the most common ground.** |
| `--sage` | `#9DB870` | Soft **muted** sage-green — the primary TYPE green (bubble & script), the "Showing"/"MOTIVATION" green. Muted, NOT neon-bright. |
| `--forest` | `#3A5A34` | Rich forest green — type on cream, and a mid-deep ground. |
| `--deep-olive` | `#3D4D1A` | Deep olive-forest — sophisticated DARK ground (the "be your own MOTIVATION" post). Rich, not muddy. |
| `--emerald` | `#2E6B3E` | Deep rich emerald ground (disco-draw poster) — saturated but **not** electric kelly green. |
| `--moss` | `#6E8348` | Mid green for secondary fills, swirl patterns. |
| `--pistachio` | `#C8E2A2` | Light pistachio — disco balls, light fills/type on dark grounds. |
| `--lime` | `#C7F04A` | Chartreuse-lime NEON — a **rare accent ONLY** (a single glowing script line, a highlight). **Never a fill or ground.** |
| `--ink` | `#1A2110` | Near-black for occasional high-contrast type / dark grounds. |

**Ground choices, in order of frequency:** cream/kraft, **deep-olive**, **forest**,
**emerald**, black (rare, "disco/night" energy like NYE). Type is usually soft
sage or forest; cream/pistachio type on the dark grounds.

**The calibration test:** if a green looks like it could be a *highlighter or
sports drink*, it's too neon — deepen and slightly mute it. If it looks *gray or
khaki*, it's too muddy — clean it up and saturate. Aim for matcha/sage richness.

**Duotone treatment:** photos are routinely tinted to a **green duotone**
(shadows → forest, highlights → pistachio/cream) so photography sits inside the
palette. Keep the midtones a clean vibrant green, not khaki. This is a defining
move — see the megaphone and carousel-cover exemplars.

## Typography

Lagroove mixes **6 type voices**. Most ads use 2–3 together (e.g. condensed-sans
headline + marker-script accent + clean-sans body). Below: what each is, where
it shows up, and a **free Google Fonts substitute** so Mode-B (HTML/SVG) ads are
buildable without licensing the originals.

| Voice | Look | Used for | Free substitute |
|---|---|---|---|
| **Wordmark serif** | Custom groovy swash serif, the "Lagroove" logo — high-contrast, looped, 70s | The logo only | **Use the real PNG from `assets/logos/` — do NOT retype the wordmark.** `Yeseva One`/`Abril Fatface` only as a last-resort approximation |
| **Display serif** | Condensed high-contrast didone, elegant | Big headlines ("NEW CLASS TIMES", "Form Focus", "WINNERS ARE IN") | `DM Serif Display`, `Playfair Display` |
| **Condensed sans** | Monumental bold grotesque, tight | Loud headlines ("LET'S LAGREE", "WHICH MOVE GETS YOU", "ANNOUNCEMENT") | `Anton`, `Archivo Black` |
| **Groovy bubble** | Wavy y2k bubble script, super retro | Affirmations, playful words ("Showing", "be your own") | `Bagel Fat One` (near-exact), `Fredoka` |
| **Signature script** | Flowing formal handwriting | Decorative subheads ("The Disco Ball Draw", "Starting September 1st") | `Pinyon Script`, `Sacramento`, `Dancing Script` |
| **Marker script** | Casual hand-marker | Doodle labels, memo-card body ("Never compare your progress") | `Caveat`, `Permanent Marker` |
| **Clean serif** | Quiet refined serif | Understated quote cards ("Good things are coming", "Do it for your future self") | `EB Garamond`, `Cormorant Garamond` |
| **Clean sans (body)** | Neutral grotesque, ALL-CAPS often | Times, addresses, body copy, CTAs | `Inter`, `Archivo`, `Helvetica Neue` |

**Type bias (Leo's preference) — reach for these THREE voices first:**
1. **Groovy bubble** (`Bagel Fat One`) — wavy y2k bubble script. The default for
   affirmations, slogans, playful hero words. This is the most "Lagroove" voice.
2. **Handwritten / signature script** (`Pinyon Script`, `Sacramento`) — flowing
   script for decorative subheads and signoffs ("The Disco Ball Draw").
3. **All-caps tight-kerned serif** — high-contrast display serif (`DM Serif
   Display`, `Playfair Display`) set ALL-CAPS with **tight, almost-touching
   letter-spacing** for bold statement headlines ("WINNERS ARE IN!").

A typical ad pairs **one** of these with a quiet neutral. **Lead with bubble or
script**; use the condensed grotesque (`Anton`) only when a headline genuinely
needs that loud-poster weight — it's no longer the default.

**Rules of thumb:** headlines are tightly tracked and BIG (often bleeding off the
edge). Body/labels are frequently ALL-CAPS sans with generous letter-spacing.
Pair exactly one "expressive" face with one neutral face — never stack three
decorative faces.

## Official logo assets (use these, don't redraw)

The real brand kit lives in `assets/logos/`, organized by lockup (A–J), each in
6 on-brand colorways: **Primary Green, Dark Green, Light Green, Neutral, Black,
White** (warm Caramel/Wheat/Yellow colorways exist but are unused — ignore).
Composite the actual PNG into ads rather than typesetting or redrawing the mark.

- **A Logotype** — the "Lagroove" groovy-serif wordmark alone. The default mark.
- **B / C / D** — wordmark + flower logo, optionally + tagline, + "BOULDER,
  COLORADO" (the masthead lockup).
- **E Logo / Flower no circle** — the **sunburst-daisy flower mark** (with or
  without its thin circle). This is the official icon/logo — the same sunburst
  that appears centered in circular-text layouts.
- **F Tagline** — "Boulder's grooviest fitness studio" set as art.
- **G Logo + Tagline**, **H Logo Stamp** — circular **"TUNE IN · TONE UP"**
  badge around the flower (great as a corner stamp / sticker), **I** rainbow
  variant, **J Dressed** — decorative dressed-up versions.

Pick the colorway that contrasts the ground (e.g. White or Light Green on a
forest/olive ground; Primary/Dark Green on cream/sage). Pick the lockup by need:
plain wordmark for a footer signoff, the stamp for a playful corner seal, the
full city lockup for formal headers.

## Motifs & graphic elements

Reach for these, in rough priority:

1. **Disco ball** — THE hero. Appears as: thin line-art icon with sparkles;
   photographic mirror-ball prop (held by models, dangled by a hand);
   checkered/faceted illustration (two-tone green); gritty vintage-halftone
   collage cutout. The ball can be **real silver/chrome metallic** OR tinted
   green — a realistic chrome mirror-ball on a green/cream ground is on-brand
   (see "KEEP Showing UP").
2. **Sunburst / daisy badge** — a little radiating sun mark, often centered in
   circular text, and as the `LAGROOVE · BOULDER` roundel badge on photos.
3. **Retro flowers** — simple 5-petal daisies with curved stems, two-tone green.
4. **Hand-drawn doodles** — marker circles/ovals around words, curvy arrows,
   little hearts, 4-point sparkles/stars. Used to annotate and add warmth.
5. **Sparkles / twinkles** — 4-point stars and small `+`/`·` dots scattered near
   disco balls and headlines.
6. **The Megaformer** — the black Lagree reformer machine; appears in product
   photography and as a taped "polaroid" in collages.

## Textures & backgrounds

The brand loves a **tactile ground** instead of flat color:

- **Crumpled/kraft paper** (cream or minty) — subtle wrinkles, the most common.
- **Aura gradient** — soft radial green glow (forest center → lime/cream halo),
  for serene quote posts.
- **Psychedelic swirl / liquid marble** — 70s tonal-green swirl pattern, for
  playful meme/quote posts.
- **Silk / satin** — draped glossy green fabric, for "special event" posts.
- **Concentric rings** — thin hairline rings rippling out, behind quiet quotes.
- **Croc/embossed leather** — green textured leather, behind clipped polaroids.
- **Painterly wash** — hand-painted green plaster/gouache, behind cutout models.

## Layout grammar

- **Format:** 4:5 (1080×1350) feed default; 9:16 stories; 1:1 for swirl/meme &
  moodboard grids. Carousels are common (multi-slide; cue with "Swipe →").
- **Corner labels:** top corners often hold tiny ALL-CAPS sans metadata —
  date/month, `LAGROOVE`, or the Boulder address — like an editorial masthead.
- **Footer signoff:** wordmark or `www.LAGROOVE.com`, usually centered or in a
  corner.
- **Headlines bleed** off the edges and dominate. Photography is frequently a
  **cutout** (model on transparent background) layered over a colored ground,
  not a full-bleed rectangle.
- **Generous negative space.** Even busy collages breathe. Resist clutter.
