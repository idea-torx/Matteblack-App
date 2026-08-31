import { useState, useEffect, useCallback, useRef, useMemo, forwardRef, useImperativeHandle } from "react";
import "./RightPanel.css";
import type { ReferenceImage } from "../types/canvas";
import { useEstimateCost, type EstimateParams } from "../hooks/useEstimateCost";
import { useGenerateButton } from "../hooks/useGenerateButton";
import { GenerateButtonCost } from "./GenerateButtonCost";
import { SeedanceVerificationModal } from "./SeedanceVerificationModal";

export type GenerationParams = {
  model: string;
  prompt: string;
  resolution?: string;
  imageNumber?: number;
  referenceImageUrls?: string[];
  duration?: string;
  generateAudio?: boolean;
  firstFrameUrl?: string;
  lastFrameUrl?: string;
  aspectRatio?: string;
  jobType: string;
  upscaleFactor?: number;
  targetFps?: number;
  imageUrl?: string;
  videoUrl?: string;
  characterOrientation?: string;
  keepOriginalSound?: boolean;
  style?: string;
  imageSize?: string;
  colors?: Array<{ r: number; g: number; b: number }>;
  lyrics?: string;
  is_instrumental?: boolean;
  text?: string;
  voice?: string;
  speed?: number;
  stability?: string;
  similarityBoost?: string;
  emotion?: string;
  durationSeconds?: number;
  promptInfluence?: number;
  audioUrl?: string;
  refVideoDuration?: number;
  characters?: number;
  outputFormat?: string;
  quality?: string;
};

type MakePanelProps = {
  videoMode: boolean;
  onVideoModeChange: (v: boolean) => void;
  selectedImageIds: string[];
  canvasReferenceImages: ReferenceImage[];
  onGenerate: (params: GenerationParams) => void;
  creditsRequired?: number;
  userBalance?: number;
  unlimited?: boolean;
  referenceImage?: ReferenceImage | null;
  onClearReference?: () => void;
  externalPrompt?: string | null;
  onClearExternalPrompt?: () => void;
  onFrameChange?: (firstFrameId: string | null, lastFrameId: string | null) => void;
};

export function MakePanel({
  videoMode,
  onVideoModeChange,
  selectedImageIds,
  canvasReferenceImages,
  onGenerate,
  creditsRequired = 25,
  userBalance = 0,
  unlimited = false,
  referenceImage = null,
  onClearReference,
  externalPrompt,
  onClearExternalPrompt,
  onFrameChange,
}: MakePanelProps) {
  const [currentImageNumber, setCurrentImageNumber] = useState(1);
  const [pricingModel, setPricingModel] = useState<string | undefined>();
  const [pricingResolution, setPricingResolution] = useState<string | undefined>();
  const [pricingDuration, setPricingDuration] = useState<string | undefined>();
  const [pricingAudio, setPricingAudio] = useState(true);
  const [pricingType, setPricingType] = useState<string>(canvasReferenceImages.length > 0 ? "image_to_image" : "text_to_image");
  const [pricingFeatures, setPricingFeatures] = useState<string[]>([]);

  const estimateParams = useMemo(() => {
    if (videoMode) {
      return {
        type: "video_gen",
        model: pricingModel,
        duration: pricingDuration,
        resolution: pricingResolution,
        quantity: 1,
        features: pricingAudio ? ["generate_audio"] : undefined,
      };
    }
    return {
      type: pricingType,
      model: pricingModel,
      resolution: pricingResolution,
      quantity: currentImageNumber,
      features: pricingFeatures.length > 0 ? pricingFeatures : undefined,
    };
  }, [videoMode, pricingModel, pricingResolution, pricingDuration, currentImageNumber, pricingType, pricingAudio, pricingFeatures]);

  const { cost: estimatedCost } = useEstimateCost(estimateParams);
  const totalCost = estimatedCost !== null ? estimatedCost : (videoMode ? creditsRequired : creditsRequired * currentImageNumber);
  const gate = useGenerateButton(userBalance, unlimited, totalCost);

  return (
    <aside className="rpanel">
      <div className="rpanel-scroll">
        <div className="rpanel-mode-toggle" data-active={videoMode ? "1" : "0"}>
          <span className="rpanel-slide-pill" />
          <button
            type="button"
            className={`rpanel-mode-btn ${!videoMode ? "rpanel-mode-btn--active" : ""}`}
            onClick={() => onVideoModeChange(false)}
          >
            Image
          </button>
          <button
            type="button"
            className={`rpanel-mode-btn ${videoMode ? "rpanel-mode-btn--active" : ""}`}
            onClick={() => onVideoModeChange(true)}
          >
            Video
          </button>
        </div>

        <div className="rpanel-panel-fade" key={videoMode ? "video" : "image"}>
          {videoMode ? (
            <VideoCards
              selectedImageIds={selectedImageIds}
              referenceImage={referenceImage}
              canvasReferenceImages={canvasReferenceImages}
              onFrameChange={onFrameChange}
              onPricingChange={(model, duration, resolution) => { setPricingModel(model); setPricingDuration(duration); setPricingResolution(resolution); }}
              onAudioChange={setPricingAudio}
              onGenerate={(params) => {
                gate.handleClick(() => onGenerate(params));
              }}
              gate={gate}
              totalCost={totalCost}
              estimateParams={estimateParams}
            />
          ) : (
            <ImageCards
              canvasReferenceImages={canvasReferenceImages}
              onClearReference={onClearReference}
              externalPrompt={externalPrompt}
              onClearExternalPrompt={onClearExternalPrompt}
              onImageNumberChange={setCurrentImageNumber}
              onPricingChange={(model, resolution, type, features) => {
                setPricingModel(model);
                setPricingResolution(resolution);
                setPricingType(type);
                const nextFeatures = features || [];
                setPricingFeatures((prev) => {
                  if (prev.length === nextFeatures.length && prev.every((f, i) => f === nextFeatures[i])) return prev;
                  return nextFeatures;
                });
              }}
              onGenerate={(params) => {
                gate.handleClick(() => onGenerate(params));
              }}
              gate={gate}
              totalCost={totalCost}
              estimateParams={estimateParams}
            />
          )}
        </div>
      </div>

      <div className="rpanel-footer" style={{ padding: "0 0 10px", minHeight: 0 }} />
    </aside>
  );
}

const AR_PRESETS: Array<{ label: string; value: number }> = [
  { label: "1:1", value: 1 },
  { label: "4:3", value: 4 / 3 },
  { label: "3:4", value: 3 / 4 },
  { label: "16:9", value: 16 / 9 },
  { label: "9:16", value: 9 / 16 },
  { label: "21:9", value: 21 / 9 },
  { label: "9:21", value: 9 / 21 },
  { label: "3:2", value: 3 / 2 },
  { label: "2:3", value: 2 / 3 },
];
function snapAspectRatio(ratio: number): string {
  let best = AR_PRESETS[0];
  let minDiff = Math.abs(ratio - best.value);
  for (const p of AR_PRESETS) {
    const d = Math.abs(ratio - p.value);
    if (d < minDiff) { best = p; minDiff = d; }
  }
  return best.label;
}

