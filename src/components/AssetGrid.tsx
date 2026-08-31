import { useMemo, useState, type CSSProperties } from "react";
import type { CanvasNode } from "../types/canvas";
import { parseTimelineFromMetadata, getTotalDuration, type TimelineState } from "../features/cinema-frame/helpers/timelineState";
import { MediaModal, type MediaModalTarget } from "./MediaModal";
import type { NodeActionHandlers } from "./canvas/NodeActions";
import { useNodeToolbar } from "../hooks/useNodeToolbar";
import "./AssetGrid.css";

/**
 * The canvas as a plain reverse-chronological grid.
 *
 * An overlay, not a replacement: the canvas stays mounted underneath so the
 * node list stays live and flipping back is instant. The canvas is the right
 * surface for arranging work and the wrong one for "show me what I made" —
 * this is the second half.
 */

/** Frames, shapes and text are canvas furniture, not output. */
const ASSET_TYPES = new Set(["image", "video", "svg", "audio", "cinema"]);

function firstClipSrc(timeline: TimelineState): string {
  for (const track of timeline.tracks) {
    if (track.type !== "video") continue;
    const first = [...track.clips].sort((a, b) => a.startOffset - b.startOffset)[0];
    if (first) return first.src;
  }
  return "";
}

function clipCount(timeline: TimelineState): number {
  return timeline.tracks.reduce((n, t) => n + (t.type === "video" ? t.clips.length : 0), 0);
}

function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

type Item = {
  node: CanvasNode;
  /** Cinema nodes only — the whole timeline, played end to end as one video. */
  timeline: TimelineState | null;
  poster: string;
};

/** Masonry row span. The column has a KNOWN pixel width, so the tile's own
 *  height falls straight out of the node's aspect ratio — no measuring, no
 *  layout pass, no library. ROW/GAP must match --asset-row and the gap in
 *  AssetGrid.css. */
const ROW = 4;
const GAP = 2;

/**
 * Landscape tiles take two columns.
 *
 * A single fixed column width gives every tile the same WIDTH, which means a
 * 9:16 portrait gets ~3x the area of a 16:9 landscape at the same setting —
 * the tall shots dominate the page and the wide ones read as thumbnails.
 * Doubling the width of anything meaningfully landscape evens the areas out at
 * every slider position, since both sides scale with --asset-col.
 *
 * ponytail: 2 columns flat, not area-matched. If the window is narrower than
 * two columns the browser adds an implicit one; at COL_MAX that needs a window
 * under ~950px, which this app does not run in.
 */
const WIDE_RATIO = 1.3;

/**
 * Width / height of the PICTURE, which is not the node's box for every type.
 *
 * A cinema node is 1920x1700 — 1080 of picture plus the toolbar and timeline
 * rows underneath it — so laying its tile out from the node box makes every cut
 * near-square regardless of what it actually contains. The poster video knows
 * its own dimensions, so cinema tiles start at 16:9 and correct themselves the
 * moment `loadedmetadata` fires (preload="metadata" was already fetching it).
 */
const CINEMA_FALLBACK = 16 / 9;

function aspectOf(node: CanvasNode, isCinema: boolean, measured: number | undefined): number {
  if (measured && measured > 0) return measured;
  if (isCinema) return CINEMA_FALLBACK;
  const w = node.width > 0 ? node.width : 1;
  const h = node.height > 0 ? node.height : 1;
  return w / h;
}

function colSpan(aspect: number): number {
  return aspect >= WIDE_RATIO ? 2 : 1;
}

function rowSpan(aspect: number, col: number): number {
  const px = colSpan(aspect) === 2 ? col * 2 + GAP : col;
  return Math.max(1, Math.round((px / aspect + GAP) / (ROW + GAP)));
}

const COL_KEY = "falforge.gridCol";
const COL_MIN = 120;
const COL_MAX = 460;

