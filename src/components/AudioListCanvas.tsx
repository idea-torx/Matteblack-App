import { useState, useRef, useEffect, useCallback, useMemo, useImperativeHandle, forwardRef } from "react";
import WaveSurfer from "wavesurfer.js";
import { LoadingWaveform as WaveLoadingAnim } from "./LoadingWaveform";
import "./AudioListCanvas.css";

export type AudioType = "tts" | "music" | "voicechanger" | "sfx";

export type AudioGenerationParams = {
  tts?: { text: string; voice: string; speed: number; emotion: string; outputFormat: string };
  music?: { prompt: string; lyrics: string; isInstrumental: boolean };
  sfx?: { prompt: string; durationSeconds: number; promptInfluence: number };
  voicechanger?: { voice: string; stability: string; similarity: string; outputFormat: string };
};

export type AudioClip = {
  id: string;
  type: AudioType;
  prompt: string;
  duration: string;
  bars: number[];
  voice?: string;
  style?: string;
  audioUrl?: string;
  jobId?: string;
  loading?: boolean;
  failed?: boolean;
  savedAssetId?: string;
  generationParams?: AudioGenerationParams;
  name?: string;
  createdAt?: string;
};

const TYPE_GRADIENT: Record<AudioType, { from: string; to: string }> = {
  voicechanger: { from: "#22c55e", to: "#059669" },
  tts: { from: "var(--accent)", to: "#1d4ed8" },
  music: { from: "#a855f7", to: "#7c3aed" },
  sfx: { from: "#f59e0b", to: "#d97706" },
};

const TYPE_CONFIG: Record<AudioType, { label: string; className: string }> = {
  tts: { label: "TTS", className: "audio-type--tts" },
  music: { label: "Music", className: "audio-type--music" },
  voicechanger: { label: "Voice Changer", className: "audio-type--vc" },
  sfx: { label: "SFX", className: "audio-type--sfx" },
};

/* Wavesurfer takes raw color values (not CSS variables) at create-time,
 * so we can't lean on the same `--tint-rgb` plumbing the rest of the app
 * uses. Instead we read `[data-theme]` off <html> and translate it to a
 * tint here — white-on-dark for dark mode, black-on-light for light mode
 * — then watch the attribute so live theme toggles update existing
 * Wavesurfer instances via `setOptions(...)`. Without this the soundwaves
 * render white-on-white in light mode and become invisible. */
type WaveTint = { waveColor: string; progressColor: string; cursorColor: string };

function readWaveTint(): WaveTint {
  const isLight = typeof document !== "undefined"
    && document.documentElement.getAttribute("data-theme") === "light";
  const rgb = isLight ? "0, 0, 0" : "255, 255, 255";
  return {
    waveColor: `rgba(${rgb}, 0.28)`,
    progressColor: `rgba(${rgb}, 0.72)`,
    cursorColor: isLight ? "#000" : "#fff",
  };
}

