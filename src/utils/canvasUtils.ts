import type { CanvasNode } from "../types/canvas";
import { VIEWPORT_BUFFER } from "../types/canvas";
import { getCached, setCached } from "../services/AssetCache";

export function getContainedNodes(groupNode: CanvasNode, allNodes: CanvasNode[]): CanvasNode[] {
  return allNodes.filter((n) => {
    if (n.id === groupNode.id) return false;
    if (n.node_type === "group") return false;
    return (
      n.x >= groupNode.x &&
      n.y >= groupNode.y &&
      n.x + n.width <= groupNode.x + groupNode.width &&
      n.y + n.height <= groupNode.y + groupNode.height
    );
  });
}

export function getGroupMembers(groupNode: CanvasNode, allNodes: CanvasNode[]): CanvasNode[] {
  const memberIds = Array.isArray(groupNode.metadata?.members) ? groupNode.metadata.members as string[] : [];
  return allNodes.filter((n) => memberIds.includes(n.id));
}

export function sortNodesReadingOrder(nodeList: CanvasNode[]): CanvasNode[] {
  if (nodeList.length <= 1) return nodeList;
  const avgHeight = nodeList.reduce((s, n) => s + n.height, 0) / nodeList.length;
  const rowThreshold = Math.max(avgHeight * 0.5, 30);
  return [...nodeList].sort((a, b) => {
    const rowA = Math.floor(a.y / rowThreshold);
    const rowB = Math.floor(b.y / rowThreshold);
    if (rowA !== rowB) return rowA - rowB;
    return a.x - b.x;
  });
}

export function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T & { cancel: () => void; flush: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingArgs: unknown[] | null = null;
  const debounced = (...args: unknown[]) => {
    pendingArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const a = pendingArgs;
      pendingArgs = null;
      if (a) fn(...a);
    }, ms);
  };
  debounced.cancel = () => { if (timer) { clearTimeout(timer); timer = null; } pendingArgs = null; };
  debounced.flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    const a = pendingArgs;
    pendingArgs = null;
    if (a) fn(...a);
  };
  return debounced as T & { cancel: () => void; flush: () => void };
}

export type BatchUpdate = { id: string; [key: string]: unknown };

export function debounceMergeBatch(
  fn: (canvasId: string, updates: BatchUpdate[]) => void,
  ms: number,
): {
  (canvasId: string, updates: BatchUpdate[]): void;
  cancel: () => void;
  flush: () => void;
  flushBeacon: (baseUrl: string) => void;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const pendingByCanvas = new Map<string, Map<string, BatchUpdate>>();

  function mergeIn(canvasId: string, updates: BatchUpdate[]) {
    let canvasMap = pendingByCanvas.get(canvasId);
    if (!canvasMap) {
      canvasMap = new Map();
      pendingByCanvas.set(canvasId, canvasMap);
    }
    for (const u of updates) {
      const existing = canvasMap.get(u.id);
      if (existing) {
        canvasMap.set(u.id, { ...existing, ...u });
      } else {
        canvasMap.set(u.id, { ...u });
      }
    }
  }

  function consumeAll(): Array<{ canvasId: string; updates: BatchUpdate[] }> {
    const result: Array<{ canvasId: string; updates: BatchUpdate[] }> = [];
    for (const [canvasId, updatesMap] of pendingByCanvas) {
      if (updatesMap.size > 0) {
        result.push({ canvasId, updates: Array.from(updatesMap.values()) });
      }
    }
    pendingByCanvas.clear();
    return result;
  }

  function filterLocalIds(updates: BatchUpdate[]): BatchUpdate[] {
    return updates.filter((u) => !u.id.startsWith("local-"));
  }

  const debounced = (canvasId: string, updates: BatchUpdate[]) => {
    mergeIn(canvasId, updates);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const batches = consumeAll();
      for (const b of batches) fn(b.canvasId, b.updates);
    }, ms);
  };

  debounced.cancel = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    pendingByCanvas.clear();
  };

  debounced.flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    const batches = consumeAll();
    for (const b of batches) fn(b.canvasId, b.updates);
  };

  debounced.flushBeacon = (baseUrl: string) => {
    if (timer) { clearTimeout(timer); timer = null; }
    const batches = consumeAll();
    for (const b of batches) {
      const validUpdates = filterLocalIds(b.updates);
      if (validUpdates.length === 0) continue;
      const url = `${baseUrl}/api/canvas/${b.canvasId}/nodes/batch`;
      const blob = new Blob([JSON.stringify({ updates: validUpdates })], { type: "application/json" });
      if (typeof navigator !== "undefined" && navigator.sendBeacon) {
        navigator.sendBeacon(url, blob);
      } else {
        fn(b.canvasId, validUpdates);
      }
    }
  };

  return debounced;
}

export function snapToGrid(value: number, gridSize: number): number {
  return Math.round(value / gridSize) * gridSize;
}

