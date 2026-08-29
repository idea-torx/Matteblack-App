import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useEstimateCost } from "../hooks/useEstimateCost";
import { useGenerateButton } from "../hooks/useGenerateButton";
import { GenerateButtonCost } from "./GenerateButtonCost";
import "./RightPanel.css";

export type TTSParams = {
  text: string;
  voice: string;
  speed: number;
  emotion: string;
  outputFormat: string;
};

type AudioPanelProps = {
  onGenerate: (params: TTSParams) => void;
  creditsRequired?: number;
  userBalance?: number;
  unlimited?: boolean;
  initialValues?: TTSParams | null;
  reuseVersion?: number;
};

const VOICES = [
  { id: "Wise_Woman", label: "Wise Woman" },
  { id: "Friendly_Person", label: "Friendly Person" },
  { id: "Inspirational_girl", label: "Inspirational Girl" },
  { id: "Deep_Voice_Man", label: "Deep Voice Man" },
  { id: "Calm_Woman", label: "Calm Woman" },
  { id: "Casual_Guy", label: "Casual Guy" },
  { id: "Lively_Girl", label: "Lively Girl" },
  { id: "Patient_Man", label: "Patient Man" },
  { id: "Young_Knight", label: "Young Knight" },
  { id: "Determined_Man", label: "Determined Man" },
  { id: "Lovely_Girl", label: "Lovely Girl" },
  { id: "Decent_Boy", label: "Decent Boy" },
  { id: "Imposing_Manner", label: "Imposing Manner" },
  { id: "Elegant_Man", label: "Elegant Man" },
  { id: "Abbess", label: "Abbess" },
  { id: "Sweet_Girl_2", label: "Sweet Girl 2" },
  { id: "Exuberant_Girl", label: "Exuberant Girl" },
] as const;

const SPEEDS = [0.5, 1.0, 1.5, 2.0] as const;

const EMOTIONS = [
  { id: "neutral", label: "Neutral" },
  { id: "happy", label: "Happy" },
  { id: "sad", label: "Sad" },
  { id: "angry", label: "Angry" },
] as const;

type OutputFormat = "mp3" | "flac" | "pcm";

const OUTPUT_FORMATS: { id: OutputFormat; label: string }[] = [
  { id: "mp3", label: "MP3" },
  { id: "flac", label: "FLAC" },
  { id: "pcm", label: "WAV (PCM)" },
];

