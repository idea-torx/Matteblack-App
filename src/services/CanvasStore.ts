import { openDB, type IDBPDatabase } from "idb";
import type { CanvasNode } from "../types/canvas";

const DB_NAME = "canvas-store";
const DB_VERSION = 2;

const STORE_CANVAS = "canvases";
const STORE_DIRTY = "dirtyQueue";
const STORE_ID_MAP = "idMap";

export type CanvasEntry = {
  cacheKey: string;
  canvasId: string;
  nodes: CanvasNode[];
  viewportX: number;
  viewportY: number;
  viewportZoom: number;
  nextZ: number;
  timestamp: number;
};

export type DirtyMutation =
  | { type: "create"; localId: string; clientId: string; canvasId: string; node: CanvasNode; committed: boolean; timestamp: number }
  | { type: "update"; canvasId: string; nodeId: string; fields: Record<string, unknown>; committed: boolean; timestamp: number }
  | { type: "delete"; canvasId: string; nodeId: string; committed: boolean; timestamp: number }
  | { type: "viewport"; canvasId: string; viewportX: number; viewportY: number; viewportZoom: number; committed: boolean; timestamp: number };

export type DirtyMutationInput =
  | { type: "create"; localId: string; clientId: string; canvasId: string; node: CanvasNode; committed?: boolean }
  | { type: "update"; canvasId: string; nodeId: string; fields: Record<string, unknown>; committed?: boolean }
  | { type: "delete"; canvasId: string; nodeId: string; committed?: boolean }
  | { type: "viewport"; canvasId: string; viewportX: number; viewportY: number; viewportZoom: number; committed?: boolean };

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        // v1 -> v2: drop the cached canvas store so stale pre-rebaseline
        // viewport_zoom values don't shadow the server's freshly migrated
        // values on first load.
        if (oldVersion < 2 && db.objectStoreNames.contains(STORE_CANVAS)) {
          db.deleteObjectStore(STORE_CANVAS);
        }
        if (!db.objectStoreNames.contains(STORE_CANVAS)) {
          db.createObjectStore(STORE_CANVAS, { keyPath: "cacheKey" });
        }
        if (!db.objectStoreNames.contains(STORE_DIRTY)) {
          db.createObjectStore(STORE_DIRTY, { keyPath: "id", autoIncrement: true });
        }
        if (!db.objectStoreNames.contains(STORE_ID_MAP)) {
          db.createObjectStore(STORE_ID_MAP, { keyPath: "localId" });
        }
      },
    });
  }
  return dbPromise;
}

const MAX_CACHED_CANVASES = 5;
const memoryCache = new Map<string, CanvasEntry>();
const idMapCache = new Map<string, string>();

let _tempIdCounter = 0;
const _dirtyMap = new Map<number, DirtyMutation & { id: number }>();
let _storeReady: Promise<void> | null = null;

function evictOldestCanvasIfNeeded(): void {
  if (memoryCache.size > MAX_CACHED_CANVASES) {
    const oldestKey = memoryCache.keys().next().value;
    if (oldestKey !== undefined) memoryCache.delete(oldestKey);
  }
}

export function waitForStoreReady(): Promise<void> {
  return (_storeReady ?? Promise.resolve()).catch(() => {});
}

export async function initStore(): Promise<void> {
  if (_storeReady) return _storeReady.catch(() => {});

  _storeReady = (async () => {
    try {
      const db = await getDB();

      const idMapTx = db.transaction(STORE_ID_MAP, "readonly");
      const idMapStore = idMapTx.objectStore(STORE_ID_MAP);
      const allMappings = await idMapStore.getAll();
      for (const m of allMappings) {
        idMapCache.set(m.localId, m.serverId);
      }

      const dirtyTx = db.transaction(STORE_DIRTY, "readonly");
      const dirtyStore = dirtyTx.objectStore(STORE_DIRTY);
      const allDirty = await dirtyStore.getAll();
      for (const entry of allDirty) {
        const m = entry as DirtyMutation & { id: number };
        _dirtyMap.set(m.id, m);
      }
    } catch (e) {
      console.warn("[CanvasStore] IDB unavailable on init — crash recovery disabled for this session:", e);
    }
  })();

  return _storeReady;
}

export function getCanvasEntry(cacheKey: string): CanvasEntry | null {
  const entry = memoryCache.get(cacheKey);
  if (!entry) return null;
  memoryCache.delete(cacheKey);
  memoryCache.set(cacheKey, entry);
  return entry;
}

