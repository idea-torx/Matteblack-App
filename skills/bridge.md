---
name: Bridge — long-form continuity
description: Chain short generations into long-form video. Continuity is scene-scoped — a scene is a handful of clips, then you cut. Covers seam modes, screen geography for multi-person scenes, the camera-motion rule that stops seams from morphing, beat density so a long clip doesn't play hollow, and how to extend a cut without the beats going slack.
---

# Bridge — long-form continuity

Use this whenever the ask is longer than one generation: a story, an ad, a scene, "a 2 minute video."
Video models produce 5–15 second clips with no memory of each other, so continuity is something you
carry.

The core idea, and the thing most people get wrong:

> **Continuity is a bridge between adjacent clips inside a scene. It is not a through-path across the
> whole piece.**

A film is not one unbroken flow. It is a handful of scenes, each internally continuous, separated by
honest cuts. Trying to make minute three continuous with minute one is not ambitious, it is a category
error — and every clip spent forcing it is a clip that morphs, drifts or teleports.

## 0. Structure: scenes, then cuts

Build the piece as **scenes of about three 5-second clips (~15s)**. Inside a scene, chain. Between
scenes, cut.

```
SCENE A  clip → clip → clip     chained, seam: frame
   ══ hard cut ══                new location / time / angle / subject
SCENE B  clip → clip → clip     chained, seam: frame
   ══ hard cut ══
SCENE C  clip → clip → clip
```

- **Three clips is the natural scene length.** One beat set up, one beat answered, one beat buttoned. Two
  feels clipped. Five is fine when the beats keep arriving — it is a default, not a ceiling — but the
  chain only survives it if every seam frame is static (§4).
- **Start each new scene with a fresh `generate_media` call**, not a continuation. A new scene has no
  obligation to the last frame of the previous one, and giving it one is how you end up inventing a
  portal to justify a cut.
- **The cut between scenes is carried by the story**, not by the picture: the same characters, the same
  problem, moved on in time or place. That is all a real cut has ever needed.

**At longer chunk lengths this inverts.** A 15-second clip holds a whole four-beat scene on its own, so
the chunk boundary *is* the scene boundary and the join wants to be a cut (`reference`) rather than a
chain. At 5s, `frame` is the workhorse and `reference` the exception; at 15s it is the other way round.
The deciding question is never clip length by itself — it is **whether this boundary is also a scene
boundary.** Two 10-second clips telling one continuous story are one scene, and chain on `frame`.

Ask what the piece is made of before you generate anything. "A 60-second ad" is four scenes, not twelve
chained clips.

## 1. Pick the seam mode — it is a choice, not a quality ladder

`continue_video` joins clips two ways. Neither is better; they do different jobs.

| Seam | What it does | Returns | Use for |
|---|---|---|---|
| `frame` | Starts the new clip on the previous clip's **exact final frame**. | `h3-max-i2v` | **Inside a scene.** One continuous take, one camera position or one contained move. The default for chaining. |
| `reference` (+ `tailSeconds`) | Feeds the previous clip's final seconds as a **motion and subject reference** — carries the room, the light and the faces, not the frame. | `h3-max-r2v` | **Across a cut**, when you want a genuinely new angle but the same world. Coverage within one location, and scene breaks. |

Check the returned model string. `-i2v` or `-r2v` means the seam engaged; `-t2v` means the source was
silently dropped and you have an unrelated clip.

**A 30-second piece is one continuous take: chain it on `frame`.** A reference seam is a cut to a new
setup, and there is no room for a new setup inside thirty seconds. When the brief says *continuous*,
*one take*, *seamless*, or the piece is under a minute, every join is `frame`. Reference seams earn
their place in longer pieces, at scene breaks and for coverage inside a scene that runs for minutes.

**The one exception inside thirty seconds: a character's first appearance.** A `frame` seam takes a
single seed frame and nothing else, so no still can ride on it; only a `reference` seam carries plates.
When a character with a plate (§2, Subject stills) enters partway through, make *that* join `reference`
— tail of about 10 seconds, the whole cast's plates plus the newcomer's in `referenceUrls` — and write
them entering from off-frame, never appearing in place: a person walking in is the one cut a viewer
does not see. Every join after it goes back to `frame`. A walk-on with no plate is written into the
chunk by description alone and needs no seam change.

**`tailSeconds` defaults to 6 and costs nothing extra.** Use 3 at a scene break, where the camera changes
and you want the old setup to have as little pull as possible; keep 6 for coverage inside one location,
where the extra seconds carry more identity and motion across the cut.

**`reference` carries the aspect ratio.** The tool reads the source clip's shape and sends it with the
generation, so a 9:16 source stays 9:16 over either seam — pick the seam for the cut, never for the
orientation. Belt and braces on non-16:9 pieces: put the orientation at the very top of the prompt
(*"Vertical 9:16 portrait frame, tall and narrow"*) and add `horizontal frame, widescreen, 16:9,
letterbox, black bars, changing aspect ratio` to the negatives.

