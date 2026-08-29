import { useRef, useState, useCallback, type MutableRefObject } from "react";
import type { CanvasNode, UndoCommand } from "../types/canvas";

type RotateState = {
  nodeId: string;
  centerX: number;
  centerY: number;
  startAngle: number;
  origRotation: number;
};

type UseRotateHandleParams = {
  zoom: number;
  nodes: CanvasNode[];
  nodesRef?: MutableRefObject<CanvasNode[]>;
  setNodes: React.Dispatch<React.SetStateAction<CanvasNode[]>>;
  pushUndo: (cmd: UndoCommand) => void;
  canvasId: string | null;
  saveNodesBatchDebounced: (canvasId: string, updates: { id: string; [key: string]: unknown }[]) => void;
};

export function useRotateHandle({
  zoom,
  nodes,
  nodesRef: externalNodesRef,
  setNodes,
  pushUndo,
  canvasId,
  saveNodesBatchDebounced,
}: UseRotateHandleParams) {
  const [isRotating, setIsRotating] = useState(false);
  const rotateState = useRef<RotateState | null>(null);
  const internalNodesRef = useRef(nodes);
  internalNodesRef.current = nodes;
  const _nodesRef = externalNodesRef ?? internalNodesRef;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const canvasIdRef = useRef(canvasId);
  canvasIdRef.current = canvasId;

  const handleRotatePointerDown = useCallback(
    (e: React.PointerEvent, nodeId: string) => {
      if (e.button === 1) return;
      e.stopPropagation();
      e.preventDefault();
      const node = _nodesRef.current.find((n) => n.id === nodeId);
      if (!node || node.locked) return;

      const nodeEl = (e.target as HTMLElement).closest("[data-node-id]") as HTMLElement | null;
      if (!nodeEl) return;
      const rect = nodeEl.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      const startAngle = Math.atan2(e.clientY - centerY, e.clientX - centerX) * (180 / Math.PI);

      setIsRotating(true);
      rotateState.current = {
        nodeId,
        centerX,
        centerY,
        startAngle,
        origRotation: node.rotation || 0,
      };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [_nodesRef]
  );

  const handleRotatePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isRotating || !rotateState.current) return;
      const rs = rotateState.current;

      const currentAngle = Math.atan2(e.clientY - rs.centerY, e.clientX - rs.centerX) * (180 / Math.PI);
      let delta = currentAngle - rs.startAngle;
      let newRotation = rs.origRotation + delta;

      if (e.shiftKey) {
        newRotation = Math.round(newRotation / 15) * 15;
      }

      newRotation = ((newRotation % 360) + 360) % 360;

      setNodes((prev) =>
        prev.map((n) => (n.id === rs.nodeId ? { ...n, rotation: newRotation } : n))
      );
    },
    [isRotating, setNodes]
  );

  const handleRotatePointerUp = useCallback(
    (_e: React.PointerEvent) => {
      if (!isRotating || !rotateState.current) return;
      const rs = rotateState.current;
      const currentNodes = _nodesRef.current;
      const node = currentNodes.find((n) => n.id === rs.nodeId);
      if (!node) {
        setIsRotating(false);
        rotateState.current = null;
        return;
      }

      const newRotation = node.rotation;
      const priorRotation = rs.origRotation;

      if (newRotation !== priorRotation) {
        const nodeId = rs.nodeId;
        pushUndo({
          type: "resize",
          undo() {
            setNodes((prev) =>
              prev.map((n) => n.id === nodeId ? { ...n, rotation: priorRotation } : n)
            );
            const cid = canvasIdRef.current;
            if (cid) saveNodesBatchDebounced(cid, [{ id: nodeId, rotation: priorRotation }]);
          },
          redo() {
            setNodes((prev) =>
              prev.map((n) => n.id === nodeId ? { ...n, rotation: newRotation } : n)
            );
            const cid = canvasIdRef.current;
            if (cid) saveNodesBatchDebounced(cid, [{ id: nodeId, rotation: newRotation }]);
          },
        });

        const cid = canvasIdRef.current;
        if (cid) {
          saveNodesBatchDebounced(cid, [{ id: nodeId, rotation: newRotation }]);
        }
      }

      setIsRotating(false);
      rotateState.current = null;
    },
    [isRotating, _nodesRef, pushUndo, setNodes, saveNodesBatchDebounced]
  );

  return {
    isRotating,
    handleRotatePointerDown,
    handleRotatePointerMove,
    handleRotatePointerUp,
  };
}
