import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CanvasNode } from "../../../types/canvas";
import { CinemaViewer } from "./CinemaViewer";
import { CinemaToolbar } from "./CinemaToolbar";
import { CinemaTimeline } from "./CinemaTimeline";
import { usePlaybackState } from "../hooks/usePlaybackState";
import {
  parseTimelineFromMetadata,
  serializeTimelineToMetadata,
  addClipToTrack,
  addVideoWithLinkedAudio,
  removeClipFromTrack,
  moveClip,
  trimClip,
  setClipVolume,
  applyMagneticSnap,
  addTrack,
  removeTrack,
  getTrackById,
  getActiveClipAtTime,
  setTrackMuted,
  getEffectiveDuration,
  splitClipAtTime,
  type TimelineState,
  type TimelineClip,
  type IncomingDragPreview,
} from "../helpers/timelineState";
import { syncTimelineToServer } from "../helpers/cinemaSync";
import { probeMediaDuration } from "../helpers/probeMediaDuration";
import "./CinemaFrame.css";

type CinemaFrameProps = {
  node: CanvasNode;
  canvasId?: string | null;
  onUpdateMetadata: (nodeId: string, metadata: Record<string, unknown>) => void;
  onToggleLock?: (nodeId: string) => void;
  incomingDragPreview?: IncomingDragPreview;
  onTargetTrackChange?: (trackId: string | null, dropTime: number | null) => void;
  onNodePointerDown?: (e: React.PointerEvent) => void;
  onNodeClick?: (e: React.MouseEvent) => void;
  onSelectForExport?: () => void;
};

