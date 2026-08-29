import { useEffect, useCallback, useMemo, type MutableRefObject } from "react";
import type { CanvasNode, CanvasApi } from "../types/canvas";
import { useFrameExport } from "./useFrameExport";
import { useVideoFrameExport } from "./useVideoFrameExport";
import type { VideoExportResolution } from "../utils/videoFrameExport";
import { getDefaultFrameFill } from "../theme";

type UseFrameApiParams = {
  viewportRef: MutableRefObject<HTMLDivElement | null>;
  nodesRef: MutableRefObject<CanvasNode[]>;
  panXRef: MutableRefObject<number>;
  panYRef: MutableRefObject<number>;
  zoomRef: MutableRefObject<number>;
  canvasIdRef: MutableRefObject<string | null>;
  addNodeAtPosition: (x: number, y: number, props: Partial<CanvasNode>) => CanvasNode;
  setNodes: React.Dispatch<React.SetStateAction<CanvasNode[]>>;
  saveNodesBatchDebounced: (canvasId: string, updates: { id: string; [key: string]: unknown }[]) => void;
  onCanvasApi?: (api: CanvasApi) => void;
  selectedIdsRef: MutableRefObject<Set<string>>;
  setPanX: React.Dispatch<React.SetStateAction<number>>;
  setPanY: React.Dispatch<React.SetStateAction<number>>;
  setZoom: React.Dispatch<React.SetStateAction<number>>;
  // Optional local-id → server-id map. When the canvas sync engine remaps a
  // freshly created node's id (e.g. `local-…` → server uuid) callers like the
  // right-panel `startGeneration` can still hand us the original local id to
  // attach a job_id to — we'll resolve it through the map.
  idMapRef?: MutableRefObject<Map<string, string>>;
};

