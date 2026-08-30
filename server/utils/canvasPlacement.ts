/**
 * Server-side canvas placement — a faithful port of the frontend algorithm in
 * src/utils/canvasPlacement.ts. Operator (MCP) generations are dispatched
 * server-side, so they can't run the frontend placement; this reproduces it so
 * agent-placed nodes land exactly like a normal generation would:
 *
 *   - first node on an empty canvas → centered on the user's viewport,
 *   - every one after it → to the right of whatever is furthest right, wrapping
 *     into a new row under the content when the row gets too wide,
 *   - placeholder sized to the *requested* aspect ratio so the finished image
 *     drops in at true proportions without a resize.
 *
 * The two copies are checked against each other in canvasPlacement.test.ts.
 * Kept dependency-free (plain rects) so it needs no DOM / CanvasNode types.
 */

export type Rect = { x: number; y: number; w: number; h: number };

export type Viewport = { cx: number; cy: number; w: number; h: number };

export const GAP = 24;

/** ponytail: fixed canvas-unit row width, deliberately not the viewport's —
 *  see the note in the frontend copy. */
function rowMaxWidth(w: number): number {
  return Math.max(w * 6, 8192);
}

function overlaps(a: Rect, b: Rect, gap: number): boolean {
  return (
    a.x < b.x + b.w + gap &&
    a.x + a.w + gap > b.x &&
    a.y < b.y + b.h + gap &&
    a.y + a.h + gap > b.y
  );
}

function anchorOf(occupied: Rect[]): Rect {
  let best = occupied[0];
  for (const r of occupied) {
    const d = (r.x + r.w) - (best.x + best.w);
    if (d > 0 || (d === 0 && r.y > best.y)) best = r;
  }
  return best;
}

function slideRight(x: number, y: number, w: number, h: number, occupied: Rect[]): number {
  let cx = x;
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

/** The rect-only core. Must stay identical to the frontend `layout`. */
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

/** Where the next single placeholder goes. */
export function placeNext(opts: {
  viewport: Viewport;
  occupied: Rect[];
  size: { w: number; h: number };
}): Rect {
  return layout(opts.viewport, [opts.size], opts.occupied)[0];
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

/** Synthesize a reasonable viewport when the frontend hasn't reported one.
 *  Only ever consulted for the very first node on an empty canvas now. */
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
