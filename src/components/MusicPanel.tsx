import { useState, useEffect, useMemo } from "react";
import { useEstimateCost } from "../hooks/useEstimateCost";
import { useGenerateButton } from "../hooks/useGenerateButton";
import { GenerateButtonCost } from "./GenerateButtonCost";
import "./RightPanel.css";

export type MusicGenerationParams = {
  prompt: string;
  lyrics: string;
  isInstrumental: boolean;
};

type MusicPanelProps = {
  onGenerate: (params: MusicGenerationParams) => void;
  creditsRequired?: number;
  userBalance?: number;
  unlimited?: boolean;
  externalPrompt?: string | null;
  onClearExternalPrompt?: () => void;
  initialValues?: MusicGenerationParams | null;
  reuseVersion?: number;
};

const STRUCTURE_TAGS = [
  "[Intro]", "[Verse]", "[Pre Chorus]", "[Chorus]", "[Post Chorus]",
  "[Hook]", "[Bridge]", "[Interlude]", "[Transition]", "[Build Up]",
  "[Break]", "[Inst]", "[Solo]", "[Outro]",
];

export function MusicPanel({ onGenerate, creditsRequired = 30, userBalance = 0, unlimited = false, externalPrompt, onClearExternalPrompt, initialValues, reuseVersion = 0 }: MusicPanelProps) {
  const [prompt, setPrompt] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [isInstrumental, setIsInstrumental] = useState(false);

  useEffect(() => {
    if (externalPrompt) {
      setPrompt(externalPrompt);
      onClearExternalPrompt?.();
    }
  }, [externalPrompt, onClearExternalPrompt]);

  const estimateParams = useMemo(() => ({
    type: "audio_music",
    model: "minimax-music",
  }), []);
  const { cost: estimatedCost } = useEstimateCost(estimateParams);
  const totalCost = estimatedCost !== null ? estimatedCost : creditsRequired;

  const promptValid = prompt.length >= 10;
  const lyricsValid = isInstrumental || lyrics.trim().length > 0;
  const canGenerate = promptValid && lyricsValid;
  const gate = useGenerateButton(userBalance, unlimited, totalCost);

  useEffect(() => {
    if (!initialValues) return;
    setPrompt(initialValues.prompt ?? "");
    setLyrics(initialValues.lyrics ?? "");
    setIsInstrumental(initialValues.isInstrumental ?? false);
  }, [reuseVersion]);

  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    style: true,
  });

  const toggle = (key: string) =>
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));

  return (
    <aside className="rpanel">
      <div className="rpanel-scroll">
        <div className="rpanel-mode-toggle" data-active={isInstrumental ? "1" : "0"}>
          <span className="rpanel-slide-pill" />
          <button
            type="button"
            className={`rpanel-mode-btn ${!isInstrumental ? "rpanel-mode-btn--active" : ""}`}
            onClick={() => setIsInstrumental(false)}
          >
            Lyrics
          </button>
          <button
            type="button"
            className={`rpanel-mode-btn ${isInstrumental ? "rpanel-mode-btn--active" : ""}`}
            onClick={() => setIsInstrumental(true)}
          >
            Instrumental
          </button>
        </div>

        <div className="rpanel-panel-fade" key={isInstrumental ? "instrumental" : "lyrics"}>
          {!isInstrumental && (
            <div className="rpanel-card rpanel-card--prompt">
              <div className="rpanel-card-toggle" style={{ cursor: "default" }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
                </svg>
                <span className="rpanel-card-toggle-label">Lyrics</span>
              </div>
              <textarea
                className="rpanel-textarea"
                style={{ minHeight: "120px" }}
                placeholder={`Enter lyrics with structure tags...\n\n${STRUCTURE_TAGS.join("  ")}`}
                value={lyrics}
                onChange={(e) => setLyrics(e.target.value)}
              />
            </div>
          )}

          <div className="rpanel-card">
            <button type="button" className="rpanel-card-toggle" onClick={() => toggle("style")}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" /></svg>
              <span className="rpanel-card-toggle-label">Style / Mood / Genre</span>
              <svg className={`rpanel-card-chevron ${openSections.style ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
            </button>
            {openSections.style && (
              <div className="rpanel-card-body">
                <textarea
                  className="rpanel-textarea"
                  placeholder="Describe the style, mood, and genre (10-300 characters)..."
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  maxLength={300}
                />
                <div style={{ textAlign: "right", fontSize: "11px", opacity: 0.5, marginTop: "2px" }}>{prompt.length}/300</div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="rpanel-footer">
        <button type="button" className={gate.className("rpanel-action-btn rpanel-action-btn--tall")} disabled={!canGenerate} onClick={() => {
          if (!canGenerate) return;
          gate.handleClick(() => {
            onGenerate({
              prompt,
              lyrics,
              isInstrumental,
            });
          });
        }}>
          <GenerateButtonCost cost={totalCost} params={estimateParams} visible={gate.state === "ready" && canGenerate} />
          <span style={{ flex: 1, textAlign: "center" }}>{gate.label("Generate Music")}</span>
        </button>
      </div>
    </aside>
  );
}
