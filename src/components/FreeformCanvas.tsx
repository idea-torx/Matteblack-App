import { useRef, useCallback, useEffect, useLayoutEffect, useState, useMemo } from "react";
import { getDefaultFrameFill, getDefaultTextColor } from "../theme";

import { useAuth } from "../contexts/AuthContext";
import { useWorkspace } from "../contexts/WorkspaceContext";
import { getCanvasEntry } from "../services/CanvasStore";
import { enqueueDirty } from "../services/CanvasStore";
import { SyncStatusIndicator } from "./canvas/SyncStatusIndicator";
import { triggerLibrarySaveAnimation } from "../utils/flyToAnimation";
import { useNodeToolbar } from "../hooks/useNodeToolbar";
import { MediaModal } from "./MediaModal";
import { useResizeHandles } from "../hooks/useResizeHandles";
import { useRotateHandle } from "../hooks/useRotateHandle";
import { useFrameClipboard } from "../hooks/useFrameClipboard";
import { useFrameApi } from "../hooks/useFrameApi";
import { useShapeApi } from "../hooks/useShapeApi";
import { useTextApi } from "../hooks/useTextApi";
import { useTextDraw } from "../hooks/useTextDraw";
import { TextEditOverlay, type InFlightText } from "./canvas/TextEditOverlay";
import { useShapeDraw, ShapeDrawGhost } from "../hooks/useShapeDraw";
import { useSvgPathEdit } from "../hooks/useSvgPathEdit";
import { usePenDraw, PenDrawGhost } from "../hooks/usePenDraw";
import { useFreehandDraw, FreehandDrawGhost } from "../hooks/useFreehandDraw";
import { SvgNodeEditHandles } from "./canvas/SvgNodeEditHandles";
import { extractPathDataFromSvg, scalePathData } from "../utils/svgPathModel";
import type { PathData } from "../utils/svgPathModel";
import { performBooleanOp, type BooleanOpType } from "../utils/svgBooleanOps";
import { useLayerOrder } from "../hooks/canvas/useLayerOrder";
import { useCanvasLoader } from "../hooks/canvas/useCanvasLoader";
import { useCanvasDrop } from "../hooks/canvas/useCanvasDrop";
import { useCanvasLayout } from "../hooks/canvas/useCanvasLayout";
import { useSmartGuides } from "../hooks/canvas/useSmartGuides";
import { useCinemaCanvas } from "../features/cinema-canvas";
import {
  parseTimelineFromMetadata,
  serializeTimelineToMetadata,
  addClipToTrack,
  addVideoWithLinkedAudio,
} from "../features/cinema-frame/helpers/timelineState";
import { syncTimelineToServer, cancelTimelineSync } from "../features/cinema-frame/helpers/cinemaSync";
import { probeMediaDuration } from "../features/cinema-frame/helpers/probeMediaDuration";
import "./FreeformCanvas.css";

import type {
  ReferenceImage,
  CanvasNode,
  CanvasApi,
  ContextMenu,
  UndoCommand,
  PendingPlacement,
  FreeformCanvasProps,
} from "../types/canvas";
import {
  MIN_ZOOM,
  MAX_ZOOM,
  ZOOM_STEP,
  ZOOM_BASELINE,
  DEFAULT_GRID_SIZE,
} from "../types/canvas";
import {
  sortNodesReadingOrder,
  snapToGrid,
  clampDimensions,
  downloadAsset,
  saveNodeToLibraryOptimistic,
  findNodeInLibraryCache,
  isNodeInViewport,
} from "../utils/canvasUtils";
import type { LibraryMatch } from "../utils/canvasUtils";
import type { ResizeHandle } from "../hooks/useResizeHandles";
import { Minimap } from "./canvas/Minimap";
import { CanvasNodeComponent } from "./canvas/CanvasNodeComponent";
import { ZoomToolbar } from "./canvas/ZoomToolbar";
import {
  usePresenceChannel,
  useCursorBroadcast,
  RemoteCursorLayer,
  PresenceAvatarCluster,
} from "../features/presence";

export type { ReferenceImage, CanvasNode, PendingPlacement };

