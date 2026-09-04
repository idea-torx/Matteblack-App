import { useRef, useState, useCallback, type MutableRefObject } from "react";
import type { CanvasNode, UndoCommand } from "../types/canvas";
import type { PathData } from "../utils/svgPathModel";
import type { SvgEditTool } from "../components/canvas/SvgEditToolbar";
import {
  simplifyPathData,
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
  type: "anchor" | "handleIn" | "handleOut" | "scale" | "translate";
  subPathIdx: number;
  anchorIdx: number;
  startX: number;
  startY: number;
  origX: number;
  origY: number;
  vbScaleX: number;
  vbScaleY: number;
  /** Scale only: the corner held still, and the shapes being scaled. */
  fixedX?: number;
  fixedY?: number;
  snapshot?: PathData;
  groups?: number[];
  /** Translate only: the shape under the pointer, in case this is just a click. */
  clickGroup?: number;
  additive?: boolean;
  moved?: boolean;
  /** Every shape as a canvas-space rect, so the smart guides see them. */
  rects?: CanvasNode[];
} | null;

type UseSvgPathEditParams = {
  nodes: CanvasNode[];
  nodesRef: MutableRefObject<CanvasNode[]>;
  setNodes: React.Dispatch<React.SetStateAction<CanvasNode[]>>;
  zoom: number;
  pushUndo: (cmd: UndoCommand) => void;
  canvasId: string | null;
  saveNodesBatchDebounced: (canvasId: string, updates: { id: string; [key: string]: unknown }[]) => void;
  /** Canvas smart guides, so shapes inside an SVG snap like nodes do. */
  snapRects?: (rects: CanvasNode[], ids: Set<string>, dx: number, dy: number) => { snapDx: number; snapDy: number };
  clearGuides?: () => void;
};

