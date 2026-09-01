function generateId(): string {
  return crypto.randomUUID();
}

export type ClipType = "video" | "image" | "audio";

export type IncomingDragPreview = {
  draggedNodeId: string;
  src: string;
  mediaType: "image" | "video" | "audio";
  label?: string;
  duration?: number;
  screenX?: number;
  screenY?: number;
};

export type TimelineClip = {
  id: string;
  sourceNodeId: string;
  src: string;
  type: ClipType;
  duration: number;
  startOffset: number;
  label?: string;
  trimStart: number;
  trimEnd: number;
  volume: number;
  linkedClipId?: string;
};

export type TimelineTrack = {
  id: string;
  type: "video" | "audio";
  clips: TimelineClip[];
  /** Silence every clip on this track without touching their own volumes, so
   *  unmuting restores the mix the user set. The common case is muting V1 so a
   *  music bed on A1 plays under the picture instead of fighting the dialogue
   *  and room tone baked into generated clips. */
  muted?: boolean;
};

export type TimelineState = {
  tracks: TimelineTrack[];
  playheadPosition: number;
  zoomLevel: number;
  magneticSnap: boolean;
  looping: boolean;
};

export function createDefaultTimelineState(): TimelineState {
  return {
    tracks: [
      { id: generateId(), type: "video", clips: [] },
      { id: generateId(), type: "audio", clips: [] },
    ],
    playheadPosition: 0,
    zoomLevel: 0.15,
    magneticSnap: true,
    looping: false,
  };
}

export function getTrack(state: TimelineState, trackType: "video" | "audio"): TimelineTrack {
  return state.tracks.find((t) => t.type === trackType) || state.tracks[0];
}

export function getTrackById(state: TimelineState, trackId: string): TimelineTrack | undefined {
  return state.tracks.find((t) => t.id === trackId);
}

export function getEffectiveDuration(clip: TimelineClip): number {
  return clip.duration - clip.trimStart - clip.trimEnd;
}

export function addTrack(state: TimelineState, trackType: "video" | "audio"): TimelineState {
  const id = generateId();
  const newTrack: TimelineTrack = { id, type: trackType, clips: [] };
  const videoTracks = state.tracks.filter((t) => t.type === "video");
  const audioTracks = state.tracks.filter((t) => t.type === "audio");
  if (trackType === "video") {
    return { ...state, tracks: [...videoTracks, newTrack, ...audioTracks] };
  }
  return { ...state, tracks: [...videoTracks, ...audioTracks, newTrack] };
}

export function removeTrack(state: TimelineState, trackId: string): TimelineState {
  const track = getTrackById(state, trackId);
  if (!track) return state;
  const sameType = state.tracks.filter((t) => t.type === track.type);
  if (sameType.length <= 1) return state;

  const linkedIdsToRemove = new Set(
    track.clips.filter((c) => c.linkedClipId).map((c) => c.linkedClipId!)
  );

  const tracks = state.tracks
    .filter((t) => t.id !== trackId)
    .map((t) => {
      if (linkedIdsToRemove.size === 0) return t;
      const filtered = t.clips.filter((c) => !linkedIdsToRemove.has(c.id));
      return filtered.length !== t.clips.length ? { ...t, clips: filtered } : t;
    });

  return { ...state, tracks };
}

export function addClipToTrack(
  state: TimelineState,
  trackId: string,
  clip: Omit<TimelineClip, "startOffset" | "trimStart" | "trimEnd" | "volume">,
  dropTime?: number
): TimelineState {
  const tracks = state.tracks.map((track) => {
    if (track.id !== trackId) return track;
    let startOffset: number;
    if (typeof dropTime === "number" && dropTime >= 0) {
      const dur = clip.duration || 3;
      startOffset = resolveOverlap(track.clips, Math.max(0, dropTime), dur, clip.id);
    } else {
      const lastClip = track.clips[track.clips.length - 1];
      startOffset = lastClip ? lastClip.startOffset + getEffectiveDuration(lastClip) : 0;
    }
    const newClips = [...track.clips, { ...clip, startOffset, trimStart: 0, trimEnd: 0, volume: 1 }]
      .sort((a, b) => a.startOffset - b.startOffset);
    return { ...track, clips: newClips };
  });
  return { ...state, tracks };
}

