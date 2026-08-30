import { useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { UndoCommand } from "../../types/canvas";
import { ZOOM_BASELINE } from "../../types/canvas";

export type ZoomToolbarProps = {
  zoom: number;
  zoomMode: boolean;
  snapEnabled: boolean;
  gridSize: number;
  showMinimap: boolean;
  toolbarExpanded: boolean;
  presentMode?: boolean;
  undoStack: MutableRefObject<UndoCommand[]>;
  redoStack: MutableRefObject<UndoCommand[]>;
  downloadableCount: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomToFit: () => void;
  onSetZoomMode: (fn: (v: boolean) => boolean) => void;
  onSetSnapEnabled: (fn: (v: boolean) => boolean) => void;
  onSetGridSize: (size: number) => void;
  onSetShowMinimap: (fn: (v: boolean) => boolean) => void;
  onSetToolbarExpanded: (fn: (v: boolean) => boolean) => void;
  onUndo: () => void;
  onRedo: () => void;
  onTogglePresentMode?: () => void;
  gridView?: boolean;
  onToggleGridView?: () => void;
  onBulkDownload: () => void;
};

export function ZoomToolbar({
  zoom,
  zoomMode,
  snapEnabled,
  gridSize,
  showMinimap,
  toolbarExpanded,
  undoStack,
  redoStack,
  downloadableCount,
  onZoomIn,
  onZoomOut,
  onZoomToFit,
  onSetZoomMode,
  onSetSnapEnabled,
  onSetGridSize,
  onSetShowMinimap,
  onSetToolbarExpanded,
  onUndo,
  onRedo,
  gridView,
  onToggleGridView,
  onBulkDownload,
}: ZoomToolbarProps) {
  /* Toggle a transient "pulse" class whenever the toolbar expands or
   * collapses so the pill gives a one-shot springy pop. We skip the
   * very first render (mount) so the toolbar doesn't pop on page
   * load — only on user-driven toggles. */
  const toolbarRef = useRef<HTMLDivElement>(null);
  const skipFirst = useRef(true);
  /* Tracks whether we are within the very first mount window. While
   * true, the CSS stagger animation on `> *` is allowed to play; once
   * cleared it is suppressed so children that get inserted later
   * (e.g. the bulk-download button when selection grows, or the +/-
   * buttons on toolbar expand) do NOT re-trigger the cascade — and,
   * critically, so the toolbar does not visually flash when zoom-driven
   * re-renders cause any conditional child to re-mount. */
  const [justMounted, setJustMounted] = useState(true);
  useEffect(() => {
    const t = window.setTimeout(() => setJustMounted(false), 360);
    return () => window.clearTimeout(t);
  }, []);
  useEffect(() => {
    if (skipFirst.current) {
      skipFirst.current = false;
      return;
    }
    const el = toolbarRef.current;
    if (!el) return;
    el.classList.remove("freeform-canvas__toolbar--pulse");
    // Force reflow so the class re-add re-triggers the animation.
    void el.offsetWidth;
    el.classList.add("freeform-canvas__toolbar--pulse");
    const t = window.setTimeout(() => {
      el.classList.remove("freeform-canvas__toolbar--pulse");
    }, 380);
    return () => window.clearTimeout(t);
  }, [toolbarExpanded]);

  /* Publish the toolbar's actual rendered width as a CSS custom property
   * on <html> so other floating UI (e.g. the multiplayer presence cluster)
   * can sit immediately to its right without overlapping the pill as it
   * expands/collapses. We use ResizeObserver because the toolbar's width
   * changes both on user toggles AND on subtle layout shifts (font load,
   * panel open, etc). The variable is cleared on unmount. */
  useEffect(() => {
    const el = toolbarRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const root = document.documentElement;
    let lastWritten = -1;
    const update = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      // Skip sub-pixel/no-op writes — without this, mid-zoom layout
      // reads can re-fire the observer with the same rounded width
      // and force an unnecessary style recalculation on <html>.
      if (w === lastWritten) return;
      lastWritten = w;
      root.style.setProperty("--zoom-toolbar-width", `${w}px`);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--zoom-toolbar-width");
    };
  }, []);

  return (
    <div
      ref={toolbarRef}
      className="freeform-canvas__toolbar"
      data-expanded={toolbarExpanded ? "true" : "false"}
      data-just-mounted={justMounted ? "true" : "false"}
    >
      {toolbarExpanded && downloadableCount >= 2 && (
        <>
          <button
            type="button"
            className="freeform-canvas__zoom-btn freeform-canvas__bulk-download-btn"
            onClick={onBulkDownload}
            title={`Download ${downloadableCount} selected files`}
            aria-label={`Download ${downloadableCount} selected files`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <span className="freeform-canvas__bulk-download-count">{downloadableCount}</span>
          </button>
          <div className="freeform-canvas__toolbar-sep" />
        </>
      )}
      <div className="freeform-canvas__zoom-controls">
        {toolbarExpanded && (
          <button type="button" className="freeform-canvas__zoom-btn" onClick={onZoomOut} aria-label="Zoom out">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        )}
        <span className="freeform-canvas__zoom-pct" onClick={onZoomToFit} title="Click to fit all">
          {Math.round((zoom / ZOOM_BASELINE) * 100)}%
        </span>
        {toolbarExpanded && (
          <button type="button" className="freeform-canvas__zoom-btn" onClick={onZoomIn} aria-label="Zoom in">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        )}
      </div>

      {toolbarExpanded && (
        <>
          <div className="freeform-canvas__toolbar-sep" />

          <button
            type="button"
            className={`freeform-canvas__zoom-btn ${zoomMode ? "freeform-canvas__zoom-btn--active" : ""}`}
            onClick={() => onSetZoomMode((v) => !v)}
            title={zoomMode ? "Zoom mode (scroll to zoom) — click or release Space to return to pan" : "Pan mode (scroll to pan) — hold Space for zoom"}
            aria-label="Toggle zoom/pan mode"
          >
            {zoomMode ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="11" y1="8" x2="11" y2="14" /><line x1="8" y1="11" x2="14" y2="11" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v0" /><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2" /><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8" /><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 16" />
              </svg>
            )}
          </button>

          <div className="freeform-canvas__toolbar-sep" />

          <button
            type="button"
            className={`freeform-canvas__zoom-btn ${snapEnabled ? "freeform-canvas__zoom-btn--active" : ""}`}
            onClick={() => onSetSnapEnabled((v) => !v)}
            title={`Snap to grid (${gridSize}px)`}
            aria-label="Toggle snap to grid"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" />
            </svg>
          </button>

          {snapEnabled && (
            <select
              className="freeform-canvas__grid-select"
              value={gridSize}
              onChange={(e) => onSetGridSize(Number(e.target.value))}
              title="Grid spacing"
            >
              <option value={10}>10px</option>
              <option value={20}>20px</option>
              <option value={40}>40px</option>
              <option value={50}>50px</option>
            </select>
          )}

          <div className="freeform-canvas__toolbar-sep" />

          <button
            type="button"
            className={`freeform-canvas__zoom-btn ${showMinimap ? "freeform-canvas__zoom-btn--active" : ""}`}
            onClick={() => onSetShowMinimap((v) => !v)}
            title="Toggle minimap"
            aria-label="Toggle minimap"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="2" width="20" height="20" rx="2" /><rect x="6" y="6" width="6" height="4" rx="1" opacity="0.5" /><rect x="14" y="12" width="4" height="6" rx="1" opacity="0.5" />
            </svg>
          </button>

          <div className="freeform-canvas__toolbar-sep" />

          <button
            type="button"
            className="freeform-canvas__zoom-btn"
            onClick={onUndo}
            disabled={undoStack.current.length === 0}
            title="Undo (Ctrl+Z)"
            aria-label="Undo"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
            </svg>
          </button>
          <button
            type="button"
            className="freeform-canvas__zoom-btn"
            onClick={onRedo}
            disabled={redoStack.current.length === 0}
            title="Redo (Ctrl+Shift+Z)"
            aria-label="Redo"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10" />
            </svg>
          </button>
        </>
      )}

      {toolbarExpanded && <div className="freeform-canvas__toolbar-sep" />}

      {onToggleGridView && (
        <>
          <button
            type="button"
            className={`freeform-canvas__zoom-btn ${gridView ? "freeform-canvas__zoom-btn--active" : ""}`}
            onClick={onToggleGridView}
            aria-pressed={!!gridView}
            title={gridView ? "Back to canvas" : "Grid view — every asset, newest first"}
            aria-label="Toggle grid view"
          >
            {gridView ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7h7v10H3zM14 5h7v6h-7zM14 15h7v4h-7z" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
            )}
          </button>
          <div className="freeform-canvas__toolbar-sep" />
        </>
      )}

      <button
        type="button"
        className="freeform-canvas__zoom-btn freeform-canvas__toolbar-toggle"
        onClick={() => onSetToolbarExpanded((v) => !v)}
        title={toolbarExpanded ? "Collapse toolbar" : "Expand toolbar"}
        aria-label="Toggle toolbar"
      >
        {/* Single chevron — CSS rotates it 180° based on the
            data-expanded attribute on the root, so the icon swap reads
            as a smooth flip rather than a hard cut. */}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
    </div>
  );
}
