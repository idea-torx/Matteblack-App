import { useCallback } from "react";
import type { CanvasNode, UndoCommand } from "../../types/canvas";

type AlignEntity = { key: string; x: number; y: number; width: number; height: number; memberIds: string[] };

type UseCanvasLayoutParams = {
  nodesRef: React.MutableRefObject<CanvasNode[]>;
  selectedIdsRef: React.MutableRefObject<Set<string>>;
  setNodes: React.Dispatch<React.SetStateAction<CanvasNode[]>>;
  pushUndo: (cmd: UndoCommand) => void;
  canvasId: string | null;
  saveNodesBatchDebounced: (canvasId: string, updates: { id: string; [key: string]: unknown }[]) => void;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  memberToGroupMap: Map<string, string>;
};

function animateLayoutTransitionDOM(viewportRef: React.RefObject<HTMLDivElement | null>, ids: Set<string>) {
  const el = viewportRef.current;
  if (!el) return;
  const nodeEls = el.querySelectorAll<HTMLElement>(".freeform-canvas__node");
  nodeEls.forEach((nodeEl) => {
    const nodeId = nodeEl.dataset.nodeId;
    if (nodeId && ids.has(nodeId)) {
      nodeEl.classList.add("freeform-canvas__node--animating");
    }
  });
  setTimeout(() => {
    nodeEls.forEach((nodeEl) => {
      nodeEl.classList.remove("freeform-canvas__node--animating");
    });
  }, 220);
}