const PromptEditor = forwardRef<HTMLDivElement, {
  prompt: string;
  onPromptChange: (v: string) => void;
  axiomTag: string | null;
  onDismissTag: () => void;
}>(function PromptEditor({ prompt, onPromptChange, axiomTag, onDismissTag }, forwardedRef) {
  const editorRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef(prompt);
  const onDismissRef = useRef(onDismissTag);
  const currentAxiomTagRef = useRef<string | null>(axiomTag);
  const pointerDownRef = useRef(false);
  promptRef.current = prompt;
  onDismissRef.current = onDismissTag;

  useImperativeHandle(forwardedRef, () => editorRef.current as HTMLDivElement, []);

  const getTextFromDom = useCallback(() => {
    const el = editorRef.current;
    if (!el) return "";
    let text = "";
    el.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        text += child.textContent || "";
      } else if (child instanceof HTMLElement && !child.dataset.axiomTag) {
        text += child.textContent || "";
      }
    });
    return text.replace(/^\u00A0/, "");
  }, []);

  const findTextNode = useCallback((): Text | null => {
    const el = editorRef.current;
    if (!el) return null;
    for (let i = el.childNodes.length - 1; i >= 0; i--) {
      const node = el.childNodes[i];
      if (node.nodeType === Node.TEXT_NODE) {
        const prev = node.previousSibling;
        if (prev instanceof HTMLElement && prev.dataset.axiomTag) {
          if ((node.textContent || "") === "\u00A0") continue;
        }
        return node as Text;
      }
    }
    return null;
  }, []);

  const buildAxiomTagEl = useCallback((tagLabel: string) => {
    const tag = document.createElement("span");
    tag.className = "rpanel-axiom-tag-inline";
    tag.contentEditable = "false";
    tag.dataset.axiomTag = "true";
    const tagText = document.createElement("span");
    tagText.className = "rpanel-axiom-tag-inline-text";
    tagText.textContent = tagLabel;
    const tagBtn = document.createElement("button");
    tagBtn.className = "rpanel-axiom-tag-inline-x";
    tagBtn.type = "button";
    tagBtn.textContent = "\u00d7";
    tagBtn.addEventListener("mousedown", (ev) => { ev.preventDefault(); ev.stopPropagation(); });
    tagBtn.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); onDismissRef.current(); });
    tag.appendChild(tagText);
    tag.appendChild(tagBtn);
    return tag;
  }, []);

  const rebuildDom = useCallback((textOverride?: string) => {
    const el = editorRef.current;
    if (!el) return;
    const sel = window.getSelection();
    const hasFocus = el === document.activeElement || el.contains(document.activeElement);

    el.innerHTML = "";

    if (axiomTag) {
      el.appendChild(buildAxiomTagEl(axiomTag));
      el.appendChild(document.createTextNode("\u00A0"));
    }

    const t = textOverride ?? promptRef.current;
    if (t) {
      el.appendChild(document.createTextNode(t));
    }

    currentAxiomTagRef.current = axiomTag;

    if (hasFocus && sel) {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }, [axiomTag, buildAxiomTagEl]);

  // Initial mount: build DOM once.
  useEffect(() => {
    rebuildDom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync axiom tag changes (add/remove/relabel) without nuking DOM during interaction.
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    if (currentAxiomTagRef.current === axiomTag) return;
    const hasFocus = el === document.activeElement || el.contains(document.activeElement);
    if (pointerDownRef.current || hasFocus) {
      // Defer: it's unsafe to wipe DOM right now. We'll catch up on blur or next idle change.
      return;
    }
    rebuildDom();
  }, [axiomTag, rebuildDom]);

  // Sync external prompt changes non-destructively.
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    const hasFocus = el === document.activeElement || el.contains(document.activeElement);
    if (hasFocus || pointerDownRef.current) return;
    if (currentAxiomTagRef.current !== axiomTag) {
      rebuildDom();
      return;
    }
    if (getTextFromDom() === prompt) return;
    const textNode = findTextNode();
    if (textNode) {
      if (prompt) {
        textNode.textContent = prompt;
      } else {
        textNode.parentNode?.removeChild(textNode);
      }
    } else if (prompt) {
      el.appendChild(document.createTextNode(prompt));
    }
  }, [prompt, axiomTag, rebuildDom, getTextFromDom, findTextNode]);

  const handleInput = useCallback(() => {
    const text = getTextFromDom();
    promptRef.current = text;
    onPromptChange(text);
  }, [onPromptChange, getTextFromDom]);

  const handlePointerDown = useCallback(() => {
    pointerDownRef.current = true;
  }, []);

  const handleBlur = useCallback(() => {
    // If a deferred rebuild is needed (axiom tag drifted while focused), do it now.
    if (currentAxiomTagRef.current !== axiomTag) {
      rebuildDom();
    }
  }, [axiomTag, rebuildDom]);

  useEffect(() => {
    const release = () => { pointerDownRef.current = false; };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Backspace" && editorRef.current) {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      if (!range.collapsed) return;
      const tagEl = editorRef.current.querySelector("[data-axiom-tag]");
      if (!tagEl) return;
      const container = range.startContainer;
      const offset = range.startOffset;
      const spacerNode = tagEl.nextSibling;
      const isAtSpacer = spacerNode && container === spacerNode && offset === 0;
      const isAtEditorStart = container === editorRef.current && offset <= 1;
      if (isAtSpacer || isAtEditorStart) {
        const textAfter = getTextFromDom();
        if (textAfter.trim().length === 0) {
          e.preventDefault();
          onDismissRef.current();
        } else {
          e.preventDefault();
        }
      }
    }
  }, [getTextFromDom]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    document.execCommand("insertText", false, text);
  }, []);

  return (
    <div
      ref={editorRef}
      className="rpanel-prompt-editable"
      contentEditable
      suppressContentEditableWarning
      onInput={handleInput}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      onPointerDown={handlePointerDown}
      onBlur={handleBlur}
      data-placeholder="Enter your prompt here..."
    />
  );
});

