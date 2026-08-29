import React, { useState, useCallback, useRef, type MutableRefObject } from "react";
import type { PathData } from "../utils/svgPathModel";
import { rdpSimplify, fitCubicBezier } from "../utils/svgPathModel";

type Pt = { x: number; y: number };
type FreehandState = {
  points: Pt[];
};

const DEFAULT_STROKE_WIDTH = 20;

// Moving-average smoothing — windowed low-pass on raw pointer samples.
// Endpoints are preserved so the start/end of the stroke don't get pulled
// inward. Run twice for a stronger smoothing effect; cheap and stable.
function smoothPoints(points: Pt[], window = 3, passes = 2): Pt[] {
  if (points.length < 3 || window < 2) return points.slice();
  let pts = points.slice();
  for (let pass = 0; pass < passes; pass++) {
    const out: Pt[] = new Array(pts.length);
    out[0] = pts[0];
    out[pts.length - 1] = pts[pts.length - 1];
    const half = Math.floor(window / 2);
    for (let i = 1; i < pts.length - 1; i++) {
      let sx = 0, sy = 0, n = 0;
      const lo = Math.max(0, i - half);
      const hi = Math.min(pts.length - 1, i + half);
      for (let j = lo; j <= hi; j++) {
        sx += pts[j].x;
        sy += pts[j].y;
        n++;
      }
      out[i] = { x: sx / n, y: sy / n };
    }
    pts = out;
  }
  return pts;
}

type UseFreehandDrawParams = {
  viewportRef: MutableRefObject<HTMLDivElement | null>;
  panXRef: MutableRefObject<number>;
  panYRef: MutableRefObject<number>;
  zoomRef: MutableRefObject<number>;
  addNodeAtPositionRef: MutableRefObject<((x: number, y: number, props: Record<string, unknown>) => unknown) | null>;
  onDeselectAllRef: MutableRefObject<(() => void) | undefined>;
};

export function useFreehandDraw({
  viewportRef,
  panXRef,
  panYRef,
  zoomRef,
  addNodeAtPositionRef,
  onDeselectAllRef,
}: UseFreehandDrawParams) {
  const [freehandState, setFreehandState] = useState<FreehandState | null>(null);
  const freehandRef = useRef<FreehandState | null>(null);

  const screenToWorld = useCallback((clientX: number, clientY: number) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (clientX - rect.left - panXRef.current) / zoomRef.current,
      y: (clientY - rect.top - panYRef.current) / zoomRef.current,
    };
  }, [viewportRef, panXRef, panYRef, zoomRef]);

  const handleFreehandPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();

    if (onDeselectAllRef.current) onDeselectAllRef.current();

    const world = screenToWorld(e.clientX, e.clientY);
    const state: FreehandState = { points: [world] };
    freehandRef.current = state;
    setFreehandState(state);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [screenToWorld, onDeselectAllRef]);

  const handleFreehandPointerMove = useCallback((e: React.PointerEvent) => {
    const state = freehandRef.current;
    if (!state) return;

    const world = screenToWorld(e.clientX, e.clientY);
    const newState = { points: [...state.points, world] };
    freehandRef.current = newState;
    setFreehandState(newState);
  }, [screenToWorld]);

  const handleFreehandPointerUp = useCallback(() => {
    const state = freehandRef.current;
    if (!state || state.points.length < 2) {
      freehandRef.current = null;
      setFreehandState(null);
      return;
    }

    const smoothed = smoothPoints(state.points, 5, 2);
    const simplified = rdpSimplify(smoothed, 1.5);
    if (simplified.length < 2) {
      freehandRef.current = null;
      setFreehandState(null);
      return;
    }

    const subPath = fitCubicBezier(simplified);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const a of subPath.anchors) {
      minX = Math.min(minX, a.x);
      minY = Math.min(minY, a.y);
      maxX = Math.max(maxX, a.x);
      maxY = Math.max(maxY, a.y);
      if (a.handleIn) { minX = Math.min(minX, a.handleIn.x); minY = Math.min(minY, a.handleIn.y); maxX = Math.max(maxX, a.handleIn.x); maxY = Math.max(maxY, a.handleIn.y); }
      if (a.handleOut) { minX = Math.min(minX, a.handleOut.x); minY = Math.min(minY, a.handleOut.y); maxX = Math.max(maxX, a.handleOut.x); maxY = Math.max(maxY, a.handleOut.y); }
    }

    const pad = 2;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const width = Math.max(32, maxX - minX);
    const height = Math.max(32, maxY - minY);

    const normalizedAnchors = subPath.anchors.map((a) => ({
      ...a,
      x: a.x - minX,
      y: a.y - minY,
      handleIn: a.handleIn ? { x: a.handleIn.x - minX, y: a.handleIn.y - minY } : undefined,
      handleOut: a.handleOut ? { x: a.handleOut.x - minX, y: a.handleOut.y - minY } : undefined,
    }));

    const pathData: PathData = {
      subPaths: [{ anchors: normalizedAnchors, closed: false }],
      stroke: "#0077FF",
      strokeWidth: DEFAULT_STROKE_WIDTH,
      fill: "none",
    };

    addNodeAtPositionRef.current?.(minX, minY, {
      node_type: "svg",
      width,
      height,
      label: "Freehand Path",
      metadata: { pathData },
    });

    freehandRef.current = null;
    setFreehandState(null);
  }, [addNodeAtPositionRef]);

  return {
    freehandState,
    handleFreehandPointerDown,
    handleFreehandPointerMove,
    handleFreehandPointerUp,
  };
}

type FreehandDrawGhostProps = {
  freehandState: FreehandState;
  panX: number;
  panY: number;
  zoom: number;
};

export function FreehandDrawGhost({ freehandState, panX, panY, zoom }: FreehandDrawGhostProps) {
  if (!freehandState || freehandState.points.length < 2) return null;

  const svgStyle: React.CSSProperties = {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    pointerEvents: "none",
    overflow: "visible",
    zIndex: 99999,
  };

  const pts = freehandState.points;
  const d = pts.map((p, i) => {
    const sx = p.x * zoom + panX;
    const sy = p.y * zoom + panY;
    return i === 0 ? `M${sx} ${sy}` : `L${sx} ${sy}`;
  }).join(" ");

  return (
    <svg style={svgStyle}>
      <path
        d={d}
        fill="none"
        stroke="#0077FF"
        strokeWidth={DEFAULT_STROKE_WIDTH * zoom}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