export function useFrameApi({
  viewportRef,
  nodesRef,
  panXRef,
  panYRef,
  zoomRef,
  canvasIdRef,
  addNodeAtPosition,
  setNodes,
  saveNodesBatchDebounced,
  onCanvasApi,
  selectedIdsRef,
  setPanX,
  setPanY,
  setZoom,
  idMapRef,
}: UseFrameApiParams) {
  const nextFrameName = useCallback(() => {
    const existing = nodesRef.current.filter((n) => n.node_type === "frame");
    const nums = existing
      .map((n) => n.label?.match(/^Frame (\d+)$/)?.[1])
      .filter(Boolean)
      .map(Number);
    const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
    return `Frame ${next}`;
  }, [nodesRef]);

  const addFrame = useCallback((width: number, height: number) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = (rect.width / 2 - panXRef.current) / zoomRef.current;
    const cy = (rect.height / 2 - panYRef.current) / zoomRef.current;
    addNodeAtPosition(cx - width / 2, cy - height / 2, {
      node_type: "frame",
      width,
      height,
      label: nextFrameName(),
      metadata: { fill: getDefaultFrameFill(), nativeWidth: width, nativeHeight: height },
    });
  }, [viewportRef, panXRef, panYRef, zoomRef, addNodeAtPosition, nextFrameName]);

  const addFrameAtPosition = useCallback((x: number, y: number, width: number, height: number) => {
    addNodeAtPosition(x, y, {
      node_type: "frame",
      width,
      height,
      label: nextFrameName(),
      metadata: { fill: getDefaultFrameFill(), nativeWidth: width, nativeHeight: height },
    });
  }, [addNodeAtPosition, nextFrameName]);

  const updateFrameColor = useCallback((nodeId: string, color: string) => {
    setNodes((prev) =>
      prev.map((n) =>
        n.id === nodeId ? { ...n, metadata: { ...n.metadata, fill: color } } : n
      )
    );
    const cid = canvasIdRef.current;
    if (cid) {
      const node = nodesRef.current.find((n) => n.id === nodeId);
      if (node) {
        saveNodesBatchDebounced(cid, [{ id: nodeId, metadata: { ...node.metadata, fill: color } }]);
      }
    }
  }, [setNodes, canvasIdRef, nodesRef, saveNodesBatchDebounced]);

  const { exportFrames } = useFrameExport(nodesRef);

  const handleExportFrame = useCallback((nodeId: string) => {
    exportFrames([nodeId], "png");
  }, [exportFrames]);

  const handleExportFrames = useCallback((nodeIds: string[], format: "png" | "pdf") => {
    exportFrames(nodeIds, format);
  }, [exportFrames]);

  const videoFrameExport = useVideoFrameExport();
  const exportFrameAsVideo = useCallback(
    (frameId: string, resolution: VideoExportResolution, includeAudio: boolean) => {
      videoFrameExport.start({
        frameId,
        resolution,
        includeAudio,
        nodes: nodesRef.current,
      });
    },
    [videoFrameExport, nodesRef]
  );
  const videoExportApi = useMemo(
    () => ({
      isExporting: videoFrameExport.isExporting,
      stage: videoFrameExport.stage,
      progress: videoFrameExport.progress,
      error: videoFrameExport.error,
      start: exportFrameAsVideo,
      cancel: videoFrameExport.cancel,
      reset: videoFrameExport.reset,
    }),
    [
      videoFrameExport.isExporting,
      videoFrameExport.stage,
      videoFrameExport.progress,
      videoFrameExport.error,
      videoFrameExport.cancel,
      videoFrameExport.reset,
      exportFrameAsVideo,
    ]
  );

  const updateNodeTransform = useCallback((nodeId: string, props: { x?: number; y?: number; width?: number; height?: number; rotation?: number }) => {
    setNodes((prev) =>
      prev.map((n) => {
        if (n.id !== nodeId) return n;
        const updated = { ...n };
        if (props.x !== undefined) updated.x = props.x;
        if (props.y !== undefined) updated.y = props.y;
        if (props.width !== undefined) updated.width = Math.max(1, props.width);
        if (props.height !== undefined) updated.height = Math.max(1, props.height);
        if (props.rotation !== undefined) updated.rotation = props.rotation;
        return updated;
      })
    );
    const cid = canvasIdRef.current;
    if (cid) {
      saveNodesBatchDebounced(cid, [{ id: nodeId, ...props }]);
    }
  }, [setNodes, canvasIdRef, saveNodesBatchDebounced]);

  const updateNodeMetadata = useCallback((nodeId: string, meta: Record<string, unknown>) => {
    setNodes((prev) => {
      const updated = prev.map((n) => {
        if (n.id !== nodeId) return n;
        const mergedMeta: Record<string, unknown> = { ...(n.metadata || {}), ...meta };
        return { ...n, metadata: mergedMeta };
      });
      const node = updated.find((n) => n.id === nodeId);
      const cid = canvasIdRef.current;
      if (node && cid) {
        saveNodesBatchDebounced(cid, [{ id: nodeId, metadata: node.metadata }]);
      }
      return updated;
    });
  }, [setNodes, canvasIdRef, saveNodesBatchDebounced]);

  const alignNodes = useCallback((axis: "left" | "centerH" | "right" | "top" | "centerV" | "bottom" | "distributeH" | "distributeV") => {
    const ids = selectedIdsRef.current;
    if (ids.size < 2 && !["left", "centerH", "right", "top", "centerV", "bottom"].includes(axis)) return;
    const selected = nodesRef.current.filter((n) => ids.has(n.id));
    if (selected.length === 0) return;

    const updates: Record<string, { x?: number; y?: number }> = {};

    if (axis === "left") {
      const minX = Math.min(...selected.map((n) => n.x));
      selected.forEach((n) => { updates[n.id] = { x: minX }; });
    } else if (axis === "centerH") {
      const minX = Math.min(...selected.map((n) => n.x));
      const maxX = Math.max(...selected.map((n) => n.x + n.width));
      const center = (minX + maxX) / 2;
      selected.forEach((n) => { updates[n.id] = { x: center - n.width / 2 }; });
    } else if (axis === "right") {
      const maxX = Math.max(...selected.map((n) => n.x + n.width));
      selected.forEach((n) => { updates[n.id] = { x: maxX - n.width }; });
    } else if (axis === "top") {
      const minY = Math.min(...selected.map((n) => n.y));
      selected.forEach((n) => { updates[n.id] = { y: minY }; });
    } else if (axis === "centerV") {
      const minY = Math.min(...selected.map((n) => n.y));
      const maxY = Math.max(...selected.map((n) => n.y + n.height));
      const center = (minY + maxY) / 2;
      selected.forEach((n) => { updates[n.id] = { y: center - n.height / 2 }; });
    } else if (axis === "bottom") {
      const maxY = Math.max(...selected.map((n) => n.y + n.height));
      selected.forEach((n) => { updates[n.id] = { y: maxY - n.height }; });
    } else if (axis === "distributeH") {
      if (selected.length < 3) return;
      const sorted = [...selected].sort((a, b) => a.x - b.x);
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const totalSpace = (last.x + last.width) - first.x;
      const totalNodeWidth = sorted.reduce((sum, n) => sum + n.width, 0);
      const gap = (totalSpace - totalNodeWidth) / (sorted.length - 1);
      let cx = first.x + first.width + gap;
      for (let i = 1; i < sorted.length - 1; i++) {
        updates[sorted[i].id] = { x: cx };
        cx += sorted[i].width + gap;
      }
    } else if (axis === "distributeV") {
      if (selected.length < 3) return;
      const sorted = [...selected].sort((a, b) => a.y - b.y);
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const totalSpace = (last.y + last.height) - first.y;
      const totalNodeHeight = sorted.reduce((sum, n) => sum + n.height, 0);
      const gap = (totalSpace - totalNodeHeight) / (sorted.length - 1);
      let cy = first.y + first.height + gap;
      for (let i = 1; i < sorted.length - 1; i++) {
        updates[sorted[i].id] = { y: cy };
        cy += sorted[i].height + gap;
      }
    }

    setNodes((prev) =>
      prev.map((n) => {
        const u = updates[n.id];
        if (!u) return n;
        return { ...n, ...u };
      })
    );
    const cid = canvasIdRef.current;
    if (cid) {
      const batch = Object.entries(updates).map(([id, u]) => ({ id, ...u }));
      if (batch.length > 0) saveNodesBatchDebounced(cid, batch);
    }
  }, [nodesRef, selectedIdsRef, setNodes, canvasIdRef, saveNodesBatchDebounced]);

  const updateNode = useCallback((nodeId: string, fields: Partial<CanvasNode>) => {
    // Resolve a stale local-id (e.g. `local-…`) to the server-assigned uuid
    // when the sync engine has remapped the node since the caller last saw it.
    // Without this, right-panel `startGeneration` calls that fire after the
    // create sync resolves would silently no-op (no node matches the old id),
    // leaving the placeholder spinner forever and the polling effect blind.
    //
    // To stay race-proof against the order of `handleIdRemap`'s setNodes vs.
    // ours, we match on EITHER id inside setNodes (so the update lands no
    // matter which version of the id is currently in state), and capture the
    // actual matched id to use for the debounced server-side persistence so
    // we always send the canonical (server) id when one is known.
    const remapped = idMapRef?.current.get(nodeId);
    let matchedId: string | null = null;
    setNodes((prev) =>
      prev.map((n) => {
        const isMatch = n.id === nodeId || (remapped !== undefined && n.id === remapped);
        if (!isMatch) return n;
        matchedId = n.id;
        const next = { ...n, ...fields } as CanvasNode;
        if (fields.metadata) {
          next.metadata = { ...(n.metadata || {}), ...(fields.metadata as Record<string, unknown>) };
        }
        return next;
      })
    );
    const cid = canvasIdRef.current;
    if (cid) {
      // Prefer the id we actually matched (post-setNodes); fall back to the
      // remap or the caller's id if the match wasn't observed (e.g. node was
      // deleted in flight) — saveNodesBatchDebounced is a no-op if the id is
      // unknown to the sync engine.
      const persistId = matchedId || remapped || nodeId;
      const updated = nodesRef.current.find((n) => n.id === persistId);
      const merged: { id: string; [key: string]: unknown } = { id: persistId, ...fields };
      if (fields.metadata && updated) {
        merged.metadata = { ...(updated.metadata || {}), ...(fields.metadata as Record<string, unknown>) };
      }
      saveNodesBatchDebounced(cid, [merged]);
    }
  }, [setNodes, canvasIdRef, nodesRef, saveNodesBatchDebounced, idMapRef]);

  const getViewport = useCallback(() => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const w = rect?.width ?? 0;
    const h = rect?.height ?? 0;
    const usableW = Math.max(1, w);
    const cx = (usableW / 2 - panXRef.current) / zoomRef.current;
    const cy = (h / 2 - panYRef.current) / zoomRef.current;
    return {
      cx,
      cy,
      w: usableW / zoomRef.current,
      h: h / zoomRef.current,
      panX: panXRef.current,
      panY: panYRef.current,
      zoom: zoomRef.current,
    };
  }, [viewportRef, panXRef, panYRef, zoomRef]);

  const centerOnNode = useCallback((nodeId: string, opts?: { zoom?: number; animate?: boolean }) => {
    const node = nodesRef.current.find((n) => n.id === nodeId);
    if (!node) return;
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const usableW = Math.max(1, rect.width);
    // Choose a zoom that fits the node with some padding (60% of viewport).
    const target = opts?.zoom;
    const fitZoomW = (usableW * 0.6) / Math.max(1, node.width);
    const fitZoomH = (rect.height * 0.6) / Math.max(1, node.height);
    const fitZoom = Math.max(0.025, Math.min(target ?? Math.min(fitZoomW, fitZoomH), 1.25));
    const cxNode = node.x + node.width / 2;
    const cyNode = node.y + node.height / 2;
    const newPanX = usableW / 2 - cxNode * fitZoom;
    const newPanY = rect.height / 2 - cyNode * fitZoom;
    setZoom(fitZoom);
    setPanX(newPanX);
    setPanY(newPanY);
  }, [nodesRef, viewportRef, setZoom, setPanX, setPanY]);

  const getNodes = useCallback(() => nodesRef.current, [nodesRef]);

  useEffect(() => {
    if (!onCanvasApi) return;
    onCanvasApi({ addFrame, addFrameAtPosition, updateFrameColor, exportFrame: handleExportFrame, exportFrames: handleExportFrames, videoExport: videoExportApi, updateNodeTransform, updateNodeMetadata, alignNodes, updateNode, getViewport, centerOnNode, getNodes } as CanvasApi);
  }, [onCanvasApi, addFrame, addFrameAtPosition, updateFrameColor, handleExportFrame, handleExportFrames, videoExportApi, updateNodeTransform, updateNodeMetadata, alignNodes, updateNode, getViewport, centerOnNode, getNodes]);
}
