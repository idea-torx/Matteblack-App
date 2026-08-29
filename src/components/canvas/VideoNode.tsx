import { useRef, useEffect, useState, memo } from "react";
import type { CanvasNode } from "../../types/canvas";
import { useVideoThumbnail } from "../../features/cinema-frame/hooks/useVideoThumbnail";

export const VideoNode = memo(function VideoNode({ node, isPlaying, onTogglePlay, isInViewport = true, zoom = 1 }: { node: CanvasNode; isPlaying: boolean; onTogglePlay: (id: string) => void; isInViewport?: boolean; zoom?: number }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isMuted, setIsMuted] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);

  const thumbnail = useVideoThumbnail(node.src || undefined);

  useEffect(() => {
    setHasLoaded(false);
    setIsBuffering(false);
  }, [node.src]);

  useEffect(() => {
    if (!isInViewport) {
      setHasLoaded(false);
      setIsBuffering(false);
    }
  }, [isInViewport]);

  useEffect(() => {
    const vid = videoRef.current;
    if (!vid) return;
    const onLoadedData = () => { setHasLoaded(true); setIsBuffering(false); };
    const onWaiting = () => setIsBuffering(true);
    const onPlaying = () => setIsBuffering(false);
    vid.addEventListener("loadeddata", onLoadedData);
    vid.addEventListener("canplay", onLoadedData);
    vid.addEventListener("waiting", onWaiting);
    vid.addEventListener("playing", onPlaying);
    return () => {
      vid.removeEventListener("loadeddata", onLoadedData);
      vid.removeEventListener("canplay", onLoadedData);
      vid.removeEventListener("waiting", onWaiting);
      vid.removeEventListener("playing", onPlaying);
    };
  }, [node.id]);

  useEffect(() => {
    const vid = videoRef.current;
    if (!vid) return;
    if (isPlaying && isInViewport && node.src) {
      vid.play().catch(() => {});
    } else {
      vid.pause();
    }
  }, [isPlaying, isInViewport, node.src]);

  useEffect(() => {
    const vid = videoRef.current;
    if (!vid) return;
    vid.muted = isMuted;
  }, [isMuted]);

  useEffect(() => {
    const vid = videoRef.current;
    if (!vid) return;
    const onTime = () => {
      setCurrentTime(vid.currentTime);
      setDuration(vid.duration || 0);
      setProgress(vid.duration ? (vid.currentTime / vid.duration) * 100 : 0);
    };
    vid.addEventListener("timeupdate", onTime);
    return () => {
      vid.removeEventListener("timeupdate", onTime);
    };
  }, [node.id]);

  const formatTime = (t: number) => {
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const hasSrc = !!node.src;

  const renderedW = (node.width || 0) * zoom;
  const renderedH = (node.height || 0) * zoom;
  const showOverlays = Math.min(renderedW, renderedH) >= 120;

  return (
    <div className="freeform-canvas__video-wrapper">
      {hasSrc ? (
        <>
          {thumbnail && !hasLoaded && (
            <img
              src={thumbnail}
              alt=""
              className="freeform-canvas__video-thumbnail"
              draggable={false}
            />
          )}
          <video
            ref={videoRef}
            className={`freeform-canvas__node-video${!hasLoaded ? " freeform-canvas__node-video--hidden" : ""}`}
            src={isInViewport ? node.src : undefined}
            muted={isMuted}
            loop
            playsInline
            preload="metadata"
            draggable={false}
          />
          {(!hasLoaded || isBuffering) && (
            <div className="freeform-canvas__video-loading-overlay">
              <div className="freeform-canvas__video-spinner" />
            </div>
          )}
        </>
      ) : (
        <div className="freeform-canvas__node-gradient" style={{ background: node.gradient }} />
      )}
      {showOverlays && (
      <div className={`freeform-canvas__video-controls ${isPlaying ? "freeform-canvas__video-controls--playing" : ""}`}>
        <button
          type="button"
          className="freeform-canvas__video-play-btn"
          onClick={(e) => { e.stopPropagation(); onTogglePlay(node.id); }}
        >
          {isPlaying ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="8 5 20 12 8 19" /></svg>
          )}
        </button>
        <div className="freeform-canvas__video-progress-bar" onClick={(e) => {
          e.stopPropagation();
          const vid = videoRef.current;
          if (!vid || !vid.duration) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const pct = (e.clientX - rect.left) / rect.width;
          vid.currentTime = pct * vid.duration;
        }}>
          <div className="freeform-canvas__video-progress-fill" style={{ width: `${progress}%` }} />
        </div>
        <span className="freeform-canvas__video-time">
          {hasSrc ? `${formatTime(currentTime)} / ${formatTime(duration)}` : (node.metadata.duration as string || "0:00")}
        </span>
        <button
          type="button"
          className="freeform-canvas__video-mute-btn"
          onClick={(e) => { e.stopPropagation(); setIsMuted((m) => !m); }}
        >
          {isMuted ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              <line x1="23" y1="9" x2="17" y2="15" />
              <line x1="17" y1="9" x2="23" y2="15" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            </svg>
          )}
        </button>
      </div>
      )}
      {showOverlays && (
      <div className={`freeform-canvas__video-play-overlay${isPlaying ? " freeform-canvas__video-play-overlay--hover-only" : ""}`} onClick={(e) => { e.stopPropagation(); onTogglePlay(node.id); }}>
        {isPlaying ? (
          <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
        ) : (
          <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor"><polygon points="8 5 20 12 8 19" /></svg>
        )}
      </div>
      )}
    </div>
  );
});
