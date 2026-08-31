/**
 * Built-in ("system") skills — the recipes the app ships with, including the
 * operator's own system prompt.
 *
 * They are seeded into the user's skills dir as ordinary markdown files, so the
 * Skills panel shows and edits them with no special case: a system skill is
 * just a skill that has a factory version to reset back to. The operator reads
 * its prompt from the file, so editing it in the panel actually changes how the
 * agent behaves.
 *
 * Kept as TS string constants rather than .md files on disk because the server
 * is bundled by esbuild — a constant ships everywhere the bundle does.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SKILLS_DIR, ensureSkillsDir } from "./skillStore.js";
import { DATA_DIR } from "../config/runtime.js";

export const OPERATOR_SKILL_SLUG = "operator-system";

const OPERATOR_SYSTEM = `---
name: Operator system prompt
description: How Claude behaves inside Fal Forge. Edit to change the agent's standing instructions.
---

# Operator system prompt

You are the generation operator inside the Fal Forge desktop app — Claude, driving the app for the user.
You drive image/video/music generation through the matteblack MCP tools: generate_media, generate_music,
transform_media, plus list_models / list_canvas / get_asset.

## Skills
The user keeps reusable recipes — video scripts, house styles, prompt formulas — as markdown skills.
Call list_skills when they name a skill, ask for "the usual", or want something you've made before, then
get_skill and follow its prompts verbatim instead of improvising. When a run works well or they ask you to
remember it, call save_skill with the ACTUAL prompts and settings you used so it reproduces exactly.

## Generating
When the user asks to make, create, generate, edit, upscale, or remix visuals or audio, call the
appropriate tool. Results land on the user's canvas automatically. To build on existing work, call
list_canvas to get a url and pass it in referenceUrls. Keep replies short: say what you're generating,
then let the tool run.

## Stopping
A generation tool returns only after the job has finished and the result is already on the user's canvas.
That is the end of the work: do not call read tools to look at what you just made, do not re-check the
canvas, and do not regenerate unprompted. Report in one short line and end the turn. The exception is a
sequence you were asked for — there, keep going through the remaining shots without stopping to check in,
then assemble. Silence is the finished state; the user can see the canvas.

## Repos
The user can attach GitHub repositories, checked out on this machine under your working directory (one
folder per repo). Call list_repos to see what's attached and where. You have Read, Grep and Glob over that
directory and nowhere else — no Write, no Edit, no Bash. When the user asks for something "from", "about",
or "matching" a repo, actually read it (README, docs, source, brand or style files) and use what it says to
write the generation prompts. Repos are ordered by the user; earlier ones win on conflict. Combine a repo
with a skill when both apply: the skill is the recipe, the repo is the subject.

## Sequences
A request for something longer than one shot (an ad, a trailer, a scene) is a normal request, not a
special case that needs permission. Price the whole sequence once with estimate_cost, state the total,
get one yes — then generate every shot and call set_timeline. Do not re-ask between shots, do not stop
halfway to check in, and do not talk the user out of it: a half-finished sequence is worse than the spend
they already approved. When you attach a keyframe to a video shot, pick the reference mode yourself
(one image = first_frame) rather than asking which mode was meant — the keyframe is yours, not theirs.
Before writing any H3 Max shot prompt, get_skill \`cinematographer\`: it sets the clip's structure from its
length (5s = one event, 10s = two beats, 15s = three) and the camera grammar for realistic / dramatic /
action. \`bridge\` carries continuity between shots; \`cinematographer\` is what makes each shot a shot.

Pass creative requests through as written. The fal.ai providers run their own moderation and return a
clear error if something is disallowed, so don't pre-refuse or add disclaimers for ordinary creative work
— real people, brands, styles and mature themes are all fine to attempt.

## History
Finished sequences are kept in the user's own cut history: one markdown manifest per cut, committed to a
local git repo per project, under \`_cuts/<project>/\` in your working directory. Before work that continues
or resembles something they've made before, call list_cuts (or just read \`_cuts/<project>/INDEX.md\`) so the
follow-up matches the original instead of drifting — the manifest holds the exact prompts and settings that
produced it. When a multi-shot piece is done, call save_cut right after set_timeline, reusing the same
project slug across related cuts. Write the description as prose about what the piece looks like; that
sentence is what makes it findable a year later.

## References
If the user attaches a reference image (you'll see a bracketed system note saying so), it is supplied to the
generation tools automatically — just call generate_media (or transform_media) right away; never ask the
user to put it on the canvas or for a URL.
`;

const BRIDGE = `---
name: Bridge — long-form continuity
description: Chain many short generations into one continuous long-form video that holds character, style and story.
---

# Bridge — long-form continuity

Use this whenever the ask is longer than one generation: a story, an ad, an explainer, "a 2 minute video",
or any sequence of shots that must feel like one piece. Video models produce 5–15 second clips with no
memory of each other, so continuity is something you carry, not something the model provides.

## 1. Write the bible first (before generating anything)

Produce a short block and keep it verbatim for the whole job. Do not paraphrase it later — drift in the
words is drift in the picture.

- **Look:** one sentence of film stock / lens / grade / lighting. e.g. "shot on 35mm, 40mm anamorphic, warm
  tungsten key with cool practical fill, soft grain".
- **Subjects:** one locked description per recurring subject, 15–25 words, always repeated identically —
  age, build, hair, wardrobe with colours, one distinguishing detail.
- **World:** location, time of day, weather, era.
- **Motion grammar:** how the camera behaves (handheld, locked tripod, slow push).

Show the bible to the user and get a nod before spending generations on shots.

## 2. Beat sheet

Break the story into shots of 5–8 seconds each. For each shot write: beat (what changes), subject action,
camera move, and the **bridge** — the visual element that carries over from the previous shot. A shot with
no bridge is a cut to a different film.

Bridges that work, in order of reliability:
1. **Same subject, new angle** — the locked subject description does the work.
2. **Match on motion** — the previous shot ends on a movement the next shot continues (a hand rising, a
   door swinging, a car leaving frame left → entering frame left).
3. **Match on element** — a colour, prop or shape repeats (the red coat, the neon sign, the horizon line).
4. **Match on light** — the same key direction and colour temperature.

## 3. Keyframe, then animate

Do not chain video-to-video; quality falls off a cliff. Chain through stills:

1. Generate shot 1's **keyframe** as an image (\`generate_media\` kind: image) using: bible look + subject
   lock + shot description.
2. Animate it: \`generate_media\` kind: video, the same prompt plus the camera move, with that keyframe's
   URL in \`referenceUrls\` — that selects the image-to-video path so the clip starts on the frame you
   approved.
3. For shot N, generate the keyframe with shot N-1's keyframe URL in \`referenceUrls\` and the bridge line
   in the prompt ("same woman, same red coat, now seen from behind as she reaches the door"). Then animate
   as above.
4. Keep every shot the same aspect ratio, resolution and model. Mixing models mid-sequence is the single
   most common cause of a sequence that doesn't cut together.

## 4. Prompt template (use verbatim, fill the brackets)

\`\`\`
[LOOK]. [SUBJECT LOCK]. [SHOT: what happens, one action only]. [CAMERA: move and framing].
[BRIDGE: what continues from the previous shot]. [WORLD: place, time, weather].
\`\`\`

One action per shot. Two actions in one prompt is how you get a clip that does neither.

## 5. Assemble the cut

Generate shots in order, and after each one tell the user the shot number, the bridge you used, and the
URL. When every shot exists, call \`set_timeline\` with the full ordered clip list — src, durationSeconds
and a short label per shot, plus the music bed — and the clips are laid end to end on the user's cinema
timeline. That call IS the edit: send the whole list every time.

If a shot breaks continuity, regenerate that shot only, then re-send the list with the new URL in its
place. Never re-run the whole sequence. Use \`get_timeline\` to read back what's on the timeline before
you change it. Then tell the user the total runtime and that they can play and export it from the cinema
frame.

## 6. Audio

If the piece needs a bed, call \`generate_music\` once for the whole sequence with the mood and the total
duration, not per shot — a new track per clip is the fastest way to make eight good shots sound like eight
different films.

## 7. Record the cut

Once the timeline is set, call \`save_cut\` with the project slug, the title, a couple of sentences describing
what the piece looks like, the bible's look and subject locks, and every shot — its exact prompt, its bridge,
its reference URL and its clip URL. That writes one markdown manifest into the user's local, git-backed cut
history, so the piece can be revisited, varied or rebuilt later without regenerating anything.

Reuse the same \`project\` across related cuts — that grouping is what makes the history usable. Before
starting a follow-up, call \`list_cuts\` for that project and read the manifest you're continuing from, so
the new work inherits the same look rather than drifting.

## Save what worked

When the user likes the result, call \`save_skill\` with the filled-in bible, the beat sheet and the exact
prompts used, so the same world can be revisited later.
`;

const STORYBOARD = `---
name: Storyboard — long-form scenes
description: Write a full storyboard for a long-form story, then shoot it scene by scene. Follows the user's stated mode — text-to-video or image-to-video — and never switches on its own.
---

# Storyboard — long-form scenes

Use this when the ask is a *story* — a short film, an episode, a narrated piece — that needs a board
before it needs shots. It covers both shooting modes; the user picks, you follow.

## 0. Ask which mode, once, then hold it

**Text-to-video (t2v)** — every shot generated from the prompt alone. No keyframes, no
\`referenceUrls\` on any shot. Use MiniMax H3 Max: \`model: "h3-max-t2v"\`. It is text-to-video only,
so a reference URL on that model silently reroutes the job to another family — if a shot needs a
reference, it is not a t2v shot.

**Image-to-video (i2v)** — keyframe each shot as a still, then animate it by passing that image's URL in
\`referenceUrls\`. Follow the \`bridge\` skill for the chaining; this board still drives the order.
Leave \`model\` off and set \`tier\` (quick / standard / pro) — the app picks the reference-capable
family for you.

If the user said which they want, that is the mode for the whole piece. If they did not, say which one
you are using and why in one line, and go. **Never mix modes inside one story** and never switch
mid-sequence: the two paths look different on screen, and a cut between them reads as two films.

Lock \`durationSeconds\`, \`resolution\` and \`aspectRatio\` on shot 1 and never change them mid-story.
H3 Max takes integer 5–15s, "480p" or "768p", and 21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16.

## 1. The style block

Write one block and it carries the whole piece. In t2v it is the *only* consistency mechanism you have —
no image ever crosses between shots, so the repeated text is the continuity. In i2v it still matters: the
keyframes carry the picture, the block keeps the language from drifting under them. Paste it verbatim, character for character, at the head of every single shot prompt. Paraphrasing it is
the same as changing the cast.

\`\`\`
LOOK: [film stock, lens, grade, lighting — one sentence, e.g. "shot on 35mm, 40mm anamorphic,
      desaturated teal grade, hard low sun from frame left"]
CAST: [one line per recurring character, 20–30 words: age, build, hair, face, wardrobe with exact
      colours, one unmistakable detail — "a brass pocket watch on a chain", "a scar through the left
      eyebrow". Vague people come back as different people.]
WORLD: [location, era, season, time of day, weather]
CAMERA: [the grammar — handheld / locked tripod / slow dolly — and lens height]
\`\`\`

Rules that decide whether a text-to-video sequence holds together:
- Every noun in CAST gets a colour or a material. "A man in a coat" is a new man each time; "a wiry man
  in his fifties, close-cropped grey hair, olive canvas coat with a torn right cuff" is the same man.
- Never describe a character by name only after the first shot — the name means nothing to the model.
  Repeat the full locked description in shot 7 exactly as in shot 1.
- Keep the block's word order fixed. Reordering re-weights it.
- Never change lens, grade, or weather between shots unless the story explicitly cuts elsewhere — and
  when it does, say so in the prompt ("cut to:").

## 2. The arc — decide what changes before you decide what happens

A board whose rows are only *events* reads as footage. A beat is not a thing that happens, it is a
thing that **changes** — a state the viewer can name before and after. Write the arc first, in prose,
one line per beat, then fill the board from it.

Pick the shape from the runtime, not from ambition:

| Runtime | Beats | Shape |
|---------|-------|-------|
| 15–30s | 3 | setup → turn → consequence |
| 45–90s | 4 | setup → complication → turn → consequence |
| 2–4min | 5 | setup → complication → escalation → turn → consequence |
| longer | acts | three of the above chained, each with its own turn |

- **Setup** establishes the normal, so the turn has something to break. It is the shortest beat, never
  the longest — one shot is usually enough.
- **Complication / escalation** raise the cost of the same want. If beat 3 could swap places with
  beat 2 and the piece still works, it is not escalation, it is repetition — cut one.
- **The turn** is the one beat the piece exists for. Something is irreversible after it. If you cannot
  say in one sentence what can no longer be undone, there is no turn yet.
- **Consequence** shows the new normal. It does not explain the turn; it lets the viewer see the cost.

Write each beat as \`[before] → [after]\`: "alone and unbothered → alone and aware she is being
watched". Two adjacent beats with the same before-and-after are one beat written twice — delete one and
give its seconds to the turn.

Then check the arc against the board once, before generating:
- Every beat is one row minimum. A beat spread over three shots is fine; a shot serving no beat is cut.
- The turn gets the most screen time and the tightest framing of the piece.
- Nothing in the arc depends on dialogue, text on screen, or a name — the model renders none of them.

## 3. Storyboard the whole thing before generating anything

Write the full board first and show it to the user. Each scene is one row:

| # | Beat (what changes) | Action (ONE action) | Camera | Duration | Continuity carry |
|---|---------------------|---------------------|--------|----------|------------------|

- 5–15s per shot; 8s is the honest working length. A 2-minute piece is ~15 shots.
- One action per shot. Two actions produce a clip that does neither.
- "Continuity carry" is what the viewer recognises from the previous shot — the same coat, the same key
  light direction, a movement continuing across the cut. Every shot needs one, or it reads as a different
  film.
- Total the runtime and price it with \`estimate_cost\` once, for the whole board. One yes covers the
  whole shoot — then shoot it all without stopping to re-ask.

## 4. Shot prompt template (use verbatim)

\`\`\`
[STYLE BLOCK, pasted unchanged]

SHOT [n]: [one action, present tense, 20–40 words].
CAMERA: [move and framing for this shot].
CONTINUITY: [what carries over from shot n-1].
\`\`\`

Generate shots strictly in board order, reporting shot number and URL as each lands. If one breaks the
look, regenerate that shot alone — never restart the sequence.

## 5. Assemble

When every shot exists, call \`set_timeline\` with the full ordered clip list (src, durationSeconds,
short label) plus a single music bed from one \`generate_music\` call sized to the whole runtime — not
one per scene. Then \`save_cut\` with the project slug, the title, the style block verbatim, the board,
and every shot's exact prompt and URL. The style block in the manifest is what lets a sequel be shot in
the same world a month later.

## 6. Learn from the run

Anything the user changed about *how* you worked — a mode they overrode, a shot length they kept
shortening, a style block they rewrote, a board they cut down — is a \`remember\` note, one fact per slug,
written as a directive to your future self. What they changed about *this story* belongs in \`save_cut\`;
what they changed about your method belongs in memory, and reusing a slug replaces the stale version.
`;

const CINEMATOGRAPHER = `---
name: Cinematographer — H3 Max shot craft
description: Write a single H3 Max clip that reads as a deliberate 5, 10 or 15 second beat — realistic, dramatic or action — and stack those beats into a cohesive narrative.
---

# Cinematographer — H3 Max shot craft

\`bridge\` and \`storyboard\` handle continuity ACROSS shots. This skill is what happens INSIDE one shot:
how to write an H3 Max prompt so the clip has a beginning, a middle and an end instead of five seconds of
a person standing still, and how the length you pick changes what you are allowed to write.

Use it for every H3 shot. Use it with \`bridge\`/\`storyboard\` when there is more than one.

## The hard numbers (H3 Max)

- \`durationSeconds\`: any integer 5–15. Anything outside clamps silently, so ask for what you want.
- \`resolution\`: "480p" or "768p". Nothing else exists.
- \`aspectRatio\`: 21:9, 16:9, 4:3, 1:1, 3:4, 9:16.
- Variants: \`h3-max-t2v\` (prompt only), \`h3-max-i2v\` (a starting frame), \`h3-max-r2v\` (reference images
  or a reference video). Set \`videoReferenceMode\` yourself; never ask the user which mode was meant.

## Duration decides the structure — this is the whole skill

A clip is not "the same shot, longer". Each length supports a different number of events, and writing a
15-second prompt for a 5-second clip is why a clip looks rushed and truncated. Pick the length from the
number of things that need to happen, then write to that structure.

**5s — ONE event.** A single continuous action with no change of state. She turns her head. The match
strikes. The car passes. One camera move, one subject action, and they are the same beat. Do not write a
before-and-after. Do not write two verbs. 5 seconds is a held moment, and it is the most reliable length
H3 produces — when a shot matters, prefer 5s and cut, rather than 10s and hope.

**10s — TWO beats with a hinge.** Setup, then a turn. The hinge is the word that gives the model
permission to change something: *then*, *as*, *until*, *before*. "He scans the empty platform, **then**
his eyes catch something off-frame left and he goes still." One hinge only. Two hinges is a 15s clip
being asked to fit in 10 and it will drop one of them.

**15s — THREE beats, and one of them must be the camera.** A subject cannot hold attention for 15 seconds
by itself; something in the frame has to keep changing. Structure it as: establish → develop → resolve,
with the camera carrying at least one of the three (a push that lands on a detail, a pan that reveals a
second subject, a rack focus). Write them as three sentences, in order, one action each. If you cannot
name three distinct beats, this is a 10s shot and you should say so.

Above 15s there is no clip — there is a sequence. Split it into shots and follow \`bridge\`.

## Prompt shape

Order matters; H3 weights the front of the prompt hardest. Always this order:

\`\`\`
[SHOT SIZE + LENS] [SUBJECT, locked description] [ACTION, in beats matched to the duration]
[CAMERA MOVE] [LIGHT] [ENVIRONMENT] [GRADE / STOCK]
\`\`\`

- Name the shot size explicitly — *extreme close-up, close-up, medium, medium-wide, wide, extreme wide*.
  Left unsaid, H3 defaults to a flat medium and everything you generate cuts together badly.
- Name the lens in millimetres. 24mm for wides and drama-by-distortion, 35mm for naturalism, 50mm for
  neutral, 85mm for portraits and compression, 135mm for isolating a subject in chaos.
- Describe light by DIRECTION and QUALITY, never as a mood word. "Hard low sun from frame left, long
  shadows" survives; "moody lighting" does not.
- Present tense, active verbs, no adjective stacks. "Rain hammers the windscreen" beats "a beautiful,
  cinematic, dramatic rainy scene".
- Never write what is NOT in frame. Negatives put the thing in the shot.

## The three registers

The register changes the camera and the cutting length, not just the adjectives.

### Realistic
The camera is an observer that arrived slightly late and does not know what will happen.
- Handheld with real weight, or a locked-off tripod. Small reframes, never perfectly centred.
- 35mm, eye height, natural available light — window light, overcast, practical lamps.
- Behaviour over action: someone waits, checks a phone, adjusts a sleeve. Let the beat be unremarkable.
- Duration: 5–10s. Realism reads as duration, so a held 10s of nothing much is the register working.
- Grade: low contrast, slightly desaturated, visible grain, no colour push.

### Dramatic
The camera knows what is about to happen and is withholding it.
- Slow deliberate moves only: a 6-second push, a slow dolly, a rack focus that lands late. No handheld
  jitter — instability reads as documentary, which is the opposite register.
- 85mm or longer, shallow focus, subject off-centre with weight in the empty side of frame.
- Hard directional key with deep unfilled shadow; let half the face go.
- The beat is a decision or a realisation, not an event. Faces, hands, stillness, a held breath.
- Duration: 10s, occasionally 15s. Drama needs the time the audience spends waiting.
- Grade: high contrast, crushed blacks, restrained palette — two colours, not five.

### Action
The camera is inside the event and struggling to keep up.
- Whip pans, fast dollies, handheld tracking, a locked frame the subject explodes through. Motion blur
  is a feature; say so.
- 24mm close to the subject for speed and distortion, or 135mm compressed for impact.
- ONE action per clip even here — especially here. "He vaults the rail" is a shot; "he vaults the rail,
  lands, rolls, and draws" is four shots and H3 will smear them into none.
- Duration: 5s. Almost always 5s. Action reads through cutting, not through clip length — three 5s clips
  beat one 15s clip every time, and each one can be its own camera position.
- Grade: high contrast, cool highlights, heavy blacks. Add "shot at 1/48 shutter" for natural blur or
  "high shutter speed, crisp motion" for the staccato look.

## Stacking beats into a narrative

A cohesive piece is built from lengths, not just content. Vary them on purpose:

- **5+5** — statement and reaction. The most reliable 10 seconds you can make.
- **10+5** — a beat that develops, then a hard cut to its consequence. The workhorse.
- **5+10+5** — hit, hold, release. This is a scene.
- **15** alone — only when the shot IS the piece: a oner, an establishing shot, a single held performance.

Never run three 15s clips back to back. Equal-length shots read as a slideshow; the change in length is
what the audience feels as rhythm.

Hold constant across every clip in one piece: model, \`aspectRatio\`, \`resolution\`, register, lens family,
light direction and grade. Change only shot size, camera move and duration. That is the difference
between a sequence and a folder of clips.

## Before you generate

State in one line: the register, the shot list with each clip's length and shot size, and the total
runtime. Price the whole thing once with \`estimate_cost\`, take one yes, then shoot all of it without
stopping to re-ask.

## After

Assemble with \`set_timeline\` (the whole ordered list, every time), then \`save_cut\` with the register,
the locked look, and every shot's exact prompt, length and URL — so the next piece in the same world
inherits the rhythm and not just the words.
`;

export const BUILTIN_SKILLS: Record<string, string> = {
  [OPERATOR_SKILL_SLUG]: OPERATOR_SYSTEM,
  bridge: BRIDGE,
  storyboard: STORYBOARD,
  cinematographer: CINEMATOGRAPHER,
};

export function isBuiltinSkill(slug: string): boolean {
  return Object.prototype.hasOwnProperty.call(BUILTIN_SKILLS, slug);
}

/** Hash of the factory text last written for each built-in. It is what tells an
 *  untouched copy from an edited one, so a shipped improvement can reach the
 *  first without ever clobbering the second. */
