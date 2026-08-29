import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import type { TimelineState, TimelineClip } from "../helpers/timelineState";
import { getTotalDuration, getActiveClipAtTime } from "../helpers/timelineState";

export type PlaybackState = {
  isPlaying: boolean;
  currentTime: number;
  currentTimeRef: React.RefObject<number>;
  seekVersion: number;
  volume: number;
  totalDuration: number;
};

function findActiveVideoClip(timeline: TimelineState, time: number): TimelineClip | null {
  for (const track of timeline.tracks) {
    if (track.type === "video") {
      const clip = getActiveClipAtTime(track, time);
      if (clip) return clip;
    }
  }
  return null;
}

function findActiveAudioClips(timeline: TimelineState, time: number): TimelineClip[] {
  const result: TimelineClip[] = [];
  for (const track of timeline.tracks) {
    if (track.type === "audio") {
      const clip = getActiveClipAtTime(track, time);
      if (clip) result.push(clip);
    }
  }
  return result;
}

export function usePlaybackState(
  timeline: TimelineState,
  onPlayheadChange?: (time: number) => void
) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(timeline.playheadPosition);
  const [volume, setVolume] = useState(0.8);
  const [seekVersion, setSeekVersion] = useState(0);
  const animRef = useRef<number | null>(null);
  const lastFrameRef = useRef<number>(0);
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;
  const onPlayheadChangeRef = useRef(onPlayheadChange);
  onPlayheadChangeRef.current = onPlayheadChange;
  const loopingRef = useRef(timeline.looping);
  loopingRef.current = timeline.looping;
  const currentTimeRef = useRef(currentTime);
  const isPlayingRef = useRef(false);
  const prevPlayheadRef = useRef(timeline.playheadPosition);
  const activeVideoClipIdRef = useRef<string | null>(null);
  const activeAudioClipIdsRef = useRef<string>("");

  useEffect(() => {
    if (!isPlayingRef.current && timeline.playheadPosition !== prevPlayheadRef.current) {
      prevPlayheadRef.current = timeline.playheadPosition;
      currentTimeRef.current = timeline.playheadPosition;
      setCurrentTime(timeline.playheadPosition);
    }
  }, [timeline.playheadPosition]);

  const totalDuration = getTotalDuration(timeline);

  const rawActiveClip = findActiveVideoClip(timeline, currentTime);
  const rawActiveAudioClips = findActiveAudioClips(timeline, currentTime);

  const activeClip = useMemo(() => {
    return rawActiveClip;
  }, [rawActiveClip?.id, timeline.tracks]);

  const activeAudioClips = useMemo(() => {
    return rawActiveAudioClips;
  }, [rawActiveAudioClips.map((c) => c.id).join(","), timeline.tracks]);

  useEffect(() => {
    activeVideoClipIdRef.current = activeClip?.id ?? null;
  }, [activeClip]);

  useEffect(() => {
    activeAudioClipIdsRef.current = activeAudioClips.map((c) => c.id).join(",");
  }, [activeAudioClips]);

  const play = useCallback(() => {
    const dur = getTotalDuration(timelineRef.current);
    if (dur <= 0) return;
    isPlayingRef.current = true;
    setIsPlaying(true);
    lastFrameRef.current = performance.now();
  }, []);

  const pause = useCallback(() => {
    isPlayingRef.current = false;
    setIsPlaying(false);
    setCurrentTime(currentTimeRef.current);
    onPlayheadChangeRef.current?.(currentTimeRef.current);
  }, []);

  const stop = useCallback(() => {
    isPlayingRef.current = false;
    setIsPlaying(false);
    currentTimeRef.current = 0;
    setCurrentTime(0);
    onPlayheadChangeRef.current?.(0);
  }, []);

  const seek = useCallback((time: number) => {
    const t = Math.max(0, time);
    currentTimeRef.current = t;
    setCurrentTime(t);
    setSeekVersion((v) => v + 1);
  }, []);

  const scrubThrottleRef = useRef<number>(0);
  const SCRUB_STATE_THROTTLE_MS = 100;

  const scrubSeek = useCallback((time: number) => {
    const t = Math.max(0, time);
    currentTimeRef.current = t;
    setSeekVersion((v) => v + 1);

    const tl = timelineRef.current;
    const newClip = findActiveVideoClip(tl, t);
    const newClipId = newClip?.id ?? null;
    const clipChanged = newClipId !== activeVideoClipIdRef.current;

    const now = performance.now();
    if (clipChanged || now - scrubThrottleRef.current >= SCRUB_STATE_THROTTLE_MS) {
      scrubThrottleRef.current = now;
      setCurrentTime(t);
    }
  }, []);

  const commitScrubTime = useCallback(() => {
    setCurrentTime(currentTimeRef.current);
  }, []);

  const pendingStopRef = useRef(false);

  useEffect(() => {
    if (!isPlaying) {
      if (animRef.current) {
        cancelAnimationFrame(animRef.current);
        animRef.current = null;
      }
      return;
    }

    const tick = (now: number) => {
      const delta = (now - lastFrameRef.current) / 1000;
      lastFrameRef.current = now;

      const tl = timelineRef.current;
      const dur = getTotalDuration(tl);
      let next = currentTimeRef.current + delta;

      if (next >= dur) {
        if (loopingRef.current) {
          next = next % dur;
        } else {
          next = dur;
          currentTimeRef.current = next;
          setCurrentTime(next);
          pendingStopRef.current = true;
          onPlayheadChangeRef.current?.(next);
          return;
        }
      }

      currentTimeRef.current = next;

      const newVideoClip = findActiveVideoClip(tl, next);
      const newVideoClipId = newVideoClip?.id ?? null;
      const newAudioClips = findActiveAudioClips(tl, next);
      const newAudioIds = newAudioClips.map((c) => c.id).join(",");

      const clipBoundaryChanged =
        newVideoClipId !== activeVideoClipIdRef.current ||
        newAudioIds !== activeAudioClipIdsRef.current;

      if (clipBoundaryChanged) {
        setCurrentTime(next);
      }

      animRef.current = requestAnimationFrame(tick);
    };

    lastFrameRef.current = performance.now();
    animRef.current = requestAnimationFrame(tick);

    return () => {
      if (animRef.current) {
        cancelAnimationFrame(animRef.current);
        animRef.current = null;
      }
    };
  }, [isPlaying]);

  useEffect(() => {
    if (pendingStopRef.current) {
      pendingStopRef.current = false;
      isPlayingRef.current = false;
      setIsPlaying(false);
    }
  });

  return {
    isPlaying,
    currentTime,
    currentTimeRef,
    seekVersion,
    volume,
    totalDuration,
    activeClip,
    activeAudioClips,
    play,
    pause,
    stop,
    seek,
    scrubSeek,
    commitScrubTime,
    setVolume,
  };
}
