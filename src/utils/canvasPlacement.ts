import type { CanvasNode } from "../types/canvas";

export type Rect = { x: number; y: number; w: number; h: number };

export type Viewport = {
  cx: number;
  cy: number;
  w: number;
  h: number;
};

/**
 * Compute axis-aligned rectangles for an array of existing nodes (excluding
 * frames so placeholders can land inside frames if needed).
 */
function nodesToRects(nodes: CanvasNode[], excludeIds?: Set<string>): Rect[] {
  const out: Rect[] = [];
  for (const n of nodes) {
    if (excludeIds && excludeIds.has(n.id)) continue;
    if (n.node_type === "frame" || n.node_type === "group") continue;
    out.push({ x: n.x, y: n.y, w: n.width, h: n.height });
  }
  return out;
}

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
 * Find empty slots near the user's viewport for `count` placeholders of the
 * given size. Lays them out left-to-right first, wrapping into rows. If the
 * preferred area is occupied, expands outward in a spiral-ish pattern until
 * each placeholder finds open space.
 */
export function findEmptySlots(
  viewport: Viewport,
  sizes: { w: number; h: number }[],
  existingNodes: CanvasNode[],
  excludeIds?: Set<string>
): { x: number; y: number; w: number; h: number }[] {
  if (sizes.length === 0) return [];
  const gap = 24;
  const occupied = nodesToRects(existingNodes, excludeIds);
  const placed: Rect[] = [];

  // Lay out as a single row centered on viewport center, then wrap to a new
  // row if the row would exceed viewport width. If the resulting block
  // overlaps existing nodes, push it down (and slightly outward) until it
  // doesn't.
  const maxRowWidth = Math.max(viewport.w * 0.85, sizes[0].w * 2 + gap);
  type Row = { items: { idx: number; w: number; h: number }[]; w: number; h: number };
  const rows: Row[] = [];
  let cur: Row = { items: [], w: 0, h: 0 };
  for (let i = 0; i < sizes.length; i++) {
    const s = sizes[i];
    const itemW = s.w + (cur.items.length > 0 ? gap : 0);
    if (cur.w + itemW > maxRowWidth && cur.items.length > 0) {
      rows.push(cur);
      cur = { items: [], w: 0, h: 0 };
    }
    cur.items.push({ idx: i, w: s.w, h: s.h });
    cur.w += (cur.items.length > 1 ? gap : 0) + s.w;
    cur.h = Math.max(cur.h, s.h);
  }
  if (cur.items.length > 0) rows.push(cur);

  const blockW = Math.max(...rows.map((r) => r.w));
  const blockH = rows.reduce((sum, r, i) => sum + r.h + (i > 0 ? gap : 0), 0);

  // Search positions in expanding rings around the viewport center.
  const baseX = viewport.cx - blockW / 2;
  const baseY = viewport.cy - blockH / 2;
  const step = Math.max(80, Math.min(viewport.w, viewport.h) * 0.15);
  const maxRings = 30;

  const tryPlace = (originX: number, originY: number): { x: number; y: number; w: number; h: number }[] | null => {
    const trial: { x: number; y: number; w: number; h: number }[] = new Array(sizes.length);
    let cy = originY;
    for (const row of rows) {
      let cx = originX + (blockW - row.w) / 2;
      for (const it of row.items) {
        if (!fitsAt(cx, cy, it.w, it.h, occupied, gap)) return null;
        // Also check against already-placed items in this trial.
        let collidesSelf = false;
        for (const p of trial) {
          if (p && rectsOverlap({ x: cx, y: cy, w: it.w, h: it.h }, p, gap)) {
            collidesSelf = true;
            break;
          }
        }
        if (collidesSelf) return null;
        trial[it.idx] = { x: cx, y: cy, w: it.w, h: it.h };
        cx += it.w + gap;
      }
      cy += row.h + gap;
    }
    return trial;
  };

  // Try the base location first.
  let result = tryPlace(baseX, baseY);
  if (result) return result;

  // Spiral outward.
  for (let ring = 1; ring <= maxRings && !result; ring++) {
    const offsets: { dx: number; dy: number }[] = [];
    // Prefer "below" first (less likely to obscure existing context above).
    offsets.push({ dx: 0, dy: ring * step });
    offsets.push({ dx: ring * step, dy: 0 });
    offsets.push({ dx: -ring * step, dy: 0 });
    offsets.push({ dx: 0, dy: -ring * step });
    offsets.push({ dx: ring * step, dy: ring * step });
    offsets.push({ dx: -ring * step, dy: ring * step });
    offsets.push({ dx: ring * step, dy: -ring * step });
    offsets.push({ dx: -ring * step, dy: -ring * step });
    for (const off of offsets) {
      result = tryPlace(baseX + off.dx, baseY + off.dy);
      if (result) break;
    }
  }

  if (result) {
    placed.push(...result);
    return result;
  }

  // Fallback: stack below the viewport, walking each row down further until
  // it clears every existing node so we never visibly overlap.
  const fallback: { x: number; y: number; w: number; h: number }[] = new Array(sizes.length);
  let cy = viewport.cy + viewport.h * 0.6;
  for (const row of rows) {
    let cx = viewport.cx - row.w / 2;
    // Scan down until placing the entire row at this `cy` clears all
    // occupied rects. Cap iterations to avoid infinite loops on pathological
    // inputs.
    let safety = 200;
    while (safety-- > 0) {
      let ok = true;
      let testX = cx;
      for (const it of row.items) {
        if (!fitsAt(testX, cy, it.w, it.h, occupied, gap)) { ok = false; break; }
        testX += it.w + gap;
      }
      if (ok) break;
      cy += step;
    }
    for (const it of row.items) {
      const placedItem = { x: cx, y: cy, w: it.w, h: it.h };
      fallback[it.idx] = placedItem;
      occupied.push(placedItem);
      cx += it.w + gap;
    }
    cy += row.h + gap;
  }
  return fallback;
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
