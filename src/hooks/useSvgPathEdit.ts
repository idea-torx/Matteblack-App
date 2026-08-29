import { useRef, useState, useCallback, type MutableRefObject } from "react";
import type { CanvasNode, UndoCommand } from "../types/canvas";
import type { PathData } from "../utils/svgPathModel";
import type { SvgEditTool } from "../components/canvas/SvgEditToolbar";
import {
  extractPathDataFromSvg,
  moveAnchor,
  moveHandle,
  deletePoint,
  toggleSmooth,
  splitPathAtPoint,
  joinEndpoints,
  insertPointOnSegment,
} from "../utils/svgPathModel";

type SelectedPoint = { subPathIdx: number; anchorIdx: number };

type DragState = {
  type: "anchor" | "handleIn" | "handleOut";
  subPathIdx: number;
  anchorIdx: number;
  startX: number;
  startY: number;
  origX: number;
  origY: number;
  vbScaleX: number;
  vbScaleY: number;
} | null;

type UseSvgPathEditParams = {
  nodes: CanvasNode[];
  nodesRef: MutableRefObject<CanvasNode[]>;
  setNodes: React.Dispatch<React.SetStateAction<CanvasNode[]>>;
  zoom: number;
  pushUndo: (cmd: UndoCommand) => void;
  canvasId: string | null;
  saveNodesBatchDebounced: (canvasId: string, updates: { id: string; [key: string]: unknown }[]) => void;
};

