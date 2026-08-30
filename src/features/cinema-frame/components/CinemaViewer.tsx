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
  /** The clip after this one, preloaded into the standby element. */
  nextClip?: TimelineClip | null;
  activeAudioClips: TimelineClip[];
  isPlaying: boolean;
  currentTimeRef: React.RefObject<number>;
  seekVersion: number;
  volume: number;
  /** The active clip's video track is muted — picture plays, its audio does not. */
  videoMuted?: boolean;
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
  nextClip = null,
  activeAudioClips,
  isPlaying,
  currentTimeRef,
  seekVersion,
  volume,
  videoMuted = false,
}: CinemaViewerProps) {
  // Two elements, not one. Swapping `src` on a single <video> costs a load and
  // a seek at every clip boundary, and the element paints nothing until that
  // round trip finishes — that blank is the gap between clips. The standby
  // preloads the next clip and parks on the frame the boundary will ask for,
  // so crossing it is a display toggle.
  const videoARef = useRef<HTMLVideoElement>(null);
  const videoBRef = useRef<HTMLVideoElement>(null);
  /** Whichever of the two is on screen. Everything else reads this. */
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const standbySrc = useRef<string | null>(null);
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
  // A video dropped on the timeline also gets a mirror clip on the audio track
  // (same src) so its sound can be trimmed and levelled separately. That mirror
  // must not be *played* separately — the video element is already producing it,
  // and doing both is the same waveform twice, slightly out of phase.
  const linkedAudio = activeClip
    ? activeAudioClips.find((c) => c.id === activeClip.linkedClipId || c.linkedClipId === activeClip.id) ?? null
    : null;
  const independentAudioClips = linkedAudio
    ? activeAudioClips.filter((c) => c.id !== linkedAudio.id)
    : activeAudioClips;

  const activeAudioClipsRef = useRef(independentAudioClips);
  activeAudioClipsRef.current = independentAudioClips;

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

  const handleCanPlay = useCallback((e: React.SyntheticEvent<HTMLVideoElement>) => {
    const video = videoRef.current;
    // The standby element fires this too; it does its own parking seek.
    if (video && e.currentTarget === video && pendingSeek.current !== null) {
      const target = pendingSeek.current;
      pendingSeek.current = null;
      if (Math.abs(video.currentTime - target) < 0.001) return;
      markSeeking();
      video.currentTime = target;
    }
  }, [markSeeking]);

  const handleSeeked = useCallback((e: React.SyntheticEvent<HTMLVideoElement>) => {
    if (e.currentTarget === videoRef.current) clearSeeking();
  }, [clearSeeking]);

  useEffect(() => {
    if (!videoRef.current) videoRef.current = videoARef.current;
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
      const standby = video === videoARef.current ? videoBRef.current : videoARef.current;
      // Primed = this exact clip, decoded, already sitting on the right frame.
      // Promote it; a seek here would put the gap straight back.
      if (
        standby &&
        standbySrc.current === activeClip.src &&
        standby.readyState >= 2 &&
        Math.abs(standby.currentTime - clipLocalTime) < 0.1
      ) {
        standbySrc.current = null;
        videoRef.current = standby;
        clearSeeking();
        pendingSeek.current = null;
        standby.style.display = "block";
        video.style.display = "none";
        // Mute before pausing. Chromium ramps the audio down over ~20ms when a
        // media element pauses, and ramps up again when the next one starts —
        // that V is the dip you hear at every cut. Muting is instant, so the
        // ramp runs on silence.
        video.muted = true;
        video.pause();
        // Level the incoming element here rather than leaving it to the volume
        // effect below: it was primed muted, and an extra effect hop is another
        // slice of silence at the exact moment the cut lands.
        const clipLevel = linkedAudio ? linkedAudio.volume : activeClip.volume ?? 1;
        const level = videoMuted ? 0 : Math.max(0, Math.min(1, volume * clipLevel));
        standby.volume = level;
        standby.muted = level === 0;
        prevClipId.current = activeClip.id;
        prevSrc.current = activeClip.src;
        if (isPlaying) standby.play().catch(() => {});
        return;
      }

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

  // Visibility is imperative on purpose: promoting the standby swaps the two
  // elements inside the effect above, and a React state round trip would land a
  // frame later — which is the gap all of this exists to remove. This settles
  // the pair on every clip change; the promotion sets them directly.
  useEffect(() => {
    const front = videoRef.current;
    const visible = activeClip?.type === "video";
    for (const el of [videoARef.current, videoBRef.current]) {
      if (el) el.style.display = visible && el === front ? "block" : "none";
    }
  }, [activeClip]);

  // Prime the standby with the next clip while this one is still playing.
  useEffect(() => {
    const front = videoRef.current;
    const standby = front === videoARef.current ? videoBRef.current : videoARef.current;
    if (!standby || !nextClip || nextClip.type !== "video" || !nextClip.src) return;
    if (standbySrc.current === nextClip.src) return;

    standbySrc.current = nextClip.src;
    standby.muted = true;
    standby.src = nextClip.src;
    standby.load();
    const seekTo = nextClip.trimStart;
    let cancelled = false;
    const onCanPlay = async () => {
      standby.removeEventListener("canplay", onCanPlay);
      // Warm it. The first play() on an element that has never played builds an
      // audio renderer and an output stream — tens of milliseconds, spent at the
      // cut, where they read as lag and a dropout. Doing it here, muted and
      // hidden, makes the play() at the boundary a resume instead.
      try {
        await standby.play();
      } catch {
        /* autoplay refusal: the boundary play() is no worse off than before */
      }
      standby.pause();
      if (cancelled) return;
      // Park on the frame the boundary will ask for, so promotion is a toggle.
      if (Math.abs(standby.currentTime - seekTo) > 0.001) standby.currentTime = seekTo;
    };
    standby.addEventListener("canplay", onCanPlay);
    return () => {
      cancelled = true;
      standby.removeEventListener("canplay", onCanPlay);
    };
  }, [nextClip, activeClip]);

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

  // Video clips carry their own audio; hard-muting them meant the only sound
  // the frame could ever make came from clips on the audio track — and an
  // agent-built timeline has none, so it was silent. The mirror clip's own
  // volume steers the video element, which is what the user is adjusting.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const clipLevel = linkedAudio ? linkedAudio.volume : (activeClip?.volume ?? 1);
    // Track mute overrides the clip's own level without overwriting it, so
    // unmuting restores whatever mix the user had set.
    const level = videoMuted ? 0 : Math.max(0, Math.min(1, volume * clipLevel));
    v.volume = level;
    v.muted = level === 0;
  }, [activeClip, linkedAudio, volume, videoMuted]);

  useEffect(() => {
    const slots = audioSlotsRef.current;
    const activeIds = new Set(independentAudioClips.map((c) => c.id));

    for (const slot of slots) {
      if (slot.clipId && !activeIds.has(slot.clipId)) {
        if (!slot.el.paused) slot.el.pause();
        audioSeekingMap.current.delete(slot.clipId);
        slot.clipId = null;
        slot.src = null;
      }
    }

    for (const clip of independentAudioClips) {
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
  }, [independentAudioClips, isPlaying, seekVersion, currentTimeRef]);

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

      {/* display is owned by the effects above, not by React — the constant
          style object is applied on mount and never re-applied. */}
      <video ref={videoARef} className="cinema-viewer__media" style={{ display: "none" }} playsInline preload="auto" onCanPlay={handleCanPlay} onSeeked={handleSeeked} />
      <video ref={videoBRef} className="cinema-viewer__media" style={{ display: "none" }} playsInline preload="auto" onCanPlay={handleCanPlay} onSeeked={handleSeeked} />
    </div>
  );
});