export async function loadCanvasEntry(cacheKey: string): Promise<CanvasEntry | null> {
  const mem = memoryCache.get(cacheKey);
  if (mem) {
    memoryCache.delete(cacheKey);
    memoryCache.set(cacheKey, mem);
    return mem;
  }
  try {
    const db = await getDB();
    const entry = await db.get(STORE_CANVAS, cacheKey);
    if (entry) {
      memoryCache.set(cacheKey, entry as CanvasEntry);
      evictOldestCanvasIfNeeded();
      return entry as CanvasEntry;
    }
  } catch (e) {
    console.warn("[CanvasStore] Failed to load from IndexedDB:", e);
  }
  return null;
}

export async function saveCanvasEntry(entry: CanvasEntry): Promise<void> {
  memoryCache.delete(entry.cacheKey);
  memoryCache.set(entry.cacheKey, { ...entry, timestamp: Date.now() });
  evictOldestCanvasIfNeeded();
  try {
    const db = await getDB();
    await db.put(STORE_CANVAS, { ...entry, timestamp: Date.now() });
  } catch (e) {
    console.warn("[CanvasStore] Failed to write to IndexedDB:", e);
  }
}

export function updateCanvasEntryNodes(cacheKey: string, nodes: CanvasNode[], nextZ?: number): void {
  const entry = memoryCache.get(cacheKey);
  if (!entry) return;
  entry.nodes = nodes;
  if (nextZ !== undefined) entry.nextZ = nextZ;
  entry.timestamp = Date.now();
  persistEntryAsync(cacheKey);
}

export function updateCanvasEntryViewport(cacheKey: string, x: number, y: number, zoom: number): void {
  const entry = memoryCache.get(cacheKey);
  if (!entry) return;
  entry.viewportX = x;
  entry.viewportY = y;
  entry.viewportZoom = zoom;
  entry.timestamp = Date.now();
  persistEntryAsync(cacheKey);
}

export function invalidateCanvasEntry(cacheKey: string): void {
  memoryCache.delete(cacheKey);
  getDB().then((db) => db.delete(STORE_CANVAS, cacheKey)).catch(() => {});
}

function persistEntryAsync(cacheKey: string): void {
  const entry = memoryCache.get(cacheKey);
  if (!entry) return;
  getDB().then((db) => db.put(STORE_CANVAS, { ...entry })).catch((e) => {
    console.warn("[CanvasStore] Persist failed:", e);
  });
}

const _readOnlyCanvases = new Set<string>();

export function setCanvasReadOnly(canvasId: string, readOnly: boolean): void {
  if (readOnly) _readOnlyCanvases.add(canvasId);
  else _readOnlyCanvases.delete(canvasId);
}

export function isCanvasReadOnly(canvasId: string): boolean {
  return _readOnlyCanvases.has(canvasId);
}

export function enqueueDirty(mutation: DirtyMutationInput): void {
  if (_readOnlyCanvases.has(mutation.canvasId)) return;
  const committed = mutation.committed === true;
  let resolved = mutation;
  if (mutation.type === "delete") {
    const mappedId = getIdMapping(mutation.nodeId);
    if (mappedId) {
      resolved = { ...mutation, nodeId: mappedId };
    }
  }
  const entry = { ...resolved, committed, timestamp: Date.now() } as DirtyMutation;

  if (resolved.type === "delete") {
    const targetId = resolved.nodeId;
    const targetCanvas = resolved.canvasId;
    const staleIds: number[] = [];
    for (const [id, existing] of _dirtyMap) {
      if (
        existing.canvasId === targetCanvas &&
        existing.type === "update" &&
        existing.nodeId === targetId
      ) {
        staleIds.push(id);
      }
    }
    if (staleIds.length > 0) {
      for (const id of staleIds) _dirtyMap.delete(id);
      (async () => {
        try {
          const db = await getDB();
          const tx = db.transaction(STORE_DIRTY, "readwrite");
          for (const id of staleIds) {
            if (id > 0) await tx.store.delete(id);
          }
          await tx.done;
        } catch (e) {
          console.warn("[CanvasStore] Failed to prune stale updates on delete:", e);
        }
      })();
    }
  }

  const tempId = --_tempIdCounter;
  const mapEntry = { ...entry, id: tempId } as DirtyMutation & { id: number };
  _dirtyMap.set(tempId, mapEntry);

  (async () => {
    try {
      const db = await getDB();
      const realId = await db.add(STORE_DIRTY, entry) as number;
      const currentEntry = _dirtyMap.get(tempId);
      if (currentEntry !== undefined) {
        _dirtyMap.delete(tempId);
        _dirtyMap.set(realId, { ...currentEntry, id: realId });
      } else {
        db.delete(STORE_DIRTY, realId).catch(() => {});
      }
    } catch (e) {
      console.warn("[CanvasStore] Failed to enqueue dirty mutation to IDB (kept in memory):", e);
    }
  })();
}

