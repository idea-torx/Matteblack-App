/**
 * Self-check for track mute in the export.
 * Run: `npx tsx src/features/cinema-frame/helpers/buildFFmpegCommand.test.ts`
 *
 * The case that matters is the MIRROR clip: a video dropped on the timeline
 * also creates a linked clip on the audio track carrying that video's own
 * audio. Muting the video track has to drop that too, or the sound comes back
 * in through the side door and the mute is audible in the preview but not in
 * the file.
 */
import assert from "node:assert/strict";
import { buildFFmpegCommand } from "./buildFFmpegCommand.js";
import type { TimelineState, TimelineClip } from "./timelineState.js";

const clip = (id: string, extra: Partial<TimelineClip> = {}): TimelineClip =>
  ({
    id,
    type: "video",
    sourceUrl: `/uploads/${id}.mp4`,
    startOffset: 0,
    duration: 5,
    trimStart: 0,
    trimEnd: 0,
    volume: 1,
    ...extra,
  }) as TimelineClip;

const state = (videoMuted: boolean, musicMuted = false): TimelineState =>
  ({
    tracks: [
      { id: "v1", type: "video", muted: videoMuted, clips: [clip("vid")] },
      {
        id: "a1",
        type: "audio",
        muted: musicMuted,
        clips: [
          clip("mirror", { type: "audio", linkedClipId: "vid" }),
          clip("music", { type: "audio" }),
        ],
      },
    ],
    playheadPosition: 0,
    zoomLevel: 1,
    magneticSnap: true,
    looping: false,
  }) as TimelineState;

const files = new Map([
  ["vid", "vid.mp4"],
  ["mirror", "vid.mp4"],
  ["music", "music.mp3"],
]);
const info = new Map([
  ["vid", { hasAudio: true, isH264: true }],
  ["mirror", { hasAudio: true, isH264: true }],
  ["music", { hasAudio: true, isH264: false }],
]);
const cfg = { resolution: "source" as const, includeAudio: true, filename: "out.mp4" };
const run = (s: TimelineState) => buildFFmpegCommand(s, files, cfg, 5, info).args.join(" ");

// Unmuted: both the video's own audio and the music bed are inputs.
const open = run(state(false));
assert.ok(open.includes("music.mp3"), "music bed must be in the unmuted mix");
assert.ok(open.includes("vid.mp4"), "picture is always an input");

// Muted video track: picture stays, music stays, the mirror is gone.
// vid.mp4 appears exactly once (as picture) instead of twice.
const muted = run(state(true));
assert.ok(muted.includes("music.mp3"), "muting picture must not silence the music bed");
assert.ok(muted.includes("vid.mp4"), "muted track still renders picture");
assert.equal(
  (open.match(/vid\.mp4/g) ?? []).length - (muted.match(/vid\.mp4/g) ?? []).length,
  1,
  "muting the video track must drop exactly one vid.mp4 input — the mirror clip",
);

// And muting the audio track drops the music without touching picture.
const noMusic = run(state(false, true));
assert.ok(!noMusic.includes("music.mp3"), "muted audio track contributes nothing");
assert.ok(noMusic.includes("vid.mp4"), "picture unaffected by an audio-track mute");

console.log("buildFFmpegCommand: all checks passed");

// An image clip (end card) is looped into the picture chain, not dropped.
{
  const st = {
    ...state(false),
    tracks: [{ id: "v1", type: "video", muted: false, clips: [clip("vid"), clip("card", { type: "image", sourceUrl: "/uploads/card.png", startOffset: 5, duration: 3 })] }],
  } as TimelineState;
  const f = new Map([["vid", "vid.mp4"], ["card", "card.png"]]);
  const out = buildFFmpegCommand(st, f, cfg, 8, info).args.join(" ");
  assert.match(out, /-loop 1 -framerate 30 -t 3\.0000 -i card\.png/, "image looped as input");
  assert.match(out, /concat=n=2/, "image joins concat");
  assert.doesNotMatch(out, /color=c=black/, "no black gap where the card sits");
  console.log("image clip export: ok");
}
