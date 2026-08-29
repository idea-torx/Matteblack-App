import React, { useState, useCallback, useRef, type MutableRefObject } from "react";

type ShapeDrawState = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
} | null;

type UseShapeDrawParams = {
  viewportRef: MutableRefObject<HTMLDivElement | null>;
  panXRef: MutableRefObject<number>;
  panYRef: MutableRefObject<number>;
  zoomRef: MutableRefObject<number>;
  pendingShapeKindRef: MutableRefObject<string>;
  shapeApiRef: MutableRefObject<{ addShapeAtPosition: (x: number, y: number, w: number, h: number, kind?: string, extraMeta?: Record<string, unknown>) => void } | null>;
  onDesignSubToolChangeRef: MutableRefObject<((tool: "select" | "frame" | "shape" | "text" | "pen" | "draw") => void) | undefined>;
  onDeselectAllRef: MutableRefObject<(() => void) | undefined>;
};

const MIN_SHAPE = 8;

export function useShapeDraw({
  viewportRef,
  panXRef,
  panYRef,
  zoomRef,
  pendingShapeKindRef,
  shapeApiRef,
  onDesignSubToolChangeRef,
  onDeselectAllRef,
}: UseShapeDrawParams) {
  const [shapeDraw, setShapeDraw] = useState<ShapeDrawState>(null);
  const shapeDrawRef = useRef<ShapeDrawState>(null);

  const handleShapeDrawStart = useCallback((e: React.PointerEvent, rect: DOMRect) => {
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const state = { startX: sx, startY: sy, currentX: sx, currentY: sy };
    shapeDrawRef.current = state;
    setShapeDraw(state);
    viewportRef.current?.setPointerCapture(e.pointerId);
    if (onDeselectAllRef.current) onDeselectAllRef.current();
  }, [viewportRef, onDeselectAllRef]);

  const handleShapeDrawMove = useCallback((e: React.PointerEvent, rect: DOMRect) => {
    setShapeDraw((prev) => {
      if (!prev) return null;
      let cx = e.clientX - rect.left;
      let cy = e.clientY - rect.top;
      if (e.shiftKey && pendingShapeKindRef.current === "line") {
        const dx = Math.abs(cx - prev.startX);
        const dy = Math.abs(cy - prev.startY);
        if (dx >= dy) {
          cy = prev.startY;
        } else {
          cx = prev.startX;
        }
      }
      const next = { ...prev, currentX: cx, currentY: cy };
      shapeDrawRef.current = next;
      return next;
    });
  }, [pendingShapeKindRef]);

  const handleShapeDrawEnd = useCallback(() => {
    const prev = shapeDrawRef.current;
    if (!prev) return;
    shapeDrawRef.current = null;
    setShapeDraw(null);

    const panX = panXRef.current;
    const panY = panYRef.current;
    const zoom = zoomRef.current;
    const kind = pendingShapeKindRef.current;

    const left = Math.min(prev.startX, prev.currentX);
    const top = Math.min(prev.startY, prev.currentY);
    const w = Math.abs(prev.currentX - prev.startX);
    const h = Math.abs(prev.currentY - prev.startY);
    const worldX = (left - panX) / zoom;
    const worldY = (top - panY) / zoom;
    const lineDirection = (prev.currentX >= prev.startX) === (prev.currentY >= prev.startY) ? "down" : "up";
    const extraMeta = kind === "line" ? { lineDirection } : undefined;

    if (kind === "line") {
      const dragDist = Math.hypot(w, h) / zoom;
      if (dragDist >= MIN_SHAPE) {
        const worldW = Math.max(2, Math.round(w / zoom));
        const worldH = Math.max(2, Math.round(h / zoom));
        shapeApiRef.current?.addShapeAtPosition(worldX, worldY, worldW, worldH, kind, extraMeta);
      } else {
        shapeApiRef.current?.addShapeAtPosition(
          (prev.startX - panX) / zoom - 50,
          (prev.startY - panY) / zoom,
          100, 2, kind, { lineDirection: "down" }
        );
      }
    } else {
      const worldW = Math.max(32, Math.round(w / zoom));
      const worldH = Math.max(32, Math.round(h / zoom));
      if (w / zoom >= MIN_SHAPE && h / zoom >= MIN_SHAPE) {
        shapeApiRef.current?.addShapeAtPosition(worldX, worldY, worldW, worldH, kind);
      } else {
        shapeApiRef.current?.addShapeAtPosition(
          (left - panX) / zoom - 50,
          (top - panY) / zoom - 50,
          100, 100, kind
        );
      }
    }

    if (onDeselectAllRef.current) onDeselectAllRef.current();
    if (onDesignSubToolChangeRef.current) onDesignSubToolChangeRef.current("select");
  }, [panXRef, panYRef, zoomRef, pendingShapeKindRef, shapeApiRef, onDesignSubToolChangeRef, onDeselectAllRef]);

  return {
    shapeDraw,
    setShapeDraw,
    handleShapeDrawStart,
    handleShapeDrawMove,
    handleShapeDrawEnd,
  };
}