export const CinemaFrame = memo(function CinemaFrame({
  node,
  canvasId,
  onUpdateMetadata,
  onToggleLock,
  incomingDragPreview,
  onTargetTrackChange,
  onNodePointerDown,
  onNodeClick,
  onSelectForExport,
}: CinemaFrameProps) {
  const timeline = useMemo(() => parseTimelineFromMetadata(node.metadata), [node.metadata]);

  const timelineRef = useRef<TimelineState>(timeline);
  timelineRef.current = timeline;
  const nodeMetaRef = useRef(node.metadata);
  nodeMetaRef.current = node.metadata;
  const nodeIdRef = useRef(node.id);
  nodeIdRef.current = node.id;
  const onUpdateRef = useRef(onUpdateMetadata);
  onUpdateRef.current = onUpdateMetadata;
  const canvasIdRef = useRef(canvasId);
  canvasIdRef.current = canvasId;

  const [snapLines, setSnapLines] = useState<{ trackId: string; time: number }[]>([]);
  const snapLineTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const lastPersistedRef = useRef<TimelineState>(timeline);

  const persistTimeline = useCallback(
    (newTimeline: TimelineState) => {
      const prevTimeline = timelineRef.current;
      timelineRef.current = newTimeline;
      lastPersistedRef.current = newTimeline;
      onUpdateRef.current(nodeIdRef.current, serializeTimelineToMetadata(nodeMetaRef.current, newTimeline));
      if (canvasIdRef.current) {
        syncTimelineToServer(canvasIdRef.current, node.id, prevTimeline, newTimeline).catch(() => {});
      }
    },
    []
  );

  useEffect(() => {
    if (timeline !== lastPersistedRef.current && canvasIdRef.current) {
      syncTimelineToServer(canvasIdRef.current, node.id, lastPersistedRef.current, timeline).catch(() => {});
      lastPersistedRef.current = timeline;
    }
  }, [timeline]);

  const frameRef = useRef<HTMLDivElement>(null);

  const getVisibleDuration = useCallback((zoom: number) => {
    const el = frameRef.current;
    const viewportWidth = el ? el.clientWidth : 600;
    const pps = 100 * zoom;
    return viewportWidth / pps;
  }, []);

  const persistWithSnap = useCallback(
    (newTimeline: TimelineState) => {
      const visibleDuration = getVisibleDuration(newTimeline.zoomLevel);
      const { state: snapped, snapPoints } = applyMagneticSnap(newTimeline, visibleDuration);
      persistTimeline(snapped);

      if (snapPoints.length > 0) {
        setSnapLines(snapPoints);
        if (snapLineTimerRef.current) clearTimeout(snapLineTimerRef.current);
        snapLineTimerRef.current = setTimeout(() => setSnapLines([]), 600);
      }
    },
    [persistTimeline, getVisibleDuration]
  );

  const handlePlayheadChange = useCallback(
    (time: number) => {
      const updated = { ...timelineRef.current, playheadPosition: time };
      persistTimeline(updated);
    },
    [persistTimeline]
  );

  const handleMagneticSnapToggle = useCallback(() => {
    const updated = { ...timelineRef.current, magneticSnap: !timelineRef.current.magneticSnap };
    persistTimeline(updated);
  }, [persistTimeline]);

  const playback = usePlaybackState(timeline, handlePlayheadChange);

  const playbackSeekRef = useRef(playback.seek);
  playbackSeekRef.current = playback.seek;
  const playbackScrubSeekRef = useRef(playback.scrubSeek);
  playbackScrubSeekRef.current = playback.scrubSeek;
  const playbackCommitScrubRef = useRef(playback.commitScrubTime);
  playbackCommitScrubRef.current = playback.commitScrubTime;

  const handleMoveClip = useCallback(
    (trackId: string, clipId: string, newStartOffset: number) => {
      const updated = moveClip(timelineRef.current, trackId, clipId, newStartOffset);
      persistWithSnap(updated);
    },
    [persistWithSnap]
  );

  const handleTrimClipCommit = useCallback(
    (trackId: string, clipId: string, trimStart: number, trimEnd: number) => {
      const updated = trimClip(timelineRef.current, trackId, clipId, trimStart, trimEnd);
      persistWithSnap(updated);
    },
    [persistWithSnap]
  );

  const handleRemoveClip = useCallback(
    (trackId: string, clipId: string) => {
      const updated = removeClipFromTrack(timelineRef.current, trackId, clipId);
      persistTimeline(updated);
    },
    [persistTimeline]
  );

  const handleDropClipFromCanvas = useCallback(
    async (trackId: string, dataStr: string, dropTime?: number) => {
      try {
        const data = JSON.parse(dataStr);
        const clipType = data.type === "audio" ? "audio" : data.type === "video" ? "video" : "image";

        const track = getTrackById(timelineRef.current, trackId);
        if (!track) return;
        if (track.type === "audio" && clipType !== "audio") return;
        if (track.type === "video" && clipType === "audio") return;
        if (track.type === "video" && clipType === "image") return;

        const src = data.src || "";
        const providedDur = typeof data.duration === "number" && data.duration > 0 ? data.duration : 0;
        const duration = providedDur || await probeMediaDuration(src, clipType as "video" | "audio" | "image");

        const clipId = crypto.randomUUID();

        const newClip = {
          id: clipId,
          sourceNodeId: data.nodeId || data.id || "",
          src,
          type: clipType as "video" | "image" | "audio",
          duration,
          label: data.label || "",
        };

        let updated: TimelineState;
        if (clipType === "video" && track.type === "video") {
          const audioClipId = crypto.randomUUID();
          updated = addVideoWithLinkedAudio(timelineRef.current, trackId, newClip, audioClipId, dropTime);
        } else {
          updated = addClipToTrack(timelineRef.current, trackId, newClip, dropTime);
        }
        persistWithSnap(updated);
      } catch (err) {
        console.warn("[CinemaFrame] Failed to parse drop data:", err);
      }
    },
    [persistWithSnap]
  );

  const handleDragClipOut = useCallback(
    (clip: TimelineClip, trackId: string) => {
      const updated = removeClipFromTrack(timelineRef.current, trackId, clip.id);
      persistTimeline(updated);
    },
    [persistTimeline]
  );

  const handleSeek = useCallback(
    (time: number) => {
      playbackSeekRef.current(time);
      const updated = { ...timelineRef.current, playheadPosition: time };
      persistTimeline(updated);
    },
    [persistTimeline]
  );

  const handleScrubSeek = useCallback(
    (time: number) => {
      playbackScrubSeekRef.current(time);
    },
    []
  );

  const handleScrubEnd = useCallback(
    () => {
      playbackCommitScrubRef.current();
      const time = playback.currentTimeRef.current;
      const updated = { ...timelineRef.current, playheadPosition: time };
      persistTimeline(updated);
    },
    [playback.currentTimeRef, persistTimeline]
  );

  const handleZoomChange = useCallback(
    (zoom: number) => {
      const updated = { ...timelineRef.current, zoomLevel: zoom };
      persistTimeline(updated);
    },
    [persistTimeline]
  );

  const handleClipVolumeChange = useCallback(
    (trackId: string, clipId: string, volume: number) => {
      const updated = setClipVolume(timelineRef.current, trackId, clipId, volume);
      persistTimeline(updated);
    },
    [persistTimeline]
  );

  const handleLoopToggle = useCallback(() => {
    const updated = { ...timelineRef.current, looping: !timelineRef.current.looping };
    persistTimeline(updated);
  }, [persistTimeline]);

  const findSplittableClip = useCallback((tl: TimelineState, time: number): { trackId: string; clipId: string } | null => {
    for (const track of tl.tracks) {
      const clip = getActiveClipAtTime(track, time);
      if (clip) {
        const effStart = clip.startOffset;
        const effEnd = effStart + getEffectiveDuration(clip);
        if (time > effStart && time < effEnd) {
          return { trackId: track.id, clipId: clip.id };
        }
      }
    }
    return null;
  }, []);

  const canSplit = findSplittableClip(timeline, playback.currentTimeRef.current) !== null;

  const handleSplit = useCallback(() => {
    const time = playback.currentTimeRef.current;
    const target = findSplittableClip(timelineRef.current, time);
    if (!target) return;
    const updated = splitClipAtTime(timelineRef.current, target.trackId, target.clipId, time);
    persistTimeline(updated);
  }, [findSplittableClip, playback.currentTimeRef, persistTimeline]);

  const handleAddTrack = useCallback(
    (trackType: "video" | "audio") => {
      const updated = addTrack(timelineRef.current, trackType);
      persistTimeline(updated);
    },
    [persistTimeline]
  );

  const handleRemoveTrack = useCallback(
    (trackId: string) => {
      const updated = removeTrack(timelineRef.current, trackId);
      persistTimeline(updated);
    },
    [persistTimeline]
  );

  const handleSetTrackMuted = useCallback(
    (trackId: string, muted: boolean) => {
      persistTimeline(setTrackMuted(timelineRef.current, trackId, muted));
    },
    [persistTimeline]
  );

  const handleTitlebarDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onToggleLock?.(node.id);
  }, [node.id, onToggleLock]);

  const handleExportClick = useCallback((_e: React.MouseEvent) => {
    onSelectForExport?.();
  }, [onSelectForExport]);

  const isLocked = node.locked !== false;

  return (
    <div className="cinema-frame" ref={frameRef}>
      <div className="cinema-frame__titlebar" onPointerDown={onNodePointerDown} onClick={onNodeClick} onDoubleClick={handleTitlebarDoubleClick} title={isLocked ? "Double-click to unlock (allow repositioning)" : "Double-click to lock position"}>
        <span className="cinema-frame__titlebar-text">Cinema</span>
        <button
          type="button"
          className="cinema-frame__export-btn"
          onClick={handleExportClick}
          title="Export MP4"
          aria-label="Export MP4"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </button>
        <span className={`cinema-frame__lock-icon ${isLocked ? "" : "cinema-frame__lock-icon--unlocked"}`}>
          {isLocked ? (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 9.9-1" />
            </svg>
          )}
        </span>
      </div>
      <CinemaViewer
        videoMuted={timeline.tracks.some(
          (t) => t.type === "video" && t.muted && t.clips.some((c) => c.id === playback.activeClip?.id),
        )}
        activeClip={playback.activeClip}
        activeAudioClips={playback.activeAudioClips}
        isPlaying={playback.isPlaying}
        currentTimeRef={playback.currentTimeRef}
        seekVersion={playback.seekVersion}
        volume={playback.volume}
      />
      <CinemaToolbar
        isPlaying={playback.isPlaying}
        currentTime={playback.currentTime}
        currentTimeRef={playback.currentTimeRef}
        totalDuration={playback.totalDuration}
        volume={playback.volume}
        zoomLevel={timeline.zoomLevel}
        looping={timeline.looping}
        canSplit={canSplit}
        magneticSnap={timeline.magneticSnap}
        onPlay={playback.play}
        onPause={playback.pause}
        onSeek={handleSeek}
        onVolumeChange={playback.setVolume}
        onZoomChange={handleZoomChange}
        onLoopToggle={handleLoopToggle}
        onSplit={handleSplit}
        onMagneticSnapToggle={handleMagneticSnapToggle}
      />
      <CinemaTimeline
        timeline={timeline}
        currentTimeRef={playback.currentTimeRef}
        isPlaying={playback.isPlaying}
        onScrubSeek={handleScrubSeek}
        onScrubEnd={handleScrubEnd}
        onMoveClip={handleMoveClip}
        onTrimClipCommit={handleTrimClipCommit}
        onRemoveClip={handleRemoveClip}
        onDropClipFromCanvas={handleDropClipFromCanvas}
        onDragClipOut={handleDragClipOut}
        onClipVolumeChange={handleClipVolumeChange}
        onAddTrack={handleAddTrack}
        onRemoveTrack={handleRemoveTrack}
        onSetTrackMuted={handleSetTrackMuted}
        onZoomChange={handleZoomChange}
        zoomLevel={timeline.zoomLevel}
        incomingDragPreview={incomingDragPreview}
        onTargetTrackChange={onTargetTrackChange}
        snapLines={snapLines}
      />
    </div>
  );
});
