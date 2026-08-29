import { useState, useCallback, useRef } from "react";
import type { CanvasNode } from "../../types/canvas";

export interface GuideLine {
  orientation: "horizontal" | "vertical";
  position: number;
  start: number;
  end: number;
  type: "edge" | "center" | "spacing";
}

export interface DistanceLabel {
  x: number;
  y: number;
  distance: number;
  orientation: "horizontal" | "vertical";
}

export interface ResizeSnapResult {
  newX: number;
  newY: number;
  newW: number;
  newH: number;
}

export interface SmartGuidesHook {
  guides: GuideLine[];
  distanceLabels: DistanceLabel[];
  computeSnap: (
    nodes: CanvasNode[],
    draggedIds: Set<string>,
    dx: number,
    dy: number,
    zoom: number,
    panX: number,
    panY: number,
    viewportW: number,
    viewportH: number,
    threshold?: number,
  ) => { snapDx: number; snapDy: number };
  computeResizeSnap: (
    nodes: CanvasNode[],
    resizingId: string,
    newX: number,
    newY: number,
    newW: number,
    newH: number,
    handle: string,
    zoom: number,
    panX: number,
    panY: number,
    viewportW: number,
    viewportH: number,
    threshold?: number,
  ) => ResizeSnapResult;
  clearGuides: () => void;
}

interface NodeBounds {
  id: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
  cx: number;
  cy: number;
}

function getBounds(n: CanvasNode): NodeBounds {
  return {
    id: n.id,
    left: n.x,
    right: n.x + n.width,
    top: n.y,
    bottom: n.y + n.height,
    cx: n.x + n.width / 2,
    cy: n.y + n.height / 2,
  };
}

function getDraggedBounds(
  nodes: CanvasNode[],
  draggedIds: Set<string>,
  dx: number,
  dy: number,
): NodeBounds {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const n of nodes) {
    if (!draggedIds.has(n.id)) continue;
    left = Math.min(left, n.x + dx);
    top = Math.min(top, n.y + dy);
    right = Math.max(right, n.x + n.width + dx);
    bottom = Math.max(bottom, n.y + n.height + dy);
  }
  return {
    id: "__dragged__",
    left,
    right,
    top,
    bottom,
    cx: (left + right) / 2,
    cy: (top + bottom) / 2,
  };
}

const NEARBY_MARGIN = 1500;

function prefilterNearby(
  allBounds: NodeBounds[],
  dragged: NodeBounds,
): NodeBounds[] {
  const expandedLeft = dragged.left - NEARBY_MARGIN;
  const expandedRight = dragged.right + NEARBY_MARGIN;
  const expandedTop = dragged.top - NEARBY_MARGIN;
  const expandedBottom = dragged.bottom + NEARBY_MARGIN;
  const result: NodeBounds[] = [];
  for (const b of allBounds) {
    if (
      b.right >= expandedLeft &&
      b.left <= expandedRight &&
      b.bottom >= expandedTop &&
      b.top <= expandedBottom
    ) {
      result.push(b);
    }
  }
  return result;
}

const GAP_LABEL_MAX = 500;

