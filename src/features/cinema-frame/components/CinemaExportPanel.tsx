import { useState, useCallback } from "react";
import { PanelSection } from "../../../components/design/PanelSection";
import { useCinemaExport, type ExportStage } from "../hooks/useCinemaExport";
import { parseTimelineFromMetadata } from "../helpers/timelineState";
import type { ExportConfig } from "../helpers/buildFFmpegCommand";
import "../../../components/RightPanel.css";

type CinemaExportPanelProps = {
  timelineStateRaw: unknown;
};

const STAGE_LABELS: Record<ExportStage, string> = {
  idle: "",
  "loading-ffmpeg": "Loading encoder...",
  "fetching-media": "Fetching media files...",
  probing: "Analyzing streams...",
  encoding: "Encoding video...",
  finalizing: "Finalizing...",
  done: "Export complete!",
  error: "Export failed",
  cancelled: "Export cancelled",
};

export function CinemaExportPanel({ timelineStateRaw }: CinemaExportPanelProps) {
  const [resolution, setResolution] = useState<ExportConfig["resolution"]>("source");
  const [includeAudio, setIncludeAudio] = useState(true);
  const [filename, setFilename] = useState("cinema-export");

  const fakeMetadata = { timelineState: timelineStateRaw } as Record<string, unknown>;
  const timeline = timelineStateRaw ? parseTimelineFromMetadata(fakeMetadata) : null;

  const { startExport, cancelExport, progress, stage, isExporting, error } = useCinemaExport(timeline);

  const handleExport = useCallback(() => {
    startExport({ resolution, includeAudio, filename });
  }, [startExport, resolution, includeAudio, filename]);

  const hasClips = timeline?.tracks.some((t) => t.clips.length > 0) ?? false;

  return (
    <aside className="rpanel rpanel--design">
      <div className="rpanel-scroll">
        <PanelSection title="Export Settings" defaultOpen={true}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <label
                style={{ display: "block", fontSize: 11, color: "var(--text-secondary)", marginBottom: 4 }}
              >
                Resolution
              </label>
              <select
                value={resolution}
                onChange={(e) => setResolution(e.target.value as ExportConfig["resolution"])}
                disabled={isExporting}
                style={{
                  width: "100%",
                  padding: "6px 8px",
                  fontSize: 12,
                  color: "var(--text-primary)",
                  background: "rgba(var(--tint-rgb), 0.04)",
                  border: "1px solid rgba(var(--tint-rgb), 0.08)",
                  borderRadius: 6,
                  outline: "none",
                }}
              >
                <option value="source">Match Source</option>
                <option value="720p">720p (1280x720)</option>
                <option value="1080p">1080p (1920x1080)</option>
              </select>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                id="cinema-export-audio"
                checked={includeAudio}
                onChange={(e) => setIncludeAudio(e.target.checked)}
                disabled={isExporting}
                style={{ accentColor: "var(--accent)" }}
              />
              <label
                htmlFor="cinema-export-audio"
                style={{ fontSize: 12, color: "var(--text-primary)", cursor: "pointer" }}
              >
                Include audio
              </label>
            </div>

            <div>
              <label
                style={{ display: "block", fontSize: 11, color: "var(--text-secondary)", marginBottom: 4 }}
              >
                Filename
              </label>
              <input
                type="text"
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
                disabled={isExporting}
                style={{
                  width: "100%",
                  padding: "6px 8px",
                  fontSize: 12,
                  color: "var(--text-primary)",
                  background: "rgba(var(--tint-rgb), 0.04)",
                  border: "1px solid rgba(var(--tint-rgb), 0.08)",
                  borderRadius: 6,
                  outline: "none",
                }}
                placeholder="cinema-export"
              />
              <span style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2, display: "block" }}>
                .mp4
              </span>
            </div>
          </div>
        </PanelSection>

        {isExporting && (
          <PanelSection title="Progress" defaultOpen={true}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div
                style={{
                  width: "100%",
                  height: 6,
                  background: "rgba(var(--tint-rgb), 0.08)",
                  borderRadius: 3,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${Math.round(progress * 100)}%`,
                    height: "100%",
                    background: "var(--accent)",
                    borderRadius: 3,
                    transition: "width 0.3s ease",
                  }}
                />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                  {STAGE_LABELS[stage]}
                </span>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  {Math.round(progress * 100)}%
                </span>
              </div>
            </div>
          </PanelSection>
        )}

        {stage === "done" && !isExporting && (
          <PanelSection title="Status" defaultOpen={true}>
            <div style={{ fontSize: 12, color: "#4ade80", display: "flex", alignItems: "center", gap: 6 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
              Export complete! File downloaded.
            </div>
          </PanelSection>
        )}

        {error && (
          <PanelSection title="Error" defaultOpen={true}>
            <div style={{ fontSize: 12, color: "#f87171" }}>{error}</div>
          </PanelSection>
        )}
      </div>

      <div className="rpanel-footer" style={{ padding: "10px 14px", borderTop: "1px solid rgba(var(--tint-rgb), 0.06)" }}>
        {isExporting ? (
          <button
            type="button"
            className="rpanel-action-btn rpanel-action-btn--secondary"
            onClick={cancelExport}
            style={{ width: "100%" }}
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            className="rpanel-action-btn"
            onClick={handleExport}
            disabled={!hasClips}
            style={{
              width: "100%",
              padding: "8px 16px",
              fontSize: 13,
              fontWeight: 600,
              color: hasClips ? "var(--text-on-accent)" : "var(--text-muted)",
              background: hasClips ? "var(--accent)" : "rgba(var(--tint-rgb), 0.04)",
              border: "none",
              borderRadius: 6,
              cursor: hasClips ? "pointer" : "not-allowed",
              transition: "background 0.15s, opacity 0.15s",
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6, verticalAlign: -2 }}>
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Export MP4
          </button>
        )}
      </div>
    </aside>
  );
}