export function AudioPanel({ onGenerate, creditsRequired = 10, userBalance = 0, unlimited = false, initialValues, reuseVersion = 0 }: AudioPanelProps) {
  const [text, setText] = useState("");
  const estimateParams = useMemo(() => ({
    type: "audio_tts",
    model: "minimax-tts",
    characters: text.length || undefined,
  }), [text.length]);
  const { cost: estimatedCost } = useEstimateCost(estimateParams);
  const totalCost = estimatedCost !== null ? estimatedCost : creditsRequired;

  const gate = useGenerateButton(userBalance, unlimited, totalCost);
  const [voice, setVoice] = useState("Friendly_Person");
  const [speed, setSpeed] = useState<number>(1.0);
  const [emotion, setEmotion] = useState("neutral");
  const [outputFormat, setOutputFormat] = useState<OutputFormat>("mp3");

  const [previewCache, setPreviewCache] = useState<Record<string, string>>({});
  const [previewLoading, setPreviewLoading] = useState<string | null>(null);
  const [previewPlaying, setPreviewPlaying] = useState<string | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    fetch("/api/tts-previews")
      .then((r) => r.json())
      .then((data) => {
        if (data.previews) setPreviewCache(data.previews);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!initialValues) return;
    setText(initialValues.text ?? "");
    if (initialValues.voice) setVoice(initialValues.voice);
    if (initialValues.speed != null) {
      const nearest = SPEEDS.reduce((best, s) =>
        Math.abs(s - initialValues.speed) < Math.abs(best - initialValues.speed) ? s : best,
      SPEEDS[0]);
      setSpeed(nearest);
    }
    if (initialValues.emotion) {
      setEmotion(EMOTIONS.some((em) => em.id === initialValues.emotion) ? initialValues.emotion : "neutral");
    }
    if (initialValues.outputFormat) setOutputFormat(initialValues.outputFormat as OutputFormat);
  }, [reuseVersion]);

  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    voice: false,
  });

  const toggle = (key: string) =>
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));

  const handlePreview = useCallback((voiceId: string, e: React.MouseEvent) => {
    e.stopPropagation();

    if (previewPlaying === voiceId) {
      previewAudioRef.current?.pause();
      if (previewAudioRef.current) previewAudioRef.current.currentTime = 0;
      setPreviewPlaying(null);
      return;
    }

    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current.currentTime = 0;
    }
    setPreviewPlaying(null);

    const url = previewCache[voiceId];
    if (url) {
      const audio = new Audio(url);
      previewAudioRef.current = audio;
      audio.onended = () => setPreviewPlaying(null);
      audio.play();
      setPreviewPlaying(voiceId);
      return;
    }

    setPreviewLoading(voiceId);
    fetch(`/api/tts-preview?voice_id=${encodeURIComponent(voiceId)}`)
      .then((r) => r.json())
      .then((data) => {
        if (!data.url) return;
        setPreviewCache((prev) => ({ ...prev, [voiceId]: data.url }));
        const audio = new Audio(data.url);
        previewAudioRef.current = audio;
        audio.onended = () => setPreviewPlaying(null);
        audio.play();
        setPreviewPlaying(voiceId);
      })
      .catch((err) => console.error("Preview error:", err))
      .finally(() => setPreviewLoading(null));
  }, [previewCache, previewPlaying]);

  return (
    <aside className="rpanel">
      <div className="rpanel-scroll">
        <div className="rpanel-card rpanel-card--prompt">
          <div className="rpanel-card-toggle" style={{ cursor: "default" }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
            <span className="rpanel-card-toggle-label">Text</span>
          </div>
          <textarea
            className="rpanel-textarea"
            placeholder="Enter text to speak..."
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>

        <div className="rpanel-card">
          <button type="button" className="rpanel-card-toggle" onClick={() => toggle("voice")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
            <span className="rpanel-card-toggle-label">Voice</span>
            <span className="rpanel-tag">{VOICES.find((v) => v.id === voice)?.label ?? voice}</span>
            <svg className={`rpanel-card-chevron ${openSections.voice ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          {openSections.voice && (
            <div className="rpanel-card-body">
              <div className="rpanel-list">
                {VOICES.map((v) => {
                  const isPlaying = previewPlaying === v.id;
                  const isLoading = previewLoading === v.id;
                  const hasPreview = !!previewCache[v.id];
                  return (
                    <div
                      key={v.id}
                      className={`rpanel-voice-btn ${voice === v.id ? "rpanel-voice-btn--active" : ""} ${isPlaying ? "rpanel-voice-btn--playing" : ""}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => setVoice(v.id)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setVoice(v.id); } }}
                    >
                      <button
                        type="button"
                        className={`rpanel-voice-play ${isPlaying ? "rpanel-voice-play--active" : ""}`}
                        onClick={(e) => handlePreview(v.id, e)}
                        title={isPlaying ? "Stop" : "Preview"}
                        disabled={isLoading || (!hasPreview && previewLoading !== null)}
                      >
                        {isLoading ? (
                          <svg className="rpanel-voice-play__spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <circle cx="12" cy="12" r="10" strokeDasharray="30 70" />
                          </svg>
                        ) : isPlaying ? (
                          <div className="rpanel-voice-eq" aria-label="Playing">
                            <span /><span /><span /><span />
                          </div>
                        ) : (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                            <polygon points="6 3 20 12 6 21 6 3" />
                          </svg>
                        )}
                      </button>
                      <span className="rpanel-voice-btn__label">{v.label}</span>
                      {voice === v.id && (
                        <svg className="rpanel-voice-btn__check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="rpanel-flat-section">
          <span className="rpanel-flat-label">Speed</span>
          <div
            className="rpanel-seg-group rpanel-seg-group--full"
            data-count={SPEEDS.length}
            data-active={SPEEDS.indexOf(speed as typeof SPEEDS[number])}
          >
            <span className="rpanel-slide-pill" />
            {SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                className={`rpanel-seg-btn ${speed === s ? "rpanel-seg-btn--active" : ""}`}
                onClick={() => setSpeed(s)}
              >
                {s}x
              </button>
            ))}
          </div>
        </div>

        <div className="rpanel-flat-section">
          <span className="rpanel-flat-label">Emotion</span>
          <div
            className="rpanel-seg-group rpanel-seg-group--full"
            data-count={EMOTIONS.length}
            data-active={EMOTIONS.findIndex((em) => em.id === emotion)}
          >
            <span className="rpanel-slide-pill" />
            {EMOTIONS.map((em) => (
              <button
                key={em.id}
                type="button"
                className={`rpanel-seg-btn ${emotion === em.id ? "rpanel-seg-btn--active" : ""}`}
                onClick={() => setEmotion(em.id)}
              >
                {em.label}
              </button>
            ))}
          </div>
        </div>

        <div className="rpanel-flat-section">
          <span className="rpanel-flat-label">Output Format</span>
          <div
            className="rpanel-seg-group rpanel-seg-group--full"
            data-count={OUTPUT_FORMATS.length}
            data-active={OUTPUT_FORMATS.findIndex((f) => f.id === outputFormat)}
          >
            <span className="rpanel-slide-pill" />
            {OUTPUT_FORMATS.map((f) => (
              <button
                key={f.id}
                type="button"
                className={`rpanel-seg-btn ${outputFormat === f.id ? "rpanel-seg-btn--active" : ""}`}
                onClick={() => setOutputFormat(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="rpanel-footer">
        <button type="button" className={gate.className("rpanel-action-btn rpanel-action-btn--tall")} onClick={() => {
          gate.handleClick(() => {
            onGenerate({ text, voice, speed, emotion, outputFormat });
          });
        }}>
          <GenerateButtonCost cost={totalCost} params={estimateParams} visible={gate.state === "ready"} />
          <span style={{ flex: 1, textAlign: "center" }}>{gate.label("Generate Speech")}</span>
        </button>
      </div>
    </aside>
  );
}
