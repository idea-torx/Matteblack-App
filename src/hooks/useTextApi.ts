import { useCallback, type MutableRefObject } from "react";
import type { CanvasNode, CanvasApi } from "../types/canvas";
import { getDefaultTextColor } from "../theme";

type UseTextApiParams = {
  viewportRef: MutableRefObject<HTMLDivElement | null>;
  nodesRef: MutableRefObject<CanvasNode[]>;
  panXRef: MutableRefObject<number>;
  panYRef: MutableRefObject<number>;
  zoomRef: MutableRefObject<number>;
  addNodeAtPosition: (x: number, y: number, props: Partial<CanvasNode>) => CanvasNode;
};

const DEFAULT_TEXT_META = {
  fontFamily: "Inter, sans-serif",
  fontWeight: 400,
  fontSize: 48,
  color: "#ffffff",
  textAlign: "left" as const,
  textContent: "",
};

export function useTextApi({
  viewportRef,
  nodesRef,
  panXRef,
  panYRef,
  zoomRef,
  addNodeAtPosition,
}: UseTextApiParams) {
  const nextTextName = useCallback(() => {
    const existing = nodesRef.current.filter((n) => n.node_type === "text");
    const nums = existing
      .map((n) => n.label?.match(/^Text (\d+)$/)?.[1])
      .filter(Boolean)
      .map(Number);
    const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
    return `Text ${next}`;
  }, [nodesRef]);

  const addText = useCallback((width: number, height: number) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = (rect.width / 2 - panXRef.current) / zoomRef.current;
    const cy = (rect.height / 2 - panYRef.current) / zoomRef.current;
    return addNodeAtPosition(cx - width / 2, cy - height / 2, {
      node_type: "text",
      width,
      height,
      label: nextTextName(),
      metadata: { ...DEFAULT_TEXT_META, color: getDefaultTextColor() },
    });
  }, [viewportRef, panXRef, panYRef, zoomRef, addNodeAtPosition, nextTextName]);

  const addTextAtPosition = useCallback((x: number, y: number, width: number, height: number) => {
    return addNodeAtPosition(x, y, {
      node_type: "text",
      width,
      height,
      label: nextTextName(),
      metadata: { ...DEFAULT_TEXT_META, color: getDefaultTextColor() },
    });
  }, [addNodeAtPosition, nextTextName]);

  return { addText, addTextAtPosition } as Pick<CanvasApi, "addText" | "addTextAtPosition">;
}
