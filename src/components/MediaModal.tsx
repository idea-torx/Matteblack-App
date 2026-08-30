import { useEffect } from "react";
import { CinemaViewer } from "../features/cinema-frame/components/CinemaViewer";
import { usePlaybackState } from "../features/cinema-frame/hooks/usePlaybackState";
import { getTotalDuration, type TimelineState } from "../features/cinema-frame/helpers/timelineState";
import "./MediaModal.css";

/**
 * The app's one full-size preview. Deliberately an in-app modal and NOT
 * element.requestFullscreen(): the native call takes over the display, drops
 * the window chrome and the traffic lights, and Escape leaves the app in a
 * state the React tree didn't ask for. A cover inside the window is the same
 * picture with none of that.
 */
export type MediaModalTarget =
  | { kind: "image" | "video" | "svg"; src: string; label?: string }
  | { kind: "cinema"; timeline: TimelineState; label?: string };

function fmt(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A cinema node is a timeline, not a file — so it plays through the same
 *  viewer the cinema frame uses rather than as a single <video src>. */
function CinemaPlayback({ timeline }: { timeline: TimelineState }) {
  const pb = usePlaybackState(timeline);
  const total = getTotalDuration(timeline);
  const { play } = pb;
  useEffect(() => { play(); }, [play]);

  return (
    <div className="media-modal__cinema" onClick={(e) => e.stopPropagation()}>
      <div className="media-modal__stage">
        <CinemaViewer
          activeClip={pb.activeClip}
          nextClip={pb.nextClip}
          activeAudioClips={pb.activeAudioClips}
          isPlaying={pb.isPlaying}
          currentTimeRef={pb.currentTimeRef}
          seekVersion={pb.seekVersion}
          volume={pb.volume}
          videoMuted={timeline.tracks.some(
            (t) => t.type === "video" && t.muted && t.clips.some((c) => c.id === pb.activeClip?.id),
          )}
        />
      </div>
      <div className="media-modal__transport">
        <button
          type="button"
          className="media-modal__play"
          aria-label={pb.isPlaying ? "Pause" : "Play"}
          onClick={() => (pb.isPlaying ? pb.pause() : pb.play())}
        >
          {pb.isPlaying ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l13-7.5z" /></svg>
          )}
        </button>
        <input
          className="media-modal__scrub"
          type="range"
          min={0}
          max={total || 1}
          step={0.01}
          value={Math.min(pb.currentTime, total || 1)}
          aria-label="Seek"
          onChange={(e) => pb.seek(Number(e.target.value))}
        />
        <span className="media-modal__time">{fmt(pb.currentTime)} / {fmt(total)}</span>
      </div>
    </div>
  );
}

export function MediaModal({ target, onClose }: { target: MediaModalTarget | null; onClose: () => void }) {
  useEffect(() => {
    if (!target) return;
    // Capture phase: the canvas has its own Escape handlers and this cover is
    // the thing on top, so it gets first refusal.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [target, onClose]);

  if (!target) return null;

  return (
    <div
      className="media-modal"
      role="dialog"
      aria-modal="true"
      aria-label={target.label || "Preview"}
      onClick={onClose}
    >
      <div className="media-modal__bar">
        <span className="media-modal__title">{target.label || ""}</span>
        <button type="button" className="media-modal__close" aria-label="Close preview" onClick={(e) => { e.stopPropagation(); onClose(); }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <div className="media-modal__body">
        {target.kind === "cinema" ? (
          <CinemaPlayback timeline={target.timeline} />
        ) : target.kind === "video" ? (
          <video
            className="media-modal__media"
            src={target.src}
            controls
            autoPlay
            playsInline
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <img
            className="media-modal__media"
            src={target.src}
            alt={target.label || "Preview"}
            onClick={(e) => e.stopPropagation()}
          />
        )}
      </div>
    </div>
  );
}
