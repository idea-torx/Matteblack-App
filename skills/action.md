---
name: Action — hits that land, cuts that move
description: Make fight scenes, chases and stunts read as ACTION instead of interpretive dance — fixes punches that don't land, flat pacing, held wides and goofy invented choreography. Use with cinematographer + realism + bridge on any action beat.
---

# Action — hits that land, cuts that move

Action fails differently from drama, and it fails for one root reason: the model is asked to be the
fight choreographer, the stunt team AND the editor at once. It is terrible at all three. This skill
takes those jobs back. `cinematographer` still owns lens and light, `realism` still owns weight and
skin, `bridge` still owns seams — this owns the violence.

## 0. Action is made in the edit — the one rule over all others

Real screen fights are 2–4 second shots cut together. Nobody holds a shot through a whole exchange.
So: **generate action as 5-second single-beat clips and cut them on the timeline.** Never ask for a
10s or 15s fight in one call — that is where invented wushu, dropped beats and held wides all come
from. The edit rhythm your reference movies have IS the trim: cut into each clip late (the wind-up is
already moving on frame one) and cut out on the impact, not after it. A 5s clip often yields 2–3
usable seconds; that is success, not waste.

## 1. One exchange per clip, written as cause → contact → consequence

"They fight" is how you get dance. Every clip gets exactly ONE exchange, written in three parts:

```
[ATTACK: named move, named side] — [CONTACT: where it lands] — [CONSEQUENCE: what the impact does]
```

"He throws a short right cross — it catches her jaw — her head snaps sideways and she staggers two
steps into the shelving, bottles crashing down."

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
ONE two-second pause at the turn (the moment it could go either way — this pause is what makes the
finish read as fast), then the final exchange in the tightest, shortest cuts of the sequence. If
every shot is fast, none are.

## 4. Damage persists

The wooden reset — pristine fighters in every clip — breaks a sequence faster than any bad punch.
Carry the consequences forward in every subsequent prompt, in the subject lock itself: "his lip
split and bleeding, shirt torn at the shoulder, favouring his left leg". Each clip's damage is the
previous clip's consequence written into the character. This costs one clause and is the single
biggest realism win in a fight.

## 5. Physics — the anti-goofy block (paste into every action prompt)

`realism`'s weight paragraph, sharpened for combat:

```
Every strike travels a short, direct line with full body weight behind it — no spinning, no flips,
no windmilling arms, no martial-arts flourishes unless named. Hits connect with visible impact:
the receiving body absorbs, buckles or is displaced. Both fighters are heavy: they tire, they
stumble, they grab and hold as much as they swing, footwork is small and ugly. Struck objects
break, slide or fall and stay where they land. All motion at true speed.
```

Real fights are graceless. Every degree of elegance you allow is a degree of goofy you get back.

## 6. Camera during action

One camera behavior per clip, and it must be motivated: locked-off for geography, handheld with
tight sway for exchanges (name it: "handheld, close, unsteady"), a fast pan only when it FOLLOWS a
body being displaced. The camera never orbits, never floats through the fight, never does its own
stunt — unmotivated camera motion during an exchange is the second biggest goofy source after
unnamed moves. Screen direction holds across cuts (`bridge` rule): whoever attacks left-to-right
keeps attacking left-to-right until the turn, and the turn is exactly when you're allowed to flip it.

## 7. Sound

Impacts land in the ear more than the eye: one dry, close body-hit sound per contact, breath and
effort between them, environment debris where the consequence says so. No music unless the sequence
has one — and if it does, it ducks under every impact. A held sound-scape of grunts with no clean
hits is a reroll.

## 8. Forbidden throughout

```
Negative prompt: martial arts flourishes, spinning kicks, backflips, wire-work, windmilling arms,
dance-like choreography, punches stopping short of contact, no-contact hits, slow motion, speed
ramps, floaty weightless bodies, rubber limbs, morphing hands, teleporting fighters, orbiting
camera, camera flythrough, pristine undamaged fighters after hits, objects resetting, held wide
shot during impact, squaring up, circling before the fight.
```

Trim "slow motion" only if one beat is deliberately slo-mo — never trim the contact or physics lines.

## 9. Reroll economics

A 5s clip is ~17s to make. A clip where the punch misses, the move got fancy, or a fighter healed is
a REROLL, not an edit note — but check first whether the fix is actually a missing close-up (§2) or
a missing consequence clause (§1), because those are prompt bugs and will fail identically on every
reroll. Assemble with `set_timeline`, trims doing the pacing (§3), and `save_cut` the sequence with
every clip's exchange line so the next fight in this world inherits the grammar.