export function addVideoWithLinkedAudio(
  state: TimelineState,
  videoTrackId: string,
  videoClip: Omit<TimelineClip, "startOffset" | "trimStart" | "trimEnd" | "volume">,
  audioClipId: string,
  dropTime?: number
): TimelineState {
  const videoTrack = getTrackById(state, videoTrackId);
  if (!videoTrack) return state;
  let startOffset: number;
  if (typeof dropTime === "number" && dropTime >= 0) {
    const dur = videoClip.duration || 3;
    startOffset = resolveOverlap(videoTrack.clips, Math.max(0, dropTime), dur, videoClip.id);
  } else {
    const lastVideoClip = videoTrack.clips[videoTrack.clips.length - 1];
    startOffset = lastVideoClip ? lastVideoClip.startOffset + getEffectiveDuration(lastVideoClip) : 0;
  }

  // A generated id with no matching track silently dropped the mirror clip —
  // the drop looked fine and the sound was simply gone. Create the track.
  const audioTrack = state.tracks.find((t) => t.type === "audio");
  const audioTrackId = audioTrack?.id || generateId();
  const tracksWithAudio = audioTrack
    ? state.tracks
    : [...state.tracks, { id: audioTrackId, type: "audio" as const, clips: [] }];

  const linkedVideoClip: TimelineClip = {
    ...videoClip,
    startOffset,
    trimStart: 0,
    trimEnd: 0,
    volume: 1,
    linkedClipId: audioClipId,
  };

  const linkedAudioClip: TimelineClip = {
    id: audioClipId,
    sourceNodeId: videoClip.sourceNodeId,
    src: videoClip.src,
    type: "audio",
    duration: videoClip.duration,
    startOffset,
    trimStart: 0,
    trimEnd: 0,
    volume: 1,
    label: videoClip.label,
    linkedClipId: videoClip.id,
  };

  const tracks = tracksWithAudio.map((track) => {
    if (track.id === videoTrackId) {
      return { ...track, clips: [...track.clips, linkedVideoClip].sort((a, b) => a.startOffset - b.startOffset) };
    }
    if (track.id === audioTrackId) {
      return { ...track, clips: [...track.clips, linkedAudioClip].sort((a, b) => a.startOffset - b.startOffset) };
    }
    return track;
  });
  return { ...state, tracks };
}

export function removeClipFromTrack(
  state: TimelineState,
  trackId: string,
  clipId: string
): TimelineState {
  const sourceTrack = getTrackById(state, trackId);
  const clip = sourceTrack?.clips.find((c) => c.id === clipId);
  const linkedId = clip?.linkedClipId;

  const tracks = state.tracks.map((track) => {
    const filtered = track.clips.filter((c) => c.id !== clipId && c.id !== linkedId);
    return { ...track, clips: filtered };
  });
  return { ...state, tracks };
}

export function moveClip(
  state: TimelineState,
  trackId: string,
  clipId: string,
  newStartOffset: number
): TimelineState {
  const sourceTrack = getTrackById(state, trackId);
  if (!sourceTrack) return state;
  const clip = sourceTrack.clips.find((c) => c.id === clipId);
  if (!clip) return state;

  const effDur = getEffectiveDuration(clip);
  let targetStart = Math.max(0, newStartOffset);

  const otherClips = sourceTrack.clips.filter((c) => c.id !== clipId);
  targetStart = resolveOverlap(otherClips, targetStart, effDur, clipId);

  const linkedId = clip.linkedClipId;

  const tracks = state.tracks.map((track) => {
    if (track.id === trackId) {
      const updatedClip = { ...clip, startOffset: targetStart };
      const newClips = [...otherClips, updatedClip].sort((a, b) => a.startOffset - b.startOffset);
      return { ...track, clips: newClips };
    }
    if (linkedId) {
      const hasLinked = track.clips.some((c) => c.id === linkedId);
      if (hasLinked) {
        return {
          ...track,
          clips: track.clips.map((c) =>
            c.id === linkedId ? { ...c, startOffset: targetStart } : c
          ).sort((a, b) => a.startOffset - b.startOffset),
        };
      }
    }
    return track;
  });
  return { ...state, tracks };
}

function resolveOverlap(
  otherClips: TimelineClip[],
  targetStart: number,
  duration: number,
  _clipId: string
): number {
  const sorted = [...otherClips].sort((a, b) => a.startOffset - b.startOffset);
  const maxIterations = sorted.length + 1;

  for (let iter = 0; iter < maxIterations; iter++) {
    let foundOverlap = false;
    const targetEnd = targetStart + duration;

    for (const other of sorted) {
      const otherEnd = other.startOffset + getEffectiveDuration(other);
      if (targetStart < otherEnd && targetEnd > other.startOffset) {
        const slideRight = otherEnd;
        const slideLeft = other.startOffset - duration;
        const distRight = Math.abs(slideRight - targetStart);
        const distLeft = Math.abs(slideLeft - targetStart);
        if (slideLeft >= 0 && distLeft < distRight) {
          targetStart = slideLeft;
        } else {
          targetStart = slideRight;
        }
        foundOverlap = true;
        break;
      }
    }
    if (!foundOverlap) break;
  }

  return Math.max(0, targetStart);
}

