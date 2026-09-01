---
name: Action — hits that land, cuts that move
description: Make fight scenes, chases and stunts read as ACTION instead of interpretive dance — fixes punches that don't land, flat pacing, held wides and goofy invented choreography. Use with cinematographer + realism + bridge on any action beat.
---

# Action — hits that land, cuts that move

Action fails differently from drama, and it fails for one root reason: the model is asked to be the
fight choreographer, the stunt team AND the editor at once. It is terrible at all three. This skill
takes those jobs back. `cinematographer` still owns lens and light, `realism` still owns weight and
skin, `bridge` still owns seams — this owns the violence.

The house style is John Wick, not a bar brawl: trained fighters, brutally fast, ruthlessly economical.
Speed is the default register of every clip — fast strikes, fast footwork, fast camera — and the hits
still land with full weight. Fast and weightless is the failure; fast and heavy is the style.

## 0. Action is made in the edit — the one rule over all others

Real screen fights are 2–4 second shots cut together. Nobody holds a shot through a whole exchange.
So: **generate action as 5-second single-beat clips and cut them on the timeline.** Never ask for a
10s or 15s fight in one call — that is where invented wushu, dropped beats and held wides all come
from. The edit rhythm your reference movies have IS the trim: cut into each clip late (the strike is
already travelling on frame one) and cut out on the impact, not after it. Target trims of 1–2 seconds
per shot in the assembled sequence — a 5s clip yielding one blistering 90-frame exchange is success,
not waste.

## 1. One exchange per clip, written as cause → contact → consequence

"They fight" is how you get dance. Every clip gets exactly ONE exchange — a single fast combination,
up to three contacts in one unbroken chain — written in three parts:

```
[ATTACK: named moves, named sides, at full speed] — [CONTACT: where each lands] — [CONSEQUENCE]
```

"He fires a jab-cross-elbow in one fast chain — the jab snaps her head back, the cross catches her
jaw, the elbow drops her sideways into the shelving, bottles crashing down." No pause between
strikes, no telegraphed wind-up: the combination is one continuous burst.

The consequence is what makes the punch land. Models fudge the contact frame; they cannot fudge a
head snapping back, a body hitting a table, dust off a jacket. **Spend your words on the result of
the hit, not the hit.** If the consequence is missing from the prompt, the punch will stop short on
screen every time.

Name real moves — a jab, a shove against the wall, a leg sweep, a tackle through the door. Never
"attacks him", never "an impressive move". Unnamed action is where the goofy comes from.

## 2. Coverage — which shot size holds which beat

The wrong shot held too long is a coverage error. Each beat type has a size; alternate sizes every
cut or the sequence flatlines:

| Beat | Shot | Why |
|---|---|---|
| Geography — who is where, what's between them | Wide, once, early | Without it no hit has stakes; with more than one the pace dies |
| The exchange | Medium / medium-close, 35–50mm | Both bodies in frame so the contact is provable |
| The impact | Close-up ON THE RECEIVER | The hit lands in the reactee's face and body, not the puncher's |
| The detail | Insert, 1–2s — the grabbed bottle, the slipping grip | Cheap tension, resets the eye between exchanges |
| The turn | Medium-wide | The moment the fight changes direction gets one breath of room |

Rule of thumb for the cut: wide → medium → close → insert → medium… never two of the same size in a
row, and never a wide during an impact. Reaction close-ups are the cheapest clips you'll generate and
they do the most work — when a hit doesn't sell, add the receiver's close-up after it, don't reroll
the hit.

## 3. Pacing — the escalation curve

A sequence has a shape, not a speed. Build it on the timeline as: **in fast, one breath, finish
faster.** Open mid-action (first clip starts with the first attack already travelling — no squaring
up, no circling), cut quickening through the exchanges (trim each clip shorter than the last), give
ONE beat of stillness at the turn — a single breath, not a rest (the moment it could go either way;
this one pause is what makes everything around it read as fast) — then the final exchange in the
tightest, shortest cuts of the sequence. Even at maximum tempo the sequence needs that one anchor:
if literally every frame is fast, the eye stops registering speed.

## 4. Damage persists

The wooden reset — pristine fighters in every clip — breaks a sequence faster than any bad punch.
Carry the consequences forward in every subsequent prompt, in the subject lock itself: "his lip
split and bleeding, shirt torn at the shoulder, favouring his left leg". Each clip's damage is the
previous clip's consequence written into the character. This costs one clause and is the single
biggest realism win in a fight.

## 5. Physics — the anti-goofy block (paste into every action prompt)

`realism`'s weight paragraph, sharpened for combat:

```
Both fighters are trained and brutally fast: every strike travels a short, direct line at full
speed with full body weight behind it — no telegraphed wind-ups, no pauses between strikes, no
spinning, no flips, no windmilling arms, no flourishes. Combinations chain without gaps. Hits
connect with visible impact: the receiving body absorbs, buckles or is displaced hard. Footwork is
fast and economical; they grab, throw and slam as much as they punch. Struck objects break, slide
or fall and stay where they land. All motion at true speed — the speed IS real time, never a ramp.
```

The style is precision at speed, not brawling: economy is what separates fast from flailing. Every
flourish you allow is a degree of goofy you get back; every pause you allow is tempo lost.