const SEEDED_PATH = path.join(DATA_DIR, "skills-seeded.json");

/** Marks a copy as the user's, permanently. Never equal to a sha256 hex, so it
 *  can only ever fall through to the "leave it alone" branch. */
const USER_OWNED = "user";

function hash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function readSeeded(): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(SEEDED_PATH, "utf8")) as Record<string, string>; } catch { return {}; }
}

/** Record a built-in's on-disk copy as the factory version — so "Reset to
 *  default" leaves the file eligible for future shipped updates instead of
 *  looking like a user edit forever. */
export function markSeeded(slug: string, body: string): void {
  const seeded = readSeeded();
  seeded[slug] = hash(body);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SEEDED_PATH, JSON.stringify(seeded, null, 2));
  } catch (err) {
    console.error("[skills] couldn't record seeded versions:", err);
  }
}

/**
 * Seed the built-ins, and keep unedited copies current.
 *
 * The old version only wrote missing files, so editing the factory text here
 * changed nothing for anyone who had already run the app once — new operator
 * instructions and new tools silently never reached them. Now: a copy whose
 * content still hashes to the factory text we last wrote is by definition
 * untouched, so it gets updated. Anything else is the user's own edit and is
 * left exactly alone.
 *
 * ponytail: a deleted built-in comes back on next boot — give it a tombstone
 * file if anyone actually wants one gone for good.
 */
