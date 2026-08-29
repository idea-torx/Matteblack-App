import React, { useState, useCallback, useRef, type MutableRefObject } from "react";
import type { AnchorPoint, PathData } from "../utils/svgPathModel";

type PenPoint = AnchorPoint;

type PenState = {
  anchors: PenPoint[];
  currentPos: { x: number; y: number } | null;
  draggingHandle: boolean;
};

type UsePenDrawParams = {
  viewportRef: MutableRefObject<HTMLDivElement | null>;
  panXRef: MutableRefObject<number>;
  panYRef: MutableRefObject<number>;
  zoomRef: MutableRefObject<number>;
  addNodeAtPositionRef: MutableRefObject<((x: number, y: number, props: Record<string, unknown>) => unknown) | null>;
  onDeselectAllRef: MutableRefObject<(() => void) | undefined>;
};

const CLOSE_THRESHOLD = 10;

export function usePenDraw({
  viewportRef,
  panXRef,
  panYRef,
  zoomRef,
  addNodeAtPositionRef,
  onDeselectAllRef,
}: UsePenDrawParams) {
  const [penState, setPenState] = useState<PenState | null>(null);
  const penStateRef = useRef<PenState | null>(null);
  const isDraggingNewPoint = useRef(false);
  const dragStartClient = useRef({ x: 0, y: 0 });

  const screenToWorld = useCallback((clientX: number, clientY: number) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (clientX - rect.left - panXRef.current) / zoomRef.current,
      y: (clientY - rect.top - panYRef.current) / zoomRef.current,
    };
  }, [viewportRef, panXRef, panYRef, zoomRef]);

  const finalizePath = useCallback((anchors: PenPoint[], closed: boolean) => {
    if (anchors.length < 2) {
      setPenState(null);
      penStateRef.current = null;
      return;
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const a of anchors) {
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

    const normalizedAnchors = anchors.map((a) => ({
      ...a,
      x: a.x - minX,
      y: a.y - minY,
      handleIn: a.handleIn ? { x: a.handleIn.x - minX, y: a.handleIn.y - minY } : undefined,
      handleOut: a.handleOut ? { x: a.handleOut.x - minX, y: a.handleOut.y - minY } : undefined,
    }));

    const pathData: PathData = {
      subPaths: [{ anchors: normalizedAnchors, closed }],
      stroke: "#0077FF",
      strokeWidth: 2,
      fill: closed ? "#0077FF" : "none",
      fillOpacity: closed ? 0.5 : 1,
      strokeOpacity: 1,
    };

    addNodeAtPositionRef.current?.(minX, minY, {
      node_type: "svg",
      width,
      height,
      label: "Pen Path",
      metadata: { pathData },
    });

    setPenState(null);
    penStateRef.current = null;
  }, [addNodeAtPositionRef]);

  const handlePenPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();

    const world = screenToWorld(e.clientX, e.clientY);
    const state = penStateRef.current;

    if (state && state.anchors.length > 0) {
      const first = state.anchors[0];
      const dist = Math.hypot(world.x - first.x, world.y - first.y) * zoomRef.current;
      if (dist < CLOSE_THRESHOLD && state.anchors.length >= 3) {
        finalizePath(state.anchors, true);
        return;
      }
    }

    if (onDeselectAllRef.current) onDeselectAllRef.current();

    const newAnchor: PenPoint = { x: world.x, y: world.y, smooth: false };
    const newAnchors = state ? [...state.anchors, newAnchor] : [newAnchor];
    const newState = { anchors: newAnchors, currentPos: world, draggingHandle: false };
    penStateRef.current = newState;
    setPenState(newState);

    isDraggingNewPoint.current = true;
    dragStartClient.current = { x: e.clientX, y: e.clientY };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [screenToWorld, zoomRef, finalizePath, onDeselectAllRef]);

  const handlePenPointerMove = useCallback((e: React.PointerEvent) => {
    const state = penStateRef.current;
    if (!state) return;

    const world = screenToWorld(e.clientX, e.clientY);

    if (isDraggingNewPoint.current && state.anchors.length > 0) {
      const dist = Math.hypot(e.clientX - dragStartClient.current.x, e.clientY - dragStartClient.current.y);
      if (dist > 3) {
        const lastIdx = state.anchors.length - 1;
        const last = state.anchors[lastIdx];
        const dx = world.x - last.x;
        const dy = world.y - last.y;
        const newAnchors = [...state.anchors];
        newAnchors[lastIdx] = {
          ...last,
          smooth: true,
          handleIn: { x: last.x - dx, y: last.y - dy },
          handleOut: { x: last.x + dx, y: last.y + dy },
        };
        const newState = { anchors: newAnchors, currentPos: world, draggingHandle: true };
        penStateRef.current = newState;
        setPenState(newState);
        return;
      }
    }

    const newState = { ...state, currentPos: world };
    penStateRef.current = newState;
    setPenState(newState);
  }, [screenToWorld]);

  const handlePenPointerUp = useCallback(() => {
    isDraggingNewPoint.current = false;
  }, []);

  const handlePenKeyDown = useCallback((e: KeyboardEvent) => {
    const state = penStateRef.current;
    if (!state) return;
    if (e.key === "Escape" || e.key === "Enter") {
      finalizePath(state.anchors, false);
    }
  }, [finalizePath]);

  return {
    penState,
    handlePenPointerDown,
    handlePenPointerMove,
    handlePenPointerUp,
    handlePenKeyDown,
    setPenState,
  };
}

