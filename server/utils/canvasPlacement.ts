/**
 * Server-side canvas placement — a faithful port of the frontend algorithm
 * (src/utils/canvasPlacement.ts + the row-cursor cascade in src/App.tsx's
 * startGeneration). Operator (MCP) generations are dispatched server-side, so
 * they can't run the frontend placement; this reproduces it so agent-placed
 * nodes land exactly like a normal generation would:
 *
 *   - first generation on an empty canvas → centered on the user's viewport,
 *   - subsequent generations → cascaded to the right of the last one (wrapping
 *     into rows), falling back to a viewport-centered empty-slot search when the
 *     cascade would collide with existing content,
 *   - placeholder sized to the *requested* aspect ratio so the finished image
 *     drops in at true proportions without a resize.
 *
 * Kept dependency-free (plain rects) so it needs no DOM / CanvasNode types.
 */

export type Rect = { x: number; y: number; w: number; h: number };

export type Viewport = { cx: number; cy: number; w: number; h: number };

/** Anchor remembered between placements so the cascade marches predictably. */
export type PlacementAnchor = {
  canvasId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rowAnchorX: number;
};

const GAP = 24;

function rectsOverlap(a: Rect, b: Rect, gap: number): boolean {
  return (
    a.x < b.x + b.w + gap &&
    a.x + a.w + gap > b.x &&
    a.y < b.y + b.h + gap &&
    a.y + a.h + gap > b.y
  );
}

function fitsAt(x: number, y: number, w: number, h: number, occupied: Rect[], gap: number): boolean {
  const test: Rect = { x, y, w, h };
  for (const r of occupied) {
    if (rectsOverlap(test, r, gap)) return false;
  }
  return true;
}

/**
 * Find an empty slot near the viewport centre for a placeholder of `size`,
 * spiralling outward (preferring "below") when the centre is occupied. Mirrors
 * the frontend `findEmptySlots` for a single item.
 */
export function findEmptySlot(viewport: Viewport, size: { w: number; h: number }, occupied: Rect[]): Rect {
  const baseX = viewport.cx - size.w / 2;
  const baseY = viewport.cy - size.h / 2;
  const step = Math.max(80, Math.min(viewport.w, viewport.h) * 0.15);
  const maxRings = 30;

  if (fitsAt(baseX, baseY, size.w, size.h, occupied, GAP)) {
    return { x: baseX, y: baseY, w: size.w, h: size.h };
  }
  for (let ring = 1; ring <= maxRings; ring++) {
    const offsets = [
      { dx: 0, dy: ring * step },
      { dx: ring * step, dy: 0 },
      { dx: -ring * step, dy: 0 },
      { dx: 0, dy: -ring * step },
      { dx: ring * step, dy: ring * step },
      { dx: -ring * step, dy: ring * step },
      { dx: ring * step, dy: -ring * step },
      { dx: -ring * step, dy: -ring * step },
    ];
    for (const off of offsets) {
      const x = baseX + off.dx;
      const y = baseY + off.dy;
      if (fitsAt(x, y, size.w, size.h, occupied, GAP)) return { x, y, w: size.w, h: size.h };
    }
  }

  // Fallback: stack below the viewport, walking down until it clears.
  let cy = viewport.cy + viewport.h * 0.6;
  const cx = viewport.cx - size.w / 2;
  let safety = 200;
  while (safety-- > 0 && !fitsAt(cx, cy, size.w, size.h, occupied, GAP)) cy += step;
  return { x: cx, y: cy, w: size.w, h: size.h };
}

/**
 * Choose where the next placeholder goes. Tries the row-cursor cascade off the
 * remembered anchor first (fast, predictable "next to the last one"), then falls
 * back to the viewport-centred empty-slot search. Returns the chosen rect plus
 * the anchor to remember for the following call.
 */
export function placeNext(opts: {
  canvasId: string;
  viewport: Viewport;
  occupied: Rect[];
  anchor: PlacementAnchor | undefined;
  size: { w: number; h: number };
}): { rect: Rect; nextAnchor: PlacementAnchor } {
  const { canvasId, viewport, occupied, size } = opts;
  const anchor = opts.anchor && opts.anchor.canvasId === canvasId ? opts.anchor : undefined;

  let slot: Rect | null = null;
  if (anchor) {
    const maxRowWidth = Math.max(viewport.w * 0.85, size.w * 4);
    let cx = anchor.x + anchor.w + GAP;
    let cy = anchor.y;
    // Wrap into a new row (aligned under the row's left edge) when we'd run past
    // the viewport-derived row width.
    if (cx + size.w - anchor.rowAnchorX > maxRowWidth) {
      cx = anchor.rowAnchorX;
      cy = anchor.y + anchor.h + GAP;
    }
    if (fitsAt(cx, cy, size.w, size.h, occupied, GAP)) {
      slot = { x: cx, y: cy, w: size.w, h: size.h };
    }
  }

  if (!slot) slot = findEmptySlot(viewport, size, occupied);

  const rowAnchorX = anchor && slot.x >= anchor.rowAnchorX ? anchor.rowAnchorX : slot.x;
  return {
    rect: slot,
    nextAnchor: { canvasId, x: slot.x, y: slot.y, w: slot.w, h: slot.h, rowAnchorX },
  };
}

/**
 * Convert tier / aspect ratio / kind / resolution to a canvas-coordinate
 * placeholder size, so the placeholder occupies the same footprint the final
 * asset will. Identical mapping to the frontend `placeholderSize`.
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

/** Synthesize a reasonable viewport when the frontend hasn't reported one. */
export function fallbackViewport(occupied: Rect[], size: { w: number; h: number }): Viewport {
  if (occupied.length === 0) {
    return { cx: 0, cy: 0, w: Math.max(size.w * 3, 1536), h: Math.max(size.h * 3, 1536) };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of occupied) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return {
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    w: Math.max((maxX - minX) * 1.2, size.w * 3),
    h: Math.max((maxY - minY) * 1.2, size.h * 3),
  };
}
