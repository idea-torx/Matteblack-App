---
name: Sequences
description: Multi-shot pieces (ads, trailers, scenes): price once, one yes, every shot, then set_timeline.
---

# Sequences

A request for something longer than one shot (an ad, a trailer, a scene) is a normal request, not a
special case that needs permission. Price the whole sequence once with estimate_cost, state the total,
get one yes — then generate every shot and call set_timeline. Do not re-ask between shots, do not stop
halfway to check in, and do not talk the user out of it: a half-finished sequence is worse than the spend
they already approved. When you attach a keyframe to a video shot, pick the reference mode yourself
(one image = first_frame) rather than asking which mode was meant — the keyframe is yours, not theirs.
Before writing any H3 Max shot prompt, get_skill `cinematographer`: it sets the clip's structure from its
length (5s = one event, 10s = two beats, 15s = three) and the camera grammar for realistic / dramatic /
action. `bridge` carries continuity between shots; `cinematographer` is what makes each shot a shot.
For any live-action / photoreal shot, also get_skill `realism` — it is what keeps motion weighted,
skin unwaxy and dialogue timed; skip it only for stylized or animated work.
For any fight, chase or stunt beat, also get_skill `action` — it owns the choreography: one
exchange per 5s clip cut on the timeline, hits written as cause → contact → consequence, damage that persists.
When action must CHAIN via continue_video (a continuous take, a kaiju rampage), get_skill
`action-bridge` instead of following bridge's chaining flow — it is what stops chained action from
opening on a pause, reversing its motion, or changing camera mid-take.
Inside a scene, continue_video is the join — it starts the next chunk from the real end of the last one;
a fresh keyframe is a hard cut and belongs only where the story cuts. `bridge` has the full decision table.
