import { memo, useRef, useEffect, useCallback } from "react";
import type { TimelineClip } from "../helpers/timelineState";

interface VideoFrameMetadata {
  presentationTime: number;
  expectedDisplayTime: number;
  width: number;
  height: number;
  mediaTime: number;
  presentedFrames: number;
  processingDuration?: number;
}

interface VideoFrameCallbackHandle extends HTMLVideoElement {
  requestVideoFrameCallback(callback: (now: number, metadata: VideoFrameMetadata) => void): number;
  cancelVideoFrameCallback(handle: number): void;
}

type CinemaViewerProps = {
  activeClip: TimelineClip | null;
  activeAudioClips: TimelineClip[];
  isPlaying: boolean;
  currentTimeRef: React.RefObject<number>;
  seekVersion: number;
  volume: number;
};

type AudioSlot = {
  el: HTMLAudioElement;
  clipId: string | null;
  src: string | null;
};

const DRIFT_THRESHOLD_PLAYING = 0.3;
const DRIFT_THRESHOLD_PAUSED = 0.05;
const SEEKING_TIMEOUT_MS = 200;
const SCRUB_THROTTLE_MS = 50;

const hasRVFC = typeof HTMLVideoElement !== "undefined" && "requestVideoFrameCallback" in HTMLVideoElement.prototype;

function supportsRVFC(video: HTMLVideoElement): video is VideoFrameCallbackHandle {
  return hasRVFC && "requestVideoFrameCallback" in video;
}