function useWaveTint(): WaveTint {
  const [tint, setTint] = useState<WaveTint>(() => readWaveTint());
  useEffect(() => {
    if (typeof document === "undefined") return;
    const obs = new MutationObserver(() => setTint(readWaveTint()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  return tint;
}

export function randomBars(count: number): number[] {
  const bars: number[] = [];
  for (let i = 0; i < count; i++) {
    bars.push(0.15 + Math.random() * 0.85);
  }
  return bars;
}

const GHOST_ROWS = [
  { type: "music" as AudioType, width: "70%" },
  { type: "tts" as AudioType, width: "55%" },
  { type: "sfx" as AudioType, width: "80%" },
  { type: "voicechanger" as AudioType, width: "45%" },
  { type: "music" as AudioType, width: "65%" },
  { type: "tts" as AudioType, width: "50%" },
  { type: "sfx" as AudioType, width: "60%" },
];

function EmptyStatePlaceholder() {
  return (
    <div className="alc-empty-ghost">
      {GHOST_ROWS.map((row, i) => {
        const gradient = TYPE_GRADIENT[row.type];
        const opacity = Math.max(0, 1 - i * 0.15);
        return (
          <div
            key={i}
            className="alc-ghost-row"
            style={{ opacity }}
          >
            <div
              className="alc-ghost-cover"
              style={{
                background: `linear-gradient(135deg, ${gradient.from}, ${gradient.to})`,
              }}
            />
            <div className="alc-ghost-info">
              <div className="alc-ghost-name" style={{ width: "60%" }} />
              <div className="alc-ghost-prompt" style={{ width: "40%" }} />
            </div>
            <div className="alc-ghost-waveform">
              <div className="alc-ghost-wave" style={{ width: row.width }} />
            </div>
            <div className="alc-ghost-duration" />
            <div className="alc-ghost-actions">
              <div className="alc-ghost-btn" />
              <div className="alc-ghost-btn" />
              <div className="alc-ghost-btn" />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
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

function hashForGradient(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = ((h << 5) - h) + id.charCodeAt(i);
    h = h & h;
  }
  return Math.abs(h);
}

function CoverArt({ clip }: { clip: AudioClip }) {
  const gradient = TYPE_GRADIENT[clip.type];
  const seed = hashForGradient(clip.id);
  const angle = (seed % 360);
  const lighten = (seed % 20) - 10;
  return (
    <div
      className="alc-cover-art"
      style={{
        background: `linear-gradient(${angle}deg, ${gradient.from}, ${gradient.to})`,
        filter: `brightness(${1 + lighten / 100})`,
      }}
    >
      <div className="alc-cover-art-overlay" />
    </div>
  );
}

function getClipDisplayName(clip: AudioClip): string {
  if (clip.name) return clip.name;
  const typeLabel = TYPE_CONFIG[clip.type].label;
  return `${typeLabel}-${clip.id.slice(0, 8)}`;
}

function downloadAudio(clip: AudioClip) {
  if (!clip.audioUrl) return;
  const ext = clip.audioUrl.includes(".wav") ? "wav" : "mp3";
  const name = `${getClipDisplayName(clip).replace(/\s+/g, "_")}.${ext}`;
  // Route fetch through the same-origin /api/audio-proxy so the
  // browser doesn't reject the request for missing CORS headers on
  // the upstream R2 / fal.media bucket. Without the proxy, the
  // cross-origin fetch fails and we'd fall back to window.open —
  // which navigates to the audio file in a new tab instead of
  // downloading it.
  let fetchUrl = clip.audioUrl;
  try {
    const parsed = new URL(clip.audioUrl, window.location.origin);
    if (parsed.origin !== window.location.origin) {
      fetchUrl = `/api/audio-proxy?url=${encodeURIComponent(clip.audioUrl)}`;
    }
  } catch { /* keep original URL — fetch will surface the error */ }
  fetch(fetchUrl)
    .then((r) => {
      if (!r.ok) throw new Error(`download failed: ${r.status}`);
      return r.blob();
    })
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    })
    .catch((err) => {
      console.error("[audio-download] failed", err);
    });
}

function InlineEditableName({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) {
      onChange(trimmed);
    } else {
      setDraft(value);
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="alc-row-name-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") { setDraft(value); setEditing(false); }
        }}
      />
    );
  }

  return (
    <span className="alc-row-name" onClick={() => { setDraft(value); setEditing(true); }} title="Click to rename">
      {value}
    </span>
  );
}

function ClickToCopyPrompt({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  return (
    <span className="alc-row-prompt" onClick={handleCopy} title="Click to copy prompt">
      {copied ? "Copied!" : text}
    </span>
  );
}

type RowProps = {
  clip: AudioClip;
  isPlaying: boolean;
  isActuallyPlaying: boolean;
  onPlay: () => void;
  onCancel?: () => void;
  onDelete?: () => void;
  onSave?: () => void;
  onReuse?: () => void;
  onRename?: (name: string) => void;
};

function RowWaveSurfer({ clip }: { clip: AudioClip }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const tint = useWaveTint();

  useEffect(() => {
    if (!containerRef.current || !clip.audioUrl) return;
    const proxiedUrl = getProxiedAudioUrl(clip.audioUrl);
    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: tint.waveColor,
      progressColor: tint.waveColor,
      cursorWidth: 0,
      barWidth: 2,
      barGap: 1,
      barRadius: 1,
      height: 32,
      normalize: true,
      interact: false,
      url: proxiedUrl,
    });
    wsRef.current = ws;
    return () => {
      ws.destroy();
      wsRef.current = null;
    };
    // tint intentionally excluded — recreating on theme flip would
    // re-decode audio. We push live updates via the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip.audioUrl]);

  // Live theme-flip: update colors on the existing instance.
  useEffect(() => {
    if (!wsRef.current) return;
    wsRef.current.setOptions({ waveColor: tint.waveColor, progressColor: tint.waveColor });
  }, [tint.waveColor]);

  return <div ref={containerRef} className="alc-row-ws-container" />;
}

function AudioRow({ clip, isPlaying, isActuallyPlaying: _isActuallyPlaying, onPlay, onCancel, onDelete, onSave, onReuse, onRename }: RowProps) {
  const isLoading = clip.loading && !clip.audioUrl;
  const isFailed = (!!clip.failed || (!isLoading && !clip.audioUrl)) && !clip.audioUrl;
  const hasAudio = !!clip.audioUrl;
  const canReuse = !isLoading && !!clip.generationParams;
  const config = TYPE_CONFIG[clip.type];
  const tint = useWaveTint();
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    if (!justSaved) return;
    const t = setTimeout(() => setJustSaved(false), 3000);
    return () => clearTimeout(t);
  }, [justSaved]);

  const displayName = getClipDisplayName(clip);

  const handleRowClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("button") || target.closest("input") || target.closest("textarea") || target.closest(".alc-row-actions")) return;
    if (hasAudio && !isLoading && !isFailed) onPlay?.();
  };

  return (
    <div className={`alc-row ${isPlaying ? "alc-row--playing" : ""} ${isLoading ? "alc-row--loading" : ""} ${isFailed ? "alc-row--failed" : ""}`} onClick={handleRowClick} style={{ cursor: hasAudio && !isLoading && !isFailed ? "pointer" : undefined }}>
      <CoverArt clip={clip} />

      <div className="alc-row-info">
        <InlineEditableName value={displayName} onChange={(v) => onRename?.(v)} />
        <ClickToCopyPrompt text={clip.prompt || config.label} />
      </div>

      <div className="alc-row-waveform">
        {isLoading ? (
          <WaveLoadingAnim height={32} waveColor={tint.waveColor} />
        ) : isFailed ? (
          <div className="alc-row-failed-bars">
            {clip.bars.slice(0, 40).map((h, i) => (
              <div key={i} className="alc-row-failed-bar" style={{ height: `${h * 100}%` }} />
            ))}
          </div>
        ) : hasAudio ? (
          <RowWaveSurfer clip={clip} />
        ) : null}
      </div>

      <div className="alc-row-duration">
        {isLoading ? (
          <span className="alc-row-generating">Generating...</span>
        ) : isFailed ? (
          <span className="alc-row-failed-label">Failed</span>
        ) : (
          <span>{clip.duration}</span>
        )}
      </div>

      <div className="alc-row-actions">
        {isLoading && onCancel ? (
          <button type="button" className="alc-row-action-btn alc-row-action-btn--cancel" onClick={onCancel} title="Cancel">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        ) : isFailed ? (
          <>
            {canReuse && onReuse && (
              <button type="button" className="alc-row-action-btn" onClick={onReuse} title="Re-use settings">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                </svg>
              </button>
            )}
            {onDelete && (
              <button type="button" className="alc-row-action-btn alc-row-action-btn--delete" onClick={onDelete} title="Delete">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            )}
          </>
        ) : hasAudio ? (
          <>
            <button
              type="button"
              className={`alc-row-action-btn ${justSaved ? "alc-row-action-btn--saved" : ""}`}
              title={saving ? "Saving..." : justSaved ? "Saved!" : "Save"}
              disabled={saving || justSaved}
              onClick={() => {
                if (!saving && !justSaved && onSave) {
                  setSaving(true);
                  onSave();
                  setTimeout(() => { setSaving(false); setJustSaved(true); }, 600);
                }
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill={justSaved ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
              </svg>
            </button>
            <button type="button" className="alc-row-action-btn" title="Download" onClick={() => downloadAudio(clip)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </button>
            {canReuse && onReuse && (
              <button type="button" className="alc-row-action-btn" onClick={onReuse} title="Re-use settings">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                </svg>
              </button>
            )}
            {onDelete && (
              <button type="button" className="alc-row-action-btn alc-row-action-btn--delete" onClick={onDelete} title="Delete">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

type NowPlaying = {
  clipId: string;
  clip: AudioClip;
};

type BottomPlaybackBarHandle = {
  togglePlayPause: () => void;
};

const BottomPlaybackBar = forwardRef<BottomPlaybackBarHandle, {
  nowPlaying: NowPlaying | null;
  onPrev: () => void;
  onNext: () => void;
  onPlayingChange: (playing: boolean) => void;
}>(function BottomPlaybackBar({
  nowPlaying,
  onPrev,
  onNext,
  onPlayingChange,
}, ref) {
  const wsRef = useRef<WaveSurfer | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [playing, setPlayingInternal] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.8);
  const [repeat, setRepeat] = useState(false);
  const repeatRef = useRef(false);
  const prevClipIdRef = useRef<string | null>(null);
  const tint = useWaveTint();
  const tintRef = useRef(tint);
  tintRef.current = tint;

  const setPlaying = useCallback((v: boolean) => {
    setPlayingInternal(v);
    onPlayingChange(v);
  }, [onPlayingChange]);

  useImperativeHandle(ref, () => ({
    togglePlayPause: () => {
      if (wsRef.current) wsRef.current.playPause();
    },
  }), []);

  useEffect(() => {
    if (!nowPlaying?.clip.audioUrl || !containerRef.current) {
      if (wsRef.current) {
        wsRef.current.destroy();
        wsRef.current = null;
      }
      setPlaying(false);
      setCurrentTime(0);
      setDuration(0);
      prevClipIdRef.current = null;
      return;
    }

    if (prevClipIdRef.current === nowPlaying.clipId && wsRef.current) {
      return;
    }

    if (wsRef.current) {
      wsRef.current.destroy();
      wsRef.current = null;
    }

    prevClipIdRef.current = nowPlaying.clipId;
    const proxiedUrl = getProxiedAudioUrl(nowPlaying.clip.audioUrl!);

    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: tintRef.current.waveColor,
      progressColor: tintRef.current.progressColor,
      cursorColor: tintRef.current.cursorColor,
      cursorWidth: 1,
      barWidth: 2,
      barGap: 1,
      barRadius: 1,
      height: 28,
      normalize: true,
      url: proxiedUrl,
    });

    ws.setVolume(volume);

    ws.on("ready", () => {
      setDuration(ws.getDuration());
      ws.play();
    });
    ws.on("timeupdate", (t: number) => setCurrentTime(t));
    ws.on("play", () => setPlaying(true));
    ws.on("pause", () => setPlaying(false));
    ws.on("finish", () => {
      if (repeatRef.current) {
        ws.seekTo(0);
        ws.play();
      } else {
        setPlaying(false);
      }
    });
    ws.on("error", () => {});

    wsRef.current = ws;

    return () => {
      ws.destroy();
      wsRef.current = null;
    };
  }, [nowPlaying?.clipId, nowPlaying?.clip.audioUrl]);

  useEffect(() => {
    if (wsRef.current) wsRef.current.setVolume(volume);
  }, [volume]);

  // Live theme-flip: update colors on the existing wavesurfer instance
  // so the bottom-bar waveform stays visible when the user toggles
  // between dark and light without interrupting playback.
  useEffect(() => {
    if (!wsRef.current) return;
    wsRef.current.setOptions({
      waveColor: tint.waveColor,
      progressColor: tint.progressColor,
      cursorColor: tint.cursorColor,
    });
  }, [tint.waveColor, tint.progressColor, tint.cursorColor]);

  const handlePlayPause = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.playPause();
    }
  }, []);

  const displayName = nowPlaying ? getClipDisplayName(nowPlaying.clip) : "";

  return (
    <div className={`alc-bottom-bar ${!nowPlaying ? "alc-bottom-bar--idle" : ""}`}>
      <div className="alc-bottom-bar-left">
        {nowPlaying ? (
          <>
            <CoverArt clip={nowPlaying.clip} />
            <div className="alc-bottom-bar-track-info">
              <span className="alc-bottom-bar-track-name">{displayName}</span>
              <span className="alc-bottom-bar-track-type">{TYPE_CONFIG[nowPlaying.clip.type].label}</span>
            </div>
          </>
        ) : (
          <>
            <div className="alc-bottom-bar-idle-cover" />
            <div className="alc-bottom-bar-track-info">
              <span className="alc-bottom-bar-track-name alc-bottom-bar-track-name--idle">No track selected</span>
            </div>
          </>
        )}
      </div>

      <div className="alc-bottom-bar-center">
        <div className="alc-bottom-bar-controls">
          <button type="button" className="alc-bottom-bar-btn" onClick={onPrev} title="Previous">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="19 20 9 12 19 4 19 20" /><line x1="5" y1="19" x2="5" y2="5" stroke="currentColor" strokeWidth="2" /></svg>
          </button>
          <button type="button" className="alc-bottom-bar-btn alc-bottom-bar-btn--play" onClick={handlePlayPause} title={playing ? "Pause" : "Play"}>
            {playing ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="8 4 20 12 8 20 8 4" /></svg>
            )}
          </button>
          <button type="button" className="alc-bottom-bar-btn" onClick={onNext} title="Next">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 4 15 12 5 20 5 4" /><line x1="19" y1="5" x2="19" y2="19" stroke="currentColor" strokeWidth="2" /></svg>
          </button>
        </div>
        <div className="alc-bottom-bar-scrub-row">
          <span className="alc-bottom-bar-time">{formatTime(currentTime)}</span>
          <div className="alc-bottom-bar-waveform-wrap">
            <div ref={containerRef} className="alc-bottom-bar-waveform" />
          </div>
          <span className="alc-bottom-bar-time">{formatTime(duration)}</span>
        </div>
      </div>

      <div className="alc-bottom-bar-right">
        <button
          type="button"
          className={`alc-bottom-bar-btn ${repeat ? "alc-bottom-bar-btn--active" : ""}`}
          onClick={() => { setRepeat((v) => !v); repeatRef.current = !repeatRef.current; }}
          title={repeat ? "Repeat off" : "Repeat track"}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 0 1-4 4H3" />
          </svg>
        </button>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
        </svg>
        <input
          type="range"
          className="alc-bottom-bar-volume"
          min={0}
          max={100}
          value={volume * 100}
          onChange={(e) => setVolume(Number(e.target.value) / 100)}
          style={{ background: `linear-gradient(to right, rgba(255,255,255,0.8) ${volume * 100}%, rgba(255,255,255,0.15) ${volume * 100}%)` }}
        />
      </div>
    </div>
  );
});

type AudioListCanvasProps = {
  clips: AudioClip[];
  onCancelClip?: (clipId: string) => void;
  onDeleteClip?: (clipId: string) => void;
  onSaveClip?: (clipId: string) => void;
  onReuseClip?: (clipId: string) => void;
  onRenameClip?: (clipId: string, name: string) => void;
};

const FILTER_OPTIONS: { value: AudioType | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "tts", label: "TTS" },
  { value: "music", label: "Music" },
  { value: "sfx", label: "SFX" },
  { value: "voicechanger", label: "Voice" },
];

export function AudioListCanvas({
  clips,
  onCancelClip,
  onDeleteClip,
  onSaveClip,
  onReuseClip,
  onRenameClip,
}: AudioListCanvasProps) {
  const [activeFilter, setActiveFilter] = useState<AudioType | "all">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [nowPlayingId, setNowPlayingId] = useState<string | null>(null);
  const [isActuallyPlaying, setIsActuallyPlaying] = useState(false);
  const bottomBarRef = useRef<BottomPlaybackBarHandle>(null);

  const filteredClips = useMemo(() => {
    let result = clips;
    if (activeFilter !== "all") {
      result = result.filter((c) => c.type === activeFilter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      result = result.filter((c) => {
        const name = (c.name || "").toLowerCase();
        const prompt = (c.prompt || "").toLowerCase();
        const type = TYPE_CONFIG[c.type].label.toLowerCase();
        return name.includes(q) || prompt.includes(q) || type.includes(q);
      });
    }
    return result;
  }, [clips, activeFilter, searchQuery]);

  const isEmpty = filteredClips.length === 0 && clips.length === 0;
  const noResults = filteredClips.length === 0 && clips.length > 0;

  const playableClips = useMemo(() => clips.filter((c) => !!c.audioUrl && !c.loading && !c.failed), [clips]);

  const nowPlaying = useMemo((): NowPlaying | null => {
    if (!nowPlayingId) return null;
    const clip = clips.find((c) => c.id === nowPlayingId);
    if (!clip || !clip.audioUrl) return null;
    return { clipId: nowPlayingId, clip };
  }, [nowPlayingId, clips]);

  const handlePlay = useCallback((clipId: string) => {
    if (clipId === nowPlayingId) {
      bottomBarRef.current?.togglePlayPause();
    } else {
      setNowPlayingId(clipId);
    }
  }, [nowPlayingId]);

  const handlePrev = useCallback(() => {
    if (!nowPlayingId || playableClips.length === 0) return;
    const idx = playableClips.findIndex((c) => c.id === nowPlayingId);
    const prevIdx = idx <= 0 ? playableClips.length - 1 : idx - 1;
    setNowPlayingId(playableClips[prevIdx].id);
  }, [nowPlayingId, playableClips]);

  const handleNext = useCallback(() => {
    if (!nowPlayingId || playableClips.length === 0) return;
    const idx = playableClips.findIndex((c) => c.id === nowPlayingId);
    const nextIdx = idx >= playableClips.length - 1 ? 0 : idx + 1;
    setNowPlayingId(playableClips[nextIdx].id);
  }, [nowPlayingId, playableClips]);

  const handlePlayingChange = useCallback((playing: boolean) => {
    setIsActuallyPlaying(playing);
  }, []);

  return (
    <main className="alc-canvas">
      <div className="alc-toolbar">
          <div className="alc-filter-chips">
            {FILTER_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`alc-chip ${activeFilter === opt.value ? "alc-chip--active" : ""}`}
                onClick={() => setActiveFilter(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className="alc-search">
            <svg className="alc-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              className="alc-search-input"
              placeholder="Search clips..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button type="button" className="alc-search-clear" onClick={() => setSearchQuery("")}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
        </div>
      <div className="alc-scroll">
        {isEmpty && <EmptyStatePlaceholder />}
        {noResults && (
          <div className="alc-no-results">
            <span>No clips match your filters</span>
          </div>
        )}
        {filteredClips.map((clip) => (
          <AudioRow
            key={clip.id}
            clip={clip}
            isPlaying={nowPlayingId === clip.id}
            isActuallyPlaying={nowPlayingId === clip.id && isActuallyPlaying}
            onPlay={() => handlePlay(clip.id)}
            onCancel={onCancelClip ? () => onCancelClip(clip.id) : undefined}
            onDelete={onDeleteClip ? () => onDeleteClip(clip.id) : undefined}
            onSave={onSaveClip ? () => onSaveClip(clip.id) : undefined}
            onReuse={onReuseClip ? () => onReuseClip(clip.id) : undefined}
            onRename={onRenameClip ? (name: string) => onRenameClip(clip.id, name) : undefined}
          />
        ))}
      </div>
      <BottomPlaybackBar
        ref={bottomBarRef}
        nowPlaying={nowPlaying}
        onPrev={handlePrev}
        onNext={handleNext}
        onPlayingChange={handlePlayingChange}
      />
    </main>
  );
}
