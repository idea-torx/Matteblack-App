import { useState, useEffect } from "react";
import "./RightPanel.css";
import type { ReferenceImage } from "../types/canvas";
import { useGenerateButton } from "../hooks/useGenerateButton";
import { GenerateButtonCost } from "./GenerateButtonCost";


type RightPanelProps = {
  onEditImage: (ar: string, jobType?: string, imageNumber?: number) => void;
  creditsRequired?: number;
  userBalance?: number;
  unlimited?: boolean;
  referenceImage?: ReferenceImage | null;
  onClearReference?: () => void;
  externalPrompt?: string | null;
  onClearExternalPrompt?: () => void;
};

export function RightPanel({ onEditImage, creditsRequired = 0, userBalance = 0, unlimited = false, referenceImage = null, onClearReference, externalPrompt, onClearExternalPrompt }: RightPanelProps) {
  const hasSelectedImage = !!referenceImage;

  const getBackgroundImage = (gradient: string) => {
    if (!gradient) return "none";
    if (gradient.startsWith("url(") || gradient.startsWith("linear-gradient") || gradient.startsWith("radial-gradient")) return gradient;
    return `url(${gradient})`;
  };
  const [prompt, setPrompt] = useState("");

  useEffect(() => {
    if (externalPrompt) {
      setPrompt(externalPrompt);
      onClearExternalPrompt?.();
    }
  }, [externalPrompt, onClearExternalPrompt]);
  const [model, setModel] = useState<"seedream" | "nano-banana-2">("nano-banana-2");
  const [resolution, setResolution] = useState<"1k" | "2k" | "4k">("1k");
  const [aspectRatio, setAspectRatio] = useState("1:1");
  const [imageNumber, setImageNumber] = useState(1);
  const rpGate = useGenerateButton(userBalance, unlimited, creditsRequired * imageNumber);
  const [quickSetting, setQuickSetting] = useState<"fast" | "realistic" | "vivid" | "social" | null>("fast");

  const applyPreset = (preset: "fast" | "realistic" | "vivid" | "social") => {
    setQuickSetting(preset);
    if (preset === "fast") {
      setModel("nano-banana-2");
      setResolution("1k");
      setAspectRatio("1:1");
      setImageNumber(1);
    } else if (preset === "realistic") {
      setModel("nano-banana-2");
      setResolution("2k");
      setAspectRatio("1:1");
      setImageNumber(1);
    } else if (preset === "vivid") {
      setModel("seedream");
      setResolution("4k");
      setAspectRatio("1:1");
      setImageNumber(1);
    } else if (preset === "social") {
      setModel("nano-banana-2");
      setResolution("1k");
      setAspectRatio("9:16");
      setImageNumber(2);
    }
  };
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    reference: false,
    quickSettings: false,
    model: false,
    resolution: false,
    aspectRatio: false,
    imageNumber: false,
  });

  const toggle = (key: string) =>
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));

  return (
    <aside className="rpanel">
      <div className="rpanel-scroll">
        {/* Reference */}
        <div className="rpanel-card">
          <button type="button" className="rpanel-card-toggle" onClick={() => toggle("reference")}>
            {!openSections.reference && referenceImage ? (
              <span className="rpanel-ref-thumb" style={{ backgroundImage: getBackgroundImage(referenceImage.gradient) }} />
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></svg>
            )}
            <span className="rpanel-card-toggle-label">Reference</span>
            {!openSections.reference && referenceImage && (
              <button type="button" className="rpanel-ref-clear" onClick={(e) => { e.stopPropagation(); onClearReference?.(); }}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            )}
            <svg className={`rpanel-card-chevron ${openSections.reference ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          {openSections.reference && (
            <div className="rpanel-card-body">
              <div className="rpanel-list">
                <button type="button" className="rpanel-list-btn">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10" /></svg>
                  Product
                </button>
                <button type="button" className="rpanel-list-btn">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
                  Upload
                </button>
                <button type="button" className={`rpanel-list-btn ${hasSelectedImage ? "rpanel-list-btn--active" : ""}`}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></svg>
                  Use selected
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Prompt */}
        <div className="rpanel-card rpanel-card--prompt">
          <div className="rpanel-card-toggle" style={{ cursor: "default", marginBottom: 0 }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" /></svg>
            <span className="rpanel-card-toggle-label">Prompt</span>
          </div>
          <textarea
            className="rpanel-textarea"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Enter your prompt here..."
          />
        </div>

        {/* Quick Settings */}
        <div className="rpanel-card">
          <button type="button" className="rpanel-card-toggle" onClick={() => toggle("quickSettings")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C12 0 14.5 8.5 12 12C9.5 8.5 12 0 12 0ZM12 24C12 24 9.5 15.5 12 12C14.5 15.5 12 24 12 24ZM0 12C0 12 8.5 9.5 12 12C8.5 14.5 0 12 0 12ZM24 12C24 12 15.5 14.5 12 12C15.5 9.5 24 12 24 12Z" /></svg>
            <span className="rpanel-card-toggle-label">Quick Settings</span>
            <svg className={`rpanel-card-chevron ${openSections.quickSettings ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          {openSections.quickSettings && (
            <div className="rpanel-card-body">
              <div className="rpanel-list">
                <button type="button" className={`rpanel-list-btn ${quickSetting === "fast" ? "rpanel-list-btn--active" : ""}`} onClick={() => applyPreset("fast")}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10" /></svg>
                  Fast
                </button>
                <button type="button" className={`rpanel-list-btn ${quickSetting === "realistic" ? "rpanel-list-btn--active" : ""}`} onClick={() => applyPreset("realistic")}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
                  Realistic
                </button>
                <button type="button" className={`rpanel-list-btn ${quickSetting === "vivid" ? "rpanel-list-btn--active" : ""}`} onClick={() => applyPreset("vivid")}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M8 14s1.5 2 4 2 4-2 4-2" /><line x1="9" y1="9" x2="9.01" y2="9" /><line x1="15" y1="9" x2="15.01" y2="9" /></svg>
                  Vivid
                </button>
                <button type="button" className={`rpanel-list-btn ${quickSetting === "social" ? "rpanel-list-btn--active" : ""}`} onClick={() => applyPreset("social")}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z" /></svg>
                  Social
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Model */}
        <div className="rpanel-card">
          <button type="button" className="rpanel-card-toggle" onClick={() => toggle("model")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
            <span className="rpanel-card-toggle-label">Model</span>
            <svg className={`rpanel-card-chevron ${openSections.model ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          {openSections.model && (
            <div className="rpanel-card-body">
              <div className="rpanel-list">
                <button
                  type="button"
                  className={`rpanel-list-btn ${model === "nano-banana-2" ? "rpanel-list-btn--active" : ""}`}
                  onClick={() => setModel("nano-banana-2")}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" /><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" /><path d="M5.84 14.09A6.68 6.68 0 0 1 5.5 12c0-.72.12-1.43.34-2.09V7.07H2.18A11 11 0 0 0 1 12c0 1.78.43 3.46 1.18 4.93l3.66-2.84z" /><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" /></svg>
                  Nano Banana 2
                  <span className="rpanel-tag">Best</span>
                </button>
                <button
                  type="button"
                  className={`rpanel-list-btn ${model === "seedream" ? "rpanel-list-btn--active" : ""}`}
                  onClick={() => setModel("seedream")}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 16s1-4 5-4 5 4 9 4 5-4 5-4" /><path d="M2 12s1-4 5-4 5 4 9 4 5-4 5-4" /><path d="M18 8l2-2" /><circle cx="20" cy="6" r="0.5" fill="currentColor" /><path d="M6 16v2" /><path d="M10 16v1" /><path d="M14 16v2" /></svg>
                  Seedream
                  <span className="rpanel-tag">Affordable</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Resolution */}
        <div className="rpanel-card">
          <button type="button" className="rpanel-card-toggle" onClick={() => toggle("resolution")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4.5" y="4.5" width="15" height="15" rx="1" transform="rotate(45 12 12)" /></svg>
            <span className="rpanel-card-toggle-label">Resolution</span>
            <svg className={`rpanel-card-chevron ${openSections.resolution ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          {openSections.resolution && (
            <div className="rpanel-card-body">
              <div className="rpanel-list">
                <button type="button" className={`rpanel-list-btn ${resolution === "1k" ? "rpanel-list-btn--active" : ""}`} onClick={() => setResolution("1k")}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></svg>
                  1K (1080p)
                </button>
                <button type="button" className={`rpanel-list-btn ${resolution === "2k" ? "rpanel-list-btn--active" : ""}`} onClick={() => setResolution("2k")}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></svg>
                  2K
                </button>
                <button type="button" className={`rpanel-list-btn ${resolution === "4k" ? "rpanel-list-btn--active" : ""}`} onClick={() => setResolution("4k")}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></svg>
                  4K
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Aspect Ratio */}
        <div className="rpanel-card">
          <button type="button" className="rpanel-card-toggle" onClick={() => toggle("aspectRatio")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /></svg>
            <span className="rpanel-card-toggle-label">Aspect Ratio</span>
            <svg className={`rpanel-card-chevron ${openSections.aspectRatio ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          {openSections.aspectRatio && (
            <div className="rpanel-card-body">
              <div className="rpanel-list">
                <button type="button" className={`rpanel-list-btn ${aspectRatio === "1:1" ? "rpanel-list-btn--active" : ""}`} onClick={() => setAspectRatio("1:1")}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /></svg>
                  1:1
                </button>
                <button type="button" className={`rpanel-list-btn ${aspectRatio === "4:3" ? "rpanel-list-btn--active" : ""}`} onClick={() => setAspectRatio("4:3")}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2" /></svg>
                  4:3
                </button>
                <button type="button" className={`rpanel-list-btn ${aspectRatio === "3:4" ? "rpanel-list-btn--active" : ""}`} onClick={() => setAspectRatio("3:4")}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="2" width="16" height="20" rx="2" /></svg>
                  3:4
                </button>
                <button type="button" className={`rpanel-list-btn ${aspectRatio === "16:9" ? "rpanel-list-btn--active" : ""}`} onClick={() => setAspectRatio("16:9")}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="5" width="22" height="14" rx="2" /></svg>
                  16:9
                </button>
                <button type="button" className={`rpanel-list-btn ${aspectRatio === "9:16" ? "rpanel-list-btn--active" : ""}`} onClick={() => setAspectRatio("9:16")}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="1" width="14" height="22" rx="2" /></svg>
                  9:16
                </button>
                <button type="button" className={`rpanel-list-btn ${aspectRatio === "21:9" ? "rpanel-list-btn--active" : ""}`} onClick={() => setAspectRatio("21:9")}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="7" width="22" height="10" rx="2" /></svg>
                  21:9
                </button>
                <button type="button" className={`rpanel-list-btn ${aspectRatio === "3:2" ? "rpanel-list-btn--active" : ""}`} onClick={() => setAspectRatio("3:2")}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2" /></svg>
                  3:2
                </button>
                <button type="button" className={`rpanel-list-btn ${aspectRatio === "2:3" ? "rpanel-list-btn--active" : ""}`} onClick={() => setAspectRatio("2:3")}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="2" width="16" height="20" rx="2" /></svg>
                  2:3
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Image Number */}
        <div className="rpanel-card">
          <button type="button" className="rpanel-card-toggle" onClick={() => toggle("imageNumber")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="16" height="12" rx="2" /><path d="M22 8.5V17a2 2 0 0 1-2 2" /></svg>
            <span className="rpanel-card-toggle-label">Image Number</span>
            <svg className={`rpanel-card-chevron ${openSections.imageNumber ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          {openSections.imageNumber && (
            <div className="rpanel-card-body">
              <div className="rpanel-list">
                {[1, 2, 3, 4].map((n) => (
                  <button key={n} type="button" className={`rpanel-list-btn ${imageNumber === n ? "rpanel-list-btn--active" : ""}`} onClick={() => setImageNumber(n)}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="12" cy="12" r="3" /></svg>
                    {n} {n === 1 ? "Image" : "Images"}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Action footer */}
      <div className="rpanel-footer">
        <button type="button" className={rpGate.className("rpanel-action-btn rpanel-action-btn--tall")} onClick={() => {
          rpGate.handleClick(() => {
            onEditImage(aspectRatio, "image_to_image", imageNumber);
          });
        }}>
          {rpGate.state === "ready" ? (
            <>
              <GenerateButtonCost cost={creditsRequired * imageNumber} />
              <span style={{ flex: 1, textAlign: "center" }}>{rpGate.label("Generate Image")}</span>
            </>
          ) : <span style={{ flex: 1, textAlign: "center" }}>{rpGate.label("Generate Image")}</span>}
        </button>
      </div>
    </aside>
  );
}
