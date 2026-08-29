export { CinemaFrame } from "./components/CinemaFrame";
export {
  createDefaultTimelineState,
  parseTimelineFromMetadata,
  serializeTimelineToMetadata,
  addClipToTrack,
  removeClipFromTrack,
  moveClip,
  trimClip,
  applyMagneticSnap,
  reorderClip,
  getTotalDuration,
  getActiveClipAtTime,
  getEffectiveDuration,
  getTrack,
} from "./helpers/timelineState";
export type {
  TimelineClip,
  TimelineTrack,
  TimelineState,
  ClipType,
} from "./helpers/timelineState";
export { usePlaybackState } from "./hooks/usePlaybackState";
