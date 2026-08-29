import { useMemo } from "react";
import { useEstimateCost } from "../hooks/useEstimateCost";
import { PanelSection } from "./design/PanelSection";
import "./RightPanel.css";

type SelectionContextPanelProps = {
  selectionType: "image" | "video" | "svg" | "multi" | "none" | "shape" | "text";
  count: number;
  onAction: (action: string, ar?: string, jobType?: string) => void;
  creditsRequired?: number;
  userBalance?: number;
  onClearSelection: () => void;
};

export function SelectionContextPanel({
  selectionType,
  count,
  onAction,
  creditsRequired = 10,
  userBalance = 0,
  onClearSelection,
}: SelectionContextPanelProps) {
  const estimateParams = useMemo(() => ({
    type: "upscale",
    model: "seedvr-upscale",
  }), []);
  const { cost: estimatedCost } = useEstimateCost(estimateParams);
  const totalCost = estimatedCost !== null ? estimatedCost : creditsRequired;

  if (selectionType === "multi") {
    return (
      <aside className="rpanel rpanel--design">
        <div className="rpanel-scroll">
          <PanelSection
            title="Batch Selection"
            defaultOpen={false}
            badge={<span className="rpanel-tag">{count} items</span>}
          >
            <div />
          </PanelSection>

          <PanelSection title="Batch Actions" defaultOpen={true}>
            <div className="rpanel-list">
              <button type="button" className="rpanel-list-btn" onClick={() => onAction("export")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                Export All
              </button>
              <button type="button" className="rpanel-list-btn" onClick={() => onAction("group")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="1" y="1" width="10" height="10" rx="2" />
                  <rect x="13" y="13" width="10" height="10" rx="2" />
                  <path d="M13 1h8a2 2 0 0 1 2 2v8" />
                  <path d="M1 13v8a2 2 0 0 0 2 2h8" />
                </svg>
                Group
              </button>
              <button type="button" className="rpanel-list-btn rpanel-list-btn--danger" onClick={() => onAction("delete")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
                Delete Selected
              </button>
            </div>
          </PanelSection>
        </div>

        <div className="rpanel-footer">
          <button type="button" className="rpanel-action-btn rpanel-action-btn--secondary" onClick={onClearSelection}>
            Clear Selection
          </button>
        </div>
      </aside>
    );
  }

  if (selectionType === "video") {
    return (
      <aside className="rpanel rpanel--design">
        <div className="rpanel-scroll">
          <PanelSection title="Video Selected" defaultOpen={false}>
            <div />
          </PanelSection>

          <PanelSection title="Video Actions" defaultOpen={true}>
            <div className="rpanel-list">
              <button type="button" className="rpanel-list-btn" onClick={() => onAction("upscale_video")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></svg>
                Upscale
              </button>
              <button type="button" className="rpanel-list-btn" onClick={() => onAction("extend_video")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 3 21 3 21 9" />
                  <polyline points="9 21 3 21 3 15" />
                  <line x1="21" y1="3" x2="14" y2="10" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </svg>
                Extend Video
              </button>
              <button type="button" className="rpanel-list-btn" onClick={() => onAction("video_to_gif")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
                  <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
                </svg>
                Convert to GIF
              </button>
              <button type="button" className="rpanel-list-btn" onClick={() => onAction("extract_frames")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="6" width="16" height="12" rx="2" />
                  <path d="M22 8.5V17a2 2 0 0 1-2 2" />
                </svg>
                Extract Frames
              </button>
              <button type="button" className="rpanel-list-btn" onClick={() => onAction("download")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                Download
              </button>
            </div>
          </PanelSection>
        </div>

        <div className="rpanel-footer">
          <button type="button" className="rpanel-action-btn rpanel-action-btn--secondary" onClick={onClearSelection}>
            Deselect
          </button>
          <span className="rpanel-credits">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M14.5 9a3.5 3.5 0 1 0 0 6"/></svg>
            {totalCost}
          </span>
        </div>
      </aside>
    );
  }

  if (selectionType === "svg") {
    return (
      <aside className="rpanel rpanel--design">
        <div className="rpanel-scroll">
          <PanelSection title="Vector Selected" defaultOpen={false}>
            <div />
          </PanelSection>

          <PanelSection title="Vector Actions" defaultOpen={true}>
            <div className="rpanel-list">
              <button type="button" className="rpanel-list-btn" onClick={() => onAction("download")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                Download SVG
              </button>
              <button type="button" className="rpanel-list-btn" onClick={() => onAction("cleanup_vector")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <polyline points="22 4 12 14.01 9 11.01" />
                </svg>
                Cleanup Vector
              </button>
              <button type="button" className="rpanel-list-btn" onClick={() => onAction("clearcheck")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
                ClearCheck
              </button>
            </div>
          </PanelSection>
        </div>

        <div className="rpanel-footer">
          <button type="button" className="rpanel-action-btn rpanel-action-btn--secondary" onClick={onClearSelection}>
            Deselect
          </button>
          <span className="rpanel-credits">{userBalance} Credits available</span>
        </div>
      </aside>
    );
  }

  if (selectionType === "image") {
    return (
      <aside className="rpanel rpanel--design">
        <div className="rpanel-scroll">
          <PanelSection title="Image Selected" defaultOpen={false}>
            <div />
          </PanelSection>

          <PanelSection title="Image Actions" defaultOpen={true}>
            <div className="rpanel-list">
              <button type="button" className="rpanel-list-btn" onClick={() => onAction("img2video", "16:9", "video_gen")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="23 7 16 12 23 17 23 7" />
                  <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                </svg>
                Image to Video
              </button>
              <button type="button" className="rpanel-list-btn" onClick={() => onAction("upscale", "1:1", "upscale")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 3 21 3 21 9" />
                  <polyline points="9 21 3 21 3 15" />
                  <line x1="21" y1="3" x2="14" y2="10" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </svg>
                Upscale
              </button>
              <button type="button" className="rpanel-list-btn" onClick={() => onAction("expand", "16:9", "resize")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <line x1="9" y1="3" x2="9" y2="21" />
                  <line x1="15" y1="3" x2="15" y2="21" />
                </svg>
                Expand / Resize
              </button>
              <button type="button" className="rpanel-list-btn" onClick={() => onAction("variations", "1:1", "image_to_image")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="6" width="16" height="12" rx="2" />
                  <path d="M22 8.5V17a2 2 0 0 1-2 2" />
                </svg>
                Variations
              </button>
              <button type="button" className="rpanel-list-btn" onClick={() => onAction("style_transfer", "1:1", "image_to_image")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 0C12 0 14.5 8.5 12 12C9.5 8.5 12 0 12 0ZM12 24C12 24 9.5 15.5 12 12C14.5 15.5 12 24 12 24ZM0 12C0 12 8.5 9.5 12 12C8.5 14.5 0 12 0 12ZM24 12C24 12 15.5 14.5 12 12C15.5 9.5 24 12 24 12Z" />
                </svg>
                Style Transfer
              </button>
              <button type="button" className="rpanel-list-btn" onClick={() => onAction("remove_bg", "1:1", "remove_bg")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 5.5A3.5 3.5 0 0 1 8.5 2H12v7H8.5A3.5 3.5 0 0 1 5 5.5z" />
                  <path d="M12 2h3.5a3.5 3.5 0 1 1 0 7H12V2z" />
                  <path d="M12 12.5a3.5 3.5 0 1 1 7 0 3.5 3.5 0 1 1-7 0z" />
                </svg>
                Remove Background
              </button>
              <button type="button" className="rpanel-list-btn" onClick={() => onAction("clearcheck")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
                ClearCheck
              </button>
            </div>
          </PanelSection>
        </div>

        <div className="rpanel-footer">
          <button type="button" className="rpanel-action-btn rpanel-action-btn--secondary" onClick={onClearSelection}>
            Deselect
          </button>
          <span className="rpanel-credits">{userBalance} Credits available</span>
        </div>
      </aside>
    );
  }

  return null;
}
