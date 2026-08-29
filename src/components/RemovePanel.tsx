import { useMemo, useState } from "react";
import { useEstimateCost } from "../hooks/useEstimateCost";
import { useGenerateButton } from "../hooks/useGenerateButton";
import { GenerateButtonCost } from "./GenerateButtonCost";
import "./RightPanel.css";
import type { ReferenceImage } from "../types/canvas";
import type { GenerationParams } from "./MakePanel";

type RemovePanelProps = {
  onRemoveBackground: (params: GenerationParams) => void;
  creditsRequired?: number;
  userBalance?: number;
  unlimited?: boolean;
  referenceImage?: ReferenceImage | null;
  onClearReference?: () => void;
};

export function RemovePanel({ onRemoveBackground, creditsRequired = 1, userBalance = 0, unlimited = false, referenceImage = null, onClearReference }: RemovePanelProps) {
  const hasSelectedImage = !!referenceImage;
  const [model, setModel] = useState<string>("pixelcut_remove_bg");
  const [openSections, setOpenSections] = useState<{ model: boolean }>({ model: false });

  const estimateParams = useMemo(() => ({
    type: "remove_bg",
    model,
  }), [model]);
  const { cost: estimatedCost } = useEstimateCost(estimateParams);
  const totalCost = estimatedCost !== null ? estimatedCost : creditsRequired;

  const gate = useGenerateButton(userBalance, unlimited, totalCost);

  const getBackgroundImage = (gradient: string) => {
    if (!gradient) return "none";
    if (gradient.startsWith("url(") || gradient.startsWith("linear-gradient") || gradient.startsWith("radial-gradient")) return gradient;
    return `url(${gradient})`;
  };

  const extractImageUrl = (gradient: string): string => {
    if (!gradient) return "";
    const urlMatch = gradient.match(/^url\(["']?(.*?)["']?\)$/);
    if (urlMatch) return urlMatch[1];
    if (gradient.startsWith("http://") || gradient.startsWith("https://") || gradient.startsWith("data:") || gradient.startsWith("/")) return gradient;
    return gradient;
  };

  return (
    <aside className="rpanel">
      <div className="rpanel-scroll">
        {hasSelectedImage ? (
          <div className="rpanel-card">
            <h3 className="rpanel-card-title" style={{ marginBottom: 8 }}>
              Image
            </h3>
            <div className="rpanel-ref-grid">
              <div className="rpanel-ref-large-thumb">
                <div
                  className="rpanel-ref-large-thumb-img"
                  style={{ backgroundImage: getBackgroundImage(referenceImage!.gradient) }}
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
          </div>
        ) : (
          <div className="rpanel-card">
            <div className="rpanel-empty-state">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
              </svg>
              <span className="rpanel-empty-state-text">Select an image on the canvas to remove its background</span>
            </div>
          </div>
        )}

        <div className="rpanel-card">
          <button
            type="button"
            className="rpanel-card-toggle"
            onClick={() => setOpenSections(s => ({ ...s, model: !s.model }))}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
            <span className="rpanel-card-toggle-label">Model</span>
            <span className="rpanel-tag" style={{ background: "transparent", color: "var(--text-muted)", padding: 0, fontSize: 11 }}>{model === "pixelcut_remove_bg" ? "Pixelcut" : "Bria"}</span>
            <svg className={`rpanel-card-chevron ${openSections.model ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          {openSections.model && (
            <div className="rpanel-card-body">
              <div className="rpanel-list">
                <button
                  type="button"
                  className={`rpanel-list-btn ${model === "pixelcut_remove_bg" ? "rpanel-list-btn--active" : ""}`}
                  onClick={() => setModel("pixelcut_remove_bg")}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18" /><path d="M3 9h6" /></svg>
                  Pixelcut
                  <span className="rpanel-tag">Default</span>
                </button>
                <button
                  type="button"
                  className={`rpanel-list-btn ${model === "remove_bg" ? "rpanel-list-btn--active" : ""}`}
                  onClick={() => setModel("remove_bg")}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M8 12h8" /><path d="M12 8v8" /></svg>
                  Bria
                  <span className="rpanel-tag">Affordable</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="rpanel-footer">
        <button
          type="button"
          className={gate.className("rpanel-action-btn rpanel-action-btn--tall")}
          disabled={gate.state === "ready" && !hasSelectedImage}
          onClick={() => {
            gate.handleClick(() => {
              if (!hasSelectedImage) return;
              const imageUrl = extractImageUrl(referenceImage!.gradient);
              if (!imageUrl || !(imageUrl.startsWith("http://") || imageUrl.startsWith("https://") || imageUrl.startsWith("data:") || imageUrl.startsWith("/"))) return;
              onRemoveBackground({
                model,
                prompt: "",
                referenceImageUrls: [imageUrl],
                jobType: "remove_bg",
              });
            });
          }}
        >
          <GenerateButtonCost cost={totalCost} params={estimateParams} visible={gate.state === "ready" && hasSelectedImage} />
          <span style={{ flex: 1, textAlign: "center" }}>{gate.label("Remove Background")}</span>
        </button>
      </div>
    </aside>
  );
}