export const CinemaViewer = memo(function CinemaViewer({
  activeClip,
  activeAudioClips,
  isPlaying,
  currentTimeRef,
  seekVersion,
  volume,
}: CinemaViewerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const prevClipId = useRef<string | null>(null);
  const prevSrc = useRef<string | null>(null);
  const pendingSeek = useRef<number | null>(null);
  const videoSeekingRef = useRef(false);
  const seekingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const driftCheckRef = useRef<number | null>(null);
  const prevSeekVersion = useRef(seekVersion);

  const audioSlotsRef = useRef<AudioSlot[]>([]);
  const audioSeekingMap = useRef<Map<string, boolean>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);
  const audioDriftCheckRef = useRef<number | null>(null);
  const activeAudioClipsRef = useRef(activeAudioClips);
  activeAudioClipsRef.current = activeAudioClips;

  const scrubPendingTimeRef = useRef<number | null>(null);
  const scrubFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const markSeeking = useCallback(() => {
    videoSeekingRef.current = true;
    if (seekingTimeoutRef.current) clearTimeout(seekingTimeoutRef.current);
    seekingTimeoutRef.current = setTimeout(() => {
      videoSeekingRef.current = false;
      seekingTimeoutRef.current = null;
    }, SEEKING_TIMEOUT_MS);
  }, []);

  const clearSeeking = useCallback(() => {
    videoSeekingRef.current = false;
    if (seekingTimeoutRef.current) {
      clearTimeout(seekingTimeoutRef.current);
      seekingTimeoutRef.current = null;
    }
  }, []);

  const applySeek = useCallback((video: HTMLVideoElement, time: number) => {
    if (videoSeekingRef.current) return;
    if (video.readyState >= 2) {
      if (Math.abs(video.currentTime - time) < 0.001) return;
      markSeeking();
      video.currentTime = time;
      pendingSeek.current = null;
    } else {
      pendingSeek.current = time;
    }
  }, [markSeeking]);

  const scrubRvfcHandleRef = useRef<number | null>(null);

  const flushScrubPending = useCallback(() => {
    const pending = scrubPendingTimeRef.current;
    if (pending !== null && videoRef.current) {
      scrubPendingTimeRef.current = null;
      applySeek(videoRef.current, pending);
    }
  }, [applySeek]);

  const throttledScrubSeek = useCallback((video: HTMLVideoElement, time: number) => {
    scrubPendingTimeRef.current = time;

    if (supportsRVFC(video) && !video.paused) {
      if (scrubRvfcHandleRef.current == null) {
        scrubRvfcHandleRef.current = video.requestVideoFrameCallback(() => {
          scrubRvfcHandleRef.current = null;
          flushScrubPending();
        });
      }
      if (!scrubFallbackTimerRef.current) {
        scrubFallbackTimerRef.current = setTimeout(() => {
          scrubFallbackTimerRef.current = null;
          if (scrubRvfcHandleRef.current != null && videoRef.current && supportsRVFC(videoRef.current)) {
            videoRef.current.cancelVideoFrameCallback(scrubRvfcHandleRef.current);
            scrubRvfcHandleRef.current = null;
          }
          flushScrubPending();
        }, SCRUB_THROTTLE_MS * 2);
      }
    } else {
      if (!scrubFallbackTimerRef.current) {
        scrubFallbackTimerRef.current = setTimeout(() => {
          scrubFallbackTimerRef.current = null;
          flushScrubPending();
        }, SCRUB_THROTTLE_MS);
      }
    }
  }, [applySeek, flushScrubPending]);

  const handleCanPlay = useCallback(() => {
    const video = videoRef.current;
    if (video && pendingSeek.current !== null) {
      const target = pendingSeek.current;
      pendingSeek.current = null;
      if (Math.abs(video.currentTime - target) < 0.001) return;
      markSeeking();
      video.currentTime = target;
    }
  }, [markSeeking]);

  const handleSeeked = useCallback(() => {
    clearSeeking();
  }, [clearSeeking]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (!activeClip || activeClip.type !== "video") {
      if (!video.paused) video.pause();
      return;
    }

    const time = currentTimeRef.current;
    const clipLocalTime = activeClip.trimStart + (time - activeClip.startOffset);
    const srcChanged = prevClipId.current !== activeClip.id || prevSrc.current !== activeClip.src;
    const userSeeked = prevSeekVersion.current !== seekVersion;
    prevSeekVersion.current = seekVersion;

    if (srcChanged) {
      pendingSeek.current = clipLocalTime;
      clearSeeking();
      video.src = activeClip.src;
      video.load();
      prevClipId.current = activeClip.id;
      prevSrc.current = activeClip.src;
      if (isPlaying) {
        video.play().catch(() => {});
      }
      return;
    }

    if (userSeeked) {
      if (!isPlaying) {
        throttledScrubSeek(video, clipLocalTime);
      } else {
        applySeek(video, clipLocalTime);
      }
    }

    if (!isPlaying) {
      if (!video.paused) {
        video.pause();
      }
      if (!userSeeked) {
        const drift = Math.abs(video.currentTime - clipLocalTime);
        if (drift > DRIFT_THRESHOLD_PAUSED) {
          applySeek(video, clipLocalTime);
        }
      }
    } else {
      if (video.paused) {
        const drift = Math.abs(video.currentTime - clipLocalTime);
        if (drift > DRIFT_THRESHOLD_PAUSED) {
          applySeek(video, clipLocalTime);
        }
        video.play().catch(() => {});
      }
    }
  }, [activeClip, isPlaying, seekVersion, applySeek, throttledScrubSeek, clearSeeking, currentTimeRef]);

  useEffect(() => {
    if (!isPlaying || !activeClip || activeClip.type !== "video") {
      if (driftCheckRef.current) {
        const video = videoRef.current;
        if (video && supportsRVFC(video)) {
          video.cancelVideoFrameCallback(driftCheckRef.current);
        } else {
          cancelAnimationFrame(driftCheckRef.current);
        }
        driftCheckRef.current = null;
      }
      return;
    }

    const clip = activeClip;
    const video = videoRef.current;

    if (video && supportsRVFC(video)) {
      const checkDriftRVFC = (_now: number, _meta: VideoFrameMetadata) => {
        if (video && !videoSeekingRef.current && !video.seeking) {
          const time = currentTimeRef.current;
          const clipLocalTime = clip.trimStart + (time - clip.startOffset);
          const drift = Math.abs(video.currentTime - clipLocalTime);
          if (drift > DRIFT_THRESHOLD_PLAYING) {
            applySeek(video, clipLocalTime);
          }
        }
        if (supportsRVFC(video)) {
          driftCheckRef.current = video.requestVideoFrameCallback(checkDriftRVFC);
        }
      };

      driftCheckRef.current = video.requestVideoFrameCallback(checkDriftRVFC);

      return () => {
        if (driftCheckRef.current != null && video && supportsRVFC(video)) {
          video.cancelVideoFrameCallback(driftCheckRef.current);
          driftCheckRef.current = null;
        }
      };
    }

    const checkDrift = () => {
      const v = videoRef.current;
      if (v && !videoSeekingRef.current && !v.seeking) {
        const time = currentTimeRef.current;
        const clipLocalTime = clip.trimStart + (time - clip.startOffset);
        const drift = Math.abs(v.currentTime - clipLocalTime);
        if (drift > DRIFT_THRESHOLD_PLAYING) {
          applySeek(v, clipLocalTime);
        }
      }
      driftCheckRef.current = requestAnimationFrame(checkDrift);
    };

    driftCheckRef.current = requestAnimationFrame(checkDrift);

    return () => {
      if (driftCheckRef.current) {
        cancelAnimationFrame(driftCheckRef.current);
        driftCheckRef.current = null;
      }
    };
  }, [isPlaying, activeClip, applySeek, currentTimeRef]);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.muted = true;
    }
  }, [activeClip]);

  useEffect(() => {
    const slots = audioSlotsRef.current;
    const activeIds = new Set(activeAudioClips.map((c) => c.id));

    for (const slot of slots) {
      if (slot.clipId && !activeIds.has(slot.clipId)) {
        if (!slot.el.paused) slot.el.pause();
        audioSeekingMap.current.delete(slot.clipId);
        slot.clipId = null;
        slot.src = null;
      }
    }

    for (const clip of activeAudioClips) {
      let slot = slots.find((s) => s.clipId === clip.id);
      if (!slot) {
        slot = slots.find((s) => s.clipId === null);
        if (!slot) {
          const el = document.createElement("audio");
          el.preload = "auto";
          el.style.display = "none";
          containerRef.current?.appendChild(el);
          slot = { el, clipId: null, src: null };
          slots.push(slot);
        }
      }

      const time = currentTimeRef.current;
      const clipLocalTime = clip.trimStart + (time - clip.startOffset);
      const srcChanged = slot.clipId !== clip.id || slot.src !== clip.src;

      if (srcChanged) {
        audioSeekingMap.current.set(clip.id, false);
        slot.el.src = clip.src;
        slot.el.load();
        slot.clipId = clip.id;
        slot.src = clip.src;
        const seekTime = clipLocalTime;
        const slotClipId = clip.id;
        const slotEl = slot.el;
        const onCanPlay = () => {
          slotEl.removeEventListener("canplay", onCanPlay);
          if (Math.abs(slotEl.currentTime - seekTime) < 0.001) return;
          audioSeekingMap.current.set(slotClipId, true);
          slotEl.currentTime = seekTime;
          slotEl.addEventListener("seeked", () => {
            audioSeekingMap.current.set(slotClipId, false);
          }, { once: true });
        };
        slot.el.addEventListener("canplay", onCanPlay);
        if (isPlaying) {
          slot.el.play().catch(() => {});
        }
        continue;
      }

      const isSeeking = audioSeekingMap.current.get(clip.id) ?? false;

      if (isSeeking && !slot.el.seeking) {
        audioSeekingMap.current.set(clip.id, false);
      }

      if (!isSeeking && !slot.el.seeking) {
        const drift = Math.abs(slot.el.currentTime - clipLocalTime);
        const threshold = isPlaying ? DRIFT_THRESHOLD_PLAYING : DRIFT_THRESHOLD_PAUSED;
        if (drift > threshold && slot.el.readyState >= 2) {
          if (Math.abs(slot.el.currentTime - clipLocalTime) >= 0.001) {
            audioSeekingMap.current.set(clip.id, true);
            slot.el.currentTime = clipLocalTime;
            const slotClipId = clip.id;
            slot.el.addEventListener("seeked", () => {
              audioSeekingMap.current.set(slotClipId, false);
            }, { once: true });
          }
        }
      }

      if (!isPlaying) {
        if (!slot.el.paused) {
          slot.el.pause();
        }
      } else {
        if (slot.el.paused) {
          slot.el.play().catch(() => {});
        }
      }
    }
  }, [activeAudioClips, isPlaying, seekVersion, currentTimeRef]);

  useEffect(() => {
    if (!isPlaying) {
      if (audioDriftCheckRef.current) {
        cancelAnimationFrame(audioDriftCheckRef.current);
        audioDriftCheckRef.current = null;
      }
      return;
    }

    const checkAudioDrift = () => {
      const slots = audioSlotsRef.current;
      const clips = activeAudioClipsRef.current;
      const time = currentTimeRef.current;

      for (const clip of clips) {
        const slot = slots.find((s) => s.clipId === clip.id);
        if (!slot) continue;

        const isSeeking = audioSeekingMap.current.get(clip.id) ?? false;
        if (isSeeking || slot.el.seeking) continue;

        const clipLocalTime = clip.trimStart + (time - clip.startOffset);
        const drift = Math.abs(slot.el.currentTime - clipLocalTime);
        if (drift > DRIFT_THRESHOLD_PLAYING && slot.el.readyState >= 2) {
          audioSeekingMap.current.set(clip.id, true);
          slot.el.currentTime = clipLocalTime;
          const slotClipId = clip.id;
          slot.el.addEventListener("seeked", () => {
            audioSeekingMap.current.set(slotClipId, false);
          }, { once: true });
        }
      }

      audioDriftCheckRef.current = requestAnimationFrame(checkAudioDrift);
    };

    audioDriftCheckRef.current = requestAnimationFrame(checkAudioDrift);

    return () => {
      if (audioDriftCheckRef.current) {
        cancelAnimationFrame(audioDriftCheckRef.current);
        audioDriftCheckRef.current = null;
      }
    };
  }, [isPlaying, currentTimeRef]);

  useEffect(() => {
    for (const slot of audioSlotsRef.current) {
      const clip = activeAudioClips.find((c) => c.id === slot.clipId);
      const clipVol = clip ? clip.volume : 1;
      slot.el.volume = Math.max(0, Math.min(1, volume * clipVol));
    }
  }, [volume, activeAudioClips]);

  useEffect(() => {
    return () => {
      if (seekingTimeoutRef.current) clearTimeout(seekingTimeoutRef.current);
      if (driftCheckRef.current) cancelAnimationFrame(driftCheckRef.current);
      if (audioDriftCheckRef.current) cancelAnimationFrame(audioDriftCheckRef.current);
      if (scrubFallbackTimerRef.current) clearTimeout(scrubFallbackTimerRef.current);
      const video = videoRef.current;
      if (scrubRvfcHandleRef.current != null && video && supportsRVFC(video)) {
        video.cancelVideoFrameCallback(scrubRvfcHandleRef.current);
      }
      for (const slot of audioSlotsRef.current) {
        slot.el.pause();
        slot.el.removeAttribute("src");
        slot.el.remove();
      }
      audioSlotsRef.current = [];
    };
  }, []);

  const showEmpty = !activeClip;
  const showImage = activeClip?.type === "image";
  const showVideo = activeClip?.type === "video";

  return (
    <div className="cinema-viewer" ref={containerRef} onPointerDown={(e) => e.stopPropagation()}>
      {showEmpty && (
        <div className="cinema-viewer__empty">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.4">
            <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" />
            <line x1="7" y1="2" x2="7" y2="22" />
            <line x1="17" y1="2" x2="17" y2="22" />
            <line x1="2" y1="12" x2="22" y2="12" />
            <line x1="2" y1="7" x2="7" y2="7" />
            <line x1="2" y1="17" x2="7" y2="17" />
            <line x1="17" y1="7" x2="22" y2="7" />
            <line x1="17" y1="17" x2="22" y2="17" />
          </svg>
          <span style={{ opacity: 0.5, fontSize: 12, marginTop: 8 }}>Drop clips to begin</span>
        </div>
      )}

      {showImage && (
        <img
          src={activeClip.src}
          alt={activeClip.label || ""}
          className="cinema-viewer__media"
          draggable={false}
        />
      )}

      <video
        ref={videoRef}
        className="cinema-viewer__media"
        style={{ display: showVideo ? "block" : "none" }}
        muted
        playsInline
        preload="auto"
        onCanPlay={handleCanPlay}
        onSeeked={handleSeeked}
      />
    </div>
  );
});