## 6. Camera during action

One camera behavior per clip, and it must be motivated — but at this tempo the camera is athletic:
a fast whip pan following a thrown body, a hard fast push-in on an exchange, a fast lateral track
matching the fighters' movement. Name the speed ("fast whip pan", "rapid push-in") or H3 gives you a
drift. Locked-off is for the geography wide only; everything else moves fast WITH the action. The
camera still never orbits, never floats, never does its own stunt — unmotivated camera motion during an exchange is the second biggest goofy source after
unnamed moves. Screen direction holds across cuts (`bridge` rule): whoever attacks left-to-right
keeps attacking left-to-right until the turn, and the turn is exactly when you're allowed to flip it.

## 7. Sound

Impacts land in the ear more than the eye: one dry, close body-hit sound per contact, breath and
effort between them, environment debris where the consequence says so. No music unless the sequence
has one — and if it does, it ducks under every impact. A held sound-scape of grunts with no clean
hits is a reroll.

## 8. Forbidden throughout

```
Negative prompt: telegraphed wind-ups, pauses between strikes, fighters waiting their turn,
martial arts flourishes, spinning kicks, backflips, wire-work, windmilling arms,
dance-like choreography, punches stopping short of contact, no-contact hits, slow motion, speed
ramps, floaty weightless bodies, rubber limbs, morphing hands, teleporting fighters, orbiting
camera, camera flythrough, pristine undamaged fighters after hits, objects resetting, held wide
shot during impact, squaring up, circling before the fight.
```

Trim "slow motion" only if one beat is deliberately slo-mo — never trim the contact or physics lines.

## 9. A worked sequence — imitate this shape

Six clips, one fight: a man (gray suit, cropped dark hair) versus a taller attacker (black bomber
jacket) in a narrow hotel corridor. Every clip 5s, 768p, 16:9, same grade line throughout ("clean
digital, cool highlights, heavy blacks, high shutter speed, crisp motion"). Physics block (§5) and
negative block (§8) appended to every prompt — omitted below only to keep this readable.

1. **Geography wide, 24mm, locked-off.** "Wide shot down a narrow hotel corridor, warm sconce light,
   a man in a gray suit walks toward camera as a taller man in a black bomber steps out of a doorway
   ten feet ahead, dropping a keycard. Both go still for half a beat." → trim to 2.0s.
2. **Medium, 35mm, fast lateral track.** "The bomber lunges with a fast right haymaker — the suited
   man slips inside it and fires a jab-cross in one chain, the jab snapping the bomber's head back,
   the cross bouncing his shoulder off the corridor wall, a sconce shattering. Camera tracks fast
   left with the movement." → trim to 1.5s, cut on the wall hit.
3. **Close-up ON THE BOMBER, 85mm.** "Close-up: the bomber's head snaps sideways from the impact,
   blood at his lip, a wall sconce swinging broken behind him. He catches himself on the wallpaper,
   tearing it." → trim to 1.0s.
4. **Insert, 1s.** "Insert: the suited man's hand snatches the fallen keycard lanyard off the floor
   mid-stride and wraps it around his fist." → trim to 1.0s.
5. **THE TURN — medium-wide, one breath.** "Medium-wide: both men square for half a second in the
   wrecked corridor, breathing hard — the bomber bleeding from the lip, the suited man's jacket torn
   at the shoulder — then the bomber charges." → trim to 2.0s, the sequence's only pause.
6. **Finish — medium, 35mm, rapid push-in.** "The bomber charges — the suited man sidesteps and
   drives him face-first into the doorframe with the lanyard-wrapped fist, elbow, then a knee, one
   unbroken chain; the bomber drops and stays down against the door. Camera pushes in fast on the
   impact." → trim to 1.5s.

~9 seconds assembled from 30 generated. Note what the shape does: sizes alternate every cut, the
receiver owns the impact close-up, damage from clip 2 is worn in clips 3 and 5, the single pause
sits at the turn, and the finish is the fastest cut in the piece. Steal the shape, replace the
corridor.

## 10. Seams — when the fight is one continuing take

The default is hard cuts (§0): separate clips, trimmed. When a take must genuinely continue via
`continue_video`, action INVERTS `bridge`'s end-on-a-holdable-pose rule — asked for a rest frame, the
model knocks a fighter down and the next chunk wastes its opening on him getting up. Instead:
`seam='reference'` on every intra-fight join, end every chunk on a motion still in flight ("END ON:
his cross still travelling"), open the next chunk by completing it, and never end a chunk on a fall or
a stagger unless it is the finish. Full rules in `bridge`. Whatever the seam, trim its dead frames out
on the timeline.

## 11. Reroll economics

A 5s clip is ~17s to make. A clip where the punch misses, the move got fancy, a fighter healed, or
the exchange plays slower than real time is a REROLL, not an edit note — but check first whether the fix is actually a missing close-up (§2) or
a missing consequence clause (§1), because those are prompt bugs and will fail identically on every
reroll. Assemble with `set_timeline`, trims doing the pacing (§3), and `save_cut` the sequence with
every clip's exchange line so the next fight in this world inherits the grammar.
