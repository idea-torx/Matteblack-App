/** Durations seedance-2.5 accepts, in seconds. Mirrors the list in MakePanel. */
const SEEDANCE_25_DURATIONS = [4, 6, 8, 10, 15, 20, 25, 30];

/**
 * Playblast length in seconds, snapped to the nearest duration seedance-2.5
 * offers. Blender metadata is untrusted (it round-trips through the canvas), so
 * anything unusable falls back to 24 fps / the shortest allowed clip.
 */
export function directionDuration(frameRange: unknown, fps: unknown): string {
  const rate = typeof fps === "number" && fps > 0 ? fps : 24;
  const range = Array.isArray(frameRange) ? frameRange.map(Number) : [];
  const seconds = range.length === 2 && range.every(Number.isFinite)
    ? Math.round((range[1] - range[0] + 1) / rate)
    : 0;
  const nearest = SEEDANCE_25_DURATIONS.reduce((best, d) =>
    Math.abs(d - seconds) < Math.abs(best - seconds) ? d : best);
  return String(nearest);
}
