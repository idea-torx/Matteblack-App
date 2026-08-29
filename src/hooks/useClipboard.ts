import { useRef, useCallback, useEffect } from "react";
import type { CanvasNode } from "../types/canvas";

type UseClipboardParams = {
  nodes: CanvasNode[];
  selectedIds: Set<string>;
  addNodeAtPosition: (x: number, y: number, props: Partial<CanvasNode>) => CanvasNode;
  onSelectMultiple?: (ids: string[], mode?: "exclusive" | "add") => void;
  onDeselectAll?: () => void;
};

const PASTE_OFFSET = 30;

export function useClipboard({
  nodes,
  selectedIds,
  addNodeAtPosition,
  onSelectMultiple,
  onDeselectAll,
}: UseClipboardParams) {
  const clipboardRef = useRef<CanvasNode[]>([]);
  const pasteCountRef = useRef(0);
  const pendingSelectRef = useRef<string[] | null>(null);

  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  const onSelectMultipleRef = useRef(onSelectMultiple);
  onSelectMultipleRef.current = onSelectMultiple;
  const onDeselectAllRef = useRef(onDeselectAll);
  onDeselectAllRef.current = onDeselectAll;

  const copyNodes = useCallback((nodesToCopy: CanvasNode[]) => {
    if (nodesToCopy.length === 0) return;
    clipboardRef.current = nodesToCopy.map((n) => ({ ...n }));
    pasteCountRef.current = 0;
  }, []);

  const copySelected = useCallback(() => {
    const selected = nodesRef.current.filter((n) => selectedIdsRef.current.has(n.id));
    copyNodes(selected);
  }, [copyNodes]);

  const pasteNodes = useCallback(() => {
    if (clipboardRef.current.length === 0) return;
    pasteCountRef.current += 1;
    const offset = PASTE_OFFSET * pasteCountRef.current;

    const newIds: string[] = [];
    for (const original of clipboardRef.current) {
      const newNode = addNodeAtPosition(original.x + offset, original.y + offset, {
        node_type: original.node_type,
        width: original.width,
        height: original.height,
        rotation: original.rotation,
        label: original.label,
        src: original.src,
        gradient: original.gradient,
        asset_id: original.asset_id,
        job_id: original.job_id,
        metadata: { ...original.metadata },
      });
      newIds.push(newNode.id);
    }

    if (newIds.length > 0) {
      pendingSelectRef.current = newIds;
    }
  }, [addNodeAtPosition]);

  const duplicateSelected = useCallback(() => {
    const selected = nodesRef.current.filter((n) => selectedIdsRef.current.has(n.id));
    if (selected.length === 0) return;
    copyNodes(selected);
    pasteNodes();
  }, [copyNodes, pasteNodes]);

  const hasCopied = clipboardRef.current.length > 0;

  useEffect(() => {
    if (pendingSelectRef.current) {
      const ids = pendingSelectRef.current;
      const allExist = ids.every((id) => nodesRef.current.some((n) => n.id === id));
      if (allExist) {
        pendingSelectRef.current = null;
        onSelectMultipleRef.current?.(ids, "exclusive");
      }
    }
  }, [nodes]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.target instanceof HTMLElement && e.target.isContentEditable) return;

      if ((e.ctrlKey || e.metaKey) && e.key === "c" && !e.shiftKey) {
        const selected = nodesRef.current.filter((n) => selectedIdsRef.current.has(n.id));
        if (selected.length > 0) {
          e.preventDefault();
          copyNodes(selected);
        }
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key === "v" && !e.shiftKey) {
        if (clipboardRef.current.length > 0) {
          e.preventDefault();
          pasteNodes();
        }
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key === "d" && !e.shiftKey) {
        e.preventDefault();
        const selected = nodesRef.current.filter((n) => selectedIdsRef.current.has(n.id));
        if (selected.length > 0) {
          copyNodes(selected);
          pasteNodes();
        }
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [copyNodes, pasteNodes]);

  return {
    copyNodes,
    copySelected,
    pasteNodes,
    duplicateSelected,
    hasCopied,
    clipboardRef,
  };
}
