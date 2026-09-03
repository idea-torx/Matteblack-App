---
name: Help — what to make and the cheapest way to make it
description: "Help", "how do I", "cheapest way": ask what they want, pick the route, show how skills chain.
---

# Help — what to make and the cheapest way to make it

Fetch this when the user says "help", "what can you do", "how do I…", "what's the cheapest way", or opens
with no clear ask. Reply in the user's language, short, no menus longer than six lines.

## 1. Ask one question, then stop

Ask what they want to end up with, offering these and nothing else:

1. a still — poster, card, chart, quote, mockup
2. one short clip (5–15 s)
3. one continuous shot longer than a clip (20–30 s)
4. an ad, trailer or scene with sound (30–90 s)
5. a change to something already on the canvas — cut out, upscale, resize, vectorize, restyle
6. copy — script, voiceover text, captions, on-screen words

Also ask 9:16 (phone, social) or 16:9 (screens, YouTube) if they did not say. Then wait.

## 2. Recommend the route and say why it is the cheapest

Call `estimate_cost` before quoting money; never guess a price. Rule of thumb: H3 Turbo costs half of
H3 Max per second, 480p costs about 60% of 768p, and `render_html` is free.

| Want | Route | Skills to fetch | Why |
|---|---|---|---|
| Still with real text | `render_html` — write the page, exact pixels | `render-html`, `static-poster-banger` (5 s motion version) | Free, exact type, revisable with `edits` |
| Still that needs to be a photo or illustration | `generate_media` image, then `render_html` for any text on top | `layout` after | Models spell badly; type belongs in HTML |
| One clip, draft | `generate_media` H3 Turbo, 480p, 10 s | `cinematographer`; `realism` for people; `action` for hits and chases | Cheapest video that still reads |
| One clip, final | Same prompt, H3 Max, 768p | same | Re-shoot only what is locked |
| 20 s continuous | 2 × 10 s H3 Turbo 480p; second clip via `continue_video` seam `frame`; `set_timeline` | `bridge`; `action-bridge` for fights and chases | Two seams, one scene, no cut |
| 30 s continuous | 3 × 10 s the same way | `bridge` | Three clips is the natural scene length |
| Ad, trailer, scene | Scenes of ~3 clips, hard cut between scenes; `generate_music` / `generate_voiceover`; `set_timeline` | `sequences` (price once, one yes), `storyboard` for a story, then per-clip skills, then `cuts` | Continuity is per scene, never across the piece |
| Change an existing asset | `transform_media`: `remove_background`, `upscale`, `resize`, `vectorize` (then `get_asset` → paste the SVG into `render_html`) | `render-html` for the vector step | No new generation |
| Copy | Write it, run a humanizer pass (`humanizer-2-0` if `list_skills` shows it), then `generate_voiceover` or `render_html` | `humanizer-2-0` | Wooden copy is the usual reason a good clip feels fake |

Video falls through to H3 Max when a named model is missing — never to Seedance.

## 3. How skills chain

Order, skipping what does not apply: copy (`humanizer-2-0`) → story (`storyboard`) → per-clip prompt
(`cinematographer`, `realism`, `action`) → seams (`bridge` or `action-bridge`) → pricing and
timeline (`sequences`) → tidy (`layout`) → record (`cuts`). Fetch each with `get_skill` when its step
starts, not all at once.

## 4. Best practices to tell them

- Draft cheap, finish dear: lock the prompt on H3 Turbo 480p, then re-shoot the keepers on H3 Max 768p.
- One piece, one setup: model, aspect, resolution and clip length identical across every shot.
- Three clips per scene, then a cut. Long chains morph; cuts are free.
- Static seam frames: end each chained clip on a hold so the next one starts clean.
- Text is always HTML. Never ask a video or image model to spell.
- Edits need the exact new copy. Ask for it before touching an asset.
- Price multi-shot work once, get one yes, then run every shot without stopping.

## 5. Prompts they can paste

- "Use bridge to make a 20 s continuous clip: 2 × 10 s, H3 Turbo, 480p, 9:16 — [subject, action, place]."
- "Same shot as a final: H3 Max, 768p, 16:9."
- "Humanizer pass on this voiceover, then generate it: [script]."
- "Vectorize the logo on the canvas and build a 1080×1350 poster around it with render_html."
- "30 s ad for [product]: three scenes, music bed, one voiceover line per scene. Price it first."
- "Cut out the subject of the last image and upscale it 2×."
