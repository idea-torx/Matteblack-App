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
