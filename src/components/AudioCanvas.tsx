import { useRef, useCallback, useEffect, useState, useMemo } from "react";
import WaveSurfer from "wavesurfer.js";
import { GenerationWait } from "./GenerationWait";
import { LoadingWaveform } from "./LoadingWaveform";
import type { AudioClip, AudioType } from "./AudioListCanvas";
import "./Canvas.css";
import "./AudioCanvas.css";

const TYPE_CONFIG: Record<AudioType, { label: string; className: string; waveColor: string; progressColor: string }> = {
  tts: { label: "TTS", className: "audio-type--tts", waveColor: "rgba(96, 165, 250, 0.35)", progressColor: "#60a5fa" },
  music: { label: "Music", className: "audio-type--music", waveColor: "rgba(192, 132, 252, 0.35)", progressColor: "#c084fc" },
  voicechanger: { label: "Voice Changer", className: "audio-type--vc", waveColor: "rgba(52, 211, 153, 0.35)", progressColor: "#34d399" },
  sfx: { label: "SFX", className: "audio-type--sfx", waveColor: "rgba(251, 191, 36, 0.35)", progressColor: "#fbbf24" },
};

type ClipGroup = {
  key: string;
  label: string;
  clips: AudioClip[];
};

function groupClips(clips: AudioClip[]): ClipGroup[] {
  const map = new Map<string, AudioClip[]>();
  for (const clip of clips) {
    const groupKey = clip.voice || clip.type;
    if (!map.has(groupKey)) map.set(groupKey, []);
    map.get(groupKey)!.push(clip);
  }
  const groups: ClipGroup[] = [];
  for (const [key, items] of map) {
    groups.push({ key, label: key, clips: items });
  }
  return groups;
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

function downloadAudio(clip: AudioClip) {
  if (!clip.audioUrl) return;
  const ext = clip.audioUrl.includes(".wav") ? "wav" : "mp3";
  const name = `${clip.type}-${clip.id.slice(0, 8)}.${ext}`;
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

type AudioLineageRowProps = {
  group: ClipGroup;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onSaveClip?: (clipId: string) => void;
  onDeleteClip?: (clipId: string) => void;
};

function AudioLineageRow({ group, selectedId, onSelect, onSaveClip, onDeleteClip }: AudioLineageRowProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [currentIndex, setCurrentIndex] = useState(0);

  const scrollToIndex = useCallback((index: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const cards = el.querySelectorAll<HTMLElement>(".canvas-gen");
    const clamped = Math.max(0, Math.min(index, cards.length - 1));
    setCurrentIndex(clamped);
    cards[clamped].scrollIntoView({
      behavior: "smooth",
      inline: "center",
      block: "nearest",
    });
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || group.clips.length <= 1) return;

    const updateCurrentIndex = () => {
      const cards = Array.from(el.querySelectorAll<HTMLElement>(".canvas-gen"));
      if (cards.length === 0) return;
      const viewportCenter = el.scrollLeft + el.clientWidth / 2;
      let closestIndex = 0;
      let closestDistance = Number.POSITIVE_INFINITY;
      cards.forEach((card, index) => {
        const cardCenter = card.offsetLeft + card.offsetWidth / 2;
        const distance = Math.abs(cardCenter - viewportCenter);
        if (distance < closestDistance) {
          closestDistance = distance;
          closestIndex = index;
        }
      });
      setCurrentIndex(closestIndex);
    };

    updateCurrentIndex();
    el.addEventListener("scroll", updateCurrentIndex, { passive: true });
    window.addEventListener("resize", updateCurrentIndex);
    return () => {
      el.removeEventListener("scroll", updateCurrentIndex);
      window.removeEventListener("resize", updateCurrentIndex);
    };
  }, [group.clips.length]);

  const showPager = group.clips.length > 1;

  return (
    <section className="canvas-lineage">
      <div className="canvas-lineage-scroll" ref={scrollRef}>
        <div className="canvas-edge-spacer" aria-hidden="true" />
        {group.clips.map((clip, index) => {
          const isSelected = selectedId === clip.id;
          const config = TYPE_CONFIG[clip.type];
          return (
            <div
              key={clip.id}
              className={`canvas-gen ${isSelected ? "canvas-gen--selected" : ""}`}
              onClick={() => {
                onSelect(clip.id);
                scrollToIndex(index);
              }}
              style={{ position: "relative" }}
            >
              {clip.loading && !clip.audioUrl ? (
                <div className="audio-card">
                  <div className="audio-prompt" title={clip.prompt}>{clip.prompt}</div>
                  <div className="audio-wave-section audio-wave-section--loading">
                    <LoadingWaveform
                      progress={0.5}
                      height={36}
                      waveColor="rgba(96, 165, 250, 0.4)"
                    />
                  </div>
                  <div className="audio-toolbar">
                    <span className="audio-loading-label">Generating...</span>
                  </div>
                </div>
              ) : clip.failed && !clip.audioUrl ? (
                <div className="audio-card audio-card--failed">
                  <div className="audio-prompt" title={clip.prompt}>{clip.prompt}</div>
                  <div className="audio-wave-section">
                    <div className="audio-waveform">
                      {clip.bars.map((h, i) => (
                        <div
                          key={i}
                          className="audio-waveform-bar audio-waveform-bar--failed"
                          style={{ height: `${h * 100}%` }}
                        />
                      ))}
                    </div>
                  </div>
                  <div className="audio-toolbar">
                    <span className="audio-failed-label">Failed</span>
                    {onDeleteClip && (
                      <button
                        type="button"
                        className="audio-toolbar-btn audio-toolbar-btn--delete"
                        onClick={(e) => { e.stopPropagation(); onDeleteClip(clip.id); }}
                        aria-label="Delete"
                      >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
              ) : clip.audioUrl ? (
                <AudioCardWithWaveSurfer clip={clip} onSaveClip={onSaveClip} onDeleteClip={onDeleteClip} />
              ) : (
                <AudioCardFallback clip={clip} onSaveClip={onSaveClip} onDeleteClip={onDeleteClip} />
              )}
              <div className="canvas-gen-meta">
                <span className={`canvas-gen-badge canvas-gen-badge--audio ${config.className}`}>{config.label}</span>
                <span className="canvas-gen-label">{clip.voice || clip.prompt.substring(0, 30)}</span>
              </div>
            </div>
          );
        })}
        <div className="canvas-edge-spacer" aria-hidden="true" />
      </div>

      {showPager && (
        <div className="canvas-lineage-pager" aria-label="Audio navigation">
          {group.clips.map((clip, index) => (
            <button
              key={clip.id}
              type="button"
              className={`canvas-lineage-segment ${currentIndex === index ? "canvas-lineage-segment--active" : ""}`}
              onClick={() => scrollToIndex(index)}
              aria-label={`View audio ${index + 1}`}
              aria-pressed={currentIndex === index}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function AudioCardWithWaveSurfer({ clip, onSaveClip, onDeleteClip }: { clip: AudioClip; onSaveClip?: (clipId: string) => void; onDeleteClip?: (clipId: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [totalDuration, setTotalDuration] = useState(clip.duration);
  const [saving, setSaving] = useState(false);
  const [wsError, setWsError] = useState(false);
  const config = TYPE_CONFIG[clip.type];
  const isSaved = !!clip.savedAssetId;

  useEffect(() => {
    if (isSaved) setSaving(false);
  }, [isSaved]);

  useEffect(() => {
    if (!saving) return;
    const timer = setTimeout(() => setSaving(false), 10000);
    return () => clearTimeout(timer);
  }, [saving]);

  useEffect(() => {
    if (!containerRef.current || !clip.audioUrl) return;

    const proxiedUrl = getProxiedAudioUrl(clip.audioUrl);

    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: config.waveColor,
      progressColor: config.progressColor,
      cursorColor: config.progressColor,
      cursorWidth: 2,
      barWidth: 2,
      barGap: 1.5,
      barRadius: 2,
      height: 48,
      normalize: true,
      url: proxiedUrl,
    });

    ws.on("ready", () => {
      setTotalDuration(formatTime(ws.getDuration()));
    });
    ws.on("timeupdate", (time: number) => {
      setCurrentTime(time);
    });
    ws.on("play", () => setPlaying(true));
    ws.on("pause", () => setPlaying(false));
    ws.on("finish", () => setPlaying(false));

    ws.on("error", (err: Error) => {
      console.error("WaveSurfer error (AudioCanvas):", err);
      setWsError(true);
    });

    wsRef.current = ws;

    return () => {
      ws.destroy();
      wsRef.current = null;
    };
  }, [clip.audioUrl, clip.type]);

  const togglePlay = useCallback(() => {
    wsRef.current?.playPause();
  }, []);

  if (wsError) {
    return <AudioCardFallback clip={clip} onSaveClip={onSaveClip} onDeleteClip={onDeleteClip} />;
  }

  return (
    <div className={`audio-card ${playing ? "audio-card--playing" : ""}`}>
      <div className="audio-prompt" title={clip.prompt}>{clip.prompt}</div>

      <div className="audio-wave-section">
        <div ref={containerRef} className="audio-wavesurfer-container" />
      </div>

      <div className="audio-toolbar">
        <button
          type="button"
          className="audio-toolbar-btn audio-toolbar-btn--play"
          onClick={(e) => { e.stopPropagation(); togglePlay(); }}
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="6 3 20 12 6 21 6 3" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="audio-toolbar-btn"
          onClick={(e) => { e.stopPropagation(); downloadAudio(clip); }}
          aria-label="Download"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </button>
        <button
          type="button"
          className={`audio-toolbar-btn audio-toolbar-btn--save ${isSaved ? "audio-toolbar-btn--saved" : ""}`}
          disabled={isSaved || saving}
          onClick={(e) => {
            e.stopPropagation();
            if (!isSaved && !saving && onSaveClip) {
              setSaving(true);
              onSaveClip(clip.id);
            }
          }}
          aria-label={isSaved ? "Saved to Library" : "Save to Library"}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill={isSaved ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
          </svg>
        </button>
        {onDeleteClip && (
          <button
            type="button"
            className="audio-toolbar-btn audio-toolbar-btn--delete"
            onClick={(e) => { e.stopPropagation(); onDeleteClip(clip.id); }}
            aria-label="Delete"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        )}
        <span className="audio-time">{formatTime(currentTime)} / {totalDuration}</span>
      </div>
    </div>
  );
}

function AudioCardFallback({ clip, onSaveClip, onDeleteClip }: { clip: AudioClip; onSaveClip?: (clipId: string) => void; onDeleteClip?: (clipId: string) => void }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [scrub, setScrub] = useState(0);
  const [saving, setSaving] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const isSaved = !!clip.savedAssetId;

  useEffect(() => {
    if (!clip.audioUrl) return;
    const proxiedUrl = getProxiedAudioUrl(clip.audioUrl);
    const audio = new Audio(proxiedUrl);
    audio.preload = "metadata";
    audioRef.current = audio;

    audio.addEventListener("loadedmetadata", () => {
      if (isFinite(audio.duration)) setAudioDuration(audio.duration);
    });
    audio.addEventListener("timeupdate", () => {
      setCurrentTime(audio.currentTime);
      if (audio.duration > 0) {
        setScrub((audio.currentTime / audio.duration) * 100);
      }
    });
    audio.addEventListener("play", () => setPlaying(true));
    audio.addEventListener("pause", () => setPlaying(false));
    audio.addEventListener("ended", () => { setPlaying(false); setScrub(0); });
    audio.addEventListener("error", () => {
      console.error("Fallback Audio error (AudioCanvas):", audio.error);
    });

    return () => {
      audio.pause();
      audio.src = "";
      audioRef.current = null;
    };
  }, [clip.audioUrl]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      audio.play().catch((err) => console.error("Fallback play error:", err));
    } else {
      audio.pause();
    }
  }, []);

  const handleScrub = useCallback((value: number) => {
    setScrub(value);
    const audio = audioRef.current;
    if (audio && audio.duration > 0) {
      audio.currentTime = (value / 100) * audio.duration;
    }
  }, []);

  useEffect(() => {
    if (isSaved) setSaving(false);
  }, [isSaved]);

  useEffect(() => {
    if (!saving) return;
    const timer = setTimeout(() => setSaving(false), 10000);
    return () => clearTimeout(timer);
  }, [saving]);

  const totalBars = clip.bars.length;
  const scrubBarIndex = (scrub / 100) * totalBars;
  const displayDuration = audioDuration > 0 ? formatTime(audioDuration) : clip.duration;

  return (
    <div className={`audio-card ${playing ? "audio-card--playing" : ""}`}>
      <div className="audio-prompt" title={clip.prompt}>{clip.prompt}</div>

      <div className="audio-wave-section">
        <div className="audio-waveform">
          {clip.bars.map((h, i) => {
            const passed = i < scrubBarIndex;
            const isNear = Math.abs(i - scrubBarIndex) < 3;
            const bounce = isNear && playing ? 0.15 + Math.random() * 0.2 : 0;
            const finalH = passed || isNear ? Math.min(h + bounce, 1) : h;
            return (
              <div
                key={i}
                className={`audio-waveform-bar ${passed ? "audio-waveform-bar--passed" : ""}`}
                style={{ height: `${finalH * 100}%` }}
              />
            );
          })}
        </div>
        <input
          type="range"
          className="audio-scrub"
          min={0}
          max={100}
          value={scrub}
          onChange={(e) => { e.stopPropagation(); handleScrub(Number(e.target.value)); }}
          onClick={(e) => e.stopPropagation()}
          aria-label="Scrub playback"
          style={{ background: `linear-gradient(to right, var(--accent) ${scrub}%, rgba(255,255,255,0.08) ${scrub}%)` }}
        />
      </div>

      <div className="audio-toolbar">
        <button
          type="button"
          className="audio-toolbar-btn audio-toolbar-btn--play"
          onClick={(e) => { e.stopPropagation(); togglePlay(); }}
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="6 3 20 12 6 21 6 3" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="audio-toolbar-btn"
          onClick={(e) => { e.stopPropagation(); downloadAudio(clip); }}
          aria-label="Download"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </button>
        <button
          type="button"
          className={`audio-toolbar-btn audio-toolbar-btn--save ${isSaved ? "audio-toolbar-btn--saved" : ""}`}
          disabled={isSaved || saving}
          onClick={(e) => {
            e.stopPropagation();
            if (!isSaved && !saving && onSaveClip) {
              setSaving(true);
              onSaveClip(clip.id);
            }
          }}
          aria-label={isSaved ? "Saved to Library" : "Save to Library"}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill={isSaved ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
          </svg>
        </button>
        {onDeleteClip && (
          <button
            type="button"
            className="audio-toolbar-btn audio-toolbar-btn--delete"
            onClick={(e) => { e.stopPropagation(); onDeleteClip(clip.id); }}
            aria-label="Delete"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        )}
        <span className="audio-time">{formatTime(currentTime)} / {displayDuration}</span>
      </div>
    </div>
  );
}

type AudioCanvasProps = {
  clips: AudioClip[];
  generating?: boolean;
  genDone?: boolean;
  genContextLabel?: string;
  onCancelGeneration?: () => void;
  onSaveClip?: (clipId: string) => void;
  onDeleteClip?: (clipId: string) => void;
};

export function AudioCanvas({
  clips,
  generating,
  genDone,
  genContextLabel,
  onCancelGeneration,
  onSaveClip,
  onDeleteClip,
}: AudioCanvasProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const completedClips = useMemo(() => clips.filter((c) => !!c.audioUrl || !!c.failed), [clips]);
  const groups = useMemo(() => groupClips(completedClips), [completedClips]);
  const loadingClips = useMemo(() => clips.filter((c) => c.loading && !c.audioUrl && !c.failed), [clips]);

  return (
    <main className="canvas audio-canvas">
      {generating && (
        <section className="canvas-lineage">
          <div className="canvas-lineage-scroll">
            <div className="canvas-edge-spacer" aria-hidden="true" />
            <div className="canvas-gen" style={{ position: "relative" }}>
              <GenerationWait
                contextLabel={genContextLabel}
                isDone={genDone}
                onCancel={onCancelGeneration}
                aspectRatio="21:9"
              />
              <div className="canvas-gen-meta">
                <span className="canvas-gen-badge canvas-gen-badge--audio">
                  {genContextLabel}
                </span>
                <span className="canvas-gen-label">Generating...</span>
              </div>
            </div>
            <div className="canvas-edge-spacer" aria-hidden="true" />
          </div>
        </section>
      )}
      {loadingClips.length > 0 && (
        <section className="canvas-lineage">
          <div className="canvas-lineage-scroll">
            <div className="canvas-edge-spacer" aria-hidden="true" />
            {loadingClips.map((clip) => {
              const config = TYPE_CONFIG[clip.type];
              return (
                <div key={clip.id} className="canvas-gen" style={{ position: "relative" }}>
                  <div className="audio-card">
                    <div className="audio-prompt" title={clip.prompt}>{clip.prompt}</div>
                    <div className="audio-wave-section audio-wave-section--loading">
                      <LoadingWaveform
                        progress={0.5}
                        height={36}
                        waveColor="rgba(96, 165, 250, 0.4)"
                      />
                    </div>
                    <div className="audio-toolbar">
                      <span className="audio-loading-label">Generating...</span>
                    </div>
                  </div>
                  <div className="canvas-gen-meta">
                    <span className={`canvas-gen-badge canvas-gen-badge--audio ${config.className}`}>{config.label}</span>
                    <span className="canvas-gen-label">{clip.voice || "Processing"}</span>
                  </div>
                </div>
              );
            })}
            <div className="canvas-edge-spacer" aria-hidden="true" />
          </div>
        </section>
      )}
      {groups.map((group) => (
        <AudioLineageRow
          key={group.key}
          group={group}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onSaveClip={onSaveClip}
          onDeleteClip={onDeleteClip}
        />
      ))}
    </main>
  );
}