function computeSmartGuidesInternal(
  nodes: CanvasNode[],
  draggedIds: Set<string>,
  dx: number,
  dy: number,
  threshold: number,
  viewportExtent: { minX: number; minY: number; maxX: number; maxY: number },
): { guides: GuideLine[]; distanceLabels: DistanceLabel[]; snapDx: number; snapDy: number } {
  if (draggedIds.size === 0) {
    return { guides: [], distanceLabels: [], snapDx: dx, snapDy: dy };
  }

  const dragged = getDraggedBounds(nodes, draggedIds, dx, dy);
  const otherBounds: NodeBounds[] = [];
  for (const n of nodes) {
    if (draggedIds.has(n.id)) continue;
    if (n.node_type === "group") continue;
    otherBounds.push(getBounds(n));
  }

  if (otherBounds.length === 0) {
    return { guides: [], distanceLabels: [], snapDx: dx, snapDy: dy };
  }

  const nearby = prefilterNearby(otherBounds, dragged);
  if (nearby.length === 0) {
    return { guides: [], distanceLabels: [], snapDx: dx, snapDy: dy };
  }

  const guides: GuideLine[] = [];
  const distanceLabels: DistanceLabel[] = [];
  let bestSnapX: number | null = null;
  let bestSnapXDist = Infinity;
  let bestSnapY: number | null = null;
  let bestSnapYDist = Infinity;

  const dragXPoints = [dragged.left, dragged.cx, dragged.right];
  const dragYPoints = [dragged.top, dragged.cy, dragged.bottom];

  for (const other of nearby) {
    const otherXPoints = [other.left, other.cx, other.right];
    const otherYPoints = [other.top, other.cy, other.bottom];

    for (const dx_ of dragXPoints) {
      for (const ox of otherXPoints) {
        const dist = Math.abs(dx_ - ox);
        if (dist < threshold) {
          const offset = ox - dx_;
          const absDist = Math.abs(offset);
          if (absDist < bestSnapXDist) {
            bestSnapXDist = absDist;
            bestSnapX = offset;
          }
        }
      }
    }

    for (const dy_ of dragYPoints) {
      for (const oy of otherYPoints) {
        const dist = Math.abs(dy_ - oy);
        if (dist < threshold) {
          const offset = oy - dy_;
          const absDist = Math.abs(offset);
          if (absDist < bestSnapYDist) {
            bestSnapYDist = absDist;
            bestSnapY = offset;
          }
        }
      }
    }
  }

  const distSnap = computeDistributionSnap(dragged, nearby, threshold);
  if (distSnap.snapX !== null) {
    bestSnapX = distSnap.snapX;
    bestSnapXDist = Math.abs(distSnap.snapX);
  }
  if (distSnap.snapY !== null) {
    bestSnapY = distSnap.snapY;
    bestSnapYDist = Math.abs(distSnap.snapY);
  }

  const snapAdjX = bestSnapX !== null ? bestSnapX : 0;
  const snapAdjY = bestSnapY !== null ? bestSnapY : 0;
  const snappedDx = dx + snapAdjX;
  const snappedDy = dy + snapAdjY;

  const snapped = getDraggedBounds(nodes, draggedIds, snappedDx, snappedDy);
  const snappedXPoints = [snapped.left, snapped.cx, snapped.right];
  const snappedYPoints = [snapped.top, snapped.cy, snapped.bottom];

  const vMinX = viewportExtent.minX;
  const vMaxX = viewportExtent.maxX;
  const vMinY = viewportExtent.minY;
  const vMaxY = viewportExtent.maxY;

  const addedV = new Set<number>();
  const addedH = new Set<number>();

  for (const other of nearby) {
    const otherXPoints = [other.left, other.cx, other.right];
    const otherYPoints = [other.top, other.cy, other.bottom];

    for (const sx of snappedXPoints) {
      for (const ox of otherXPoints) {
        if (Math.abs(sx - ox) < 0.5 && !addedV.has(ox)) {
          const isCenter = ox === other.cx && sx === snapped.cx;
          if (!isCenter && (ox === other.cx || sx === snapped.cx)) continue;
          addedV.add(ox);
          guides.push({
            orientation: "vertical",
            position: ox,
            start: vMinY,
            end: vMaxY,
            type: isCenter ? "center" : "edge",
          });
        }
      }
    }

    for (const sy of snappedYPoints) {
      for (const oy of otherYPoints) {
        if (Math.abs(sy - oy) < 0.5 && !addedH.has(oy)) {
          const isCenter = oy === other.cy && sy === snapped.cy;
          if (!isCenter && (oy === other.cy || sy === snapped.cy)) continue;
          addedH.add(oy);
          guides.push({
            orientation: "horizontal",
            position: oy,
            start: vMinX,
            end: vMaxX,
            type: isCenter ? "center" : "edge",
          });
        }
      }
    }
  }

  let closestLeft: { other: NodeBounds; gap: number } | null = null;
  let closestRight: { other: NodeBounds; gap: number } | null = null;
  let closestAbove: { other: NodeBounds; gap: number } | null = null;
  let closestBelow: { other: NodeBounds; gap: number } | null = null;

  for (const other of nearby) {
    const hGap = computeHorizontalGap(snapped, other);
    if (hGap !== null && hGap > 0 && hGap < GAP_LABEL_MAX) {
      const overlapTop = Math.max(snapped.top, other.top);
      const overlapBottom = Math.min(snapped.bottom, other.bottom);
      if (overlapBottom > overlapTop) {
        if (other.right <= snapped.left) {
          if (!closestLeft || hGap < closestLeft.gap) closestLeft = { other, gap: hGap };
        } else {
          if (!closestRight || hGap < closestRight.gap) closestRight = { other, gap: hGap };
        }
      }
    }

    const vGap = computeVerticalGap(snapped, other);
    if (vGap !== null && vGap > 0 && vGap < GAP_LABEL_MAX) {
      const overlapLeft = Math.max(snapped.left, other.left);
      const overlapRight = Math.min(snapped.right, other.right);
      if (overlapRight > overlapLeft) {
        if (other.bottom <= snapped.top) {
          if (!closestAbove || vGap < closestAbove.gap) closestAbove = { other, gap: vGap };
        } else {
          if (!closestBelow || vGap < closestBelow.gap) closestBelow = { other, gap: vGap };
        }
      }
    }
  }

  for (const entry of [closestLeft, closestRight]) {
    if (!entry) continue;
    const { other, gap } = entry;
    const overlapTop = Math.max(snapped.top, other.top);
    const overlapBottom = Math.min(snapped.bottom, other.bottom);
    const midY = (overlapTop + overlapBottom) / 2;
    const midX = snapped.left > other.right
      ? (other.right + snapped.left) / 2
      : (snapped.right + other.left) / 2;
    distanceLabels.push({ x: midX, y: midY, distance: Math.round(gap), orientation: "horizontal" });
  }

  for (const entry of [closestAbove, closestBelow]) {
    if (!entry) continue;
    const { other, gap } = entry;
    const overlapLeft = Math.max(snapped.left, other.left);
    const overlapRight = Math.min(snapped.right, other.right);
    const midX = (overlapLeft + overlapRight) / 2;
    const midY = snapped.top > other.bottom
      ? (other.bottom + snapped.top) / 2
      : (snapped.bottom + other.top) / 2;
    distanceLabels.push({ x: midX, y: midY, distance: Math.round(gap), orientation: "vertical" });
  }

  detectEqualSpacing(snapped, nearby, guides, distanceLabels);

  if (distSnap.matchedHGap !== null && distSnap.hSnapNeighbor) {
    const neighbor = distSnap.hSnapNeighbor;
    const gap = distSnap.matchedHGap;
    const overlapTop = Math.max(snapped.top, neighbor.top);
    const overlapBottom = Math.min(snapped.bottom, neighbor.bottom);
    if (overlapBottom > overlapTop) {
      const midY = (overlapTop + overlapBottom) / 2;
      const midX = snapped.left > neighbor.right
        ? (neighbor.right + snapped.left) / 2
        : (snapped.right + neighbor.left) / 2;
      const alreadyHas = distanceLabels.some(l =>
        Math.abs(l.x - midX) < 2 && Math.abs(l.y - midY) < 2
      );
      if (!alreadyHas) {
        distanceLabels.push({ x: midX, y: midY, distance: Math.round(gap), orientation: "horizontal" });
      }
      guides.push({
        orientation: "horizontal",
        position: midY,
        start: Math.min(snapped.left, neighbor.left),
        end: Math.max(snapped.right, neighbor.right),
        type: "spacing",
      });
    }

    for (const pair of distSnap.hRefPairs) {
      const pOverlapTop = Math.max(pair.a.top, pair.b.top);
      const pOverlapBottom = Math.min(pair.a.bottom, pair.b.bottom);
      if (pOverlapBottom > pOverlapTop) {
        const pMidY = (pOverlapTop + pOverlapBottom) / 2;
        const pMidX = pair.a.right < pair.b.left
          ? (pair.a.right + pair.b.left) / 2
          : (pair.b.right + pair.a.left) / 2;
        distanceLabels.push({ x: pMidX, y: pMidY, distance: Math.round(gap), orientation: "horizontal" });
        guides.push({
          orientation: "horizontal",
          position: pMidY,
          start: Math.min(pair.a.left, pair.b.left),
          end: Math.max(pair.a.right, pair.b.right),
          type: "spacing",
        });
      }
    }
  }

  if (distSnap.matchedVGap !== null && distSnap.vSnapNeighbor) {
    const neighbor = distSnap.vSnapNeighbor;
    const gap = distSnap.matchedVGap;
    const overlapLeft = Math.max(snapped.left, neighbor.left);
    const overlapRight = Math.min(snapped.right, neighbor.right);
    if (overlapRight > overlapLeft) {
      const midX = (overlapLeft + overlapRight) / 2;
      const midY = snapped.top > neighbor.bottom
        ? (neighbor.bottom + snapped.top) / 2
        : (snapped.bottom + neighbor.top) / 2;
      const alreadyHas = distanceLabels.some(l =>
        Math.abs(l.x - midX) < 2 && Math.abs(l.y - midY) < 2
      );
      if (!alreadyHas) {
        distanceLabels.push({ x: midX, y: midY, distance: Math.round(gap), orientation: "vertical" });
      }
      guides.push({
        orientation: "vertical",
        position: midX,
        start: Math.min(snapped.top, neighbor.top),
        end: Math.max(snapped.bottom, neighbor.bottom),
        type: "spacing",
      });
    }

    for (const pair of distSnap.vRefPairs) {
      const pOverlapLeft = Math.max(pair.a.left, pair.b.left);
      const pOverlapRight = Math.min(pair.a.right, pair.b.right);
      if (pOverlapRight > pOverlapLeft) {
        const pMidX = (pOverlapLeft + pOverlapRight) / 2;
        const pMidY = pair.a.bottom < pair.b.top
          ? (pair.a.bottom + pair.b.top) / 2
          : (pair.b.bottom + pair.a.top) / 2;
        distanceLabels.push({ x: pMidX, y: pMidY, distance: Math.round(gap), orientation: "vertical" });
        guides.push({
          orientation: "vertical",
          position: pMidX,
          start: Math.min(pair.a.top, pair.b.top),
          end: Math.max(pair.a.bottom, pair.b.bottom),
          type: "spacing",
        });
      }
    }
  }

  return { guides, distanceLabels, snapDx: snappedDx, snapDy: snappedDy };
}