export function reorderClip(
  state: TimelineState,
  trackId: string,
  clipId: string,
  newIndex: number
): TimelineState {
  const tracks = state.tracks.map((track) => {
    if (track.id !== trackId) return track;
    const clipIndex = track.clips.findIndex((c) => c.id === clipId);
    if (clipIndex === -1 || clipIndex === newIndex) return track;
    const clips = [...track.clips];
    const [removed] = clips.splice(clipIndex, 1);
    clips.splice(newIndex, 0, removed);
    let offset = 0;
    const recomputed = clips.map((c) => {
      const updated = { ...c, startOffset: offset };
      offset += getEffectiveDuration(c);
      return updated;
    });
    return { ...track, clips: recomputed };
  });
  return { ...state, tracks };
}

export function trimClip(
  state: TimelineState,
  trackId: string,
  clipId: string,
  trimStart: number,
  trimEnd: number
): TimelineState {
  const sourceTrack = getTrackById(state, trackId);
  if (!sourceTrack) return state;
  const clipIndex = sourceTrack.clips.findIndex((c) => c.id === clipId);
  if (clipIndex === -1) return state;

  const clip = sourceTrack.clips[clipIndex];
  const clampedTrimStart = Math.max(0, Math.min(trimStart, clip.duration - trimEnd - 0.01));
  const clampedTrimEnd = Math.max(0, Math.min(trimEnd, clip.duration - clampedTrimStart - 0.01));

  const trimStartDelta = clampedTrimStart - clip.trimStart;
  const newStartOffset = clip.startOffset + trimStartDelta;
  const linkedId = clip.linkedClipId;

  const tracks = state.tracks.map((track) => {
    if (track.id === trackId) {
      return {
        ...track,
        clips: track.clips.map((c, i) =>
          i === clipIndex
            ? { ...c, trimStart: clampedTrimStart, trimEnd: clampedTrimEnd, startOffset: newStartOffset }
            : c
        ),
      };
    }
    if (linkedId) {
      const hasLinked = track.clips.some((c) => c.id === linkedId);
      if (hasLinked) {
        return {
          ...track,
          clips: track.clips.map((c) =>
            c.id === linkedId
              ? { ...c, trimStart: clampedTrimStart, trimEnd: clampedTrimEnd, startOffset: newStartOffset }
              : c
          ).sort((a, b) => a.startOffset - b.startOffset),
        };
      }
    }
    return track;
  });
  return { ...state, tracks };
}

export function setClipVolume(
  state: TimelineState,
  trackId: string,
  clipId: string,
  volume: number
): TimelineState {
  const tracks = state.tracks.map((track) => {
    if (track.id !== trackId) return track;
    return {
      ...track,
      clips: track.clips.map((c) =>
        c.id === clipId ? { ...c, volume: Math.max(0, Math.min(10, volume)) } : c
      ),
    };
  });
  return { ...state, tracks };
}

export function applyMagneticSnap(
  state: TimelineState,
  visibleDuration: number
): { state: TimelineState; snapPoints: { trackId: string; time: number }[] } {
  if (!state.magneticSnap) return { state, snapPoints: [] };

  const threshold = Math.max(0.2, visibleDuration * 0.05);
  const snapPoints: { trackId: string; time: number }[] = [];

  const tracks = state.tracks.map((track) => {
    if (track.clips.length < 2) return track;
    const sorted = [...track.clips].sort((a, b) => a.startOffset - b.startOffset);
    const snapped: TimelineClip[] = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const prev = snapped[i - 1];
      const curr = sorted[i];
      const prevEnd = prev.startOffset + getEffectiveDuration(prev);
      const gap = curr.startOffset - prevEnd;

      if (gap > 0 && gap <= threshold) {
        snapped.push({ ...curr, startOffset: prevEnd });
        snapPoints.push({ trackId: track.id, time: prevEnd });
      } else {
        snapped.push(curr);
      }
    }

    return { ...track, clips: snapped };
  });

  return { state: { ...state, tracks }, snapPoints };
}

