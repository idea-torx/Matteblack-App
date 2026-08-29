import { useCallback } from "react";
import type { CanvasNode, UndoCommand } from "../../types/canvas";

type UseLayerOrderParams = {
  nodesRef: React.MutableRefObject<CanvasNode[]>;
  selectedIdsRef: React.MutableRefObject<Set<string>>;
  nodesInFramesRef: React.MutableRefObject<Map<string, string>>;
  setNodes: React.Dispatch<React.SetStateAction<CanvasNode[]>>;
  pushUndo: (cmd: UndoCommand) => void;
  canvasId: string | null;
  saveNodesBatchDebounced: (canvasId: string, updates: { id: string; [key: string]: unknown }[]) => void;
};

function isFrame(node: CanvasNode): boolean {
  return node.node_type === "frame";
}

function reorderMoveUp(sorted: CanvasNode[], selectedIds: Set<string>): CanvasNode[] {
  const result = [...sorted];
  for (let i = result.length - 2; i >= 0; i--) {
    if (selectedIds.has(result[i].id) && !selectedIds.has(result[i + 1].id)) {
      [result[i], result[i + 1]] = [result[i + 1], result[i]];
    }
  }
  return result;
}

function reorderMoveDown(sorted: CanvasNode[], selectedIds: Set<string>): CanvasNode[] {
  const result = [...sorted];
  for (let i = 1; i < result.length; i++) {
    if (selectedIds.has(result[i].id) && !selectedIds.has(result[i - 1].id)) {
      [result[i - 1], result[i]] = [result[i], result[i - 1]];
    }
  }
  return result;
}

function reorderBringToTop(sorted: CanvasNode[], selectedIds: Set<string>): CanvasNode[] {
  const unselected = sorted.filter((n) => !selectedIds.has(n.id));
  const selected = sorted.filter((n) => selectedIds.has(n.id));
  return [...unselected, ...selected];
}

function reorderSendToBottom(sorted: CanvasNode[], selectedIds: Set<string>): CanvasNode[] {
  const unselected = sorted.filter((n) => !selectedIds.has(n.id));
  const selected = sorted.filter((n) => selectedIds.has(n.id));
  return [...selected, ...unselected];
}

export function useLayerOrder({
  nodesRef,
  selectedIdsRef,
  nodesInFramesRef,
  setNodes,
  pushUndo,
  canvasId,
  saveNodesBatchDebounced,
}: UseLayerOrderParams) {

  const persistZChanges = useCallback((changes: Map<string, number>) => {
    if (canvasId) {
      const updates = Array.from(changes.entries()).map(([id, z]) => ({ id, z_index: z }));
      saveNodesBatchDebounced(canvasId, updates);
    }
  }, [canvasId, saveNodesBatchDebounced]);

  const applyReorder = useCallback((
    reorderFn: (sorted: CanvasNode[], selectedIds: Set<string>) => CanvasNode[],
  ) => {
    const selectedIds = selectedIdsRef.current;
    if (selectedIds.size === 0) return;
    const allNodes = nodesRef.current;
    const selected = allNodes.filter((n) => selectedIds.has(n.id));
    if (selected.length === 0) return;

    const changes = new Map<string, number>();
    const prevZ = new Map<string, number>();
    allNodes.forEach((n) => prevZ.set(n.id, n.z_index));

    const nif = nodesInFramesRef.current;

    const frameGroups = new Map<string | null, Set<string>>();
    for (const sel of selected) {
      if (isFrame(sel)) continue;
      const parentFrame = nif.get(sel.id) ?? null;
      if (!frameGroups.has(parentFrame)) frameGroups.set(parentFrame, new Set());
      frameGroups.get(parentFrame)!.add(sel.id);
    }

    for (const [frameId, selInGroup] of frameGroups) {
      const siblings = allNodes.filter((n) => {
        if (isFrame(n) || n.node_type === "group" || n.visible === false) return false;
        const nParent = nif.get(n.id) ?? null;
        return nParent === frameId;
      });
      if (siblings.length <= 1) continue;
      const sorted = [...siblings].sort((a, b) => a.z_index - b.z_index);
      const reordered = reorderFn(sorted, selInGroup);
      const baseZ = sorted[0].z_index;
      reordered.forEach((n, i) => {
        const targetZ = baseZ + i;
        if (n.z_index !== targetZ) {
          changes.set(n.id, targetZ);
        }
      });
    }

    const hasFrames = selected.some(isFrame);
    if (hasFrames) {
      const frameNodes = allNodes.filter(isFrame);
      if (frameNodes.length > 1) {
        const sorted = [...frameNodes].sort((a, b) => a.z_index - b.z_index);
        const reordered = reorderFn(sorted, selectedIds);
        const baseZ = sorted[0].z_index;
        reordered.forEach((n, i) => {
          const targetZ = baseZ + i;
          if (n.z_index !== targetZ) {
            changes.set(n.id, targetZ);
          }
        });
      }
    }

    if (changes.size === 0) return;

    const updatedNodes = allNodes.map((n) => {
      const z = changes.get(n.id);
      return z !== undefined ? { ...n, z_index: z } : n;
    });
    nodesRef.current = updatedNodes;

    setNodes(updatedNodes);

    const undoChanges = new Map<string, number>();
    for (const [id] of changes) {
      const prev = prevZ.get(id);
      if (prev !== undefined) undoChanges.set(id, prev);
    }

    pushUndo({
      type: "layer",
      undo: () => {
        setNodes((prev) => {
          const result = prev.map((n) => {
            const z = undoChanges.get(n.id);
            return z !== undefined ? { ...n, z_index: z } : n;
          });
          nodesRef.current = result;
          return result;
        });
        persistZChanges(undoChanges);
      },
      redo: () => {
        setNodes((prev) => {
          const result = prev.map((n) => {
            const z = changes.get(n.id);
            return z !== undefined ? { ...n, z_index: z } : n;
          });
          nodesRef.current = result;
          return result;
        });
        persistZChanges(changes);
      },
    });

    persistZChanges(changes);
  }, [nodesRef, selectedIdsRef, nodesInFramesRef, setNodes, pushUndo, persistZChanges]);

  const moveUp = useCallback(() => {
    applyReorder(reorderMoveUp);
  }, [applyReorder]);

  const moveDown = useCallback(() => {
    applyReorder(reorderMoveDown);
  }, [applyReorder]);

  const bringToTop = useCallback(() => {
    applyReorder(reorderBringToTop);
  }, [applyReorder]);

  const sendToBottom = useCallback(() => {
    applyReorder(reorderSendToBottom);
  }, [applyReorder]);

  return { moveUp, moveDown, bringToTop, sendToBottom };
}