function ImageCards({
  canvasReferenceImages,
  onClearReference,
  externalPrompt,
  onClearExternalPrompt,
  onGenerate,
  onImageNumberChange,
  onPricingChange,
  gate,
  totalCost,
  estimateParams,
}: {
  canvasReferenceImages: ReferenceImage[];
  onClearReference?: () => void;
  externalPrompt?: string | null;
  onClearExternalPrompt?: () => void;
  onGenerate: (params: GenerationParams) => void;
  onImageNumberChange?: (n: number) => void;
  onPricingChange?: (model: string, resolution: string, type: string, features?: string[]) => void;
  gate: ReturnType<typeof useGenerateButton>;
  totalCost: number;
  estimateParams: EstimateParams;
}) {
  const [prompt, setPrompt] = useState("");
  const promptEditorRef = useRef<HTMLDivElement>(null);
  const [model, setModel] = useState<"nano-banana-2" | "seedream-5" | "seedream" | "gpt-image-2">("nano-banana-2");
  const [quality, setQuality] = useState<"low" | "medium" | "high">("high");
  const [resolution, setResolution] = useState<"1k" | "2k">("1k");
  const [imageNumber, setImageNumberRaw] = useState(1);
  const setImageNumber = (n: number) => {
    setImageNumberRaw(n);
    onImageNumberChange?.(n);
  };
  const [aspectRatio, setAspectRatio] = useState("1:1");
  const [axiomTagDismissed, setAxiomTagDismissed] = useState(false);

  const referenceImages = canvasReferenceImages.slice(0, 15);

  const axiomRef = referenceImages.find((r) => r.id.includes("-axiom-") || r.axiomName);
  const axiomTagText = axiomRef
    ? (axiomRef.axiomName || axiomRef.label || "product")
    : null;
  const axiomDescriptionText = axiomRef
    ? (axiomRef.axiomDescription || axiomRef.axiomName || axiomRef.label || "product")
    : null;
  const showAxiomTag = !!axiomTagText && !axiomTagDismissed && referenceImages.length > 0;

  useEffect(() => {
    setAxiomTagDismissed(false);
  }, [canvasReferenceImages]);

  const getBackgroundImage = (gradient: string) => {
    if (!gradient) return "none";
    if (gradient.startsWith("url(") || gradient.startsWith("linear-gradient") || gradient.startsWith("radial-gradient")) return gradient;
    return `url(${gradient})`;
  };

  useEffect(() => {
    if (externalPrompt) {
      setPrompt(externalPrompt);
      onClearExternalPrompt?.();
    }
  }, [externalPrompt, onClearExternalPrompt]);

  const prevRefCountRef = useRef(0);
  useEffect(() => {
    if (referenceImages.length > 0 && prevRefCountRef.current === 0) {
      const firstAr = referenceImages[0].aspectRatio;
      if (firstAr) setAspectRatio(firstAr);
    }
    prevRefCountRef.current = referenceImages.length;
  }, [referenceImages]);

  const isTextToImage = referenceImages.length === 0;
  const effectiveJobType = isTextToImage ? "text_to_image" : "image_to_image";
  const effectiveModel = model === "nano-banana-2"
    ? (isTextToImage ? "nano-banana-2-t2i" : "nano-banana-2")
    : model === "seedream-5"
      ? (isTextToImage ? "seedream-5-t2i" : "seedream-5-edit")
    : model === "seedream"
      ? (isTextToImage ? "seedream-t2i" : "seedream-edit")
      : model === "gpt-image-2"
        ? (isTextToImage ? "gpt-image-2-t2i" : "gpt-image-2-edit")
        : model;

  const qualityFeatures = model === "gpt-image-2" && quality !== "high"
    ? [`quality_${quality}`]
    : [];

  const effectivePricingResolution = model === "gpt-image-2"
    ? (resolution === "2k" && aspectRatio !== "1:1" ? "2k" : "1k")
    : resolution;

  useEffect(() => {
    onPricingChange?.(effectiveModel, effectivePricingResolution, effectiveJobType, qualityFeatures.length > 0 ? qualityFeatures : undefined);
  }, [effectiveModel, effectivePricingResolution, effectiveJobType, onPricingChange, quality, model]);

  const handleGenerate = useCallback(() => {
    let finalPrompt = prompt;
    if (showAxiomTag && axiomDescriptionText) {
      const prefix = axiomDescriptionText;
      finalPrompt = finalPrompt.trim()
        ? `${prefix}, ${finalPrompt.trim()}`
        : prefix;
    }
    onGenerate({
      model: effectiveModel,
      prompt: finalPrompt,
      resolution: effectivePricingResolution,
      imageNumber,
      aspectRatio,
      jobType: effectiveJobType,
      referenceImageUrls: isTextToImage ? [] : referenceImages.map((r) => {
        const g = r.gradient || "";
        const m = g.match(/^url\(["']?(.*?)["']?\)$/);
        return m ? m[1] : g;
      }),
      quality: model === "gpt-image-2" ? quality : undefined,
    });
  }, [effectiveModel, prompt, effectivePricingResolution, imageNumber, aspectRatio, referenceImages, onGenerate, effectiveJobType, isTextToImage, showAxiomTag, axiomDescriptionText, model, quality]);

  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    model: false,
    quality: false,
    resolution: false,
    aspectRatio: false,
    imageNumber: false,
  });
  const toggle = (key: string) => setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));

  return (
    <>
      {isTextToImage ? (
        <div className="rpanel-flat-section">
          <span className="rpanel-flat-label">Text to Image</span>
        </div>
      ) : (() => {
        const isAxiomStack = referenceImages.length > 1 && referenceImages.every((r) => r.id.includes("-axiom-"));
        return (
          <div className="rpanel-card">
            <h3 className="rpanel-card-title" style={{ marginBottom: 8 }}>
              {isAxiomStack ? "Product" : "Reference Images"}
              {isAxiomStack && <span className="rpanel-tag" style={{ marginLeft: 8, fontSize: 9 }}>{referenceImages.length} images</span>}
              {!isAxiomStack && model === "nano-banana-2" && <span className="rpanel-tag" style={{ marginLeft: 8, fontSize: 9 }}>Multi</span>}
            </h3>
            {isAxiomStack ? (
              <div className="rpanel-ref-axiom-stack">
                {referenceImages.slice(0, 4).map((ref, i) => (
                  <div
                    key={ref.id}
                    className="rpanel-ref-axiom-stack-card"
                    style={{
                      backgroundImage: getBackgroundImage(ref.gradient),
                      zIndex: 4 - i,
                      transform: `rotate(${(i - 1.5) * 4}deg) translateY(${i * 2}px)`,
                    }}
                  />
                ))}
                <span className="rpanel-ref-axiom-stack-label">{referenceImages[0]?.label || "Product"}</span>
              </div>
            ) : (
              <div className="rpanel-ref-grid">
                {referenceImages.map((ref) => (
                  <div key={ref.id} className="rpanel-ref-large-thumb">
                    <div
                      className="rpanel-ref-large-thumb-img"
                      style={{ backgroundImage: getBackgroundImage(ref.gradient) }}
                    />
                  </div>
                ))}
              </div>
            )}
            <button
              type="button"
              className="rpanel-ref-clear-all"
              onClick={() => onClearReference?.()}
            >
              Clear all
            </button>
          </div>
        );
      })()}

      <div
        className="rpanel-card rpanel-card--prompt"
        onMouseDown={(e) => {
          if (e.target !== e.currentTarget) return;
          const editor = promptEditorRef.current;
          if (!editor) return;
          e.preventDefault();
          editor.focus();
          const sel = window.getSelection();
          if (sel) {
            const range = document.createRange();
            range.selectNodeContents(editor);
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
          }
        }}
      >
        <span className="rpanel-flat-label" style={{ marginBottom: 2 }}>Prompt</span>
        <PromptEditor
          ref={promptEditorRef}
          prompt={prompt}
          onPromptChange={setPrompt}
          axiomTag={showAxiomTag ? axiomTagText : null}
          onDismissTag={() => setAxiomTagDismissed(true)}
        />
      </div>

      <button type="button" className="rpanel-model-selector" onClick={() => toggle("model")}>
        <span className="rpanel-model-selector-icon">
          {model === "gpt-image-2" ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /></svg>
          ) : model === "nano-banana-2" ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" /><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" /><path d="M5.84 14.09A6.68 6.68 0 0 1 5.5 12c0-.72.12-1.43.34-2.09V7.07H2.18A11 11 0 0 0 1 12c0 1.78.43 3.46 1.18 4.93l3.66-2.84z" /><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" /></svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 16s1-4 5-4 5 4 9 4 5-4 5-4" /><path d="M2 12s1-4 5-4 5 4 9 4 5-4 5-4" /></svg>
          )}
        </span>
        <span className="rpanel-model-selector-info">
          <span className="rpanel-model-selector-name">
            {model === "gpt-image-2" ? "GPT Image 2" : model === "nano-banana-2" ? "Nano Banana 2" : model === "seedream-5" ? "Seedream 5" : "Seedream"}
          </span>
          <span className="rpanel-model-selector-provider">
            {model === "gpt-image-2" ? "OpenAI · text + image" : model === "nano-banana-2" ? "Google · quality" : model === "seedream-5" ? "ByteDance · newest" : "ByteDance · quick"}
          </span>
        </span>
        <svg className={`rpanel-card-chevron ${openSections.model ? "rpanel-card-chevron--open" : ""}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      {openSections.model && (
        <div className="rpanel-card" style={{ marginTop: -2 }}>
          <div className="rpanel-list">
            <button type="button" className={`rpanel-list-btn ${model === "gpt-image-2" ? "rpanel-list-btn--active" : ""}`} onClick={() => { setModel("gpt-image-2"); toggle("model"); }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /></svg>
              GPT Image 2
              <span className="rpanel-tag">Premium</span>
            </button>
            <button type="button" className={`rpanel-list-btn ${model === "nano-banana-2" ? "rpanel-list-btn--active" : ""}`} onClick={() => { setModel("nano-banana-2"); toggle("model"); }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" /><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" /><path d="M5.84 14.09A6.68 6.68 0 0 1 5.5 12c0-.72.12-1.43.34-2.09V7.07H2.18A11 11 0 0 0 1 12c0 1.78.43 3.46 1.18 4.93l3.66-2.84z" /><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" /></svg>
              Nano Banana 2
              <span className="rpanel-tag">Quality</span>
            </button>
            <button type="button" className={`rpanel-list-btn ${model === "seedream-5" ? "rpanel-list-btn--active" : ""}`} onClick={() => { setModel("seedream-5"); toggle("model"); }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 16s1-4 5-4 5 4 9 4 5-4 5-4" /><path d="M2 12s1-4 5-4 5 4 9 4 5-4 5-4" /></svg>
              Seedream 5
              <span className="rpanel-tag">Quick</span>
            </button>
            <button type="button" className={`rpanel-list-btn ${model === "seedream" ? "rpanel-list-btn--active" : ""}`} onClick={() => { setModel("seedream"); toggle("model"); }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 16s1-4 5-4 5 4 9 4 5-4 5-4" /><path d="M2 12s1-4 5-4 5 4 9 4 5-4 5-4" /></svg>
              Seedream
              <span className="rpanel-tag">Quick</span>
            </button>
          </div>
        </div>
      )}

      <div className="rpanel-flat-section">
        <span className="rpanel-flat-label">Aspect ratio</span>
        <div className="rpanel-ar-grid">
          {[
            { value: "1:1", w: 18, h: 18 },
            { value: "9:16", w: 12, h: 20 },
            { value: "16:9", w: 22, h: 12 },
          ].map(({ value: ar, w, h }) => (
            <button key={ar} type="button" className={`rpanel-ar-card ${aspectRatio === ar ? "rpanel-ar-card--active" : ""}`} onClick={() => setAspectRatio(ar)}>
              <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h}><rect width={w} height={h} rx="2" fill={aspectRatio === ar ? "var(--accent)" : "currentColor"} opacity={aspectRatio === ar ? 0.7 : 0.18} /></svg>
              <span className="rpanel-ar-text">{ar}</span>
            </button>
          ))}
          <button type="button" className={`rpanel-ar-card rpanel-ar-card--more`} onClick={() => toggle("aspectRatio")}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.35"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
            <span className="rpanel-ar-text">More</span>
          </button>
        </div>
        {openSections.aspectRatio && (
          <div className="rpanel-chip-grid" style={{ marginTop: 4 }}>
            {["1:1", "4:3", "3:4", "16:9", "9:16", "21:9", "3:2", "2:3"].map((ar) => (
              <button key={ar} type="button" className={`rpanel-chip ${aspectRatio === ar ? "rpanel-chip--active" : ""}`} onClick={() => setAspectRatio(ar)}>
                {ar}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="rpanel-dual-row">
        {model === "gpt-image-2" && (
          <div className="rpanel-dual-col">
            <span className="rpanel-flat-label">Quality</span>
            <div className="rpanel-seg-group" data-count="3" data-active={["low", "medium", "high"].indexOf(quality)}>
              <span className="rpanel-slide-pill" />
              {(["low", "medium", "high"] as const).map((q) => (
                <button key={q} type="button" className={`rpanel-seg-btn ${quality === q ? "rpanel-seg-btn--active" : ""}`} onClick={() => setQuality(q)}>
                  {q === "medium" ? "Med" : q.charAt(0).toUpperCase() + q.slice(1)}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="rpanel-dual-col">
          <span className="rpanel-flat-label">Resolution</span>
          <div className="rpanel-seg-group" data-count="2" data-active={["1k", "2k"].indexOf(resolution)}>
            <span className="rpanel-slide-pill" />
            {(["1k", "2k"] as const).map((r) => (
              <button key={r} type="button" className={`rpanel-seg-btn ${resolution === r ? "rpanel-seg-btn--active" : ""}`} onClick={() => setResolution(r)}>
                {r.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="rpanel-flat-section">
        <span className="rpanel-flat-label">Images per run</span>
        <div className="rpanel-seg-group rpanel-seg-group--full" data-count="4" data-active={imageNumber - 1}>
          <span className="rpanel-slide-pill" />
          {[1, 2, 3, 4].map((n) => (
            <button key={n} type="button" className={`rpanel-seg-btn ${imageNumber === n ? "rpanel-seg-btn--active" : ""}`} onClick={() => setImageNumber(n)}>
              {n}
            </button>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 8 }}>
        <button
          type="button"
          className={gate.className("rpanel-action-btn rpanel-action-btn--tall")}
          data-generate-btn
          onClick={handleGenerate}
        >
          <GenerateButtonCost cost={totalCost} params={estimateParams} visible={gate.state === "ready"} />
          <span style={{ flex: 1, textAlign: "center" }}>{gate.label("Generate Image")}</span>
        </button>
      </div>
    </>
  );
}

function VideoCards({
  selectedImageIds,
  referenceImage,
  canvasReferenceImages,
  onFrameChange,
  onGenerate,
  onPricingChange,
  onAudioChange,
  gate,
  totalCost,
  estimateParams,
}: {
  selectedImageIds: string[];
  referenceImage?: ReferenceImage | null;
  canvasReferenceImages: ReferenceImage[];
  onFrameChange?: (firstFrameId: string | null, lastFrameId: string | null) => void;
  onGenerate: (params: GenerationParams) => void;
  onPricingChange?: (model: string, duration: string, resolution?: string) => void;
  onAudioChange?: (audio: boolean) => void;
  gate: ReturnType<typeof useGenerateButton>;
  totalCost: number;
  estimateParams: EstimateParams;
}) {
  type VideoMode = "text-to-video" | "image-to-video" | "reference-to-video";
  const [videoMode, setVideoMode] = useState<VideoMode>("text-to-video");
  const [prompt, setPrompt] = useState("");
  const [videoModel, setVideoModel] = useState<"kling-o3-pro" | "kling-o3-4k" | "veo3.1-lite" | "seedance-2.5" | "seedance-2.0" | "gemini-omni" | "h3-max">("kling-o3-pro");
  const [duration, setDuration] = useState<string>("5");
  const [generateAudio, setGenerateAudio] = useState(true);
  const [aspectRatio, setAspectRatio] = useState<"16:9" | "9:16" | "1:1">("16:9");
  const [videoResolution, setVideoResolution] = useState<"360p" | "480p" | "720p" | "768p" | "1080p" | "4k">("1080p");

  const GEMINI_OMNI_DURATIONS = ["3", "4", "6", "8", "10"];
  const SEEDANCE_25_DURATIONS = ["4", "6", "8", "10", "15", "20", "25", "30"];
  const SEEDANCE_DURATIONS = ["4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"];
  const KLING_O3_DURATIONS = ["3", "5", "7", "9", "11", "13", "15"];
  const H3_DURATIONS = ["5", "7", "9", "11", "13", "15"];

  // Seedance gate removed (2026-05); state retained as a write-only flag in
  // case the modal flow needs to come back. The setter is still used by
  // handleSelectSeedance + handleSeedanceVerified.
  const [, setSeedanceVerified] = useState<boolean | null>(null);
  const [showSeedanceModal, setShowSeedanceModal] = useState(false);

  const videoModelLabels: Record<string, string> = {
    "kling-o3-pro": "Kling O3 Pro",
    "kling-o3-4k": "Kling O3 4K",
    "veo3.1-lite": "Veo 3.1 Lite",
    "gemini-omni": "Gemini Omni Flash 1.1",
    "seedance-2.5": "Seedance 2.5",
    "seedance-2.0": "Seedance 2.0",
    "h3-max": "MiniMax H3 Max",
  };
  const [firstFrame, setFirstFrame] = useState<{ id: string; url: string; name: string; aspectRatio?: string } | null>(null);
  const [lastFrame, setLastFrame] = useState<{ id: string; url: string; name: string; aspectRatio?: string } | null>(null);
  const [referenceVideo, setReferenceVideo] = useState<{ id: string; url: string; name: string } | null>(null);
  const [referenceAudio, setReferenceAudio] = useState<{ name: string; dataUrl: string } | null>(null);
  const [r2vImages, setR2vImages] = useState<Array<{ id: string; url: string; name: string }>>([]);
  const audioInputRef = useRef<HTMLInputElement>(null);

  const isImageRef = referenceImage && referenceImage.nodeType === "image";
  const isVideoRef = referenceImage && referenceImage.nodeType === "video";
  const hasCanvasSelection = selectedImageIds.length > 0 && !!referenceImage && !!isImageRef;
  const hasVideoSelection = selectedImageIds.length > 0 && !!referenceImage && !!isVideoRef;

  const imageRefs = useMemo(() => canvasReferenceImages.filter((r) => r.nodeType === "image"), [canvasReferenceImages]);

  useEffect(() => {
    if (videoModel === "veo3.1-lite") {
      setDuration((d) => (["4", "6", "8"].includes(d) ? d : "6"));
    } else if (videoModel === "gemini-omni") {
      setDuration((d) => (GEMINI_OMNI_DURATIONS.includes(d) ? d : "8"));
      setVideoResolution((r) => (["360p", "720p", "1080p", "4k"].includes(r) ? r : "720p"));
      if (videoMode === "reference-to-video") setVideoMode("text-to-video");
    } else if (videoModel === "seedance-2.5") {
      setDuration((d) => (SEEDANCE_25_DURATIONS.includes(d) ? d : "10"));
      setVideoResolution((r) => (r === "768p" ? "1080p" : r));
    } else if (videoModel === "seedance-2.0") {
      setDuration((d) => (SEEDANCE_DURATIONS.includes(d) ? d : "5"));
      setVideoResolution((r) => (r === "768p" ? "1080p" : r));
    } else if (videoModel === "h3-max") {
      // fal ships H3 Max as a text-to-video endpoint only, and its resolution
      // tiers are 480P/768P rather than the shared 480/720/1080 ladder.
      setDuration((d) => (H3_DURATIONS.includes(d) ? d : "5"));
      setVideoResolution((r) => (r === "480p" ? r : "768p"));
      setVideoMode("text-to-video");
    } else {
      // kling-o3-pro / kling-o3-4k: every integer 3–15 seconds, default 5.
      setDuration((d) => (KLING_O3_DURATIONS.includes(d) ? d : "5"));
    }
  }, [videoModel]);

  useEffect(() => {
    if (videoModel === "h3-max") return; // text-to-video only
    const count = imageRefs.length;
    if (count === 0) {
      if (videoMode === "image-to-video") setVideoMode("text-to-video");
      setFirstFrame(null);
      setLastFrame(null);
    } else if (count >= 2) {
      setVideoMode("image-to-video");
      const ref0 = imageRefs[0];
      const rawUrl0 = extractRawUrl(ref0.gradient);
      if (isValidImageUrl(rawUrl0)) {
        setFirstFrame({ id: ref0.id, url: rawUrl0, name: ref0.label, aspectRatio: ref0.aspectRatio });
      } else {
        setFirstFrame(null);
      }
      const ref1 = imageRefs[1];
      const rawUrl1 = extractRawUrl(ref1.gradient);
      if (isValidImageUrl(rawUrl1)) {
        setLastFrame({ id: ref1.id, url: rawUrl1, name: ref1.label, aspectRatio: ref1.aspectRatio });
      } else {
        setLastFrame(null);
      }
    } else {
      const ref = imageRefs[0];
      const rawUrl = extractRawUrl(ref.gradient);
      if (!isValidImageUrl(rawUrl)) {
        if (videoMode === "image-to-video") setVideoMode("text-to-video");
        setFirstFrame(null);
        setLastFrame(null);
        return;
      }
      if (videoMode === "image-to-video" && firstFrame && ref.id !== firstFrame.id) {
        setLastFrame({ id: ref.id, url: rawUrl, name: ref.label, aspectRatio: ref.aspectRatio });
      } else {
        setVideoMode("image-to-video");
        setFirstFrame({ id: ref.id, url: rawUrl, name: ref.label, aspectRatio: ref.aspectRatio });
        setLastFrame(null);
      }
    }
  }, [imageRefs, videoModel]);

  useEffect(() => {
    if (videoMode !== "reference-to-video") return;
    const supportsR2v = videoModel.startsWith("seedance-") || videoModel.startsWith("kling-o3-");
    if (!supportsR2v) return;
    if (imageRefs.length === 0) return;
    // Seedance 2.5 accepts up to 30 reference images, 2.0 up to 3; Kling O3 (Pro / 4K) up to 4.
    const refCap = videoModel.startsWith("kling-o3-") ? 4 : videoModel === "seedance-2.5" ? 30 : 3;
    const newImages: Array<{ id: string; url: string; name: string }> = [];
    for (const ref of imageRefs.slice(0, refCap)) {
      const rawUrl = extractRawUrl(ref.gradient);
      if (isValidImageUrl(rawUrl) && !r2vImages.some((r) => r.id === ref.id)) {
        newImages.push({ id: ref.id, url: rawUrl, name: ref.label });
      }
    }
    if (newImages.length > 0) {
      setR2vImages((prev) => [...prev, ...newImages].slice(0, refCap));
    }
  }, [imageRefs, videoMode, videoModel]);

  useEffect(() => {
    onFrameChange?.(firstFrame?.id ?? null, lastFrame?.id ?? null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstFrame?.id, lastFrame?.id]);

  // Probe the actual image dimensions for first/last frame so the placeholder
  // and any AR-sensitive request payload reflects the true source ratio,
  // independent of however the canvas node was sized or snapped. We compare
  // against the captured source URL (not img.src, which gets absolutized) so
  // relative URLs still match. We do not set crossOrigin — we only need pixel
  // dimensions, not pixel data, so non-CORS images load fine.
  useEffect(() => {
    const url = firstFrame?.url;
    if (!url) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      const w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) return;
      const ar = snapAspectRatio(w / h);
      setFirstFrame((prev) => (prev && prev.url === url && prev.aspectRatio !== ar ? { ...prev, aspectRatio: ar } : prev));
    };
    img.onerror = () => { if (!cancelled) console.warn("[MakePanel] firstFrame AR probe failed for", url); };
    img.src = url;
    return () => { cancelled = true; };
  }, [firstFrame?.url]);

  useEffect(() => {
    const url = lastFrame?.url;
    if (!url) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      const w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) return;
      const ar = snapAspectRatio(w / h);
      setLastFrame((prev) => (prev && prev.url === url && prev.aspectRatio !== ar ? { ...prev, aspectRatio: ar } : prev));
    };
    img.onerror = () => { if (!cancelled) console.warn("[MakePanel] lastFrame AR probe failed for", url); };
    img.src = url;
    return () => { cancelled = true; };
  }, [lastFrame?.url]);

  useEffect(() => {
    let modelKey: string;
    if (videoMode === "text-to-video") {
      modelKey = `${videoModel}-t2v`;
    } else if (videoMode === "reference-to-video") {
      modelKey = `${videoModel}-r2v`;
    } else if (videoMode === "image-to-video" && videoModel === "veo3.1-lite" && firstFrame && lastFrame) {
      modelKey = `${videoModel}-flf2v`;
    } else {
      modelKey = `${videoModel}-i2v`;
    }
    onPricingChange?.(modelKey, duration, (videoModel.startsWith("seedance-") || videoModel === "h3-max" || videoModel === "gemini-omni") ? videoResolution : undefined);
  }, [videoModel, duration, videoMode, firstFrame, lastFrame, videoResolution, onPricingChange]);

  useEffect(() => {
    onAudioChange?.(generateAudio);
  }, [generateAudio, onAudioChange]);

  const getBackgroundImage = (gradient: string) => {
    if (!gradient) return "none";
    if (gradient.startsWith("url(") || gradient.startsWith("linear-gradient") || gradient.startsWith("radial-gradient")) return gradient;
    return `url(${gradient})`;
  };

  const extractRawUrl = (gradient: string): string => {
    if (!gradient) return "";
    const m = gradient.match(/^url\(["']?(.*?)["']?\)$/);
    return m ? m[1] : gradient;
  };

  const isValidImageUrl = (url: string): boolean => {
    if (!url) return false;
    if (url.startsWith("linear-gradient") || url.startsWith("radial-gradient")) return false;
    return url.startsWith("http://") || url.startsWith("https://") || url.startsWith("/") || url.startsWith("data:image");
  };

  const handleUseSelectedForFirst = useCallback(() => {
    if (referenceImage) {
      const url = extractRawUrl(referenceImage.gradient);
      if (isValidImageUrl(url)) {
        setFirstFrame({ id: referenceImage.id, url, name: referenceImage.label, aspectRatio: referenceImage.aspectRatio });
      }
    }
  }, [referenceImage]);

  const handleUseSelectedForLast = useCallback(() => {
    if (referenceImage) {
      const url = extractRawUrl(referenceImage.gradient);
      if (isValidImageUrl(url)) {
        setLastFrame({ id: referenceImage.id, url, name: referenceImage.label, aspectRatio: referenceImage.aspectRatio });
      }
    }
  }, [referenceImage]);

  const isGenerateDisabled =
    (videoMode === "image-to-video" && !firstFrame) ||
    (videoMode === "reference-to-video" && videoModel.startsWith("kling-o3-") && r2vImages.length === 0) ||
    (videoMode === "reference-to-video" && videoModel.startsWith("seedance-") && !referenceVideo && r2vImages.length === 0);

  const handleGenerate = useCallback(() => {
    let modelKey: string;
    if (videoMode === "text-to-video") {
      modelKey = `${videoModel}-t2v`;
    } else if (videoMode === "reference-to-video") {
      modelKey = `${videoModel}-r2v`;
    } else if (videoMode === "image-to-video" && videoModel === "veo3.1-lite" && firstFrame && lastFrame) {
      modelKey = `${videoModel}-flf2v`;
    } else {
      modelKey = `${videoModel}-i2v`;
    }
    onGenerate({
      model: modelKey,
      prompt,
      duration,
      generateAudio,
      aspectRatio: videoMode === "text-to-video"
        ? aspectRatio
        : videoMode === "image-to-video"
          ? (firstFrame?.aspectRatio || lastFrame?.aspectRatio)
          : undefined,
      resolution: (videoModel.startsWith("seedance-") || videoModel === "h3-max" || videoModel === "gemini-omni") ? videoResolution : undefined,
      jobType: "video_gen",
      firstFrameUrl: videoMode === "image-to-video" ? firstFrame?.url : undefined,
      lastFrameUrl: videoMode === "image-to-video" ? lastFrame?.url : undefined,
      videoUrl: videoMode === "reference-to-video" ? referenceVideo?.url : undefined,
      audioUrl: videoMode === "reference-to-video" && referenceAudio ? referenceAudio.dataUrl : undefined,
      referenceImageUrls: videoMode === "reference-to-video" && r2vImages.length > 0 ? r2vImages.map((r) => r.url) : undefined,
    });
  }, [videoMode, videoModel, prompt, duration, generateAudio, aspectRatio, videoResolution, firstFrame, lastFrame, referenceVideo, referenceAudio, r2vImages, onGenerate]);

  const handleAudioUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      setReferenceAudio({ name: file.name, dataUrl: reader.result as string });
    };
    reader.readAsDataURL(file);
    if (audioInputRef.current) audioInputRef.current.value = "";
  }, []);

  const handleSelectSeedance = useCallback(() => {
    // Seedance 2.0 region/business-verification gate removed (2026-05) —
    // no longer region-restricted by the provider. Selecting Seedance now
    // just sets the model. The verification modal + endpoints stay in
    // place in case the gate needs to come back.
    setSeedanceVerified(true);
    setVideoModel("seedance-2.0");
  }, []);

  const handleSeedanceVerified = useCallback(() => {
    setSeedanceVerified(true);
    setShowSeedanceModal(false);
    setVideoModel("seedance-2.0");
  }, []);

  const [moreRefsOpen, setMoreRefsOpen] = useState(false);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    mode: false,
    model: false,
    duration: false,
    audio: false,
    aspectRatio: false,
    resolution: false,
  });
  const toggle = (key: string) => setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));

  const videoModeOptions = (() => {
    const base: VideoMode[] = ["text-to-video", "image-to-video"];
    if (videoModel === "h3-max") return ["text-to-video"] as VideoMode[];
    if (videoModel.startsWith("seedance-") || videoModel.startsWith("kling-o3-")) base.push("reference-to-video");
    return base;
  })();
  const videoModeIndex = videoModeOptions.indexOf(videoMode);

  const durationOptions = (() => {
    if (videoModel === "veo3.1-lite") return ["4", "6", "8"];
    if (videoModel === "gemini-omni") return GEMINI_OMNI_DURATIONS;
    if (videoModel === "seedance-2.5") return SEEDANCE_25_DURATIONS;
    if (videoModel === "seedance-2.0") return ["4", "6", "8", "10", "12", "15"];
    if (videoModel === "h3-max") return H3_DURATIONS;
    // kling-o3-pro / kling-o3-4k: fal accepts every integer "3".."15", but
    // we surface 2-second steps in the panel to keep the segmented control
    // readable. The agent still passes through any integer 3-15.
    return KLING_O3_DURATIONS;
  })();
  const durationIndex = durationOptions.indexOf(duration);

  const videoResOptions = videoModel === "h3-max"
    ? (["480p", "768p"] as const)
    : videoModel === "gemini-omni"
      ? (["360p", "720p", "1080p", "4k"] as const)
      : (["480p", "720p", "1080p"] as const);
  const videoResIndex = (videoResOptions as readonly string[]).indexOf(videoResolution);

  const videoModelIcon = (m: string) => {
    if (m.startsWith("kling-o3-")) return <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: -0.5 }}>{m === "kling-o3-4k" ? "4K" : "K"}</span>;
    if (m === "gemini-omni") return <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c.4 5.2 4.4 9.2 9.6 9.6v.8C16.4 12.8 12.4 16.8 12 22h-.8C10.8 16.8 6.8 12.8 1.6 12.4v-.8C6.8 11.2 10.8 7.2 11.2 2h.8z" /></svg>;
    if (m === "h3-max") return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3" /></svg>;
    if (m === "veo3.1-lite") return <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" /><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" /><path d="M5.84 14.09A6.68 6.68 0 0 1 5.5 12c0-.72.12-1.43.34-2.09V7.07H2.18A11 11 0 0 0 1 12c0 1.78.43 3.46 1.18 4.93l3.66-2.84z" /><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" /></svg>;
    return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12 Q5 6 8 12 Q11 18 14 12 Q17 6 20 12 Q21 14 22 12"/></svg>;
  };

  const videoModelProvider = (m: string) => {
    if (m === "kling-o3-pro") return "Kling · quality";
    if (m === "kling-o3-4k") return "Kling · premium+";
    if (m === "veo3.1-lite") return "Google · quick";
    if (m === "h3-max") return "MiniMax · fast";
    return "ByteDance · premium";
  };

  return (
    <>
      <div className="rpanel-flat-section">
        <span className="rpanel-flat-label">Mode</span>
        <div className="rpanel-seg-group rpanel-seg-group--full" data-count={videoModeOptions.length} data-active={videoModeIndex >= 0 ? videoModeIndex : 0}>
          <span className="rpanel-slide-pill" />
          {videoModeOptions.map((m) => (
            <button key={m} type="button" className={`rpanel-seg-btn ${videoMode === m ? "rpanel-seg-btn--active" : ""}`} onClick={() => setVideoMode(m)}>
              {m === "text-to-video" ? "Text" : m === "image-to-video" ? "Image" : "Reference"}
            </button>
          ))}
        </div>
      </div>

      {videoMode === "image-to-video" && (
        <div className="rpanel-card rpanel-frame-section">
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <h3 className="rpanel-card-title" style={{ margin: 0 }}>First Frame</h3>
            <span className="rpanel-tag" style={{ opacity: 0.5 }}>Required</span>
          </div>
          {firstFrame ? (
            <div className="rpanel-frame-preview">
              <div className="rpanel-frame-preview-img" style={{ backgroundImage: getBackgroundImage(firstFrame.url) }} />
              <div className="rpanel-frame-preview-info">
                <span className="rpanel-frame-preview-name">{firstFrame.name}</span>
                <button
                  type="button"
                  className="rpanel-frame-preview-clear"
                  onClick={() => setFirstFrame(null)}
                >
                  Remove
                </button>
              </div>
            </div>
          ) : (
            <div className="rpanel-frame-empty">
              <div className="rpanel-frame-btn-row">
                <button
                  type="button"
                  className={`rpanel-frame-use-selected-btn ${!hasCanvasSelection ? "rpanel-frame-use-selected-btn--disabled" : ""}`}
                  disabled={!hasCanvasSelection}
                  onClick={handleUseSelectedForFirst}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 12l2 2 4-4" /></svg>
                  Use selected
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {videoMode === "image-to-video" && (
        <div className="rpanel-card rpanel-frame-section">
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <h3 className="rpanel-card-title" style={{ margin: 0 }}>Last Frame</h3>
            <span className="rpanel-tag" style={{ opacity: 0.5 }}>Optional</span>
          </div>
          {lastFrame ? (
            <div className="rpanel-frame-preview">
              <div className="rpanel-frame-preview-img" style={{ backgroundImage: getBackgroundImage(lastFrame.url) }} />
              <div className="rpanel-frame-preview-info">
                <span className="rpanel-frame-preview-name">{lastFrame.name}</span>
                <button
                  type="button"
                  className="rpanel-frame-preview-clear"
                  onClick={() => setLastFrame(null)}
                >
                  Remove
                </button>
              </div>
            </div>
          ) : (
            <div className="rpanel-frame-empty">
              <div className="rpanel-frame-btn-row">
                <button
                  type="button"
                  className={`rpanel-frame-use-selected-btn ${!hasCanvasSelection ? "rpanel-frame-use-selected-btn--disabled" : ""}`}
                  disabled={!hasCanvasSelection}
                  onClick={handleUseSelectedForLast}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 12l2 2 4-4" /></svg>
                  Use selected
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {videoMode === "reference-to-video" && (videoModel.startsWith("seedance-") || videoModel.startsWith("kling-o3-")) && (() => {
        const refCap = videoModel.startsWith("kling-o3-") ? 4 : 3;
        return (
          <div className="rpanel-card rpanel-frame-section">
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <h3 className="rpanel-card-title" style={{ margin: 0 }}>Reference Images</h3>
              <span className="rpanel-tag" style={{ opacity: 0.5 }}>Up to {refCap}</span>
            </div>
            {r2vImages.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {r2vImages.map((img, i) => (
                  <div className="rpanel-frame-preview" key={img.id}>
                    <div className="rpanel-frame-preview-img" style={{ backgroundImage: getBackgroundImage(img.url) }} />
                    <div className="rpanel-frame-preview-info">
                      <span className="rpanel-frame-preview-name">{img.name || `Image ${i + 1}`} <span style={{ opacity: 0.55, marginLeft: 4 }}>@element{i + 1}</span></span>
                      <button type="button" className="rpanel-frame-preview-clear" onClick={() => setR2vImages((prev) => prev.filter((_, j) => j !== i))}>
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
                {r2vImages.length < refCap && (
                  <button
                    type="button"
                    className={`rpanel-frame-use-selected-btn ${!hasCanvasSelection ? "rpanel-frame-use-selected-btn--disabled" : ""}`}
                    disabled={!hasCanvasSelection}
                    style={{ marginTop: 4 }}
                    onClick={() => {
                      if (referenceImage && referenceImage.nodeType === "image") {
                        const url = extractRawUrl(referenceImage.gradient);
                        if (isValidImageUrl(url) && !r2vImages.some((r) => r.id === referenceImage.id)) {
                          setR2vImages((prev) => [...prev, { id: referenceImage.id, url, name: referenceImage.label }]);
                        }
                      }
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                    Add selected image
                  </button>
                )}
              </div>
            ) : (
              <div className="rpanel-frame-empty">
                <div className="rpanel-frame-btn-row">
                  <button
                    type="button"
                    className={`rpanel-frame-use-selected-btn ${!hasCanvasSelection ? "rpanel-frame-use-selected-btn--disabled" : ""}`}
                    disabled={!hasCanvasSelection}
                    onClick={() => {
                      if (referenceImage && referenceImage.nodeType === "image") {
                        const url = extractRawUrl(referenceImage.gradient);
                        if (isValidImageUrl(url)) {
                          setR2vImages([{ id: referenceImage.id, url, name: referenceImage.label }]);
                        }
                      }
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 12l2 2 4-4" /></svg>
                    Use selected image
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {videoMode === "reference-to-video" && videoModel.startsWith("seedance-") && (
        <div className="rpanel-more-refs">
          <button type="button" className="rpanel-more-refs-toggle" onClick={() => setMoreRefsOpen((v) => !v)}>
            <svg className={`rpanel-more-refs-chevron ${moreRefsOpen ? "rpanel-more-refs-chevron--open" : ""}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
            More references
            {(referenceVideo || referenceAudio) && <span className="rpanel-more-refs-dot" />}
          </button>
          {moreRefsOpen && (
            <div className="rpanel-more-refs-body">
              <div className="rpanel-card rpanel-frame-section">
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <h3 className="rpanel-card-title" style={{ margin: 0 }}>Reference Video</h3>
                  <span className="rpanel-tag" style={{ opacity: 0.5 }}>Optional</span>
                </div>
                {referenceVideo ? (
                  <div className="rpanel-frame-preview">
                    <div className="rpanel-frame-preview-img" style={{ backgroundImage: getBackgroundImage(referenceVideo.url), backgroundColor: "#222" }} />
                    <div className="rpanel-frame-preview-info">
                      <span className="rpanel-frame-preview-name">{referenceVideo.name}</span>
                      <button type="button" className="rpanel-frame-preview-clear" onClick={() => setReferenceVideo(null)}>
                        Remove
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="rpanel-frame-empty">
                    <div className="rpanel-frame-btn-row">
                      <button
                        type="button"
                        className={`rpanel-frame-use-selected-btn ${!hasVideoSelection ? "rpanel-frame-use-selected-btn--disabled" : ""}`}
                        disabled={!hasVideoSelection}
                        onClick={() => {
                          if (referenceImage && referenceImage.nodeType === "video") {
                            const url = extractRawUrl(referenceImage.gradient);
                            if (url) setReferenceVideo({ id: referenceImage.id, url, name: referenceImage.label });
                          }
                        }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 12l2 2 4-4" /></svg>
                        Use selected video
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="rpanel-card rpanel-frame-section">
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <h3 className="rpanel-card-title" style={{ margin: 0 }}>Reference Audio</h3>
                  <span className="rpanel-tag" style={{ opacity: 0.5 }}>Optional</span>
                </div>
                {referenceAudio ? (
                  <div className="rpanel-frame-preview">
                    <div className="rpanel-frame-preview-img" style={{ backgroundColor: "#222", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14" /><path d="M15.54 8.46a5 5 0 0 1 0 7.07" /></svg>
                    </div>
                    <div className="rpanel-frame-preview-info">
                      <span className="rpanel-frame-preview-name">{referenceAudio.name}</span>
                      <button type="button" className="rpanel-frame-preview-clear" onClick={() => setReferenceAudio(null)}>
                        Remove
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="rpanel-frame-empty">
                    <div className="rpanel-frame-btn-row">
                      <input
                        ref={audioInputRef}
                        type="file"
                        accept="audio/*"
                        style={{ display: "none" }}
                        onChange={handleAudioUpload}
                      />
                      <button
                        type="button"
                        className="rpanel-frame-use-selected-btn"
                        onClick={() => audioInputRef.current?.click()}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
                        Upload audio file
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="rpanel-card rpanel-card--prompt" style={{ position: "relative" }}>
        <span className="rpanel-flat-label" style={{ marginBottom: 2 }}>Prompt</span>
        {videoModel.startsWith("kling-o3-") && (
          <div className="rpanel-prompt-info-wrap">
            <button type="button" className="rpanel-prompt-info-btn" aria-label="Tip">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></svg>
            </button>
            <div className="rpanel-prompt-info-tooltip">
              Name references in your prompt with @element1, @element2, … so Kling O3 knows which subject is which.
            </div>
          </div>
        )}
        <textarea
          className="rpanel-textarea"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe the motion or story for your video..."
        />
      </div>

      <button type="button" className="rpanel-model-selector" onClick={() => toggle("model")}>
        <span className="rpanel-model-selector-icon">
          {videoModelIcon(videoModel)}
        </span>
        <span className="rpanel-model-selector-info">
          <span className="rpanel-model-selector-name">{videoModelLabels[videoModel]}</span>
          <span className="rpanel-model-selector-provider">{videoModelProvider(videoModel)}</span>
        </span>
        <svg className={`rpanel-card-chevron ${openSections.model ? "rpanel-card-chevron--open" : ""}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      {openSections.model && (
        <div className="rpanel-card" style={{ marginTop: -2 }}>
          <div className="rpanel-list">
            <button type="button" className={`rpanel-list-btn ${videoModel === "kling-o3-pro" ? "rpanel-list-btn--active" : ""}`} onClick={() => { setVideoModel("kling-o3-pro"); toggle("model"); }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" /></svg>
              Kling O3 Pro
              <span className="rpanel-tag">Quality</span>
            </button>
            <button type="button" className={`rpanel-list-btn ${videoModel === "kling-o3-4k" ? "rpanel-list-btn--active" : ""}`} onClick={() => { setVideoModel("kling-o3-4k"); toggle("model"); }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></svg>
              Kling O3 4K
              <span className="rpanel-tag">Premium+</span>
            </button>
            <button type="button" className={`rpanel-list-btn ${videoModel === "veo3.1-lite" ? "rpanel-list-btn--active" : ""}`} onClick={() => { setVideoModel("veo3.1-lite"); if (videoMode === "reference-to-video") setVideoMode("text-to-video"); toggle("model"); }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" /><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" /><path d="M5.84 14.09A6.68 6.68 0 0 1 5.5 12c0-.72.12-1.43.34-2.09V7.07H2.18A11 11 0 0 0 1 12c0 1.78.43 3.46 1.18 4.93l3.66-2.84z" /><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" /></svg>
              Veo 3.1 Lite
              <span className="rpanel-tag">Quick</span>
            </button>
            <button type="button" className={`rpanel-list-btn ${videoModel === "seedance-2.5" ? "rpanel-list-btn--active" : ""}`} onClick={() => { setVideoModel("seedance-2.5"); toggle("model"); }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12 Q5 6 8 12 Q11 18 14 12 Q17 6 20 12 Q21 14 22 12"/></svg>
              Seedance 2.5
              <span className="rpanel-tag">Premium</span>
            </button>
            <button type="button" className={`rpanel-list-btn ${videoModel === "seedance-2.0" ? "rpanel-list-btn--active" : ""}`} onClick={() => { handleSelectSeedance(); toggle("model"); }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12 Q5 6 8 12 Q11 18 14 12 Q17 6 20 12 Q21 14 22 12"/></svg>
              Seedance 2.0
              <span className="rpanel-tag">Premium</span>
            </button>
            <button type="button" className={`rpanel-list-btn ${videoModel === "gemini-omni" ? "rpanel-list-btn--active" : ""}`} onClick={() => { setVideoModel("gemini-omni"); if (videoMode === "reference-to-video") setVideoMode("text-to-video"); toggle("model"); }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c.4 5.2 4.4 9.2 9.6 9.6v.8C16.4 12.8 12.4 16.8 12 22h-.8C10.8 16.8 6.8 12.8 1.6 12.4v-.8C6.8 11.2 10.8 7.2 11.2 2h.8z" /></svg>
              Gemini Omni Flash
              <span className="rpanel-tag">Premium</span>
            </button>
            <button type="button" className={`rpanel-list-btn ${videoModel === "h3-max" ? "rpanel-list-btn--active" : ""}`} onClick={() => { setVideoModel("h3-max"); setVideoMode("text-to-video"); toggle("model"); }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3" /></svg>
              MiniMax H3 Max
              <span className="rpanel-tag">Fast</span>
            </button>
          </div>
        </div>
      )}

      {videoMode === "text-to-video" && (
        <div className="rpanel-flat-section">
          <span className="rpanel-flat-label">Aspect ratio</span>
          <div className="rpanel-ar-grid" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
            {[
              { value: "16:9" as const, w: 22, h: 12 },
              { value: "9:16" as const, w: 12, h: 20 },
              { value: "1:1" as const, w: 18, h: 18 },
            ].map(({ value: ar, w, h }) => (
              <button key={ar} type="button" className={`rpanel-ar-card ${aspectRatio === ar ? "rpanel-ar-card--active" : ""}`} onClick={() => setAspectRatio(ar)}>
                <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h}><rect width={w} height={h} rx="2" fill={aspectRatio === ar ? "var(--accent)" : "currentColor"} opacity={aspectRatio === ar ? 0.7 : 0.18} /></svg>
                <span className="rpanel-ar-text">{ar}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="rpanel-flat-section">
        <span className="rpanel-flat-label">Duration</span>
        <div className="rpanel-seg-group rpanel-seg-group--full" data-count={durationOptions.length} data-active={durationIndex >= 0 ? durationIndex : 0}>
          <span className="rpanel-slide-pill" />
          {durationOptions.map((d) => (
            <button key={d} type="button" className={`rpanel-seg-btn ${duration === d ? "rpanel-seg-btn--active" : ""}`} onClick={() => setDuration(d)}>
              {d}s
            </button>
          ))}
        </div>
      </div>

      {(videoModel.startsWith("seedance-") || videoModel === "h3-max" || videoModel === "gemini-omni") && (
        <div className="rpanel-flat-section">
          <span className="rpanel-flat-label">Resolution</span>
          <div className="rpanel-seg-group rpanel-seg-group--full" data-count={videoResOptions.length} data-active={videoResIndex >= 0 ? videoResIndex : 0}>
            <span className="rpanel-slide-pill" />
            {videoResOptions.map((r) => (
              <button key={r} type="button" className={`rpanel-seg-btn ${videoResolution === r ? "rpanel-seg-btn--active" : ""}`} onClick={() => setVideoResolution(r)}>
                {r}
              </button>
            ))}
          </div>
        </div>
      )}

      {videoModel !== "h3-max" && (videoMode !== "reference-to-video" || videoModel.startsWith("kling-o3-")) && (
        <div className="rpanel-flat-section" style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <span className="rpanel-flat-label" style={{ margin: 0 }}>Audio</span>
          <button
            type="button"
            className={`rpanel-toggle ${generateAudio ? "rpanel-toggle--on" : ""}`}
            onClick={() => setGenerateAudio((v) => !v)}
            aria-pressed={generateAudio}
          >
            <span className="rpanel-toggle-knob" />
          </button>
        </div>
      )}

      <div style={{ marginTop: 8 }}>
        <button
          type="button"
          className={gate.className("rpanel-action-btn rpanel-action-btn--tall")}
          data-generate-btn
          onClick={handleGenerate}
          disabled={gate.state === "ready" && isGenerateDisabled}
          style={gate.state === "ready" && isGenerateDisabled ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
        >
          <GenerateButtonCost cost={totalCost} params={estimateParams} visible={gate.state === "ready" && !isGenerateDisabled} />
          <span style={{ flex: 1, textAlign: "center" }}>{gate.label("Generate Video")}</span>
        </button>
      </div>

      {showSeedanceModal && (
        <SeedanceVerificationModal
          onClose={() => setShowSeedanceModal(false)}
          onVerified={handleSeedanceVerified}
        />
      )}
    </>
  );
}
