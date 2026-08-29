import { useState, useMemo, useEffect } from "react";
import { useEstimateCost } from "../hooks/useEstimateCost";
import { useGenerateButton } from "../hooks/useGenerateButton";
import { GenerateButtonCost } from "./GenerateButtonCost";
import type { GenerationParams } from "./MakePanel";
import type { ReferenceImage } from "../types/canvas";
import "./RightPanel.css";
import "./VectorPanel.css";

interface VectorPanelProps {
  onClose: () => void;
  onGenerate: (params: GenerationParams) => void;
  creditsRequired?: number;
  userBalance?: number;
  unlimited?: boolean;
  canvasReferenceImages?: ReferenceImage[];
  onClearReference?: () => void;
}

const SIZE_PRESETS = [
  { id: "square_hd", label: "1:1", tag: "Square" },
  { id: "landscape_16_9", label: "16:9", tag: "Landscape" },
  { id: "portrait_16_9", label: "9:16", tag: "Portrait" },
  { id: "landscape_4_3", label: "4:3", tag: "Landscape" },
  { id: "portrait_4_3", label: "3:4", tag: "Portrait" },
] as const;

function parseHexColors(input: string): Array<{ r: number; g: number; b: number }> {
  if (!input.trim()) return [];
  return input
    .split(",")
    .map((s) => s.trim().replace(/^#/, ""))
    .filter((hex) => /^[0-9a-fA-F]{6}$/.test(hex))
    .map((hex) => ({
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    }));
}

export function VectorPanel({ onClose: _onClose, onGenerate, creditsRequired = 10, userBalance = 0, unlimited = false, canvasReferenceImages = [], onClearReference }: VectorPanelProps) {
  const hasReference = canvasReferenceImages.length > 0;
  const [mode, setMode] = useState<"text" | "image">(hasReference ? "image" : "text");
  const isImageToVector = mode === "image";

  useEffect(() => {
    if (hasReference) setMode("image");
  }, [hasReference]);

  const effectiveModel = isImageToVector ? "recraft-vectorize" : "recraft-v4-vector";
  const effectiveJobType = isImageToVector ? "image_to_vector" : "text_to_vector";

  const estimateParams = useMemo(() => ({
    type: effectiveJobType,
    model: effectiveModel,
  }), [effectiveJobType, effectiveModel]);
  const { cost: estimatedCost } = useEstimateCost(estimateParams);
  const totalCost = estimatedCost !== null ? estimatedCost : creditsRequired;

  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState("square_hd");
  const [colors, setColors] = useState("");

  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    size: false,
    colors: false,
  });
  const toggle = (key: string) =>
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));

  const gate = useGenerateButton(userBalance, unlimited, totalCost);
  const canGenerate = isImageToVector
    ? hasReference && gate.state === "ready"
    : prompt.trim().length > 0 && gate.state === "ready";

  const handleGenerate = () => {
    gate.handleClick(() => {
      if (isImageToVector) {
        const refUrl = canvasReferenceImages[0]?.gradient || "";
        const params: GenerationParams = {
          model: "recraft-vectorize",
          prompt: "",
          jobType: "image_to_vector",
          imageUrl: refUrl,
          referenceImageUrls: [refUrl],
        };
        onGenerate(params);
      } else {
        if (!prompt.trim()) return;
        const parsedColors = parseHexColors(colors);
        const params: GenerationParams = {
          model: "recraft-v4-vector",
          prompt: prompt.trim(),
          jobType: "text_to_vector",
          imageSize: size,
          colors: parsedColors.length > 0 ? parsedColors : undefined,
        };
        onGenerate(params);
      }
    });
  };

  const getBackgroundImage = (gradient: string) => {
    if (!gradient) return "none";
    if (gradient.startsWith("url(") || gradient.startsWith("linear-gradient") || gradient.startsWith("radial-gradient")) return gradient;
    return `url(${gradient})`;
  };

  return (
    <aside className="rpanel">
      <div className="rpanel-scroll">
        <div className="rpanel-mode-toggle">
          <button
            type="button"
            className={`rpanel-mode-btn ${!isImageToVector ? "rpanel-mode-btn--active" : ""}`}
            onClick={() => setMode("text")}
          >
            Text to Vector
          </button>
          <button
            type="button"
            className={`rpanel-mode-btn ${isImageToVector ? "rpanel-mode-btn--active" : ""}`}
            onClick={() => setMode("image")}
          >
            Image to Vector
          </button>
        </div>

        {isImageToVector ? (
          <div className="rpanel-card">
            <h3 className="rpanel-card-title" style={{ marginBottom: 8 }}>
              Reference Image
            </h3>
            {hasReference ? (
              <>
                <div className="rpanel-ref-grid">
                  <div className="rpanel-ref-large-thumb">
                    <div
                      className="rpanel-ref-large-thumb-img"
                      style={{ backgroundImage: getBackgroundImage(canvasReferenceImages[0]?.gradient || "") }}
                    />
                  </div>
                </div>
                <button
                  type="button"
                  className="rpanel-ref-clear-all"
                  onClick={() => onClearReference?.()}
                >
                  Clear
                </button>
              </>
            ) : (
              <div style={{ padding: "12px 0 4px", color: "var(--text-muted)", fontSize: 12 }}>
                Select an image on the canvas to vectorize
              </div>
            )}
          </div>
        ) : (
          <div className="rpanel-card rpanel-card--prompt">
            <div className="rpanel-card-toggle" style={{ cursor: "default", marginBottom: 0 }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" /></svg>
              <span className="rpanel-card-toggle-label">Prompt</span>
            </div>
            <textarea
              className="rpanel-textarea"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe the vector graphic you want to create..."
            />
          </div>
        )}

        {!isImageToVector && (
          <>
            <div className="rpanel-card">
              <button type="button" className="rpanel-card-toggle" onClick={() => toggle("size")}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" />
                  <line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />
                </svg>
                <span className="rpanel-card-toggle-label">Size</span>
                {!openSections.size && <span className="rpanel-tag">{SIZE_PRESETS.find((s) => s.id === size)?.label}</span>}
                <svg className={`rpanel-card-chevron ${openSections.size ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
              </button>
              {openSections.size && (
                <div className="rpanel-card-body">
                  <div className="rpanel-list">
                    {SIZE_PRESETS.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        className={`rpanel-list-btn ${size === s.id ? "rpanel-list-btn--active" : ""}`}
                        onClick={() => setSize(s.id)}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="3" y="3" width="18" height="18" rx="2" />
                        </svg>
                        {s.label}
                        <span className="rpanel-tag">{s.tag}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="rpanel-card">
              <button type="button" className="rpanel-card-toggle" onClick={() => toggle("colors")}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="13.5" cy="6.5" r="2.5" /><circle cx="17.5" cy="10.5" r="2.5" />
                  <circle cx="8.5" cy="7.5" r="2.5" /><circle cx="6.5" cy="12.5" r="2.5" />
                  <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.555C21.965 6.012 17.461 2 12 2z" />
                </svg>
                <span className="rpanel-card-toggle-label">Colors</span>
                <span className="rpanel-tag" style={{ opacity: 0.5 }}>Optional</span>
                <svg className={`rpanel-card-chevron ${openSections.colors ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
              </button>
              {openSections.colors && (
                <div className="rpanel-card-body">
                  <input
                    type="text"
                    className="rpanel-search"
                    placeholder="#FF6B6B, #4ECDC4, #556270..."
                    value={colors}
                    onChange={(e) => setColors(e.target.value)}
                  />
                  <span className="vector-colors-hint">Comma-separated hex colors to guide the palette</span>
                </div>
              )}
            </div>
          </>
        )}

      </div>

      <div className="rpanel-footer">
        <button
          type="button"
          className={gate.className(`rpanel-action-btn rpanel-action-btn--tall ${canGenerate || gate.state !== "ready" ? "" : "rpanel-action-btn--disabled"}`)}
          disabled={gate.state === "ready" && !canGenerate}
          onClick={handleGenerate}
        >
          <GenerateButtonCost cost={totalCost} params={estimateParams} visible={gate.state === "ready" && canGenerate} />
          <span style={{ flex: 1, textAlign: "center" }}>{gate.label(isImageToVector ? "Vectorize" : "Generate SVG")}</span>
        </button>
      </div>
    </aside>
  );
}
