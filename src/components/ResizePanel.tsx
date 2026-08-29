import { useState, useCallback, useEffect, useMemo } from "react";
import { useEstimateCost } from "../hooks/useEstimateCost";
import { useGenerateButton } from "../hooks/useGenerateButton";
import { GenerateButtonCost } from "./GenerateButtonCost";
import "./RightPanel.css";
import type { ReferenceImage } from "../types/canvas";
import type { GenerationParams } from "./MakePanel";

type AspectRatio = "1:1" | "16:9" | "9:16" | "4:3" | "3:4" | "5:4" | "4:5" | "3:2" | "2:3";

const ASPECT_RATIOS: AspectRatio[] = ["1:1", "16:9", "9:16", "4:3", "3:4", "5:4", "4:5", "3:2", "2:3"];

type SocialKitOption = {
  id: string;
  label: string;
  ratio: AspectRatio;
};

const SOCIAL_KIT_OPTIONS: SocialKitOption[] = [
  { id: "ig-post", label: "Instagram Post", ratio: "1:1" },
  { id: "ig-story", label: "Instagram Story / TikTok", ratio: "9:16" },
  { id: "ig-portrait", label: "Instagram Portrait", ratio: "4:5" },
  { id: "yt-thumb", label: "YouTube Thumbnail", ratio: "16:9" },
  { id: "fb-cover", label: "Facebook Cover", ratio: "16:9" },
  { id: "pin", label: "Pinterest Pin", ratio: "2:3" },
  { id: "x-header", label: "Twitter / X Header", ratio: "16:9" },
];

type ResizePanelProps = {
  onResizeImage: (params: string | GenerationParams, jobType?: string) => void;
  creditsRequired?: number;
  userBalance?: number;
  unlimited?: boolean;
  referenceImage?: ReferenceImage | null;
  onClearReference?: () => void;
  externalPrompt?: string | null;
  onClearExternalPrompt?: () => void;
};