export function FreeformCanvas({
  selectedImageIds,
  onSelectImage,
  onSelectMultiple,
  onDeselectAll,
  onNodeMeta,
  onDropReference,
  onDropPrompt,
  onDropTrayItem,
  onCanvasReady,
  projectCanvasId,
  canvasFlushRef,
  onToolSelect,
  onLoadingChange,
  fitAllTrigger,
  firstFrameId,
  lastFrameId,
  pendingPlacement,
  onClearPendingPlacement,
  onConfirmPlacement,
  onLibrarySaved,
  presentMode,
  gridView,
  onToggleGridView,
  onTogglePresentMode,
  onCanvasApi,
  activeTool,
  designSubTool,
  onDesignSubToolChange,
  onActivateDesignTool,
  onCreateFrame,
  pendingShapeKind,
  onPendingShapeKindChange,
  onQuickRemoveBg,
  onSvgEditStateChange,
  onSyncStatusChange,
  onOpenLibrary,
  onRequestCinemaExport,
  projectName,
  onNodesChange,
  dotPulseKey,
}: FreeformCanvasProps) {
  const { activeWorkspace } = useWorkspace();
  const { signIn } = useAuth();
  const viewportRef = useRef<HTMLDivElement>(null);
  const { fullscreen, openFullscreen, closeFullscreen, downloadNode: rawDownloadNode, saveToLibrary: rawSaveToLibrary, savePrompt, deleteNode } = useNodeToolbar();

  const handleToolbarSave = useCallback((node: CanvasNode): Promise<{ ok: boolean }> => {
    return rawSaveToLibrary(node, () => onLibrarySaved?.());
  }, [rawSaveToLibrary, onLibrarySaved]);
  const [subtoolDropdown, setSubtoolDropdown] = useState<"frame" | "shape" | "svg" | null>(null);

  const initCache = useMemo(() => {
    if (!activeWorkspace?.id) return null;
    const key = projectCanvasId
      ? `ws:${activeWorkspace.id}:project:${projectCanvasId}`
      : `ws:${activeWorkspace.id}`;
    return getCanvasEntry(key);
  }, [activeWorkspace?.id, projectCanvasId]);

  const nextZRef = useRef(initCache?.nextZ ?? 1);
  const nextFrameZRef = useRef(-1000);
  const canvasIdRef = useRef<string | null>(initCache?.canvasId ?? null);
  const idMapRef = useRef(new Map<string, string>());
  const INFLIGHT_VIRTUAL_ID = "__inflight_new_text__";
  const inFlightTextRef = useRef<InFlightText | null>(null);

  const {
    nodes, setNodes,
    canvasId, setCanvasId,
    canvasLoaded: _canvasLoaded, setCanvasLoaded,
    canvasError, setCanvasError,
    panX, setPanX,
    panY, setPanY,
    zoom, setZoom,
    cacheKeyRef: _cacheKeyRef, loadIdRef, canvasLoadedRef,
    saveViewportDebounced: _saveViewportDebounced, saveNodesBatchDebounced,
    syncStatus, syncFailedSeconds, retrySyncNow,
    flushBeforeSwitch,
  } = useCanvasLoader({
    activeWorkspaceId: activeWorkspace?.id,
    projectCanvasId,
    onCanvasReady,
    onLoadingChange,
    initCache,
    nextZRef,
    nextFrameZRef,
    canvasIdRef,
    idMapRef,
    onIdRemapped: (localId, serverId) => {
      if (selectedImageIds.includes(localId)) {
        const next = selectedImageIds.map((id) => (id === localId ? serverId : id));
        onSelectMultiple?.(next);
      }
    },
  });

  const downloadNode = useCallback((node: CanvasNode) => {
    return rawDownloadNode(node, projectName, nodes);
  }, [rawDownloadNode, projectName, nodes]);

  useEffect(() => {
    onSyncStatusChange?.(syncStatus, syncFailedSeconds, retrySyncNow);
  }, [syncStatus, syncFailedSeconds, onSyncStatusChange, retrySyncNow]);

  const isCinema = useMemo(() => nodes.some((n) => n.node_type === "cinema"), [nodes]);
  const cinemaCanvas = useCinemaCanvas({
    nodes,
    selectedImageIds,
    onToolSelect: isCinema ? onToolSelect : undefined,
    activeTool,
  });

  const cinemaNodeSelectRef = useRef(cinemaCanvas.handleCinemaNodeSelect);
  cinemaNodeSelectRef.current = cinemaCanvas.handleCinemaNodeSelect;

  useEffect(() => {
    if (!isCinema) return;
    if (selectedImageIds.length !== 1) return;
    cinemaNodeSelectRef.current(selectedImageIds[0]);
  }, [isCinema, selectedImageIds]);

  useEffect(() => {
    if (canvasFlushRef) {
      canvasFlushRef.current = async () => {
        const flight = inFlightTextRef.current;
        if (flight) {
          handleInFlightCommitRef.current(flight.text);
        }
        await flushBeforeSwitch();
      };
    }
  }, [canvasFlushRef, flushBeforeSwitch]);

  const prevContainerLeftRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const newLeft = el.getBoundingClientRect().left;
    if (prevContainerLeftRef.current !== null) {
      const delta = prevContainerLeftRef.current - newLeft;
      // Skip sub-pixel deltas — these can be produced by mid-transition
      // layout reads and are noise that would otherwise feed back into
      // a pan-correction loop while a panel is animating in/out.
      if (Math.abs(delta) >= 0.5) {
        setPanX((prev) => prev + delta);
      }
    }
    prevContainerLeftRef.current = newLeft;
  }, [presentMode]);

  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [insideGroupId, setInsideGroupId] = useState<string | null>(null);

  const memberToGroupMap = useMemo(() => {
    const map = new Map<string, string>();
    nodes.forEach((n) => {
      if (n.node_type === "group" && Array.isArray(n.metadata?.members)) {
        (n.metadata.members as string[]).forEach((memberId) => {
          map.set(memberId, n.id);
        });
      }
    });
    return map;
  }, [nodes]);

  const selectedIds = useMemo(() => new Set(selectedImageIds), [selectedImageIds]);

  const downloadableNodes = useMemo(() => {
    if (selectedImageIds.length < 2) return [];
    return nodes.filter(
      (n) => selectedIds.has(n.id) && (n.node_type === "image" || n.node_type === "video" || n.node_type === "audio") && n.src && !n.src.startsWith("blob:")
    );
  }, [nodes, selectedIds, selectedImageIds.length]);

  const handleBulkDownload = useCallback(() => {
    if (downloadableNodes.length === 0) return;
    downloadableNodes.forEach(async (node) => {
      let ext = "";
      try {
        const pathname = new URL(node.src, window.location.origin).pathname;
        const lastSegment = pathname.split("/").pop() || "";
        const dotIdx = lastSegment.lastIndexOf(".");
        if (dotIdx > 0) ext = lastSegment.slice(dotIdx);
      } catch { /* ignore */ }
      if (!ext) ext = node.node_type === "audio" ? ".mp3" : node.node_type === "video" ? ".mp4" : ".png";
      let filename = node.label || `${node.node_type}-${node.id}`;
      if (!filename.includes(".")) filename += ext;
      try {
        const resp = await fetch(node.src);
        const blob = await resp.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = filename;
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);
      } catch {
        const a = document.createElement("a");
        a.href = node.src;
        a.download = filename;
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
    });
  }, [downloadableNodes]);

  const onNodesChangeRef = useRef(onNodesChange);
  onNodesChangeRef.current = onNodesChange;
  useEffect(() => {
    onNodesChangeRef.current?.(nodes);
  }, [nodes]);

  const nodesRef = useRef(nodes);
  /** Nodes that have been on screen at least once; see visibleNodeIds. */
  const mountedIds = useRef<Set<string>>(new Set());
  // Switching canvases makes every retained id dead weight.
  useEffect(() => { mountedIds.current.clear(); }, [canvasId]);
  nodesRef.current = nodes;
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  const panXRef = useRef(panX);
  panXRef.current = panX;
  const panYRef = useRef(panY);
  panYRef.current = panY;
  const onSelectImageRef = useRef(onSelectImage);
  onSelectImageRef.current = onSelectImage;
  const onDeselectAllRef = useRef(onDeselectAll);
  onDeselectAllRef.current = onDeselectAll;
  const onSelectMultipleRef = useRef(onSelectMultiple);
  onSelectMultipleRef.current = onSelectMultiple;
  const onToolSelectRef = useRef(onToolSelect);
  onToolSelectRef.current = onToolSelect;
  const onDropPromptRef = useRef(onDropPrompt);
  onDropPromptRef.current = onDropPrompt;
  const onQuickRemoveBgRef = useRef(onQuickRemoveBg);
  onQuickRemoveBgRef.current = onQuickRemoveBg;
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const contextMenuOpenRef = useRef(false);
  contextMenuOpenRef.current = !!contextMenu;
  const [libSaved, setLibSaved] = useState(false);
  const [libSaveError, setLibSaveError] = useState(false);
  const libSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [libMatch, setLibMatch] = useState<LibraryMatch | null>(null);
  const [libFolderMenuOpen, setLibFolderMenuOpen] = useState(false);
  const [libFolders, setLibFolders] = useState<Array<{ id: string; name: string }>>([]);
  const [libFoldersLoading, setLibFoldersLoading] = useState(false);
  const libFolderMenuTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchLibFolders = useCallback(() => {
    if (libFoldersLoading) return;
    setLibFoldersLoading(true);
    fetch("/api/folders?type=media", { credentials: "include" })
      .then((r) => {
        if (!r.ok) throw new Error("fetch failed");
        return r.json();
      })
      .then((data) => {
        const folders: Array<{ id: string; name: string }> = data.folders ?? [];
        const names = new Set(folders.map((f: { name: string }) => f.name));
        const defaults: Array<{ id: string; name: string }> = [];
        if (!names.has("Uploads")) defaults.push({ id: "", name: "Uploads" });
        if (!names.has("Generations")) defaults.push({ id: "", name: "Generations" });
        setLibFolders([...defaults, ...folders]);
      })
      .catch(() => {
        setLibFolders([{ id: "", name: "Uploads" }, { id: "", name: "Generations" }]);
      })
      .finally(() => setLibFoldersLoading(false));
  }, [libFoldersLoading]);

  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const panDidDrag = useRef(false);
  const spaceDown = useRef(false);
  const [zoomMode, setZoomMode] = useState(false);
  const [toolbarExpanded, setToolbarExpanded] = useState(false);
  const [marquee, setMarquee] = useState<{ startX: number; startY: number; currentX: number; currentY: number } | null>(null);
  const [frameDraw, setFrameDraw] = useState<{ startX: number; startY: number; currentX: number; currentY: number } | null>(null);
  const [cinemaGhost, setCinemaGhost] = useState<{
    cinemaNodeId: string;
    draggedNodeId: string;
    src: string;
    mediaType: "image" | "video" | "audio";
    aspectRatio: number;
    screenX: number;
    screenY: number;
    inside: boolean;
  } | null>(null);
  const cinemaGhostRef = useRef(cinemaGhost);
  cinemaGhostRef.current = cinemaGhost;
  const targetTrackIdRef = useRef<string | null>(null);
  const dropTimeRef = useRef<number | null>(null);
  const handleTargetTrackChange = useCallback((trackId: string | null, dropTime: number | null) => {
    targetTrackIdRef.current = trackId;
    dropTimeRef.current = dropTime;
  }, []);
  const [inFlightText, setInFlightText] = useState<InFlightText | null>(null);
  inFlightTextRef.current = inFlightText;
  const inFlightTextNodeId = inFlightText?.nodeId ?? null;
  const inFlightTextBounds = useMemo(() => {
    if (!inFlightText || !inFlightText.nodeId) return null;
    return {
      x: inFlightText.x,
      y: inFlightText.y,
      w: inFlightText.width,
      h: inFlightText.height,
    };
  }, [inFlightText]);
  const activeToolRef = useRef(activeTool);
  activeToolRef.current = activeTool;
  const designSubToolRef = useRef(designSubTool);
  designSubToolRef.current = designSubTool;
  const pendingShapeKindRef = useRef(pendingShapeKind || "rectangle");
  pendingShapeKindRef.current = pendingShapeKind || "rectangle";
  const onDesignSubToolChangeRef = useRef(onDesignSubToolChange);
  onDesignSubToolChangeRef.current = onDesignSubToolChange;
  const onPendingShapeKindChangeRef = useRef(onPendingShapeKindChange);
  onPendingShapeKindChangeRef.current = onPendingShapeKindChange;
  const addNodeAtPositionRef = useRef<((x: number, y: number, props: Partial<CanvasNode>) => CanvasNode) | null>(null);
  const textDrawZoomRef = useRef(zoom);
  textDrawZoomRef.current = zoom;

  const undoStack = useRef<UndoCommand[]>([]);
  const redoStack = useRef<UndoCommand[]>([]);
  const [, setUndoRedoVersion] = useState(0);

  const pushUndo = useCallback((cmd: UndoCommand) => {
    undoStack.current.push(cmd);
    if (undoStack.current.length > 100) undoStack.current.shift();
    redoStack.current = [];
    setUndoRedoVersion((v) => v + 1);
  }, []);

  const svgPathEdit = useSvgPathEdit({
    nodes,
    nodesRef,
    setNodes,
    zoom,
    pushUndo,
    canvasId,
    saveNodesBatchDebounced,
  });

  const penDrawHandlers = usePenDraw({
    viewportRef,
    panXRef,
    panYRef,
    zoomRef: textDrawZoomRef,
    addNodeAtPositionRef: addNodeAtPositionRef as React.MutableRefObject<((x: number, y: number, props: Record<string, unknown>) => unknown) | null>,
    onDeselectAllRef,
  });

  const freehandDrawHandlers = useFreehandDraw({
    viewportRef,
    panXRef,
    panYRef,
    zoomRef: textDrawZoomRef,
    addNodeAtPositionRef: addNodeAtPositionRef as React.MutableRefObject<((x: number, y: number, props: Record<string, unknown>) => unknown) | null>,
    onDeselectAllRef,
  });

  const svgEditPathDataForPanel = useMemo(() => {
    if (!svgPathEdit.editingNodeId) return null;
    const node = nodes.find((n) => n.id === svgPathEdit.editingNodeId);
    return (node?.metadata?.pathData as PathData) || null;
  }, [svgPathEdit.editingNodeId, nodes]);
  useEffect(() => {
    if (!onSvgEditStateChange) return;
    if (svgPathEdit.editingNodeId && svgEditPathDataForPanel) {
      onSvgEditStateChange({
        isEditing: true,
        selectedPoints: svgPathEdit.selectedPoints,
        pathData: svgEditPathDataForPanel,
      });
    } else {
      onSvgEditStateChange(null);
    }
  }, [svgPathEdit.editingNodeId, svgPathEdit.selectedPoints, svgEditPathDataForPanel, onSvgEditStateChange]);

  const shapeApiRef = useRef<{ addShapeAtPosition: (x: number, y: number, w: number, h: number, kind?: string, extraMeta?: Record<string, unknown>) => void } | null>(null);

  const shapeDrawHandlers = useShapeDraw({
    viewportRef,
    panXRef,
    panYRef,
    zoomRef: textDrawZoomRef,
    pendingShapeKindRef,
    shapeApiRef,
    onDesignSubToolChangeRef,
    onDeselectAllRef,
  });

  const textDrawHandlers = useTextDraw({
    panXRef,
    panYRef,
    zoomRef: textDrawZoomRef,
    onDesignSubToolChangeRef,
    onDeselectAllRef,
    setInFlightText,
  });

  const marqueeMousePos = useRef({ x: 0, y: 0 });
  const marqueeAddMode = useRef(false);
  const marqueeHitOrder = useRef<string[]>([]);
  const edgePanFrame = useRef<number | null>(null);
  const DRAG_THRESHOLD = 3;
  const pendingNodeDrag = useRef<{ x: number; y: number; nodeId: string } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, nodePositions: new Map<string, { x: number; y: number }>() });
  const didDragRef = useRef(false);
  const { guides: smartGuides, distanceLabels: smartDistanceLabels, computeSnap: computeSmartSnap, computeResizeSnap: computeSmartResizeSnap, clearGuides: clearSmartGuides } = useSmartGuides();

  const [editingFrameLabel, setEditingFrameLabel] = useState<string | null>(null);

  const renameFrame = useCallback((frameId: string, newLabel: string) => {
    const cId = canvasId;
    setNodes((prev) => prev.map((n) => n.id === frameId ? { ...n, label: newLabel } : n));
    if (cId) {
      saveNodesBatchDebounced(cId, [{ id: frameId, label: newLabel }]);
    }
  }, [canvasId, saveNodesBatchDebounced]);

  const groupResizeState = useRef<{
    handle: ResizeHandle;
    startX: number;
    startY: number;
    origBounds: { x: number; y: number; width: number; height: number };
    origMembers: Map<string, { x: number; y: number; width: number; height: number; metadata?: Record<string, unknown> | null }>;
    memberIds: string[];
  } | null>(null);
  const [, setIsGroupResizing] = useState(false);

  const finalizeGroupResize = useCallback(() => {
    const st = groupResizeState.current;
    if (!st) return;
    groupResizeState.current = null;
    setIsGroupResizing(false);
    const prevMembers = new Map(st.origMembers);
    const cId = canvasId;
    setNodes((latestNodes) => {
      const newPositions = new Map<string, { x: number; y: number; width: number; height: number; metadata?: Record<string, unknown> | null }>();
      const updated = latestNodes.map((n) => {
        const orig = st.origMembers.get(n.id);
        if (!orig) return n;
        let nextMeta: Record<string, unknown> | null | undefined = n.metadata;
        if (n.node_type === "svg" && orig.metadata && (orig.metadata as Record<string, unknown>).pathData) {
          const sx = orig.width === 0 ? 1 : n.width / orig.width;
          const sy = orig.height === 0 ? 1 : n.height / orig.height;
          if (sx !== 1 || sy !== 1) {
            const pd = (orig.metadata as Record<string, unknown>).pathData as PathData;
            nextMeta = { ...(n.metadata || {}), pathData: scalePathData(pd, sx, sy), originalWidth: n.width, originalHeight: n.height };
          }
        } else if (n.node_type === "frame") {
          nextMeta = { ...(n.metadata || {}), nativeWidth: n.width, nativeHeight: n.height };
        }
        const nextNode = nextMeta === n.metadata ? n : { ...n, metadata: nextMeta };
        newPositions.set(n.id, { x: nextNode.x, y: nextNode.y, width: nextNode.width, height: nextNode.height, metadata: nextNode.metadata });
        return nextNode;
      });
      pushUndo({
        type: "resize",
        undo: () => setNodes((prev) => prev.map((n) => {
          const p = prevMembers.get(n.id);
          return p ? { ...n, x: p.x, y: p.y, width: p.width, height: p.height, metadata: p.metadata ?? n.metadata } : n;
        })),
        redo: () => setNodes((prev) => prev.map((n) => {
          const p = newPositions.get(n.id);
          return p ? { ...n, x: p.x, y: p.y, width: p.width, height: p.height, metadata: p.metadata ?? n.metadata } : n;
        })),
      });
      if (cId) {
        const updates = st.memberIds.map((id) => {
          const n = updated.find((nd) => nd.id === id);
          if (!n) return null;
          return { id: n.id, x: n.x, y: n.y, width: n.width, height: n.height, metadata: n.metadata ?? undefined };
        }).filter((u): u is NonNullable<typeof u> => u !== null);
        if (updates.length > 0) saveNodesBatchDebounced(cId, updates);
      }
      return updated;
    });
  }, [canvasId, pushUndo, saveNodesBatchDebounced]);

  const [playingVideos, setPlayingVideos] = useState<Set<string>>(new Set());
  const [snapEnabled, setSnapEnabled] = useState(false);
  const [gridSize, setGridSize] = useState(DEFAULT_GRID_SIZE);
  const [showMinimap, setShowMinimap] = useState(false);
  const [viewportSize, setViewportSize] = useState({ w: 0, h: 0 });

  const undo = useCallback(() => {
    const cmd = undoStack.current.pop();
    if (!cmd) return;
    cmd.undo();
    redoStack.current.push(cmd);
    setUndoRedoVersion((v) => v + 1);
  }, []);

  const redo = useCallback(() => {
    const cmd = redoStack.current.pop();
    if (!cmd) return;
    cmd.redo();
    undoStack.current.push(cmd);
    setUndoRedoVersion((v) => v + 1);
  }, []);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    let rafId: number | null = null;
    let pending: { w: number; h: number } | null = null;
    const obs = new ResizeObserver((entries) => {
      const last = entries[entries.length - 1];
      if (!last) return;
      pending = { w: last.contentRect.width, h: last.contentRect.height };
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        const next = pending;
        pending = null;
        if (!next) return;
        setViewportSize((prev) => {
          if (prev.w === next.w && prev.h === next.h) return prev;
          return next;
        });
      });
    });
    obs.observe(el);
    return () => {
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      obs.disconnect();
    };
  }, []);

  const toggleVideoPlay = useCallback((nodeId: string) => {
    setPlayingVideos((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

  const { handleResizePointerDown, handleResizePointerMove, handleResizePointerUp } = useResizeHandles({
    zoom,
    nodes,
    nodesRef,
    setNodes,
    snapEnabled,
    gridSize,
    pushUndo,
    canvasId,
    saveNodesBatchDebounced,
    computeResizeSnap: computeSmartResizeSnap,
    clearSmartGuides,
    panX,
    panY,
    viewportSize,
  });

  const { isRotating, handleRotatePointerDown, handleRotatePointerMove, handleRotatePointerUp } = useRotateHandle({
    zoom,
    nodes,
    nodesRef,
    setNodes,
    pushUndo,
    canvasId,
    saveNodesBatchDebounced,
  });

  const nodesInFramesRef = useRef<Map<string, string>>(new Map());

  const { moveUp: layerMoveUp, moveDown: layerMoveDown, bringToTop: layerBringToTop, sendToBottom: layerSendToBottom } = useLayerOrder({
    nodesRef,
    selectedIdsRef,
    nodesInFramesRef,
    setNodes,
    pushUndo,
    canvasId,
    saveNodesBatchDebounced,
  });

  const screenToCanvas = useCallback((clientX: number, clientY: number) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (clientX - rect.left - panX) / zoom,
      y: (clientY - rect.top - panY) / zoom,
    };
  }, [panX, panY, zoom]);

  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  // --zoom exists only so chrome (outlines, handles, labels) can counter-scale
  // itself to stay 1px on screen. It lives on the transform container, i.e. the
  // root of every canvas node — so writing it invalidates style for the whole
  // subtree. During a wheel-zoom that is a full recalc of every node per frame,
  // which is why panning (transform only) is smooth and zooming is not, and why
  // it gets worse with more assets. Let the transform track zoom live and let
  // the counter-scale settle once the gesture stops; chrome being a fraction of
  // a pixel off mid-gesture is invisible.
  const [settledZoom, setSettledZoom] = useState(zoom);
  useEffect(() => {
    const t = setTimeout(() => setSettledZoom(zoom), 140);
    return () => clearTimeout(t);
  }, [zoom]);
  const zoomModeRef = useRef(zoomMode);
  zoomModeRef.current = zoomMode;

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (contextMenuOpenRef.current) return;
      const isZoomGesture = e.ctrlKey || e.metaKey || zoomModeRef.current;
      if (isZoomGesture && e.deltaY !== 0) {
        const rect = el.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const currentZoom = zoomRef.current;
        let newZoom: number;
        if (e.ctrlKey || e.metaKey) {
          const rawDelta = -e.deltaY * 0.008;
          const clampedDelta = Math.max(-0.3, Math.min(0.3, rawDelta));
          newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, currentZoom * (1 + clampedDelta)));
        } else {
          const direction = e.deltaY > 0 ? -1 : 1;
          const factor = 1 + direction * 0.08;
          newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, currentZoom * factor));
        }
        if (newZoom !== currentZoom) {
          const scale = newZoom / currentZoom;
          setPanX((prev) => mouseX - (mouseX - prev) * scale);
          setPanY((prev) => mouseY - (mouseY - prev) * scale);
          zoomRef.current = newZoom;
          setZoom(newZoom);
        }
      } else {
        if (Math.abs(e.deltaX) > 0) {
          setPanX((prev) => prev - e.deltaX);
        }
        if (Math.abs(e.deltaY) > 0) {
          setPanY((prev) => prev - e.deltaY);
        }
      }
    };
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, []);

  const handleViewportPointerDown = useCallback((e: React.PointerEvent) => {
    if (contextMenuOpenRef.current) {
      setContextMenu(null);
      return;
    }
    if (svgPathEdit.editingNodeId) {
      const subTool = designSubToolRef.current;
      const isDrawingTool = e.button === 0 && activeTool === "design" && (subTool === "pen" || subTool === "draw" || subTool === "frame" || subTool === "shape" || subTool === "text");
      if (isDrawingTool) {
        svgPathEdit.exitEditMode();
      } else if (e.button === 1 || (e.button === 0 && spaceDown.current)) {
      } else if (e.button === 0 && (e.target === viewportRef.current || (e.target as HTMLElement).classList.contains("freeform-canvas__grid"))) {
        const rect = viewportRef.current!.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        setMarquee({ startX: sx, startY: sy, currentX: sx, currentY: sy });
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        svgPathEdit.selectPointsInRect(0, 0, 0, 0);
        return;
      } else {
        return;
      }
    }
    if (inFlightTextRef.current) {
      const age = Date.now() - (inFlightTextRef.current._createdAt ?? 0);
      if (age > 150) {
        handleInFlightCommitRef.current(inFlightTextRef.current.text);
        if (e.button === 0 && !spaceDown.current && activeTool === "design" && designSubToolRef.current === "text") {
          return;
        }
      }
    }
    if (e.button === 1 || (e.button === 0 && spaceDown.current)) {
      panDidDrag.current = false;
      setIsPanning(true);
      panStart.current = { x: e.clientX, y: e.clientY, panX, panY };
      viewportRef.current?.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (e.button === 0 && activeTool === "design") {
      const subTool = designSubToolRef.current;
      if (subTool === "frame" || subTool === "shape" || subTool === "text" || subTool === "pen" || subTool === "draw") {
        if (subTool === "pen") {
          penDrawHandlers.handlePenPointerDown(e);
          return;
        }
        if (subTool === "draw") {
          freehandDrawHandlers.handleFreehandPointerDown(e);
          return;
        }
        const rect = viewportRef.current!.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        if (subTool === "frame") {
          setFrameDraw({ startX: sx, startY: sy, currentX: sx, currentY: sy });
          viewportRef.current?.setPointerCapture(e.pointerId);
          if (onDeselectAllRef.current) onDeselectAllRef.current();
          return;
        }
        if (subTool === "shape") {
          shapeDrawHandlers.handleShapeDrawStart(e, rect);
          return;
        }
        if (subTool === "text") {
          textDrawHandlers.handleTextDrawStart(e, rect);
          return;
        }
      }
    }
    if (e.target !== viewportRef.current && !(e.target as HTMLElement).classList.contains("freeform-canvas__grid")) return;
    if (e.button === 0) {
      const rect = viewportRef.current!.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      marqueeAddMode.current = e.shiftKey;
      marqueeHitOrder.current = [];
      setMarquee({ startX: sx, startY: sy, currentX: sx, currentY: sy });
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      if (!marqueeAddMode.current && onDeselectAllRef.current) {
        if (insideGroupId) {
          setInsideGroupId(null);
          onDeselectAllRef.current();
        } else {
          onDeselectAllRef.current();
          setActiveGroupId(null);
          // Deselecting used to also swing the rail over to the Toolkit when a
          // make-tool was active. A click that misses a node — which happens
          // whenever a node is mid-remount at the viewport edge — then reads as
          // "clicked my video, got sent to the Toolkit". Deselect deselects.
        }
      }
    }
  }, [panX, panY, activeTool, insideGroupId]);

  const emitNodeMeta = useCallback((effectiveId: string, node: CanvasNode) => {
    if (!onNodeMeta) return;
    const w = node.width || 256;
    const h = node.height || 256;
    const ratio = w / h;
    const arOptions = [
      { label: "1:1", value: 1 },
      { label: "4:3", value: 4/3 },
      { label: "3:4", value: 3/4 },
      { label: "16:9", value: 16/9 },
      { label: "9:16", value: 9/16 },
      { label: "21:9", value: 21/9 },
      { label: "9:21", value: 9/21 },
      { label: "3:2", value: 3/2 },
      { label: "2:3", value: 2/3 },
    ];
    let closest = arOptions[0];
    let minDiff = Math.abs(ratio - closest.value);
    for (const opt of arOptions) {
      const diff = Math.abs(ratio - opt.value);
      if (diff < minDiff) { closest = opt; minDiff = diff; }
    }
    const axiomImages = Array.isArray(node.metadata?.axiomImages) ? node.metadata.axiomImages as string[] : undefined;
    const axiomName = node.metadata?.axiomName as string | undefined;
    const axiomDescription = node.metadata?.axiomDescription as string | undefined;
    let gradientUrl = node.src || node.gradient || "";
    // Some image nodes only carry their URL inside a CSS `url("…")` wrapper
    // (e.g. background-image-rendered transparents from BG removal / upscale).
    // Unwrap before the scheme check so the agent panel actually receives them.
    if (gradientUrl.startsWith("url(")) {
      const m = gradientUrl.match(/url\((['"]?)([^'")]+)\1\)/);
      gradientUrl = m ? m[2] : "";
    }
    if (gradientUrl && gradientUrl.startsWith("/")) {
      gradientUrl = `${window.location.origin}${gradientUrl}`;
    }
    if (gradientUrl && !gradientUrl.startsWith("http://") && !gradientUrl.startsWith("https://") && !gradientUrl.startsWith("data:")) {
      gradientUrl = "";
    }
    onNodeMeta(effectiveId, {
      id: effectiveId,
      label: node.label || "Canvas Node",
      gradient: gradientUrl,
      aspectRatio: closest.label,
      axiomImages,
      axiomName,
      axiomDescription,
      nodeType: node.node_type === "video" ? "video" : node.node_type === "svg" ? "svg" : node.node_type === "group" ? "group" : node.node_type === "frame" ? "frame" : node.node_type === "shape" ? "shape" : node.node_type === "text" ? "text" : node.node_type === "cinema" ? "cinema" : node.node_type === "image" ? "image" : undefined,
      fontFamily: node.node_type === "text" ? (node.metadata?.fontFamily as string) || "Inter, sans-serif" : undefined,
      fontWeight: node.node_type === "text" ? (node.metadata?.fontWeight as number) || 400 : undefined,
      fontSize: node.node_type === "text" ? (node.metadata?.fontSize as number) || 48 : undefined,
      color: node.node_type === "text" ? (node.metadata?.color as string) || getDefaultTextColor() : undefined,
      textAlign: node.node_type === "text" ? (node.metadata?.textAlign as string) || "left" : undefined,
      textContent: node.node_type === "text" ? (node.metadata?.textContent as string) || "" : undefined,
      letterSpacing: node.node_type === "text" ? (node.metadata?.letterSpacing as number) || 0 : undefined,
      lineHeight: node.node_type === "text" ? (node.metadata?.lineHeight as number) || 120 : undefined,
      fill: node.node_type === "frame" ? (node.metadata?.fill as string) || "#1a1a2e" : node.node_type === "shape" ? (node.metadata?.fill as string) || "#5b5fc7" : undefined,
      x: node.x,
      y: node.y,
      width: w,
      height: h,
      rotation: node.rotation || 0,
      borderRadius: (node.metadata as Record<string, unknown>)?.borderRadius as number | undefined,
      shapeKind: node.node_type === "shape" ? (node.metadata?.shapeKind as string) || "rectangle" : undefined,
      stroke: node.node_type === "shape" ? (node.metadata?.stroke as string) || "none" : (node.metadata?.stroke as string) || undefined,
      strokeWidth: node.node_type === "shape" ? (node.metadata?.strokeWidth as number) || 0 : (node.metadata?.strokeWidth as number) || undefined,
      opacity: (node.metadata?.opacity as number) ?? 100,
      pathData: node.node_type === "svg" ? (node.metadata?.pathData as Record<string, unknown>) : undefined,
      timelineState: node.node_type === "cinema" ? node.metadata?.timelineState : undefined,
      duration: node.node_type === "video" ? ((node.metadata as Record<string, unknown>)?.duration as number | undefined) : undefined,
    } as ReferenceImage);
  }, [onNodeMeta]);

  const emitNodeMetaRef = useRef(emitNodeMeta);
  emitNodeMetaRef.current = emitNodeMeta;

  const handleCinemaMetaUpdate = useCallback((nodeId: string, updatedNode: CanvasNode) => {
    emitNodeMetaRef.current(nodeId, updatedNode);
  }, []);

  const handleViewportPointerMove = useCallback((e: React.PointerEvent) => {
    if (isPanning) {
      const dx = e.clientX - panStart.current.x;
      const dy = e.clientY - panStart.current.y;
      if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
        panDidDrag.current = true;
      }
      setPanX(panStart.current.panX + dx);
      setPanY(panStart.current.panY + dy);
    } else if (frameDraw) {
      const rect = viewportRef.current!.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      setFrameDraw((prev) => prev ? { ...prev, currentX: cx, currentY: cy } : null);
    } else if (shapeDrawHandlers.shapeDraw) {
      const rect = viewportRef.current!.getBoundingClientRect();
      shapeDrawHandlers.handleShapeDrawMove(e, rect);
    } else if (textDrawHandlers.textDraw) {
      const rect = viewportRef.current!.getBoundingClientRect();
      textDrawHandlers.handleTextDrawMove(e, rect);
    } else if (penDrawHandlers.penState) {
      penDrawHandlers.handlePenPointerMove(e);
    } else if (freehandDrawHandlers.freehandState) {
      freehandDrawHandlers.handleFreehandPointerMove(e);
    } else if (marquee) {
      const rect = viewportRef.current!.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      marqueeMousePos.current = { x: cx, y: cy };
      setMarquee((prev) => prev ? { ...prev, currentX: cx, currentY: cy } : null);

      const left = Math.min(marquee.startX, cx);
      const top = Math.min(marquee.startY, cy);
      const right = Math.max(marquee.startX, cx);
      const bottom = Math.max(marquee.startY, cy);

      if (right - left > 3 || bottom - top > 3) {
        const worldLeft = (left - panX) / zoom;
        const worldTop = (top - panY) / zoom;
        const worldRight = (right - panX) / zoom;
        const worldBottom = (bottom - panY) / zoom;

        if (svgPathEdit.editingNodeId) {
          svgPathEdit.selectPointsInRect(worldLeft, worldTop, worldRight, worldBottom);
          return;
        }

        const hitSet = new Set<string>();
        const hitNodeMap = new Map<string, typeof nodes[0]>();
        for (const n of nodes) {
          if (n.node_type === "group") continue;
          if (n.node_type === "frame") {
            const handleTop = n.y - 30 / zoom;
            const handleBottom = n.y;
            const handleLeft = n.x;
            const handleRight = n.x + n.width;
            if (handleLeft < worldRight && handleRight > worldLeft && handleTop < worldBottom && handleBottom > worldTop) {
              hitSet.add(n.id);
              hitNodeMap.set(n.id, n);
            }
            continue;
          }
          const nRight = n.x + n.width;
          const nBottom = n.y + n.height;
          if (n.x < worldRight && nRight > worldLeft && n.y < worldBottom && nBottom > worldTop) {
            hitSet.add(n.id);
            hitNodeMap.set(n.id, n);
          }
        }

        const prev = marqueeHitOrder.current;
        const kept = prev.filter((id) => hitSet.has(id));
        const keptSet = new Set(kept);
        const newIds: string[] = [];
        hitSet.forEach((id) => { if (!keptSet.has(id)) newIds.push(id); });
        const ordered = [...kept, ...newIds];
        marqueeHitOrder.current = ordered;

        for (const id of ordered) {
          const node = hitNodeMap.get(id);
          if (node) emitNodeMeta(id, node);
        }

        if (onSelectMultipleRef.current) {
          onSelectMultipleRef.current(ordered, marqueeAddMode.current ? "add" : "exclusive");
        }
      }
    }
  }, [isPanning, frameDraw, shapeDrawHandlers.shapeDraw, textDrawHandlers.textDraw, penDrawHandlers.penState, freehandDrawHandlers.freehandState, marquee, panX, panY, zoom, nodes, emitNodeMeta, svgPathEdit.editingNodeId, svgPathEdit.selectPointsInRect]);

  const handleViewportPointerUp = useCallback(() => {
    if (frameDraw) {
      const left = Math.min(frameDraw.startX, frameDraw.currentX);
      const top = Math.min(frameDraw.startY, frameDraw.currentY);
      const w = Math.abs(frameDraw.currentX - frameDraw.startX);
      const h = Math.abs(frameDraw.currentY - frameDraw.startY);
      const MIN_FRAME = 32;
      if (w / zoom >= MIN_FRAME && h / zoom >= MIN_FRAME) {
        const worldX = (left - panX) / zoom;
        const worldY = (top - panY) / zoom;
        const worldW = Math.round(w / zoom);
        const worldH = Math.round(h / zoom);
        const existingFrames = nodesRef.current.filter((n) => n.node_type === "frame");
        const frameNums = existingFrames
          .map((n) => n.label?.match(/^Frame (\d+)$/)?.[1])
          .filter(Boolean)
          .map(Number);
        const nextNum = frameNums.length > 0 ? Math.max(...frameNums) + 1 : 1;
        const newFrame = addNodeAtPositionRef.current?.(worldX, worldY, {
          node_type: "frame",
          width: worldW,
          height: worldH,
          label: `Frame ${nextNum}`,
          metadata: { fill: getDefaultFrameFill(), nativeWidth: worldW, nativeHeight: worldH },
        });
        if (newFrame) {
          emitNodeMetaRef.current(newFrame.id, newFrame);
          onSelectImageRef.current(newFrame.id, "exclusive");
        }
      }
      setFrameDraw(null);
      if (onDesignSubToolChangeRef.current) onDesignSubToolChangeRef.current("select");
      return;
    }
    if (shapeDrawHandlers.shapeDraw) {
      shapeDrawHandlers.handleShapeDrawEnd();
      return;
    }
    if (textDrawHandlers.textDraw) {
      textDrawHandlers.handleTextDrawEnd();
      return;
    }
    if (penDrawHandlers.penState) {
      penDrawHandlers.handlePenPointerUp();
      return;
    }
    if (freehandDrawHandlers.freehandState) {
      freehandDrawHandlers.handleFreehandPointerUp();
      return;
    }
    if (marquee) {
      setMarquee(null);
    }
    setIsPanning(false);
  }, [frameDraw, shapeDrawHandlers.shapeDraw, textDrawHandlers.textDraw, penDrawHandlers.penState, freehandDrawHandlers.freehandState, marquee, panX, panY, zoom]);

  const EDGE_PAN_ZONE = 40;
  const EDGE_PAN_MAX_SPEED = 16;

  useEffect(() => {
    if (!marquee) {
      if (edgePanFrame.current !== null) {
        cancelAnimationFrame(edgePanFrame.current);
        edgePanFrame.current = null;
      }
      return;
    }
    const getOverlayInsets = (canvasRect: DOMRect) => {
      let rightInset = 0;
      let bottomInset = 0;
      let leftInset = 0;
      let topInset = 0;
      document.querySelectorAll(".rpanel, .gen-tray, .node-inspector").forEach((panel) => {
        const pr = (panel as HTMLElement).getBoundingClientRect();
        if (pr.width === 0 || pr.height === 0) return;
        if (pr.left < canvasRect.right && pr.right > canvasRect.left && pr.top < canvasRect.bottom && pr.bottom > canvasRect.top) {
          if (pr.right >= canvasRect.right - 1) rightInset = Math.max(rightInset, canvasRect.right - pr.left);
          if (pr.left <= canvasRect.left + 1) leftInset = Math.max(leftInset, pr.right - canvasRect.left);
          if (pr.bottom >= canvasRect.bottom - 1) bottomInset = Math.max(bottomInset, canvasRect.bottom - pr.top);
          if (pr.top <= canvasRect.top + 1) topInset = Math.max(topInset, pr.bottom - canvasRect.top);
        }
      });
      return { leftInset, rightInset, topInset, bottomInset };
    };
    const tick = () => {
      const el = viewportRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const { leftInset, rightInset, topInset, bottomInset } = getOverlayInsets(rect);
      const mx = marqueeMousePos.current.x;
      const my = marqueeMousePos.current.y;
      const effectiveLeft = leftInset;
      const effectiveRight = rect.width - rightInset;
      const effectiveTop = topInset;
      const effectiveBottom = rect.height - bottomInset;

      let dx = 0;
      let dy = 0;
      if (mx < effectiveLeft + EDGE_PAN_ZONE && mx > effectiveLeft) dx = EDGE_PAN_MAX_SPEED * ((effectiveLeft + EDGE_PAN_ZONE - mx) / EDGE_PAN_ZONE);
      else if (mx > effectiveRight - EDGE_PAN_ZONE && mx < effectiveRight) dx = -EDGE_PAN_MAX_SPEED * ((mx - (effectiveRight - EDGE_PAN_ZONE)) / EDGE_PAN_ZONE);
      if (my < effectiveTop + EDGE_PAN_ZONE && my > effectiveTop) dy = EDGE_PAN_MAX_SPEED * ((effectiveTop + EDGE_PAN_ZONE - my) / EDGE_PAN_ZONE);
      else if (my > effectiveBottom - EDGE_PAN_ZONE && my < effectiveBottom) dy = -EDGE_PAN_MAX_SPEED * ((my - (effectiveBottom - EDGE_PAN_ZONE)) / EDGE_PAN_ZONE);

      if (dx !== 0 || dy !== 0) {
        setPanX((prev) => prev + dx);
        setPanY((prev) => prev + dy);
        setMarquee((prev) => prev ? { ...prev, startX: prev.startX + dx, startY: prev.startY + dy } : null);
      }
      edgePanFrame.current = requestAnimationFrame(tick);
    };
    edgePanFrame.current = requestAnimationFrame(tick);
    return () => {
      if (edgePanFrame.current !== null) {
        cancelAnimationFrame(edgePanFrame.current);
        edgePanFrame.current = null;
      }
    };
  }, [marquee !== null]);

  const startNodeDrag = useCallback((clientX: number, clientY: number, effectiveId: string) => {
    setIsDragging(true);
    const positions = new Map<string, { x: number; y: number }>();
    const idsToMove = new Set<string>();

    const draggedGroupId = memberToGroupMap.get(effectiveId);
    if (activeGroupId && !insideGroupId && draggedGroupId === activeGroupId) {
      const gNode = nodes.find((n) => n.id === activeGroupId);
      if (gNode && Array.isArray(gNode.metadata?.members)) {
        (gNode.metadata.members as string[]).forEach((mid) => idsToMove.add(mid));
      }
    } else {
      const currentSelected = new Set(selectedIds);
      currentSelected.add(effectiveId);

      currentSelected.forEach((id) => {
        idsToMove.add(id);
        const gNode = nodes.find((n) => n.id === id);
        if (gNode?.node_type === "frame") {
          nodes.forEach((n) => {
            if (n.id === id || n.node_type === "frame" || n.node_type === "group") return;
            const cx = n.x + n.width / 2;
            const cy = n.y + n.height / 2;
            if (cx >= gNode.x && cx <= gNode.x + gNode.width && cy >= gNode.y && cy <= gNode.y + gNode.height) {
              idsToMove.add(n.id);
            }
          });
        }
      });
    }

    nodes.forEach((n) => {
      if (idsToMove.has(n.id)) {
        positions.set(n.id, { x: n.x, y: n.y });
      }
    });
    dragStart.current = { x: clientX, y: clientY, nodePositions: positions };
  }, [nodes, selectedIds, activeGroupId, insideGroupId, memberToGroupMap]);

  const handleNodePointerDown = useCallback((e: React.PointerEvent, nodeId: string) => {
    if (contextMenuOpenRef.current) {
      setContextMenu(null);
      return;
    }

    if (svgPathEdit.editingNodeId === nodeId) {
      return;
    }

    if (e.button === 0 && activeToolRef.current === "design") {
      const subTool = designSubToolRef.current;
      if (subTool === "frame" || subTool === "shape" || subTool === "text" || subTool === "pen" || subTool === "draw") {
        return;
      }
    }

    if (e.button === 1 || (e.button === 0 && spaceDown.current)) {
      return;
    }

    e.stopPropagation();

    if (e.button !== 0) return;

    if (spaceDown.current) {
      setIsPanning(true);
      panStart.current = { x: e.clientX, y: e.clientY, panX: panXRef.current, panY: panYRef.current };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }

    const node = nodesRef.current.find((n) => n.id === nodeId);
    if (node?.locked) return;

    const isFrameNode = node?.node_type === "frame";
    const isFrameSelected = isFrameNode && selectedIdsRef.current.has(nodeId);
    const isFrameLabelDrag = isFrameNode && (e.target as HTMLElement).closest("[data-frame-label]") !== null;

    if (isFrameNode && !isFrameLabelDrag && !isFrameSelected) {
      const frameHasChildren = node && Array.from(nodesInFramesRef.current.values()).some((fid) => fid === node.id);
      if (frameHasChildren) {
        return;
      }
    }

    const groupId = memberToGroupMap.get(nodeId);
    if (groupId && !insideGroupId) {
      didDragRef.current = false;
      setActiveGroupId(groupId);
      pendingNodeDrag.current = { x: e.clientX, y: e.clientY, nodeId };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }

    didDragRef.current = false;

    const alreadySelected = selectedIdsRef.current.has(nodeId);

    if (alreadySelected && !e.shiftKey) {
      pendingNodeDrag.current = { x: e.clientX, y: e.clientY, nodeId };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } else if (!alreadySelected && !e.shiftKey) {
      if (onDeselectAllRef.current) onDeselectAllRef.current();
      onSelectImageRef.current(nodeId, "exclusive");
      if (node) emitNodeMetaRef.current(nodeId, node);
      pendingNodeDrag.current = { x: e.clientX, y: e.clientY, nodeId };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    }
  }, [memberToGroupMap, insideGroupId, svgPathEdit.editingNodeId]);

  const handleNodePointerMove = useCallback((e: React.PointerEvent) => {
    if (pendingNodeDrag.current) {
      const dx = e.clientX - pendingNodeDrag.current.x;
      const dy = e.clientY - pendingNodeDrag.current.y;
      if (Math.abs(dx) >= DRAG_THRESHOLD || Math.abs(dy) >= DRAG_THRESHOLD) {
        const pending = pendingNodeDrag.current;
        pendingNodeDrag.current = null;
        startNodeDrag(pending.x, pending.y, pending.nodeId);
      }
      return;
    }
    if (!isDragging) return;
    didDragRef.current = true;
    let dx = (e.clientX - dragStart.current.x) / zoom;
    let dy = (e.clientY - dragStart.current.y) / zoom;

    if (snapEnabled) {
      const firstPos = dragStart.current.nodePositions.values().next().value;
      if (firstPos) {
        const snappedX = snapToGrid(firstPos.x + dx, gridSize);
        const snappedY = snapToGrid(firstPos.y + dy, gridSize);
        dx = snappedX - firstPos.x;
        dy = snappedY - firstPos.y;
      }
    }

    {
      const draggedIds = new Set(dragStart.current.nodePositions.keys());
      const vw = viewportSize.w || window.innerWidth;
      const vh = viewportSize.h || window.innerHeight;
      const origNodes = nodes.map((n) => {
        const orig = dragStart.current.nodePositions.get(n.id);
        return orig ? { ...n, x: orig.x, y: orig.y } : n;
      });
      const { snapDx, snapDy } = computeSmartSnap(origNodes, draggedIds, dx, dy, zoom, panX, panY, vw, vh);
      dx = snapDx;
      dy = snapDy;
    }

    let cinemaProximity = false;
    const movedIds = Array.from(dragStart.current.nodePositions.keys());
    if (movedIds.length === 1) {
      const draggedId = movedIds[0];
      const draggedNode = nodesRef.current.find((n) => n.id === draggedId);
      if (draggedNode && draggedNode.src && (draggedNode.node_type === "video" || draggedNode.node_type === "audio")) {
        const orig = dragStart.current.nodePositions.get(draggedId);
        const nx = (orig?.x ?? draggedNode.x) + dx;
        const ny = (orig?.y ?? draggedNode.y) + dy;
        const ncx = nx + draggedNode.width / 2;
        const ncy = ny + draggedNode.height / 2;
        const PROXIMITY = 200;
        for (const cn of nodesRef.current) {
          if (cn.node_type !== "cinema" || cn.id === draggedId) continue;
          const inside = ncx >= cn.x && ncx <= cn.x + cn.width && ncy >= cn.y && ncy <= cn.y + cn.height;
          const near = ncx >= cn.x - PROXIMITY && ncx <= cn.x + cn.width + PROXIMITY && ncy >= cn.y - PROXIMITY && ncy <= cn.y + cn.height + PROXIMITY;
          if (inside || near) {
            cinemaProximity = true;
            setCinemaGhost({
              cinemaNodeId: cn.id,
              draggedNodeId: draggedId,
              src: draggedNode.src,
              mediaType: draggedNode.node_type as "image" | "video" | "audio",
              aspectRatio: draggedNode.width / Math.max(1, draggedNode.height),
              screenX: e.clientX,
              screenY: e.clientY,
              inside,
            });
            break;
          }
        }
        if (!cinemaProximity) {
          setCinemaGhost(null);
          targetTrackIdRef.current = null;
          dropTimeRef.current = null;
        }
      }
    }

    if (cinemaProximity) {
      setNodes((prev) => prev.map((n) => {
        const orig = dragStart.current.nodePositions.get(n.id);
        if (!orig) return n;
        return { ...n, x: orig.x, y: orig.y };
      }));
    } else {
      setNodes((prev) => prev.map((n) => {
        const orig = dragStart.current.nodePositions.get(n.id);
        if (!orig) return n;
        return { ...n, x: orig.x + dx, y: orig.y + dy };
      }));
    }
  }, [isDragging, zoom, snapEnabled, gridSize, startNodeDrag, nodes, panX, panY, viewportSize, computeSmartSnap]);

  const handleNodePointerUp = useCallback(() => {
    if (pendingNodeDrag.current) {
      pendingNodeDrag.current = null;
    }
    if (isDragging) {
      const prevPositions = new Map(dragStart.current.nodePositions);
      const currentNodes = nodesRef.current;
      const movedIds = Array.from(prevPositions.keys());
      const newPositions = new Map<string, { x: number; y: number }>();
      movedIds.forEach((id) => {
        const n = currentNodes.find((node) => node.id === id);
        if (n) newPositions.set(id, { x: n.x, y: n.y });
      });

      let absorbedByCinema = false;

      if (didDragRef.current && movedIds.length === 1) {
        const draggedNode = currentNodes.find((n) => n.id === movedIds[0]);
        if (draggedNode && (draggedNode.node_type === "video" || draggedNode.node_type === "audio")) {
          const ghost = cinemaGhostRef.current;
          const cinemaNode = ghost && ghost.draggedNodeId === draggedNode.id
            ? currentNodes.find((n) => n.id === ghost.cinemaNodeId)
            : (() => {
                const cx = draggedNode.x + draggedNode.width / 2;
                const cy = draggedNode.y + draggedNode.height / 2;
                return currentNodes.find((n) =>
                  n.node_type === "cinema" &&
                  n.id !== draggedNode.id &&
                  cx >= n.x && cx <= n.x + n.width &&
                  cy >= n.y && cy <= n.y + n.height
                );
              })();
          if (cinemaNode && draggedNode.src) {
            absorbedByCinema = true;
            const clipType = draggedNode.node_type === "audio" ? "audio" as const : draggedNode.node_type === "video" ? "video" as const : "image" as const;
            const cinemaId = cinemaNode.id;
            const nodeSrc = draggedNode.src;
            const nodeId = draggedNode.id;
            const nodeLabel = draggedNode.label || "";
            const metaDur = (draggedNode.metadata as Record<string, unknown>)?.duration as number;

            setNodes((prev) => prev.map((n) => {
              const origPos = prevPositions.get(n.id);
              if (origPos) return { ...n, x: origPos.x, y: origPos.y };
              return n;
            }));

            const capturedTargetTrackId = targetTrackIdRef.current;
            const capturedDropTime = dropTimeRef.current ?? undefined;

            (async () => {
              const providedDur = typeof metaDur === "number" && metaDur > 0 ? metaDur : 0;
              const duration = providedDur || await probeMediaDuration(nodeSrc, clipType);
              const newClip = {
                id: crypto.randomUUID(),
                sourceNodeId: nodeId,
                src: nodeSrc,
                type: clipType,
                duration,
                label: nodeLabel,
              };
              let capturedPrevMeta: Record<string, unknown> | null = null;
              let capturedNewMeta: Record<string, unknown> | null = null;
              setNodes((prev) => prev.map((n) => {
                if (n.id !== cinemaId) return n;
                const latestMeta = (n.metadata || {}) as Record<string, unknown>;
                capturedPrevMeta = latestMeta;
                const latestTimeline = parseTimelineFromMetadata(latestMeta);
                let updatedTimeline;
                if (clipType === "video") {
                  const videoTrackId = capturedTargetTrackId && latestTimeline.tracks.find((t) => t.id === capturedTargetTrackId && t.type === "video")
                    ? capturedTargetTrackId
                    : latestTimeline.tracks.find((t) => t.type === "video")?.id || crypto.randomUUID();
                  const audioClipId = crypto.randomUUID();
                  updatedTimeline = addVideoWithLinkedAudio(latestTimeline, videoTrackId, newClip, audioClipId, capturedDropTime);
                } else {
                  const trackType = clipType === "audio" ? "audio" : "video";
                  const fallbackId = latestTimeline.tracks.find((t) => t.type === (clipType === "audio" ? "audio" : "video"))?.id || crypto.randomUUID();
                  const targetTrackId = capturedTargetTrackId && latestTimeline.tracks.find((t) => t.id === capturedTargetTrackId && t.type === trackType)
                    ? capturedTargetTrackId
                    : latestTimeline.tracks.find((t) => t.type === trackType)?.id || fallbackId;
                  updatedTimeline = addClipToTrack(latestTimeline, targetTrackId, newClip, capturedDropTime);
                }
                const newMeta = serializeTimelineToMetadata(latestMeta, updatedTimeline);
                capturedNewMeta = newMeta;
                return { ...n, metadata: newMeta };
              }));
              if (canvasId && capturedNewMeta) {
                enqueueDirty({ type: "update", canvasId, nodeId: cinemaId, fields: { metadata: capturedNewMeta }, committed: true });
                const prevTimeline = capturedPrevMeta ? parseTimelineFromMetadata(capturedPrevMeta) : parseTimelineFromMetadata({});
                const nextTimeline = parseTimelineFromMetadata(capturedNewMeta);
                syncTimelineToServer(canvasId, cinemaId, prevTimeline, nextTimeline).catch((err) => {
                  console.error("[FreeformCanvas] cinema sync after drag-drop failed:", err);
                });
              }
              if (capturedPrevMeta && capturedNewMeta) {
                const prevM = capturedPrevMeta;
                const newM = capturedNewMeta;
                pushUndo({
                  type: "move",
                  undo: () => {
                    setNodes((prev) => prev.map((n) =>
                      n.id === cinemaId ? { ...n, metadata: prevM } : n
                    ));
                    if (canvasId) {
                      enqueueDirty({ type: "update", canvasId, nodeId: cinemaId, fields: { metadata: prevM }, committed: true });
                    }
                  },
                  redo: () => {
                    setNodes((prev) => prev.map((n) =>
                      n.id === cinemaId ? { ...n, metadata: newM } : n
                    ));
                    if (canvasId) {
                      enqueueDirty({ type: "update", canvasId, nodeId: cinemaId, fields: { metadata: newM }, committed: true });
                    }
                  },
                });
              }
            })();
          }
        }
      }

      if (didDragRef.current && !absorbedByCinema) {
        pushUndo({
          type: "move",
          undo: () => {
            setNodes((prev) => prev.map((n) => {
              const pos = prevPositions.get(n.id);
              return pos ? { ...n, x: pos.x, y: pos.y } : n;
            }));
          },
          redo: () => {
            setNodes((prev) => prev.map((n) => {
              const pos = newPositions.get(n.id);
              return pos ? { ...n, x: pos.x, y: pos.y } : n;
            }));
          },
        });
      }

      setIsDragging(false);
      clearSmartGuides();
      setCinemaGhost(null);
      targetTrackIdRef.current = null;
      dropTimeRef.current = null;

      if (canvasId && didDragRef.current && !absorbedByCinema) {
        const latestNodes = nodesRef.current;
        const updates = movedIds.map((id) => {
          const node = latestNodes.find((n) => n.id === id);
          if (!node) return null;
          return { id: node.id, x: node.x, y: node.y, width: node.width, height: node.height, z_index: node.z_index };
        }).filter((u): u is NonNullable<typeof u> => u !== null);
        if (updates.length > 0) {
          saveNodesBatchDebounced(canvasId, updates);
        }
      }
    }
  }, [isDragging, canvasId, saveNodesBatchDebounced, pushUndo, clearSmartGuides, nodesRef]);

  const deleteSelectedNodes = useCallback(() => {
    const currentSelectedIds = new Set(selectedIdsRef.current);
    const currentNodes = nodesRef.current;
    const cId = canvasId;

    if (activeGroupId && currentSelectedIds.size === 0) {
      const gNode = currentNodes.find((n) => n.id === activeGroupId);
      if (gNode) {
        const memberIds = Array.isArray(gNode.metadata?.members) ? gNode.metadata.members as string[] : [];
        memberIds.forEach((id) => currentSelectedIds.add(id));
        currentSelectedIds.add(activeGroupId);
      }
    }

    const idsToDelete = new Set(currentSelectedIds);

    for (const id of idsToDelete) {
      const node = currentNodes.find((n) => n.id === id);
      if (node?.node_type === "frame") {
        const frameMap = nodesInFramesRef.current;
        for (const n of currentNodes) {
          if (frameMap.get(n.id) === id) {
            idsToDelete.add(n.id);
          }
        }
      }
    }

    currentNodes.forEach((n) => {
      if (n.node_type === "group" && Array.isArray(n.metadata?.members)) {
        const members = n.metadata.members as string[];
        const allMembersDeleted = members.every((id) => idsToDelete.has(id));
        if (allMembersDeleted && members.length > 0) {
          idsToDelete.add(n.id);
        }
      }
    });

    for (const id of idsToDelete) {
      const groupId = memberToGroupMap.get(id);
      if (groupId && !idsToDelete.has(groupId)) {
        const gNode = currentNodes.find((n) => n.id === groupId);
        if (gNode && Array.isArray(gNode.metadata?.members)) {
          const remaining = (gNode.metadata.members as string[]).filter((mid) => !idsToDelete.has(mid));
          if (remaining.length < 2) {
            idsToDelete.add(groupId);
          }
        }
      }
    }

    const toDelete = Array.from(idsToDelete);
    const deletedNodes = currentNodes.filter((n) => idsToDelete.has(n.id));

    setNodes((prev) => {
      let updated = prev.filter((n) => !idsToDelete.has(n.id));
      updated = updated.map((n) => {
        if (n.node_type === "group" && Array.isArray(n.metadata?.members)) {
          const filtered = (n.metadata.members as string[]).filter((id) => !idsToDelete.has(id));
          if (filtered.length !== (n.metadata.members as string[]).length) {
            return { ...n, metadata: { ...n.metadata, members: filtered } };
          }
        }
        return n;
      });
      return updated;
    });
    if (onDeselectAllRef.current) onDeselectAllRef.current();
    setActiveGroupId(null);
    setInsideGroupId(null);

    pushUndo({
      type: "delete",
      undo: () => {
        setNodes((prev) => [...prev, ...deletedNodes]);
        if (cId) {
          deletedNodes.forEach((dn) => {
            enqueueDirty({
              type: "create",
              localId: dn.id,
              clientId: dn.id,
              canvasId: cId,
              node: { ...dn },
              committed: true,
            });
          });
        }
      },
      redo: () => {
        setNodes((prev) => prev.filter((n) => !toDelete.includes(n.id)));
        if (cId) {
          toDelete.forEach((id) => {
            enqueueDirty({ type: "delete", canvasId: cId, nodeId: id, committed: true });
          });
        }
      },
    });

    if (cId) {
      // Drop any debounced cinema/sync flush so it can't race the node delete
      // and resurrect tracks/clips on the server.
      for (const n of deletedNodes) {
        if (n.node_type === "cinema") cancelTimelineSync(cId, n.id);
      }
      toDelete.forEach((id) => {
        enqueueDirty({ type: "delete", canvasId: cId, nodeId: id, committed: true });
      });
    }
  }, [canvasId, pushUndo, activeGroupId, memberToGroupMap]);

  const toggleLockNode = useCallback((nodeId: string) => {
    const prevLocked = nodesRef.current.find((n) => n.id === nodeId)?.locked;
    const newLocked = !prevLocked;
    setNodes((prev) => prev.map((n) => n.id === nodeId ? { ...n, locked: newLocked } : n));
    if (canvasId) {
      saveNodesBatchDebounced(canvasId, [{ id: nodeId, locked: newLocked }]);
    }
    pushUndo({
      type: "lock",
      undo: () => setNodes((prev) => prev.map((n) => n.id === nodeId ? { ...n, locked: !!prevLocked } : n)),
      redo: () => setNodes((prev) => prev.map((n) => n.id === nodeId ? { ...n, locked: !prevLocked } : n)),
    });
    setContextMenu(null);
  }, [canvasId, pushUndo, saveNodesBatchDebounced]);


  const groupSelected = useCallback(() => {
    const currentSelectedIds = selectedIdsRef.current;
    const currentNodes = nodesRef.current;
    const ids = Array.from(currentSelectedIds);
    if (ids.length < 2) return;
    const selected = currentNodes.filter((n) => currentSelectedIds.has(n.id) && n.node_type !== "group" && n.node_type !== "frame" && !memberToGroupMap.has(n.id));
    if (selected.length < 2) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    selected.forEach((n) => {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.width);
      maxY = Math.max(maxY, n.y + n.height);
    });
    const lowestZ = Math.min(...selected.map((n) => n.z_index)) - 1;
    const groupNode: CanvasNode = {
      id: `local-group-${Date.now()}`,
      canvas_id: canvasId || "",
      node_type: "group",
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
      rotation: 0,
      z_index: lowestZ,
      locked: false,
      visible: true,
      label: "",
      src: "",
      gradient: "",
      asset_id: null,
      job_id: null,
      metadata: { members: selected.map((n) => n.id) },
    };
    setNodes((prev) => [...prev, groupNode]);

    const localGroupId = groupNode.id;
    pushUndo({
      type: "group",
      undo: () => {
        const resolvedId = idMapRef.current.get(localGroupId) || localGroupId;
        setNodes((prev) => prev.filter((n) => n.id !== resolvedId && n.id !== localGroupId));
      },
      redo: () => setNodes((prev) => [...prev, groupNode]),
    });

    if (canvasId) {
      const groupClientId = typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
      enqueueDirty({
        type: "create",
        localId: groupNode.id,
        clientId: groupClientId,
        canvasId,
        node: { ...groupNode },
        committed: true,
      });
    }

    if (onDeselectAllRef.current) onDeselectAllRef.current();
    setContextMenu(null);
  }, [canvasId, pushUndo, memberToGroupMap]);

  const ungroupNode = useCallback((groupId: string) => {
    const gNode = nodesRef.current.find((n) => n.id === groupId);
    if (!gNode || gNode.node_type !== "group") return;
    const removedGroup = { ...gNode };
    setNodes((prev) => prev.filter((n) => n.id !== groupId));

    pushUndo({
      type: "ungroup",
      undo: () => setNodes((prev) => [...prev, removedGroup]),
      redo: () => setNodes((prev) => prev.filter((n) => n.id !== groupId)),
    });

    if (canvasId) {
      enqueueDirty({ type: "delete", canvasId, nodeId: groupId, committed: true });
    }
    setContextMenu(null);
  }, [canvasId, pushUndo]);

  const multiAllSvg = useMemo(() => {
    if (selectedIds.size < 2) return false;
    const selected = nodes.filter((n) => selectedIds.has(n.id) && n.node_type !== "group");
    return selected.length >= 2 && selected.every((n) => n.node_type === "svg");
  }, [nodes, selectedIds]);

  const activeGroupBounds = useMemo(() => {
    if (!activeGroupId) return null;
    const gNode = nodes.find((n) => n.id === activeGroupId);
    if (!gNode || !Array.isArray(gNode.metadata?.members)) return null;
    const memberIds = gNode.metadata.members as string[];
    const members = nodes.filter((n) => memberIds.includes(n.id));
    if (members.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    members.forEach((n) => {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.width);
      maxY = Math.max(maxY, n.y + n.height);
    });
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
  }, [activeGroupId, nodes]);

  const multiSelectionBox = useMemo<
    { bounds: { minX: number; minY: number; width: number; height: number }; memberIds: string[] } | null
  >(() => {
    if (activeGroupId) return null;
    if (insideGroupId) return null;
    if (selectedIds.size < 2) return null;
    const members = nodes.filter((n) => selectedIds.has(n.id) && n.node_type !== "group");
    if (members.length < 2) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    members.forEach((n) => {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.width);
      maxY = Math.max(maxY, n.y + n.height);
    });
    return {
      bounds: { minX, minY, width: maxX - minX, height: maxY - minY },
      memberIds: members.map((n) => n.id),
    };
  }, [activeGroupId, insideGroupId, selectedIds, nodes]);

  useEffect(() => {
    if (groupResizeState.current) finalizeGroupResize();
  }, [activeGroupId, insideGroupId, finalizeGroupResize]);

  const selectionBox = useMemo(() => {
    if (activeGroupBounds && activeGroupId) {
      const gNode = nodes.find((n) => n.id === activeGroupId);
      const memberIds = (Array.isArray(gNode?.metadata?.members) ? gNode!.metadata!.members : []) as string[];
      return {
        bounds: { minX: activeGroupBounds.minX, minY: activeGroupBounds.minY, width: activeGroupBounds.width, height: activeGroupBounds.height },
        memberIds,
        kind: "group" as const,
      };
    }
    if (multiSelectionBox) {
      return { ...multiSelectionBox, kind: "multi" as const };
    }
    return null;
  }, [activeGroupBounds, activeGroupId, multiSelectionBox, nodes]);

  const { alignNodes, distributeNodes, applyLayout } = useCanvasLayout({
    nodesRef,
    selectedIdsRef,
    setNodes,
    pushUndo,
    canvasId,
    saveNodesBatchDebounced,
    viewportRef,
    memberToGroupMap,
  });

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === " " || e.code === "Space") {
        if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target instanceof HTMLElement && e.target.isContentEditable))) {
          e.preventDefault();
          spaceDown.current = true;
          setZoomMode(true);
        }
      }

      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.target instanceof HTMLElement && e.target.isContentEditable) return;

      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "Z" || (e.key === "z" && e.shiftKey))) {
        e.preventDefault();
        redo();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key === "a") {
        e.preventDefault();
        if (onSelectMultipleRef.current) {
          const sorted = sortNodesReadingOrder(nodesRef.current.filter((n) => n.node_type !== "group"));
          onSelectMultipleRef.current(sorted.map((n) => n.id), "exclusive");
        }
        return;
      }

      if (e.key === "Delete" || e.key === "Backspace") {
        if (svgPathEdit.editingNodeId) return;
        if (selectedIdsRef.current.size > 0 || activeGroupId) {
          e.preventDefault();
          deleteSelectedNodes();
        }
      }
      if (e.key === "Escape") {
        if (svgPathEdit.editingNodeId) return;
        setSubtoolDropdown(null);
        if (insideGroupId) {
          setInsideGroupId(null);
          if (onDeselectAllRef.current) onDeselectAllRef.current();
          return;
        }
        if (activeGroupId) {
          setActiveGroupId(null);
          if (onDeselectAllRef.current) onDeselectAllRef.current();
          return;
        }
        if (onDeselectAllRef.current) onDeselectAllRef.current();
        setContextMenu(null);
      }

      if (e.key === "f" || e.key === "F") {
        if (!e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          if (onToolSelectRef.current) onToolSelectRef.current("design");
          if (onDesignSubToolChangeRef.current) onDesignSubToolChangeRef.current("frame");
        }
      }

      if (e.key === "c" || e.key === "C") {
        if (!e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          if (onToolSelectRef.current) onToolSelectRef.current("create");
        }
      }

      if (e.key === "r" || e.key === "R") {
        if (!e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          if (onDeselectAllRef.current) onDeselectAllRef.current();
          if (onToolSelectRef.current) onToolSelectRef.current("design");
          if (onDesignSubToolChangeRef.current) onDesignSubToolChangeRef.current("shape");
          if (onPendingShapeKindChangeRef.current) onPendingShapeKindChangeRef.current("rectangle");
        }
      }

      if (e.key === "t" || e.key === "T") {
        if (!e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          if (onDeselectAllRef.current) onDeselectAllRef.current();
          if (onToolSelectRef.current) onToolSelectRef.current("design");
          if (onDesignSubToolChangeRef.current) onDesignSubToolChangeRef.current("text");
        }
      }

      if (e.key === "p" || e.key === "P") {
        if (!e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          if (onDeselectAllRef.current) onDeselectAllRef.current();
          if (onToolSelectRef.current) onToolSelectRef.current("design");
          if (onDesignSubToolChangeRef.current) onDesignSubToolChangeRef.current("pen");
        }
      }

      if (e.key === "d" || e.key === "D") {
        if (!e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          if (onDeselectAllRef.current) onDeselectAllRef.current();
          if (onToolSelectRef.current) onToolSelectRef.current("design");
          if (onDesignSubToolChangeRef.current) onDesignSubToolChangeRef.current("draw");
        }
      }

      if ((e.ctrlKey || e.metaKey) && (e.key === "]" || e.code === "BracketRight")) {
        e.preventDefault();
        if (e.shiftKey) {
          layerBringToTop();
        } else {
          layerMoveUp();
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "[" || e.code === "BracketLeft")) {
        e.preventDefault();
        if (e.shiftKey) {
          layerSendToBottom();
        } else {
          layerMoveDown();
        }
        return;
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === " " || e.code === "Space") {
        spaceDown.current = false;
        setZoomMode(false);
      }
    };
    const handleWindowBlur = () => {
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, [deleteSelectedNodes, undo, redo, layerMoveUp, layerMoveDown, layerBringToTop, layerSendToBottom, activeGroupId, insideGroupId]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      svgPathEdit.handleKeyDown(e);
      penDrawHandlers.handlePenKeyDown(e);
      if (e.key === "Escape" && !penDrawHandlers.penState && (designSubToolRef.current === "pen" || designSubToolRef.current === "draw")) {
        if (onDesignSubToolChangeRef.current) onDesignSubToolChangeRef.current("select");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [svgPathEdit.handleKeyDown, penDrawHandlers.handlePenKeyDown, penDrawHandlers.penState]);


  const handleContextMenu = useCallback((e: React.MouseEvent, nodeId: string) => {
    const nd = nodesRef.current.find((n) => n.id === nodeId);
    if (nd?.node_type === "text" && inFlightTextNodeId === nodeId) return;
    e.preventDefault();
    e.stopPropagation();

    setLibSaved(false);
    setLibSaveError(false);
    setLibMatch(null);
    setLibFolderMenuOpen(false);
    if (libSaveTimer.current) { clearTimeout(libSaveTimer.current); libSaveTimer.current = null; }
    if (libFolderMenuTimer.current) { clearTimeout(libFolderMenuTimer.current); libFolderMenuTimer.current = null; }

    const nd2 = nodesRef.current.find((n) => n.id === nodeId);
    if (nd2 && (nd2.node_type === "image" || nd2.node_type === "video" || nd2.node_type === "svg")) {
      const match = findNodeInLibraryCache(nodeId);
      if (match) setLibMatch(match);
    }

    const groupId = memberToGroupMap.get(nodeId);
    if (groupId && !insideGroupId) {
      setActiveGroupId(groupId);
      setContextMenu({ x: e.clientX, y: e.clientY, nodeId });
      return;
    }

    setContextMenu({ x: e.clientX, y: e.clientY, nodeId });
    if (!selectedIdsRef.current.has(nodeId)) {
      const node = nodesRef.current.find((n) => n.id === nodeId);
      if (node) emitNodeMetaRef.current(nodeId, node);
      onSelectImageRef.current(nodeId);
    }
  }, [memberToGroupMap, insideGroupId, inFlightTextNodeId]);

  const contextMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!contextMenu) return;
    const close = (e: MouseEvent) => {
      if (contextMenuRef.current && contextMenuRef.current.contains(e.target as Node)) return;
      setContextMenu(null);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [contextMenu]);

  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current) return;
    const el = contextMenuRef.current;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    let newX = contextMenu.x;
    let newY = contextMenu.y;
    if (newX + rect.width > window.innerWidth - pad) {
      newX = window.innerWidth - rect.width - pad;
    }
    if (newX < pad) newX = pad;
    if (newY + rect.height > window.innerHeight - pad) {
      newY = window.innerHeight - rect.height - pad;
    }
    if (newY < pad) newY = pad;
    if (newX !== contextMenu.x || newY !== contextMenu.y) {
      el.style.left = `${newX}px`;
      el.style.top = `${newY}px`;
    }
    const submenu = el.querySelector(".freeform-canvas__context-folder-submenu") as HTMLElement | null;
    if (submenu) {
      submenu.classList.remove("freeform-canvas__context-folder-submenu--flip");
      submenu.style.top = "";
      const subRect = submenu.getBoundingClientRect();
      if (subRect.right > window.innerWidth - pad) {
        submenu.classList.add("freeform-canvas__context-folder-submenu--flip");
      }
      const subRectUpdated = submenu.getBoundingClientRect();
      if (subRectUpdated.left < pad) {
        submenu.classList.remove("freeform-canvas__context-folder-submenu--flip");
      }
      const subRectFinal = submenu.getBoundingClientRect();
      if (subRectFinal.bottom > window.innerHeight - pad) {
        const parentTop = el.getBoundingClientRect().top;
        submenu.style.top = `${window.innerHeight - pad - subRectFinal.height - parentTop}px`;
      }
    }
  }, [contextMenu, libFolderMenuOpen, libFoldersLoading, libFolders.length]);

  const addNodeAtPosition = useCallback((x: number, y: number, props: Partial<CanvasNode>, options?: { skipSync?: boolean }) => {
    const isFrame = props.node_type === "frame";
    const isCinemaNode = props.node_type === "cinema";
    const newZ = (isFrame || isCinemaNode) ? nextFrameZRef.current-- : nextZRef.current++;
    const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const newNode: CanvasNode = {
      id: localId,
      canvas_id: canvasId || "",
      node_type: props.node_type || "image",
      x,
      y,
      width: props.width || 256,
      height: props.height || 256,
      rotation: props.rotation || 0,
      z_index: newZ,
      locked: props.locked ?? false,
      visible: true,
      label: props.label || "",
      src: props.src || "",
      gradient: props.gradient || "",
      asset_id: props.asset_id || null,
      job_id: props.job_id || null,
      metadata: {
        ...(props.metadata || {}),
        originalWidth: props.width || 256,
        originalHeight: props.height || 256,
      },
    };
    setNodes((prev) => [...prev, newNode]);
    emitNodeMetaRef.current(newNode.id, newNode);

    pushUndo({
      type: "create",
      undo: () => setNodes((prev) => prev.filter((n) => n.id !== newNode.id && n.id !== (idMapRef.current.get(newNode.id) || ""))),
      redo: () => setNodes((prev) => [...prev, newNode]),
    });

    if (canvasId && !options?.skipSync) {
      const clientId = typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
      enqueueDirty({
        type: "create",
        localId: newNode.id,
        clientId,
        canvasId,
        node: { ...newNode },
        committed: true,
      });
    }

    return newNode;
  }, [canvasId, pushUndo]);

  addNodeAtPositionRef.current = addNodeAtPosition;

  const handleSvgBooleanOp = useCallback((op: BooleanOpType, nodeIds: string[]) => {
    const orderedNodes = nodeIds
      .map((id) => nodesRef.current.find((n) => n.id === id))
      .filter((n): n is CanvasNode => !!n);
    if (orderedNodes.length < 2) return;

    const nodeInfos = orderedNodes.map((n) => {
      let pathData = n.metadata?.pathData as PathData | undefined;
      if (!pathData && n.metadata?.svg_content) {
        pathData = extractPathDataFromSvg(n.metadata.svg_content as string, n.width, n.height) ?? undefined;
      }
      if (!pathData) {
        pathData = { subPaths: [], fill: "#000000" };
      }
      return { id: n.id, x: n.x, y: n.y, width: n.width, height: n.height, pathData };
    });

    const result = performBooleanOp(op, nodeInfos);
    if (!result) return;

    const oldNodes = orderedNodes.map((n) => ({ ...n, metadata: { ...n.metadata } }));
    const keepNode = orderedNodes[0];
    const removedIds = orderedNodes.slice(1).map((n) => n.id);

    const mergedNode: CanvasNode = {
      ...keepNode,
      x: result.x,
      y: result.y,
      width: result.width,
      height: result.height,
      metadata: {
        ...keepNode.metadata,
        pathData: result.pathData,
        svg_content: undefined,
        originalWidth: result.width,
        originalHeight: result.height,
      },
    };

    setNodes((prev) => {
      const without = prev.filter((n) => !removedIds.includes(n.id));
      return without.map((n) => n.id === keepNode.id ? mergedNode : n);
    });

    emitNodeMetaRef.current(keepNode.id, mergedNode);

    const cId = canvasId;
    if (cId) {
      saveNodesBatchDebounced(cId, [{
        id: keepNode.id,
        x: result.x,
        y: result.y,
        width: result.width,
        height: result.height,
        metadata: mergedNode.metadata,
      }]);
      removedIds.forEach((id) => {
        enqueueDirty({ type: "delete", canvasId: cId, nodeId: id, committed: true });
      });
    }

    if (onSelectMultiple) {
      onSelectMultiple([keepNode.id]);
    }

    pushUndo({
      type: "delete",
      undo: () => {
        setNodes((prev) => {
          const without = prev.filter((n) => n.id !== keepNode.id);
          return [...without, ...oldNodes];
        });
      },
      redo: () => {
        setNodes((prev) => {
          const without = prev.filter((n) => !removedIds.includes(n.id));
          return without.map((n) => n.id === keepNode.id ? mergedNode : n);
        });
      },
    });
  }, [canvasId, pushUndo, saveNodesBatchDebounced, onSelectMultiple]);

  const wrappedOnCanvasApi = useCallback((api: CanvasApi) => {
    api.canvasAlign = alignNodes as (dir: string) => void;
    api.canvasDistribute = distributeNodes as (dir: string) => void;
    api.canvasLayout = applyLayout;
    api.updateSvgPoint = svgPathEdit.updatePointPosition;
    api.toggleSvgSmooth = svgPathEdit.togglePointSmooth;
    api.updateSvgPointRadius = svgPathEdit.updatePointRadius;
    api.pushUndo = pushUndo;
    api.svgBooleanOp = handleSvgBooleanOp;
    api.addNode = (x: number, y: number, props: Partial<CanvasNode>) => {
      return addNodeAtPosition(x, y, props);
    };
    onCanvasApi?.(api);
  }, [onCanvasApi, alignNodes, distributeNodes, applyLayout, svgPathEdit.updatePointPosition, svgPathEdit.togglePointSmooth, svgPathEdit.updatePointRadius, pushUndo, handleSvgBooleanOp, addNodeAtPosition]);

  const shapeApiResult = useShapeApi({
    viewportRef,
    nodesRef,
    panXRef,
    panYRef,
    zoomRef,
    addNodeAtPosition,
  });
  shapeApiRef.current = shapeApiResult;

  const textApiResult = useTextApi({
    viewportRef,
    nodesRef,
    panXRef,
    panYRef,
    zoomRef,
    addNodeAtPosition,
  });
  const handleStartTextEdit = useCallback((nodeId: string) => {
    const node = nodesRef.current.find((n) => n.id === nodeId);
    if (!node || node.node_type !== "text") return;
    const meta = node.metadata as Record<string, unknown>;
    setInFlightText({
      nodeId,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      text: (meta?.textContent as string) || "",
      fontFamily: (meta?.fontFamily as string) || "Inter, sans-serif",
      fontWeight: (meta?.fontWeight as number) || 400,
      fontSize: (meta?.fontSize as number) || 48,
      color: (meta?.color as string) || getDefaultTextColor(),
      textAlign: (meta?.textAlign as string) || "left",
      letterSpacing: (meta?.letterSpacing as number) || 0,
      lineHeight: (meta?.lineHeight as number) || 120,
      label: node.label || "",
      _createdAt: Date.now(),
    });
  }, []);

  const handleInFlightCommit = useCallback((text: string) => {
    const flight = inFlightTextRef.current;
    if (!flight) return;
    setInFlightText(null);

    if (flight.nodeId) {
      const resolvedId = idMapRef.current.get(flight.nodeId) || flight.nodeId;
      const oldNode = nodesRef.current.find((n) => n.id === flight.nodeId || n.id === resolvedId);
      const oldText = oldNode ? ((oldNode.metadata as Record<string, unknown>)?.textContent as string) || "" : "";
      const finalId = resolvedId;
      setNodes((prev) => {
        const updated = prev.map((n) =>
          (n.id === flight.nodeId || n.id === resolvedId)
            ? { ...n, metadata: { ...n.metadata, textContent: text } }
            : n
        );
        const node = updated.find((n) => n.id === flight.nodeId || n.id === resolvedId);
        if (node && canvasId) {
          saveNodesBatchDebounced(canvasId, [{ id: node.id, metadata: node.metadata }]);
        }
        return updated;
      });
      if (text !== oldText) {
        pushUndo({
          type: "resize",
          undo: () => setNodes((prev) => prev.map((n) => n.id === finalId ? { ...n, metadata: { ...n.metadata, textContent: oldText } } : n)),
          redo: () => setNodes((prev) => prev.map((n) => n.id === finalId ? { ...n, metadata: { ...n.metadata, textContent: text } } : n)),
        });
      }
    } else {
      if (onDeselectAllRef.current) onDeselectAllRef.current();
      if (text.trim()) {
        const existing = nodesRef.current.filter((n) => n.node_type === "text");
        const nums = existing
          .map((n) => n.label?.match(/^Text (\d+)$/)?.[1])
          .filter(Boolean)
          .map(Number);
        const nextNum = nums.length > 0 ? Math.max(...nums) + 1 : 1;
        const finalMeta = {
          textContent: text,
          fontFamily: flight.fontFamily,
          fontWeight: flight.fontWeight,
          fontSize: flight.fontSize,
          color: flight.color,
          textAlign: flight.textAlign,
          letterSpacing: flight.letterSpacing,
          lineHeight: flight.lineHeight,
        };
        const newNode = addNodeAtPosition(flight.x, flight.y, {
          node_type: "text",
          width: flight.width,
          height: flight.height,
          label: `Text ${nextNum}`,
          metadata: finalMeta,
        });
        if (newNode) {
          onSelectImageRef.current(newNode.id, "exclusive");
        }
        if (onDropPromptRef.current) {
          onDropPromptRef.current(text.trim());
        }
      }
    }

    if (designSubToolRef.current === "text" && onDesignSubToolChangeRef.current) {
      onDesignSubToolChangeRef.current("select");
    }
  }, [canvasId, saveNodesBatchDebounced, addNodeAtPosition, pushUndo]);

  const handleInFlightTextChange = useCallback((text: string) => {
    setInFlightText((prev) => prev ? { ...prev, text } : null);
  }, []);

  const handleInFlightCommitRef = useRef(handleInFlightCommit);
  handleInFlightCommitRef.current = handleInFlightCommit;

  const prevInFlightActiveRef = useRef(false);
  useEffect(() => {
    const isActive = !!(inFlightText && !inFlightText.nodeId);
    const wasActive = prevInFlightActiveRef.current;
    prevInFlightActiveRef.current = isActive;

    if (isActive && inFlightText) {
      if (onNodeMeta) {
        onNodeMeta(INFLIGHT_VIRTUAL_ID, {
          id: INFLIGHT_VIRTUAL_ID,
          label: "New Text",
          gradient: "",
          nodeType: "text",
          fontFamily: inFlightText.fontFamily,
          fontWeight: inFlightText.fontWeight,
          fontSize: inFlightText.fontSize,
          color: inFlightText.color,
          textAlign: inFlightText.textAlign,
          textContent: inFlightText.text,
          letterSpacing: inFlightText.letterSpacing,
          lineHeight: inFlightText.lineHeight,
          x: inFlightText.x,
          y: inFlightText.y,
          width: inFlightText.width,
          height: inFlightText.height,
        });
      }
      if (!wasActive) {
        onSelectImage(INFLIGHT_VIRTUAL_ID, "exclusive");
      }
    }
  }, [inFlightText, onNodeMeta, onSelectImage]);

  useEffect(() => {
    const commitIfInFlight = () => {
      const flight = inFlightTextRef.current;
      if (flight) {
        handleInFlightCommitRef.current(flight.text);
      }
    };
    const handleVisChange = () => {
      if (document.visibilityState === "hidden") commitIfInFlight();
    };
    const handleBeforeUnload = () => commitIfInFlight();
    document.addEventListener("visibilitychange", handleVisChange);
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      document.removeEventListener("visibilitychange", handleVisChange);
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, []);

  const wrappedOnCanvasApiWithShape = useCallback((api: CanvasApi) => {
    api.addShape = shapeApiResult.addShape;
    api.addShapeAtPosition = shapeApiResult.addShapeAtPosition;
    api.addText = textApiResult.addText;
    api.addTextAtPosition = textApiResult.addTextAtPosition;
    const originalUpdateNodeMetadata = api.updateNodeMetadata;
    if (originalUpdateNodeMetadata) {
      api.updateNodeMetadata = (nodeId: string, meta: Record<string, unknown>) => {
        const flight = inFlightTextRef.current;
        const isVirtualInFlight = nodeId === INFLIGHT_VIRTUAL_ID && flight && !flight.nodeId;
        const remappedFlightId = flight?.nodeId ? (idMapRef.current.get(flight.nodeId) || flight.nodeId) : undefined;
        const isExistingInFlight = flight && flight.nodeId && (flight.nodeId === nodeId || remappedFlightId === nodeId);

        if (isVirtualInFlight || isExistingInFlight) {
          if (!isVirtualInFlight) {
            originalUpdateNodeMetadata(nodeId, meta);
          }
          setInFlightText((prev) => {
            if (!prev) return prev;
            if (!isVirtualInFlight && prev.nodeId !== nodeId) return prev;
            return {
              ...prev,
              ...(meta.fontFamily !== undefined ? { fontFamily: meta.fontFamily as string } : {}),
              ...(meta.fontWeight !== undefined ? { fontWeight: meta.fontWeight as number } : {}),
              ...(meta.fontSize !== undefined ? { fontSize: meta.fontSize as number } : {}),
              ...(meta.color !== undefined ? { color: meta.color as string } : {}),
              ...(meta.textAlign !== undefined ? { textAlign: meta.textAlign as string } : {}),
              ...(meta.letterSpacing !== undefined ? { letterSpacing: meta.letterSpacing as number } : {}),
              ...(meta.lineHeight !== undefined ? { lineHeight: meta.lineHeight as number } : {}),
            };
          });
        } else {
          originalUpdateNodeMetadata(nodeId, meta);
        }
      };
    }
    wrappedOnCanvasApi(api);
  }, [wrappedOnCanvasApi, shapeApiResult.addShape, shapeApiResult.addShapeAtPosition, textApiResult.addText, textApiResult.addTextAtPosition]);

  useFrameApi({
    viewportRef,
    nodesRef,
    panXRef,
    panYRef,
    zoomRef,
    canvasIdRef,
    addNodeAtPosition,
    setNodes,
    saveNodesBatchDebounced,
    onCanvasApi: wrappedOnCanvasApiWithShape,
    selectedIdsRef,
    setPanX,
    setPanY,
    setZoom,
    idMapRef,
  });

  const clipboardSelectedIds = useMemo(() => {
    if (activeGroupId && !insideGroupId) {
      const gNode = nodes.find((n) => n.id === activeGroupId);
      if (gNode && Array.isArray(gNode.metadata?.members)) {
        return new Set(gNode.metadata.members as string[]);
      }
    }
    return selectedIds;
  }, [selectedIds, activeGroupId, insideGroupId, nodes]);

  const { copyNodes, pasteNodes, clipboardRef } = useFrameClipboard({
    nodes,
    selectedIds: clipboardSelectedIds,
    nodesInFramesRef,
    addNodeAtPosition,
    onSelectMultiple,
    onDeselectAll,
  });

  const { dragOver, dragPlaceholder, handleDragOver, handleDragLeave, handleDrop } = useCanvasDrop({
    screenToCanvas,
    addNodeAtPosition,
    emitNodeMeta,
    onSelectImageRef,
    onDeselectAllRef,
    onDropPrompt,
    onDropReference,
    onDropTrayItem,
    canvasId,
    idMapRef,
    viewportRef,
    setNodes,
  });

  const zoomAroundCenter = useCallback((direction: 1 | -1) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) {
      setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z + ZOOM_STEP * direction)));
      return;
    }
    const oldZ = zoomRef.current;
    const newZ = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, oldZ + ZOOM_STEP * direction));
    if (newZ === oldZ) return;
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const ratio = newZ / oldZ;
    setPanX((px) => cx - (cx - px) * ratio);
    setPanY((py) => cy - (cy - py) * ratio);
    setZoom(newZ);
  }, []);

  const zoomIn = useCallback(() => zoomAroundCenter(1), [zoomAroundCenter]);
  const zoomOut = useCallback(() => zoomAroundCenter(-1), [zoomAroundCenter]);

  const FIT_PADDING = 25;

  const zoomToFit = useCallback(() => {
    if (nodes.length === 0) { setZoom(ZOOM_BASELINE); setPanX(0); setPanY(0); return; }
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const availW = rect.width - FIT_PADDING * 2;
    const availH = rect.height - FIT_PADDING * 2;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodes.forEach((n) => {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.width);
      maxY = Math.max(maxY, n.y + n.height);
    });
    const contentW = maxX - minX;
    const contentH = maxY - minY;
    const scaleX = availW / contentW;
    const scaleY = availH / contentH;
    const newZoom = Math.min(Math.max(MIN_ZOOM, Math.min(scaleX, scaleY)), MAX_ZOOM);
    const visibleCenterX = rect.width / 2;
    const visibleCenterY = rect.height / 2;
    setPanX(visibleCenterX - (minX + contentW / 2) * newZoom);
    setPanY(visibleCenterY - (minY + contentH / 2) * newZoom);
    setZoom(newZoom);
  }, [nodes]);

  const fitAllTriggerRef = useRef(0);
  useEffect(() => {
    if (fitAllTrigger && fitAllTrigger !== fitAllTriggerRef.current) {
      fitAllTriggerRef.current = fitAllTrigger;
      requestAnimationFrame(() => zoomToFit());
    }
  }, [fitAllTrigger, zoomToFit]);

  const navigateToPoint = useCallback((worldX: number, worldY: number) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const visibleCenterX = rect.width / 2;
    const visibleCenterY = rect.height / 2;
    setPanX(visibleCenterX - worldX * zoom);
    setPanY(visibleCenterY - worldY * zoom);
  }, [zoom]);

  // Multiplayer presence: subscribe to SSE for snapshot/join/leave/cursor/idle
  // events and broadcast our own pointer at ~16 Hz. Disabled in cinema and
  // present mode where the canvas isn't being edited collaboratively.
  const presenceEnabled = !isCinema && !presentMode && !!canvasId;
  usePresenceChannel(presenceEnabled ? canvasId : null);
  useCursorBroadcast({
    canvasId: presenceEnabled ? canvasId : null,
    viewportRef,
    screenToCanvas,
    panX,
    panY,
    zoom,
    enabled: presenceEnabled,
  });

  const handleNodeClick = useCallback((e: React.MouseEvent, nodeId: string) => {
    if (didDragRef.current) return;
    const clickedNode = nodesRef.current.find((n) => n.id === nodeId);

    const parentFrameId = nodesInFramesRef.current.get(nodeId);
    if (parentFrameId && clickedNode?.node_type !== "frame") {
      if (clickedNode) emitNodeMetaRef.current(nodeId, clickedNode);
      const mode = e.shiftKey ? "toggle" : "exclusive";
      onSelectImageRef.current(nodeId, mode);
      return;
    }

    const groupId = memberToGroupMap.get(nodeId);

    if (insideGroupId) {
      const isInsideMember = groupId === insideGroupId;
      if (!isInsideMember) {
        setInsideGroupId(null);
        if (onDeselectAllRef.current) onDeselectAllRef.current();
        if (groupId && clickedNode?.node_type !== "group") {
          setActiveGroupId(groupId);
        } else {
          setActiveGroupId(null);
          if (clickedNode) emitNodeMetaRef.current(nodeId, clickedNode);
          onSelectImageRef.current(nodeId, e.shiftKey ? "toggle" : "exclusive");
        }
        return;
      }
    }

    if (groupId && !insideGroupId && clickedNode?.node_type !== "group") {
      if (onDeselectAllRef.current) onDeselectAllRef.current();
      setActiveGroupId(groupId);
      return;
    }

    if (clickedNode) emitNodeMetaRef.current(nodeId, clickedNode);
    const mode = e.shiftKey ? "toggle" : "exclusive";
    onSelectImageRef.current(nodeId, mode);
    if (!e.shiftKey) {
      setActiveGroupId(null);
      setInsideGroupId(null);
    }
  }, [memberToGroupMap, insideGroupId]);

  const handleViewportDoubleClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const nodeEl = target.closest(".freeform-canvas__node");
    if (nodeEl) {
      const nodeId = (nodeEl as HTMLElement).dataset.nodeId;
      if (nodeId) {
        const clickedNode = nodesRef.current.find((n) => n.id === nodeId);

        if (nodeId && activeGroupId && !insideGroupId) {
          const groupId = memberToGroupMap.get(nodeId);
          if (groupId === activeGroupId) {
            e.stopPropagation();
            setInsideGroupId(activeGroupId);
            if (clickedNode) {
              emitNodeMetaRef.current(nodeId, clickedNode);
              onSelectImageRef.current(nodeId, "exclusive");
            }
            return;
          }
        }

        if (clickedNode?.node_type === "frame") {
          return;
        }
      }
      return;
    }

    if (activeGroupId || insideGroupId) {
      setActiveGroupId(null);
      setInsideGroupId(null);
      if (onDeselectAllRef.current) onDeselectAllRef.current();
      return;
    }

    const canvasPos = screenToCanvas(e.clientX, e.clientY);
    const frames = nodesRef.current
      .filter((n) => n.node_type === "frame" && n.visible !== false)
      .sort((a, b) => b.z_index - a.z_index);
    for (const f of frames) {
      if (canvasPos.x >= f.x && canvasPos.x <= f.x + f.width && canvasPos.y >= f.y && canvasPos.y <= f.y + f.height) {
        e.stopPropagation();
        if (onDeselectAllRef.current) onDeselectAllRef.current();
        onSelectImageRef.current(f.id, "exclusive");
        emitNodeMetaRef.current(f.id, f);
        return;
      }
    }
  }, [screenToCanvas, activeGroupId, insideGroupId, memberToGroupMap]);

  const [placementGhost, setPlacementGhost] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!pendingPlacement || !viewportRef.current) return;
    const el = viewportRef.current;

    const handleMouseMove = (e: MouseEvent) => {
      setPlacementGhost({ x: e.clientX, y: e.clientY });
    };

    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target !== el && !target.classList.contains("freeform-canvas__layer") && !target.classList.contains("freeform-canvas__placement-ghost")) return;

      const rect = el.getBoundingClientRect();
      const cx = (e.clientX - rect.left - panX) / zoom;
      const cy = (e.clientY - rect.top - panY) / zoom;
      const { url, isVideo, isAudio, isSvg, svgContent, label, jobId } = pendingPlacement;

      if (url && isAudio) {
        const aw = 300;
        const ah = 80;
        const trayItem = pendingPlacement.trayItem as Record<string, unknown> | undefined;
        const subtypeMap: Record<string, string> = { audio_tts: "tts", audio_music: "music", audio_sfx: "sfx", audio_voice_changer: "voice" };
        const audioMeta: Record<string, unknown> = {
          audioSubtype: subtypeMap[(trayItem?.job_type as string) || ""] || "music",
          prompt: trayItem?.prompt || (trayItem?.metadata as Record<string, unknown>)?.prompt || "",
        };
        if (trayItem?.job_params) audioMeta.jobParams = trayItem.job_params;
        addNodeAtPosition(cx - aw / 2, cy - ah / 2, { label, src: url, job_id: jobId, node_type: "audio", width: aw, height: ah, metadata: audioMeta });
        onConfirmPlacement?.(pendingPlacement);
      } else if (url && isSvg) {
        const svgMeta: Record<string, unknown> = {};
        if (svgContent) svgMeta.svg_content = svgContent;
        const img = new Image();
        img.onload = () => {
          const { w, h } = clampDimensions(img.naturalWidth || 256, img.naturalHeight || 256);
          if (svgContent) {
            const parsed = extractPathDataFromSvg(svgContent, w, h);
            if (parsed) svgMeta.pathData = parsed;
          }
          addNodeAtPosition(cx - w / 2, cy - h / 2, { label, src: url, job_id: jobId, node_type: "svg", width: w, height: h, metadata: svgMeta });
          onConfirmPlacement?.(pendingPlacement);
        };
        img.onerror = () => {
          if (svgContent) {
            const parsed = extractPathDataFromSvg(svgContent, 256, 256);
            if (parsed) svgMeta.pathData = parsed;
          }
          addNodeAtPosition(cx - 128, cy - 128, { label, src: url, job_id: jobId, node_type: "svg", metadata: svgMeta });
          onConfirmPlacement?.(pendingPlacement);
        };
        img.src = url;
      } else if (url && isVideo) {
        const vid = document.createElement("video");
        vid.onloadedmetadata = () => {
          const { w, h } = clampDimensions(vid.videoWidth || 512, vid.videoHeight || 288);
          addNodeAtPosition(cx - w / 2, cy - h / 2, { label, src: url, job_id: jobId, node_type: "video", width: w, height: h });
          onConfirmPlacement?.(pendingPlacement);
        };
        vid.onerror = () => {
          addNodeAtPosition(cx - 256, cy - 144, { label, src: url, job_id: jobId, node_type: "video", width: 512, height: 288 });
          onConfirmPlacement?.(pendingPlacement);
        };
        vid.src = url;
      } else if (url) {
        const img = new Image();
        img.onload = () => {
          const { w, h } = clampDimensions(img.naturalWidth || 256, img.naturalHeight || 256);
          addNodeAtPosition(cx - w / 2, cy - h / 2, { label, src: url, job_id: jobId, width: w, height: h });
          onConfirmPlacement?.(pendingPlacement);
        };
        img.onerror = () => {
          addNodeAtPosition(cx - 128, cy - 128, { label, src: url, job_id: jobId });
          onConfirmPlacement?.(pendingPlacement);
        };
        img.src = url;
      }
      setPlacementGhost(null);
      onClearPendingPlacement?.();
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPlacementGhost(null);
        onClearPendingPlacement?.();
      }
    };

    el.addEventListener("mousemove", handleMouseMove);
    el.addEventListener("click", handleClick);
    window.addEventListener("keydown", handleEscape);
    return () => {
      el.removeEventListener("mousemove", handleMouseMove);
      el.removeEventListener("click", handleClick);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [pendingPlacement, panX, panY, zoom, addNodeAtPosition, onConfirmPlacement, onClearPendingPlacement]);

  const sortedNodes = useMemo(() => [...nodes].sort((a, b) => a.z_index - b.z_index), [nodes]);

  const { nodeClipRects, nodesInFrames } = useMemo(() => {
    const frames = sortedNodes.filter((n) => n.node_type === "frame" && n.visible !== false);
    if (frames.length === 0) return { nodeClipRects: new Map<string, { top?: number; right?: number; bottom?: number; left?: number; polygon?: string }>(), nodesInFrames: new Map<string, string>() };
    const clips = new Map<string, { top?: number; right?: number; bottom?: number; left?: number; polygon?: string }>();
    const inFrame = new Map<string, string>();
    for (const node of sortedNodes) {
      if (node.node_type === "frame" || node.node_type === "group" || node.node_type === "cinema" || node.visible === false) continue;
      for (let fi = frames.length - 1; fi >= 0; fi--) {
        const frame = frames[fi];
        const centerX = node.x + node.width / 2;
        const centerY = node.y + node.height / 2;
        const centerInFrame =
          centerX >= frame.x && centerX <= frame.x + frame.width &&
          centerY >= frame.y && centerY <= frame.y + frame.height;
        if (!centerInFrame) continue;
        inFrame.set(node.id, frame.id);
        if (node.rotation) {
          const rad = -(node.rotation * Math.PI) / 180;
          const cos = Math.cos(rad);
          const sin = Math.sin(rad);
          const cx = node.x + node.width / 2;
          const cy = node.y + node.height / 2;
          const hw = node.width / 2;
          const hh = node.height / 2;
          const fCorners = [
            [frame.x, frame.y],
            [frame.x + frame.width, frame.y],
            [frame.x + frame.width, frame.y + frame.height],
            [frame.x, frame.y + frame.height],
          ];
          const localCorners = fCorners.map(([wx, wy]) => {
            const dx = wx - cx;
            const dy = wy - cy;
            return [
              (dx * cos - dy * sin + hw) / node.width * 100,
              (dx * sin + dy * cos + hh) / node.height * 100,
            ];
          });
          const allInside = localCorners.every(
            ([px, py]) => px >= -0.5 && px <= 100.5 && py >= -0.5 && py <= 100.5
          );
          if (!allInside) {
            const poly = localCorners
              .map(([px, py]) => `${px.toFixed(2)}% ${py.toFixed(2)}%`)
              .join(", ");
            clips.set(node.id, { polygon: poly });
          }
        } else {
          const overlaps =
            node.x < frame.x + frame.width &&
            node.x + node.width > frame.x &&
            node.y < frame.y + frame.height &&
            node.y + node.height > frame.y;
          if (overlaps) {
            const top = Math.max(0, frame.y - node.y);
            const left = Math.max(0, frame.x - node.x);
            const bottom = Math.max(0, (node.y + node.height) - (frame.y + frame.height));
            const right = Math.max(0, (node.x + node.width) - (frame.x + frame.width));
            if (top > 0 || right > 0 || bottom > 0 || left > 0) {
              clips.set(node.id, { top, right, bottom, left });
            }
          }
        }
        break;
      }
    }
    return { nodeClipRects: clips, nodesInFrames: inFrame };
  }, [sortedNodes]);

  nodesInFramesRef.current = nodesInFrames;

  const prevNodesInFramesRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const prev = prevNodesInFramesRef.current;
    const curr = nodesInFrames;

    const changedFrameIds = new Set<string>();
    for (const [nodeId, frameId] of curr) {
      if (prev.get(nodeId) !== frameId) changedFrameIds.add(frameId);
    }
    for (const [nodeId, frameId] of prev) {
      if (!curr.has(nodeId) || curr.get(nodeId) !== frameId) changedFrameIds.add(frameId);
    }

    prevNodesInFramesRef.current = new Map(curr);

    if (changedFrameIds.size === 0) return;

    const frameMembers = new Map<string, string[]>();
    for (const [nodeId, frameId] of curr) {
      if (!changedFrameIds.has(frameId)) continue;
      if (!frameMembers.has(frameId)) frameMembers.set(frameId, []);
      frameMembers.get(frameId)!.push(nodeId);
    }

    const zChanges = new Map<string, number>();
    for (const [, memberIds] of frameMembers) {
      const members = nodesRef.current.filter((n) => memberIds.includes(n.id));
      members.sort((a, b) => a.z_index - b.z_index);
      members.forEach((n, i) => {
        const targetZ = i + 1;
        if (n.z_index !== targetZ) {
          zChanges.set(n.id, targetZ);
        }
      });
    }

    if (zChanges.size === 0) return;

    setNodes((prev) => {
      const result = prev.map((n) => {
        const z = zChanges.get(n.id);
        return z !== undefined ? { ...n, z_index: z } : n;
      });
      nodesRef.current = result;
      return result;
    });

    if (canvasId) {
      const updates = Array.from(zChanges.entries()).map(([id, z]) => ({ id, z_index: z }));
      saveNodesBatchDebounced(canvasId, updates);
    }
  }, [nodesInFrames]);


  const visibleNodeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const node of sortedNodes) {
      if (node.visible === false) continue;
      if (isNodeInViewport(node, panX, panY, zoom, viewportSize.w, viewportSize.h)) {
        ids.add(node.id);
        // Sticky: once a node has been on screen it stays mounted. Unmounting
        // destroys the <img>/<video>, and remounting paints one blank frame
        // before the decode lands — that blank IS the flash while panning and
        // the "elements printing in" while the agent adds nodes. Nothing about
        // it is a paint cost we can tune away; the element simply has no pixels
        // yet. isInViewport is still honest below, so VideoNode keeps dropping
        // its src off-screen and what stays resident is decoded images.
        mountedIds.current.add(node.id);
      }
    }
    return ids;
  }, [sortedNodes, panX, panY, zoom, viewportSize.w, viewportSize.h]);

  const contextNode = contextMenu ? nodes.find((n) => n.id === contextMenu.nodeId) : null;
  const contextGroupId = contextMenu?.nodeId ? memberToGroupMap.get(contextMenu.nodeId) : undefined;
  const isGroupNode = contextNode?.node_type === "group" || (!!contextGroupId && !!activeGroupId && !insideGroupId);
  const isImageNode = contextNode && (contextNode.node_type === "image" || contextNode.node_type === "video" || contextNode.node_type === "svg") && !!contextNode.src;
  const isDownloadableNode = contextNode && (contextNode.node_type === "image" || contextNode.node_type === "video" || contextNode.node_type === "svg" || contextNode.node_type === "audio") && !!contextNode.src;

  return (
    <main
      className={`freeform-canvas ${isPanning ? "freeform-canvas--panning" : ""} ${spaceDown.current ? "freeform-canvas--pan-tool" : ""} ${zoomMode ? "freeform-canvas--zoom-mode" : ""} ${marquee ? "freeform-canvas--selecting" : ""} ${dragOver ? "freeform-canvas--drag-over" : ""} ${(frameDraw || shapeDrawHandlers.shapeDraw || textDrawHandlers.textDraw || penDrawHandlers.penState || freehandDrawHandlers.freehandState) ? "freeform-canvas--frame-draw" : (activeTool === "design" && (designSubTool === "frame" || designSubTool === "shape" || designSubTool === "text" || designSubTool === "pen" || designSubTool === "draw") ? "freeform-canvas--frame-draw-ready" : "")} ${isRotating ? "freeform-canvas--rotating" : ""}`}
      ref={viewportRef}
      onPointerDown={handleViewportPointerDown}
      onPointerMove={(e) => { handleViewportPointerMove(e); handleNodePointerMove(e); handleResizePointerMove(e); handleRotatePointerMove(e); svgPathEdit.handleEditPointerMove(e); }}
      onPointerUp={(e) => { handleViewportPointerUp(); handleNodePointerUp(); handleResizePointerUp(); handleRotatePointerUp(e); svgPathEdit.handleEditPointerUp(); }}
      onDoubleClick={handleViewportDoubleClick}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onContextMenu={(e) => {
        if (inFlightText) return;
        e.preventDefault();
        const target = e.target as HTMLElement;
        const isNode = target.closest(".freeform-canvas__node");
        if (!isNode) {
          const canvasPos = screenToCanvas(e.clientX, e.clientY);
          setContextMenu({ x: e.clientX, y: e.clientY, canvasX: canvasPos.x, canvasY: canvasPos.y });
        }
      }}
    >
      {(() => {
        const cell = 24;
        const gridStyle = {
          backgroundPosition: `${panX}px ${panY}px`,
          backgroundSize: `${cell}px ${cell}px`,
        };
        return (
          <>
            <div className="freeform-canvas__grid freeform-canvas__grid--sm" style={gridStyle} />
            {dotPulseKey != null && (
              <div
                key={dotPulseKey}
                className="freeform-canvas__radial-pulse"
                aria-hidden="true"
              />
            )}
          </>
        );
      })()}

      {marquee && (() => {
        const left = Math.min(marquee.startX, marquee.currentX);
        const top = Math.min(marquee.startY, marquee.currentY);
        const w = Math.abs(marquee.currentX - marquee.startX);
        const h = Math.abs(marquee.currentY - marquee.startY);
        return (
          <div className="freeform-canvas__marquee" style={{ left, top, width: w, height: h }} />
        );
      })()}

      {(smartGuides.length > 0 || smartDistanceLabels.length > 0) && (() => {
        const svgW = viewportSize.w || 0;
        const svgH = viewportSize.h || 0;
        return (
        <svg className="freeform-canvas__smart-guides" style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none", overflow: "hidden", zIndex: 3 }}>
          {smartGuides.map((g, i) => {
            const color = "#e879f9";
            const dash = g.type === "spacing" ? "4 3" : "none";
            if (g.orientation === "vertical") {
              const sx = g.position * zoom + panX;
              const sy1 = Math.max(0, g.start * zoom + panY);
              const sy2 = Math.min(svgH, g.end * zoom + panY);
              return <line key={i} x1={sx} y1={sy1} x2={sx} y2={sy2} stroke={color} strokeWidth={1} strokeDasharray={dash} />;
            } else {
              const sy = g.position * zoom + panY;
              const sx1 = Math.max(0, g.start * zoom + panX);
              const sx2 = Math.min(svgW, g.end * zoom + panX);
              return <line key={i} x1={sx1} y1={sy} x2={sx2} y2={sy} stroke={color} strokeWidth={1} strokeDasharray={dash} />;
            }
          })}
          {smartDistanceLabels.map((label, i) => {
            const sx = label.x * zoom + panX;
            const sy = label.y * zoom + panY;
            return (
              <g key={`dl-${i}`}>
                <rect x={sx - 14} y={sy - 9} width={28} height={18} rx={3} fill="rgba(232,121,249,0.3)" stroke="#e879f9" strokeWidth={1} />
                <text x={sx} y={sy + 4} textAnchor="middle" fill="#fff" fontSize={10} fontFamily="system-ui, sans-serif">{Math.round(label.distance)}</text>
              </g>
            );
          })}
        </svg>
        );
      })()}

      {frameDraw && (() => {
        const left = Math.min(frameDraw.startX, frameDraw.currentX);
        const top = Math.min(frameDraw.startY, frameDraw.currentY);
        const w = Math.abs(frameDraw.currentX - frameDraw.startX);
        const h = Math.abs(frameDraw.currentY - frameDraw.startY);
        return (
          <div className="freeform-canvas__frame-draw-preview" style={{ left, top, width: w, height: h }} />
        );
      })()}

      {textDrawHandlers.textDraw && (() => {
        const td = textDrawHandlers.textDraw;
        const left = Math.min(td.startX, td.currentX);
        const top = Math.min(td.startY, td.currentY);
        const w = Math.abs(td.currentX - td.startX);
        const h = Math.abs(td.currentY - td.startY);
        return (
          <div className="freeform-canvas__frame-draw-preview" style={{ left, top, width: w, height: h, borderColor: "#5b5fc7" }} />
        );
      })()}

      {shapeDrawHandlers.shapeDraw && (
        <ShapeDrawGhost shapeDraw={shapeDrawHandlers.shapeDraw} shapeKind={pendingShapeKindRef.current} />
      )}

      {penDrawHandlers.penState && (
        <PenDrawGhost penState={penDrawHandlers.penState} panX={panX} panY={panY} zoom={zoom} />
      )}

      {freehandDrawHandlers.freehandState && (
        <FreehandDrawGhost freehandState={freehandDrawHandlers.freehandState} panX={panX} panY={panY} zoom={zoom} />
      )}


      {canvasError && (
        <div className="freeform-canvas__error-overlay">
          <div className="freeform-canvas__error-box">
            <span className="freeform-canvas__error-msg">{canvasError}</span>
            {canvasError === "Session expired. Please sign in again." ? (
              <button
                className="freeform-canvas__error-retry"
                onClick={() => signIn()}
              >
                Sign in
              </button>
            ) : (
              <button
                className="freeform-canvas__error-retry"
                onClick={() => {
                  const retryProjectId = projectCanvasId;
                  if (!retryProjectId) return;
                  const retryLoadId = ++loadIdRef.current;
                  setCanvasError(null);
                  setCanvasLoaded(false);
                  canvasLoadedRef.current = false;
                  (async () => {
                    const { authFetch } = await import("../contexts/AuthContext");
                    const r = await authFetch(`/api/canvas/${retryProjectId}/load`);
                    if (loadIdRef.current !== retryLoadId) return null;
                    if (r.status === 403) throw new Error("You don't have access to this canvas.");
                    if (!r.ok) throw new Error("retry-fail");
                    return r.json();
                  })()
                    .then((data) => {
                      if (!data || loadIdRef.current !== retryLoadId) return;
                      if (data.canvas) {
                        setCanvasId(data.canvas.id);
                        canvasIdRef.current = data.canvas.id;
                        setPanX(data.canvas.viewport_x || 0);
                        setPanY(data.canvas.viewport_y || 0);
                        setZoom(data.canvas.viewport_zoom || ZOOM_BASELINE);
                        onCanvasReady?.(data.canvas.id);
                      }
                      setNodes(data.nodes || []);
                      canvasLoadedRef.current = true;
                      setCanvasLoaded(true);
                    })
                    .catch((err) => {
                      if (loadIdRef.current !== retryLoadId) return;
                      setCanvasError(err?.message === "retry-fail" ? "Still unable to load canvas. Please try again later." : err?.message || "Still unable to load canvas.");
                      canvasLoadedRef.current = true;
                      setCanvasLoaded(true);
                    });
                }}
              >
                Retry
              </button>
            )}
          </div>
        </div>
      )}

      {snapEnabled && (
        <div className="freeform-canvas__snap-grid" style={{
          backgroundPosition: `${panX}px ${panY}px`,
          backgroundSize: `${gridSize * zoom}px ${gridSize * zoom}px`,
        }} />
      )}

      <div
        className="freeform-canvas__transform"
        style={{ transform: `translate(${panX}px, ${panY}px) scale(${zoom})`, "--zoom": settledZoom } as React.CSSProperties}
      >
        {sortedNodes.map((node) => {
          if (node.visible === false) return null;
          if (node.node_type === "group") return null;
          const inViewport = visibleNodeIds.has(node.id);
          if (!inViewport && !mountedIds.current.has(node.id) && !selectedIds.has(node.id)) return null;
          const isGroupMember = memberToGroupMap.has(node.id);
          const hideHandles = isGroupMember && !insideGroupId;
          return (
            <CanvasNodeComponent
              key={node.id}
              node={node}
              isSelected={selectedIds.has(node.id)}
              isDraggingNode={isDragging && (selectedIds.has(node.id) || dragStart.current.nodePositions.has(node.id))}
              isPlayingVideo={playingVideos.has(node.id)}
              isInViewport={inViewport}
              selectionOrderIndex={selectedImageIds.length > 1 && !multiAllSvg ? selectedImageIds.indexOf(node.id) : -1}
              isFirstFrame={firstFrameId === node.id}
              isLastFrame={lastFrameId === node.id}
              canvasId={canvasId}
              zoom={zoom}
              clipRect={nodeClipRects.get(node.id) || null}
              insideFrame={nodesInFrames.has(node.id) || false}
              hideHandles={hideHandles}
              showDimensionLabel={activeTool === "design"}
              onNodePointerDown={handleNodePointerDown}
              onNodeClick={handleNodeClick}
              onContextMenu={handleContextMenu}
              onResizePointerDown={handleResizePointerDown}
              onRotatePointerDown={handleRotatePointerDown}
              onDownloadNode={downloadNode}
              onSaveToLibrary={handleToolbarSave}
              onSavePrompt={savePrompt}
              onDeleteNode={deleteNode}
              onOpenFullscreen={openFullscreen}
              onToggleVideoPlay={toggleVideoPlay}
              onDropPrompt={onDropPrompt}
              setNodes={setNodes}
              pushUndo={pushUndo}
              inFlightTextNodeId={inFlightTextNodeId}
              inFlightTextBounds={inFlightTextBounds}
              onStartTextEdit={handleStartTextEdit}
              onDoubleClickSvg={svgPathEdit.enterEditMode}
              isEditingPath={svgPathEdit.isEditingPath(node.id)}
              onToggleLock={toggleLockNode}
              onRequestCinemaExport={onRequestCinemaExport}
              incomingDragPreview={cinemaGhost && cinemaGhost.cinemaNodeId === node.id ? (() => {
                const dn = nodes.find((n) => n.id === cinemaGhost.draggedNodeId);
                return {
                  draggedNodeId: cinemaGhost.draggedNodeId,
                  src: cinemaGhost.src,
                  mediaType: cinemaGhost.mediaType,
                  label: dn?.label || undefined,
                  duration: (dn?.metadata as Record<string, unknown>)?.duration as number | undefined,
                  screenX: cinemaGhost.screenX,
                  screenY: cinemaGhost.screenY,
                };
              })() : undefined}
              onTargetTrackChange={cinemaGhost && cinemaGhost.cinemaNodeId === node.id ? handleTargetTrackChange : undefined}
              onCinemaMetaUpdate={node.node_type === "cinema" ? handleCinemaMetaUpdate : undefined}
            />
          );
        })}

        {sortedNodes.map((node) => {
          if (node.visible === false || node.node_type !== "frame") return null;
          if (!node.label && editingFrameLabel !== node.id) return null;
          const inViewport = visibleNodeIds.has(node.id);
          if (!inViewport && !mountedIds.current.has(node.id) && !selectedIds.has(node.id)) return null;
          const isFrameSelected = selectedIds.has(node.id);
          return (
            <div
              key={`frame-label-${node.id}`}
              data-node-id={node.id}
              className={`freeform-canvas__frame-label-overlay ${isFrameSelected ? "freeform-canvas__frame-label-overlay--selected" : ""}`}
              style={{
                position: "absolute",
                left: node.x,
                top: node.y,
                width: node.width,
                height: 0,
                pointerEvents: "none",
                "--zoom": settledZoom,
              } as React.CSSProperties}
            >
              {editingFrameLabel === node.id ? (
                <input
                  className="freeform-canvas__frame-label-input"
                  defaultValue={node.label || ""}
                  autoFocus
                  onBlur={(ev) => { renameFrame(node.id, ev.target.value); setEditingFrameLabel(null); }}
                  onKeyDown={(ev) => { if (ev.key === "Enter") { renameFrame(node.id, (ev.target as HTMLInputElement).value); setEditingFrameLabel(null); } if (ev.key === "Escape") setEditingFrameLabel(null); }}
                  onPointerDown={(ev) => ev.stopPropagation()}
                  onClick={(ev) => ev.stopPropagation()}
                />
              ) : node.label ? (
                <span
                  className="freeform-canvas__frame-label-text"
                  data-frame-label="true"
                  data-node-id={node.id}
                  onPointerDown={(ev) => { ev.stopPropagation(); handleNodePointerDown(ev, node.id); }}
                  onClick={(ev) => { ev.stopPropagation(); handleNodeClick(ev, node.id); }}
                  onDoubleClick={(ev) => { ev.stopPropagation(); setEditingFrameLabel(node.id); }}
                >
                  {node.label}
                </span>
              ) : null}
            </div>
          );
        })}

        {sortedNodes.map((node) => {
          if (node.visible === false || !selectedIds.has(node.id) || node.locked) return null;
          if (node.node_type === "group") return null;
          return (
            <div
              key={`handles-${node.id}`}
              data-node-id={node.id}
              data-node-type={node.node_type}
              className="freeform-canvas__handles-overlay"
              style={{
                position: "absolute",
                left: node.x,
                top: node.y,
                width: node.width,
                height: node.height,
                transform: node.rotation ? `rotate(${node.rotation}deg)` : undefined,
                pointerEvents: inFlightTextNodeId === node.id ? "none" : (node.node_type === "video" ? "none" : "auto"),
                overflow: svgPathEdit.isEditingPath(node.id) ? "visible" : undefined,
                "--zoom": settledZoom,
              } as React.CSSProperties}
              onPointerDown={(e) => handleNodePointerDown(e, node.id)}
              onClick={(e) => { e.stopPropagation(); handleNodeClick(e, node.id); }}
              onDoubleClick={(e) => { e.stopPropagation(); if (node.node_type === "text") handleStartTextEdit(node.id); if (node.node_type === "svg") svgPathEdit.enterEditMode(node.id); }}
              onContextMenu={(e) => { e.stopPropagation(); handleContextMenu(e, node.id); }}
            >
              {svgPathEdit.isEditingPath(node.id) ? (
                <SvgNodeEditHandles
                  pathData={svgPathEdit.getPathData(node.id)!}
                  nodeWidth={node.width}
                  nodeHeight={node.height}
                  selectedPoints={svgPathEdit.selectedPoints}
                  zoom={zoom}
                  isDragging={svgPathEdit.isDragging}
                  editTool={svgPathEdit.editTool}
                  canJoin={svgPathEdit.canJoin}
                  canCut={svgPathEdit.canCut}
                  onToolChange={svgPathEdit.setEditTool}
                  onCutAction={svgPathEdit.handleCutSelected}
                  onJoinAction={svgPathEdit.handleJoinSelected}
                  onExit={svgPathEdit.exitEditMode}
                  onAnchorPointerDown={svgPathEdit.handleAnchorPointerDown}
                  onHandlePointerDown={svgPathEdit.handleHandlePointerDown}
                  onSegmentClick={svgPathEdit.handleSegmentClick}
                />
              ) : selectionBox ? null : (
                <>
                  {(["nw", "ne", "sw", "se"] as const).map((corner) => (
                    <div
                      key={`rot-${corner}`}
                      className={`freeform-canvas__rotate-corner freeform-canvas__rotate-corner--${corner}`}
                      onPointerDown={(e) => handleRotatePointerDown(e, node.id)}
                    />
                  ))}
                  {(["nw", "ne", "sw", "se"] as ResizeHandle[]).map((h) => (
                    <div
                      key={h}
                      className={`freeform-canvas__handle freeform-canvas__handle--${h}`}
                      onPointerDown={(e) => handleResizePointerDown(e, node.id, h)}
                    />
                  ))}
                  {(["n", "s", "w", "e"] as ResizeHandle[]).map((h) => (
                    <div
                      key={h}
                      className={`freeform-canvas__edge-handle freeform-canvas__edge-handle--${h}`}
                      onPointerDown={(e) => handleResizePointerDown(e, node.id, h)}
                    />
                  ))}
                </>
              )}
            </div>
          );
        })}

        {selectionBox && !insideGroupId && (
          <div
            className={`freeform-canvas__group-bbox${selectionBox.kind === "multi" ? " freeform-canvas__group-bbox--multi" : ""}`}
            style={{
              left: selectionBox.bounds.minX,
              top: selectionBox.bounds.minY,
              width: selectionBox.bounds.width,
              height: selectionBox.bounds.height,
              pointerEvents: "none",
              "--zoom": settledZoom,
            } as React.CSSProperties}
          >
            {(["nw", "ne", "sw", "se", "n", "s", "w", "e"] as const).map((h) => (
              <div
                key={h}
                className={`freeform-canvas__group-handle freeform-canvas__group-handle--${h}`}
                style={{ pointerEvents: "auto" }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  const memberIds = selectionBox.memberIds;
                  if (memberIds.length === 0) return;
                  const origMembers = new Map<string, { x: number; y: number; width: number; height: number; metadata?: Record<string, unknown> | null }>();
                  nodes.forEach((n) => {
                    if (memberIds.includes(n.id)) {
                      origMembers.set(n.id, { x: n.x, y: n.y, width: n.width, height: n.height, metadata: n.metadata ? { ...n.metadata } : n.metadata });
                    }
                  });
                  groupResizeState.current = {
                    handle: h,
                    startX: e.clientX,
                    startY: e.clientY,
                    origBounds: { x: selectionBox.bounds.minX, y: selectionBox.bounds.minY, width: selectionBox.bounds.width, height: selectionBox.bounds.height },
                    origMembers,
                    memberIds,
                  };
                  setIsGroupResizing(true);
                  (e.target as HTMLElement).setPointerCapture(e.pointerId);
                }}
                onPointerMove={(e) => {
                  if (!groupResizeState.current) return;
                  const st = groupResizeState.current;
                  const dx = (e.clientX - st.startX) / zoom;
                  const dy = (e.clientY - st.startY) / zoom;
                  const ob = st.origBounds;
                  const h = st.handle;
                  const isCorner = h.length === 2;

                  let rawW = ob.width, rawH = ob.height;
                  let anchorX = ob.x, anchorY = ob.y;
                  if (h.includes("e")) rawW = ob.width + dx;
                  if (h.includes("w")) { rawW = ob.width - dx; anchorX = ob.x + ob.width; }
                  if (h.includes("s")) rawH = ob.height + dy;
                  if (h.includes("n")) { rawH = ob.height - dy; anchorY = ob.y + ob.height; }

                  let scaleX: number, scaleY: number;
                  if (isCorner) {
                    const sW = rawW / ob.width;
                    const sH = rawH / ob.height;
                    const uniform = Math.max(0.1, Math.min(Math.abs(sW), Math.abs(sH)));
                    scaleX = uniform;
                    scaleY = uniform;
                  } else {
                    scaleX = h === "w" || h === "e" ? Math.max(0.1, rawW / ob.width) : 1;
                    scaleY = h === "n" || h === "s" ? Math.max(0.1, rawH / ob.height) : 1;
                  }

                  const newW = ob.width * scaleX;
                  const newH = ob.height * scaleY;
                  let newX: number, newY: number;
                  if (h.includes("w")) { newX = anchorX - newW; } else { newX = anchorX; }
                  if (h.includes("n")) { newY = anchorY - newH; } else { newY = anchorY; }

                  setNodes((prev) => prev.map((n) => {
                    const orig = st.origMembers.get(n.id);
                    if (!orig) return n;
                    return {
                      ...n,
                      x: newX + (orig.x - ob.x) * scaleX,
                      y: newY + (orig.y - ob.y) * scaleY,
                      width: orig.width * scaleX,
                      height: orig.height * scaleY,
                    };
                  }));
                }}
                onPointerUp={(e) => {
                  finalizeGroupResize();
                  try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* noop */ }
                }}
                onPointerCancel={(e) => {
                  finalizeGroupResize();
                  try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* noop */ }
                }}
                onLostPointerCapture={() => {
                  finalizeGroupResize();
                }}
              />
            ))}
          </div>
        )}

        {dragPlaceholder && (
          <div
            className="freeform-canvas__drop-placeholder"
            style={{
              left: dragPlaceholder.x,
              top: dragPlaceholder.y,
              width: dragPlaceholder.w,
              height: dragPlaceholder.h,
            }}
          >
            {dragPlaceholder.url && (
              <img
                src={dragPlaceholder.url}
                alt=""
                className="freeform-canvas__drop-placeholder-img"
              />
            )}
          </div>
        )}
      </div>

      {inFlightText && (
        <TextEditOverlay
          inFlight={inFlightText}
          panX={panX}
          panY={panY}
          zoom={zoom}
          onCommit={handleInFlightCommit}
          onTextChange={handleInFlightTextChange}
        />
      )}

      {presenceEnabled && (
        <RemoteCursorLayer panX={panX} panY={panY} zoom={zoom} />
      )}

      {presenceEnabled && (
        <PresenceAvatarCluster
          onPanTo={(x, y) => navigateToPoint(x, y)}
        />
      )}

      <ZoomToolbar
        zoom={zoom}
        zoomMode={zoomMode}
        snapEnabled={snapEnabled}
        gridSize={gridSize}
        showMinimap={showMinimap}
        toolbarExpanded={toolbarExpanded}
        presentMode={presentMode}
        undoStack={undoStack}
        redoStack={redoStack}
        downloadableCount={downloadableNodes.length}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onZoomToFit={zoomToFit}
        onSetZoomMode={setZoomMode}
        onSetSnapEnabled={setSnapEnabled}
        onSetGridSize={setGridSize}
        onSetShowMinimap={setShowMinimap}
        onSetToolbarExpanded={setToolbarExpanded}
        onUndo={undo}
        onRedo={redo}
        onTogglePresentMode={onTogglePresentMode}
        gridView={gridView}
        onToggleGridView={onToggleGridView}
        onBulkDownload={handleBulkDownload}
      />

      {activeTool === "design" && (
      <div className="design-subtool-bar design-subtool-bar--canvas" onPointerDown={(e) => e.stopPropagation()}>
        <button
          type="button"
          className={`design-subtool-btn ${activeTool === "design" && designSubTool === "select" ? "design-subtool-btn--active" : ""}`}
          title="Select"
          onClick={() => { onActivateDesignTool?.(); onDesignSubToolChange?.("select"); setSubtoolDropdown(null); }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />
            <path d="M13 13l6 6" />
          </svg>
          <span className="design-subtool-label">Select</span>
        </button>

        <div className="design-subtool-sep" />

        <div className="design-subtool-wrapper">
          <button
            type="button"
            className={`design-subtool-btn ${activeTool === "design" && designSubTool === "frame" ? "design-subtool-btn--active" : ""}`}
            title="Frame"
            onClick={() => { onActivateDesignTool?.(); onDesignSubToolChange?.("frame"); setSubtoolDropdown(null); }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 8V5a1 1 0 0 1 1-1h3" />
              <path d="M16 4h3a1 1 0 0 1 1 1v3" />
              <path d="M20 16v3a1 1 0 0 1-1 1h-3" />
              <path d="M8 20H5a1 1 0 0 1-1-1v-3" />
            </svg>
            <span className="design-subtool-label">Frame</span>
          </button>
          <button
            type="button"
            className="design-subtool-chevron"
            title="Frame presets"
            onClick={(e) => { e.stopPropagation(); setSubtoolDropdown(subtoolDropdown === "frame" ? null : "frame"); }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="18 15 12 9 6 15" />
            </svg>
          </button>
          {subtoolDropdown === "frame" && (
            <div className="design-subtool-dropdown" onClick={(e) => e.stopPropagation()}>
              <div className="design-subtool-dropdown-title">Frame Presets</div>
              <button
                type="button"
                className="design-subtool-dropdown-item"
                onClick={() => {
                  const rect = viewportRef.current?.getBoundingClientRect();
                  const vw = rect?.width ?? 1200;
                  const vh = rect?.height ?? 800;
                  const cx = (vw / 2 - panX) / zoom - 400;
                  const cy = (vh / 2 - panY) / zoom - 250;
                  addNodeAtPosition(cx, cy, {
                    node_type: "cinema",
                    // The viewer is what's left after the fixed toolbar and
                    // timeline take their rows, so the height is 1080 plus the
                    // ~620px of chrome — that makes the picture a true 1920x1080.
                    width: 1920,
                    height: 1700,
                    label: "Cinema Frame",
                    locked: true,
                    metadata: { timelineState: { tracks: [{ id: crypto.randomUUID(), type: "video", clips: [] }, { id: crypto.randomUUID(), type: "audio", clips: [] }], playheadPosition: 0, zoomLevel: 1 } },
                  });
                  setSubtoolDropdown(null);
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" />
                  <line x1="7" y1="2" x2="7" y2="22" />
                  <line x1="17" y1="2" x2="17" y2="22" />
                  <line x1="2" y1="12" x2="22" y2="12" />
                </svg>
                <span>Cinema Frame</span>
                <span className="design-subtool-dropdown-dim">1920×1080</span>
              </button>
              {[
                { label: "HD", w: 1920, h: 1080 },
                { label: "Instagram Post", w: 1080, h: 1080 },
                { label: "Story", w: 1080, h: 1920 },
                { label: "4K", w: 3840, h: 2160 },
              ].map((p) => (
                <button
                  key={p.label}
                  type="button"
                  className="design-subtool-dropdown-item"
                  onClick={() => {
                    onActivateDesignTool?.();
                    onDesignSubToolChange?.("frame");
                    onCreateFrame?.(p.w, p.h);
                    setSubtoolDropdown(null);
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x={Math.max(1, (16 - (p.w >= p.h ? 14 : Math.round(14 * p.w / p.h))) / 2)} y={Math.max(1, (16 - (p.h >= p.w ? 14 : Math.round(14 * p.h / p.w))) / 2)} width={p.w >= p.h ? 14 : Math.round(14 * p.w / p.h)} height={p.h >= p.w ? 14 : Math.round(14 * p.h / p.w)} rx="1.5" />
                  </svg>
                  <span>{p.label}</span>
                  <span className="design-subtool-dropdown-dim">{p.w}×{p.h}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="design-subtool-wrapper">
          <button
            type="button"
            className={`design-subtool-btn ${activeTool === "design" && designSubTool === "shape" ? "design-subtool-btn--active" : ""}`}
            title="Shape"
            onClick={() => { onActivateDesignTool?.(); onDesignSubToolChange?.("shape"); setSubtoolDropdown(null); }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
            </svg>
            <span className="design-subtool-label">Shape</span>
          </button>
          <button
            type="button"
            className="design-subtool-chevron"
            title="Shape types"
            onClick={(e) => { e.stopPropagation(); setSubtoolDropdown(subtoolDropdown === "shape" ? null : "shape"); }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="18 15 12 9 6 15" />
            </svg>
          </button>
          {subtoolDropdown === "shape" && (
            <div className="design-subtool-dropdown" onClick={(e) => e.stopPropagation()}>
              <div className="design-subtool-dropdown-title">Shapes</div>
              {[
                { value: "rectangle", label: "Rectangle", icon: <rect x="3" y="3" width="18" height="18" rx="2" /> },
                { value: "ellipse", label: "Ellipse", icon: <ellipse cx="12" cy="12" rx="10" ry="8" /> },
                { value: "triangle", label: "Triangle", icon: <polygon points="12 3 22 21 2 21" /> },
                { value: "diamond", label: "Diamond", icon: <polygon points="12 2 22 12 12 22 2 12" /> },
                { value: "line", label: "Line", icon: <line x1="4" y1="20" x2="20" y2="4" /> },
              ].map((s) => (
                <button
                  key={s.value}
                  type="button"
                  className={`design-subtool-dropdown-item ${pendingShapeKind === s.value ? "design-subtool-dropdown-item--active" : ""}`}
                  onClick={() => {
                    onActivateDesignTool?.();
                    onDesignSubToolChange?.("shape");
                    onPendingShapeKindChange?.(s.value);
                    setSubtoolDropdown(null);
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    {s.icon}
                  </svg>
                  <span>{s.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          type="button"
          className={`design-subtool-btn ${activeTool === "design" && designSubTool === "text" ? "design-subtool-btn--active" : ""}`}
          title="Text"
          onClick={() => { onActivateDesignTool?.(); onDesignSubToolChange?.("text"); setSubtoolDropdown(null); }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="4 7 4 4 20 4 20 7" />
            <line x1="9.5" y1="20" x2="14.5" y2="20" />
            <line x1="12" y1="4" x2="12" y2="20" />
          </svg>
          <span className="design-subtool-label">Text</span>
        </button>

        {!isCinema && (
          <>
            <div className="design-subtool-sep" />

            <div className="design-subtool-wrapper">
              <button
                type="button"
                className={`design-subtool-btn ${activeTool === "design" && (designSubTool === "pen" || designSubTool === "draw") ? "design-subtool-btn--active" : ""}`}
                title="Pen"
                onClick={() => { onActivateDesignTool?.(); onDesignSubToolChange?.("pen"); setSubtoolDropdown(null); }}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 19l7-7 3 3-7 7-3-3z" />
                  <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
                  <path d="M2 2l7.586 7.586" />
                  <circle cx="11" cy="11" r="2" />
                </svg>
                <span className="design-subtool-label">{designSubTool === "draw" ? "Pencil" : "Pen"}</span>
              </button>
              <button
                type="button"
                className="design-subtool-chevron"
                title="Drawing tools"
                onClick={(e) => { e.stopPropagation(); setSubtoolDropdown(subtoolDropdown === "svg" ? null : "svg"); }}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="18 15 12 9 6 15" />
                </svg>
              </button>
              {subtoolDropdown === "svg" && (
                <div className="design-subtool-dropdown" onClick={(e) => e.stopPropagation()}>
                  <div className="design-subtool-dropdown-title">Drawing Tools</div>
                  <button
                    type="button"
                    className={`design-subtool-dropdown-item ${designSubTool === "pen" ? "design-subtool-dropdown-item--active" : ""}`}
                    onClick={() => { onActivateDesignTool?.(); onDesignSubToolChange?.("pen"); setSubtoolDropdown(null); }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 19l7-7 3 3-7 7-3-3z" />
                      <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
                      <path d="M2 2l7.586 7.586" />
                      <circle cx="11" cy="11" r="2" />
                    </svg>
                    <span>Pen</span>
                  </button>
                  <button
                    type="button"
                    className={`design-subtool-dropdown-item ${designSubTool === "draw" ? "design-subtool-dropdown-item--active" : ""}`}
                    onClick={() => { onActivateDesignTool?.(); onDesignSubToolChange?.("draw"); setSubtoolDropdown(null); }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                    </svg>
                    <span>Pencil</span>
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
      )}

      {subtoolDropdown && (
        <div className="design-subtool-backdrop" onClick={() => setSubtoolDropdown(null)} />
      )}

      {showMinimap && viewportSize.w > 0 && (
        <Minimap
          nodes={nodes}
          panX={panX}
          panY={panY}
          zoom={zoom}
          viewportWidth={viewportSize.w}
          viewportHeight={viewportSize.h}
          onNavigate={navigateToPoint}
          selectedIds={selectedIds}
        />
      )}

      {contextMenu && (
        <>
        <div
          className="freeform-canvas__context-backdrop"
          onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); setContextMenu(null); }}
          onWheel={(e) => { e.stopPropagation(); e.preventDefault(); }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        />
        <div
          ref={contextMenuRef}
          className="freeform-canvas__context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.nodeId ? (
            <>
              {isImageNode && onToolSelect && (
                <>
                  {[
                    { id: "create", label: "Create", icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v18" /><path d="M3 12h18" /><circle cx="12" cy="12" r="9" /></svg> },
                    { id: "upscale", label: "Upscale", icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></svg> },
                    { id: "resize", label: "Resize", icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" rx="1" /></svg> },
                    { id: "remove", label: "Remove BG", icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 20H7L3 16l9-9 8 8-3 3" /><path d="M6.05 17.95L2 22" /><path d="M15 4l5 5" /></svg> },
                    { id: "design", label: "Design", icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18" /><path d="M9 21V9" /></svg> },
                  ].map((tool) => (
                    <button
                      key={tool.id}
                      type="button"
                      className="freeform-canvas__context-item"
                      onClick={() => { onToolSelect(tool.id); setContextMenu(null); }}
                    >
                      {tool.icon}
                      {tool.label}
                    </button>
                  ))}
                </>
              )}
              {isImageNode && (
                <>
                  <div className="freeform-canvas__context-divider" />
                  {libMatch ? (
                    <button
                      type="button"
                      className="freeform-canvas__context-item freeform-canvas__context-item--in-library"
                      onClick={() => {
                        const node = contextNode!;
                        const viewType = node.node_type === "video" ? "videos" : "images";
                        setContextMenu(null);
                        onOpenLibrary?.(viewType, libMatch.folderId ?? undefined, libMatch.assetId);
                      }}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                      In Library: {libMatch.folderName}
                    </button>
                  ) : (
                    <div
                      className="freeform-canvas__context-folder-picker"
                      onMouseEnter={() => {
                        if (libSaved || libSaveError) return;
                        if (libFolderMenuTimer.current) clearTimeout(libFolderMenuTimer.current);
                        if (!libFolderMenuOpen) {
                          setLibFolderMenuOpen(true);
                          fetchLibFolders();
                        }
                      }}
                      onMouseLeave={() => {
                        libFolderMenuTimer.current = setTimeout(() => {
                          setLibFolderMenuOpen(false);
                          libFolderMenuTimer.current = null;
                        }, 200);
                      }}
                    >
                      <button
                        type="button"
                        className={`freeform-canvas__context-item${libSaved ? " freeform-canvas__context-item--saved" : ""}${libSaveError ? " freeform-canvas__context-item--error" : ""}`}
                        disabled={libSaved || libSaveError}
                        onClick={() => {
                          if (libSaved || libSaveError) return;
                          if (!libFolderMenuOpen) {
                            setLibFolderMenuOpen(true);
                            fetchLibFolders();
                          }
                        }}
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                        </svg>
                        {libSaveError ? "Failed" : libSaved ? "Saved!" : "Add to Library"}
                        {!libSaved && !libSaveError && (
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: "auto" }}>
                            <polyline points="9 18 15 12 9 6" />
                          </svg>
                        )}
                      </button>
                      {libFolderMenuOpen && !libSaved && !libSaveError && (
                        <div className="freeform-canvas__context-folder-submenu">
                          {libFoldersLoading ? (
                            <div className="freeform-canvas__context-folder-loading">Loading…</div>
                          ) : (
                            libFolders.map((folder) => (
                              <button
                                key={folder.id || `__default_${folder.name}`}
                                type="button"
                                className="freeform-canvas__context-item"
                                onClick={() => {
                                  const node = contextNode!;
                                  setLibSaved(true);
                                  setLibFolderMenuOpen(false);
                                  if (libSaveTimer.current) clearTimeout(libSaveTimer.current);
                                  const vpRect = viewportRef.current?.getBoundingClientRect();
                                  if (vpRect) {
                                    const srcRect = {
                                      x: node.x * zoom + panX + vpRect.left,
                                      y: node.y * zoom + panY + vpRect.top,
                                      width: node.width * zoom,
                                      height: node.height * zoom,
                                    };
                                    triggerLibrarySaveAnimation([srcRect], node.src);
                                  }
                                  saveNodeToLibraryOptimistic(
                                    node,
                                    () => onLibrarySaved?.(),
                                    folder.id || undefined,
                                    folder.name,
                                  ).then((result) => {
                                    if (result.ok) {
                                      libSaveTimer.current = setTimeout(() => { setLibSaved(false); setContextMenu(null); libSaveTimer.current = null; }, 800);
                                    } else {
                                      setLibSaved(false);
                                      setLibSaveError(true);
                                      libSaveTimer.current = setTimeout(() => { setLibSaveError(false); libSaveTimer.current = null; }, 2000);
                                    }
                                  });
                                }}
                              >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                                </svg>
                                <span className="freeform-canvas__context-folder-name">{folder.name}</span>
                              </button>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
              {isDownloadableNode && (
                <>
                  {!isImageNode && <div className="freeform-canvas__context-divider" />}
                  <button
                    type="button"
                    className="freeform-canvas__context-item"
                    onClick={async () => {
                      const node = contextNode!;
                      const url = node.src || "";
                      if (!url) return;
                      setContextMenu(null);
                      const ext = node.node_type === "audio" ? ".mp3" : node.node_type === "video" ? ".mp4" : node.node_type === "svg" ? ".svg" : ".png";
                      await downloadAsset(url, (node.label || "download") + ext);
                    }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                    Download
                  </button>
                </>
              )}
              {(isImageNode || isDownloadableNode) && <div className="freeform-canvas__context-divider" />}
              <button
                type="button"
                className="freeform-canvas__context-item"
                onClick={() => {
                  let copySet: typeof nodes = [];
                  if (activeGroupId && !insideGroupId) {
                    const gNode = nodes.find((n) => n.id === activeGroupId);
                    if (gNode && Array.isArray(gNode.metadata?.members)) {
                      const mids = new Set(gNode.metadata.members as string[]);
                      copySet = nodes.filter((n) => mids.has(n.id));
                    }
                  }
                  if (copySet.length === 0) {
                    copySet = nodes.filter((n) => selectedIds.has(n.id));
                  }
                  if (copySet.length > 0) {
                    copyNodes(copySet);
                  } else if (contextMenu.nodeId) {
                    const contextNode = nodes.find((n) => n.id === contextMenu.nodeId);
                    if (contextNode) copyNodes([contextNode]);
                  }
                  setContextMenu(null);
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                Copy
              </button>
              <button
                type="button"
                className="freeform-canvas__context-item"
                disabled={clipboardRef.current.length === 0}
                onClick={() => {
                  pasteNodes();
                  setContextMenu(null);
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="8" y="2" width="8" height="4" rx="1" ry="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /></svg>
                Paste
              </button>
              {contextNode && (contextNode.node_type === "image" || contextNode.node_type === "video") && (() => {
                const meta = (contextNode.metadata || {}) as Record<string, unknown>;
                const prompt =
                  (typeof meta.prompt === "string" && meta.prompt) ||
                  (typeof meta.promptText === "string" && meta.promptText) ||
                  (typeof meta.userPrompt === "string" && meta.userPrompt) ||
                  "";
                if (!prompt) return null;
                return (
                  <button
                    type="button"
                    className="freeform-canvas__context-item"
                    onClick={() => {
                      try {
                        void navigator.clipboard?.writeText(prompt);
                      } catch {
                        /* ignore — clipboard may be blocked */
                      }
                      setContextMenu(null);
                    }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="9" y1="13" x2="15" y2="13" /><line x1="9" y1="17" x2="15" y2="17" /></svg>
                    Copy Prompt
                  </button>
                );
              })()}
              <div className="freeform-canvas__context-divider" />
              <button
                type="button"
                className="freeform-canvas__context-item"
                onClick={() => toggleLockNode(contextMenu.nodeId!)}
              >
                {nodes.find((n) => n.id === contextMenu.nodeId)?.locked ? (
                  <><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 9.9-1" /></svg> Unlock</>
                ) : (
                  <><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg> Lock</>
                )}
              </button>
              <div className="freeform-canvas__context-divider" />
              <div className="freeform-canvas__context-submenu">
                <span className="freeform-canvas__context-submenu-label">Layer</span>
                <button type="button" className="freeform-canvas__context-item" onClick={() => { layerBringToTop(); setContextMenu(null); }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 11 12 6 7 11" /><polyline points="17 18 12 13 7 18" /></svg>
                  Bring to Top
                </button>
                <button type="button" className="freeform-canvas__context-item" onClick={() => { layerMoveUp(); setContextMenu(null); }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15" /></svg>
                  Move Up
                </button>
                <button type="button" className="freeform-canvas__context-item" onClick={() => { layerMoveDown(); setContextMenu(null); }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
                  Move Down
                </button>
                <button type="button" className="freeform-canvas__context-item" onClick={() => { layerSendToBottom(); setContextMenu(null); }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="7 13 12 18 17 13" /><polyline points="7 6 12 11 17 6" /></svg>
                  Send to Bottom
                </button>
              </div>
              {selectedIds.size >= 2 && !isGroupNode && (
                <button
                  type="button"
                  className="freeform-canvas__context-item"
                  onClick={groupSelected}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16.5 9.4l-9-5.19" /><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><polyline points="3.27 6.96 12 12.01 20.73 6.96" /><line x1="12" y1="22.08" x2="12" y2="12" /></svg>
                  Group
                </button>
              )}
              {isGroupNode && (
                <>
                  <button
                    type="button"
                    className="freeform-canvas__context-item"
                    onClick={() => {
                      const gid = contextGroupId || contextMenu.nodeId!;
                      ungroupNode(gid);
                      setActiveGroupId(null);
                    }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><path d="M12 22v-6" /><path d="M12 8V2" /><path d="M20.7 7L12 12 3.3 7" /><path d="M3.3 17L12 12l8.7 5" /></svg>
                    Ungroup
                  </button>
                  <div className="freeform-canvas__context-divider" />
                  <button
                    type="button"
                    className="freeform-canvas__context-item freeform-canvas__context-item--danger"
                    onClick={() => { deleteSelectedNodes(); setContextMenu(null); }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" /></svg>
                    Delete
                  </button>
                </>
              )}
              {!isGroupNode && (
                <>
                  <div className="freeform-canvas__context-divider" />
                  <button
                    type="button"
                    className="freeform-canvas__context-item freeform-canvas__context-item--danger"
                    onClick={() => { deleteSelectedNodes(); setContextMenu(null); }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" /></svg>
                    Delete
                  </button>
                </>
              )}
            </>
          ) : (
            <>
              <button
                type="button"
                className="freeform-canvas__context-item"
                onClick={async () => {
                  setContextMenu(null);
                  if (clipboardRef.current.length > 0) {
                    pasteNodes();
                    return;
                  }
                  try {
                    const clipboardItems = await navigator.clipboard.read();
                    for (const item of clipboardItems) {
                      const imageType = item.types.find((t) => t.startsWith("image/"));
                      if (imageType) {
                        const blob = await item.getType(imageType);
                        const url = URL.createObjectURL(blob);
                        const img = new Image();
                        img.onload = () => {
                          const cx = contextMenu.canvasX ?? 0;
                          const cy = contextMenu.canvasY ?? 0;
                          addNodeAtPosition(cx - img.width / 2, cy - img.height / 2, {
                            src: url,
                            label: "Pasted image",
                            width: img.width,
                            height: img.height,
                          });
                        };
                        img.src = url;
                        return;
                      }
                    }
                  } catch {}
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="8" y="2" width="8" height="4" rx="1" ry="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /></svg>
                Paste
              </button>
              {nodes.length > 0 && (
                <button
                  type="button"
                  className="freeform-canvas__context-item"
                  onClick={() => {
                    if (onSelectMultiple) {
                      const sorted = sortNodesReadingOrder(nodes.filter((n) => n.node_type !== "group"));
                      onSelectMultiple(sorted.map((n) => n.id), "exclusive");
                    }
                    setContextMenu(null);
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 12l2 2 4-4" /></svg>
                  Select All
                </button>
              )}
              {selectedIds.size > 0 && (
                <button
                  type="button"
                  className="freeform-canvas__context-item"
                  onClick={() => {
                    if (onDeselectAll) onDeselectAll();
                    setContextMenu(null);
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /></svg>
                  Deselect All
                </button>
              )}
              <div className="freeform-canvas__context-divider" />
              <button
                type="button"
                className="freeform-canvas__context-item"
                onClick={() => {
                  if (onToolSelectRef.current) onToolSelectRef.current("design");
                  setContextMenu(null);
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" /></svg>
                Design
              </button>
              <div className="freeform-canvas__context-divider" />
              <button
                type="button"
                className="freeform-canvas__context-item"
                onClick={() => { zoomToFit(); setContextMenu(null); }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6" /><path d="M9 21H3v-6" /><path d="M21 3l-7 7" /><path d="M3 21l7-7" /></svg>
                Fit All
              </button>
              <button
                type="button"
                className="freeform-canvas__context-item"
                onClick={() => {
                  setZoom(ZOOM_BASELINE);
                  const rect = viewportRef.current?.getBoundingClientRect();
                  if (rect) {
                    setPanX(rect.width / 2);
                    setPanY(rect.height / 2);
                  }
                  setContextMenu(null);
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="8" y1="11" x2="14" y2="11" /></svg>
                Reset Zoom
              </button>
              <button
                type="button"
                className="freeform-canvas__context-item"
                onClick={() => { setSnapEnabled((s) => !s); setContextMenu(null); }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></svg>
                {snapEnabled ? "Disable Snap" : "Enable Snap"}
              </button>
            </>
          )}
        </div>
        </>
      )}
      {pendingPlacement && placementGhost && (
        <div
          className="freeform-canvas__placement-ghost"
          style={{
            left: placementGhost.x,
            top: placementGhost.y,
          }}
        >
          {pendingPlacement.isAudio ? (
            <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(99, 102, 241, 0.15)", borderRadius: 6, color: "rgba(167, 139, 250, 0.9)" }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>
            </div>
          ) : pendingPlacement.isVideo ? (
            <video src={pendingPlacement.url} muted playsInline preload="metadata" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 6 }} />
          ) : (
            <img src={pendingPlacement.url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 6 }} />
          )}
        </div>
      )}
      <MediaModal
        target={fullscreen.open ? { kind: fullscreen.type === "video" ? "video" : "image", src: fullscreen.src } : null}
        onClose={closeFullscreen}
      />
      <SyncStatusIndicator status={syncStatus} failedSeconds={syncFailedSeconds} onRetry={retrySyncNow} />
    </main>
  );
}
