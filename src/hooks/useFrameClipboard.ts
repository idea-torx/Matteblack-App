import { useRef, useCallback, useEffect } from "react";
import type { CanvasNode } from "../types/canvas";

type UseFrameClipboardParams = {
  nodes: CanvasNode[];
  selectedIds: Set<string>;
  nodesInFramesRef: React.RefObject<Map<string, string>>;
  addNodeAtPosition: (x: number, y: number, props: Partial<CanvasNode>) => CanvasNode;
  onSelectMultiple?: (ids: string[], mode?: "exclusive" | "add") => void;
  onDeselectAll?: () => void;
};

const FRAME_GAP = 40;
const NON_FRAME_PASTE_OFFSET = 30;

function getDuplicateFrameLabel(originalLabel: string, allNodes: CanvasNode[]): string {
  const baseLabel = originalLabel.replace(/\(\d+\)$/, "").trimEnd();
  const pattern = new RegExp(`^${baseLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\((\\d+)\\))?$`);
  let maxSuffix = 0;
  for (const n of allNodes) {
    if (n.node_type !== "frame") continue;
    const match = n.label?.match(pattern);
    if (match) {
      const num = match[1] ? parseInt(match[1], 10) : 0;
      if (num > maxSuffix) maxSuffix = num;
    }
  }
  return `${baseLabel}(${maxSuffix + 1})`;
}

function getNodesInFrame(
  frameId: string,
  allNodes: CanvasNode[],
  nodesInFramesMap: Map<string, string>,
): CanvasNode[] {
  const children: CanvasNode[] = [];
  for (const n of allNodes) {
    if (nodesInFramesMap.get(n.id) === frameId) {
      children.push(n);
    }
  }
  return children;
}

function remapMetadataIds(
  metadata: Record<string, unknown>,
  idMap: Map<string, string>,
): Record<string, unknown> {
  const result = { ...metadata };
  if (Array.isArray(result.members)) {
    result.members = (result.members as string[]).map((id) => idMap.get(id) ?? id);
  }
  return result;
}

type ClipboardEntry = {
  frame: CanvasNode;
  children: CanvasNode[];
} | {
  frame: null;
  children: CanvasNode[];
};

const STORE_KEY = "canvasClipboard";
/** ponytail: 2MB cap — nodes are metadata + URLs, not pixels, so this is many
 *  hundreds of them. Past it the copy just isn't persisted and stays in-memory. */
const STORE_MAX = 2_000_000;

function readStore(): ClipboardEntry[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Module-level, not per-mount: the canvas unmounts when you switch projects, so
 * a useRef clipboard emptied itself exactly when you wanted to paste. Backed by
 * localStorage so a copy also survives a reload. Safe across projects because
 * assets are keyed by user, not project — a pasted node's asset_id still
 * resolves in the project you land in.
 */
const clipboardStore: { current: ClipboardEntry[] } = { current: readStore() };

function writeStore(entries: ClipboardEntry[]): void {
  clipboardStore.current = entries;
  try {
    const json = JSON.stringify(entries);
    if (json.length <= STORE_MAX) localStorage.setItem(STORE_KEY, json);
    else localStorage.removeItem(STORE_KEY);
  } catch {
    /* quota or private mode — in-memory copy still works */
  }
}

export function useFrameClipboard({
  nodes,
  selectedIds,
  nodesInFramesRef,
  addNodeAtPosition,
  onSelectMultiple,
  onDeselectAll,
}: UseFrameClipboardParams) {
  const clipboardRef = clipboardStore;
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

    const allNodes = nodesRef.current;
    const entries: ClipboardEntry[] = [];
    const alreadyCopiedIds = new Set<string>();

    const frames = nodesToCopy.filter((n) => n.node_type === "frame");
    const nonFrames = nodesToCopy.filter((n) => n.node_type !== "frame");

    for (const frame of frames) {
      alreadyCopiedIds.add(frame.id);
      const children = getNodesInFrame(frame.id, allNodes, nodesInFramesRef.current);
      children.forEach((c) => alreadyCopiedIds.add(c.id));
      entries.push({
        frame: { ...frame },
        children: children.map((c) => ({ ...c })),
      });
    }

    const remainingNonFrames = nonFrames.filter((n) => !alreadyCopiedIds.has(n.id));
    if (remainingNonFrames.length > 0) {
      entries.push({
        frame: null,
        children: remainingNonFrames.map((n) => ({ ...n })),
      });
    }

    writeStore(entries);
    pasteCountRef.current = 0;
  }, []);

  const copySelected = useCallback(() => {
    const selected = nodesRef.current.filter((n) => selectedIdsRef.current.has(n.id));
    copyNodes(selected);
  }, [copyNodes]);

  const pasteNodes = useCallback(() => {
    if (clipboardRef.current.length === 0) return;
    pasteCountRef.current += 1;
    const pasteCount = pasteCountRef.current;

    const newIds: string[] = [];
    const idMap = new Map<string, string>();

    for (const entry of clipboardRef.current) {
      if (entry.frame) {
        const frame = entry.frame;
        const offsetX = (frame.width + FRAME_GAP) * pasteCount;
        const newFrameX = frame.x + offsetX;
        const newFrameY = frame.y;

        const dupLabel = getDuplicateFrameLabel(frame.label || "Frame", nodesRef.current);
        const newFrame = addNodeAtPosition(newFrameX, newFrameY, {
          node_type: frame.node_type,
          width: frame.width,
          height: frame.height,
          rotation: frame.rotation,
          label: dupLabel,
          src: frame.src,
          gradient: frame.gradient,
          asset_id: frame.asset_id,
          job_id: frame.job_id,
          metadata: { ...frame.metadata },
        });
        idMap.set(frame.id, newFrame.id);
        newIds.push(newFrame.id);

        for (const child of entry.children) {
          const relX = child.x - frame.x;
          const relY = child.y - frame.y;
          const remappedMeta = remapMetadataIds({ ...child.metadata }, idMap);
          const newChild = addNodeAtPosition(newFrameX + relX, newFrameY + relY, {
            node_type: child.node_type,
            width: child.width,
            height: child.height,
            rotation: child.rotation,
            label: child.label,
            src: child.src,
            gradient: child.gradient,
            asset_id: child.asset_id,
            job_id: child.job_id,
            metadata: remappedMeta,
          });
          idMap.set(child.id, newChild.id);
          newIds.push(newChild.id);
        }
      } else {
        const offset = NON_FRAME_PASTE_OFFSET * pasteCount;
        for (const original of entry.children) {
          const remappedMeta = remapMetadataIds({ ...original.metadata }, idMap);
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
            metadata: remappedMeta,
          });
          idMap.set(original.id, newNode.id);
          newIds.push(newNode.id);
        }
      }
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