export function useSvgPathEdit({
  nodesRef,
  setNodes,
  zoom,
  pushUndo,
  canvasId,
  saveNodesBatchDebounced,
  snapRects,
  clearGuides,
}: UseSvgPathEditParams) {
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [selectedPoints, setSelectedPoints] = useState<SelectedPoint[]>([]);
  // Which shape is open for point editing. Null means the whole artwork is
  // showing and a shape has to be clicked into first, as in Figma.
  const [activeGroups, setActiveGroupsState] = useState<number[]>([]);
  // Selecting a shape is not the same as being inside it: points only appear
  // once you click a second time, so a multi-shape selection stays readable.
  const [enteredGroup, setEnteredGroup] = useState<number | null>(null);
  const [editTool, setEditTool] = useState<SvgEditTool>("move");
  const [isDragging, setIsDragging] = useState(false);
  const dragState = useRef<DragState>(null);
  const beforeEditMetadata = useRef<Record<string, unknown> | null>(null);
  const beforeEditBounds = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const snapRectsRef = useRef(snapRects);
  snapRectsRef.current = snapRects;
  const clearGuidesRef = useRef(clearGuides);
  clearGuidesRef.current = clearGuides;
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
    if (pathData.viewBox) {
      return { vbScaleX: pathData.viewBox.width / node.width, vbScaleY: pathData.viewBox.height / node.height };
    }
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

    // Seeded from the artwork, not from the node: a node with whitespace around
    // its shapes has to shrink onto them, not just grow to fit strays.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
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

    if (!(maxX > minX) || !(maxY > minY)) return;
    // Already wrapped tight; re-laying it out every time would jitter the node.
    if (Math.abs(minX) < 0.5 && Math.abs(minY) < 0.5 &&
        Math.abs(maxX - node.width) < 0.5 && Math.abs(maxY - node.height) < 0.5) return;

    const offsetX = -minX;
    const offsetY = -minY;
    const newWidth = maxX - minX;
    const newHeight = maxY - minY;

    const shifted: PathData = {
      ...pathData,
      // The node was resized; the viewBox the canvas renders through follows it.
      viewBox: pathData.viewBox ? { x: 0, y: 0, width: newWidth, height: newHeight } : undefined,
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
    setActiveGroupsState([]);
    setEnteredGroup(null);
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
    setActiveGroupsState([]);
    setEnteredGroup(null);
    beforeEditMetadata.current = null;
    beforeEditBounds.current = null;
  }, [editingNodeId, nodesRef, pushUndo, setNodes, saveNodesBatchDebounced]);

  const setActiveGroup = useCallback((g: number | null, additive = false) => {
    setSelectedPoints([]);
    if (g === null) {
      setActiveGroupsState([]);
      setEnteredGroup(null);
      return;
    }
    if (additive) {
      setActiveGroupsState(activeGroups.includes(g) ? activeGroups.filter((x) => x !== g) : [...activeGroups, g]);
      setEnteredGroup(null);
      return;
    }
    // Clicking the one shape already picked is the click that goes into it.
    setEnteredGroup(activeGroups.length === 1 && activeGroups[0] === g ? g : null);
    setActiveGroupsState([g]);
  }, [activeGroups]);

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

  /**
   * Every shape in this SVG as a canvas-space rect, plus the node's own box,
   * which is what the smart guides expect to be handed.
   */
  const groupRects = useCallback((nodeId: string, pathData: PathData): CanvasNode[] => {
    const node = nodesRef.current.find((n) => n.id === nodeId);
    if (!node) return [];
    const { vbScaleX, vbScaleY } = getViewBoxScale(nodeId);
    const vbX = pathData.viewBox?.x ?? 0;
    const vbY = pathData.viewBox?.y ?? 0;
    const box = new Map<number, { x0: number; y0: number; x1: number; y1: number }>();
    pathData.subPaths.forEach((sp, i) => {
      const g = sp.group ?? i;
      let b = box.get(g);
      if (!b) { b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }; box.set(g, b); }
      for (const a of sp.anchors) {
        for (const p of [a, a.handleIn, a.handleOut]) {
          if (!p) continue;
          b.x0 = Math.min(b.x0, p.x); b.y0 = Math.min(b.y0, p.y);
          b.x1 = Math.max(b.x1, p.x); b.y1 = Math.max(b.y1, p.y);
        }
      }
    });
    const rects: CanvasNode[] = [
      { id: "__node__", x: node.x, y: node.y, width: node.width, height: node.height } as CanvasNode,
    ];
    for (const [g, b] of box) {
      if (!(b.x1 > b.x0) || !(b.y1 > b.y0)) continue;
      rects.push({
        id: String(g),
        x: node.x + (b.x0 - vbX) / vbScaleX,
        y: node.y + (b.y0 - vbY) / vbScaleY,
        width: (b.x1 - b.x0) / vbScaleX,
        height: (b.y1 - b.y0) / vbScaleY,
      } as CanvasNode);
    }
    return rects;
  }, [nodesRef, getViewBoxScale]);

  /**
   * Press on a shape that is already picked: a drag moves everything picked, a
   * press that never moves is the click that goes into the shape.
   */
  const handleGroupMovePointerDown = useCallback((e: React.PointerEvent, group: number) => {
    e.stopPropagation();
    e.preventDefault();
    if (!editingNodeId) return;
    const pathData = getPathData(editingNodeId);
    if (!pathData) return;
    const { vbScaleX, vbScaleY } = getViewBoxScale(editingNodeId);
    setIsDragging(true);
    dragState.current = {
      type: "translate",
      subPathIdx: 0,
      anchorIdx: 0,
      startX: e.clientX,
      startY: e.clientY,
      origX: 0,
      origY: 0,
      vbScaleX,
      vbScaleY,
      snapshot: pathData,
      groups: activeGroups,
      clickGroup: group,
      additive: e.shiftKey || e.metaKey || e.ctrlKey,
      moved: false,
      rects: groupRects(editingNodeId, pathData),
    };
    (e.target as SVGElement).setPointerCapture(e.pointerId);
  }, [editingNodeId, getPathData, getViewBoxScale, activeGroups, groupRects]);

  /** Drag a corner of the box around the open shapes to scale them together. */
  const handleGroupScalePointerDown = useCallback((e: React.PointerEvent, grabX: number, grabY: number, fixedX: number, fixedY: number) => {
    e.stopPropagation();
    e.preventDefault();
    if (!editingNodeId) return;
    const pathData = getPathData(editingNodeId);
    if (!pathData) return;
    const { vbScaleX, vbScaleY } = getViewBoxScale(editingNodeId);
    setIsDragging(true);
    dragState.current = {
      type: "scale",
      subPathIdx: 0,
      anchorIdx: 0,
      startX: e.clientX,
      startY: e.clientY,
      origX: grabX,
      origY: grabY,
      vbScaleX,
      vbScaleY,
      fixedX,
      fixedY,
      snapshot: pathData,
      groups: activeGroups,
    };
    (e.target as SVGElement).setPointerCapture(e.pointerId);
  }, [editingNodeId, getPathData, getViewBoxScale, activeGroups]);

  const handleEditPointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging || !dragState.current || !editingNodeId) return;
    const ds = dragState.current;
    const z = zoomRef.current;

    const pathData = getPathData(editingNodeId);
    if (!pathData) return;

    const dx = (e.clientX - ds.startX) / z * ds.vbScaleX;
    const dy = (e.clientY - ds.startY) / z * ds.vbScaleY;

    if (ds.type === "translate") {
      if (Math.abs(e.clientX - ds.startX) + Math.abs(e.clientY - ds.startY) > 3) ds.moved = true;
      if (!ds.moved) return;
      const snap = ds.snapshot!;
      const gs = new Set(ds.groups!);
      // Same guides the canvas uses for nodes, fed the shapes of this SVG:
      // the snap comes back in canvas pixels, so scale it into viewBox units.
      let tx = dx, ty = dy;
      if (snapRectsRef.current && ds.rects) {
        const { snapDx, snapDy } = snapRectsRef.current(
          ds.rects,
          new Set(ds.groups!.map(String)),
          (e.clientX - ds.startX) / z,
          (e.clientY - ds.startY) / z,
        );
        tx = snapDx * ds.vbScaleX;
        ty = snapDy * ds.vbScaleY;
      }
      const pt = (p: { x: number; y: number }) => ({ x: p.x + tx, y: p.y + ty });
      updatePathData(editingNodeId, {
        ...snap,
        subPaths: snap.subPaths.map((sp, i) => !gs.has(sp.group ?? i) ? sp : {
          ...sp,
          anchors: sp.anchors.map((a) => ({
            ...a,
            ...pt(a),
            handleIn: a.handleIn ? pt(a.handleIn) : undefined,
            handleOut: a.handleOut ? pt(a.handleOut) : undefined,
          })),
        }),
      });
    } else if (ds.type === "scale") {
      const snap = ds.snapshot!;
      const fx = ds.fixedX!, fy = ds.fixedY!;
      const spanX = ds.origX - fx, spanY = ds.origY - fy;
      let sx = Math.abs(spanX) < 1e-6 ? 1 : (ds.origX + dx - fx) / spanX;
      let sy = Math.abs(spanY) < 1e-6 ? 1 : (ds.origY + dy - fy) / spanY;
      // Shift keeps the proportions, the way every other scale handle does.
      if (e.shiftKey) { const u = Math.abs(sx) > Math.abs(sy) ? sx : sy; sx = u; sy = u; }
      const pt = (p: { x: number; y: number }) => ({ x: fx + (p.x - fx) * sx, y: fy + (p.y - fy) * sy });
      const gs = new Set(ds.groups!);
      updatePathData(editingNodeId, {
        ...snap,
        subPaths: snap.subPaths.map((sp, i) => !gs.has(sp.group ?? i) ? sp : {
          ...sp,
          anchors: sp.anchors.map((a) => ({
            ...a,
            ...pt(a),
            handleIn: a.handleIn ? pt(a.handleIn) : undefined,
            handleOut: a.handleOut ? pt(a.handleOut) : undefined,
          })),
        }),
      });
    } else if (ds.type === "anchor") {
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
      const ds = dragState.current;
      setIsDragging(false);
      dragState.current = null;
      clearGuidesRef.current?.();
      if (ds?.type === "translate" && !ds.moved) {
        setActiveGroup(ds.clickGroup!, ds.additive);
        return;
      }
      if (editingNodeId) {
        normalizePathBounds(editingNodeId);
        setTimeout(() => persistChanges(editingNodeId), 0);
      }
    }
  }, [isDragging, editingNodeId, persistChanges, normalizePathBounds, setActiveGroup]);

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

  const handleSimplify = useCallback(() => {
    if (!editingNodeId) return;
    const pathData = getPathData(editingNodeId);
    if (!pathData) return;
    updatePathData(editingNodeId, simplifyPathData(pathData), true);
    setSelectedPoints([]);
  }, [editingNodeId, getPathData, updatePathData]);

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
      // Step out one level at a time: out of the shape, then out of edit mode.
      if (enteredGroup !== null) setEnteredGroup(null);
      else if (activeGroups.length > 0) setActiveGroup(null);
      else exitEditMode();
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      handleDeleteSelected();
    }
    if (e.key === "j" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleJoinSelected();
    }
  }, [editingNodeId, activeGroups, enteredGroup, setActiveGroup, exitEditMode, handleDeleteSelected, handleJoinSelected]);

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
    activeGroups,
    enteredGroup,
    setActiveGroup,
    editTool,
    setEditTool,
    isDragging,
    enterEditMode,
    exitEditMode,
    getPathData,
    ensurePathData,
    handleGroupMovePointerDown,
    handleGroupScalePointerDown,
    handleAnchorPointerDown,
    handleHandlePointerDown,
    handleEditPointerMove,
    handleEditPointerUp,
    handleSegmentClick,
    handleDeleteSelected,
    handleSimplify,
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
