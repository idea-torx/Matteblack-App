import { useState, useEffect, useRef, useMemo } from "react";
import { useEstimateCost } from "../hooks/useEstimateCost";
import { useGenerateButton } from "../hooks/useGenerateButton";
import { GenerateButtonCost } from "./GenerateButtonCost";
import "./RightPanel.css";
import type { ReferenceImage } from "../types/canvas";
import type { GenerationParams } from "./MakePanel";

type AvatarPanelProps = {
  onGenerate: (params: GenerationParams) => void;
  creditsRequired?: number;
  userBalance?: number;
  unlimited?: boolean;
  referenceImage?: ReferenceImage | null;
  referenceVideo?: ReferenceImage | null;
  onClearReference?: () => void;
  externalPrompt?: string | null;
  onClearExternalPrompt?: () => void;
};

const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"];
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const MAX_VIDEO_SIZE = 100 * 1024 * 1024;
const MAX_PROMPT_LENGTH = 2500;

export function AvatarPanel({
  onGenerate,
  creditsRequired = 30,
  userBalance = 0,
  unlimited = false,
  referenceImage = null,
  referenceVideo = null,
  onClearReference: _onClearReference,
  externalPrompt,
  onClearExternalPrompt,
}: AvatarPanelProps) {
  const [prompt, setPrompt] = useState("");
  const [orientation, setOrientation] = useState<"video" | "image">("video");
  const [keepSound, setKeepSound] = useState(true);
  const [uploadedImageUrl, setUploadedImageUrl] = useState<string | null>(null);
  const [imageUploading, setImageUploading] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);

  const [uploadedVideoUrl, setUploadedVideoUrl] = useState<string | null>(null);
  const [videoUploading, setVideoUploading] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [videoFileName, setVideoFileName] = useState<string | null>(null);
  const [videoPreview, setVideoPreview] = useState<string | null>(null);
  const [refVideoDuration, setRefVideoDuration] = useState<number | null>(null);

  const [useCanvasImage, setUseCanvasImage] = useState(true);
  const [useCanvasVideo, setUseCanvasVideo] = useState(true);

  const estimateParams = useMemo(() => ({
    type: "avatar",
    model: "kling-3.0-mc",
    duration: refVideoDuration ? String(refVideoDuration) : undefined,
  }), [refVideoDuration]);
  const { cost: estimatedCost } = useEstimateCost(estimateParams);
  const totalCost = estimatedCost !== null ? estimatedCost : creditsRequired;

  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);

  function detectVideoDuration(src: string) {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      if (video.duration && isFinite(video.duration)) {
        setRefVideoDuration(Math.ceil(video.duration));
      }
    };
    video.src = src;
  }

  useEffect(() => {
    if (externalPrompt) {
      setPrompt(externalPrompt);
      onClearExternalPrompt?.();
    }
  }, [externalPrompt, onClearExternalPrompt]);

  const gate = useGenerateButton(userBalance, unlimited, totalCost);

  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    orientation: false,
    model: false,
    audio: false,
  });
  const toggle = (key: string) =>
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));

  const getBackgroundImage = (gradient: string) => {
    if (!gradient) return "none";
    if (gradient.startsWith("url(") || gradient.startsWith("linear-gradient") || gradient.startsWith("radial-gradient")) return gradient;
    return `url(${gradient})`;
  };

  const getReferenceUrl = (ref: ReferenceImage | null): string | null => {
    if (!ref) return null;
    const g = ref.gradient;
    if (!g) return null;
    const urlMatch = g.match(/url\(["']?([^"')]+)["']?\)/);
    if (urlMatch) return urlMatch[1];
    if (g.startsWith("http") || g.startsWith("data:") || g.startsWith("/")) return g;
    return null;
  };

  const effectiveImageUrl = useCanvasImage && referenceImage ? getReferenceUrl(referenceImage) : uploadedImageUrl;
  const effectiveImagePreview = useCanvasImage && referenceImage ? getBackgroundImage(referenceImage.gradient) : imagePreview ? `url(${imagePreview})` : null;
  const hasCharImage = !!effectiveImageUrl;

  const effectiveVideoUrl = useCanvasVideo && referenceVideo ? getReferenceUrl(referenceVideo) : uploadedVideoUrl;
  const hasRefVideo = !!effectiveVideoUrl;

  useEffect(() => {
    if (useCanvasVideo && referenceVideo) {
      const url = getReferenceUrl(referenceVideo);
      if (url) {
        detectVideoDuration(url);
      }
    }
  }, [useCanvasVideo, referenceVideo]);

  const showCanvasImage = useCanvasImage && !!referenceImage;
  const showCanvasVideo = useCanvasVideo && !!referenceVideo;

  const canGenerate = !!effectiveImageUrl && !!effectiveVideoUrl;

  async function uploadFile(file: File) {
    const formData = new FormData();
    formData.append("file", file);
    const resp = await fetch("/api/upload-to-fal", {
      method: "POST",
      body: formData,
      credentials: "include",
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data.error || "Upload failed");
    }
    const data = await resp.json();
    return data.url as string;
  }

  function handleImageFile(file: File) {
    setImageError(null);
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
      setImageError("Supported formats: JPG, PNG, WEBP");
      return;
    }
    if (file.size > MAX_IMAGE_SIZE) {
      setImageError("Image must be under 10 MB");
      return;
    }
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    const preview = URL.createObjectURL(file);
    setImagePreview(preview);
    setUseCanvasImage(false);
    setImageUploading(true);
    uploadFile(file)
      .then((url) => {
        setUploadedImageUrl(url);
        setImageUploading(false);
      })
      .catch((err) => {
        setImageError(err.message);
        setImageUploading(false);
        setImagePreview(null);
      });
  }

  function handleVideoFile(file: File) {
    setVideoError(null);
    if (!ALLOWED_VIDEO_TYPES.includes(file.type)) {
      setVideoError("Supported formats: MP4, MOV, WEBM");
      return;
    }
    if (file.size > MAX_VIDEO_SIZE) {
      setVideoError("Video must be under 100 MB");
      return;
    }
    setVideoFileName(file.name);
    setUseCanvasVideo(false);
    const objectUrl = URL.createObjectURL(file);
    setVideoPreview(objectUrl);
    detectVideoDuration(objectUrl);
    setVideoUploading(true);
    uploadFile(file)
      .then((url) => {
        setUploadedVideoUrl(url);
        setVideoUploading(false);
      })
      .catch((err) => {
        setVideoError(err.message);
        setVideoUploading(false);
        setVideoFileName(null);
        setVideoPreview(null);
      });
  }

  function handleClearImage() {
    setUploadedImageUrl(null);
    setImagePreview(null);
    setImageError(null);
    setUseCanvasImage(false);
  }

  function handleClearVideo() {
    setUploadedVideoUrl(null);
    if (videoPreview) URL.revokeObjectURL(videoPreview);
    setVideoPreview(null);
    setVideoFileName(null);
    setVideoError(null);
    setUseCanvasVideo(false);
    setRefVideoDuration(null);
  }

  function handleGenerate() {
    gate.handleClick(() => {
      if (!canGenerate) return;
      const imgUrl = effectiveImageUrl!;
      const vidUrl = effectiveVideoUrl!;
      onGenerate({
        jobType: "avatar",
        model: "kling-3.0-mc",
        prompt: prompt.slice(0, MAX_PROMPT_LENGTH),
        imageUrl: imgUrl,
        videoUrl: vidUrl,
        characterOrientation: orientation,
        keepOriginalSound: keepSound,
        aspectRatio: "16:9",
        refVideoDuration: refVideoDuration ?? undefined,
      });
    });
  }

  return (
    <aside className="rpanel">
      <div className="rpanel-scroll">
        <div className="rpanel-card">
          <h3 className="rpanel-card-title" style={{ marginBottom: 8 }}>Character Image</h3>
          {(hasCharImage || showCanvasImage) && effectiveImagePreview ? (
            <>
              <div className="rpanel-ref-grid">
                <div className="rpanel-ref-large-thumb">
                  <div
                    className="rpanel-ref-large-thumb-img"
                    style={{ backgroundImage: effectiveImagePreview }}
                  />
                </div>
              </div>
              <button
                type="button"
                className="rpanel-ref-clear-all"
                onClick={handleClearImage}
              >
                Clear
              </button>
            </>
          ) : (
            <>
              <p className="rpanel-hint">Select a character image on canvas, or upload one.</p>
              <button
                type="button"
                className="rpanel-upload-fallback-btn"
                onClick={() => imageInputRef.current?.click()}
                disabled={imageUploading}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
                {imageUploading ? "Uploadingâ€¦" : "Upload Image"}
              </button>
            </>
          )}
          {imageError && <span className="rpanel-inline-error">{imageError}</span>}
          <input ref={imageInputRef} type="file" accept=".jpg,.jpeg,.png,.webp" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImageFile(f); e.target.value = ""; }} />
        </div>

        <div className="rpanel-card">
          <h3 className="rpanel-card-title" style={{ marginBottom: 8 }}>Reference Video</h3>
          {(hasRefVideo || showCanvasVideo) && effectiveVideoUrl ? (
            <>
              <div className="rpanel-ref-grid">
                <div className="rpanel-ref-large-thumb">
                  <video
                    className="rpanel-ref-large-thumb-img"
                    src={effectiveVideoUrl}
                    muted
                    playsInline
                    preload="metadata"
                    style={{ width: "100%", height: "100%", objectFit: "cover" }}
                  />
                  <div className="rpanel-ref-video-badge">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
                  </div>
                </div>
              </div>
              {videoFileName && <span style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4, display: "block" }}>{videoFileName}</span>}
              <button
                type="button"
                className="rpanel-ref-clear-all"
                onClick={handleClearVideo}
              >
                Clear
              </button>
            </>
          ) : (
            <>
              <p className="rpanel-hint">Select a video on canvas, or upload one.</p>
              <button
                type="button"
                className="rpanel-upload-fallback-btn"
                onClick={() => videoInputRef.current?.click()}
                disabled={videoUploading}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
                {videoUploading ? "Uploadingâ€¦" : "Upload Video"}
              </button>
            </>
          )}
          {videoError && <span className="rpanel-inline-error">{videoError}</span>}
          <input ref={videoInputRef} type="file" accept=".mp4,.mov,.webm" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) handleVideoFile(f); e.target.value = ""; }} />
        </div>

        <div className="rpanel-card rpanel-card--prompt">
          <div className="rpanel-card-toggle" style={{ cursor: "default", marginBottom: 0 }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" /></svg>
            <span className="rpanel-card-toggle-label">Prompt</span>
          </div>
          <textarea
            className="rpanel-textarea"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value.slice(0, MAX_PROMPT_LENGTH))}
            placeholder="Describe the character or motion..."
            maxLength={MAX_PROMPT_LENGTH}
          />
          {prompt.length > MAX_PROMPT_LENGTH - 100 && (
            <span style={{ fontSize: 10, color: "var(--text-muted)", textAlign: "right" }}>{prompt.length}/{MAX_PROMPT_LENGTH}</span>
          )}
        </div>

        <div className="rpanel-card">
          <button type="button" className="rpanel-card-toggle" onClick={() => toggle("orientation")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="16 3 21 3 21 8" /><line x1="4" y1="20" x2="21" y2="3" />
              <polyline points="21 16 21 21 16 21" /><line x1="15" y1="15" x2="21" y2="21" />
            </svg>
            <span className="rpanel-card-toggle-label">Character Orientation</span>
            <svg className={`rpanel-card-chevron ${openSections.orientation ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          {openSections.orientation && (
            <div className="rpanel-card-body">
              <div className="rpanel-list">
                <button type="button" className={`rpanel-list-btn ${orientation === "video" ? "rpanel-list-btn--active" : ""}`} onClick={() => setOrientation("video")}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" /></svg>
                  From Video
                </button>
                <button type="button" className={`rpanel-list-btn ${orientation === "image" ? "rpanel-list-btn--active" : ""}`} onClick={() => setOrientation("image")}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></svg>
                  From Image
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="rpanel-card">
          <button type="button" className="rpanel-card-toggle" onClick={() => toggle("model")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" /></svg>
            <span className="rpanel-card-toggle-label">Model</span>
            <svg className={`rpanel-card-chevron ${openSections.model ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          {openSections.model && (
            <div className="rpanel-card-body">
              <div className="rpanel-list">
                <button type="button" className="rpanel-list-btn rpanel-list-btn--active">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" /></svg>
                  Kling 3.0 Motion Control
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="rpanel-card">
          <button type="button" className="rpanel-card-toggle" onClick={() => toggle("audio")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14" /><path d="M15.54 8.46a5 5 0 0 1 0 7.07" /></svg>
            <span className="rpanel-card-toggle-label">Audio</span>
            <svg className={`rpanel-card-chevron ${openSections.audio ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          {openSections.audio && (
            <div className="rpanel-card-body">
              <div className="rpanel-toggle-row">
                <span className="rpanel-toggle-label">Keep Sound</span>
                <button
                  type="button"
                  className={`rpanel-toggle ${keepSound ? "rpanel-toggle--on" : ""}`}
                  onClick={() => setKeepSound((v) => !v)}
                  aria-pressed={keepSound}
                >
                  <span className="rpanel-toggle-knob" />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="rpanel-footer">
        <div className="rpanel-disclaimer">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></svg>
          Avatar videos can take 10+ minutes to generate
        </div>
        <button type="button" className={gate.className(`rpanel-action-btn rpanel-action-btn--tall ${gate.state === "ready" && !canGenerate ? "rpanel-action-btn--disabled" : ""}`)} onClick={handleGenerate} disabled={gate.state === "ready" && !canGenerate}>
          <GenerateButtonCost cost={totalCost} params={estimateParams} visible={gate.state === "ready" && canGenerate} />
          <span style={{ flex: 1, textAlign: "center" }}>{gate.label("Generate Avatar")}</span>
        </button>
        {gate.state === "ready" && !canGenerate && (
          <span className="rpanel-credits" style={{ color: "var(--text-muted)", fontSize: 11 }}>
            {!hasCharImage && !hasRefVideo ? "Select or upload a character image and reference video" : !hasCharImage ? "Select or upload a character image" : "Select or upload a reference video"}
          </span>
        )}
      </div>
    </aside>
  );
}