export function getTotalDuration(state: TimelineState): number {
  let max = 0;
  for (const track of state.tracks) {
    const last = track.clips[track.clips.length - 1];
    if (last) {
      const end = last.startOffset + getEffectiveDuration(last);
      if (end > max) max = end;
    }
  }
  return max;
}

export function getActiveClipAtTime(
  track: TimelineTrack,
  time: number
): TimelineClip | null {
  for (const clip of track.clips) {
    const effDur = getEffectiveDuration(clip);
    if (time >= clip.startOffset && time < clip.startOffset + effDur) {
      return clip;
    }
  }
  return null;
}

/**
 * The video clip that starts next. The viewer preloads it into its standby
 * element so crossing a clip boundary costs no load and no seek — that round
 * trip is the visible gap between clips.
 */
export function getNextVideoClipAfterTime(state: TimelineState, time: number): TimelineClip | null {
  let best: TimelineClip | null = null;
  for (const track of state.tracks) {
    if (track.type !== "video") continue;
    for (const clip of track.clips) {
      if (clip.startOffset > time && (!best || clip.startOffset < best.startOffset)) best = clip;
    }
  }
  return best;
}

/**
 * The volume a clip actually plays at. Track mute wins over the clip's own
 * level and is NOT written into it, so unmuting is lossless.
 *
 * Playback and export must never compute this differently — a mute that is
 * audible in the preview but present in the export (or vice versa) is worse
 * than no mute at all, so both call this.
 */
export function effectiveVolume(track: TimelineTrack | undefined, clip: TimelineClip): number {
  if (track?.muted) return 0;
  return Math.max(0, Math.min(1, clip.volume ?? 1));
}

/** Track ids whose audio is muted — the form the export and viewer want. */
export function mutedTrackIds(state: TimelineState): Set<string> {
  return new Set(state.tracks.filter((t) => t.muted).map((t) => t.id));
}

export function setTrackMuted(
  state: TimelineState,
  trackId: string,
  muted: boolean
): TimelineState {
  return {
    ...state,
    tracks: state.tracks.map((t) => (t.id === trackId ? { ...t, muted } : t)),
  };
}

export function getTrackLabel(state: TimelineState, track: TimelineTrack): string {
  const sameType = state.tracks.filter((t) => t.type === track.type);
  const idx = sameType.indexOf(track);
  const prefix = track.type === "video" ? "V" : "A";
  return `${prefix}${idx + 1}`;
}

function normalizeClip(c: unknown, idx: number): TimelineClip | null {
  if (!c || typeof c !== "object") return null;
  const clip = c as Record<string, unknown>;
  if (typeof clip.id !== "string" || typeof clip.src !== "string") return null;
  const type = clip.type as string;
  if (type !== "video" && type !== "image" && type !== "audio") return null;
  return {
    id: clip.id,
    sourceNodeId: typeof clip.sourceNodeId === "string" ? clip.sourceNodeId : "",
    src: clip.src,
    type,
    duration: typeof clip.duration === "number" && clip.duration > 0 ? clip.duration : 3,
    startOffset: typeof clip.startOffset === "number" ? clip.startOffset : idx * 3,
    label: typeof clip.label === "string" ? clip.label : undefined,
    trimStart: typeof clip.trimStart === "number" ? clip.trimStart : 0,
    trimEnd: typeof clip.trimEnd === "number" ? clip.trimEnd : 0,
    volume: typeof clip.volume === "number" ? Math.max(0, Math.min(1, clip.volume)) : 1,
    linkedClipId: typeof clip.linkedClipId === "string" ? clip.linkedClipId : undefined,
  };
}

function normalizeTrackGeneric(raw: unknown, idx: number): TimelineTrack | null {
  if (!raw || typeof raw !== "object") return null;
  const track = raw as Record<string, unknown>;
  const trackType = track.type as string;
  if (trackType !== "video" && trackType !== "audio") return null;
  const id = typeof track.id === "string" && track.id.length > 0
    ? track.id
    : `${trackType}-track-${idx}`;
  const clips = Array.isArray(track.clips)
    ? (track.clips.map(normalizeClip).filter(Boolean) as TimelineClip[])
    : [];
  return { id, type: trackType, clips, muted: track.muted === true };
}

let _cachedTimelineStateObj: unknown = null;
let _cachedTimeline: TimelineState | null = null;

