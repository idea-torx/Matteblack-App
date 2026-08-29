import { useState, useEffect, useMemo } from "react";
import { useEstimateCost } from "../hooks/useEstimateCost";
import { useGenerateButton } from "../hooks/useGenerateButton";
import { GenerateButtonCost } from "./GenerateButtonCost";
import "./RightPanel.css";

export type SfxParams = {
  prompt: string;
  durationSeconds: number;
  promptInfluence: number;
};

type SfxPanelProps = {
  onGenerate: (params: SfxParams) => void;
  creditsRequired?: number;
  userBalance?: number;
  unlimited?: boolean;
  initialValues?: SfxParams | null;
  reuseVersion?: number;
};

const DURATIONS = [
  { label: "Auto", value: 0 },
  { label: "0.5s", value: 0.5 },
  { label: "1s", value: 1 },
  { label: "2s", value: 2 },
  { label: "5s", value: 5 },
  { label: "10s", value: 10 },
  { label: "15s", value: 15 },
  { label: "22s", value: 22 },
] as const;

export function SfxPanel({ onGenerate, creditsRequired = 10, userBalance = 0, unlimited = false, initialValues, reuseVersion = 0 }: SfxPanelProps) {
  const [prompt, setPrompt] = useState("");
  const [durationSeconds, setDurationSeconds] = useState(5);
  const [promptInfluence, setPromptInfluence] = useState(0.3);

  const estimateParams = useMemo(() => ({
    type: "audio_sfx",
    model: "elevenlabs-sfx",
    duration: durationSeconds,
  }), [durationSeconds]);
  const { cost: estimatedCost } = useEstimateCost(estimateParams);
  const totalCost = estimatedCost !== null ? estimatedCost : creditsRequired;
  const gate = useGenerateButton(userBalance, unlimited, totalCost);

  useEffect(() => {
    if (!initialValues) return;
    setPrompt(initialValues.prompt ?? "");
    if (initialValues.durationSeconds != null) setDurationSeconds(initialValues.durationSeconds);
    if (initialValues.promptInfluence != null) setPromptInfluence(initialValues.promptInfluence);
  }, [reuseVersion]);

  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    prompt: true,
    duration: false,
    influence: false,
  });

  const toggle = (key: string) =>
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));

  return (
    <aside className="rpanel">
      <div className="rpanel-scroll">
        <div className="rpanel-card rpanel-card--prompt">
          <div className="rpanel-card-toggle" style={{ cursor: "default" }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" /></svg>
            <span className="rpanel-card-toggle-label">Prompt</span>
          </div>
          <textarea
            className="rpanel-textarea"
            placeholder="Describe the sound effect you want to generate..."
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>

        <div className="rpanel-card">
          <button type="button" className="rpanel-card-toggle" onClick={() => toggle("duration")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            <span className="rpanel-card-toggle-label">Duration</span>
            <span className="rpanel-tag">{DURATIONS.find((d) => d.value === durationSeconds)?.label ?? `${durationSeconds}s`}</span>
            <svg className={`rpanel-card-chevron ${openSections.duration ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          {openSections.duration && (
            <div className="rpanel-card-body">
              <div className="rpanel-btn-row">
                {DURATIONS.map((d) => (
                  <button
                    key={d.value}
                    type="button"
                    className={`rpanel-btn-row-item ${durationSeconds === d.value ? "rpanel-btn-row-item--active" : ""}`}
                    onClick={() => setDurationSeconds(d.value)}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="rpanel-card">
          <button type="button" className="rpanel-card-toggle" onClick={() => toggle("influence")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" />
              <line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" />
              <line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" />
              <line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" />
            </svg>
            <span className="rpanel-card-toggle-label">Prompt Influence</span>
            <span className="rpanel-tag">{promptInfluence.toFixed(1)}</span>
            <svg className={`rpanel-card-chevron ${openSections.influence ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          {openSections.influence && (
            <div className="rpanel-card-body">
              <div className="rpanel-slider-group">
                <div className="rpanel-slider-header">
                  <span className="rpanel-slider-label">How closely to follow the prompt</span>
                  <span className="rpanel-slider-value">{promptInfluence.toFixed(1)}</span>
                </div>
                <input
                  type="range"
                  className="rpanel-slider"
                  min="0"
                  max="1"
                  step="0.1"
                  value={promptInfluence}
                  onChange={(e) => setPromptInfluence(parseFloat(e.target.value))}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="rpanel-footer">
        <button type="button" className={gate.className("rpanel-action-btn rpanel-action-btn--tall")} onClick={() => {
          gate.handleClick(() => {
            if (!prompt.trim()) return;
            onGenerate({ prompt, durationSeconds, promptInfluence });
          });
        }}>
          <GenerateButtonCost cost={totalCost} params={estimateParams} visible={gate.state === "ready"} />
          <span style={{ flex: 1, textAlign: "center" }}>{gate.label("Generate SFX")}</span>
        </button>
      </div>
    </aside>
  );
}