**Don't invent a diegetic event to hide a seam you didn't want.** A spreading shadow, a rising object, an
opening portal placed there only to give the stitch something to hold onto — that is writing the story
around the stitching mechanism, and it shows. Real coverage just cuts.

**But when a seamless join is the actual brief, build the transition and make it the best beat in the
clip.** Use a `frame` seam and change the world in shot. Three ways, cheapest first:

1. **Physical action** — a character is thrown, carried, driven, falls. The new location arrives as a
   consequence of the story. Always prefer this when the story can supply the motion.
2. **A medium-native transformation** — clay walls peeling like putty, felt seams unpicking, paper pages
   turning. The material behaving as the material does is not an invented event.
3. **An in-world device** — a portal, a beam. Last resort, and the thing rule one above is warning about.

For a location change on a frame seam: open on the old location, play a beat there, *then* transform, and
restate the geography chart (§3) as holding **through** the change. The seed frame pins the sculpts and
the geometry; the prompt is free to rebuild everything behind them. Negatives:
`cut to a new shot, hard cut, scene change`.

For `reference` continuations, open the prompt with:

> A NEW SHOT — cut to a completely different camera angle. This is a fresh setup, not a continuation of
> the previous camera position.

Without that line, reference mode resumes the old camera and you get a jump cut instead of coverage.

**At a scene break, hold the screen sides.** Go wider, go lower, change the setup — but stay on the same
side of the line so LEFT / CENTRE / RIGHT (§3) survives the cut. Changing setup *and* crossing the line in
one move is an invitation to swap people.

### Other models

`h3-max` via `continue_video` is the working path and everything above assumes it. Two alternatives
remain useful:

- **`veo3.1-lite` + `videoReferenceMode: 'first_last_frame'`** — pins a clip at *both* ends between two
  stills you approved. Highest control, most setup, durations snap to 4/6/8s.
- **Keyframe-then-animate (`first_frame`)** — generate the opening still, approve it, animate it.
  Stills are cheap and clips are not, so this is worth it when a shot must look exactly like something.

Keep aspect ratio, resolution and model identical across every clip in a piece. Mixing models mid-sequence
is the most common cause of a sequence that won't cut together.

## 2. The bible — write it once, restate it verbatim

A short block, repeated **word for word in every single clip prompt**. Not "same as before" and not a
paraphrase; drift in the words is drift in the picture.

- **Look** — one sentence of stock, light, grade, grain. e.g. *"Shot on 35mm in the flat bright look of a
  1990s American sitcom: even warm key light, minimal shadow, gentle film grain, television framing."*
- **World** — location, time of day, era, and 3–4 specific set objects that let you say "same" later
  (*teal vinyl seats, orange formica table, two white mugs, a big lettered window*).
- **Subjects** — one locked description per character, 15–25 words: build, hair, wardrobe with colours,
  one distinguishing detail.
- **Sound** — what the diegetic bed is, stated every clip so it doesn't restart.
- **Voice** — per speaking character: age, gender, accent, temperament. e.g. *"MAYA: a woman in her
  mid-twenties, warm low London accent, dry and unhurried."* State the accent twice in every chunk, once
  here and once beside the lines, and put the wrong accents and the wrong gender in the negative prompt.
  One mention drifts by the third chunk.
- **Subject stills** — one approved still per character, including anyone who arrives late
  (keyframe-then-animate, §1), generated before the first clip. Before generating any, ask the user
  once where the cast comes from: **generated from scratch** (describe each, approve each still),
  **pulled from a repo** (existing character art or brand mascots via `list_repos`), or **made up by
  you** with no plates (fastest; faces are whatever the model invents). Pass the same URLs as
  `referenceUrls` on every `reference` continuation: the tail carries only the last few seconds, and
  these stills are what hold a face together once the scene is many chunks old. Record the URLs in
  the cut (§9) so the next piece inherits the cast.

Keep it lean. **Prompt bloat feeds morphing** — an overloaded prompt gives the model more to reinvent at
every seam. Say each thing once, clearly, and stop.

## 3. Screen geography — the anti-teleport rules

Two or more people in a scene teleport across seams because **off-screen geography is geography the model
invents.** Four rules, all restated verbatim in every chunk of the scene:

**1. A standing/seating chart, in caps, by SCREEN side.** Left and right *of frame*, never world-side —
the model composes in frame space.

> SEATING, WHICH NEVER CHANGES: GEORGE sits on the LEFT of the frame — short, stocky, balding, round
> tortoiseshell glasses, olive-green zip jacket. JERRY sits on the RIGHT of the frame, directly opposite —
> slim, neat short dark hair, blue button-down. Neither man ever swaps seats, stands up, or crosses the
> table.

