import type { CanvasNode } from "../types/canvas";

export type Rect = { x: number; y: number; w: number; h: number };

export type Viewport = {
  cx: number;
  cy: number;
  w: number;
  h: number;
};

export const GAP = 24;

/**
 * ponytail: rows wrap on a fixed canvas-unit width, not the viewport's. Row
 * width used to be `viewport.w * 0.85`, which meant the same canvas wrapped
 * after two items zoomed in and after twelve zoomed out — the single biggest
 * source of "placement is random". Six items across is a screenful at a normal
 * working zoom; make it a per-canvas setting if anyone wants tighter columns.
 */
function rowMaxWidth(w: number): number {
  return Math.max(w * 6, 8192);
}

/**
 * Compute axis-aligned rectangles for an array of existing nodes (excluding
 * frames so placeholders can land inside frames if needed).
 */
function nodesToRects(nodes: CanvasNode[], excludeIds?: Set<string>): Rect[] {
  const out: Rect[] = [];
  for (const n of nodes) {
    if (excludeIds && excludeIds.has(n.id)) continue;
    if (n.node_type === "frame" || n.node_type === "group") continue;
    if (!(n.width > 0) || !(n.height > 0)) continue;
    out.push({ x: n.x, y: n.y, w: n.width, h: n.height });
  }
  return out;
}

function overlaps(a: Rect, b: Rect, gap: number): boolean {
  return (
    a.x < b.x + b.w + gap &&
    a.x + a.w + gap > b.x &&
    a.y < b.y + b.h + gap &&
    a.y + a.h + gap > b.y
  );
}

/**
 * The node the next one goes to the right of: the furthest-right edge on the
 * canvas, ties broken downward.
 *
 * Derived from the canvas rather than remembered in a ref, which is the whole
 * point — a remembered anchor is lost on reload, on switching canvases, and
 * between the UI and the agent (they each kept their own), and every one of
 * those losses dropped placement back into a spiral search. The canvas is the
 * one thing all of them can see.
 */
function anchorOf(occupied: Rect[]): Rect {
  let best = occupied[0];
  for (const r of occupied) {
    const d = (r.x + r.w) - (best.x + best.w);
    if (d > 0 || (d === 0 && r.y > best.y)) best = r;
  }
  return best;
}

/**
 * Slide right until nothing is in the way. Always right, never up/left/down:
 * the caller asked for "next to the last one", and a search that is allowed to
 * go backwards is a search whose result nobody can predict.
 */
function slideRight(x: number, y: number, w: number, h: number, occupied: Rect[]): number {
  let cx = x;
  // Each pass jumps clear of the worst collider, so the bound is the number of
  // rects, not a step count.
  for (let pass = 0; pass <= occupied.length; pass++) {
    let moved = false;
    for (const r of occupied) {
      if (overlaps({ x: cx, y, w, h }, r, GAP)) {
        cx = Math.max(cx, r.x + r.w + GAP);
        moved = true;
      }
    }
    if (!moved) return cx;
  }
  return cx;
}

/**
 * Place `sizes.length` placeholders, left to right, starting to the right of
 * whatever is furthest right on the canvas and wrapping into a new row under
 * everything when the row gets too wide. An empty canvas starts at the centre
 * of what the user is looking at; after that the viewport is not consulted, so
 * where a node lands does not depend on pan, zoom, or who asked for it.
 */
export function findEmptySlots(
  viewport: Viewport,
  sizes: { w: number; h: number }[],
  existingNodes: CanvasNode[],
  excludeIds?: Set<string>,
): Rect[] {
  return layout(viewport, sizes, nodesToRects(existingNodes, excludeIds));
}

/** The rect-only core, shared with the server port. Keep the two identical. */
export function layout(viewport: Viewport, sizes: { w: number; h: number }[], occupied: Rect[]): Rect[] {
  if (sizes.length === 0) return [];
  const obstacles = occupied.slice();
  const out: Rect[] = [];

  let cursorX: number;
  let cursorY: number;
  let rowLeft: number;
  if (obstacles.length === 0) {
    cursorX = viewport.cx - sizes[0].w / 2;
    cursorY = viewport.cy - sizes[0].h / 2;
    rowLeft = cursorX;
  } else {
    const anchor = anchorOf(obstacles);
    cursorX = anchor.x + anchor.w + GAP;
    cursorY = anchor.y;
    rowLeft = Math.min(...obstacles.map((r) => r.x));
  }

  for (const s of sizes) {
    // Wrap: back to the left edge of the content, below all of it. Measured
    // fresh each time so a wrap clears items placed earlier in this same call.
    if (out.length > 0 && cursorX + s.w - rowLeft > rowMaxWidth(s.w)) {
      const bottom = Math.max(...obstacles.map((r) => r.y + r.h), cursorY);
      cursorX = rowLeft;
      cursorY = bottom + GAP;
    }
    const x = slideRight(cursorX, cursorY, s.w, s.h, obstacles);
    const rect = { x, y: cursorY, w: s.w, h: s.h };
    out.push(rect);
    obstacles.push(rect);
    cursorX = x + s.w + GAP;
  }
  return out;
}

/**
 * Convert a tier + aspect ratio + kind to a canvas-coordinate placeholder
 * size. The placeholder occupies the same canvas footprint the final asset
 * will render at, so the user sees the true scale from the moment the
 * generation starts.
 *
 * `resolution` (when provided) takes priority over `tier` and maps directly
 * to the long-edge pixel count of the generation ("1k" → 1024, … "4k" →
 * 4096). When omitted we fall back to a tier mapping that matches the
 * defaults used by the generation tiers ("quality" ≈ 2K, "premium" ≈ 3K).
 */
export function placeholderSize(
  tier: "quick" | "quality" | "premium" | undefined,
  aspectRatio: string | undefined,
  kind: "image" | "video" | "music",
  resolution?: string | null,
): { w: number; h: number } {
  let longEdge: number;
  const r = (resolution || "").toLowerCase();
  if (r === "1k") longEdge = 1024;
  else if (r === "2k") longEdge = 2048;
  else if (r === "3k") longEdge = 3072;
  else if (r === "4k") longEdge = 4096;
  else longEdge = tier === "premium" ? 3072 : tier === "quality" ? 2048 : 1024;
  if (kind === "music") return { w: 384, h: 90 };
  const ar = parseAspect(aspectRatio || (kind === "video" ? "16:9" : "1:1"));
  if (ar >= 1) return { w: longEdge, h: Math.round(longEdge / ar) };
  return { w: Math.round(longEdge * ar), h: longEdge };
}

function parseAspect(s: string): number {
  const m = s.match(/^(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)$/);
  if (m) {
    const a = parseFloat(m[1]);
    const b = parseFloat(m[2]);
    if (a > 0 && b > 0) return a / b;
  }
  return 1;
}