export function parseTimelineFromMetadata(metadata: Record<string, unknown>): TimelineState {
  const tsObj = metadata.timelineState;
  if (tsObj === _cachedTimelineStateObj && _cachedTimeline) {
    return _cachedTimeline;
  }

  let result: TimelineState;
  if (metadata.timelineState && typeof metadata.timelineState === "object") {
    const raw = metadata.timelineState as Record<string, unknown>;
    const rawTracks = Array.isArray(raw.tracks) ? raw.tracks : [];

    const parsed = rawTracks.map((t, i) => normalizeTrackGeneric(t, i)).filter(Boolean) as TimelineTrack[];

    const hasVideo = parsed.some((t) => t.type === "video");
    const hasAudio = parsed.some((t) => t.type === "audio");
    if (!hasVideo) parsed.unshift({ id: generateId(), type: "video", clips: [] });
    if (!hasAudio) parsed.push({ id: generateId(), type: "audio", clips: [] });

    result = {
      tracks: parsed,
      playheadPosition: typeof raw.playheadPosition === "number" ? raw.playheadPosition : 0,
      zoomLevel: typeof raw.zoomLevel === "number" ? Math.max(0.01, Math.min(0.3, raw.zoomLevel)) : 0.15,
      magneticSnap: typeof raw.magneticSnap === "boolean" ? raw.magneticSnap : true,
      looping: typeof raw.looping === "boolean" ? raw.looping : false,
    };
  } else {
    result = createDefaultTimelineState();
  }

  _cachedTimelineStateObj = metadata.timelineState;
  _cachedTimeline = result;
  return result;
}

export function splitClipAtTime(
  state: TimelineState,
  trackId: string,
  clipId: string,
  splitTime: number
): TimelineState {
  const track = getTrackById(state, trackId);
  if (!track) return state;
  const clip = track.clips.find((c) => c.id === clipId);
  if (!clip) return state;

  const effStart = clip.startOffset;
  const effEnd = effStart + getEffectiveDuration(clip);

  if (splitTime <= effStart || splitTime >= effEnd) return state;

  const relativeTime = splitTime - effStart;

  const leftId = clip.id;
  const rightId = generateId();

  const leftClip: TimelineClip = {
    ...clip,
    id: leftId,
    trimEnd: clip.duration - (clip.trimStart + relativeTime),
  };

  const rightClip: TimelineClip = {
    ...clip,
    id: rightId,
    startOffset: splitTime,
    trimStart: clip.trimStart + relativeTime,
    trimEnd: clip.trimEnd,
  };

  let tracks = state.tracks.map((t) => {
    if (t.id !== trackId) return t;
    const newClips = t.clips
      .filter((c) => c.id !== clipId)
      .concat([leftClip, rightClip])
      .sort((a, b) => a.startOffset - b.startOffset);
    return { ...t, clips: newClips };
  });

  if (clip.linkedClipId) {
    const linkedTrack = state.tracks.find((t) =>
      t.clips.some((c) => c.id === clip.linkedClipId)
    );
    if (linkedTrack) {
      const linkedClip = linkedTrack.clips.find((c) => c.id === clip.linkedClipId);
      if (linkedClip) {
        const linkedRightId = generateId();

        const linkedLeft: TimelineClip = {
          ...linkedClip,
          trimEnd: linkedClip.duration - (linkedClip.trimStart + relativeTime),
          linkedClipId: leftId,
        };

        const linkedRight: TimelineClip = {
          ...linkedClip,
          id: linkedRightId,
          startOffset: splitTime,
          trimStart: linkedClip.trimStart + relativeTime,
          trimEnd: linkedClip.trimEnd,
          linkedClipId: rightId,
        };

        leftClip.linkedClipId = linkedClip.id;
        rightClip.linkedClipId = linkedRightId;

        tracks = tracks.map((t) => {
          if (t.id === trackId) {
            return {
              ...t,
              clips: t.clips.map((c) => {
                if (c.id === leftId) return { ...c, linkedClipId: linkedClip.id };
                if (c.id === rightId) return { ...c, linkedClipId: linkedRightId };
                return c;
              }),
            };
          }
          if (t.id === linkedTrack.id) {
            const newClips = t.clips
              .filter((c) => c.id !== linkedClip.id)
              .concat([linkedLeft, linkedRight])
              .sort((a, b) => a.startOffset - b.startOffset);
            return { ...t, clips: newClips };
          }
          return t;
        });
      }
    }
  }

  return { ...state, tracks };
}

export function serializeTimelineToMetadata(
  existingMetadata: Record<string, unknown>,
  timeline: TimelineState
): Record<string, unknown> {
  return { ...existingMetadata, timelineState: timeline };
}