**2. Anchor the silent character in frame.** Design the shot so whoever isn't talking stays physically
visible — an over-the-shoulder past them, a shoulder held in the foreground. *A character you can see
cannot be relocated.* This is the strongest of the four.

**3. Every entrance and exit needs a stated route.** Not just exits — *"he enters from the LEFT edge of
frame and walks in to stand in the CENTRE"*, *"his shoulder slides off the left edge as the shot tightens
past him — he does not disappear."* An unrouted arrival is an unrouted position. When a new character
arrives, motivate the camera move by the arrival (a small pull back to take in a third person) so it reads
as blocking rather than as a camera tic.

**4. One speaker per beat, declared in caps, with an acting note.** Name *how* they talk, not just what
they say — *fast and conspiratorial* / *dry and unhurried* / *wounded defensive confidence*. Describe the
other characters as silent **and located**. In a multi-beat clip (§5) the speaker changes between beats,
but never inside one — declare each beat's speaker in its own timecoded line.

Negative prompt, every clip: `characters swapping seats, a man on the wrong side of the table, [NAME]
vanishing, [NAME] reappearing, anyone teleporting, empty booth, overlapping dialogue, repeated dialogue`.
Name every off-camera character as not speaking and not in frame.

## 4. Camera motion — begin at rest, end at rest

**Never leave a camera move in flight at a seam.**

A frame seam hands the next clip a **still image**, and a still has no velocity. Anything mid-move gets
re-invented by the continuation, and re-invention wobbles: it reverses direction, or it morphs the whole
frame trying to resolve a motion it can't read.

The rule:

> **One small camera move per clip. It starts at rest, eases to a complete stop before the clip ends, and
> the final second is held perfectly static.**

- **Vary the move between clips** — a tiny push, then a slight drift, then a tiny push — so it doesn't
  read as a repeating tic.
- **Keep it small.** A few inches. Big sustained moves are large geometric transforms and the model
  resolves them by morphing.
- **One move per clip, not per beat.** A 15-second clip holds four beats and still gets exactly one
  camera move. Beats are carried by performance and cutting-in-camera, not by the camera restarting.
- **Locked-off is stable but dead.** Zero movement across a whole scene reads as a slideshow. The small
  contained move is the working middle.
- Let the **performers** carry the energy. A lean-in, a hand thrown out, a mug set down — that is what
  makes a static frame feel alive, and it costs nothing at the seam.

Add to every negative prompt: `camera still moving at the end of the shot, fast camera movement, pan,
tilt, arc, orbit, dolly, zoom, handheld, camera shake, morphing, warping geometry, reframing`.

**Never name camera directions in a negative prompt.** "Not panning left" summons panning left. Say what
the camera *does* in the positive prompt and forbid movement generically in the negative.

*(This supersedes the old rule about ending a clip mid-camera-move for the next one to complete. Tested
four ways on the same scene: ending mid-arc flipped the direction; re-declaring the vector harder made it
oscillate and morph; locked-off was inert; begin-at-rest / end-at-rest worked.)*

## 5. Beats and pacing

### Beat density — write enough story to fill the runtime

Dialogue-led comedy runs at **roughly a beat every three and a half seconds.** That is a proxy for
sanity-checking a script, not a rate to hit:

| Clip length | Beats, as a floor | Shape |
|---|---|---|
| 5s | 1 | line in the first second, reaction held for the last two |
| 15s | 4 | set up, answer, escalate, button |
| 10s | 3 | set up, answer, button |

**Faster material carries far more, and should.** A montage, a running argument, a gag reel, a musical
number, a chase — five seconds of any of those can hold three or four beats and play tight rather than
rushed. The genre sets the pace; the table is only there to catch the opposite failure. Use it to ask
*"is there enough here?"*, never *"is there too much?"*

**Work out roughly how many beats the runtime wants before you write a word of prompt.** Two 10-second
clips is not "two moments," it is closer to **six beats** of story, and the script has to contain six
things that happen. Multiply first, then write to the number, then let the material push it up.

The failure mode when you don't: the clip plays **hollow.** Not badly generated — correctly generated and
thinly written, with the model stretching two ideas across ten seconds by adding dead air between them.
It reads as a pacing problem but it is a **scripting** problem, and no prompt tuning fixes it. The tell
is a clip where you could remove three seconds and lose nothing.

- **Every beat is a new piece of information**, not a longer version of the last one. A reaction shot to a
  line already delivered is not a beat. A reply that changes the situation is.
- **Timecode the beats in the prompt** — `0-3s: ... 3-6s: ... 6-10s: ...` — so the model paces the whole
  runtime rather than front-loading and drifting. Uneven timecodes are fine and often better: three fast
  beats and one long held one is a rhythm, four evenly spaced ones is a metronome.
- **Escalate.** With three or four beats there is room for the situation to get worse before it buttons,
  and that is what stops the middle sagging. Two-beat writing has no middle to sag, which is why it feels
  minimal rather than slow.
