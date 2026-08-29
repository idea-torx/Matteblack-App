import { useState, useEffect, useRef } from "react";
import { LoadingWaveform } from "./LoadingWaveform";
import "./GenerationWait.css";

type Stage = { label: string; weight: number };

type GenerationWaitProps = {
  stages?: Stage[];
  contextLabel?: string;
  estimatedRange?: string;
  onCancel?: () => void;
  isDone?: boolean;
  aspectRatio?: string;
};

const DEFAULT_STAGES: Stage[] = [
  { label: "Analyzing brief", weight: 0.1 },
  { label: "Composing structure", weight: 0.2 },
  { label: "Generating output", weight: 0.45 },
  { label: "Rendering", weight: 0.2 },
  { label: "Finalizing", weight: 0.05 },
];

const BASE_DURATION = 28_000;
const TICK_MS = 80;

function jitter(ms: number) {
  return ms * (0.85 + Math.random() * 0.3);
}

function arToCSS(ar: string): string {
  const parts = ar.split(":");
  if (parts.length === 2) return `${parts[0]} / ${parts[1]}`;
  return "1 / 1";
}

export function GenerationWait({
  stages = DEFAULT_STAGES,
  contextLabel = "Generating",
  estimatedRange = "30–90s",
  onCancel,
  isDone = false,
  aspectRatio = "1:1",
}: GenerationWaitProps) {
  const [elapsed, setElapsed] = useState(0);
  const [totalProgress, setTotalProgress] = useState(0);
  const [activeStageIndex, setActiveStageIndex] = useState(0);
  const [stageProgress, setStageProgress] = useState(0);
  const [dots, setDots] = useState("");

  const progressRef = useRef(0);

  const stageDurationsRef = useRef<number[]>(
    stages.map((s) => jitter(s.weight * BASE_DURATION)),
  );

  useEffect(() => {
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const cycle = ["", ".", "..", "..."];
    let i = 0;
    const id = setInterval(() => {
      i = (i + 1) % cycle.length;
      setDots(cycle[i]);
    }, 500);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (isDone) {
      setTotalProgress(1);
      progressRef.current = 1;
      setActiveStageIndex(stages.length);
      setStageProgress(1);
      return;
    }

    const durations = stageDurationsRef.current;
    let stageIdx = 0;
    let stageElapsed = 0;

    const id = setInterval(() => {
      if (stageIdx >= stages.length) { clearInterval(id); return; }

      stageElapsed += TICK_MS;
      const dur = durations[stageIdx];
      const sp = Math.min(stageElapsed / dur, 0.97);

      let completedWeight = 0;
      for (let i = 0; i < stageIdx; i++) completedWeight += stages[i].weight;
      const tp = Math.min(completedWeight + stages[stageIdx].weight * sp, 0.97);

      setActiveStageIndex(stageIdx);
      setStageProgress(sp);
      setTotalProgress(tp);
      progressRef.current = tp;

      if (stageElapsed >= dur && stageIdx < stages.length - 1) {
        stageIdx++;
        stageElapsed = 0;
      }
    }, TICK_MS);

    return () => clearInterval(id);
  }, [isDone, stages]);

  return (
    <div className="genwait-card" style={{ aspectRatio: arToCSS(aspectRatio) }}>
      <div className="genwait-wave-bg">
        <LoadingWaveform
          progress={totalProgress}
          height={120}
          waveColor="rgba(96, 165, 250, 0.4)"
          isDone={isDone}
        />
      </div>

      <div className="genwait-inner">
        <div className="genwait-top">
          <span className="genwait-context">{contextLabel}</span>
          <span className="genwait-elapsed">{elapsed}s</span>
        </div>

        <div className="genwait-bar-track">
          <div
            className="genwait-bar-fill"
            style={{ width: `${totalProgress * 100}%` }}
          />
        </div>

        <div className="genwait-stages">
          {stages.map((stage, i) => {
            let state: "upcoming" | "active" | "completed";
            if (isDone || i < activeStageIndex) state = "completed";
            else if (i === activeStageIndex) state = "active";
            else state = "upcoming";

            return (
              <div key={i} className={`genwait-stage genwait-stage--${state}`}>
                <span className="genwait-stage-dot" />
                <span className="genwait-stage-label">
                  {stage.label}
                  {state === "active" && <span className="genwait-dots">{dots}</span>}
                </span>
                {state === "active" && (
                  <span className="genwait-stage-pct">
                    {Math.round(stageProgress * 100)}%
                  </span>
                )}
              </div>
            );
          })}
        </div>

        <div className="genwait-bottom">
          <span className="genwait-estimate">Usually {estimatedRange}</span>
          {onCancel && (
            <button type="button" className="genwait-cancel" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