interface DistributionSnapResult {
  snapX: number | null;
  snapY: number | null;
  matchedHGap: number | null;
  matchedVGap: number | null;
  hSnapNeighbor: NodeBounds | null;
  vSnapNeighbor: NodeBounds | null;
  hRefPairs: { a: NodeBounds; b: NodeBounds }[];
  vRefPairs: { a: NodeBounds; b: NodeBounds }[];
}

const DIST_SNAP_THRESHOLD = 12;

function findNeighborGap(
  anchor: NodeBounds,
  side: "left" | "right" | "above" | "below",
  others: NodeBounds[],
): { neighbor: NodeBounds; gap: number } | null {
  let best: NodeBounds | null = null;
  let bestDist = Infinity;

  for (const o of others) {
    if (o.id === anchor.id) continue;

    if (side === "left" || side === "right") {
      const vOverlap = Math.min(anchor.bottom, o.bottom) - Math.max(anchor.top, o.top);
      if (vOverlap <= 0) continue;
      if (side === "left" && o.right <= anchor.left) {
        const d = anchor.left - o.right;
        if (d > 0 && d < bestDist) { bestDist = d; best = o; }
      }
      if (side === "right" && o.left >= anchor.right) {
        const d = o.left - anchor.right;
        if (d > 0 && d < bestDist) { bestDist = d; best = o; }
      }
    } else {
      const hOverlap = Math.min(anchor.right, o.right) - Math.max(anchor.left, o.left);
      if (hOverlap <= 0) continue;
      if (side === "above" && o.bottom <= anchor.top) {
        const d = anchor.top - o.bottom;
        if (d > 0 && d < bestDist) { bestDist = d; best = o; }
      }
      if (side === "below" && o.top >= anchor.bottom) {
        const d = o.top - anchor.bottom;
        if (d > 0 && d < bestDist) { bestDist = d; best = o; }
      }
    }
  }

  return best ? { neighbor: best, gap: bestDist } : null;
}

