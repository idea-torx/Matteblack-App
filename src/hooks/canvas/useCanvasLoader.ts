import { useRef, useState, useEffect, useMemo, useCallback } from "react";
import type { CanvasNode } from "../../types/canvas";
import { DEBOUNCE_MS, ZOOM_BASELINE } from "../../types/canvas";
import { authFetch } from "../../contexts/AuthContext";
import {
  getCanvasEntry,
  loadCanvasEntry,
  saveCanvasEntry,
  updateCanvasEntryNodes,
  updateCanvasEntryViewport,
  invalidateCanvasEntry,
  enqueueDirty,
  getDirtyQueue,
  removeDirtyEntries,
  getIdMapping,
  initStore,
  waitForStoreReady,
  type CanvasEntry,
  type DirtyMutation,
} from "../../services/CanvasStore";
import { CanvasSyncEngine, getCanvasSessionId } from "../../services/CanvasSyncEngine";
import { useCanvasSSE } from "./useCanvasSSE";
import { assembleTimelineFromDb, type DbTrack } from "../../features/cinema-frame/helpers/cinemaSync";
import { getContainedNodes } from "../../utils/canvasUtils";
import type { BatchUpdate } from "../../utils/canvasUtils";
import { useSyncStatus } from "../../components/canvas/SyncStatusIndicator";

type UseCanvasLoaderParams = {
  activeWorkspaceId: string | undefined;
  projectCanvasId: string | null | undefined;
  onCanvasReady?: (canvasId: string) => void;
  onLoadingChange?: (loading: boolean) => void;
  initCache: CanvasEntry | null;
  nextZRef: React.MutableRefObject<number>;
  nextFrameZRef: React.MutableRefObject<number>;
  canvasIdRef: React.MutableRefObject<string | null>;
  idMapRef?: React.MutableRefObject<Map<string, string>>;
  onIdRemapped?: (localId: string, serverId: string) => void;
};

function reconcileWithDirty(
  serverNodes: CanvasNode[],
  dirtyQueue: DirtyMutation[],
  tombstonedIds: Set<string> = new Set()
): CanvasNode[] {
  let nodes = [...serverNodes];
  const nodeMap = new Map<string, CanvasNode>();
  nodes.forEach((n) => nodeMap.set(n.id, n));

  for (const mut of dirtyQueue) {
    if (mut.type === "create") {
      const existingServerId = getIdMapping(mut.localId);
      // If the server has tombstoned the create's local or mapped id, the
      // node was deleted server-side — don't resurrect it from the dirty
      // queue. The stale create is dropped further down.
      if (tombstonedIds.has(mut.localId)) continue;
      if (existingServerId && tombstonedIds.has(existingServerId)) continue;
      if (existingServerId && nodeMap.has(existingServerId)) continue;
      if (!nodeMap.has(mut.localId)) {
        nodeMap.set(mut.localId, { ...mut.node });
      }
    } else if (mut.type === "update") {
      let nodeId = mut.nodeId;
      const mapped = getIdMapping(nodeId);
      if (mapped) nodeId = mapped;
      const existing = nodeMap.get(nodeId) || nodeMap.get(mut.nodeId);
      if (existing) {
        const updated = { ...existing, ...mut.fields } as CanvasNode;
        nodeMap.set(existing.id, updated);
      }
    } else if (mut.type === "delete") {
      let nodeId = mut.nodeId;
      const mapped = getIdMapping(nodeId);
      if (mapped) nodeId = mapped;
      nodeMap.delete(nodeId);
      nodeMap.delete(mut.nodeId);
    }
  }

  return Array.from(nodeMap.values());
}

