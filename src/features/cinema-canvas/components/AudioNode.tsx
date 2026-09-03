import { useRef, useState, useEffect, useCallback, memo } from "react";
import WaveSurfer from "wavesurfer.js";
import type { CanvasNode } from "../../../types/canvas";

type AudioSubtype = "tts" | "music" | "sfx" | "voice";

const SUBTYPE_LABELS: Record<AudioSubtype, string> = {
  tts: "TTS",
  music: "Music",
  sfx: "SFX",
  voice: "Voice",
};

function getSubtype(node: CanvasNode): AudioSubtype {
  const raw = (node.metadata?.audioSubtype as string) || "music";
  if (raw in SUBTYPE_LABELS) return raw as AudioSubtype;
  return "music";
}

function formatTime(t: number): string {
  if (!isFinite(t) || t < 0) return "0:00";
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function getProxiedAudioUrl(url: string): string {
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.origin === window.location.origin) return url;
    return `/api/audio-proxy?url=${encodeURIComponent(url)}`;
  } catch {
    return url;
  }
}

function isLightTheme(): boolean {
  return document.documentElement.getAttribute("data-scheme") === "light";
}

export const AudioNode = memo(function AudioNode({
  node,
}: {
  node: CanvasNode;
}) {
  const wsContainerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.8);
  const [wsReady, setWsReady] = useState(false);
  const [wsError, setWsError] = useState(false);

  const subtype = getSubtype(node);
  const label = SUBTYPE_LABELS[subtype];
  const hasSrc = !!node.src;

  useEffect(() => {
    setWsError(false);
    setWsReady(false);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);

    if (!wsContainerRef.current || !node.src) return;

    const proxiedUrl = getProxiedAudioUrl(node.src);

    const light = isLightTheme();
    const ws = WaveSurfer.create({
      container: wsContainerRef.current,
      waveColor: light ? "rgba(22, 163, 74, 0.3)" : "rgba(74, 222, 128, 0.4)",
      progressColor: light ? "#16a34a" : "#4ade80",
      cursorColor: light ? "#16a34a" : "#4ade80",
      cursorWidth: 2,
      barWidth: 2,
      barGap: 1.5,
      barRadius: 2,
      height: 32,
      normalize: true,
      url: proxiedUrl,
    });

    ws.setVolume(volume);

    ws.on("ready", () => {
      setDuration(ws.getDuration());
      setWsReady(true);
    });
    ws.on("timeupdate", (time: number) => {
      setCurrentTime(time);
    });
    ws.on("play", () => setIsPlaying(true));
    ws.on("pause", () => setIsPlaying(false));
    ws.on("finish", () => setIsPlaying(false));
    ws.on("error", () => {
      setWsError(true);
    });

    wsRef.current = ws;

    return () => {
      ws.destroy();
      wsRef.current = null;
      setWsReady(false);
    };
  }, [node.src]);

  useEffect(() => {
    if (wsRef.current) {
      wsRef.current.setVolume(volume);
    }
  }, [volume]);

  const togglePlay = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (!hasSrc) return;
    wsRef.current?.playPause();
  }, [hasSrc]);

  const handleVolumeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    e.stopPropagation();
    setVolume(parseFloat(e.target.value));
  }, []);

  const displayDuration = duration > 0 ? duration : (node.metadata?.duration as number) || 0;

  if (wsError && hasSrc) {
    return (
      <AudioNodeFallback node={node} />
    );
  }

  return (
    <div className={`audio-node ${isPlaying ? "audio-node--playing" : ""}`}>
      <div className="audio-node__row">

        <button
          type="button"
          className="audio-node__play-btn"
          onClick={togglePlay}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="6 3 20 12 6 21 6 3" />
            </svg>
          )}
        </button>

        <div className="audio-node__wavesurfer" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
          <div ref={wsContainerRef} className="audio-node__ws-container" />
          {!wsReady && hasSrc && (
            <div className="audio-node__ws-loading">Loading...</div>
          )}
        </div>

        <div className="audio-node__meta">
          <span className="audio-node__type-badge">{label}</span>
          <span className="audio-node__time">
            {formatTime(currentTime)} / {formatTime(displayDuration)}
          </span>
        </div>

        <div className="audio-node__volume" onPointerDown={(e) => e.stopPropagation()}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
            onClick={(e) => e.stopPropagation()}
            className="audio-node__volume-slider"
            aria-label="Volume"
          />
        </div>
      </div>

      {node.label && (
        <div className="audio-node__prompt" title={node.label}>
          {node.label}
        </div>
      )}
    </div>
  );
});

const AudioNodeFallback = memo(function AudioNodeFallback({
  node,
}: {
  node: CanvasNode;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.8);

  const subtype = getSubtype(node);
  const label = SUBTYPE_LABELS[subtype];
  const hasSrc = !!node.src;

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => {
      setCurrentTime(audio.currentTime);
      if (audio.duration && isFinite(audio.duration)) setDuration(audio.duration);
    };
    const onLoaded = () => {
      if (audio.duration && isFinite(audio.duration)) setDuration(audio.duration);
    };
    const onEnded = () => setIsPlaying(false);
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onLoaded);
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onLoaded);
      audio.removeEventListener("ended", onEnded);
    };
  }, [node.id]);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio) audio.volume = volume;
  }, [volume]);

  const togglePlay = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const audio = audioRef.current;
    if (!audio || !hasSrc) return;
    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      audio.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
    }
  }, [isPlaying, hasSrc]);

  const handleProgressClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const audio = audioRef.current;
    if (!audio || !audio.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audio.currentTime = pct * audio.duration;
  }, []);

  const handleVolumeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    e.stopPropagation();
    setVolume(parseFloat(e.target.value));
  }, []);

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
  const displayDuration = duration > 0 ? duration : (node.metadata?.duration as number) || 0;

  return (
    <div className={`audio-node ${isPlaying ? "audio-node--playing" : ""}`}>
      {hasSrc && <audio ref={audioRef} src={node.src} preload="metadata" />}

      <div className="audio-node__row">

        <button
          type="button"
          className="audio-node__play-btn"
          onClick={togglePlay}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="6 3 20 12 6 21 6 3" />
            </svg>
          )}
        </button>

        <div className="audio-node__progress" onClick={handleProgressClick} onPointerDown={(e) => e.stopPropagation()}>
          <div className="audio-node__progress-fill" style={{ width: `${progress}%` }} />
        </div>

        <div className="audio-node__meta">
          <span className="audio-node__type-badge">{label}</span>
          <span className="audio-node__time">
            {formatTime(currentTime)} / {formatTime(displayDuration)}
          </span>
        </div>

        <div className="audio-node__volume" onPointerDown={(e) => e.stopPropagation()}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
            onClick={(e) => e.stopPropagation()}
            className="audio-node__volume-slider"
            aria-label="Volume"
          />
        </div>
      </div>

      {node.label && (
        <div className="audio-node__prompt" title={node.label}>
          {node.label}
        </div>
      )}
    </div>
  );
});
