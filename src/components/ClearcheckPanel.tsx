import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useEstimateCost } from "../hooks/useEstimateCost";
import { useGenerateButton } from "../hooks/useGenerateButton";
import { GenerateButtonCost } from "./GenerateButtonCost";
import { useWorkspace } from "../contexts/WorkspaceContext";
import "./RightPanel.css";
import "./ClearcheckPanel.css";
import type { ReferenceImage } from "../types/canvas";

export type AuditRecord = {
  id: string;
  timestamp: number;
  source: "selected" | "upload";
  fileName: string;
  status: "clear" | "flagged";
  labels: { name: string; confidence: number }[];
  moderationFlags: string[];
};

type Props = {
  hasSelectedImage: boolean;
  onAddAudit: (audit: AuditRecord) => void;
  creditsRequired?: number;
  userBalance?: number;
  unlimited?: boolean;
  onOpenClearcheckPolicy?: () => void;
  referenceImage?: ReferenceImage | null;
  onClearReference?: () => void;
  onClose?: () => void;
};

export function ClearcheckPanel({ hasSelectedImage, onAddAudit, creditsRequired = 15, userBalance = 0, unlimited = false, onOpenClearcheckPolicy, referenceImage = null, onClearReference, onClose }: Props) {
  const { activeWorkspace } = useWorkspace();
  const estimateParams = useMemo(() => ({
    type: "clearcheck",
    model: "clearcheck",
  }), []);
  const { cost: estimatedCost } = useEstimateCost(estimateParams);
  const totalCost = estimatedCost !== null ? estimatedCost : creditsRequired;

  const gate = useGenerateButton(userBalance, unlimited, totalCost);
  const [sourceMode, setSourceMode] = useState<"selected" | "upload" | null>(hasSelectedImage ? "selected" : null);
  const [uploadName, setUploadName] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    labels: { name: string; confidence: number }[];
    moderationFlags: string[];
    status: "clear" | "flagged";
    timestamp: number;
  } | null>(null);

  const uploadedFileRef = useRef<File | null>(null);
  const imageBase64Ref = useRef<string | null>(null);
  const [uploadReady, setUploadReady] = useState(false);
  const [uploadPreview, setUploadPreview] = useState<string | null>(null);

  const [options, setOptions] = useState({
    labels: true,
    moderation: true,
    text: true,
    faces: false,
    celebrities: false,
  });

  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    source: true,
    options: false,
    results: true,
  });
  const toggle = (key: string) =>
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));

  const toggleOption = (key: keyof typeof options) =>
    setOptions((prev) => ({ ...prev, [key]: !prev[key] }));

  useEffect(() => {
    if (hasSelectedImage && sourceMode !== "upload") {
      setSourceMode("selected");
    }
  }, [hasSelectedImage]);

  const hasSource = (sourceMode === "upload" && uploadReady) || (sourceMode === "selected" && hasSelectedImage);

  const showCanvasImage = sourceMode === "selected" && hasSelectedImage && referenceImage;
  const hasActiveImage = showCanvasImage || (sourceMode === "upload" && uploadReady);
  const activePreview = showCanvasImage && referenceImage?.gradient
    ? (referenceImage.gradient.startsWith("url(") || referenceImage.gradient.startsWith("linear-gradient") || referenceImage.gradient.startsWith("radial-gradient")
      ? referenceImage.gradient
      : `url(${referenceImage.gradient})`)
    : sourceMode === "upload" && uploadPreview
      ? `url(${uploadPreview})`
      : null;

  const handleClearSource = useCallback(() => {
    if (sourceMode === "selected") {
      onClearReference?.();
    }
    setSourceMode(null);
    setUploadName(null);
    setUploadReady(false);
    setUploadPreview(null);
    uploadedFileRef.current = null;
    imageBase64Ref.current = null;
    setResult(null);
    setError(null);
  }, [sourceMode, onClearReference]);

  const extractRawUrl = (gradient: string): string => {
    if (!gradient) return "";
    const m = gradient.match(/^url\(["']?(.*?)["']?\)$/);
    return m ? m[1] : gradient;
  };

  const getPayload = useCallback(async (): Promise<{ imageBase64?: string; imageUrl?: string } | null> => {
    if (sourceMode === "upload" && imageBase64Ref.current) {
      return { imageBase64: imageBase64Ref.current };
    }

    if (sourceMode === "selected" && referenceImage?.gradient) {
      const rawUrl = extractRawUrl(referenceImage.gradient);
      if (!rawUrl) return null;
      if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) {
        return { imageUrl: rawUrl };
      }
      try {
        const resp = await fetch(rawUrl);
        const blob = await resp.blob();
        const base64: string = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.readAsDataURL(blob);
        });
        return { imageBase64: base64 };
      } catch {
        return null;
      }
    }

    return null;
  }, [sourceMode, referenceImage]);

  const runAnalysis = useCallback(async () => {
    if (!hasSource) return;
    setAnalyzing(true);
    setResult(null);
    setError(null);

    try {
      const payload = await getPayload();
      if (!payload) {
        setError("Could not read image data. Please try again.");
        setAnalyzing(false);
        return;
      }

      const currentFileName = uploadName || "canvas-selection.png";
      const resp = await fetch("/api/clearcheck", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          ...payload,
          options,
          fileName: currentFileName,
          source: sourceMode || "upload",
          ...(activeWorkspace?.type === "org" ? { workspace_id: activeWorkspace.id } : {}),
        }),
      });

      if (!resp.ok) {
        const data = await resp.json().catch(() => ({ error: "Analysis failed" }));
        setError(data.error || `Analysis failed (${resp.status})`);
        setAnalyzing(false);
        return;
      }

      const data = await resp.json();

      setResult({
        labels: data.labels,
        moderationFlags: data.moderationFlags,
        status: data.status,
        timestamp: data.timestamp,
      });
      setAnalyzing(false);

      const audit: AuditRecord = {
        id: `audit-${data.timestamp}`,
        timestamp: data.timestamp,
        source: sourceMode || "selected",
        fileName: uploadName || "canvas-selection.png",
        status: data.status,
        labels: data.labels,
        moderationFlags: data.moderationFlags,
      };
      onAddAudit(audit);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setAnalyzing(false);
    }
  }, [hasSource, sourceMode, uploadName, onAddAudit, options, getPayload]);

  const handleUploadClick = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) {
        setSourceMode("upload");
        setUploadName(file.name);
        setResult(null);
        setError(null);
        setUploadReady(false);
        uploadedFileRef.current = file;

        const reader = new FileReader();
        reader.onloadend = () => {
          imageBase64Ref.current = reader.result as string;
          setUploadPreview(reader.result as string);
          setUploadReady(true);
        };
        reader.readAsDataURL(file);
      }
    };
    input.click();
  }, []);

  const buildReportMarkdown = useCallback(() => {
    if (!result) return "";
    const md = [
      "# Clearcheck Copyright Audit Report",
      "",
      `**Date:** ${new Date(result.timestamp).toLocaleString()}`,
      `**Source:** ${sourceMode === "upload" ? uploadName : "Canvas Selection"}`,
      `**Status:** ${result.status === "clear" ? "CLEAR" : "FLAGGED"}`,
      "",
      "## Detected Labels",
      "",
      ...result.labels.map((l) => `- ${l.name}: ${l.confidence.toFixed(1)}%`),
      "",
    ];
    if (result.moderationFlags.length > 0) {
      md.push("## Moderation Flags", "", ...result.moderationFlags.map((f) => `- ${f}`), "");
    }
    md.push("---", "*Generated by Clearcheck*");
    return md.join("\n");
  }, [result, sourceMode, uploadName]);

  const downloadReport = useCallback(async () => {
    if (!result) return;

    try {
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();

      zip.file(`clearcheck-report-${result.timestamp}.md`, buildReportMarkdown());

      let imageBlob: Blob | null = null;
      let imageName = "scanned-image.png";

      if (sourceMode === "upload" && uploadedFileRef.current) {
        imageBlob = uploadedFileRef.current;
        imageName = uploadedFileRef.current.name;
      } else if (sourceMode === "selected" && referenceImage?.gradient) {
        try {
          const rawUrl = extractRawUrl(referenceImage.gradient);
          if (rawUrl) {
            const resp = await fetch(rawUrl);
            imageBlob = await resp.blob();
            const ext = rawUrl.split(".").pop()?.split("?")[0] || "png";
            imageName = `canvas-selection.${ext}`;
          }
        } catch {
          // image fetch failed, zip without it
        }
      } else if (imageBase64Ref.current) {
        const parts = imageBase64Ref.current.split(",");
        const byteStr = atob(parts[1] || parts[0]);
        const bytes = new Uint8Array(byteStr.length);
        for (let i = 0; i < byteStr.length; i++) bytes[i] = byteStr.charCodeAt(i);
        const mime = imageBase64Ref.current.match(/data:(.*?);/)?.[1] || "image/png";
        const ext = mime.split("/")[1] || "png";
        imageBlob = new Blob([bytes], { type: mime });
        imageName = `scanned-image.${ext}`;
      }

      if (imageBlob) {
        zip.file(imageName, imageBlob);
      }

      const content = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(content);
      const a = document.createElement("a");
      a.href = url;
      a.download = `clearcheck-report-${result.timestamp}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Zip generation failed, falling back to markdown:", err);
      setError("Zip generation failed â€” downloading markdown report instead.");
      const blob = new Blob([buildReportMarkdown()], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `clearcheck-report-${result.timestamp}.md`;
      a.click();
      URL.revokeObjectURL(url);
    }
  }, [result, sourceMode, uploadName, referenceImage, buildReportMarkdown]);

  return (
    <aside className="rpanel">
      {onClose && (
        <button type="button" className="cc-panel-close-btn" onClick={onClose} title="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}
      <div className="rpanel-scroll">
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", padding: "2px 0 8px" }}>
          Copyright Check
        </div>

        {/* Image Source */}
        <div className="rpanel-card">
          <h3 className="rpanel-card-title" style={{ marginBottom: 8 }}>Image Source</h3>
          {hasActiveImage && activePreview ? (
            <>
              <div className="rpanel-ref-grid">
                <div className="rpanel-ref-large-thumb">
                  <div
                    className="rpanel-ref-large-thumb-img"
                    style={{ backgroundImage: activePreview }}
                  />
                </div>
              </div>
              {uploadName && sourceMode === "upload" && (
                <div className="cc-upload-name">{uploadName}</div>
              )}
              <button
                type="button"
                className="rpanel-ref-clear-all"
                onClick={handleClearSource}
              >
                Clear
              </button>
            </>
          ) : (
            <>
              <p className="rpanel-hint">Select an image on canvas, or upload one.</p>
              <button
                type="button"
                className="rpanel-upload-fallback-btn"
                onClick={handleUploadClick}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
                Upload Image
              </button>
            </>
          )}
        </div>

        {/* Analysis Options */}
        <div className="rpanel-card">
          <button type="button" className="rpanel-card-toggle" onClick={() => toggle("options")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
            <span className="rpanel-card-toggle-label">Analysis Options</span>
            <svg className={`rpanel-card-chevron ${openSections.options ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          {openSections.options && (
            <div className="rpanel-card-body">
              {([
                ["labels", "Label Detection"],
                ["moderation", "Content Moderation"],
                ["text", "Text Detection"],
                ["faces", "Face Detection"],
                ["celebrities", "Celebrity Recognition"],
              ] as const).map(([key, label]) => (
                <div key={key} className="rpanel-toggle-row">
                  <span className="rpanel-toggle-label">{label}</span>
                  <button
                    type="button"
                    className={`rpanel-toggle ${options[key] ? "rpanel-toggle--on" : ""}`}
                    onClick={() => toggleOption(key)}
                    aria-pressed={options[key]}
                  >
                    <span className="rpanel-toggle-knob" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Disclaimer */}
        <div className="rpanel-card cc-disclaimer-card">
          <div className="cc-disclaimer-body">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="cc-disclaimer-icon">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <div className="cc-disclaimer-content">
              <p className="cc-disclaimer-text">
                Clearcheck is limited in accuracy and does not indemnify any art created on the platform.
              </p>
              {onOpenClearcheckPolicy && (
                <button type="button" className="cc-disclaimer-breadcrumb" onClick={onOpenClearcheckPolicy}>
                  Settings â€º Clearcheck Policy
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="rpanel-card cc-disclaimer-card" style={{ borderColor: "rgba(239, 68, 68, 0.3)", background: "rgba(239, 68, 68, 0.06)" }}>
            <div className="cc-disclaimer-body">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}>
                <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
              </svg>
              <p style={{ fontSize: 10, lineHeight: 1.4, color: "#ef4444", margin: 0 }}>{error}</p>
            </div>
          </div>
        )}

        {/* Results */}
        {(result || analyzing) && (
          <div className="rpanel-card">
            <button type="button" className="rpanel-card-toggle" onClick={() => toggle("results")}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></svg>
              <span className="rpanel-card-toggle-label">Results</span>
              {result && (
                <span className={`cc-status-badge cc-status-badge--${result.status}`}>
                  {result.status === "clear" ? "Clear" : "Flagged"}
                </span>
              )}
              <svg className={`rpanel-card-chevron ${openSections.results ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
            </button>
            {openSections.results && (
              <div className="rpanel-card-body">
                {analyzing ? (
                  <div className="cc-analyzing">
                    <div className="cc-analyzing-spinner" />
                    <span>Analyzing image...</span>
                  </div>
                ) : result ? (
                  <>
                    <div className="cc-result-meta">
                      <span>{new Date(result.timestamp).toLocaleTimeString()}</span>
                      <span className={`cc-status-badge cc-status-badge--${result.status}`}>
                        {result.status === "clear" ? "Clear" : "Flagged"}
                      </span>
                    </div>

                    {result.moderationFlags.length > 0 && (
                      <div className="cc-flags">
                        {result.moderationFlags.map((flag, i) => (
                          <div key={i} className="cc-flag-item">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
                            <span>{flag}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="cc-labels-header">Detected Labels</div>
                    <div className="cc-labels-list">
                      {result.labels.map((label, i) => (
                        <div key={i} className="cc-label-row">
                          <span className="cc-label-name">{label.name}</span>
                          <div className="cc-confidence-bar">
                            <div
                              className="cc-confidence-fill"
                              style={{ width: `${label.confidence}%` }}
                            />
                          </div>
                          <span className="cc-confidence-value">{label.confidence.toFixed(1)}%</span>
                        </div>
                      ))}
                    </div>

                    <button type="button" className="cc-download-btn" onClick={downloadReport}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
                      Download Report
                    </button>
                  </>
                ) : null}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="rpanel-footer">
        <button
          type="button"
          className={gate.className(`rpanel-action-btn rpanel-action-btn--tall ${gate.state === "ready" && (!hasSource || analyzing) ? "rpanel-action-btn--disabled" : ""}`)}
          onClick={() => {
            gate.handleClick(() => {
              runAnalysis();
            });
          }}
          disabled={gate.state === "ready" && (!hasSource || analyzing)}
        >
          <GenerateButtonCost cost={totalCost} params={estimateParams} visible={gate.state === "ready" && hasSource && !analyzing} />
          <span style={{ flex: 1, textAlign: "center" }}>{gate.label(analyzing ? "Analyzing..." : "Run Analysis")}</span>
        </button>
      </div>
    </aside>
  );
}