function computeDistributionSnap(
  dragged: NodeBounds,
  others: NodeBounds[],
  _threshold: number,
): DistributionSnapResult {
  let snapX: number | null = null;
  let snapXDist = Infinity;
  let snapY: number | null = null;
  let snapYDist = Infinity;
  let matchedHGap: number | null = null;
  let matchedVGap: number | null = null;
  let hSnapNeighbor: NodeBounds | null = null;
  let vSnapNeighbor: NodeBounds | null = null;
  const hRefPairs: { a: NodeBounds; b: NodeBounds }[] = [];
  const vRefPairs: { a: NodeBounds; b: NodeBounds }[] = [];

  for (const neighbor of others) {
    const vOverlap = Math.min(dragged.bottom, neighbor.bottom) - Math.max(dragged.top, neighbor.top);
    if (vOverlap <= 0) continue;

    if (neighbor.right <= dragged.left) {
      const chainGap = findNeighborGap(neighbor, "left", others);
      if (chainGap) {
        const refGap = chainGap.gap;
        const currentGap = dragged.left - neighbor.right;
        const diff = refGap - currentGap;
        if (Math.abs(diff) < DIST_SNAP_THRESHOLD && Math.abs(diff) < snapXDist) {
          snapXDist = Math.abs(diff);
          snapX = -diff;
          matchedHGap = Math.round(refGap);
          hSnapNeighbor = neighbor;
          hRefPairs.length = 0;
          hRefPairs.push({ a: chainGap.neighbor, b: neighbor });
        }
      }
    }

    if (neighbor.left >= dragged.right) {
      const chainGap = findNeighborGap(neighbor, "right", others);
      if (chainGap) {
        const refGap = chainGap.gap;
        const currentGap = neighbor.left - dragged.right;
        const diff = refGap - currentGap;
        if (Math.abs(diff) < DIST_SNAP_THRESHOLD && Math.abs(diff) < snapXDist) {
          snapXDist = Math.abs(diff);
          snapX = diff;
          matchedHGap = Math.round(refGap);
          hSnapNeighbor = neighbor;
          hRefPairs.length = 0;
          hRefPairs.push({ a: neighbor, b: chainGap.neighbor });
        }
      }
    }
  }

  for (const neighbor of others) {
    const hOverlap = Math.min(dragged.right, neighbor.right) - Math.max(dragged.left, neighbor.left);
    if (hOverlap <= 0) continue;

    if (neighbor.bottom <= dragged.top) {
      const chainGap = findNeighborGap(neighbor, "above", others);
      if (chainGap) {
        const refGap = chainGap.gap;
        const currentGap = dragged.top - neighbor.bottom;
        const diff = refGap - currentGap;
        if (Math.abs(diff) < DIST_SNAP_THRESHOLD && Math.abs(diff) < snapYDist) {
          snapYDist = Math.abs(diff);
          snapY = -diff;
          matchedVGap = Math.round(refGap);
          vSnapNeighbor = neighbor;
          vRefPairs.length = 0;
          vRefPairs.push({ a: chainGap.neighbor, b: neighbor });
        }
      }
    }

    if (neighbor.top >= dragged.bottom) {
      const chainGap = findNeighborGap(neighbor, "below", others);
      if (chainGap) {
        const refGap = chainGap.gap;
        const currentGap = neighbor.top - dragged.bottom;
        const diff = refGap - currentGap;
        if (Math.abs(diff) < DIST_SNAP_THRESHOLD && Math.abs(diff) < snapYDist) {
          snapYDist = Math.abs(diff);
          snapY = diff;
          matchedVGap = Math.round(refGap);
          vSnapNeighbor = neighbor;
          vRefPairs.length = 0;
          vRefPairs.push({ a: neighbor, b: chainGap.neighbor });
        }
      }
    }
  }

  return { snapX, snapY, matchedHGap, matchedVGap, hSnapNeighbor, vSnapNeighbor, hRefPairs, vRefPairs };
}