export function useSvgPathEdit({
  nodesRef,
  setNodes,
  zoom,
  pushUndo,
  canvasId,
  saveNodesBatchDebounced,
}: UseSvgPathEditParams) {
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [selectedPoints, setSelectedPoints] = useState<SelectedPoint[]>([]);
  const [editTool, setEditTool] = useState<SvgEditTool>("move");
  const [isDragging, setIsDragging] = useState(false);
  const dragState = useRef<DragState>(null);
  const beforeEditMetadata = useRef<Record<string, unknown> | null>(null);
  const beforeEditBounds = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const canvasIdRef = useRef(canvasId);
  canvasIdRef.current = canvasId;

  const getPathData = useCallback((nodeId: string): PathData | null => {
    const node = nodesRef.current.find((n) => n.id === nodeId);
    if (!node) return null;
    return (node.metadata?.pathData as PathData) || null;
  }, [nodesRef]);

  const getViewBoxScale = useCallback((nodeId: string): { vbScaleX: number; vbScaleY: number } => {
    const node = nodesRef.current.find((n) => n.id === nodeId);
    const pathData = getPathData(nodeId);
    if (!node || !pathData) return { vbScaleX: 1, vbScaleY: 1 };
    let vbW = 0;
    let vbH = 0;
    for (const sp of pathData.subPaths) {
      for (const a of sp.anchors) {
        if (a.x > vbW) vbW = a.x;
        if (a.y > vbH) vbH = a.y;
        if (a.handleIn) {
          if (a.handleIn.x > vbW) vbW = a.handleIn.x;
          if (a.handleIn.y > vbH) vbH = a.handleIn.y;
        }
        if (a.handleOut) {
          if (a.handleOut.x > vbW) vbW = a.handleOut.x;
          if (a.handleOut.y > vbH) vbH = a.handleOut.y;
        }
      }
    }
    vbW = vbW || node.width;
    vbH = vbH || node.height;
    return { vbScaleX: vbW / node.width, vbScaleY: vbH / node.height };
  }, [nodesRef, getPathData]);

  const ensurePathData = useCallback((nodeId: string): PathData | null => {
    const node = nodesRef.current.find((n) => n.id === nodeId);
    if (!node) return null;
    if (node.metadata?.pathData) return node.metadata.pathData as PathData;

    const svgContent = node.metadata?.svg_content as string | undefined;
    if (!svgContent) return null;

    const parsed = extractPathDataFromSvg(svgContent, node.width, node.height);
    if (!parsed) return null;

    setNodes((prev) =>
      prev.map((n) =>
        n.id === nodeId
          ? { ...n, metadata: { ...n.metadata, pathData: parsed } }
          : n
      )
    );
    return parsed;
  }, [nodesRef, setNodes]);

  const normalizePathBounds = useCallback((nodeId: string) => {
    const pathData = getPathData(nodeId);
    if (!pathData) return;
    const node = nodesRef.current.find((n) => n.id === nodeId);
    if (!node) return;

    let minX = 0, minY = 0, maxX = node.width, maxY = node.height;
    for (const sp of pathData.subPaths) {
      for (const a of sp.anchors) {
        minX = Math.min(minX, a.x);
        minY = Math.min(minY, a.y);
        maxX = Math.max(maxX, a.x);
        maxY = Math.max(maxY, a.y);
        if (a.handleIn) {
          minX = Math.min(minX, a.handleIn.x);
          minY = Math.min(minY, a.handleIn.y);
          maxX = Math.max(maxX, a.handleIn.x);
          maxY = Math.max(maxY, a.handleIn.y);
        }
        if (a.handleOut) {
          minX = Math.min(minX, a.handleOut.x);
          minY = Math.min(minY, a.handleOut.y);
          maxX = Math.max(maxX, a.handleOut.x);
          maxY = Math.max(maxY, a.handleOut.y);
        }
      }
    }

    if (minX >= 0 && minY >= 0 && maxX <= node.width && maxY <= node.height) return;

    const offsetX = -minX;
    const offsetY = -minY;
    const newWidth = maxX - minX;
    const newHeight = maxY - minY;

    const shifted: PathData = {
      ...pathData,
      subPaths: pathData.subPaths.map((sp) => ({
        ...sp,
        anchors: sp.anchors.map((a) => ({
          ...a,
          x: a.x + offsetX,
          y: a.y + offsetY,
          handleIn: a.handleIn ? { x: a.handleIn.x + offsetX, y: a.handleIn.y + offsetY } : undefined,
          handleOut: a.handleOut ? { x: a.handleOut.x + offsetX, y: a.handleOut.y + offsetY } : undefined,
        })),
      })),
    };

    setNodes((prev) =>
      prev.map((n) =>
        n.id === nodeId
          ? {
              ...n,
              x: n.x - offsetX,
              y: n.y - offsetY,
              width: newWidth,
              height: newHeight,
              metadata: { ...n.metadata, pathData: shifted },
            }
          : n
      )
    );
  }, [getPathData, nodesRef, setNodes]);

  const enterEditMode = useCallback((nodeId: string) => {
    const node = nodesRef.current.find((n) => n.id === nodeId);
    if (!node || node.node_type !== "svg") return;

    const pathData = ensurePathData(nodeId);
    if (!pathData) return;

    normalizePathBounds(nodeId);
    const freshNode = nodesRef.current.find((n) => n.id === nodeId) || node;
    beforeEditMetadata.current = { ...freshNode.metadata };
    beforeEditBounds.current = { x: freshNode.x, y: freshNode.y, width: freshNode.width, height: freshNode.height };
    setEditingNodeId(nodeId);
    setSelectedPoints([]);
    setEditTool("move");
  }, [nodesRef, ensurePathData, normalizePathBounds]);

  const exitEditMode = useCallback(() => {
    if (editingNodeId && beforeEditMetadata.current && beforeEditBounds.current) {
      const node = nodesRef.current.find((n) => n.id === editingNodeId);
      if (node) {
        const oldMeta = beforeEditMetadata.current;
        const oldBounds = beforeEditBounds.current;
        const newMeta = { ...node.metadata };
        const newBounds = { x: node.x, y: node.y, width: node.width, height: node.height };
        const nodeId = editingNodeId;
        pushUndo({
          type: "resize",
          undo: () => setNodes((prev) => prev.map((n) => n.id === nodeId ? { ...n, ...oldBounds, metadata: oldMeta } : n)),
          redo: () => setNodes((prev) => prev.map((n) => n.id === nodeId ? { ...n, ...newBounds, metadata: newMeta } : n)),
        });
        const cid = canvasIdRef.current;
        if (cid) {
          saveNodesBatchDebounced(cid, [{ id: nodeId, ...newBounds, metadata: newMeta }]);
        }
      }
    }
    setEditingNodeId(null);
    setSelectedPoints([]);
    beforeEditMetadata.current = null;
    beforeEditBounds.current = null;
  }, [editingNodeId, nodesRef, pushUndo, setNodes, saveNodesBatchDebounced]);

  const persistChanges = useCallback((nodeId: string) => {
    const cid = canvasIdRef.current;
    if (!cid) return;
    const node = nodesRef.current.find((n) => n.id === nodeId);
    if (node) {
      saveNodesBatchDebounced(cid, [{ id: nodeId, x: node.x, y: node.y, width: node.width, height: node.height, metadata: { ...node.metadata } }]);
    }
  }, [nodesRef, saveNodesBatchDebounced]);

  const updatePathData = useCallback((nodeId: string, newPathData: PathData, persist = false) => {
    setNodes((prev) =>
      prev.map((n) =>
        n.id === nodeId
          ? { ...n, metadata: { ...n.metadata, pathData: newPathData } }
          : n
      )
    );
    if (persist) setTimeout(() => persistChanges(nodeId), 0);
  }, [setNodes, persistChanges]);

  const handleAnchorPointerDown = useCallback((e: React.PointerEvent, subPathIdx: number, anchorIdx: number) => {
    e.stopPropagation();
    e.preventDefault();
    if (!editingNodeId) return;

    if (editTool === "curve") {
      const pathData = getPathData(editingNodeId);
      if (pathData) {
        const toggled = toggleSmooth(pathData, subPathIdx, anchorIdx);
        updatePathData(editingNodeId, toggled, true);
      }
      return;
    }

    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      setSelectedPoints((prev) => {
        const exists = prev.find((p) => p.subPathIdx === subPathIdx && p.anchorIdx === anchorIdx);
        if (exists) return prev.filter((p) => p !== exists);
        return [...prev, { subPathIdx, anchorIdx }];
      });
      return;
    }

    setSelectedPoints([{ subPathIdx, anchorIdx }]);

    if (editTool === "move") {
      const node = nodesRef.current.find((n) => n.id === editingNodeId);
      if (!node) return;
      const pathData = node.metadata?.pathData as PathData;
      if (!pathData) return;
      const anchor = pathData.subPaths[subPathIdx]?.anchors[anchorIdx];
      if (!anchor) return;

      const { vbScaleX, vbScaleY } = getViewBoxScale(editingNodeId);
      setIsDragging(true);
      dragState.current = {
        type: "anchor",
        subPathIdx,
        anchorIdx,
        startX: e.clientX,
        startY: e.clientY,
        origX: anchor.x,
        origY: anchor.y,
        vbScaleX,
        vbScaleY,
      };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    }
  }, [editingNodeId, editTool, getPathData, nodesRef, updatePathData, getViewBoxScale]);

  const handleHandlePointerDown = useCallback((e: React.PointerEvent, subPathIdx: number, anchorIdx: number, handleType: "in" | "out") => {
    e.stopPropagation();
    e.preventDefault();
    if (!editingNodeId) return;

    const node = nodesRef.current.find((n) => n.id === editingNodeId);
    if (!node) return;
    const pathData = node.metadata?.pathData as PathData;
    if (!pathData) return;
    const anchor = pathData.subPaths[subPathIdx]?.anchors[anchorIdx];
    if (!anchor) return;
    const handle = handleType === "in" ? anchor.handleIn : anchor.handleOut;
    if (!handle) return;

    const { vbScaleX, vbScaleY } = getViewBoxScale(editingNodeId);
    setIsDragging(true);
    dragState.current = {
      type: handleType === "in" ? "handleIn" : "handleOut",
      subPathIdx,
      anchorIdx,
      startX: e.clientX,
      startY: e.clientY,
      origX: handle.x,
      origY: handle.y,
      vbScaleX,
      vbScaleY,
    };
    (e.target as SVGElement).setPointerCapture(e.pointerId);
  }, [editingNodeId, nodesRef, getViewBoxScale]);

  const handleEditPointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging || !dragState.current || !editingNodeId) return;
    const ds = dragState.current;
    const z = zoomRef.current;

    const pathData = getPathData(editingNodeId);
    if (!pathData) return;

    const dx = (e.clientX - ds.startX) / z * ds.vbScaleX;
    const dy = (e.clientY - ds.startY) / z * ds.vbScaleY;

    if (ds.type === "anchor") {
      const moved = moveAnchor(pathData, ds.subPathIdx, ds.anchorIdx, ds.origX + dx - pathData.subPaths[ds.subPathIdx].anchors[ds.anchorIdx].x, ds.origY + dy - pathData.subPaths[ds.subPathIdx].anchors[ds.anchorIdx].y);
      updatePathData(editingNodeId, moved);
    } else {
      const ht = ds.type === "handleIn" ? "in" : "out";
      const moved = moveHandle(pathData, ds.subPathIdx, ds.anchorIdx, ht, ds.origX + dx, ds.origY + dy);
      updatePathData(editingNodeId, moved);
    }
  }, [isDragging, editingNodeId, getPathData, updatePathData]);

  const handleEditPointerUp = useCallback(() => {
    if (isDragging) {
      setIsDragging(false);
      dragState.current = null;
      if (editingNodeId) {
        normalizePathBounds(editingNodeId);
        setTimeout(() => persistChanges(editingNodeId), 0);
      }
    }
  }, [isDragging, editingNodeId, persistChanges, normalizePathBounds]);

  const handleSegmentClick = useCallback((_e: React.MouseEvent, subPathIdx: number, segmentIdx: number) => {
    if (!editingNodeId) return;
    const pathData = getPathData(editingNodeId);
    if (!pathData) return;

    const sp = pathData.subPaths[subPathIdx];
    if (!sp) return;
    const updated = insertPointOnSegment(sp, segmentIdx, 0.5);
    const newPathData = {
      ...pathData,
      subPaths: pathData.subPaths.map((s, i) => i === subPathIdx ? updated : s),
    };
    updatePathData(editingNodeId, newPathData, true);
    setSelectedPoints([{ subPathIdx, anchorIdx: segmentIdx + 1 }]);
  }, [editingNodeId, editTool, getPathData, updatePathData]);

  const handleDeleteSelected = useCallback(() => {
    if (!editingNodeId || selectedPoints.length === 0) return;
    let pathData = getPathData(editingNodeId);
    if (!pathData) return;

    const sorted = [...selectedPoints].sort((a, b) => b.anchorIdx - a.anchorIdx || b.subPathIdx - a.subPathIdx);
    for (const pt of sorted) {
      pathData = deletePoint(pathData, pt.subPathIdx, pt.anchorIdx);
    }
    updatePathData(editingNodeId, pathData, true);
    setSelectedPoints([]);
  }, [editingNodeId, selectedPoints, getPathData, updatePathData]);

  const handleCutSelected = useCallback(() => {
    if (!editingNodeId || selectedPoints.length !== 1) return;
    const pathData = getPathData(editingNodeId);
    if (!pathData) return;
    const pt = selectedPoints[0];
    const split = splitPathAtPoint(pathData, pt.subPathIdx, pt.anchorIdx);
    updatePathData(editingNodeId, split, true);
    setSelectedPoints([]);
  }, [editingNodeId, selectedPoints, getPathData, updatePathData]);

  const handleJoinSelected = useCallback(() => {
    if (!editingNodeId || selectedPoints.length !== 2) return;
    const pathData = getPathData(editingNodeId);
    if (!pathData) return;

    const [p1, p2] = selectedPoints;
    if (p1.subPathIdx !== p2.subPathIdx) {
      if (pathData.subPaths.length < 2) return;
      const joined = joinEndpoints(pathData, p1.subPathIdx, p2.subPathIdx, p1.anchorIdx, p2.anchorIdx);
      updatePathData(editingNodeId, joined, true);
      setSelectedPoints([]);
    } else {
      const sp = pathData.subPaths[p1.subPathIdx];
      if (!sp || sp.closed) return;
      const lastIdx = sp.anchors.length - 1;
      const isEndpoints = (p1.anchorIdx === 0 && p2.anchorIdx === lastIdx) || (p1.anchorIdx === lastIdx && p2.anchorIdx === 0);
      if (!isEndpoints) return;
      const newSubPaths = [...pathData.subPaths];
      newSubPaths[p1.subPathIdx] = { ...sp, closed: true };
      updatePathData(editingNodeId, { ...pathData, subPaths: newSubPaths }, true);
      setSelectedPoints([]);
    }
  }, [editingNodeId, selectedPoints, getPathData, updatePathData]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!editingNodeId) return;
    if (e.key === "Escape") {
      exitEditMode();
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      handleDeleteSelected();
    }
    if (e.key === "j" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleJoinSelected();
    }
  }, [editingNodeId, exitEditMode, handleDeleteSelected, handleJoinSelected]);

  const isEditingPath = useCallback((nodeId: string) => editingNodeId === nodeId, [editingNodeId]);

  const canJoin = (() => {
    if (selectedPoints.length !== 2) return false;
    const [p1, p2] = selectedPoints;
    if (p1.subPathIdx !== p2.subPathIdx) return true;
    const pathData = editingNodeId ? getPathData(editingNodeId) : null;
    if (!pathData) return false;
    const sp = pathData.subPaths[p1.subPathIdx];
    if (!sp || sp.closed) return false;
    const lastIdx = sp.anchors.length - 1;
    const hasFirst = (p1.anchorIdx === 0 && p2.anchorIdx === lastIdx) || (p1.anchorIdx === lastIdx && p2.anchorIdx === 0);
    return hasFirst;
  })();
  const canCut = selectedPoints.length === 1;

  const updatePointPosition = useCallback((nodeId: string, subPathIdx: number, anchorIdx: number, newX: number, newY: number) => {
    const pathData = getPathData(nodeId);
    if (!pathData) return;
    const anchor = pathData.subPaths[subPathIdx]?.anchors[anchorIdx];
    if (!anchor) return;
    const dx = newX - anchor.x;
    const dy = newY - anchor.y;
    if (dx === 0 && dy === 0) return;
    const moved = moveAnchor(pathData, subPathIdx, anchorIdx, dx, dy);
    updatePathData(nodeId, moved, true);
  }, [getPathData, updatePathData]);

  const togglePointSmooth = useCallback((nodeId: string, subPathIdx: number, anchorIdx: number) => {
    const pathData = getPathData(nodeId);
    if (!pathData) return;
    const toggled = toggleSmooth(pathData, subPathIdx, anchorIdx);
    updatePathData(nodeId, toggled, true);
  }, [getPathData, updatePathData]);

  const updatePointRadius = useCallback((nodeId: string, subPathIdx: number, anchorIdx: number, radius: number) => {
    const pathData = getPathData(nodeId);
    if (!pathData) return;
    const newSubPaths = pathData.subPaths.map((sp, si) => {
      if (si !== subPathIdx) return sp;
      return {
        ...sp,
        anchors: sp.anchors.map((a, ai) => {
          if (ai !== anchorIdx) return a;
          return { ...a, cornerRadius: radius };
        }),
      };
    });
    updatePathData(nodeId, { ...pathData, subPaths: newSubPaths }, true);
  }, [getPathData, updatePathData]);

  const selectPointsInRect = useCallback((worldLeft: number, worldTop: number, worldRight: number, worldBottom: number) => {
    if (!editingNodeId) return;
    const node = nodesRef.current.find((n) => n.id === editingNodeId);
    if (!node) return;
    const pathData = getPathData(editingNodeId);
    if (!pathData) return;

    let vbW = 0;
    let vbH = 0;
    for (const sp of pathData.subPaths) {
      for (const a of sp.anchors) {
        if (a.x > vbW) vbW = a.x;
        if (a.y > vbH) vbH = a.y;
        if (a.handleIn) {
          if (a.handleIn.x > vbW) vbW = a.handleIn.x;
          if (a.handleIn.y > vbH) vbH = a.handleIn.y;
        }
        if (a.handleOut) {
          if (a.handleOut.x > vbW) vbW = a.handleOut.x;
          if (a.handleOut.y > vbH) vbH = a.handleOut.y;
        }
      }
    }
    vbW = vbW || node.width;
    vbH = vbH || node.height;

    const scaleX = node.width / vbW;
    const scaleY = node.height / vbH;

    const hits: SelectedPoint[] = [];
    for (let si = 0; si < pathData.subPaths.length; si++) {
      const sp = pathData.subPaths[si];
      for (let ai = 0; ai < sp.anchors.length; ai++) {
        const a = sp.anchors[ai];
        const wx = node.x + a.x * scaleX;
        const wy = node.y + a.y * scaleY;
        if (wx >= worldLeft && wx <= worldRight && wy >= worldTop && wy <= worldBottom) {
          hits.push({ subPathIdx: si, anchorIdx: ai });
        }
      }
    }
    setSelectedPoints(hits);
  }, [editingNodeId, nodesRef, getPathData]);

  return {
    editingNodeId,
    isEditingPath,
    selectedPoints,
    editTool,
    setEditTool,
    isDragging,
    enterEditMode,
    exitEditMode,
    getPathData,
    ensurePathData,
    handleAnchorPointerDown,
    handleHandlePointerDown,
    handleEditPointerMove,
    handleEditPointerUp,
    handleSegmentClick,
    handleDeleteSelected,
    handleCutSelected,
    handleJoinSelected,
    handleKeyDown,
    canJoin,
    canCut,
    updatePointPosition,
    togglePointSmooth,
    updatePointRadius,
    selectPointsInRect,
  };
}