export function useCanvasLayout({
  nodesRef,
  selectedIdsRef,
  setNodes,
  pushUndo,
  canvasId,
  saveNodesBatchDebounced,
  viewportRef,
  memberToGroupMap,
}: UseCanvasLayoutParams) {

  const animateLayoutTransition = useCallback((ids: Set<string>) => {
    animateLayoutTransitionDOM(viewportRef, ids);
  }, []);

  const resolveAlignEntities = useCallback((): AlignEntity[] => {
    const currentNodes = nodesRef.current;
    const sel = selectedIdsRef.current;
    const entities: AlignEntity[] = [];
    const handledIds = new Set<string>();

    const groupEntities = new Map<string, AlignEntity>();
    for (const n of currentNodes) {
      if (!sel.has(n.id) || n.node_type === "group") continue;
      const gId = memberToGroupMap.get(n.id);
      if (gId && !groupEntities.has(gId)) {
        const gNode = currentNodes.find((g) => g.id === gId);
        if (gNode && Array.isArray(gNode.metadata?.members)) {
          const mids = gNode.metadata.members as string[];
          const members = currentNodes.filter((m) => mids.includes(m.id));
          if (members.length > 0) {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            members.forEach((m) => { minX = Math.min(minX, m.x); minY = Math.min(minY, m.y); maxX = Math.max(maxX, m.x + m.width); maxY = Math.max(maxY, m.y + m.height); });
            groupEntities.set(gId, { key: `group:${gId}`, x: minX, y: minY, width: maxX - minX, height: maxY - minY, memberIds: mids });
            mids.forEach((mid) => handledIds.add(mid));
          }
        }
      }
    }
    groupEntities.forEach((e) => entities.push(e));

    for (const n of currentNodes) {
      if (!sel.has(n.id) || n.node_type === "group" || handledIds.has(n.id)) continue;
      entities.push({ key: n.id, x: n.x, y: n.y, width: n.width, height: n.height, memberIds: [n.id] });
    }
    return entities;
  }, [memberToGroupMap]);

  const alignNodes = useCallback((direction: "left" | "center" | "right" | "top" | "middle" | "bottom") => {
    const entities = resolveAlignEntities();
    if (entities.length < 2) return;

    const allMemberIds = entities.flatMap((e) => e.memberIds);
    const allNodes = nodesRef.current.filter((n) => allMemberIds.includes(n.id));
    const prevPositions = new Map<string, { x: number; y: number }>();
    allNodes.forEach((n) => prevPositions.set(n.id, { x: n.x, y: n.y }));

    const newPositions = new Map<string, { x: number; y: number }>();

    const applyEntityDelta = (entity: AlignEntity, dx: number, dy: number) => {
      const members = nodesRef.current.filter((n) => entity.memberIds.includes(n.id));
      members.forEach((n) => newPositions.set(n.id, { x: n.x + dx, y: n.y + dy }));
    };

    switch (direction) {
      case "left": {
        const minX = Math.min(...entities.map((e) => e.x));
        entities.forEach((e) => applyEntityDelta(e, minX - e.x, 0));
        break;
      }
      case "center": {
        const minX = Math.min(...entities.map((e) => e.x));
        const maxX = Math.max(...entities.map((e) => e.x + e.width));
        const centerX = (minX + maxX) / 2;
        entities.forEach((e) => applyEntityDelta(e, centerX - e.width / 2 - e.x, 0));
        break;
      }
      case "right": {
        const maxX = Math.max(...entities.map((e) => e.x + e.width));
        entities.forEach((e) => applyEntityDelta(e, maxX - e.width - e.x, 0));
        break;
      }
      case "top": {
        const minY = Math.min(...entities.map((e) => e.y));
        entities.forEach((e) => applyEntityDelta(e, 0, minY - e.y));
        break;
      }
      case "middle": {
        const minY = Math.min(...entities.map((e) => e.y));
        const maxY = Math.max(...entities.map((e) => e.y + e.height));
        const centerY = (minY + maxY) / 2;
        entities.forEach((e) => applyEntityDelta(e, 0, centerY - e.height / 2 - e.y));
        break;
      }
      case "bottom": {
        const maxY = Math.max(...entities.map((e) => e.y + e.height));
        entities.forEach((e) => applyEntityDelta(e, 0, maxY - e.height - e.y));
        break;
      }
    }

    const updatedNodes = Array.from(newPositions.entries()).map(([id, pos]) => ({ id, x: pos.x, y: pos.y }));
    const animIds = new Set(allMemberIds);
    animateLayoutTransition(animIds);

    setNodes((prev) => prev.map((n) => {
      const pos = newPositions.get(n.id);
      return pos ? { ...n, x: pos.x, y: pos.y } : n;
    }));

    pushUndo({
      type: "move",
      undo: () => setNodes((prev) => prev.map((n) => { const p = prevPositions.get(n.id); return p ? { ...n, ...p } : n; })),
      redo: () => setNodes((prev) => prev.map((n) => { const p = newPositions.get(n.id); return p ? { ...n, ...p } : n; })),
    });

    if (canvasId) {
      saveNodesBatchDebounced(canvasId, updatedNodes);
    }
  }, [canvasId, saveNodesBatchDebounced, pushUndo, animateLayoutTransition, resolveAlignEntities]);

  const distributeNodes = useCallback((direction: "horizontal" | "vertical") => {
    const entities = resolveAlignEntities();
    if (entities.length < 3) return;

    const allMemberIds = entities.flatMap((e) => e.memberIds);
    const allNodes = nodesRef.current.filter((n) => allMemberIds.includes(n.id));
    const prevPositions = new Map<string, { x: number; y: number }>();
    allNodes.forEach((n) => prevPositions.set(n.id, { x: n.x, y: n.y }));

    const newPositions = new Map<string, { x: number; y: number }>();

    const applyEntityDelta = (entity: AlignEntity, dx: number, dy: number) => {
      const members = nodesRef.current.filter((n) => entity.memberIds.includes(n.id));
      members.forEach((n) => newPositions.set(n.id, { x: n.x + dx, y: n.y + dy }));
    };

    if (direction === "horizontal") {
      const sorted = [...entities].sort((a, b) => a.x - b.x);
      const minX = sorted[0].x;
      const maxRight = Math.max(...sorted.map((e) => e.x + e.width));
      const totalEntityWidth = sorted.reduce((acc, e) => acc + e.width, 0);
      const totalSpace = maxRight - minX - totalEntityWidth;
      const gap = totalSpace / (sorted.length - 1);
      let currentX = minX;
      sorted.forEach((e) => {
        applyEntityDelta(e, currentX - e.x, 0);
        currentX += e.width + gap;
      });
    } else {
      const sorted = [...entities].sort((a, b) => a.y - b.y);
      const minY = sorted[0].y;
      const maxBottom = Math.max(...sorted.map((e) => e.y + e.height));
      const totalEntityHeight = sorted.reduce((acc, e) => acc + e.height, 0);
      const totalSpace = maxBottom - minY - totalEntityHeight;
      const gap = totalSpace / (sorted.length - 1);
      let currentY = minY;
      sorted.forEach((e) => {
        applyEntityDelta(e, 0, currentY - e.y);
        currentY += e.height + gap;
      });
    }

    const updatedNodes = Array.from(newPositions.entries()).map(([id, pos]) => ({ id, x: pos.x, y: pos.y }));
    const animIds = new Set(allMemberIds);
    animateLayoutTransition(animIds);

    setNodes((prev) => prev.map((n) => {
      const pos = newPositions.get(n.id);
      return pos ? { ...n, x: pos.x, y: pos.y } : n;
    }));

    pushUndo({
      type: "move",
      undo: () => setNodes((prev) => prev.map((n) => { const p = prevPositions.get(n.id); return p ? { ...n, ...p } : n; })),
      redo: () => setNodes((prev) => prev.map((n) => { const p = newPositions.get(n.id); return p ? { ...n, ...p } : n; })),
    });

    if (canvasId) {
      saveNodesBatchDebounced(canvasId, updatedNodes);
    }
  }, [canvasId, saveNodesBatchDebounced, pushUndo, animateLayoutTransition, resolveAlignEntities]);

  const applyLayout = useCallback((type: "tidy" | "masonry-h" | "masonry-v") => {
    const currentNodes = nodesRef.current;
    const currentSelectedIds = selectedIdsRef.current;
    const selected = currentNodes.filter((n) => currentSelectedIds.has(n.id) && n.node_type !== "group");
    if (selected.length < 2) return;

    const prevState = new Map<string, { x: number; y: number; width: number; height: number }>();
    selected.forEach((n) => prevState.set(n.id, { x: n.x, y: n.y, width: n.width, height: n.height }));

    const originX = Math.min(...selected.map((n) => n.x));
    const originY = Math.min(...selected.map((n) => n.y));
    const GAP = 16;
    const LAYOUT_MIN_DIM = 20;

    let updates: { id: string; x: number; y: number; width: number; height: number; metadata?: Record<string, unknown> }[] = [];

    const getOriginalDims = (n: typeof selected[0]) => {
      const ow = (n.metadata as Record<string, unknown>)?.originalWidth as number | undefined;
      const oh = (n.metadata as Record<string, unknown>)?.originalHeight as number | undefined;
      return { w: ow && ow > 0 ? ow : n.width, h: oh && oh > 0 ? oh : n.height };
    };

    const metadataUpdates = new Map<string, Record<string, unknown>>();
    selected.forEach((n) => {
      const md = (n.metadata as Record<string, unknown>) || {};
      if (!md.originalWidth || !md.originalHeight) {
        metadataUpdates.set(n.id, { ...md, originalWidth: md.originalWidth || n.width, originalHeight: md.originalHeight || n.height });
      }
    });

    if (type === "tidy") {
      const count = selected.length;
      const cols = Math.ceil(Math.sqrt(count));
      const maxW = Math.max(...selected.map((n) => getOriginalDims(n).w));
      const maxH = Math.max(...selected.map((n) => getOriginalDims(n).h));
      const sorted = [...selected].sort((a, b) => a.z_index - b.z_index);
      updates = sorted.map((n, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const cellX = originX + col * (maxW + GAP);
        const cellY = originY + row * (maxH + GAP);
        const orig = getOriginalDims(n);
        const ar = orig.w / orig.h;
        let fitW = maxW;
        let fitH = maxW / ar;
        if (fitH > maxH) {
          fitH = maxH;
          fitW = maxH * ar;
        }
        const offsetX = (maxW - fitW) / 2;
        const offsetY = (maxH - fitH) / 2;
        const entry: typeof updates[0] = { id: n.id, x: cellX + offsetX, y: cellY + offsetY, width: Math.max(LAYOUT_MIN_DIM, Math.round(fitW)), height: Math.max(LAYOUT_MIN_DIM, Math.round(fitH)) };
        if (metadataUpdates.has(n.id)) entry.metadata = metadataUpdates.get(n.id);
        return entry;
      });
    } else if (type === "masonry-h") {
      const sorted = [...selected].sort((a, b) => a.z_index - b.z_index);
      const cols = Math.ceil(Math.sqrt(sorted.length));
      const colWidth = Math.max(...selected.map((n) => getOriginalDims(n).w));
      const colHeights = new Array(cols).fill(0);
      const colItems: typeof sorted[] = Array.from({ length: cols }, () => []);
      sorted.forEach((n) => {
        let shortestCol = 0;
        for (let c = 1; c < cols; c++) {
          if (colHeights[c] < colHeights[shortestCol]) shortestCol = c;
        }
        colItems[shortestCol].push(n);
        const orig = getOriginalDims(n);
        const ar = orig.w / orig.h;
        const scaledH = colWidth / ar;
        colHeights[shortestCol] += scaledH + GAP;
      });
      for (let c = 0; c < cols; c++) {
        let curY = originY;
        for (const n of colItems[c]) {
          const orig = getOriginalDims(n);
          const ar = orig.w / orig.h;
          const w = Math.max(LAYOUT_MIN_DIM, Math.round(colWidth));
          const h = Math.max(LAYOUT_MIN_DIM, Math.round(colWidth / ar));
          const entry: typeof updates[0] = { id: n.id, x: originX + c * (colWidth + GAP), y: curY, width: w, height: h };
          if (metadataUpdates.has(n.id)) entry.metadata = metadataUpdates.get(n.id);
          updates.push(entry);
          curY += h + GAP;
        }
      }
    } else if (type === "masonry-v") {
      const sorted = [...selected].sort((a, b) => a.z_index - b.z_index);
      const rows = Math.ceil(Math.sqrt(sorted.length));
      const rowHeight = Math.max(...selected.map((n) => getOriginalDims(n).h));
      const rowWidths = new Array(rows).fill(0);
      const rowItems: typeof sorted[] = Array.from({ length: rows }, () => []);
      sorted.forEach((n) => {
        let shortestRow = 0;
        for (let r = 1; r < rows; r++) {
          if (rowWidths[r] < rowWidths[shortestRow]) shortestRow = r;
        }
        rowItems[shortestRow].push(n);
        const orig = getOriginalDims(n);
        const ar = orig.w / orig.h;
        const scaledW = rowHeight * ar;
        rowWidths[shortestRow] += scaledW + GAP;
      });
      for (let r = 0; r < rows; r++) {
        let curX = originX;
        for (const n of rowItems[r]) {
          const orig = getOriginalDims(n);
          const ar = orig.w / orig.h;
          const h = Math.max(LAYOUT_MIN_DIM, Math.round(rowHeight));
          const w = Math.max(LAYOUT_MIN_DIM, Math.round(rowHeight * ar));
          const entry: typeof updates[0] = { id: n.id, x: curX, y: originY + r * (rowHeight + GAP), width: w, height: h };
          if (metadataUpdates.has(n.id)) entry.metadata = metadataUpdates.get(n.id);
          updates.push(entry);
          curX += w + GAP;
        }
      }
    }

    const newState = new Map<string, { x: number; y: number; width: number; height: number; metadata?: Record<string, unknown> }>();
    updates.forEach((u) => newState.set(u.id, { x: u.x, y: u.y, width: u.width, height: u.height, ...(u.metadata ? { metadata: u.metadata } : {}) }));

    animateLayoutTransition(currentSelectedIds);

    setNodes((prev) => prev.map((n) => {
      const s = newState.get(n.id);
      return s ? { ...n, ...s } : n;
    }));

    pushUndo({
      type: "move",
      undo: () => setNodes((prev) => prev.map((n) => { const p = prevState.get(n.id); return p ? { ...n, ...p } : n; })),
      redo: () => setNodes((prev) => prev.map((n) => { const s = newState.get(n.id); return s ? { ...n, ...s } : n; })),
    });

    if (canvasId) {
      saveNodesBatchDebounced(canvasId, updates);
    }
  }, [canvasId, saveNodesBatchDebounced, pushUndo, animateLayoutTransition]);

  return {
    alignNodes,
    distributeNodes,
    applyLayout,
    animateLayoutTransition,
  };
}
