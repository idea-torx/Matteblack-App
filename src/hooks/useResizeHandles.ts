import { useRef, useState, useCallback, type MutableRefObject } from "react";
import type { CanvasNode, UndoCommand } from "../types/canvas";
import { MIN_NODE_SIZE } from "../types/canvas";
import { snapToGrid } from "../utils/canvasUtils";
import type { ResizeSnapResult } from "./canvas/useSmartGuides";
import { scalePathData } from "../utils/svgPathModel";
import type { PathData } from "../utils/svgPathModel";

export type ResizeHandle = "nw" | "ne" | "sw" | "se" | "n" | "s" | "w" | "e";

type ResizeState = {
  nodeId: string;
  handle: ResizeHandle;
  startX: number;
  startY: number;
  origX: number;
  origY: number;
  origW: number;
  origH: number;
};

type UseResizeHandlesParams = {
  zoom: number;
  nodes: CanvasNode[];
  nodesRef?: MutableRefObject<CanvasNode[]>;
  setNodes: React.Dispatch<React.SetStateAction<CanvasNode[]>>;
  snapEnabled: boolean;
  gridSize: number;
  pushUndo: (cmd: UndoCommand) => void;
  canvasId: string | null;
  saveNodesBatchDebounced: (canvasId: string, updates: { id: string; [key: string]: unknown }[]) => void;
  computeResizeSnap?: (
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
  clearSmartGuides?: () => void;
  panX: number;
  panY: number;
  viewportSize: { w: number; h: number };
};

export function useResizeHandles({
  zoom,
  nodes,
  nodesRef: externalNodesRef,
  setNodes,
  snapEnabled,
  gridSize,
  pushUndo,
  canvasId,
  saveNodesBatchDebounced,
  computeResizeSnap,
  clearSmartGuides,
  panX,
  panY,
  viewportSize,
}: UseResizeHandlesParams) {
  const [isResizing, setIsResizing] = useState(false);
  const resizeState = useRef<ResizeState | null>(null);
  const internalNodesRef = useRef(nodes);
  internalNodesRef.current = nodes;
  const _nodesRef = externalNodesRef ?? internalNodesRef;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const snapEnabledRef = useRef(snapEnabled);
  snapEnabledRef.current = snapEnabled;
  const gridSizeRef = useRef(gridSize);
  gridSizeRef.current = gridSize;
  const canvasIdRef = useRef(canvasId);
  canvasIdRef.current = canvasId;
  const computeResizeSnapRef = useRef(computeResizeSnap);
  computeResizeSnapRef.current = computeResizeSnap;
  const clearSmartGuidesRef = useRef(clearSmartGuides);
  clearSmartGuidesRef.current = clearSmartGuides;
  const panXRef = useRef(panX);
  panXRef.current = panX;
  const panYRef = useRef(panY);
  panYRef.current = panY;
  const viewportSizeRef = useRef(viewportSize);
  viewportSizeRef.current = viewportSize;

  const handleResizePointerDown = useCallback(
    (e: React.PointerEvent, nodeId: string, handle: ResizeHandle) => {
      if (e.button === 1) return;
      e.stopPropagation();
      e.preventDefault();
      const node = _nodesRef.current.find((n) => n.id === nodeId);
      if (!node || node.locked) return;

      setIsResizing(true);
      resizeState.current = {
        nodeId,
        handle,
        startX: e.clientX,
        startY: e.clientY,
        origX: node.x,
        origY: node.y,
        origW: node.width,
        origH: node.height,
      };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [_nodesRef]
  );

  const handleResizePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isResizing || !resizeState.current) return;
      const rs = resizeState.current;
      const dx = (e.clientX - rs.startX) / zoomRef.current;
      const dy = (e.clientY - rs.startY) / zoomRef.current;
      const h = rs.handle;
      const isCorner = ["nw", "ne", "sw", "se"].includes(h);
      const shiftHeld = e.shiftKey;

      let newX = rs.origX;
      let newY = rs.origY;
      let newW = rs.origW;
      let newH = rs.origH;

      if (h.includes("e")) newW = Math.max(MIN_NODE_SIZE, rs.origW + dx);
      if (h.includes("w")) {
        newW = Math.max(MIN_NODE_SIZE, rs.origW - dx);
        newX = rs.origX + rs.origW - newW;
      }
      if (h.includes("s")) newH = Math.max(MIN_NODE_SIZE, rs.origH + dy);
      if (h.includes("n")) {
        newH = Math.max(MIN_NODE_SIZE, rs.origH - dy);
        newY = rs.origY + rs.origH - newH;
      }

      if (shiftHeld) {
        const origAspect = rs.origW / rs.origH;
        if (isCorner) {
          const currentAspect = newW / newH;
          if (currentAspect > origAspect) {
            newH = newW / origAspect;
          } else {
            newW = newH * origAspect;
          }
        } else if (h === "e" || h === "w") {
          newH = newW / origAspect;
        } else if (h === "n" || h === "s") {
          newW = newH * origAspect;
        }
        if (h.includes("n")) newY = rs.origY + rs.origH - newH;
        if (h.includes("w")) newX = rs.origX + rs.origW - newW;
      }

      if (snapEnabledRef.current) {
        const gs = gridSizeRef.current;
        newX = snapToGrid(newX, gs);
        newY = snapToGrid(newY, gs);
        newW = snapToGrid(newW, gs) || gs;
        newH = snapToGrid(newH, gs) || gs;
      }

      if (!snapEnabledRef.current && computeResizeSnapRef.current) {
        const vp = viewportSizeRef.current;
        const snapped = computeResizeSnapRef.current(
          _nodesRef.current,
          rs.nodeId,
          newX,
          newY,
          newW,
          newH,
          rs.handle,
          zoomRef.current,
          panXRef.current,
          panYRef.current,
          vp.w,
          vp.h,
        );
        if (snapped.newW >= MIN_NODE_SIZE) {
          newX = snapped.newX;
          newW = snapped.newW;
        }
        if (snapped.newH >= MIN_NODE_SIZE) {
          newY = snapped.newY;
          newH = snapped.newH;
        }
      }

      setNodes((prev) =>
        prev.map((n) =>
          n.id === rs.nodeId
            ? { ...n, x: newX, y: newY, width: newW, height: newH }
            : n
        )
      );
    },
    [isResizing, _nodesRef, setNodes]
  );

  const handleResizePointerUp = useCallback(() => {
    if (isResizing && resizeState.current) {
      const rs = resizeState.current;
      const nodeId = rs.nodeId;
      const node = _nodesRef.current.find((n) => n.id === nodeId);
      if (node) {
        const priorMetadata = {
          ...(node.metadata || {}),
          originalWidth: rs.origW,
          originalHeight: rs.origH,
        };
        const origState = {
          x: rs.origX,
          y: rs.origY,
          width: rs.origW,
          height: rs.origH,
          metadata: priorMetadata,
        };
        const updatedMetadata: Record<string, unknown> = {
          ...(node.metadata || {}),
          originalWidth: node.width,
          originalHeight: node.height,
        };
        if (node.node_type === "frame") {
          updatedMetadata.nativeWidth = node.width;
          updatedMetadata.nativeHeight = node.height;
        }
        if (node.node_type === "svg" && updatedMetadata.pathData) {
          const pd = updatedMetadata.pathData as PathData;
          const sx = node.width / rs.origW;
          const sy = node.height / rs.origH;
          if (sx !== 1 || sy !== 1) {
            updatedMetadata.pathData = scalePathData(pd, sx, sy);
          }
        }
        const newState = {
          x: node.x,
          y: node.y,
          width: node.width,
          height: node.height,
          metadata: updatedMetadata,
        };
        setNodes((prev) =>
          prev.map((n) =>
            n.id === nodeId ? { ...n, metadata: updatedMetadata } : n
          )
        );
        pushUndo({
          type: "resize",
          undo: () =>
            setNodes((prev) =>
              prev.map((n) =>
                n.id === nodeId ? { ...n, ...origState } : n
              )
            ),
          redo: () =>
            setNodes((prev) =>
              prev.map((n) =>
                n.id === nodeId ? { ...n, ...newState } : n
              )
            ),
        });
        const cid = canvasIdRef.current;
        if (cid) {
          saveNodesBatchDebounced(cid, [
            {
              id: node.id,
              x: node.x,
              y: node.y,
              width: node.width,
              height: node.height,
              metadata: updatedMetadata,
            },
          ]);
        }
      }
    }
    clearSmartGuidesRef.current?.();
    setIsResizing(false);
    resizeState.current = null;
  }, [isResizing, _nodesRef, saveNodesBatchDebounced, pushUndo, setNodes]);

  return {
    isResizing,
    handleResizePointerDown,
    handleResizePointerMove,
    handleResizePointerUp,
  };
}