export function useCanvasLoader({
  activeWorkspaceId,
  projectCanvasId,
  onCanvasReady,
  onLoadingChange,
  initCache,
  nextZRef,
  nextFrameZRef,
  canvasIdRef,
  idMapRef,
  onIdRemapped,
}: UseCanvasLoaderParams) {
  const [nodes, setNodes] = useState<CanvasNode[]>(initCache?.nodes ?? []);
  const [canvasLoaded, setCanvasLoaded] = useState(!!initCache);
  const [canvasId, setCanvasId] = useState<string | null>(initCache?.canvasId ?? null);
  const [canvasError, setCanvasError] = useState<string | null>(null);
  const [reloadCounter, setReloadCounter] = useState(0);
  const [panX, setPanX] = useState(initCache?.viewportX ?? 0);
  const [panY, setPanY] = useState(initCache?.viewportY ?? 0);
  const [zoom, setZoom] = useState(initCache?.viewportZoom ?? ZOOM_BASELINE);

  const cacheKeyRef = useRef<string | null>(null);
  const loadIdRef = useRef(0);
  const canvasLoadedRef = useRef(!!initCache);
  const panXRef = useRef(panX);
  const panYRef = useRef(panY);
  const zoomRef = useRef(zoom);
  panXRef.current = panX;
  panYRef.current = panY;
  zoomRef.current = zoom;

  const syncEngineRef = useRef<CanvasSyncEngine | null>(null);
  const { status: syncStatus, failedSeconds: syncFailedSeconds, markSyncing, markSynced, markFailed } = useSyncStatus();

  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  const idMapRefStable = useRef(idMapRef);
  idMapRefStable.current = idMapRef;
  const onIdRemappedRef = useRef(onIdRemapped);
  onIdRemappedRef.current = onIdRemapped;

  const handleIdRemap = useCallback((localId: string, serverId: string) => {
    if (idMapRefStable.current) {
      idMapRefStable.current.current.set(localId, serverId);
    }
    setNodes((prev) => {
      const updated = prev.map((n) =>
        n.id === localId ? { ...n, id: serverId, canvas_id: n.canvas_id || canvasIdRef.current || "" } : n
      );
      return updated;
    });
    onIdRemappedRef.current?.(localId, serverId);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const engine = new CanvasSyncEngine({
      onSyncing: markSyncing,
      onSynced: markSynced,
      onFailed: markFailed,
      onIdRemap: handleIdRemap,
    });
    syncEngineRef.current = engine;

    initStore()
      .catch(() => {})
      .finally(() => {
        if (!cancelled) {
          engine.start();
        }
      });

    return () => {
      cancelled = true;
      engine.flushSync().catch(() => {}).finally(() => {
        engine.stop();
        syncEngineRef.current = null;
      });
    };
  }, [markSyncing, markSynced, markFailed, handleIdRemap]);

  const retrySyncNow = useCallback(() => {
    syncEngineRef.current?.retryNow();
  }, []);

  const handleRemoteUpdate = useCallback(() => {
    setReloadCounter((c) => c + 1);
  }, []);

  useCanvasSSE(canvasId, getCanvasSessionId(), handleRemoteUpdate);

  const saveViewportDebounced = useMemo(() => {
    let lastEnqueuedViewport: { canvasId: string; x: number; y: number; zoom: number } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const enqueueViewport = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (!lastEnqueuedViewport) return;
      const v = lastEnqueuedViewport;
      lastEnqueuedViewport = null;
      enqueueDirty({
        type: "viewport",
        canvasId: v.canvasId,
        viewportX: v.x,
        viewportY: v.y,
        viewportZoom: v.zoom,
        committed: true,
      });
    };

    const wrapper = (...args: unknown[]) => {
      const [cId, vx, vy, vz, capturedKey] = args as [string, number, number, number, string | undefined];
      if (!cId || cId !== canvasIdRef.current) return;
      if (capturedKey) updateCanvasEntryViewport(capturedKey, vx, vy, vz);
      lastEnqueuedViewport = { canvasId: cId, x: vx, y: vy, zoom: vz };
      if (timer) clearTimeout(timer);
      timer = setTimeout(enqueueViewport, DEBOUNCE_MS);
    };
    wrapper.flush = enqueueViewport;
    return wrapper;
  }, []);

  const saveNodesBatchDebounced = useMemo(() => {
    const wrapper = (cId: string, updates: BatchUpdate[]) => {
      if (!cId || cId !== canvasIdRef.current) return;
      for (const u of updates) {
        const { id, ...fields } = u;
        enqueueDirty({
          type: "update",
          canvasId: cId,
          nodeId: id,
          fields,
          committed: true,
        });
      }
    };
    wrapper.flush = () => {};
    return wrapper;
  }, []);

  const flushBeforeSwitch = useCallback(async () => {
    saveViewportDebounced.flush();
    saveNodesBatchDebounced.flush();
    await syncEngineRef.current?.flushSyncFull();
  }, [saveViewportDebounced, saveNodesBatchDebounced]);

  useEffect(() => {
    const flushAll = () => {
      saveViewportDebounced.flush();
      saveNodesBatchDebounced.flush();
    };

    const handleVisChange = () => {
      if (document.visibilityState === "hidden") {
        flushAll();
        syncEngineRef.current?.flushSync();
      }
    };

    const handleBeforeUnload = () => {
      flushAll();
      syncEngineRef.current?.flushSync().catch(() => {});
    };

    document.addEventListener("visibilitychange", handleVisChange);
    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      document.removeEventListener("visibilitychange", handleVisChange);
      window.removeEventListener("beforeunload", handleBeforeUnload);
      flushAll();
      syncEngineRef.current?.flushSync();
    };
  }, [saveViewportDebounced, saveNodesBatchDebounced]);

  useEffect(() => {
    const thisLoadId = ++loadIdRef.current;

    setCanvasError(null);

    if (!activeWorkspaceId) {
      setNodes([]);
      canvasLoadedRef.current = true;
      setCanvasLoaded(true);
      cacheKeyRef.current = null;
      canvasIdRef.current = null;
      syncEngineRef.current?.setActiveCanvasId(null);
      setCanvasId(null);
      return;
    }

    if (!projectCanvasId) {
      canvasLoadedRef.current = false;
      setNodes([]);
      setCanvasId(null);
      canvasIdRef.current = null;
      syncEngineRef.current?.setActiveCanvasId(null);
      setPanX(0);
      setPanY(0);
      setZoom(ZOOM_BASELINE);
      setCanvasLoaded(false);
      nextZRef.current = 1;
      cacheKeyRef.current = null;
      return;
    }

    saveViewportDebounced.flush();
    saveNodesBatchDebounced.flush();

    const cacheKey = `ws:${activeWorkspaceId}:project:${projectCanvasId}`;
    // A remote update (SSE) on the canvas already on screen is a refresh:
    // keep what's mounted and merge the server's nodes in. Clearing first
    // unmounted every node (the flash) and reset the viewport from cache.
    const isRefresh = cacheKeyRef.current === cacheKey && canvasLoadedRef.current;
    cacheKeyRef.current = cacheKey;
    if (!isRefresh) {
      syncEngineRef.current?.setActiveCanvasId(null);
      setNodes([]);
      setCanvasLoaded(false);
      canvasLoadedRef.current = false;
    }

    const applyGroups = (nodesList: CanvasNode[]) => {
      const groups = nodesList.filter((n: CanvasNode) => n.node_type === "group");
      groups.forEach((g: CanvasNode) => {
        if (!Array.isArray(g.metadata?.members)) {
          const contained = getContainedNodes(g, nodesList);
          g.metadata = { ...g.metadata, members: contained.map((c) => c.id) };
        }
      });
    };

    const activateCanvas = (newCanvasId: string) => {
      syncEngineRef.current?.setActiveCanvasId(newCanvasId);
    };

    const loadFromLocal = async () => {
      const cached = await loadCanvasEntry(cacheKey);
      if (cached && loadIdRef.current === thisLoadId) {
        setCanvasId(cached.canvasId);
        canvasIdRef.current = cached.canvasId;
        activateCanvas(cached.canvasId);
        setPanX(cached.viewportX);
        setPanY(cached.viewportY);
        setZoom(cached.viewportZoom);
        const cachedNodes = cached.nodes;
        applyGroups(cachedNodes);
        setNodes(cachedNodes);
        nextZRef.current = cached.nextZ;
        onCanvasReady?.(cached.canvasId);
        canvasLoadedRef.current = true;
        setCanvasLoaded(true);
        return cached;
      }
      return null;
    };

    const cached = getCanvasEntry(cacheKey);
    const hadLocalDataRef = { current: isRefresh };
    if (isRefresh) {
      // nothing to restore — the screen already shows this canvas
    } else if (cached) {
      setCanvasId(cached.canvasId);
      canvasIdRef.current = cached.canvasId;
      activateCanvas(cached.canvasId);
      setPanX(cached.viewportX);
      setPanY(cached.viewportY);
      setZoom(cached.viewportZoom);
      const cachedNodes = cached.nodes;
      applyGroups(cachedNodes);
      setNodes(cachedNodes);
      nextZRef.current = cached.nextZ;
      onCanvasReady?.(cached.canvasId);
      canvasLoadedRef.current = true;
      setCanvasLoaded(true);
      hadLocalDataRef.current = true;
    } else {
      syncEngineRef.current?.setActiveCanvasId(null);
      loadFromLocal().then((localEntry) => {
        if (localEntry) {
          hadLocalDataRef.current = true;
        } else if (loadIdRef.current === thisLoadId) {
          canvasLoadedRef.current = false;
          setNodes([]);
          setCanvasId(null);
          canvasIdRef.current = null;
          setPanX(0);
          setPanY(0);
          setZoom(ZOOM_BASELINE);
          setCanvasLoaded(false);
          nextZRef.current = 1;
        }
      });
    }

    const url = `/api/canvas/${projectCanvasId}/load`;

    const fetchWithRetry = async () => {
      const r = await authFetch(url);
      if (r.status === 403) throw new Error("forbidden");
      if (!r.ok) throw new Error("network");
      return r.json();
    };

    fetchWithRetry()
      .then(async (data) => {
        if (loadIdRef.current !== thisLoadId) return;

        let loadedNodes: CanvasNode[] = [];
        let nextZ = 1;
        if (data.canvas) {
          if (cached && cached.canvasId !== data.canvas.id) {
            invalidateCanvasEntry(cacheKey);
          }
          setCanvasId(data.canvas.id);
          canvasIdRef.current = data.canvas.id;
          syncEngineRef.current?.setActiveCanvasId(data.canvas.id);
          if (!hadLocalDataRef.current || (cached && cached.canvasId !== data.canvas.id)) {
            setPanX(data.canvas.viewport_x || 0);
            setPanY(data.canvas.viewport_y || 0);
            setZoom(data.canvas.viewport_zoom || ZOOM_BASELINE);
          }
          onCanvasReady?.(data.canvas.id);
        }
        if (data.nodes) {
          loadedNodes = data.nodes;
          applyGroups(loadedNodes);

          await waitForStoreReady();
          const dirtyQueue = getDirtyQueue();
          const canvasIdForReconcile = data.canvas?.id || projectCanvasId;
          const pendingForCanvas = dirtyQueue.filter((m) => m.canvasId === canvasIdForReconcile);

          const tombstonedIds = new Set<string>(
            Array.isArray(data.tombstonedNodeIds) ? data.tombstonedNodeIds : []
          );

          if (pendingForCanvas.length > 0) {
            loadedNodes = reconcileWithDirty(loadedNodes, pendingForCanvas, tombstonedIds);
          }

          // Drop pending `create` mutations whose local or mapped server id
          // has been tombstoned on the server — the node was deleted, the
          // stale create would otherwise retry forever and resurrect it.
          if (tombstonedIds.size > 0) {
            const staleCreateIds = dirtyQueue
              .filter((m): m is Extract<DirtyMutation, { type: "create" }> & { id: number } => {
                if (m.type !== "create") return false;
                if (m.canvasId !== canvasIdForReconcile) return false;
                if (tombstonedIds.has(m.localId)) return true;
                const mapped = getIdMapping(m.localId);
                return !!(mapped && tombstonedIds.has(mapped));
              })
              .map((m) => m.id);
            if (staleCreateIds.length > 0) {
              console.warn(
                `[useCanvasLoader] Purging ${staleCreateIds.length} stale create mutation(s) for tombstoned node(s) on canvas ${canvasIdForReconcile}`
              );
              removeDirtyEntries(staleCreateIds);
            }
          }

          // Purge update mutations whose nodeId doesn't exist in the authoritative
          // server node set — these are stale cross-canvas orphans from project-switch
          // races that would otherwise retry forever (nodeSkipCount resets on reload).
          // Exception: if a `create` mutation for the same nodeId (local-*) exists in
          // the dirty queue, the node hasn't been synced yet — retain the update so it
          // applies after the create completes and ID remapping resolves.
          const loadedNodeIds = new Set(loadedNodes.map((n: CanvasNode) => n.id));
          const pendingCreateLocalIds = new Set(
            dirtyQueue
              .filter((m) => m.type === "create")
              .map((m) => (m as Extract<DirtyMutation, { type: "create" }> & { id: number }).localId)
          );
          const staleUpdateIds = dirtyQueue
            .filter((m): m is Extract<DirtyMutation, { type: "update" }> & { id: number } =>
              m.type === "update" &&
              m.canvasId === canvasIdForReconcile &&
              !loadedNodeIds.has(m.nodeId) &&
              !pendingCreateLocalIds.has(m.nodeId)
            )
            .map((m) => m.id);
          if (staleUpdateIds.length > 0) {
            console.warn(
              `[useCanvasLoader] Purging ${staleUpdateIds.length} stale cross-canvas update mutation(s) for canvas ${canvasIdForReconcile}`
            );
            removeDirtyEntries(staleUpdateIds);
          }

          if (Array.isArray(data.cinemaTracks) && data.cinemaTracks.length > 0) {
            // Tracks are tagged with the cinema node that owns them, so each
            // frame gets its own timeline instead of every frame showing the
            // canvas's single one.
            const tracksByNode = new Map<string, DbTrack[]>();
            for (const t of data.cinemaTracks as DbTrack[]) {
              const key = t.node_id || "";
              const list = tracksByNode.get(key) || [];
              list.push(t);
              tracksByNode.set(key, list);
            }
            const clips = data.cinemaClips || [];
            loadedNodes = loadedNodes.map((n: CanvasNode) => {
              if (n.node_type !== "cinema") return n;
              const own = tracksByNode.get(n.id);
              if (!own || own.length === 0) return n;
              const ownIds = new Set(own.map((t) => t.id));
              const dbTimeline = assembleTimelineFromDb(
                own,
                clips.filter((c: { track_id: string }) => ownIds.has(c.track_id))
              );
              const meta = (n.metadata || {}) as Record<string, unknown>;
              return { ...n, metadata: { ...meta, timelineState: dbTimeline } };
            });
          }

          // Keep object identity for unchanged nodes so memoized node
          // components (and their <video>/<iframe>) don't re-render.
          // ponytail: JSON.stringify per node per refresh; hash node.updated_at if canvases get huge.
          setNodes((prev) => {
            const byId = new Map(prev.map((n) => [n.id, n]));
            return loadedNodes.map((n: CanvasNode) => {
              const old = byId.get(n.id);
              return old && JSON.stringify(old) === JSON.stringify(n) ? old : n;
            });
          });
          if (loadedNodes.length > 0) {
            const maxZ = Math.max(...loadedNodes.map((n: CanvasNode) => n.z_index));
            nextZ = maxZ + 1;
            nextZRef.current = nextZ;
            const frameNodes = loadedNodes.filter((n: CanvasNode) => n.node_type === "frame");
            if (frameNodes.length > 0) {
              const minFrameZ = Math.min(...frameNodes.map((n: CanvasNode) => n.z_index));
              nextFrameZRef.current = minFrameZ - 1;
            }
          }
        } else {
          setNodes([]);
        }
        canvasLoadedRef.current = true;
        setCanvasLoaded(true);
        setCanvasError(null);

        if (data.canvas) {
          saveCanvasEntry({
            cacheKey,
            canvasId: data.canvas.id,
            nodes: loadedNodes,
            viewportX: data.canvas.viewport_x || 0,
            viewportY: data.canvas.viewport_y || 0,
            viewportZoom: data.canvas.viewport_zoom || ZOOM_BASELINE,
            nextZ,
            timestamp: Date.now(),
          });
        }
      })
      .catch((err) => {
        if (loadIdRef.current !== thisLoadId) return;
        const msg = err?.message || "";
        if (msg === "auth" || msg === "forbidden") {
          setNodes([]);
          setCanvasId(null);
          canvasIdRef.current = null;
          canvasLoadedRef.current = true;
          setCanvasLoaded(true);
          setCanvasError(msg === "auth" ? "Session expired. Please sign in again." : "You don't have access to this canvas.");
          return;
        }
        if (!hadLocalDataRef.current) {
          canvasLoadedRef.current = true;
          setCanvasLoaded(true);
          setCanvasError("Could not load canvas. Check your connection and try again.");
        }
      });
  }, [activeWorkspaceId, projectCanvasId, reloadCounter]);

  useEffect(() => {
    const handleCanvasNotFound = (e: Event) => {
      const detail = (e as CustomEvent<{ canvasId: string }>).detail;
      if (detail?.canvasId !== canvasIdRef.current) return;
      console.warn(`[useCanvasLoader] canvas:not-found for ${detail.canvasId} — invalidating cache and triggering reload`);
      const key = cacheKeyRef.current;
      if (key) {
        invalidateCanvasEntry(key);
      }
      canvasLoadedRef.current = false; // full reload, not a refresh: the canvas is gone
      setReloadCounter((c) => c + 1);
    };

    window.addEventListener("canvas:not-found", handleCanvasNotFound);
    return () => {
      window.removeEventListener("canvas:not-found", handleCanvasNotFound);
    };
  }, []);

  useEffect(() => {
    if (!canvasLoadedRef.current) return;
    const key = cacheKeyRef.current;
    if (key) {
      updateCanvasEntryNodes(key, nodes, nextZRef.current);
    }
  }, [nodes]);

  useEffect(() => {
    if (!canvasLoadedRef.current) return;
    const key = cacheKeyRef.current;
    if (key) updateCanvasEntryViewport(key, panX, panY, zoom);
  }, [panX, panY, zoom]);

  useEffect(() => {
    onLoadingChange?.(!canvasLoaded);
  }, [canvasLoaded, onLoadingChange]);

  useEffect(() => {
    if (canvasId) {
      saveViewportDebounced(canvasId, panX, panY, zoom, cacheKeyRef.current);
    }
  }, [panX, panY, zoom, canvasId, saveViewportDebounced]);

  return {
    nodes,
    setNodes,
    canvasId,
    setCanvasId,
    canvasLoaded,
    setCanvasLoaded,
    canvasError,
    setCanvasError,
    panX,
    setPanX,
    panY,
    setPanY,
    zoom,
    setZoom,
    cacheKeyRef,
    loadIdRef,
    canvasLoadedRef,
    saveViewportDebounced,
    saveNodesBatchDebounced,
    syncStatus,
    syncFailedSeconds,
    retrySyncNow,
    flushBeforeSwitch,
  };
}
