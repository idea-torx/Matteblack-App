import { useState, useCallback } from "react";
import { useCinemaExport, type ExportStage } from "../hooks/useCinemaExport";
import { parseTimelineFromMetadata } from "../helpers/timelineState";
import type { ExportConfig } from "../helpers/buildFFmpegCommand";
import "../../../components/RightPanel.css";
import "./CinemaExportPanel.css";

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

  const stageLine = error ? error : stage === "done" ? "Export complete. File downloaded." : STAGE_LABELS[stage];

  return (
    <aside className="rpanel rpanel--design">
      <div className="rpanel-scroll">
        <div className="rpanel-card cinema-export-card">
          <h3 className="rpanel-card-title">Export Settings</h3>

          <div className="cinema-export-field">
            <label className="rpanel-setting-label" htmlFor="cinema-export-res">Resolution</label>
            <select
              id="cinema-export-res"
              className="rpanel-select"
              value={resolution}
              onChange={(e) => setResolution(e.target.value as ExportConfig["resolution"])}
              disabled={isExporting}
            >
              <option value="source">Match Source</option>
              <option value="720p">720p (1280x720)</option>
              <option value="1080p">1080p (1920x1080)</option>
            </select>
          </div>

          <div className="cinema-export-field">
            <label className="rpanel-setting-label" htmlFor="cinema-export-name">Filename</label>
            <div className="cinema-export-name">
              <input
                id="cinema-export-name"
                type="text"
                className="rpanel-url-input"
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
                disabled={isExporting}
                placeholder="cinema-export"
              />
              <span className="cinema-export-ext">.mp4</span>
            </div>
          </div>

          <label className="cinema-export-check" htmlFor="cinema-export-audio">
            <input
              type="checkbox"
              id="cinema-export-audio"
              checked={includeAudio}
              onChange={(e) => setIncludeAudio(e.target.checked)}
              disabled={isExporting}
            />
            Include audio
          </label>

          {(isExporting || stageLine) && (
            <div className="cinema-export-status">
              {isExporting && (
                <div className="cinema-export-bar">
                  <div className="cinema-export-bar-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
                </div>
              )}
              <div className={`cinema-export-stage${error ? " cinema-export-stage--error" : ""}`}>
                <span>{stageLine}</span>
                {isExporting && <span>{Math.round(progress * 100)}%</span>}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="rpanel-footer">
        {isExporting ? (
          <button type="button" className="rpanel-action-btn rpanel-action-btn--secondary" onClick={cancelExport}>
            Cancel
          </button>
        ) : (
          <button
            type="button"
            className="rpanel-action-btn"
            onClick={handleExport}
            disabled={!hasClips}
          >
            Export MP4
          </button>
        )}
      </div>
    </aside>
  );
}
