import type { CanvasNode } from "../types/canvas";

export type CanvasCacheEntry = {
  canvasId: string;
  nodes: CanvasNode[];
  viewportX: number;
  viewportY: number;
  viewportZoom: number;
  nextZ: number;
  timestamp: number;
};

const MAX_ENTRIES = 500;
const store = new Map<string, CanvasCacheEntry>();

function evictIfNeeded(): void {
  if (store.size <= MAX_ENTRIES) return;
  let oldestKey: string | null = null;
  let oldestTime = Infinity;
  for (const [k, v] of store) {
    if (v.timestamp < oldestTime) {
      oldestTime = v.timestamp;
      oldestKey = k;
    }
  }
  if (oldestKey) store.delete(oldestKey);
}

export function getCanvasCache(key: string): CanvasCacheEntry | null {
  return store.get(key) ?? null;
}

export function setCanvasCache(key: string, entry: CanvasCacheEntry): void {
  store.set(key, { ...entry, timestamp: Date.now() });
  evictIfNeeded();
}

export function updateCanvasCacheNodes(key: string, nodes: CanvasNode[], nextZ?: number): void {
  const entry = store.get(key);
  if (!entry) return;
  entry.nodes = nodes;
  if (nextZ !== undefined) entry.nextZ = nextZ;
  entry.timestamp = Date.now();
}

export function updateCanvasCacheViewport(key: string, x: number, y: number, zoom: number): void {
  const entry = store.get(key);
  if (!entry) return;
  entry.viewportX = x;
  entry.viewportY = y;
  entry.viewportZoom = zoom;
  entry.timestamp = Date.now();
}

export function invalidateCanvasCache(key: string): void {
  store.delete(key);
}

export function invalidateAllCanvasCache(): void {
  store.clear();
}
