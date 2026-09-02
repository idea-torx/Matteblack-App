import { useState, useEffect, useRef, useCallback } from "react";
import "./RightPanel.css";
import "./GifMakerPanel.css";

interface GifMakerPanelProps {
  onClose: () => void;
  hasSelectedVideo?: boolean;
  videoSrc?: string;
  videoDuration?: number;
  onSendToTray?: (blob: Blob) => void;
}

type ConversionState = "idle" | "converting" | "done" | "error";

export function GifMakerPanel({
  onClose: _onClose,
  hasSelectedVideo = false,
  videoSrc,
  videoDuration = 0,
  onSendToTray,
}: GifMakerPanelProps) {
  const [sourceMode, setSourceMode] = useState<"selected" | "upload" | null>(null);
  const [fps, setFps] = useState(15);
  const [quality, setQuality] = useState(80);
  const [width, setWidth] = useState(480);
  const [loop, setLoop] = useState(true);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    source: true,
    trim: false,
    settings: false,
    preview: true,
  });

  const [conversionState, setConversionState] = useState<ConversionState>("idle");
  const [progress, setProgress] = useState(0);
  const [progressStage, setProgressStage] = useState("");
  const [gifUrl, setGifUrl] = useState<string | null>(null);
  const [gifSize, setGifSize] = useState(0);
  const [, setGifBlob] = useState<Blob | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [uploadedVideoUrl, setUploadedVideoUrl] = useState<string | null>(null);
  const [uploadedDuration, setUploadedDuration] = useState(0);

  const workerRef = useRef<Worker | null>(null);
  const videoPreviewRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [detectedDuration, setDetectedDuration] = useState(0);
  const activeVideoSrc = sourceMode === "upload" ? uploadedVideoUrl : videoSrc;
  const activeDuration = sourceMode === "upload" ? uploadedDuration : (videoDuration || detectedDuration);

  const toggle = (key: string) =>
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));

  useEffect(() => {
    if (hasSelectedVideo && videoSrc && sourceMode !== "upload") {
      setSourceMode("selected");
    }
  }, [hasSelectedVideo, videoSrc]);

  useEffect(() => {
    if (videoSrc && (!videoDuration || videoDuration <= 0)) {
      const vid = document.createElement("video");
      vid.preload = "metadata";
      vid.onloadedmetadata = () => {
        if (vid.duration && isFinite(vid.duration)) {
          setDetectedDuration(vid.duration);
        }
      };
      vid.src = videoSrc;
    }
  }, [videoSrc, videoDuration]);

  useEffect(() => {
    if (activeDuration > 0) {
      setTrimEnd(activeDuration);
      setTrimStart(0);
    }
  }, [activeDuration]);

  const gifUrlRef = useRef<string | null>(null);
  const uploadedVideoUrlRef = useRef<string | null>(null);
  useEffect(() => { gifUrlRef.current = gifUrl; }, [gifUrl]);
  useEffect(() => { uploadedVideoUrlRef.current = uploadedVideoUrl; }, [uploadedVideoUrl]);

  useEffect(() => {
    return () => {
      if (workerRef.current) {
        workerRef.current.terminate();
      }
      if (gifUrlRef.current) {
        URL.revokeObjectURL(gifUrlRef.current);
      }
      if (uploadedVideoUrlRef.current) {
        URL.revokeObjectURL(uploadedVideoUrlRef.current);
      }
    };
  }, []);

  const hasSource = (sourceMode === "upload" && !!uploadedVideoUrl) || (sourceMode === "selected" && hasSelectedVideo && !!videoSrc);

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !file.type.startsWith("video/")) return;

    if (uploadedVideoUrl) {
      URL.revokeObjectURL(uploadedVideoUrl);
    }

    const url = URL.createObjectURL(file);
    setUploadedVideoUrl(url);
    setSourceMode("upload");

    const probeVid = document.createElement("video");
    probeVid.preload = "metadata";
    probeVid.onloadedmetadata = () => {
      setUploadedDuration(probeVid.duration || 0);
    };
    probeVid.src = url;

    if (gifUrl) {
      URL.revokeObjectURL(gifUrl);
      setGifUrl(null);
      setGifBlob(null);
      setGifSize(0);
    }
    setConversionState("idle");
  }, [uploadedVideoUrl, gifUrl]);

  const handleGenerate = useCallback(async () => {
    if (!activeVideoSrc || conversionState === "converting") return;
    if (trimEnd <= trimStart) return;

    setConversionState("converting");
    setProgress(0);
    setProgressStage("Loading video...");
    setErrorMessage("");

    if (gifUrl) {
      URL.revokeObjectURL(gifUrl);
      setGifUrl(null);
      setGifBlob(null);
      setGifSize(0);
    }

    try {
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.crossOrigin = "anonymous";
      video.preload = "auto";
      video.src = activeVideoSrc;

      await new Promise<void>((resolve, reject) => {
        video.onloadeddata = () => resolve();
        video.onerror = () => reject(new Error("Failed to load video"));
        setTimeout(() => reject(new Error("Video load timeout")), 30000);
      });

      const origW = video.videoWidth;
      const origH = video.videoHeight;
      const scale = width / origW;
      const outW = width;
      const outH = Math.round(origH * scale);

      const canvas = document.createElement("canvas");
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("Canvas context not available");

      const clipDuration = trimEnd - trimStart;
      const frameInterval = 1 / fps;
      const totalFrames = Math.min(Math.ceil(clipDuration * fps), 300);

      setProgressStage("Extracting frames...");

      const frameBuffers: ArrayBuffer[] = [];
      for (let i = 0; i < totalFrames; i++) {
        const seekTime = trimStart + i * frameInterval;
        video.currentTime = Math.min(seekTime, video.duration);
        await new Promise<void>((resolve) => {
          video.onseeked = () => resolve();
        });

        ctx.drawImage(video, 0, 0, outW, outH);
        const imageData = ctx.getImageData(0, 0, outW, outH);
        frameBuffers.push(imageData.data.buffer.slice(0));

        const pct = Math.round((i / totalFrames) * 50);
        setProgress(pct);
        if (i % 5 === 0) setProgressStage(`Frame ${i + 1}/${totalFrames}`);
      }

      setProgress(50);
      setProgressStage("Encoding GIF...");

      const worker = new Worker(
        new URL("../workers/gifWorker.ts", import.meta.url),
        { type: "module" }
      );
      workerRef.current = worker;

      worker.onmessage = (e) => {
        const msg = e.data;
        if (msg.type === "progress") {
          const scaledPct = 50 + Math.round(msg.percent * 0.5);
          setProgress(scaledPct);
          setProgressStage(msg.stage);
        } else if (msg.type === "done") {
          const blob = new Blob([msg.gif], { type: "image/gif" });
          const url = URL.createObjectURL(blob);
          setGifUrl(url);
          setGifBlob(blob);
          setGifSize(msg.size);
          setConversionState("done");
          setProgress(100);
          setProgressStage("Complete!");
          worker.terminate();
          workerRef.current = null;
          if (onSendToTray) onSendToTray(blob);
        } else if (msg.type === "error") {
          setConversionState("error");
          setErrorMessage(msg.message);
          worker.terminate();
          workerRef.current = null;
        }
      };

      worker.onerror = (err) => {
        setConversionState("error");
        setErrorMessage(err.message || "Worker error");
        worker.terminate();
        workerRef.current = null;
      };

      worker.postMessage({
        type: "convert",
        frames: frameBuffers,
        width: outW,
        height: outH,
        fps,
        quality,
        loop,
      }, frameBuffers);
    } catch (err: any) {
      setConversionState("error");
      setErrorMessage(err?.message || "Failed to start conversion");
    }
  }, [activeVideoSrc, fps, quality, width, loop, trimStart, trimEnd, conversionState, gifUrl]);

  const formatTime = (t: number) => {
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    const ms = Math.round((t % 1) * 10);
    return `${m}:${s.toString().padStart(2, "0")}.${ms}`;
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <aside className="rpanel">
      <div className="rpanel-scroll">
        <div className="rpanel-card">
          <button type="button" className="rpanel-card-toggle" onClick={() => toggle("source")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="2" width="20" height="20" rx="2" />
              <path d="M10 8v8l6-4-6-4z" />
            </svg>
            <span className="rpanel-card-toggle-label">Video Source</span>
            {!openSections.source && sourceMode === "selected" && hasSelectedVideo && <span className="rpanel-tag">Selected</span>}
            {!openSections.source && sourceMode === "upload" && uploadedVideoUrl && <span className="rpanel-tag">Upload</span>}
            <svg className={`rpanel-card-chevron ${openSections.source ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          {openSections.source && (
            <div className="rpanel-card-body">
              <div className="rpanel-list">
                <button
                  type="button"
                  className={`rpanel-list-btn ${sourceMode === "selected" && hasSelectedVideo ? "rpanel-list-btn--active" : ""}`}
                  onClick={() => hasSelectedVideo && videoSrc ? setSourceMode("selected") : undefined}
                  disabled={!hasSelectedVideo || !videoSrc}
                  style={{ opacity: hasSelectedVideo && videoSrc ? 1 : 0.4 }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="2" width="20" height="20" rx="2" />
                    <path d="M10 8v8l6-4-6-4z" />
                  </svg>
                  Use selected {!hasSelectedVideo && "(no video selected)"}
                </button>
                <button
                  type="button"
                  className={`rpanel-list-btn ${sourceMode === "upload" && uploadedVideoUrl ? "rpanel-list-btn--active" : ""}`}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  Upload video
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="video/*"
                  style={{ display: "none" }}
                  onChange={handleFileUpload}
                />
              </div>
              {hasSource && activeVideoSrc && (
                <div className="gifmaker-source-preview">
                  <video
                    ref={videoPreviewRef}
                    src={activeVideoSrc}
                    muted
                    playsInline
                    preload="metadata"
                    className="gifmaker-source-video"
                    controls
                  />
                </div>
              )}
            </div>
          )}
        </div>

        <div className="rpanel-card">
          <button type="button" className="rpanel-card-toggle" onClick={() => toggle("trim")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" />
              <line x1="20" y1="4" x2="8.12" y2="15.88" />
              <line x1="14.47" y1="14.48" x2="20" y2="20" />
              <line x1="8.12" y1="8.12" x2="12" y2="12" />
            </svg>
            <span className="rpanel-card-toggle-label">Trim</span>
            <svg className={`rpanel-card-chevron ${openSections.trim ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          {openSections.trim && (
            <div className="rpanel-card-body">
              <div className="rpanel-slider-group">
                <div className="rpanel-slider-header">
                  <span className="rpanel-slider-label">Start</span>
                  <span className="rpanel-slider-value">{formatTime(trimStart)}</span>
                </div>
                <input
                  type="range"
                  className="rpanel-slider"
                  min={0}
                  max={Math.max(0, (trimEnd || activeDuration) - 0.1)}
                  step={0.1}
                  value={trimStart}
                  onChange={(e) => setTrimStart(Number(e.target.value))}
                />
              </div>
              <div className="rpanel-slider-group" style={{ marginTop: 14 }}>
                <div className="rpanel-slider-header">
                  <span className="rpanel-slider-label">End</span>
                  <span className="rpanel-slider-value">{formatTime(trimEnd)}</span>
                </div>
                <input
                  type="range"
                  className="rpanel-slider"
                  min={trimStart + 0.1}
                  max={activeDuration || 100}
                  step={0.1}
                  value={trimEnd}
                  onChange={(e) => setTrimEnd(Number(e.target.value))}
                />
              </div>
              {activeDuration > 0 && (
                <div className="gifmaker-trim-info">
                  Clip duration: {formatTime(Math.max(0, trimEnd - trimStart))} / {formatTime(activeDuration)}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="rpanel-card">
          <button type="button" className="rpanel-card-toggle" onClick={() => toggle("settings")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <span className="rpanel-card-toggle-label">Settings</span>
            <svg className={`rpanel-card-chevron ${openSections.settings ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          {openSections.settings && (
            <div className="rpanel-card-body">
              <div className="rpanel-sliders">
                <div className="rpanel-slider-group">
                  <div className="rpanel-slider-header">
                    <span className="rpanel-slider-label">FPS</span>
                    <span className="rpanel-slider-value">{fps}</span>
                  </div>
                  <input
                    type="range"
                    className="rpanel-slider"
                    min={5}
                    max={30}
                    value={fps}
                    onChange={(e) => setFps(Number(e.target.value))}
                  />
                </div>
                <div className="rpanel-slider-group">
                  <div className="rpanel-slider-header">
                    <span className="rpanel-slider-label">Quality</span>
                    <span className="rpanel-slider-value">{quality}%</span>
                  </div>
                  <input
                    type="range"
                    className="rpanel-slider"
                    min={10}
                    max={100}
                    value={quality}
                    onChange={(e) => setQuality(Number(e.target.value))}
                  />
                </div>
                <div className="rpanel-slider-group">
                  <div className="rpanel-slider-header">
                    <span className="rpanel-slider-label">Width</span>
                    <span className="rpanel-slider-value">{width}px</span>
                  </div>
                  <input
                    type="range"
                    className="rpanel-slider"
                    min={120}
                    max={1080}
                    step={10}
                    value={width}
                    onChange={(e) => setWidth(Number(e.target.value))}
                  />
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 16 }}>
                <span className="rpanel-slider-label">Loop</span>
                <button
                  type="button"
                  className={`rpanel-toggle ${loop ? "rpanel-toggle--on" : ""}`}
                  onClick={() => setLoop((v) => !v)}
                >
                  <span className="rpanel-toggle-knob" />
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="rpanel-card">
          <button type="button" className="rpanel-card-toggle" onClick={() => toggle("preview")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
            <span className="rpanel-card-toggle-label">Preview</span>
            {conversionState === "done" && !openSections.preview && <span className="rpanel-tag">Ready</span>}
            <svg className={`rpanel-card-chevron ${openSections.preview ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          {openSections.preview && (
            <div className="rpanel-card-body">
              <div className="gifmaker-preview">
                {conversionState === "converting" && (
                  <div className="gifmaker-preview-converting">
                    <div className="gifmaker-progress-ring">
                      <svg viewBox="0 0 36 36" className="gifmaker-progress-circle">
                        <path
                          d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                          fill="none"
                          stroke="rgba(255,255,255,0.08)"
                          strokeWidth="3"
                        />
                        <path
                          d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                          fill="none"
                          stroke="var(--accent)"
                          strokeWidth="3"
                          strokeDasharray={`${progress}, 100`}
                          strokeLinecap="round"
                        />
                      </svg>
                      <span className="gifmaker-progress-text">{progress}%</span>
                    </div>
                    <span className="gifmaker-progress-stage">{progressStage}</span>
                  </div>
                )}
                {conversionState === "done" && gifUrl && (
                  <div className="gifmaker-preview-content">
                    <div className="gifmaker-preview-frame gifmaker-preview-frame--result">
                      <img src={gifUrl} alt="Generated GIF" className="gifmaker-result-img" draggable={false} />
                    </div>
                    <div className="gifmaker-preview-meta">
                      <span>{width}px &middot; {fps}fps &middot; {loop ? "loop" : "once"}</span>
                      <span>{formatSize(gifSize)}</span>
                    </div>
                  </div>
                )}
                {conversionState === "error" && (
                  <div className="gifmaker-preview-empty gifmaker-preview-error">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="15" y1="9" x2="9" y2="15" />
                      <line x1="9" y1="9" x2="15" y2="15" />
                    </svg>
                    <span>{errorMessage || "Conversion failed"}</span>
                    <button type="button" className="gifmaker-retry-btn" onClick={handleGenerate}>Retry</button>
                  </div>
                )}
                {conversionState === "idle" && hasSource && (
                  <div className="gifmaker-preview-content">
                    <div className="gifmaker-preview-frame">
                      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <polygon points="5 3 19 12 5 21 5 3" />
                      </svg>
                    </div>
                    <div className="gifmaker-preview-meta">
                      <span>{width}px &middot; {fps}fps &middot; {loop ? "loop" : "once"}</span>
                      <span>Click Generate to convert</span>
                    </div>
                  </div>
                )}
                {conversionState === "idle" && !hasSource && (
                  <div className="gifmaker-preview-empty">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="2" width="20" height="20" rx="2" />
                      <path d="M10 8v8l6-4-6-4z" />
                    </svg>
                    <span>Select a video source</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="rpanel-footer">
        <button
          type="button"
          className={`rpanel-action-btn ${!hasSource || conversionState === "converting" || trimEnd <= trimStart ? "rpanel-action-btn--disabled" : ""}`}
          onClick={handleGenerate}
          disabled={!hasSource || conversionState === "converting" || trimEnd <= trimStart}
        >
          {conversionState === "converting" ? "Converting..." : conversionState === "done" ? "Regenerate GIF" : "Generate GIF"}
        </button>
      </div>
    </aside>
  );
}