function computeHorizontalGap(a: NodeBounds, b: NodeBounds): number | null {
  if (a.right <= b.left) return b.left - a.right;
  if (b.right <= a.left) return a.left - b.right;
  return null;
}

function computeVerticalGap(a: NodeBounds, b: NodeBounds): number | null {
  if (a.bottom <= b.top) return b.top - a.bottom;
  if (b.bottom <= a.top) return a.top - b.bottom;
  return null;
}

function detectEqualSpacing(
  dragged: NodeBounds,
  others: NodeBounds[],
  guides: GuideLine[],
  distanceLabels: DistanceLabel[],
) {
  const hNeighbors: { left: NodeBounds | null; right: NodeBounds | null } = { left: null, right: null };
  let leftDist = Infinity, rightDist = Infinity;

  for (const o of others) {
    const vOverlap = Math.min(dragged.bottom, o.bottom) - Math.max(dragged.top, o.top);
    if (vOverlap <= 0) continue;

    if (o.right <= dragged.left) {
      const d = dragged.left - o.right;
      if (d < leftDist) { leftDist = d; hNeighbors.left = o; }
    }
    if (o.left >= dragged.right) {
      const d = o.left - dragged.right;
      if (d < rightDist) { rightDist = d; hNeighbors.right = o; }
    }
  }

  if (hNeighbors.left && hNeighbors.right && Math.abs(leftDist - rightDist) < 1.5) {
    const midY = dragged.cy;
    guides.push({
      orientation: "vertical",
      position: hNeighbors.left.right + leftDist / 2,
      start: midY - 20,
      end: midY + 20,
      type: "spacing",
    });
    guides.push({
      orientation: "vertical",
      position: dragged.right + rightDist / 2,
      start: midY - 20,
      end: midY + 20,
      type: "spacing",
    });
    distanceLabels.push({
      x: hNeighbors.left.right + leftDist / 2,
      y: midY,
      distance: Math.round(leftDist),
      orientation: "horizontal",
    });
    distanceLabels.push({
      x: dragged.right + rightDist / 2,
      y: midY,
      distance: Math.round(rightDist),
      orientation: "horizontal",
    });
  }

  const vNeighbors: { above: NodeBounds | null; below: NodeBounds | null } = { above: null, below: null };
  let aboveDist = Infinity, belowDist = Infinity;

  for (const o of others) {
    const hOverlap = Math.min(dragged.right, o.right) - Math.max(dragged.left, o.left);
    if (hOverlap <= 0) continue;

    if (o.bottom <= dragged.top) {
      const d = dragged.top - o.bottom;
      if (d < aboveDist) { aboveDist = d; vNeighbors.above = o; }
    }
    if (o.top >= dragged.bottom) {
      const d = o.top - dragged.bottom;
      if (d < belowDist) { belowDist = d; vNeighbors.below = o; }
    }
  }

  if (vNeighbors.above && vNeighbors.below && Math.abs(aboveDist - belowDist) < 1.5) {
    const midX = dragged.cx;
    guides.push({
      orientation: "horizontal",
      position: vNeighbors.above.bottom + aboveDist / 2,
      start: midX - 20,
      end: midX + 20,
      type: "spacing",
    });
    guides.push({
      orientation: "horizontal",
      position: dragged.bottom + belowDist / 2,
      start: midX - 20,
      end: midX + 20,
      type: "spacing",
    });
    distanceLabels.push({
      x: midX,
      y: vNeighbors.above.bottom + aboveDist / 2,
      distance: Math.round(aboveDist),
      orientation: "vertical",
    });
    distanceLabels.push({
      x: midX,
      y: dragged.bottom + belowDist / 2,
      distance: Math.round(belowDist),
      orientation: "vertical",
    });
  }
}