type PenDrawGhostProps = {
  penState: PenState;
  panX: number;
  panY: number;
  zoom: number;
};

export function PenDrawGhost({ penState, panX, panY, zoom }: PenDrawGhostProps) {
  if (!penState || penState.anchors.length === 0) return null;

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

  const toScreen = (wx: number, wy: number) => ({
    x: wx * zoom + panX,
    y: wy * zoom + panY,
  });

  const pathParts: string[] = [];
  const { anchors, currentPos } = penState;

  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    const s = toScreen(a.x, a.y);
    if (i === 0) {
      pathParts.push(`M${s.x} ${s.y}`);
    } else {
      const prev = anchors[i - 1];
      if (prev.handleOut || a.handleIn) {
        const cp1 = toScreen(prev.handleOut?.x ?? prev.x, prev.handleOut?.y ?? prev.y);
        const cp2 = toScreen(a.handleIn?.x ?? a.x, a.handleIn?.y ?? a.y);
        pathParts.push(`C${cp1.x} ${cp1.y} ${cp2.x} ${cp2.y} ${s.x} ${s.y}`);
      } else {
        pathParts.push(`L${s.x} ${s.y}`);
      }
    }
  }

  if (currentPos && anchors.length > 0) {
    const last = anchors[anchors.length - 1];
    const cs = toScreen(currentPos.x, currentPos.y);
    if (last.handleOut && !penState.draggingHandle) {
      const cp1 = toScreen(last.handleOut.x, last.handleOut.y);
      pathParts.push(`C${cp1.x} ${cp1.y} ${cs.x} ${cs.y} ${cs.x} ${cs.y}`);
    } else if (!penState.draggingHandle) {
      pathParts.push(`L${cs.x} ${cs.y}`);
    }
  }

  return (
    <svg style={svgStyle}>
      <path d={pathParts.join(" ")} fill="none" stroke="#0077FF" strokeWidth={2} strokeDasharray="6 3" />
      {anchors.map((a, i) => {
        const s = toScreen(a.x, a.y);
        return (
          <g key={i}>
            {a.handleIn && (() => {
              const h = toScreen(a.handleIn.x, a.handleIn.y);
              return <>
                <line x1={s.x} y1={s.y} x2={h.x} y2={h.y} stroke="#90CAF9" strokeWidth={1} />
                <circle cx={h.x} cy={h.y} r={5} fill="white" stroke="#2196F3" strokeWidth={1.5} />
              </>;
            })()}
            {a.handleOut && (() => {
              const h = toScreen(a.handleOut.x, a.handleOut.y);
              return <>
                <line x1={s.x} y1={s.y} x2={h.x} y2={h.y} stroke="#90CAF9" strokeWidth={1} />
                <circle cx={h.x} cy={h.y} r={5} fill="white" stroke="#2196F3" strokeWidth={1.5} />
              </>;
            })()}
            <rect
              x={s.x - 5} y={s.y - 5} width={10} height={10}
              fill={i === 0 ? "#2196F3" : "white"} stroke="#2196F3" strokeWidth={1.5}
            />
          </g>
        );
      })}
    </svg>
  );
}