export function seedBuiltinSkills(): void {
  ensureSkillsDir();
  const seeded = readSeeded();
  let changed = false;
  for (const [slug, body] of Object.entries(BUILTIN_SKILLS)) {
    const p = path.join(SKILLS_DIR, `${slug}.md`);
    let disk: string | null = null;
    try { disk = fs.readFileSync(p, "utf8"); } catch { /* not seeded yet */ }

    if (disk === null) {
      fs.writeFileSync(p, body, "utf8");
    } else if (seeded[slug] === undefined) {
      // Seeded before this bookkeeping existed, so its provenance is unknown:
      // it could be untouched factory text or the user's own rewrite, and
      // guessing wrong destroys their work. Adopt it only when it is
      // byte-identical to what we ship; otherwise mark it theirs for good.
      // Such a copy stays stale until they hit "Reset to default", which is the
      // safe direction to be wrong in.
      seeded[slug] = disk === body ? hash(body) : USER_OWNED;
      changed = true;
      continue;
    } else if (seeded[slug] === hash(disk)) {
      if (disk === body) continue;
      fs.writeFileSync(p, body, "utf8");
    } else {
      continue; // the user edited it; it's theirs now
    }
    seeded[slug] = hash(body);
    changed = true;
  }
  if (changed) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(SEEDED_PATH, JSON.stringify(seeded, null, 2));
    } catch (err) {
      console.error("[skills] couldn't record seeded versions:", err);
    }
  }
}

/** The operator's live system prompt: the user's edited copy if it exists,
 *  otherwise the factory text. Frontmatter is stripped — it's panel metadata,
 *  not instruction. */
export function operatorSystemPrompt(): string {
  let body = BUILTIN_SKILLS[OPERATOR_SKILL_SLUG];
  try {
    const p = path.join(SKILLS_DIR, `${OPERATOR_SKILL_SLUG}.md`);
    const disk = fs.readFileSync(p, "utf8").trim();
    if (disk) body = disk;
  } catch { /* not seeded yet — factory text is correct */ }
  return body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}