const DIST_LOCK_BREAKOUT = 20;

interface DistLock {
  axis: "x" | "y";
  lockedDelta: number;
  neighborId: string;
  refGap: number;
}

export function useSmartGuides(): SmartGuidesHook {
  const [guides, setGuides] = useState<GuideLine[]>([]);
  const [distanceLabels, setDistanceLabels] = useState<DistanceLabel[]>([]);
  const guidesRef = useRef<GuideLine[]>([]);
  const labelsRef = useRef<DistanceLabel[]>([]);
  const distLocksRef = useRef<DistLock[]>([]);

  const computeSnap = useCallback((
    nodes: CanvasNode[],
    draggedIds: Set<string>,
    dx: number,
    dy: number,
    zoom: number,
    panX: number,
    panY: number,
    viewportW: number,
    viewportH: number,
    threshold: number = 5,
  ): { snapDx: number; snapDy: number } => {
    const viewportExtent = {
      minX: -panX / zoom,
      minY: -panY / zoom,
      maxX: (-panX + viewportW) / zoom,
      maxY: (-panY + viewportH) / zoom,
    };

    const locks = distLocksRef.current;
    let feedDx = dx;
    let feedDy = dy;
    let xLocked = false;
    let yLocked = false;

    for (const lock of locks) {
      if (lock.axis === "x") {
        if (Math.abs(dx - lock.lockedDelta) < DIST_LOCK_BREAKOUT) {
          feedDx = lock.lockedDelta;
          xLocked = true;
        }
      } else {
        if (Math.abs(dy - lock.lockedDelta) < DIST_LOCK_BREAKOUT) {
          feedDy = lock.lockedDelta;
          yLocked = true;
        }
      }
    }

    const finalResult = computeSmartGuidesInternal(nodes, draggedIds, feedDx, feedDy, threshold, viewportExtent);

    const newLocks: DistLock[] = [];
    const snappedBounds = getDraggedBounds(nodes, draggedIds, finalResult.snapDx, finalResult.snapDy);
    const otherBoundsForLock = nodes
      .filter(n => !draggedIds.has(n.id) && n.node_type !== "group")
      .map(getBounds);
    const distCheck = computeDistributionSnap(snappedBounds, otherBoundsForLock, threshold);

    if (xLocked) {
      if (distCheck.hSnapNeighbor) {
        newLocks.push(locks.find(l => l.axis === "x")!);
      }
    } else if (distCheck.snapX !== null && Math.abs(distCheck.snapX) < 1 && distCheck.hSnapNeighbor) {
      newLocks.push({
        axis: "x",
        lockedDelta: finalResult.snapDx,
        neighborId: distCheck.hSnapNeighbor.id,
        refGap: distCheck.matchedHGap ?? 0,
      });
    }

    if (yLocked) {
      if (distCheck.vSnapNeighbor) {
        newLocks.push(locks.find(l => l.axis === "y")!);
      }
    } else if (distCheck.snapY !== null && Math.abs(distCheck.snapY) < 1 && distCheck.vSnapNeighbor) {
      newLocks.push({
        axis: "y",
        lockedDelta: finalResult.snapDy,
        neighborId: distCheck.vSnapNeighbor.id,
        refGap: distCheck.matchedVGap ?? 0,
      });
    }

    distLocksRef.current = newLocks;

    if (
      finalResult.guides.length !== guidesRef.current.length ||
      finalResult.guides.some((g, i) => {
        const prev = guidesRef.current[i];
        return !prev || g.position !== prev.position || g.orientation !== prev.orientation || g.type !== prev.type;
      })
    ) {
      guidesRef.current = finalResult.guides;
      setGuides(finalResult.guides);
    }

    if (
      finalResult.distanceLabels.length !== labelsRef.current.length ||
      finalResult.distanceLabels.some((l, i) => {
        const prev = labelsRef.current[i];
        return !prev || l.x !== prev.x || l.y !== prev.y || l.distance !== prev.distance;
      })
    ) {
      labelsRef.current = finalResult.distanceLabels;
      setDistanceLabels(finalResult.distanceLabels);
    }

    return { snapDx: finalResult.snapDx, snapDy: finalResult.snapDy };
  }, []);

  const computeResizeSnap = useCallback((
    nodes: CanvasNode[],
    resizingId: string,
    newX: number,
    newY: number,
    newW: number,
    newH: number,
    handle: string,
    zoom: number,
    panX: number,
    panY: number,
    viewportW: number,
    viewportH: number,
    threshold: number = 5,
  ): ResizeSnapResult => {
    const otherBounds: NodeBounds[] = [];
    for (const n of nodes) {
      if (n.id === resizingId) continue;
      if (n.node_type === "group") continue;
      otherBounds.push(getBounds(n));
    }

    if (otherBounds.length === 0) {
      if (guidesRef.current.length > 0) {
        guidesRef.current = [];
        setGuides([]);
      }
      if (labelsRef.current.length > 0) {
        labelsRef.current = [];
        setDistanceLabels([]);
      }
      return { newX, newY, newW, newH };
    }

    const resizing: NodeBounds = {
      id: resizingId,
      left: newX,
      right: newX + newW,
      top: newY,
      bottom: newY + newH,
      cx: newX + newW / 2,
      cy: newY + newH / 2,
    };

    const nearby = prefilterNearby(otherBounds, resizing);
    if (nearby.length === 0) {
      if (guidesRef.current.length > 0) {
        guidesRef.current = [];
        setGuides([]);
      }
      if (labelsRef.current.length > 0) {
        labelsRef.current = [];
        setDistanceLabels([]);
      }
      return { newX, newY, newW, newH };
    }

    const movesLeft = handle.includes("w");
    const movesRight = handle.includes("e");
    const movesTop = handle.includes("n");
    const movesBottom = handle.includes("s");

    const activeXEdges: { value: number; type: "left" | "right" | "cx" }[] = [];
    if (movesLeft) activeXEdges.push({ value: resizing.left, type: "left" });
    if (movesRight) activeXEdges.push({ value: resizing.right, type: "right" });
    activeXEdges.push({ value: resizing.cx, type: "cx" });

    const activeYEdges: { value: number; type: "top" | "bottom" | "cy" }[] = [];
    if (movesTop) activeYEdges.push({ value: resizing.top, type: "top" });
    if (movesBottom) activeYEdges.push({ value: resizing.bottom, type: "bottom" });
    activeYEdges.push({ value: resizing.cy, type: "cy" });

    let bestSnapX: number | null = null;
    let bestSnapXDist = Infinity;
    let bestSnapXType: "left" | "right" | "cx" = "cx";

    let bestSnapY: number | null = null;
    let bestSnapYDist = Infinity;
    let bestSnapYType: "top" | "bottom" | "cy" = "cy";

    for (const other of nearby) {
      const otherXPoints = [other.left, other.cx, other.right];
      const otherYPoints = [other.top, other.cy, other.bottom];

      for (const edge of activeXEdges) {
        for (const ox of otherXPoints) {
          const dist = Math.abs(edge.value - ox);
          if (dist < threshold && dist < bestSnapXDist) {
            bestSnapXDist = dist;
            bestSnapX = ox;
            bestSnapXType = edge.type;
          }
        }
      }

      for (const edge of activeYEdges) {
        for (const oy of otherYPoints) {
          const dist = Math.abs(edge.value - oy);
          if (dist < threshold && dist < bestSnapYDist) {
            bestSnapYDist = dist;
            bestSnapY = oy;
            bestSnapYType = edge.type;
          }
        }
      }
    }

    let sX = newX, sW = newW, sY = newY, sH = newH;

    if (bestSnapX !== null) {
      if (bestSnapXType === "left") {
        const delta = bestSnapX - sX;
        sX += delta;
        sW -= delta;
      } else if (bestSnapXType === "right") {
        sW = bestSnapX - sX;
      } else {
        const currentCx = sX + sW / 2;
        const delta = bestSnapX - currentCx;
        if (movesLeft) {
          sX += delta * 2;
          sW -= delta * 2;
        } else if (movesRight) {
          sW += delta * 2;
        }
      }
    }

    if (bestSnapY !== null) {
      if (bestSnapYType === "top") {
        const delta = bestSnapY - sY;
        sY += delta;
        sH -= delta;
      } else if (bestSnapYType === "bottom") {
        sH = bestSnapY - sY;
      } else {
        const currentCy = sY + sH / 2;
        const delta = bestSnapY - currentCy;
        if (movesTop) {
          sY += delta * 2;
          sH -= delta * 2;
        } else if (movesBottom) {
          sH += delta * 2;
        }
      }
    }

    const snapped: NodeBounds = {
      id: resizingId,
      left: sX,
      right: sX + sW,
      top: sY,
      bottom: sY + sH,
      cx: sX + sW / 2,
      cy: sY + sH / 2,
    };

    const viewportExtent = {
      minX: -panX / zoom,
      minY: -panY / zoom,
      maxX: (-panX + viewportW) / zoom,
      maxY: (-panY + viewportH) / zoom,
    };

    const newGuides: GuideLine[] = [];
    const newLabels: DistanceLabel[] = [];
    const addedV = new Set<number>();
    const addedH = new Set<number>();

    const snappedXPoints = [snapped.left, snapped.cx, snapped.right];
    const snappedYPoints = [snapped.top, snapped.cy, snapped.bottom];

    for (const other of nearby) {
      const otherXPoints = [other.left, other.cx, other.right];
      const otherYPoints = [other.top, other.cy, other.bottom];

      for (const sx of snappedXPoints) {
        for (const ox of otherXPoints) {
          if (Math.abs(sx - ox) < 0.5 && !addedV.has(ox)) {
            const isCenter = ox === other.cx && sx === snapped.cx;
            if (!isCenter && (ox === other.cx || sx === snapped.cx)) continue;
            addedV.add(ox);
            newGuides.push({
              orientation: "vertical",
              position: ox,
              start: viewportExtent.minY,
              end: viewportExtent.maxY,
              type: isCenter ? "center" : "edge",
            });
          }
        }
      }

      for (const sy of snappedYPoints) {
        for (const oy of otherYPoints) {
          if (Math.abs(sy - oy) < 0.5 && !addedH.has(oy)) {
            const isCenter = oy === other.cy && sy === snapped.cy;
            if (!isCenter && (oy === other.cy || sy === snapped.cy)) continue;
            addedH.add(oy);
            newGuides.push({
              orientation: "horizontal",
              position: oy,
              start: viewportExtent.minX,
              end: viewportExtent.maxX,
              type: isCenter ? "center" : "edge",
            });
          }
        }
      }
    }

    let closestLeft: { other: NodeBounds; gap: number } | null = null;
    let closestRight: { other: NodeBounds; gap: number } | null = null;
    let closestAbove: { other: NodeBounds; gap: number } | null = null;
    let closestBelow: { other: NodeBounds; gap: number } | null = null;

    for (const other of nearby) {
      const hGap = computeHorizontalGap(snapped, other);
      if (hGap !== null && hGap > 0 && hGap < GAP_LABEL_MAX) {
        const overlapTop = Math.max(snapped.top, other.top);
        const overlapBottom = Math.min(snapped.bottom, other.bottom);
        if (overlapBottom > overlapTop) {
          if (other.right <= snapped.left) {
            if (!closestLeft || hGap < closestLeft.gap) closestLeft = { other, gap: hGap };
          } else {
            if (!closestRight || hGap < closestRight.gap) closestRight = { other, gap: hGap };
          }
        }
      }

      const vGap = computeVerticalGap(snapped, other);
      if (vGap !== null && vGap > 0 && vGap < GAP_LABEL_MAX) {
        const overlapLeft = Math.max(snapped.left, other.left);
        const overlapRight = Math.min(snapped.right, other.right);
        if (overlapRight > overlapLeft) {
          if (other.bottom <= snapped.top) {
            if (!closestAbove || vGap < closestAbove.gap) closestAbove = { other, gap: vGap };
          } else {
            if (!closestBelow || vGap < closestBelow.gap) closestBelow = { other, gap: vGap };
          }
        }
      }
    }

    for (const entry of [closestLeft, closestRight]) {
      if (!entry) continue;
      const { other, gap } = entry;
      const overlapTop = Math.max(snapped.top, other.top);
      const overlapBottom = Math.min(snapped.bottom, other.bottom);
      const midY = (overlapTop + overlapBottom) / 2;
      const midX = snapped.left > other.right
        ? (other.right + snapped.left) / 2
        : (snapped.right + other.left) / 2;
      newLabels.push({ x: midX, y: midY, distance: Math.round(gap), orientation: "horizontal" });
    }

    for (const entry of [closestAbove, closestBelow]) {
      if (!entry) continue;
      const { other, gap } = entry;
      const overlapLeft = Math.max(snapped.left, other.left);
      const overlapRight = Math.min(snapped.right, other.right);
      const midX = (overlapLeft + overlapRight) / 2;
      const midY = snapped.top > other.bottom
        ? (other.bottom + snapped.top) / 2
        : (snapped.bottom + other.top) / 2;
      newLabels.push({ x: midX, y: midY, distance: Math.round(gap), orientation: "vertical" });
    }

    if (
      newGuides.length !== guidesRef.current.length ||
      newGuides.some((g, i) => {
        const prev = guidesRef.current[i];
        return !prev || g.position !== prev.position || g.orientation !== prev.orientation || g.type !== prev.type;
      })
    ) {
      guidesRef.current = newGuides;
      setGuides(newGuides);
    }

    if (
      newLabels.length !== labelsRef.current.length ||
      newLabels.some((l, i) => {
        const prev = labelsRef.current[i];
        return !prev || l.x !== prev.x || l.y !== prev.y || l.distance !== prev.distance;
      })
    ) {
      labelsRef.current = newLabels;
      setDistanceLabels(newLabels);
    }

    return { newX: sX, newY: sY, newW: sW, newH: sH };
  }, []);

  const clearGuides = useCallback(() => {
    distLocksRef.current = [];
    if (guidesRef.current.length > 0) {
      guidesRef.current = [];
      setGuides([]);
    }
    if (labelsRef.current.length > 0) {
      labelsRef.current = [];
      setDistanceLabels([]);
    }
  }, []);

  return { guides, distanceLabels, computeSnap, computeResizeSnap, clearGuides };
}
