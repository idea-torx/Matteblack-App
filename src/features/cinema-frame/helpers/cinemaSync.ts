import type { TimelineState, TimelineTrack, TimelineClip } from "./timelineState";

interface DbTrack {
  id: string;
  canvas_id: string;
  track_type: "video" | "audio";
  sort_order: number;
}

interface DbClip {
  id: string;
  track_id: string;
  canvas_id: string;
  source_node_id: string;
  src: string;
  clip_type: "video" | "image" | "audio";
  duration: number;
  start_offset: number;
  trim_start: number;
  trim_end: number;
  volume: number;
  label: string;
  linked_clip_id: string | null;
  sort_order: number;
}

export function assembleTimelineFromDb(
  dbTracks: DbTrack[],
  dbClips: DbClip[]
): TimelineState {
  const clipsByTrack = new Map<string, TimelineClip[]>();
  for (const dc of dbClips) {
    const clip: TimelineClip = {
      id: dc.id,
      sourceNodeId: dc.source_node_id,
      src: dc.src,
      type: dc.clip_type,
      duration: dc.duration,
      startOffset: dc.start_offset,
      trimStart: dc.trim_start,
      trimEnd: dc.trim_end,
      volume: dc.volume,
      label: dc.label || undefined,
      linkedClipId: dc.linked_clip_id || undefined,
    };
    const list = clipsByTrack.get(dc.track_id) || [];
    list.push(clip);
    clipsByTrack.set(dc.track_id, list);
  }

  const tracks: TimelineTrack[] = dbTracks.map((dt) => ({
    id: dt.id,
    type: dt.track_type,
    clips: (clipsByTrack.get(dt.id) || []).sort((a, b) => a.startOffset - b.startOffset),
  }));

  const hasVideo = tracks.some((t) => t.type === "video");
  const hasAudio = tracks.some((t) => t.type === "audio");
  if (!hasVideo) tracks.unshift({ id: crypto.randomUUID(), type: "video", clips: [] });
  if (!hasAudio) tracks.push({ id: crypto.randomUUID(), type: "audio", clips: [] });

  return {
    tracks,
    playheadPosition: 0,
    zoomLevel: 0.15,
    magneticSnap: true,
    looping: false,
  };
}

export function diffTimeline(
  prev: TimelineState,
  next: TimelineState
): {
  tracks: { id: string; track_type: string; sort_order: number }[];
  clips: {
    id: string;
    track_id: string;
    source_node_id: string;
    src: string;
    clip_type: string;
    duration: number;
    start_offset: number;
    trim_start: number;
    trim_end: number;
    volume: number;
    label: string;
    linked_clip_id: string | null;
    sort_order: number;
  }[];
  deletedClipIds: string[];
  deletedTrackIds: string[];
} {
  const prevTrackIds = new Set(prev.tracks.map((t) => t.id));
  const nextTrackIds = new Set(next.tracks.map((t) => t.id));
  const prevClipIds = new Set(prev.tracks.flatMap((t) => t.clips.map((c) => c.id)));
  const nextClipIds = new Set(next.tracks.flatMap((t) => t.clips.map((c) => c.id)));

  const deletedTrackIds = [...prevTrackIds].filter((id) => !nextTrackIds.has(id));
  const deletedClipIds = [...prevClipIds].filter((id) => !nextClipIds.has(id));

  const tracks = next.tracks.map((t, i) => ({
    id: t.id,
    track_type: t.type,
    sort_order: i,
  }));

  const clips = next.tracks.flatMap((t) =>
    t.clips.map((c, ci) => ({
      id: c.id,
      track_id: t.id,
      source_node_id: c.sourceNodeId,
      src: c.src,
      clip_type: c.type,
      duration: c.duration,
      start_offset: c.startOffset,
      trim_start: c.trimStart,
      trim_end: c.trimEnd,
      volume: c.volume,
      label: c.label || "",
      linked_clip_id: c.linkedClipId || null,
      sort_order: ci,
    }))
  );

  return { tracks, clips, deletedClipIds, deletedTrackIds };
}

const _syncDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const _syncBaselines = new Map<string, TimelineState>();
const _syncLatest = new Map<string, TimelineState>();

export async function syncTimelineToServer(
  canvasId: string,
  prev: TimelineState,
  next: TimelineState
): Promise<void> {
  const existingTimer = _syncDebounceTimers.get(canvasId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  } else {
    _syncBaselines.set(canvasId, prev);
  }
  _syncLatest.set(canvasId, next);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(async () => {
      _syncDebounceTimers.delete(canvasId);
      const baseline = _syncBaselines.get(canvasId) || prev;
      const latest = _syncLatest.get(canvasId) || next;
      _syncBaselines.delete(canvasId);
      _syncLatest.delete(canvasId);
      try {
        const diff = diffTimeline(baseline, latest);
        const res = await fetch(`/api/canvas/${canvasId}/cinema/sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(diff),
        });
        if (!res.ok) {
          console.error("[cinemaSync] sync failed:", res.status);
        }
        resolve();
      } catch (err) {
        console.error("[cinemaSync] sync error:", err);
        reject(err);
      }
    }, 500);
    _syncDebounceTimers.set(canvasId, timer);
  });
}

// Cancel any pending debounced cinema/sync flush for this canvas. Called when
// the cinema frame is deleted so a queued sync doesn't race the delete and
// resurrect tracks/clips on the server (which the next load would re-attach).
export function cancelTimelineSync(canvasId: string): void {
  const t = _syncDebounceTimers.get(canvasId);
  if (t) clearTimeout(t);
  _syncDebounceTimers.delete(canvasId);
  _syncBaselines.delete(canvasId);
  _syncLatest.delete(canvasId);
}

export async function loadTimelineFromServer(
  canvasId: string
): Promise<TimelineState | null> {
  try {
    const res = await fetch(`/api/canvas/${canvasId}/cinema/timeline`, {
      credentials: "include",
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.tracks || data.tracks.length === 0) return null;
    return assembleTimelineFromDb(data.tracks, data.clips || []);
  } catch (err) {
    console.error("[cinemaSync] load error:", err);
    return null;
  }
}
