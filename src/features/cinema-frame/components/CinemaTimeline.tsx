import { memo, useCallback, useRef, useState, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import WaveSurfer from "wavesurfer.js";
import type { TimelineState, TimelineTrack, TimelineClip, IncomingDragPreview } from "../helpers/timelineState";
import { getTotalDuration, getEffectiveDuration, getTrackLabel } from "../helpers/timelineState";
import { ClipThumbnail } from "./ClipThumbnail";

function getProxiedAudioUrl(url: string): string {
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.origin === window.location.origin) return url;
    return `/api/audio-proxy?url=${encodeURIComponent(url)}`;
  } catch {
    return url;
  }
}

function useTheme(): string {
  const [theme, setTheme] = useState(() => document.documentElement.getAttribute("data-theme") || "dark");
  useEffect(() => {
    const obs = new MutationObserver(() => {
      setTheme(document.documentElement.getAttribute("data-theme") || "dark");
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  return theme;
}

function ClipWaveform({ src, clipId }: { src: string; clipId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const mountedSrc = useRef<string>("");
  const theme = useTheme();

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !src) return;

    const isLight = theme === "light";
    const waveColor = isLight ? "rgba(22, 163, 74, 0.45)" : "rgba(134, 239, 172, 0.5)";

    if (mountedSrc.current === src && wsRef.current) {
      wsRef.current.setOptions({ waveColor, progressColor: waveColor });
      return;
    }

    if (wsRef.current) {
      wsRef.current.destroy();
      wsRef.current = null;
    }
    mountedSrc.current = src;

    const proxied = getProxiedAudioUrl(src);

    const ws = WaveSurfer.create({
      container: el,
      waveColor,
      progressColor: waveColor,
      cursorWidth: 0,
      barWidth: 1.5,
      barGap: 1,
      barRadius: 1,
      height: 36,
      normalize: true,
      interact: false,
      hideScrollbar: true,
      url: proxied,
      mediaControls: false,
    });

    ws.on("ready", () => {
      ws.setTime(0);
      ws.setMuted(true);
    });

    wsRef.current = ws;

    return () => {
      ws.destroy();
      wsRef.current = null;
      mountedSrc.current = "";
    };
  }, [src, clipId, theme]);

  return (
    <div
      ref={containerRef}
      className="cinema-timeline__clip-waveform"
    />
  );
}

type CinemaTimelineProps = {
  timeline: TimelineState;
  currentTimeRef: React.RefObject<number>;
  isPlaying: boolean;
  onScrubSeek: (time: number) => void;
  onScrubEnd: () => void;
  onMoveClip: (trackId: string, clipId: string, newStartOffset: number) => void;
  onTrimClipCommit: (trackId: string, clipId: string, trimStart: number, trimEnd: number) => void;
  onRemoveClip: (trackId: string, clipId: string) => void;
  onDropClipFromCanvas: (trackId: string, data: string, dropTime?: number) => void;
  onDragClipOut: (clip: TimelineClip, trackId: string) => void;
  onClipVolumeChange: (trackId: string, clipId: string, volume: number) => void;
  onAddTrack: (trackType: "video" | "audio") => void;
  onRemoveTrack: (trackId: string) => void;
  onZoomChange: (zoom: number) => void;
  zoomLevel: number;
  incomingDragPreview?: IncomingDragPreview;
  onTargetTrackChange?: (trackId: string | null, dropTime: number | null) => void;
  snapLines: { trackId: string; time: number }[];
};

const BASE_PPS = 100;
const TRACK_GUTTER = 45;

function formatRulerTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatTimecode(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00.00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  return `${m}:${s.toString().padStart(2, "0")}.${ms.toString().padStart(2, "0")}`;
}

function RulerTicks({ pps, containerWidth }: { pps: number; containerWidth: number }) {
  let interval = 1;
  if (pps < 30) interval = 10;
  else if (pps < 60) interval = 5;
  else if (pps < 120) interval = 2;
  else interval = 1;

  const usableWidth = containerWidth - TRACK_GUTTER;
  const maxTime = usableWidth > 0 ? usableWidth / pps : 60;

  const MAX_TICKS = 120;
  const ticks: { pos: number; label: string; major: boolean }[] = [];
  for (let t = 0; t <= maxTime + interval && ticks.length < MAX_TICKS; t += interval) {
    ticks.push({ pos: TRACK_GUTTER + t * pps, label: formatRulerTime(t), major: true });
    if (interval >= 2) {
      for (let s = 1; s < interval && ticks.length < MAX_TICKS; s++) {
        const subT = t + s;
        if (subT > maxTime + interval) break;
        ticks.push({ pos: TRACK_GUTTER + subT * pps, label: "", major: false });
      }
    }
  }

  return (
    <>
      {ticks.map((tick, i) => (
        <div
          key={i}
          className={`cinema-timeline__ruler-tick ${tick.major ? "cinema-timeline__ruler-tick--major" : ""}`}
          style={{ left: tick.pos }}
        >
          {tick.label && <span className="cinema-timeline__ruler-label">{tick.label}</span>}
        </div>
      ))}
    </>
  );
}

function Playhead({
  currentTimeRef,
  pps,
  className,
}: {
  currentTimeRef: React.RefObject<number>;
  pps: number;
  isPlaying: boolean;
  className: string;
}) {
  const elRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const ppsRef = useRef(pps);
  ppsRef.current = pps;

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;

    el.style.left = `${TRACK_GUTTER + currentTimeRef.current * ppsRef.current}px`;

    const update = () => {
      if (el) {
        el.style.left = `${TRACK_GUTTER + currentTimeRef.current * ppsRef.current}px`;
      }
      rafRef.current = requestAnimationFrame(update);
    };
    rafRef.current = requestAnimationFrame(update);

    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [currentTimeRef]);

  return <div ref={elRef} className={className} />;
}

function TrimHandle({
  side,
  clip,
  pps,
  trackId,
  prevClipEnd,
  nextClipStart,
  onTrimCommit,
  onTrimPreview,
}: {
  side: "left" | "right";
  clip: TimelineClip;
  pps: number;
  trackId: string;
  prevClipEnd: number;
  nextClipStart: number;
  onTrimCommit: (trackId: string, clipId: string, trimStart: number, trimEnd: number) => void;
  onTrimPreview: (clipId: string, trimStart: number, trimEnd: number) => void;
}) {
  const [tooltipTime, setTooltipTime] = useState<number | null>(null);
  const draggingRef = useRef(false);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      draggingRef.current = true;

      const startX = e.clientX;
      const initialTrimStart = clip.trimStart;
      const initialTrimEnd = clip.trimEnd;
      const initialStartOffset = clip.startOffset;
      const handleEl = e.currentTarget as HTMLElement;
      const parentEl = handleEl.parentElement;
      const parentRect = parentEl?.getBoundingClientRect();
      const trimScale = parentEl && parentRect && parentEl.clientWidth > 0 ? parentRect.width / parentEl.clientWidth : 1;

      let lastUpdate = 0;
      let finalTrimStart = initialTrimStart;
      let finalTrimEnd = initialTrimEnd;

      const onMove = (ev: PointerEvent) => {
        if (!draggingRef.current) return;
        const now = performance.now();
        if (now - lastUpdate < 33) return;
        lastUpdate = now;

        const dx = (ev.clientX - startX) / trimScale;
        const dt = dx / pps;

        if (side === "left") {
          let newTrimStart = Math.max(0, initialTrimStart + dt);
          newTrimStart = Math.min(newTrimStart, clip.duration - clip.trimEnd - 0.01);
          const newStartOffset = initialStartOffset + (newTrimStart - initialTrimStart);
          if (newStartOffset < prevClipEnd) {
            newTrimStart = initialTrimStart + (prevClipEnd - initialStartOffset);
          }
          newTrimStart = Math.max(0, newTrimStart);
          finalTrimStart = newTrimStart;
          finalTrimEnd = clip.trimEnd;
          const previewStartOffset = initialStartOffset + (finalTrimStart - initialTrimStart);
          setTooltipTime(previewStartOffset);
          onTrimPreview(clip.id, finalTrimStart, finalTrimEnd);
        } else {
          let newTrimEnd = Math.max(0, initialTrimEnd - dt);
          newTrimEnd = Math.min(newTrimEnd, clip.duration - clip.trimStart - 0.01);
          const effDur = clip.duration - clip.trimStart - newTrimEnd;
          const clipEnd = clip.startOffset + effDur;
          if (clipEnd > nextClipStart) {
            newTrimEnd = clip.duration - clip.trimStart - (nextClipStart - clip.startOffset);
          }
          newTrimEnd = Math.max(0, newTrimEnd);
          finalTrimStart = clip.trimStart;
          finalTrimEnd = newTrimEnd;
          const previewEffDur = clip.duration - clip.trimStart - finalTrimEnd;
          setTooltipTime(clip.startOffset + previewEffDur);
          onTrimPreview(clip.id, finalTrimStart, finalTrimEnd);
        }
      };

      const onUp = () => {
        draggingRef.current = false;
        setTooltipTime(null);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        onTrimCommit(trackId, clip.id, finalTrimStart, finalTrimEnd);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [clip, pps, trackId, onTrimCommit, onTrimPreview, side, prevClipEnd, nextClipStart]
  );

  return (
    <div
      className={`cinema-timeline__trim-handle cinema-timeline__trim-handle--${side}`}
      onPointerDown={handlePointerDown}
    >
      {tooltipTime !== null && (
        <div className="cinema-timeline__trim-tooltip">
          {formatTimecode(tooltipTime)}
        </div>
      )}
    </div>
  );
}

function ClipVolumeControl({
  clip,
  trackId,
  onVolumeChange,
}: {
  clip: TimelineClip;
  trackId: string;
  onVolumeChange: (trackId: string, clipId: string, volume: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const isMuted = clip.volume === 0;
  const [popPos, setPopPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: PointerEvent) => {
      const target = e.target as Node;
      if (popRef.current && popRef.current.contains(target)) return;
      if (btnRef.current && btnRef.current.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", handler, true);
    return () => window.removeEventListener("pointerdown", handler, true);
  }, [open]);

  useEffect(() => {
    if (!open || !btnRef.current) return;
    const updatePos = () => {
      const rect = btnRef.current!.getBoundingClientRect();
      setPopPos({
        top: rect.top - 6,
        left: rect.left + rect.width / 2,
      });
    };
    updatePos();
    window.addEventListener("scroll", updatePos, true);
    window.addEventListener("resize", updatePos);
    return () => {
      window.removeEventListener("scroll", updatePos, true);
      window.removeEventListener("resize", updatePos);
    };
  }, [open]);

  return (
    <div
      className="cinema-timeline__clip-vol"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        ref={btnRef}
        type="button"
        className={`cinema-timeline__clip-vol-btn ${isMuted ? "cinema-timeline__clip-vol-btn--muted" : ""}`}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        title={`Volume: ${Math.round(clip.volume * 100)}%`}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          {!isMuted && clip.volume > 0 && <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />}
          {isMuted && <><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" /></>}
        </svg>
      </button>
      {open && popPos && createPortal(
        <div
          ref={popRef}
          className="cinema-timeline__clip-vol-pop"
          style={{
            position: "fixed",
            top: popPos.top,
            left: popPos.left,
            transform: "translate(-50%, -100%)",
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <input
            type="range"
            className="cinema-timeline__clip-vol-slider"
            min={0}
            max={1}
            step={0.01}
            value={clip.volume}
            onChange={(e) => onVolumeChange(trackId, clip.id, parseFloat(e.target.value))}
          />
          <span className="cinema-timeline__clip-vol-label">{Math.round(clip.volume * 100)}%</span>
        </div>,
        document.body
      )}
    </div>
  );
}

function TrackLane({
  track,
  trackLabel,
  pps,
  onMoveClip,
  onTrimClipCommit,
  onRemoveClip,
  onDropClipFromCanvas,
  onDragClipOut,
  onClipVolumeChange,
  onRemoveTrack,
  canRemoveTrack,
  totalDuration: _totalDuration,
  ghostPreview,
  snapLines,
  selectedClipId,
  onSelectClip,
}: {
  track: TimelineTrack;
  trackLabel: string;
  pps: number;
  onMoveClip: (trackId: string, clipId: string, newStartOffset: number) => void;
  onTrimClipCommit: (trackId: string, clipId: string, trimStart: number, trimEnd: number) => void;
  onRemoveClip: (trackId: string, clipId: string) => void;
  onDropClipFromCanvas: (trackId: string, data: string, dropTime?: number) => void;
  onDragClipOut: (clip: TimelineClip, trackId: string) => void;
  onClipVolumeChange: (trackId: string, clipId: string, volume: number) => void;
  onRemoveTrack: (trackId: string) => void;
  canRemoveTrack: boolean;
  totalDuration: number;
  ghostPreview?: { startOffset: number; duration: number; label: string };
  snapLines: { trackId: string; time: number }[];
  selectedClipId: string | null;
  onSelectClip: (trackId: string, clipId: string | null) => void;
}) {
  const [dragOverTrack, setDragOverTrack] = useState(false);
  const [externalGhostLeft, setExternalGhostLeft] = useState<number | null>(null);
  const [ghostPos, setGhostPos] = useState<{ left: number; width: number } | null>(null);
  const [hoveredClipId, setHoveredClipId] = useState<string | null>(null);
  const [dragClipId, setDragClipId] = useState<string | null>(null);
  const [trimPreview, setTrimPreview] = useState<{ clipId: string; trimStart: number; trimEnd: number } | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const clipsRef = useRef<HTMLDivElement>(null);
  const trackSnapLines = snapLines.filter((s) => s.trackId === track.id);

  const handleTrimPreview = useCallback(
    (clipId: string, trimStart: number, trimEnd: number) => {
      setTrimPreview({ clipId, trimStart, trimEnd });
    },
    []
  );

  const handleTrimCommit = useCallback(
    (trackId: string, clipId: string, trimStart: number, trimEnd: number) => {
      setTrimPreview(null);
      onTrimClipCommit(trackId, clipId, trimStart, trimEnd);
    },
    [onTrimClipCommit]
  );

  const handleExternalDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const types = e.dataTransfer.types;
      if (
        types.includes("application/x-canvas-node") ||
        types.includes("application/x-tray-item")
      ) {
        e.dataTransfer.dropEffect = "move";
        setDragOverTrack(true);
        const el = clipsRef.current;
        if (el) {
          const rect = el.getBoundingClientRect();
          const x = e.clientX - rect.left;
          setExternalGhostLeft(Math.max(0, x));
        }
      }
    },
    []
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    const el = trackRef.current;
    if (el && e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return;
    setDragOverTrack(false);
    setExternalGhostLeft(null);
  }, []);

  const handleExternalDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOverTrack(false);
      setExternalGhostLeft(null);

      let dropTime: number | undefined;
      const el = clipsRef.current;
      if (el) {
        const rect = el.getBoundingClientRect();
        const x = e.clientX - rect.left;
        dropTime = Math.max(0, x / pps);
      }

      const canvasData = e.dataTransfer.getData("application/x-canvas-node");
      if (canvasData) {
        onDropClipFromCanvas(track.id, canvasData, dropTime);
        return;
      }

      const trayData = e.dataTransfer.getData("application/x-tray-item");
      if (trayData) {
        try {
          const item = JSON.parse(trayData);
          const trayUrl = item.result_url || "";
          const audioJobTypes = ["audio_tts", "audio_music", "audio_sfx", "audio_voice_changer"];
          const isAudio = audioJobTypes.includes(item.job_type || "");
          const isVideo = item.job_type === "video_gen" || item.job_type === "avatar";
          const clipType = isAudio ? "audio" : isVideo ? "video" : "image";
          const nodeData = JSON.stringify({
            id: item.id || "",
            nodeId: item.id || "",
            src: trayUrl,
            type: clipType,
            label: item.prompt || (item.metadata?.prompt as string) || "Clip",
            duration: typeof item.duration === "number" && item.duration > 0 ? item.duration : 0,
          });
          onDropClipFromCanvas(track.id, nodeData, dropTime);
        } catch (err) {
          console.warn("[CinemaTimeline] Failed to parse tray data:", err);
        }
      }
    },
    [track, pps, onDropClipFromCanvas]
  );

  const handleClipPointerDown = useCallback(
    (e: React.PointerEvent, clip: TimelineClip) => {
      if ((e.target as HTMLElement).closest(".cinema-timeline__trim-handle")) return;
      e.stopPropagation();
      e.preventDefault();

      const trackEl = trackRef.current;
      if (!trackEl) return;

      const trackRect = trackEl.getBoundingClientRect();
      const trackScale = trackEl.clientWidth > 0 ? trackRect.width / trackEl.clientWidth : 1;
      const grabOffsetPx = (e.clientX - trackRect.left) / trackScale - clip.startOffset * pps;
      const effDur = getEffectiveDuration(clip);

      setDragClipId(clip.id);
      setGhostPos({ left: clip.startOffset * pps, width: effDur * pps });

      let lastMoveTime = 0;
      const dragOutThreshold = 100;

      const onMove = (ev: PointerEvent) => {
        const now = performance.now();
        if (now - lastMoveTime < 16) return;
        lastMoveTime = now;

        const currentTrackRect = trackEl.getBoundingClientRect();
        const s = trackEl.clientWidth > 0 ? currentTrackRect.width / trackEl.clientWidth : 1;
        const x = (ev.clientX - currentTrackRect.left) / s - grabOffsetPx;
        setGhostPos({ left: Math.max(0, x), width: effDur * pps });
      };

      const onUp = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        setDragClipId(null);
        setGhostPos(null);

        const currentTrackRect = trackEl.getBoundingClientRect();
        const s = trackEl.clientWidth > 0 ? currentTrackRect.width / trackEl.clientWidth : 1;
        const isOutside =
          ev.clientY < currentTrackRect.top - dragOutThreshold ||
          ev.clientY > currentTrackRect.bottom + dragOutThreshold;

        if (isOutside) {
          onDragClipOut(clip, track.id);
          return;
        }

        const x = (ev.clientX - currentTrackRect.left) / s - grabOffsetPx;
        const newStartOffset = Math.max(0, x / pps);
        onMoveClip(track.id, clip.id, newStartOffset);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [pps, track.id, onMoveClip, onDragClipOut]
  );

  const sortedClips = [...track.clips].sort((a, b) => a.startOffset - b.startOffset);

  return (
    <div
      ref={trackRef}
      className={`cinema-timeline__track ${dragOverTrack ? "cinema-timeline__track--drag-over" : ""}`}
      data-track-type={track.type}
      data-track-id={track.id}
      onDragOver={handleExternalDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleExternalDrop}
      onPointerDown={() => onSelectClip(track.id, null)}
    >
      <div className="cinema-timeline__track-label" title={canRemoveTrack ? "Right-click to remove" : undefined} onContextMenu={(e) => {
        if (!canRemoveTrack) return;
        e.preventDefault();
        onRemoveTrack(track.id);
      }}>
        {trackLabel}
      </div>
      <div className="cinema-timeline__track-clips" ref={clipsRef}>
        {sortedClips.map((clip, sortedIdx) => {
          const prev = sortedIdx > 0 ? sortedClips[sortedIdx - 1] : null;
          const next = sortedIdx < sortedClips.length - 1 ? sortedClips[sortedIdx + 1] : null;
          const prevClipEnd = prev ? prev.startOffset + getEffectiveDuration(prev) : 0;
          const nextClipStart = next ? next.startOffset : Infinity;

          const isPreview = trimPreview && trimPreview.clipId === clip.id;
          const displayTrimStart = isPreview ? trimPreview.trimStart : clip.trimStart;
          const displayTrimEnd = isPreview ? trimPreview.trimEnd : clip.trimEnd;
          const displayEffDur = clip.duration - displayTrimStart - displayTrimEnd;
          const displayStartOffset = isPreview
            ? clip.startOffset + (displayTrimStart - clip.trimStart)
            : clip.startOffset;

          return (
            <div
              key={clip.id}
              className={`cinema-timeline__clip ${dragClipId === clip.id ? "cinema-timeline__clip--dragging" : ""} ${hoveredClipId === clip.id ? "cinema-timeline__clip--hovered" : ""} ${selectedClipId === clip.id ? "cinema-timeline__clip--selected" : ""}`}
              style={{
                left: displayStartOffset * pps,
                width: Math.max(displayEffDur * pps, 4),
              }}
              onPointerDown={(e) => {
                onSelectClip(track.id, clip.id);
                handleClipPointerDown(e, clip);
              }}
              onPointerEnter={() => setHoveredClipId(clip.id)}
              onPointerLeave={() => setHoveredClipId(null)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onRemoveClip(track.id, clip.id);
              }}
              title={clip.label || clip.src}
            >
              <TrimHandle
                side="left"
                clip={clip}
                pps={pps}
                trackId={track.id}
                prevClipEnd={prevClipEnd}
                nextClipStart={nextClipStart}
                onTrimCommit={handleTrimCommit}
                onTrimPreview={handleTrimPreview}
              />
              {clip.type === "video" && (
                <ClipThumbnail src={clip.src} />
              )}
              {clip.type === "video" && (
                <div className="cinema-timeline__clip-overlay" />
              )}
              {track.type === "audio" && (
                <ClipWaveform src={clip.src} clipId={clip.id} />
              )}
              <span className="cinema-timeline__clip-label">
                {clip.label || (clip.type === "image" ? "IMG" : clip.type === "audio" ? "AUD" : "VID")}
              </span>
              {track.type === "audio" && (
                <ClipVolumeControl clip={clip} trackId={track.id} onVolumeChange={onClipVolumeChange} />
              )}
              <TrimHandle
                side="right"
                clip={clip}
                pps={pps}
                trackId={track.id}
                prevClipEnd={prevClipEnd}
                nextClipStart={nextClipStart}
                onTrimCommit={handleTrimCommit}
                onTrimPreview={handleTrimPreview}
              />
            </div>
          );
        })}
        {ghostPos && (
          <div
            className="cinema-timeline__clip-ghost"
            style={{ left: ghostPos.left, width: ghostPos.width }}
          />
        )}
        {trackSnapLines.map((snap, i) => (
          <div
            key={`snap-${i}`}
            className="cinema-timeline__snap-line"
            style={{ left: snap.time * pps }}
          />
        ))}
        {dragOverTrack && externalGhostLeft !== null && (
          <div
            className="cinema-timeline__clip cinema-timeline__clip--ghost"
            style={{
              left: externalGhostLeft,
              width: Math.max(5 * pps, 20),
            }}
          />
        )}
        {ghostPreview && !dragOverTrack && (
          <div
            className="cinema-timeline__clip cinema-timeline__clip--ghost"
            style={{
              left: ghostPreview.startOffset * pps,
              width: Math.max(ghostPreview.duration * pps, 4),
            }}
          >
            <span className="cinema-timeline__clip-label">
              {ghostPreview.label || "Clip"}
            </span>
          </div>
        )}
        {track.clips.length === 0 && !ghostPreview && !dragOverTrack && !ghostPos && (
          <div className="cinema-timeline__track-empty">
            Drop {track.type} here
          </div>
        )}
      </div>
    </div>
  );
}

function AddTrackButton({ onAddTrack }: { onAddTrack: (trackType: "video" | "audio") => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const btnRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: PointerEvent) => {
      if (btnRef.current && !btnRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("pointerdown", handler);
    return () => window.removeEventListener("pointerdown", handler);
  }, [menuOpen]);

  return (
    <div className="cinema-timeline__add-track" ref={btnRef}>
      <button
        className="cinema-timeline__add-track-btn"
        onClick={() => setMenuOpen((v) => !v)}
        title="Add track"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="3" width="20" height="5" rx="1" />
          <rect x="2" y="12" width="20" height="5" rx="1" />
          <line x1="12" y1="19" x2="12" y2="23" />
          <line x1="10" y1="21" x2="14" y2="21" />
        </svg>
      </button>
      {menuOpen && (
        <div className="cinema-timeline__add-track-menu">
          <button onClick={() => { onAddTrack("video"); setMenuOpen(false); }}>
            V &mdash; Video Track
          </button>
          <button onClick={() => { onAddTrack("audio"); setMenuOpen(false); }}>
            A &mdash; Audio Track
          </button>
        </div>
      )}
    </div>
  );
}

export const CinemaTimeline = memo(function CinemaTimeline({
  timeline,
  currentTimeRef,
  isPlaying,
  onScrubSeek,
  onScrubEnd,
  onMoveClip,
  onTrimClipCommit,
  onRemoveClip,
  onDropClipFromCanvas,
  onDragClipOut,
  onClipVolumeChange,
  onAddTrack,
  onRemoveTrack,
  onZoomChange: _onZoomChange,
  zoomLevel,
  incomingDragPreview,
  onTargetTrackChange,
  snapLines,
}: CinemaTimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const timelineContainerRef = useRef<HTMLDivElement>(null);
  const totalDuration = getTotalDuration(timeline);
  const [rulerWidth, setRulerWidth] = useState(800);
  const [selectedClip, setSelectedClip] = useState<{ trackId: string; clipId: string } | null>(null);
  const selectedClipRef = useRef(selectedClip);
  selectedClipRef.current = selectedClip;

  const handleSelectClip = useCallback(
    (trackId: string, clipId: string | null) => {
      setSelectedClip(clipId ? { trackId, clipId } : null);
      if (clipId) timelineContainerRef.current?.focus();
    },
    []
  );

  const animZoomRef = useRef(zoomLevel);
  const animFrameRef = useRef<number | null>(null);
  const [renderZoom, setRenderZoom] = useState(zoomLevel);

  useEffect(() => {
    if (Math.abs(animZoomRef.current - zoomLevel) < 0.001) {
      animZoomRef.current = zoomLevel;
      setRenderZoom(zoomLevel);
      return;
    }

    const animate = () => {
      const diff = zoomLevel - animZoomRef.current;
      if (Math.abs(diff) < 0.001) {
        animZoomRef.current = zoomLevel;
        setRenderZoom(zoomLevel);
        animFrameRef.current = null;
        return;
      }
      animZoomRef.current += diff * 0.3;
      setRenderZoom(animZoomRef.current);
      animFrameRef.current = requestAnimationFrame(animate);
    };

    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    animFrameRef.current = requestAnimationFrame(animate);

    return () => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
    };
  }, [zoomLevel]);

  const pps = BASE_PPS * renderZoom;

  const tracksContainerRef = useRef<HTMLDivElement>(null);
  const onTargetTrackChangeRef = useRef(onTargetTrackChange);
  onTargetTrackChangeRef.current = onTargetTrackChange;

  const { hoveredTrackId, hoveredDropTime } = useMemo(() => {
    if (!incomingDragPreview) return { hoveredTrackId: null, hoveredDropTime: null };
    const targetTrackType = incomingDragPreview.mediaType === "audio" ? "audio" : "video";
    const matchingTracks = timeline.tracks.filter((t) => t.type === targetTrackType);
    if (matchingTracks.length === 0) return { hoveredTrackId: null, hoveredDropTime: null };

    let trackId = matchingTracks[0].id;
    if (matchingTracks.length > 1 && incomingDragPreview.screenY != null) {
      const container = tracksContainerRef.current;
      if (container) {
        let closestDist = Infinity;
        for (const t of matchingTracks) {
          const el = container.querySelector(`[data-track-id="${t.id}"]`);
          if (!el) continue;
          const rect = el.getBoundingClientRect();
          const mid = rect.top + rect.height / 2;
          const dist = Math.abs(incomingDragPreview.screenY - mid);
          if (dist < closestDist) {
            closestDist = dist;
            trackId = t.id;
          }
        }
      }
    }

    let dropTime: number | null = null;
    if (incomingDragPreview.screenX != null) {
      const scroll = scrollRef.current;
      if (scroll) {
        const scrollRect = scroll.getBoundingClientRect();
        const scale = scroll.clientWidth > 0 ? scrollRect.width / scroll.clientWidth : 1;
        const x = (incomingDragPreview.screenX - scrollRect.left) / scale + scroll.scrollLeft - TRACK_GUTTER;
        dropTime = Math.max(0, x / pps);
      }
    }

    return { hoveredTrackId: trackId, hoveredDropTime: dropTime };
  }, [incomingDragPreview, timeline.tracks, pps]);

  useEffect(() => {
    onTargetTrackChangeRef.current?.(hoveredTrackId, hoveredDropTime);
  }, [hoveredTrackId, hoveredDropTime]);

  useEffect(() => {
    const el = timelineContainerRef.current;
    if (!el) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Delete" || e.key === "Backspace") {
        const sel = selectedClipRef.current;
        if (sel) {
          e.preventDefault();
          e.stopPropagation();
          onRemoveClip(sel.trackId, sel.clipId);
          setSelectedClip(null);
        }
      } else if (e.key === "Escape") {
        setSelectedClip(null);
      }
    };
    el.addEventListener("keydown", handleKeyDown);
    return () => el.removeEventListener("keydown", handleKeyDown);
  }, [onRemoveClip]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setRulerWidth(entry.contentRect.width);
      }
    });
    ro.observe(el);
    setRulerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const isScrubbing = useRef(false);

  let ghostEndTime = 0;
  if (incomingDragPreview && hoveredTrackId) {
    const defaultDur = incomingDragPreview.mediaType === "image" ? 3 : 5;
    const ghostDur = (Number.isFinite(incomingDragPreview.duration) && (incomingDragPreview.duration as number) > 0)
      ? incomingDragPreview.duration as number
      : defaultDur;
    const hoveredTrack = timeline.tracks.find((t) => t.id === hoveredTrackId);
    if (hoveredTrack) {
      let ghostStart: number;
      if (hoveredDropTime != null) {
        ghostStart = hoveredDropTime;
      } else {
        const lastClip = hoveredTrack.clips[hoveredTrack.clips.length - 1];
        ghostStart = lastClip ? lastClip.startOffset + getEffectiveDuration(lastClip) : 0;
      }
      ghostEndTime = ghostStart + ghostDur;
    }
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const blockWheel = (e: WheelEvent) => {
      e.stopPropagation();
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
      }
    };
    el.addEventListener("wheel", blockWheel, { passive: false });
    return () => el.removeEventListener("wheel", blockWheel);
  }, []);

  const clientXToTime = useCallback(
    (clientX: number) => {
      const scroll = scrollRef.current;
      if (!scroll) return 0;
      const scrollRect = scroll.getBoundingClientRect();
      const scale = scroll.clientWidth > 0 ? scrollRect.width / scroll.clientWidth : 1;
      const x = (clientX - scrollRect.left) / scale + scroll.scrollLeft - TRACK_GUTTER;
      return Math.max(0, x / pps);
    },
    [pps]
  );

  const handleRulerPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      onScrubSeek(clientXToTime(e.clientX));
      isScrubbing.current = true;

      const onMove = (ev: PointerEvent) => {
        if (!isScrubbing.current) return;
        onScrubSeek(clientXToTime(ev.clientX));
      };
      const onUp = () => {
        isScrubbing.current = false;
        onScrubEnd();
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [clientXToTime, onScrubSeek, onScrubEnd]
  );

  const effectiveDuration = Math.max(totalDuration, ghostEndTime);
  return (
    <div className="cinema-timeline" ref={timelineContainerRef} tabIndex={-1} onPointerDown={(e) => e.stopPropagation()}>
      <div
        className="cinema-timeline__ruler-area"
        ref={scrollRef}
        onPointerDown={(e) => { setSelectedClip(null); handleRulerPointerDown(e); }}
      >
        <RulerTicks pps={pps} containerWidth={rulerWidth} />
        <Playhead currentTimeRef={currentTimeRef} pps={pps} isPlaying={isPlaying} className="cinema-timeline__playhead cinema-timeline__playhead--ruler" />
      </div>
      <div className="cinema-timeline__tracks-wrapper">
        <div className="cinema-timeline__tracks" ref={tracksContainerRef}>
          {timeline.tracks.map((track) => {
            const sameTypeTracks = timeline.tracks.filter((t) => t.type === track.type);
            let ghostPreview: { startOffset: number; duration: number; label: string } | undefined;
            if (incomingDragPreview) {
              const targetTrackType = incomingDragPreview.mediaType === "audio" ? "audio" : "video";
              if (track.type === targetTrackType && track.id === hoveredTrackId) {
                const defaultDur = incomingDragPreview.mediaType === "image" ? 3 : 5;
                const dur = (Number.isFinite(incomingDragPreview.duration) && (incomingDragPreview.duration as number) > 0)
                  ? incomingDragPreview.duration as number
                  : defaultDur;
                let startOffset: number;
                if (hoveredDropTime != null) {
                  startOffset = hoveredDropTime;
                } else {
                  const lastClip = track.clips[track.clips.length - 1];
                  startOffset = lastClip ? lastClip.startOffset + getEffectiveDuration(lastClip) : 0;
                }
                const defaultLabel = incomingDragPreview.mediaType === "image" ? "IMG" : incomingDragPreview.mediaType === "audio" ? "AUD" : "VID";
                ghostPreview = { startOffset, duration: dur, label: incomingDragPreview.label || defaultLabel };
              }
            }
            return (
            <TrackLane
              key={track.id}
              track={track}
              trackLabel={getTrackLabel(timeline, track)}
              pps={pps}
              onMoveClip={onMoveClip}
              onTrimClipCommit={onTrimClipCommit}
              onRemoveClip={onRemoveClip}
              onDropClipFromCanvas={onDropClipFromCanvas}
              onDragClipOut={onDragClipOut}
              onClipVolumeChange={onClipVolumeChange}
              onRemoveTrack={onRemoveTrack}
              canRemoveTrack={sameTypeTracks.length > 1}
              totalDuration={effectiveDuration}
              ghostPreview={ghostPreview}
              snapLines={snapLines}
              selectedClipId={selectedClip?.trackId === track.id ? selectedClip.clipId : null}
              onSelectClip={handleSelectClip}
            />
            );
          })}
          <AddTrackButton onAddTrack={onAddTrack} />
        </div>
        <Playhead currentTimeRef={currentTimeRef} pps={pps} isPlaying={isPlaying} className="cinema-timeline__playhead" />
      </div>
    </div>
  );
});