export function clampDimensions(w: number, h: number, max = 1920): { w: number; h: number } {
  if (w > max || h > max) {
    const s = max / Math.max(w, h);
    return { w: Math.round(w * s), h: Math.round(h * s) };
  }
  return { w, h };
}

export async function downloadAsset(url: string, filename: string): Promise<void> {
  const fetchUrl =
    url.startsWith("http://") || url.startsWith("https://")
      ? `/api/media-proxy?url=${encodeURIComponent(url)}`
      : url;
  try {
    const resp = await fetch(fetchUrl);
    const blob = await resp.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);
  } catch {
    window.open(url, "_blank");
  }
}

export function saveNodeToLibrary(node: CanvasNode): Promise<Response> {
  return fetch("/api/assets/save-from-canvas", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      name: node.label || "Canvas Node",
      file_url: node.src || "",
      type: node.node_type === "video" ? "video" : node.node_type === "svg" ? "vector" : "image",
      metadata: { gradient: node.gradient, source_id: node.id },
    }),
  });
}

export type LibraryCacheItem = {
  id: string;
  name: string;
  file_url: string;
  type: string;
  file_type: string | null;
  folder_id: string | null;
  folder_name?: string;
  source?: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type LibraryMatch = {
  assetId: string;
  folderId: string | null;
  folderName: string;
};

export function findNodeInLibraryCache(nodeId: string): LibraryMatch | null {
  const cacheKeys = ["assets:image", "assets:video", "assets:vector"] as const;
  for (const key of cacheKeys) {
    const entry = getCached<LibraryCacheItem[]>(key);
    if (!entry) continue;
    const match = entry.data.find(
      (item) => (item.metadata as Record<string, unknown>)?.source_id === nodeId,
    );
    if (match) {
      return {
        assetId: match.id,
        folderId: match.folder_id,
        folderName: match.folder_name || "Generations",
      };
    }
  }
  return null;
}

export function saveNodeToLibraryOptimistic(
  node: CanvasNode,
  onRefresh: () => void,
  folderId?: string,
  folderName?: string,
): Promise<{ ok: true } | { ok: false }> {
  const assetType = node.node_type === "video" ? "video" : node.node_type === "svg" ? "vector" : "image";
  const tempId = `temp-${crypto.randomUUID()}`;
  const tempAsset: LibraryCacheItem = {
    id: tempId,
    name: node.label || "Canvas Node",
    file_url: node.src || "",
    type: assetType,
    file_type: null,
    folder_id: folderId ?? null,
    folder_name: folderName ?? "Generations",
    created_at: new Date().toISOString(),
    metadata: { gradient: node.gradient, source_id: node.id },
  };

  const cacheKey = `assets:${assetType}`;
  const existing = getCached<LibraryCacheItem[]>(cacheKey);
  const currentItems = existing?.data ?? [];
  setCached(cacheKey, [tempAsset, ...currentItems]);
  onRefresh();

  return fetch("/api/assets/save-from-canvas", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      name: node.label || "Canvas Node",
      file_url: node.src || "",
      type: assetType,
      metadata: { gradient: node.gradient, source_id: node.id },
      ...(folderId ? { folder_id: folderId } : folderName ? { default_folder: folderName } : {}),
    }),
  })
    .then(async (res) => {
      if (res.ok) {
        const data = await res.json().catch(() => null);
        const entry = getCached<LibraryCacheItem[]>(cacheKey);
        if (entry) {
          const serverAsset = data?.asset as LibraryCacheItem | undefined;
          setCached(
            cacheKey,
            entry.data.map((item) =>
              item.id === tempId
                ? serverAsset ? { ...item, ...serverAsset } : item
                : item,
            ),
          );
        }
        onRefresh();
        return { ok: true as const };
      }
      const entry = getCached<LibraryCacheItem[]>(cacheKey);
      if (entry) {
        setCached(cacheKey, entry.data.filter((item) => item.id !== tempId));
      }
      onRefresh();
      return { ok: false as const };
    })
    .catch(() => {
      const entry = getCached<LibraryCacheItem[]>(cacheKey);
      if (entry) {
        setCached(cacheKey, entry.data.filter((item) => item.id !== tempId));
      }
      onRefresh();
      return { ok: false as const };
    });
}

export function isNodeInViewport(
  node: CanvasNode,
  panX: number,
  panY: number,
  zoom: number,
  viewportW: number,
  viewportH: number,
): boolean {
  const screenX = node.x * zoom + panX;
  const screenY = node.y * zoom + panY;
  const screenW = node.width * zoom;
  const screenH = node.height * zoom;
  return (
    screenX + screenW > -VIEWPORT_BUFFER &&
    screenX < viewportW + VIEWPORT_BUFFER &&
    screenY + screenH > -VIEWPORT_BUFFER &&
    screenY < viewportH + VIEWPORT_BUFFER
  );
}