export function AssetGrid({ nodes, onClose }: { nodes: CanvasNode[]; onClose: () => void }) {
  const [viewing, setViewing] = useState<MediaModalTarget | null>(null);

  // The same actions the canvas mini-menu offers, minus Delete: removing a node
  // means pushing an undo command onto the canvas's own stack, which the grid is
  // rendered above and has no handle on. Delete from the canvas.
  const { downloadNode, saveToLibrary, savePrompt } = useNodeToolbar();
  const actions: NodeActionHandlers = {
    onDownload: (n) => downloadNode(n),
    onSaveToLibrary: (n) => saveToLibrary(n, () => {}),
    onSavePrompt: savePrompt,
    onReusePrompt: (n) => { void navigator.clipboard.writeText(n.label || ""); },
  };
  // Real picture aspect for cinema tiles, learned from the poster video.
  const [ratios, setRatios] = useState<Record<string, number>>({});
  const [col, setCol] = useState(() => {
    const n = Number(localStorage.getItem(COL_KEY));
    return n >= COL_MIN && n <= COL_MAX ? n : 200;
  });

  const items = useMemo<Item[]>(() => {
    return nodes
      .filter((n) => n.visible !== false && ASSET_TYPES.has(n.node_type))
      .map((node) => {
        const timeline = node.node_type === "cinema" ? parseTimelineFromMetadata(node.metadata || {}) : null;
        return { node, timeline, poster: timeline ? firstClipSrc(timeline) : node.src };
      })
      .filter((it) => !!it.poster || it.node.node_type === "audio")
      // Newest first. created_at comes from the server; nodes created in this
      // session haven't been round-tripped yet, so z_index (which increments
      // per placement) is the stand-in until they have.
      .sort((a, b) => {
        const t = (b.node.created_at || "").localeCompare(a.node.created_at || "");
        return t !== 0 ? t : b.node.z_index - a.node.z_index;
      });
  }, [nodes]);

  return (
    <div className="asset-grid">
      <div className="asset-grid__bar">
        <button type="button" className="asset-grid__back" onClick={onClose}>Back to canvas</button>
        <label className="asset-grid__scale">
          <span className="asset-grid__count">{items.length} {items.length === 1 ? "asset" : "assets"}</span>
          <input
            type="range"
            min={COL_MIN}
            max={COL_MAX}
            step={20}
            value={col}
            aria-label="Tile size"
            onChange={(e) => {
              const n = Number(e.target.value);
              setCol(n);
              try { localStorage.setItem(COL_KEY, String(n)); } catch { /* private mode */ }
            }}
          />
        </label>
      </div>

      {items.length === 0 ? (
        <div className="asset-grid__empty">Nothing generated in this project yet.</div>
      ) : (
        <div className="asset-grid__items" style={{ "--asset-col": `${col}px` } as CSSProperties}>
          {items.map(({ node, timeline, poster }) => {
            const isCinema = !!timeline;
            const isVideo = node.node_type === "video";
            const duration = timeline ? getTotalDuration(timeline) : 0;
            const aspect = aspectOf(node, isCinema, ratios[node.id]);
            return (
              <button
                type="button"
                key={node.id}
                className="asset-grid__tile"
                style={{ gridRow: `span ${rowSpan(aspect, col)}`, gridColumn: `span ${colSpan(aspect)}` }}
                onClick={() =>
                  setViewing(
                    timeline
                      ? { kind: "cinema", timeline, label: node.label, node, actions }
                      : { kind: isVideo ? "video" : "image", src: node.src, label: node.label, node, actions },
                  )
                }
                // Hover-preview only for plain video; a cinema tile would need
                // to switch sources mid-hover, which is what the modal is for.
                onMouseEnter={(e) => { if (isVideo) (e.currentTarget.querySelector("video") as HTMLVideoElement | null)?.play().catch(() => {}); }}
                onMouseLeave={(e) => {
                  if (!isVideo) return;
                  const v = e.currentTarget.querySelector("video") as HTMLVideoElement | null;
                  if (v) { v.pause(); v.currentTime = 0; }
                }}
              >
                {node.node_type === "audio" ? (
                  <div className="asset-grid__audio">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                      <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
                    </svg>
                  </div>
                ) : isVideo || isCinema ? (
                  <video
                    className="asset-grid__media"
                    src={poster}
                    muted
                    playsInline
                    preload="metadata"
                    onLoadedMetadata={
                      isCinema
                        ? (e) => {
                            const v = e.currentTarget;
                            if (!v.videoWidth || !v.videoHeight) return;
                            const r = v.videoWidth / v.videoHeight;
                            setRatios((prev) => (prev[node.id] === r ? prev : { ...prev, [node.id]: r }));
                          }
                        : undefined
                    }
                  />
                ) : (
                  <img className="asset-grid__media" src={poster} alt={node.label || ""} loading="lazy" />
                )}

                {isCinema && (
                  <span className="asset-grid__badge">
                    {clipCount(timeline)} clips · {fmtDuration(duration)}
                  </span>
                )}
                {isVideo && <span className="asset-grid__badge">Video</span>}
              </button>
            );
          })}
        </div>
      )}

      <MediaModal target={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}