export function getDirtyQueue(): (DirtyMutation & { id: number })[] {
  return Array.from(_dirtyMap.values()).sort((a, b) => a.timestamp - b.timestamp);
}

export function removeDirtyEntries(ids: number[]): void {
  if (ids.length === 0) return;
  for (const id of ids) {
    _dirtyMap.delete(id);
  }
  (async () => {
    try {
      const db = await getDB();
      const tx = db.transaction(STORE_DIRTY, "readwrite");
      for (const id of ids) {
        await tx.store.delete(id);
      }
      await tx.done;
    } catch (e) {
      console.warn("[CanvasStore] Failed to remove dirty entries from IDB:", e);
    }
  })();
}

export function clearDirtyForCanvas(canvasId: string): void {
  const toRemove: number[] = [];
  for (const [id, entry] of _dirtyMap) {
    if (entry.canvasId === canvasId) {
      toRemove.push(id);
    }
  }
  if (toRemove.length === 0) return;
  for (const id of toRemove) {
    _dirtyMap.delete(id);
  }
  (async () => {
    try {
      const db = await getDB();
      const tx = db.transaction(STORE_DIRTY, "readwrite");
      const all = await tx.store.getAll() as (DirtyMutation & { id: number })[];
      for (const entry of all) {
        if (entry.canvasId === canvasId) {
          await tx.store.delete(entry.id);
        }
      }
      await tx.done;
    } catch (e) {
      console.warn("[CanvasStore] Failed to clear dirty entries for canvas from IDB:", e);
    }
  })();
}

export function remapDirtyQueueIds(oldId: string, newId: string): void {
  for (const [key, entry] of _dirtyMap) {
    let changed = false;
    let updated = entry;
    if (entry.type === "update" && entry.nodeId === oldId) {
      updated = { ...entry, nodeId: newId };
      changed = true;
    } else if (entry.type === "delete" && entry.nodeId === oldId) {
      updated = { ...entry, nodeId: newId };
      changed = true;
    }
    if (changed) {
      _dirtyMap.set(key, updated);
    }
  }

  (async () => {
    try {
      const db = await getDB();
      const tx = db.transaction(STORE_DIRTY, "readwrite");
      const store = tx.objectStore(STORE_DIRTY);
      const allEntries = await store.getAll();
      for (const entry of allEntries) {
        const m = entry as DirtyMutation & { id: number };
        let changed = false;
        if (m.type === "update" && m.nodeId === oldId) {
          (m as DirtyMutation & { nodeId: string }).nodeId = newId;
          changed = true;
        } else if (m.type === "delete" && m.nodeId === oldId) {
          (m as DirtyMutation & { nodeId: string }).nodeId = newId;
          changed = true;
        }
        if (changed) {
          await store.put(m);
        }
      }
      await tx.done;
    } catch (e) {
      console.warn("[CanvasStore] Failed to remap dirty queue IDs in IDB:", e);
    }
  })();
}

export async function saveIdMapping(localId: string, serverId: string): Promise<void> {
  idMapCache.set(localId, serverId);
  try {
    const db = await getDB();
    await db.put(STORE_ID_MAP, { localId, serverId });
  } catch (e) {
    console.warn("[CanvasStore] Failed to save ID mapping:", e);
  }
}

export function getIdMapping(localId: string): string | undefined {
  return idMapCache.get(localId);
}

export function getAllIdMappings(): Map<string, string> {
  return new Map(idMapCache);
}

export async function pruneStaleEntries(activeCanvasId: string): Promise<void> {
  for (const [key, entry] of _dirtyMap) {
    if (entry.canvasId !== activeCanvasId) {
      _dirtyMap.delete(key);
    }
  }
  try {
    const db = await getDB();
    const tx = db.transaction(STORE_DIRTY, "readwrite");
    const store = tx.objectStore(STORE_DIRTY);
    const allEntries = await store.getAll();
    for (const entry of allEntries) {
      const m = entry as DirtyMutation & { id: number };
      if (m.canvasId !== activeCanvasId) {
        await store.delete(m.id);
      }
    }
    await tx.done;
  } catch (e) {
    console.warn("[CanvasStore] Failed to prune stale dirty entries:", e);
  }
}

export async function clearIdMappingsForCanvas(_canvasId: string): Promise<void> {
  const toRemove: string[] = [];
  for (const [localId] of idMapCache) {
    if (localId.startsWith("local-")) {
      toRemove.push(localId);
    }
  }
  for (const id of toRemove) {
    idMapCache.delete(id);
  }
  try {
    const db = await getDB();
    const tx = db.transaction(STORE_ID_MAP, "readwrite");
    for (const id of toRemove) {
      await tx.store.delete(id);
    }
    await tx.done;
  } catch (e) {
    console.warn("[CanvasStore] Failed to clear ID mappings:", e);
  }
}