const GHOST_STROKE = "#5b5fc7";
const GHOST_STROKE_WIDTH = 2;
const GHOST_DASH = "6 3";
const GHOST_FILL = "rgba(91, 95, 199, 0.1)";

type ShapeDrawGhostProps = {
  shapeDraw: NonNullable<ShapeDrawState>;
  shapeKind: string;
};

export function ShapeDrawGhost({ shapeDraw, shapeKind }: ShapeDrawGhostProps) {
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

  if (shapeKind === "line") {
    return (
      <svg style={svgStyle}>
        <line
          x1={shapeDraw.startX}
          y1={shapeDraw.startY}
          x2={shapeDraw.currentX}
          y2={shapeDraw.currentY}
          stroke={GHOST_STROKE}
          strokeWidth={GHOST_STROKE_WIDTH}
          strokeDasharray={GHOST_DASH}
        />
      </svg>
    );
  }

  const left = Math.min(shapeDraw.startX, shapeDraw.currentX);
  const top = Math.min(shapeDraw.startY, shapeDraw.currentY);
  const w = Math.abs(shapeDraw.currentX - shapeDraw.startX);
  const h = Math.abs(shapeDraw.currentY - shapeDraw.startY);

  let shapeElement: React.ReactNode;

  if (shapeKind === "ellipse") {
    shapeElement = (
      <ellipse
        cx={left + w / 2}
        cy={top + h / 2}
        rx={w / 2}
        ry={h / 2}
        fill={GHOST_FILL}
        stroke={GHOST_STROKE}
        strokeWidth={GHOST_STROKE_WIDTH}
        strokeDasharray={GHOST_DASH}
      />
    );
  } else if (shapeKind === "triangle") {
    const pts = `${left + w / 2},${top} ${left + w},${top + h} ${left},${top + h}`;
    shapeElement = (
      <polygon
        points={pts}
        fill={GHOST_FILL}
        stroke={GHOST_STROKE}
        strokeWidth={GHOST_STROKE_WIDTH}
        strokeDasharray={GHOST_DASH}
      />
    );
  } else if (shapeKind === "diamond") {
    const pts = `${left + w / 2},${top} ${left + w},${top + h / 2} ${left + w / 2},${top + h} ${left},${top + h / 2}`;
    shapeElement = (
      <polygon
        points={pts}
        fill={GHOST_FILL}
        stroke={GHOST_STROKE}
        strokeWidth={GHOST_STROKE_WIDTH}
        strokeDasharray={GHOST_DASH}
      />
    );
  } else {
    shapeElement = (
      <rect
        x={left}
        y={top}
        width={w}
        height={h}
        rx={4}
        ry={4}
        fill={GHOST_FILL}
        stroke={GHOST_STROKE}
        strokeWidth={GHOST_STROKE_WIDTH}
        strokeDasharray={GHOST_DASH}
      />
    );
  }

  return <svg style={svgStyle}>{shapeElement}</svg>;
}