export function ResizePanel({ onResizeImage, creditsRequired = 2, userBalance = 0, unlimited = false, referenceImage = null, onClearReference, externalPrompt, onClearExternalPrompt }: ResizePanelProps) {
  const hasSelectedImage = !!referenceImage;

  const estimateParams = useMemo(() => ({
    type: "resize",
    model: "bria_expand",
  }), []);
  const { cost: estimatedCost } = useEstimateCost(estimateParams);
  const totalCost = estimatedCost !== null ? estimatedCost : creditsRequired;

  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("16:9");
  const [socialKit, setSocialKit] = useState<Set<string>>(new Set());
  const [prompt, setPrompt] = useState("");

  useEffect(() => {
    if (externalPrompt) {
      setPrompt(externalPrompt);
      onClearExternalPrompt?.();
    }
  }, [externalPrompt, onClearExternalPrompt]);

  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    aspectRatio: false,
    socialKit: false,
    prompt: false,
  });

  const toggle = (key: string) =>
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));

  const toggleSocialKit = useCallback((id: string) => {
    setSocialKit((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const socialKitCount = socialKit.size;
  const effectiveCost = socialKitCount > 0 ? totalCost * socialKitCount : totalCost;
  const gate = useGenerateButton(userBalance, unlimited, effectiveCost);

  const arIcon = (ar: AspectRatio, size = 14) => {
    const [w, h] = ar.split(":").map(Number);
    const ratio = w / h;
    const pad = 3;
    const inner = size - pad * 2;
    let rw: number, rh: number;
    if (ratio >= 1) {
      rw = inner;
      rh = inner / ratio;
    } else {
      rh = inner;
      rw = inner * ratio;
    }
    const rx = (size - rw) / 2;
    const ry = (size - rh) / 2;
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x={rx} y={ry} width={rw} height={rh} rx={1.5} />
      </svg>
    );
  };

  const getBackgroundImage = (gradient: string) => {
    if (!gradient) return "none";
    if (gradient.startsWith("url(") || gradient.startsWith("linear-gradient") || gradient.startsWith("radial-gradient")) return gradient;
    return `url(${gradient})`;
  };

  const getReferenceUrl = (): string | null => {
    if (!referenceImage) return null;
    const g = referenceImage.gradient;
    if (!g) return null;
    const urlMatch = g.match(/url\(["']?([^"')]+)["']?\)/);
    if (urlMatch) return urlMatch[1];
    if (g.startsWith("http") || g.startsWith("data:") || g.startsWith("/")) return g;
    return null;
  };

  const buildParams = (ar: string): GenerationParams => {
    const refUrl = getReferenceUrl();
    return {
      jobType: "resize",
      model: "bria_expand",
      prompt: prompt.trim(),
      aspectRatio: ar,
      referenceImageUrls: refUrl ? [refUrl] : [],
    };
  };

  const handleSubmit = () => {
    gate.handleClick(() => {
      if (socialKitCount > 0) {
        const selectedFormats = SOCIAL_KIT_OPTIONS.filter((opt) => socialKit.has(opt.id));
        for (const fmt of selectedFormats) {
          onResizeImage(buildParams(fmt.ratio));
        }
      } else {
        onResizeImage(buildParams(aspectRatio));
      }
    });
  };

  return (
    <aside className="rpanel">
      <div className="rpanel-scroll">
        {hasSelectedImage && referenceImage ? (
          <div className="rpanel-card">
            <h3 className="rpanel-card-title" style={{ marginBottom: 8 }}>Reference Image</h3>
            <div className="rpanel-ref-grid">
              <div className="rpanel-ref-large-thumb">
                <div
                  className="rpanel-ref-large-thumb-img"
                  style={{ backgroundImage: getBackgroundImage(referenceImage.gradient) }}
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
            <h3 className="rpanel-card-title" style={{ marginBottom: 8 }}>Reference Image</h3>
            <p className="rpanel-hint">Select an image on the canvas to resize it</p>
          </div>
        )}

        {/* Aspect Ratio */}
        <div className="rpanel-card">
          <button type="button" className="rpanel-card-toggle" onClick={() => toggle("aspectRatio")}>
            {arIcon(aspectRatio, 12)}
            <span className="rpanel-card-toggle-label">Aspect Ratio</span>
            {!openSections.aspectRatio && <span className="rpanel-tag">{aspectRatio}</span>}
            <svg className={`rpanel-card-chevron ${openSections.aspectRatio ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          {openSections.aspectRatio && (
            <div className="rpanel-card-body">
              <div className="rpanel-list">
                {ASPECT_RATIOS.map((ar) => (
                  <button
                    key={ar}
                    type="button"
                    className={`rpanel-list-btn ${aspectRatio === ar ? "rpanel-list-btn--active" : ""}`}
                    onClick={() => setAspectRatio(ar)}
                  >
                    {arIcon(ar)}
                    {ar}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Social Kit */}
        <div className="rpanel-card">
          <button type="button" className="rpanel-card-toggle" onClick={() => toggle("socialKit")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" /><polyline points="22 6 12 13 2 6" /></svg>
            <span className="rpanel-card-toggle-label">Social Kit</span>
            {!openSections.socialKit && socialKitCount > 0 && (
              <span className="rpanel-tag">{socialKitCount} selected</span>
            )}
            <svg className={`rpanel-card-chevron ${openSections.socialKit ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          {openSections.socialKit && (
            <div className="rpanel-card-body">
              <div className="rpanel-list">
                {SOCIAL_KIT_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    className={`rpanel-list-btn ${socialKit.has(opt.id) ? "rpanel-list-btn--active" : ""}`}
                    onClick={() => toggleSocialKit(opt.id)}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      {socialKit.has(opt.id) ? (
                        <>
                          <rect x="3" y="3" width="18" height="18" rx="2" />
                          <polyline points="9 11 12 14 22 4" />
                        </>
                      ) : (
                        <rect x="3" y="3" width="18" height="18" rx="2" />
                      )}
                    </svg>
                    {opt.label}
                    <span className="rpanel-tag" style={{ marginLeft: "auto" }}>{opt.ratio}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Prompt (optional) */}
        <div className="rpanel-card">
          <button type="button" className="rpanel-card-toggle" onClick={() => toggle("prompt")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" /></svg>
            <span className="rpanel-card-toggle-label">Prompt</span>
            <svg className={`rpanel-card-chevron ${openSections.prompt ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          {openSections.prompt && (
            <div className="rpanel-card-body">
              <textarea
                className="rpanel-textarea"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Describe how the expanded area should look..."
                style={{ minHeight: 60, maxHeight: 120 }}
              />
            </div>
          )}
        </div>
      </div>

      {/* Action footer */}
      <div className="rpanel-footer">
        <button type="button" className={gate.className("rpanel-action-btn rpanel-action-btn--tall")} onClick={handleSubmit}>
          <GenerateButtonCost cost={effectiveCost} params={estimateParams} visible={gate.state === "ready"} />
          <span style={{ flex: 1, textAlign: "center" }}>{gate.label(socialKitCount > 0 ? `Resize (${socialKitCount} formats)` : "Resize Image")}</span>
        </button>
      </div>
    </aside>
  );
}
