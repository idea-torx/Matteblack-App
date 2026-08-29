import { memo, useCallback, useEffect, useRef } from "react";

type CinemaToolbarProps = {
  isPlaying: boolean;
  currentTime: number;
  currentTimeRef: React.RefObject<number>;
  totalDuration: number;
  volume: number;
  zoomLevel: number;
  looping: boolean;
  canSplit: boolean;
  magneticSnap: boolean;
  onPlay: () => void;
  onPause: () => void;
  onSeek: (time: number) => void;
  onVolumeChange: (v: number) => void;
  onZoomChange: (zoom: number) => void;
  onLoopToggle: () => void;
  onSplit: () => void;
  onMagneticSnapToggle: () => void;
};

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00.0";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 10);
  return `${m}:${s.toString().padStart(2, "0")}.${ms}`;
}

export const CinemaToolbar = memo(function CinemaToolbar({
  isPlaying,
  currentTime,
  currentTimeRef,
  totalDuration,
  volume,
  zoomLevel,
  looping,
  canSplit,
  magneticSnap,
  onPlay,
  onPause,
  onSeek,
  onVolumeChange,
  onZoomChange,
  onLoopToggle,
  onSplit,
  onMagneticSnapToggle,
}: CinemaToolbarProps) {
  const timecodeElRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf: number;
    const tick = () => {
      const el = timecodeElRef.current;
      if (el) {
        const t = currentTimeRef.current;
        el.textContent = `${formatTime(t)} / ${formatTime(totalDuration)}`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [currentTimeRef, totalDuration]);

  const handleVolumeChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      e.stopPropagation();
      onVolumeChange(parseFloat(e.target.value));
    },
    [onVolumeChange]
  );

  const handleZoomChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      e.stopPropagation();
      onZoomChange(parseFloat(e.target.value));
    },
    [onZoomChange]
  );

  const handleSkipBack = useCallback(() => {
    onSeek(Math.max(0, currentTimeRef.current - 5));
  }, [onSeek, currentTimeRef]);

  const handleSkipForward = useCallback(() => {
    onSeek(Math.min(totalDuration, currentTimeRef.current + 5));
  }, [onSeek, currentTimeRef, totalDuration]);

  const handleSkipToStart = useCallback(() => {
    onSeek(0);
  }, [onSeek]);

  const handleSkipToEnd = useCallback(() => {
    onSeek(totalDuration);
  }, [onSeek, totalDuration]);

  const togglePlayPause = useCallback(() => {
    if (isPlaying) onPause();
    else onPlay();
  }, [isPlaying, onPause, onPlay]);

  useEffect(() => {
    const isTextInput = (el: HTMLElement) => {
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      if (el?.isContentEditable || el?.closest?.('[contenteditable="true"]')) return true;
      if (el?.getAttribute?.("role") === "textbox") return true;
      return false;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (isTextInput(el)) return;

      if (e.code === "Space") {
        e.preventDefault();
        e.stopPropagation();
        if (isPlaying) onPause();
        else onPlay();
        return;
      }

      if (e.code === "KeyS" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        onSplit();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isPlaying, onPause, onPlay, onSplit]);

  return (
    <div className="cinema-toolbar" onPointerDown={(e) => e.stopPropagation()}>
      <div className="cinema-toolbar__left">
        <button
          type="button"
          className={`cinema-toolbar__btn cinema-toolbar__split-btn ${canSplit ? "" : "cinema-toolbar__split-btn--disabled"}`}
          onClick={canSplit ? onSplit : undefined}
          disabled={!canSplit}
          aria-label="Split clip at playhead"
          title={canSplit ? "Split clip (S)" : "No clip under playhead"}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="6" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <line x1="20" y1="12" x2="12" y2="12" />
            <path d="M14 6l-8.5 6" />
            <path d="M14 18l-8.5-6" />
          </svg>
        </button>
        <button
          type="button"
          className={`cinema-toolbar__btn cinema-toolbar__snap-btn ${magneticSnap ? "cinema-toolbar__snap-btn--active" : ""}`}
          onClick={onMagneticSnapToggle}
          aria-label={magneticSnap ? "Disable snap" : "Enable snap"}
          title={magneticSnap ? "Snap: ON" : "Snap: OFF"}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 15a6 6 0 0 1 12 0" />
            <path d="M6 15v4" />
            <path d="M18 15v4" />
            <line x1="6" y1="19" x2="8" y2="19" />
            <line x1="16" y1="19" x2="18" y2="19" />
          </svg>
        </button>
        <div className="cinema-toolbar__time" ref={timecodeElRef}>
          {formatTime(currentTime)} / {formatTime(totalDuration)}
        </div>
      </div>

      <div className="cinema-toolbar__center">
        <button type="button" className="cinema-toolbar__btn" onClick={handleSkipToStart} aria-label="Skip to start" title="Skip to start">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <rect x="4" y="5" width="3" height="14" />
            <polygon points="20 5 10 12 20 19" />
          </svg>
        </button>
        <button type="button" className="cinema-toolbar__btn" onClick={handleSkipBack} aria-label="Skip back 5s" title="Back 5s">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="18 5 8 12 18 19" />
            <rect x="4" y="5" width="3" height="14" />
          </svg>
        </button>
        <button type="button" className="cinema-toolbar__btn cinema-toolbar__btn--play" onClick={togglePlayPause} aria-label={isPlaying ? "Pause" : "Play"}>
          {isPlaying ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="4" width="4" height="16" />
              <rect x="14" y="4" width="4" height="16" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="8 5 20 12 8 19" />
            </svg>
          )}
        </button>
        <button type="button" className="cinema-toolbar__btn" onClick={handleSkipForward} aria-label="Skip forward 5s" title="Forward 5s">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="6 5 16 12 6 19" />
            <rect x="17" y="5" width="3" height="14" />
          </svg>
        </button>
        <button type="button" className="cinema-toolbar__btn" onClick={handleSkipToEnd} aria-label="Skip to end" title="Skip to end">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="4 5 14 12 4 19" />
            <rect x="17" y="5" width="3" height="14" />
          </svg>
        </button>
        <button
          type="button"
          className={`cinema-toolbar__btn cinema-toolbar__loop-btn ${looping ? "cinema-toolbar__loop-btn--active" : ""}`}
          onClick={onLoopToggle}
          aria-label={looping ? "Disable loop" : "Enable loop"}
          title={looping ? "Loop: ON" : "Loop: OFF"}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="17 1 21 5 17 9" />
            <path d="M3 11V9a4 4 0 0 1 4-4h14" />
            <polyline points="7 23 3 19 7 15" />
            <path d="M21 13v2a4 4 0 0 1-4 4H3" />
          </svg>
        </button>
      </div>

      <div className="cinema-toolbar__right">
        <div className="cinema-toolbar__zoom" onPointerDown={(e) => e.stopPropagation()}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="range"
            min={0.01}
            max={0.3}
            step={0.005}
            value={zoomLevel}
            onChange={handleZoomChange}
            className="cinema-toolbar__zoom-slider"
            aria-label="Timeline zoom"
          />
        </div>
        <div className="cinema-toolbar__volume" onPointerDown={(e) => e.stopPropagation()}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            {volume > 0 && <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />}
            {volume > 0.5 && <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />}
          </svg>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={volume}
            onChange={handleVolumeChange}
            className="cinema-toolbar__volume-slider"
            aria-label="Volume"
          />
        </div>
      </div>
    </div>
  );
});
