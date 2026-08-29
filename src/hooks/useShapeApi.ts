import { useCallback, type MutableRefObject } from "react";
import type { CanvasNode, CanvasApi } from "../types/canvas";

type UseShapeApiParams = {
  viewportRef: MutableRefObject<HTMLDivElement | null>;
  nodesRef: MutableRefObject<CanvasNode[]>;
  panXRef: MutableRefObject<number>;
  panYRef: MutableRefObject<number>;
  zoomRef: MutableRefObject<number>;
  addNodeAtPosition: (x: number, y: number, props: Partial<CanvasNode>) => CanvasNode;
};

export function useShapeApi({
  viewportRef,
  nodesRef,
  panXRef,
  panYRef,
  zoomRef,
  addNodeAtPosition,
}: UseShapeApiParams) {
  const nextShapeName = useCallback(() => {
    const existing = nodesRef.current.filter((n) => n.node_type === "shape");
    const nums = existing
      .map((n) => n.label?.match(/^Shape (\d+)$/)?.[1])
      .filter(Boolean)
      .map(Number);
    const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
    return `Shape ${next}`;
  }, [nodesRef]);

  const addShape = useCallback((shapeKind: string, width: number, height: number) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = (rect.width / 2 - panXRef.current) / zoomRef.current;
    const cy = (rect.height / 2 - panYRef.current) / zoomRef.current;
    addNodeAtPosition(cx - width / 2, cy - height / 2, {
      node_type: "shape",
      width,
      height,
      label: nextShapeName(),
      metadata: {
        shapeKind,
        fill: shapeKind === "line" ? "none" : "#5b5fc7",
        stroke: "#ffffff",
        strokeWidth: shapeKind === "line" ? 2 : 0,
        borderRadius: 0,
      },
    });
  }, [viewportRef, panXRef, panYRef, zoomRef, addNodeAtPosition, nextShapeName]);

  const addShapeAtPosition = useCallback((x: number, y: number, width: number, height: number, shapeKind?: string, extraMeta?: Record<string, unknown>) => {
    const kind = shapeKind || "rectangle";
    addNodeAtPosition(x, y, {
      node_type: "shape",
      width,
      height,
      label: nextShapeName(),
      metadata: {
        shapeKind: kind,
        fill: kind === "line" ? "none" : "#5b5fc7",
        stroke: "#ffffff",
        strokeWidth: kind === "line" ? 2 : 0,
        borderRadius: 0,
        ...extraMeta,
      },
    });
  }, [addNodeAtPosition, nextShapeName]);

  return { addShape, addShapeAtPosition } as Pick<CanvasApi, "addShape" | "addShapeAtPosition">;
}