- **When the runtime is fixed by the user, the story bends to it, not the other way round.** If the ask
  is 20 seconds and the idea only has three beats in it, add beats — a complication, an objection, a
  second attempt — rather than stretching what you have.

### Dialogue budget across chunks — split the words before you cut the picture

The recurring failure: chunk one is two words and a walk, chunk two is six lines and the pitch. It happens
because the script is written whole and then cut where the *picture* changes, so the establishing chunk
gets the bible and the payoff chunk gets every line. The viewer hears a silent opening and a crammed close.

- **Count first.** Before any prompt, list every line for the whole piece with its word count, then deal
  them across the chunks so no chunk is more than one line or a handful of words heavier than another.
- **Establishing happens under dialogue, never before it.** The first chunk's first line lands in its
  first second, while the geography and the walk are still being set up. A chunk with no line until the
  seam is a silent chunk, however much it moves.
- **Rebalance by beat, not by trimming.** When a chunk is heavy, move a whole beat and its line into the
  earlier chunk. Shortening lines leaves the count uneven and the delivery rushed. Moving chunk one's
  content invalidates the frame seam after it — re-shoot both.
- **The closing chunk carries the shortest last line**, so the end card has air.
- Pacing paragraph, every chunk: *"only [N] short lines, spread evenly across the runtime, room to
  breathe."* Negatives, every chunk: `crowded dialogue, four lines, extra dialogue, improvised extra lines,
  silent opening`.

### One action at a time, inside each beat

Each **beat** is one point and one action. Two actions in a single beat gets you a beat that does neither.

- **Beat** — the one point it makes.
- **Close** — how it lands. The line is paid off, the gesture finishes, the reaction registers.
- **Handoff** — **narrative, not physical.** What the next beat answers: a question asked, a claim made,
  a look held. Not an object crossing the seam.

A clip that ends in the middle of its own beat is a mistake, even when the next clip picks it up.

### Budget the runtime, or the beats won't land

The camera-at-rest rule (§4) tempts you to spend the first second and a half settling before anything
happens. Then the first line lands late and everything after it is compressed. **State the budget in the
prompt:**

> PACING: [NAME] is ALREADY mid-turn as the very first frame begins and the line starts immediately, in
> the first second — no pause, no settling, no beat of stillness before speaking. [Then the timecoded
> beats.]

- **The line starts in the first second.** Say "already turning and already talking."
- **On a 5-second clip, the reaction is the second half, and the reaction IS the beat landing.** A held
  unimpressed stare after the line is the joke; a held stare before it is dead air. On longer clips only
  the *final* beat gets that held reaction — the earlier ones hand straight over to the next line.
- **Camera settling and speaking happen at the same time**, not in sequence. The small move runs
  underneath the dialogue.
- Negative prompt: `pause before speaking, silence at the start of the clip, waiting to speak, slow start`.

### Extending a cut that already ended

Grafting new clips onto a finished piece is where pacing goes wrong, because **you are extending from a
full stop.** The old final clip was written as a resolution — *"this is the end of the scene, it resolves
fully, the final second is a still held beat"* — and a resolved beat has no forward pressure. The next
clip has to restart the engine from zero, which is exactly the slack the pacing budget above exists to
prevent.

When continuing a cut that already ended:

1. **Open the new clip with the character already in motion.** No standstill start. The seam frame is
   static; the *performance* must not be.
2. **Apply the pacing budget hard** — first line in the first second, beats on the clock after that.
3. **Demote the old resolution.** The clip that used to be last is now a middle clip; re-generate it
   without the "this is the end" language if its held ending is visibly braking the piece.
4. **Only the true final clip gets the full resolution.** Exactly one clip in the piece ends with a held
   beat and no handoff.

Regenerate only the clips that need it and re-send the whole list to `set_timeline`.

## 6. Prompt template

```
PACING: [NAME] is already [in motion] as the first frame begins and the line starts immediately, in the
first second. [Then the timecoded beats below.]

CAMERA: begins completely still, then [one small move], easing to a complete stop before the end.
The final second is held perfectly static. No other movement.

[LOOK — verbatim from the bible]. [WORLD — same location, same named objects].

[GEOGRAPHY — caps chart, screen sides, routes for any entrance or exit, never-swaps negative].

[SHOT: framing.] Then the beats, timecoded, one speaker each — as many as the material wants:
  0-3s   [NAME], [acting note], [action]: "[line]".
  3-6s   [NAME], [acting note], [action]: "[line]".
  6-10s  [NAME], [acting note], [action]: "[line]".
[Other characters] stay [where] and say nothing, [what they do].

[Sound — diegetic bed, "continuous with the previous shot"].

[CLOSE — how the last beat lands. On the true final clip, the full resolution instead.]

Negative prompt: [pacing set], [camera set], [speaker set], [geography set], [look set].
```

## 7. Assemble

Generate clips in scene order. When they all exist, call `set_timeline` with the **full ordered list** —
`src`, `durationSeconds`, a short label per clip — plus the music bed. That call *is* the edit: send the
whole list every time.

There is one cinema timeline. `set_timeline` replaces what is on it and cannot open a second node. Before
replacing a cut the user may want back, make sure its clip URLs are in a saved manifest (§9) — that is how
a previous version gets restored.

If one clip breaks, regenerate **that clip only** and re-send the list. Never re-run the sequence. Read
back with `get_timeline` before changing anything.

`set_timeline` already trims the duplicated first frame off every `frame`-seam chunk (it checks the two
frames actually match before trimming), so a seam that stutters is a camera or performance problem, not
a trim you owe.

**Watch the seams, not the clips.** When a join reads wrong, name which side is at fault: clip N still
moving at its last frame (§4), a character unaccounted for off-screen (§3), a beat that starts slack
because it was grafted onto a resolution (§5), or a scene boundary being forced to behave like a chain
(§0). And when a clip reads flat with nothing wrong at either seam, it is beat density (§5) — the script,
not the stitch.

## 8. Audio

`continue_video` generates audio on every chunk by default. For a diegetic piece keep it and describe
the same bed in every prompt — *"room tone, cutlery, low murmur, continuous with the previous shot"* —
and say **no music, no laugh track, no narration** so nothing tries to start a score mid-scene. For a
scored piece pass `generateAudio: false` on every chunk instead: a bed that restarts at each seam is
audible even when the picture joins cleanly.

For the score, call `generate_music` **once** for the whole runtime — a new track per clip is the fastest
way to make good clips sound like different films. `set_timeline` takes an `audio` list on up to eight
parallel tracks: the music bed on one track, voiceover (`generate_voiceover`) on another with
`startSeconds` to cut it to picture, and `volume` to duck the music (~0.25) under the spoken line. Every clip and bed is levelled to -16 LUFS on export; the in-app preview can only turn clips down, so a quiet clip previews quieter than it exports. Pass
`muteVideoAudio` when the clips' own sound would fight the bed.

## 9. Record the cut

Once the timeline is set, call `save_cut`: project slug, title, a couple of sentences of prose about what
the piece *looks like* (that sentence is what makes it findable a year later), the bible, and every clip
with its **exact prompt**, seam mode, reference URL and clip URL. Reuse the same `project` across related
cuts.

Before starting a follow-up, `list_cuts` for that project and read the manifest you're continuing from, so
the new work inherits the look instead of drifting.

## Reference: a scene that works

Seven clips, 35s, `h3-max`, 480p, 16:9. Kramer and an alien in a kitchen, Jerry walks in. Scene A is
clips 1–5 on `frame` seams; clip 6 is a scene break on `reference` (tailSeconds 3) to a wider setup;
clip 7 chains back on `frame` and resolves. Full prompts in `_cuts/seinfeld-alien/`. The shape — one beat
per clip, because these are 5-second clips of unhurried sitcom dialogue:

1. Two-shot, KRAMER LEFT / ALIEN RIGHT. **Kramer only**, leaning in, delighted — "So let me get this
   straight. You crossed nine galaxies — for a bagel."
2. **Alien only**, flat and matter-of-fact — "We heard things."
3. **Kramer only**, vindicated, yelling at the door — "JERRY! It's the bagels!"
4. Jerry enters from the LEFT edge, stops CENTRE; small pull back motivated by the third body.
   **Jerry only**, unfazed by the alien and annoyed only about the bagel — "That's my bagel."
5. **Alien only**, no apology in it — "There was no name on it."
6. ══ scene break, reference seam, wider ══ **Kramer only**, already mid-turn, siding with the alien —
   "He's got a point, Jerry. You never label anything."
7. **Jerry only**, already turning, defeated — "Fine. There's cream cheese in the fridge." Held reaction,
   full resolution.

Note what that costs: seven beats bought seven generations. **The same seven beats fit in two 15-second
clips** — four beats then three — for a quarter of the seams and none of the drift. Long chunks are the
better buy whenever the writing can fill them, which is exactly what §5 is about.

## Field notes (moved from memory 2026-09-01)

- **accent-drifts-across-chained-clips** — Accent drifts BETWEEN chunks of a chained piece even when the seam holds — Leo caught shots 1-2 of the Trove 30s reading American and shot 3 coming out Australian, because the voice block only said "a bright warm friendly adult". Fix: every chunk's voice block must name the accent AND spell out its mechanics (General American = hard rhotic R's, flat A's, no rising statement-intonation), say "it is the SAME voice as the previous shot and must not change", and negate every rival accent (Australian, British, Irish, South African, non-rhotic, changed voice). Do this on chunk 1, not just on the repair. Same lesson as albert-is-german-say-it-explicitly, but the failure mode here is inter-clip inconsistency, not a wrong default. Repair path worked: continue_video off the SAME source with the fixed prompt, then re-send the whole set_timeline list.
- **camera-motion-across-seams** — Settled rule after 4 tests on one Seinfeld scene: ONE small camera move per clip that STARTS AT REST and EASES TO A FULL STOP before the clip ends, final second held perfectly static. Vary the move between clips (tiny push, slight drift) so it isn't a repeating tic. Why: seam "frame" hands the next clip a still, which has no velocity — anything left mid-move gets re-invented and re-invention wobbles. Failures on the way: (v2) end mid-arc for the next clip to complete -> direction flipped; (v3) re-declare the vector harder with parallax language and six "not left" negatives -> WORSE, oscillated and morphed, and direction negatives summon what they name; (v4) fully locked-off -> stable but dead, user said too far. Add "camera still moving at the end of the shot" to negatives; never name camera directions there. Keep prompts lean, bloat feeds morphing. This kills the `bridge` skill's "end mid camera move so the next completes it" rule.
- **clip-pacing-and-extensions** — Beats go slack in a 5s clip when the camera-at-rest rule tempts you to spend the first 1.5s settling before anyone speaks — the line then lands at 4s with no room to breathe. Fix: state the budget in the prompt. "[NAME] is ALREADY mid-turn as the very first frame begins and the line starts immediately, in the first second — no pause, no settling. Finishes by the third second. The last two seconds are the reaction, held." The reaction IS the beat landing; a held stare after the line is the joke, before it is dead air. Camera move runs UNDER the dialogue, not before it. Negatives: pause before speaking, silence at the start of the clip, waiting to speak, slow start. Extension corollary the user hit: grafting clips onto a cut that already ended means extending from a full stop — the old "this is the end of the scene, held beat" clip has no forward pressure, so re-generate it without the resolution language and open the new clip with the character already in motion. Only the TRUE final clip gets a full resolution. Folded into `bridge` §5.
- **continue-video-aspect-ratio-trap** — continue_video's aspectRatio arg only sizes the canvas placeholder — the clip is supposed to follow the source. That holds for seam "frame" (the seed frame IS the geometry) but NOT for seam "reference": a 9:16 source with aspectRatio "9:16" passed explicitly came back 16:9. Reference mode gets tail seconds, not dimensions, and falls back to a landscape default. So any non-16:9 sequence must chain on FRAME seams until the app fixes geometry inheritance — which blocks making `reference` the default seam for 15s vertical work. Belt and braces when re-shooting: put "Vertical 9:16 portrait frame, tall and narrow" at the very top of the prompt and add "horizontal frame, widescreen, 16:9, letterbox, black bars, changing aspect ratio" to negatives. Worth passing to the user's other agent as a bug: reference-mode continuations should inherit source dimensions.
- **continuity-is-scene-scoped** — User's structural rule for long-form: continuity is a bridge between adjacent clips INSIDE a scene, never a through-path across the whole piece. Build as scenes of ~three 5s clips (~15s), chained with seam frame; between scenes, a hard cut started with a fresh generate_media call, continuity carried by story alone. Three clips is the natural scene length — two feels clipped, five sags as chain errors accumulate. Corollary they care about: never invent a diegetic event to justify a seam. Folded into the `bridge` skill (rewritten 2026-08-30) along with [[seam-mode-rule]], [[multi-person-continuity]] and [[camera-motion-across-seams]].
- **dont-let-a-walker-exit-frame-at-a-seam** — Two fixes for the same failure (weird motion across a frame seam when the subject is walking): (1) give them a DIEGETIC REASON TO STOP dead centre frame in the last 2s, state "THE FINAL SECONDS ARE COMPLETELY STATIC — she stands still in the CENTRE of frame and does NOT walk out of frame", and negate walking out of frame / leaving the frame / empty frame at the end. (2) BETTER when the brief needs speed: the Einstein SKID-STOP — she accelerates through the whole chunk, then something diegetic pulls her up short (the yarn thread snapping taut), she skids to a stop dead centre and the camera stops dead with her for the final second; the next chunk opens "she EXPLODES back into motion in the very first frame". Verified on the OurPwr felt running cut 2026-09-01 (2x10s 16:9 480p, continuation returned h3-max-i2v). Use (2) whenever Leo asks for the character to move faster or get away, since it satisfies "dials without stopping" and still gives a holdable seam.
- **medium-native-morph-transitions** — User asked for a "seamless transition" across a total location change (clay Oval Office -> alien planet) after a reference-seam cut read as too abrupt. Fix that worked: seam "frame" plus a three-second in-camera MORPH written into the top of the prompt — the plasticine set stretches and pulls apart into the new location while both characters hold their screen sides, "no cut, no fade, no black frame, one unbroken clay morph", with hard cut / jump cut / dissolve / crossfade / fade to black / characters disappearing during the transition in negatives. Key distinction for the `bridge` skill: a medium-native transformation (clay morphing, felt seams unpicking, paper pages turning, 2D cel) is NOT an invented diegetic event — it is the material behaving as the material does, so it does not violate the rule against writing story around the stitching mechanism. Does not transfer to live action, where a location change needs a real cut. Cost: the morph eats 3 of 15 seconds, so write that scene as three beats, not four squeezed.
- **motion-continuity-frame-seam** — Camera direction flips at a frame seam because seam "frame" hands the next clip a STILL — no velocity — so the model re-derives a move and usually picks the one that resettles the composition, i.e. the reverse. Motion continuity is the prompt's job. Five rules: (1) MOTION BLOCK first, before look and subjects, restated verbatim every chunk — one direction, constant speed and height; (2) state the PARALLAX not just the verb ("subjects slide LEFT across frame"), the model renders parallax; (3) declare the move ALREADY IN PROGRESS ("the camera is mid-arc and CONTINUES arcing right") or it reads as an instruction to start one; (4) ONE move type for the whole chain — never arc-then-push at a seam, decelerate only in the final second of the final clip; (5) compositions are PASSED THROUGH, never "settled into" — "settles" makes it decelerate then invent a new move. Negatives: camera reversing/changing direction, panning left, drifting left, stopping, slowing, settling, static locked-off camera, push in, zoom. Blocking trick: a continuous orbit round a two-person table completes into the reverse OTS, so one vector delivers all the coverage.
- **multi-person-continuity** — Characters teleport across chained clips because off-screen geography is geography the model invents. Four fixes, restate verbatim in every chunk: (1) a caps SEATING CHART naming each character's SCREEN side (left/right of frame, not world side) plus the negative "never swaps seats, never crosses the table"; (2) design the camera move so the silent character stays physically in frame — arc BEHIND them into an over-the-shoulder, a visible character can't be relocated; (3) give every exit from frame a stated route ("slides off the left edge as the shot tightens — he does not disappear"); (4) ONE SPEAKER declared in caps with an acting note on HOW they talk, the silent one described as silent AND located. Negatives: characters swapping seats, wrong side of the table, X vanishing, X reappearing, anyone teleporting, empty booth.
- **name-the-voice-gender-not-just-accent** — H3 drifts on BOTH gender and accent across chained clips, and patching only the drifting chunk never holds — Leo's verdict on the Trove explainer after two shot-3 repairs was "It's cooked. You've gotta send the whole video again." So: when the voice is wrong anywhere in a chain, REGENERATE THE WHOLE CHAIN with one identical voice block, don't repair the tail. The block must state gender AND accent explicitly and phonetically, e.g. "ONE voice only, and it is a WOMAN — clearly, unmistakably female, adult in her early thirties; her accent is AUSTRALIAN, NON-RHOTIC (R dropped in 'never', 'your'), 'nice'=NOICE, 'day'=DIE, 'you'='ya', statements rising at the end" + "the SAME voice as the previous shots, it must not change". Negatives must carry male voice / man's voice / deep voice / masculine voice AND every rival accent including American, General American, rhotic R.
- **script-first-not-voice-first** — When a chained explainer loses its NARRATIVE, the cause is prompt weighting, not the script: I front-loaded three paragraphs of voice/accent spec ahead of a three-line script and H3 delivered the accent and dropped the story. Fix that worked on the Trove 30s: put the arc FIRST — a one-line "PART N OF THREE, part one answered X, this clip answers Y and ends on the setup for Z" header, then THE SCRIPT with timecodes, then ONE short hard voice paragraph, then style/environment/camera. Also pin visual beats to specific words ("the card appears exactly on the word 'Tangle'", fist on "grit", spark on "wit") so the animation serves the sentence. Negatives should include skipped lines, unspoken dialogue, improvised extra lines. Pair with [[name-the-voice-gender-not-just-accent]] — that note says WHAT the voice block must contain, this one says it must be short and come after the script.
- **seam-mode-rule** — Seam modes are a choice, not a quality ladder. frame -> h3-max-i2v, starts on the previous clip's exact final frame. reference (tailSeconds 3) -> h3-max-r2v, carries look/faces/motion but not the frame and NOT the dimensions. At 5s clips, frame is the workhorse (a scene is ~3 clips chained) and reference is the exception for scene breaks. At 15s clips this INVERTS: the chunk boundary IS the scene boundary, each clip holds a full four-beat scene, so reference is the default and the join reads as an honest cut. In reference continuations, open with "A NEW SHOT — cut to a completely different camera angle. This is a fresh setup, not a continuation of the previous camera position," or the model resumes the old camera; name every off-camera character in negatives as not speaking and not in frame. AMENDED 2026-08-30: the old flat ban on inventing a diegetic event to justify a seam is now conditional. The ban is against inventing one to HIDE a seam you did not want — writing the story around the stitching mechanism. But when the user explicitly asks for a SEAMLESS transition (they called a reference-seam location change "a bit abrupt" on America World), a frame seam plus an in-world transformation is exactly the answer, and the transformation should be the best beat in the clip. Recipe that worked: open on the old location, play one beat there, then morph the SET around the characters — walls peeling like putty, desk flattening into ground, ceiling opening onto sky — with the caps geography chart restated as holding THROUGH the location change, plus negatives "cut to a new shot, hard cut, scene change". A frame seam carries a total location change fine at 15s: the seed frame pins the sculpts and geometry, the prompt is free to rebuild everything behind them.
- **seedance-chains-via-continue-video** — continue_video accepts model 'seedance-2.5' as well as h3-max — chunks 4-30s, up to 1080p, both seam modes. I wrongly told Leo Seedance had no continuation path and shot three unchained t2v clips; he caught it. Verified 2026-08-31: both continuations returned seedance-2.5-i2v on frame seams. Also price-check before a resolution bump — Seedance is ~$4.62/10s at 720p vs ~$0.69 at 480p, a 6x jump worth stating in one line before shooting.
- **image-refs-dropped-on-bridge** — CORRECTED 2026-09-01: relative /uploads/... urls DO work in referenceUrls now — verified in the OurPwr session, a relative seedream image path returned h3-max-i2v. So stop telling the user absolute http://127.0.0.1:<port>/ urls are required; either form works. What still matters: (1) auto-attachment only covers the message the reference arrived in, so re-pass the url on every follow-up generation, and (2) ALWAYS read the returned model string on the first generation of a pipeline and say so immediately if it reads -t2i/-t2v instead of -i2v/-r2v. Also confirmed: frame seams via continue_video work fine on 9:16 — it is only the 'reference' seam mode that can't inherit aspect. Never tell Leo 9:16 can't chain.
- **two-clip-action-must-chain** — If Leo asks for a TEN-SECOND clip and I deliver it as two 5s shots, they must be CHAINED with continue_video on a frame seam, not two independent t2v generations hard-cut together — he pushed back with "I asked for a 10-second clip, not two... if you're gonna use two 5-second clips, use your bridge skill." The action skill's cut-it-on-the-timeline rule does NOT override bridge when the user named a single runtime. Recipe that worked: shot 1 written so the attacker LANDS among the wreckage and Bruce drops into a held guard, camera stopping dead, final second completely static (the skid-stop trick from [[skid-stop-seam-for-action-chains]] applied to a fight rather than a chase); shot 2 opens "both men are ALREADY exploding back into motion in the very first frame" and carries the bible verbatim. 9:16 forces frame seams throughout. Returned h3-max-i2v, so the seam held.
- **h3-holds-four-beats-per-clip** — One H3 Max t2v generation reliably executes about FOUR beats, whatever the timecode chart says. I tried to fit the whole OurPwr narrative — catcall, look back, speed up, button press, two friends arriving, end card — into a single 15s clip twice and both failed the same way: it spent the runtime on the opening and never reached the friends or the end card, and tightening the timings to seven even 2s beats made it WORSE (denser prompt, harder push on the opening, cruder animation). Negatives cannot enforce narrative — "the friends arriving late, no end card" did nothing. When Leo asks for a single 15s clip carrying a full arc, still deliver 15s but build it as 8s + 7s chained on a frame seam so the payoff gets its own generation; say in one line why. Verified 2026-09-01.
- **albert-is-german-say-it-explicitly** — Leo caught that a clay-Einstein character has to sound German — "warm German accent" alone was drifting. Spell the accent out phonetically in the voice block: THICK, unmistakable GERMAN ACCENT, rolling r's, hard consonants, "v" for "w", a delighted old professor from Ulm, and put American accent / British accent / neutral accent / English accent in the negatives. Generalise: whenever a character has a nationality, describe the accent's mechanics rather than naming it once, since H3 defaults toward neutral American.
- **no-tts-tool-vo-is-baked-in** — CORRECTED 2026-09-01: there IS now a `generate_voiceover` tool (minimax-tts) over the bridge — it returns an audio URL you lay on its own set_timeline audio TRACK. So a VO no longer has to be baked into H3 prompts. The working assembly for a narrated piece: generate clips with generateAudio false, muteVideoAudio true, then audio: [music on track 0 at ~0.3, VO on track 1 at 1.0], both startSeconds 0. Voices are a fixed enum (Determined_Man, Wise_Woman, Elegant_Man, Deep_Voice_Man, Calm_Woman...) with speed and emotion args — no accent control, so the old no-American-accents preference can't be steered here; pick the voice by character instead. Bake VO into the H3 prompt ONLY when the narration has to lip-sync or come from an on-screen character.
