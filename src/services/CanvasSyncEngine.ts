import {
  getDirtyQueue,
  removeDirtyEntries,
  clearDirtyForCanvas,
  remapDirtyQueueIds,
  saveIdMapping,
  getIdMapping,
  type DirtyMutation,
} from "./CanvasStore";

export type SyncCallbacks = {
  onSyncing: () => void;
  onSynced: () => void;
  onFailed: () => void;
  onIdRemap: (localId: string, serverId: string) => void;
};

const SYNC_INTERVAL = 3000;
const BACKOFF_BASE = 2000;
const BACKOFF_MAX = 30000;
const NODE_SKIP_DROP_THRESHOLD = 10;

let _canvasSessionId: string | null = null;
export function getCanvasSessionId(): string {
  if (!_canvasSessionId) {
    _canvasSessionId = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  return _canvasSessionId;
}

function isLocalId(id: string): boolean {
  return id.startsWith("local-");
}

class BackoffError extends Error {
  constructor(status: number) {
    super(`Backoff required (${status})`);
    this.name = "BackoffError";
  }
}

class GlobalAuthError extends Error {
  constructor() {
    super("Global auth failure (401)");
    this.name = "GlobalAuthError";
  }
}

class CanvasPausedError extends Error {
  public canvasId: string;
  constructor(canvasId: string) {
    super(`Canvas ${canvasId} paused (403)`);
    this.name = "CanvasPausedError";
    this.canvasId = canvasId;
  }
}

function jitteredBackoff(failures: number): number {
  const exp = Math.min(BACKOFF_BASE * Math.pow(2, failures - 1), BACKOFF_MAX);
  const jitter = Math.random() * 0.3 * exp;
  return Math.min(exp + jitter, BACKOFF_MAX);
}

const CANVAS_404_PURGE_THRESHOLD = 3;

type CanvasBucketState = {
  paused: boolean;
  backoffMs: number;
  consecutiveFailures: number;
  lastAttempt: number;
};

export class CanvasSyncEngine {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private _globalPaused = false;
  private callbacks: SyncCallbacks;
  private isSyncing = false;
  private running = false;
  private activeCanvasId: string | null = null;
  private nodeSkipCount = new Map<string, number>();
  private canvas404Count = new Map<string, number>();
  private _canvasState = new Map<string, CanvasBucketState>();

  constructor(callbacks: SyncCallbacks) {
    this.callbacks = callbacks;
  }

  private getCanvasBucketState(canvasId: string): CanvasBucketState {
    let state = this._canvasState.get(canvasId);
    if (!state) {
      state = { paused: false, backoffMs: 0, consecutiveFailures: 0, lastAttempt: 0 };
      this._canvasState.set(canvasId, state);
    }
    return state;
  }

  private isCanvasReady(canvasId: string): boolean {
    const state = this._canvasState.get(canvasId);
    if (!state) return true;
    if (state.paused) return false;
    if (state.backoffMs > 0 && Date.now() - state.lastAttempt < state.backoffMs) return false;
    return true;
  }

  private readOnly = false;

  setActiveCanvasId(canvasId: string | null): void {
    this.activeCanvasId = canvasId;
  }

  setReadOnly(readOnly: boolean): void {
    this.readOnly = readOnly;
    if (readOnly) {
      // Drop any pending writes for the active canvas — viewers can't write.
      try {
        const queue = getDirtyQueue();
        const ids = queue.filter((m) => m.canvasId === this.activeCanvasId).map((m) => m.id);
        if (ids.length > 0) removeDirtyEntries(ids);
      } catch { /* ignore */ }
    }
  }

  isReadOnly(): boolean {
    return this.readOnly;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleTick();
    this.bindPageEvents();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.unbindPageEvents();
  }

  retryNow(): void {
    this._globalPaused = false;
    this._canvasState.clear();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.tick();
  }

  private scheduleTick(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
    }, SYNC_INTERVAL);
  }

  private handleBeforeUnload = (): void => {
    const canvasId = this.activeCanvasId;
    if (!canvasId) return;

    const queue = getDirtyQueue();
    if (queue.length === 0) return;

    const mutations = queue
      .filter((m) => m.canvasId === canvasId && m.type !== "create" && m.type !== "viewport")
      .map((m) => {
        if (m.type === "update") {
          let nodeId = m.nodeId;
          const mapped = getIdMapping(nodeId);
          if (mapped) nodeId = mapped;
          if (isLocalId(nodeId)) return null;
          return { type: "update" as const, nodeId, fields: m.fields };
        }
        if (m.type === "delete") {
          let nodeId = m.nodeId;
          const mapped = getIdMapping(nodeId);
          if (mapped) nodeId = mapped;
          if (isLocalId(nodeId)) return null;
          return { type: "delete" as const, nodeId };
        }
        return null;
      })
      .filter(Boolean);

    if (mutations.length === 0) return;

    const payload = JSON.stringify({ canvasId, mutations, sessionId: getCanvasSessionId() });
    const blob = new Blob([payload], { type: "application/json" });

    if (typeof navigator !== "undefined" && navigator.sendBeacon) {
      navigator.sendBeacon("/api/canvas/beacon-flush", blob);
    }
  };

  private handlePageHide = (): void => {
    this.flushSyncFull();
  };

  private bindPageEvents(): void {
    window.addEventListener("beforeunload", this.handleBeforeUnload);
    window.addEventListener("pagehide", this.handlePageHide);
  }

  private unbindPageEvents(): void {
    window.removeEventListener("beforeunload", this.handleBeforeUnload);
    window.removeEventListener("pagehide", this.handlePageHide);
  }

  private async tick(): Promise<void> {
    if (this.isSyncing || this._globalPaused) {
      this.scheduleTick();
      return;
    }
    const queue = getDirtyQueue();
    if (queue.length === 0) {
      this.scheduleTick();
      return;
    }
    const filtered = queue.filter((e) => this.isCanvasReady(e.canvasId));
    if (filtered.length === 0) {
      this.scheduleTick();
      return;
    }
    await this.processQueue(filtered);
    this.scheduleTick();
  }

  public async flushSync(): Promise<void> {
    if (this.isSyncing) return;
    const queue = getDirtyQueue();
    if (queue.length === 0) return;
    await this.processQueueKeepAlive(queue);
  }

  public async flushSyncFull(): Promise<void> {
    if (this.isSyncing) {
      await this.waitForSyncIdle();
    }
    const queue = getDirtyQueue();
    if (queue.length === 0) return;
    await this.processQueueKeepAlive(queue);
  }

  private waitForSyncIdle(maxWaitMs = 5000): Promise<void> {
    return new Promise<void>((resolve) => {
      const start = Date.now();
      const check = () => {
        if (!this.isSyncing || Date.now() - start >= maxWaitMs) {
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      setTimeout(check, 50);
    });
  }

  private async processQueue(queue: (DirtyMutation & { id: number })[]): Promise<void> {
    this.isSyncing = true;
    const hasContentMutations = queue.some((m) => m.type !== "viewport");
    if (hasContentMutations) {
      this.callbacks.onSyncing();
    }

    const allProcessedIds: number[] = [];
    let hadFailure = false;

    try {
      const grouped = this.groupByCanvas(queue);

      for (const [canvasId, mutations] of grouped) {
        if (this._globalPaused) break;

        try {
          const succeeded = await this.syncCanvasMutations(canvasId, mutations);
          allProcessedIds.push(...succeeded);

          const bucketState = this.getCanvasBucketState(canvasId);
          bucketState.consecutiveFailures = 0;
          bucketState.backoffMs = 0;
        } catch (err) {
          if (err instanceof GlobalAuthError) {
            break;
          }

          if (err instanceof CanvasPausedError) {
            continue;
          }

          hadFailure = true;
          const bucketState = this.getCanvasBucketState(canvasId);
          bucketState.consecutiveFailures++;
          bucketState.backoffMs = jitteredBackoff(bucketState.consecutiveFailures);
          bucketState.lastAttempt = Date.now();
          console.warn(`[SyncEngine] Canvas ${canvasId} sync failed, backoff ${bucketState.backoffMs}ms:`, err);
        }
      }

      if (allProcessedIds.length > 0) {
        removeDirtyEntries(allProcessedIds);
      }

      if (hasContentMutations) {
        if (this._globalPaused) {
          this.callbacks.onSynced();
        } else if (hadFailure) {
          this.callbacks.onFailed();
        } else {
          this.callbacks.onSynced();
        }
      }
    } catch (err) {
      if (allProcessedIds.length > 0) {
        removeDirtyEntries(allProcessedIds);
      }
      if (hasContentMutations) {
        this.callbacks.onFailed();
      }
      console.warn("[SyncEngine] Unexpected sync error:", err);
    } finally {
      this.isSyncing = false;
    }
  }

  private async processQueueKeepAlive(queue: (DirtyMutation & { id: number })[]): Promise<void> {
    const grouped = this.groupByCanvas(queue);

    for (const [canvasId, mutations] of grouped) {
      const updates = mutations.filter((m) => m.type === "update");
      if (updates.length > 0) {
        const batchUpdates: Array<Record<string, unknown>> = [];
        const dispatchedUpdateIds: number[] = [];
        for (const m of updates) {
          if (m.type !== "update") continue;
          let resolvedId = m.nodeId;
          const mapped = getIdMapping(resolvedId);
          if (mapped) resolvedId = mapped;
          if (isLocalId(resolvedId)) continue;
          batchUpdates.push({ id: resolvedId, ...m.fields });
          dispatchedUpdateIds.push(m.id);
        }

        if (batchUpdates.length > 0) {
          const keepaliveCommitted = updates.some((m) => m.type === "update" && m.committed === true);
          try {
            fetch(`/api/canvas/${canvasId}/nodes/batch`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-Canvas-Session-Id": getCanvasSessionId() },
              credentials: "include",
              body: JSON.stringify({ updates: batchUpdates, committed: keepaliveCommitted }),
              keepalive: true,
            }).then((resp) => {
              if (resp.ok && dispatchedUpdateIds.length > 0) {
                removeDirtyEntries(dispatchedUpdateIds);
              }
            }).catch(() => {});
          } catch {}
        }
      }

      const deletes = mutations.filter((m) => m.type === "delete");
      for (const mut of deletes) {
        if (mut.type !== "delete") continue;
        let nodeId = mut.nodeId;
        const mapped = getIdMapping(nodeId);
        if (mapped) nodeId = mapped;
        if (isLocalId(nodeId)) continue;
        const mutId = mut.id;
        try {
          fetch(`/api/canvas/${canvasId}/nodes/${nodeId}`, {
            method: "DELETE",
            credentials: "include",
            headers: { "X-Canvas-Session-Id": getCanvasSessionId() },
            keepalive: true,
          }).then((resp) => {
            if (resp.ok) {
              removeDirtyEntries([mutId]);
            }
          }).catch(() => {});
        } catch {}
      }

      const viewportMuts = mutations.filter((m) => m.type === "viewport");
      const lastViewport = viewportMuts.length > 0 ? viewportMuts[viewportMuts.length - 1] : null;
      if (lastViewport && lastViewport.type === "viewport") {
        const viewportIds = viewportMuts.map((vm) => vm.id);
        try {
          fetch(`/api/canvas/${canvasId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              viewport_x: lastViewport.viewportX,
              viewport_y: lastViewport.viewportY,
              viewport_zoom: lastViewport.viewportZoom,
            }),
            keepalive: true,
          }).then((resp) => {
            if (resp.ok && viewportIds.length > 0) {
              removeDirtyEntries(viewportIds);
            }
          }).catch(() => {});
        } catch {}
      }
    }
  }

  private groupByCanvas(queue: (DirtyMutation & { id: number })[]): Map<string, (DirtyMutation & { id: number })[]> {
    const grouped = new Map<string, (DirtyMutation & { id: number })[]>();
    for (const entry of queue) {
      const canvasId = entry.canvasId;
      if (!grouped.has(canvasId)) grouped.set(canvasId, []);
      grouped.get(canvasId)!.push(entry);
    }
    return grouped;
  }

  private async syncCanvasMutations(canvasId: string, mutations: (DirtyMutation & { id: number })[]): Promise<number[]> {
    const creates = mutations.filter((m) => m.type === "create");
    const updates = mutations.filter((m) => m.type === "update");
    const deletes = mutations.filter((m) => m.type === "delete");
    const viewports = mutations.filter((m) => m.type === "viewport");

    const processedIds: number[] = [];

    for (const mut of creates) {
      if (mut.type !== "create") continue;
      const existingServerId = getIdMapping(mut.localId);
      if (existingServerId) {
        processedIds.push(mut.id);
        continue;
      }

      const node = mut.node;
      const nodeSrc = (typeof node.src === 'string' && node.src.startsWith('blob:')) ? '' : node.src;
      const resp = await fetch(`/api/canvas/${canvasId}/nodes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Canvas-Session-Id": getCanvasSessionId() },
        credentials: "include",
        body: JSON.stringify({
          client_id: mut.clientId || null,
          node_type: node.node_type,
          x: node.x,
          y: node.y,
          width: node.width,
          height: node.height,
          z_index: node.z_index,
          label: node.label,
          src: nodeSrc,
          gradient: node.gradient,
          metadata: node.metadata,
          rotation: node.rotation,
          asset_id: node.asset_id,
          job_id: node.job_id,
        }),
      });

      this.checkAuth(resp, canvasId);
      // Server-side validation rejections (e.g. cinema node on a design
      // canvas, type mismatch). These are permanent — the same payload will
      // be rejected on every retry — so drop the mutation from the dirty
      // queue and dispatch an event so the UI can clean up the stranded
      // local node. Otherwise the queue retries forever and surfaces a
      // perpetual "sync failed" / "refresh required" indicator to the user.
      if (resp.status === 400 || resp.status === 422) {
        let serverMessage = "";
        try {
          const body = await resp.clone().json();
          serverMessage = (body && typeof body.error === "string") ? body.error : "";
        } catch { /* ignore parse error */ }
        console.warn(
          `[SyncEngine] Server permanently rejected create for ${node.node_type} node ${mut.localId} on canvas ${canvasId} (${resp.status}): ${serverMessage} — dropping mutation`
        );
        try {
          window.dispatchEvent(new CustomEvent("canvas:node-create-rejected", {
            detail: {
              canvasId,
              localId: mut.localId,
              status: resp.status,
              message: serverMessage,
              nodeType: node.node_type,
            },
          }));
        } catch { /* ignore */ }
        processedIds.push(mut.id);
        continue;
      }
      if (!resp.ok) throw new Error(`Create failed (${resp.status})`);

      const data = await resp.json();
      if (data.node) {
        const serverId = data.node.id;
        if (isLocalId(mut.localId)) {
          await saveIdMapping(mut.localId, serverId);
          remapDirtyQueueIds(mut.localId, serverId);
          this.callbacks.onIdRemap(mut.localId, serverId);
        }
      }
      processedIds.push(mut.id);
    }

    const mergedUpdates = new Map<string, Record<string, unknown>>();
    const nodeIdToMutIds = new Map<string, number[]>();
    const nodeIdCommitted = new Map<string, boolean>();
    for (const mut of updates) {
      if (mut.type !== "update") continue;
      let nodeId = mut.nodeId;
      const mapped = getIdMapping(nodeId);
      if (mapped) nodeId = mapped;
      if (isLocalId(nodeId)) {
        continue;
      }

      const existing = mergedUpdates.get(nodeId) || {};
      const sanitizedFields = { ...mut.fields };
      if (typeof sanitizedFields.src === 'string' && sanitizedFields.src.startsWith('blob:')) {
        delete sanitizedFields.src;
      }
      mergedUpdates.set(nodeId, { ...existing, ...sanitizedFields });
      const mutIds = nodeIdToMutIds.get(nodeId) || [];
      mutIds.push(mut.id);
      nodeIdToMutIds.set(nodeId, mutIds);
      if (mut.committed === true) {
        nodeIdCommitted.set(nodeId, true);
      } else if (!nodeIdCommitted.has(nodeId)) {
        nodeIdCommitted.set(nodeId, false);
      }
    }

    if (mergedUpdates.size > 0) {
      const textMetaKeys = ["fontFamily", "fontWeight", "fontSize", "fontColor", "textAlign", "color", "lineHeight", "letterSpacing"];

      const committedPayload: Array<Record<string, unknown>> = [];
      const ephemeralPayload: Array<Record<string, unknown>> = [];

      for (const [id, fields] of mergedUpdates.entries()) {
        const meta = fields.metadata as Record<string, unknown> | undefined;
        if (meta && typeof meta === "object") {
          const hasTextContent = "textContent" in meta;
          const looksLikeTextNode = hasTextContent || textMetaKeys.some((k) => k in meta);
          if (looksLikeTextNode && (!hasTextContent || !meta.textContent)) {
            console.warn(`[CanvasSyncEngine] Node ${id} has empty or missing textContent in metadata update`);
          }
        }
        const row = { id, ...fields };
        if (nodeIdCommitted.get(id) === true) {
          committedPayload.push(row);
        } else {
          ephemeralPayload.push(row);
        }
      }

      const fetchBatch = async (updates: Array<Record<string, unknown>>, committed: boolean) => {
        if (updates.length === 0) return { skipped: [] };
        const resp = await fetch(`/api/canvas/${canvasId}/nodes/batch`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Canvas-Session-Id": getCanvasSessionId() },
          credentials: "include",
          body: JSON.stringify({ updates, committed }),
        });
        this.checkAuth(resp, canvasId);
        if (!resp.ok) throw new Error(`Batch update failed (${resp.status})`);
        return resp.json().catch(() => ({}));
      };

      const [committedData, ephemeralData] = await Promise.all([
        fetchBatch(committedPayload, true),
        fetchBatch(ephemeralPayload, false),
      ]);

      const serverSkippedIds: string[] = [
        ...(Array.isArray(committedData.skipped) ? committedData.skipped : []),
        ...(Array.isArray(ephemeralData.skipped) ? ephemeralData.skipped : []),
      ];
      const serverSkippedSet = new Set(serverSkippedIds);

      for (const [nodeId, mutIds] of nodeIdToMutIds) {
        if (!serverSkippedSet.has(nodeId)) {
          this.nodeSkipCount.delete(nodeId);
          processedIds.push(...mutIds);
        } else {
          const allDirty = getDirtyQueue();
          const hasPendingCreate = allDirty.some((m) => {
            if (m.type !== "create") return false;
            const localId = (m as { type: "create"; localId: string }).localId;
            const mapped = getIdMapping(localId);
            return localId === nodeId || mapped === nodeId;
          });

          if (hasPendingCreate) {
            console.warn(`[SyncEngine] Node ${nodeId} skipped by server but has a pending create — retaining mutations`);
            const skipCount = (this.nodeSkipCount.get(nodeId) ?? 0) + 1;
            this.nodeSkipCount.set(nodeId, skipCount);
            continue;
          }

          const skipCount = (this.nodeSkipCount.get(nodeId) ?? 0) + 1;
          this.nodeSkipCount.set(nodeId, skipCount);

          if (skipCount >= NODE_SKIP_DROP_THRESHOLD) {
            console.warn(`[SyncEngine] Node ${nodeId} has been skipped ${skipCount} times with no pending create — dropping mutations after threshold`);
            this.nodeSkipCount.delete(nodeId);
            removeDirtyEntries(mutIds);
            continue;
          }

          try {
            const existenceResp = await fetch(`/api/canvas/${canvasId}/nodes/${nodeId}`, {
              method: "GET",
              credentials: "include",
            });
            if (existenceResp.status === 404) {
              console.warn(`[SyncEngine] Node ${nodeId} skipped by server but not found via GET (timing issue) — retaining mutations (skip ${skipCount})`);
            } else if (existenceResp.ok) {
              console.warn(`[SyncEngine] Node ${nodeId} confirmed to exist on server but rejected by batch (cross-canvas ghost) — permanently dropping mutations`);
              this.nodeSkipCount.delete(nodeId);
              removeDirtyEntries(mutIds);
            } else {
              console.warn(`[SyncEngine] Node ${nodeId} existence check returned ${existenceResp.status} — retaining mutations for retry`);
            }
          } catch (existenceErr) {
            console.warn(`[SyncEngine] Node ${nodeId} existence check failed:`, existenceErr, `— retaining mutations for retry`);
          }
        }
      }
    } else {
      for (const mutIds of nodeIdToMutIds.values()) {
        processedIds.push(...mutIds);
      }
    }

    const allDirtyForDeletes = getDirtyQueue();
    for (const mut of deletes) {
      if (mut.type !== "delete") continue;
      let nodeId = mut.nodeId;
      const mapped = getIdMapping(nodeId);
      if (mapped) nodeId = mapped;
      if (isLocalId(nodeId)) {
        const hasPendingCreate = allDirtyForDeletes.some(
          (m) => m.type === "create" && (m as Extract<DirtyMutation, { type: "create" }> & { id: number }).localId === nodeId
        );
        if (hasPendingCreate) {
          console.warn(`[SyncEngine] Delete for local ID ${nodeId} retained — matching create still pending in dirty queue`);
          continue;
        }
        const retryCount = (this.nodeSkipCount.get(nodeId) ?? 0) + 1;
        this.nodeSkipCount.set(nodeId, retryCount);
        if (retryCount < NODE_SKIP_DROP_THRESHOLD) {
          console.warn(`[SyncEngine] Delete for local ID ${nodeId} unresolvable — retrying (attempt ${retryCount}/${NODE_SKIP_DROP_THRESHOLD})`);
          continue;
        }
        console.warn(`[SyncEngine] Delete for local ID ${nodeId} permanently dropped after ${retryCount} retries — no server ID found`);
        this.nodeSkipCount.delete(nodeId);
        processedIds.push(mut.id);
        continue;
      }

      const resp = await fetch(`/api/canvas/${canvasId}/nodes/${nodeId}`, {
        method: "DELETE",
        credentials: "include",
        headers: { "X-Canvas-Session-Id": getCanvasSessionId() },
      });

      this.checkAuth(resp, canvasId);
      if (!resp.ok && resp.status !== 404) {
        throw new Error(`Delete failed (${resp.status})`);
      }
      processedIds.push(mut.id);
    }

    const lastViewport = viewports.length > 0 ? viewports[viewports.length - 1] : null;
    if (lastViewport && lastViewport.type === "viewport") {
      const resp = await fetch(`/api/canvas/${canvasId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          viewport_x: lastViewport.viewportX,
          viewport_y: lastViewport.viewportY,
          viewport_zoom: lastViewport.viewportZoom,
        }),
      });

      this.checkAuth(resp, canvasId);
      if (!resp.ok) throw new Error(`Viewport update failed (${resp.status})`);
    }
    viewports.forEach((m) => processedIds.push(m.id));

    return processedIds;
  }

  private checkAuth(resp: Response, canvasId?: string): void {
    if (resp.status === 429 || resp.status === 503) {
      throw new BackoffError(resp.status);
    }
    if (resp.status >= 500) {
      throw new Error(`Server error (${resp.status})`);
    }
    if (resp.status === 404 && canvasId) {
      const count = (this.canvas404Count.get(canvasId) ?? 0) + 1;
      this.canvas404Count.set(canvasId, count);
      if (count >= CANVAS_404_PURGE_THRESHOLD) {
        console.warn(`[CanvasSyncEngine] Canvas ${canvasId} returned 404 for ${count} consecutive request(s) — clearing dirty queue and dispatching canvas:not-found`);
        this.canvas404Count.delete(canvasId);
        clearDirtyForCanvas(canvasId);
        window.dispatchEvent(new CustomEvent("canvas:not-found", { detail: { canvasId } }));
      } else {
        console.warn(`[CanvasSyncEngine] Canvas ${canvasId} returned 404 (${count}/${CANVAS_404_PURGE_THRESHOLD}) — treating as transient, retaining dirty queue`);
      }
      throw new Error(`Canvas not found (404)`);
    }
    if (resp.status === 401) {
      this._globalPaused = true;
      this.scheduleAuthVerify();
      throw new GlobalAuthError();
    }
    if (resp.status === 403) {
      if (canvasId) {
        const bucketState = this.getCanvasBucketState(canvasId);
        bucketState.paused = true;
        console.warn(`[SyncEngine] Canvas ${canvasId} paused due to 403 — other canvases continue syncing`);
        this.scheduleCanvasAuthVerify(canvasId);
        throw new CanvasPausedError(canvasId);
      }
      this._globalPaused = true;
      this.scheduleAuthVerify();
      throw new GlobalAuthError();
    }
    if (canvasId && resp.ok) {
      this.canvas404Count.delete(canvasId);
    }
  }

  private authVerifyAttempts = 0;

  private scheduleAuthVerify(): void {
    this.authVerifyAttempts++;
    const attempt = this.authVerifyAttempts;
    const delay = attempt <= 1 ? 1500 : 3000;
    setTimeout(async () => {
      try {
        const r = await fetch("/api/auth/me", { credentials: "include" });
        if (r.status >= 500) {
          this._globalPaused = false;
          this.authVerifyAttempts = 0;
          this.scheduleTick();
          return;
        }
        if (r.ok) {
          const data = await r.json();
          if (data.sessionExpired) {
            window.dispatchEvent(new CustomEvent("auth:session-expired"));
            return;
          }
          if (data.user) {
            this._globalPaused = false;
            this.authVerifyAttempts = 0;
            this.scheduleTick();
            return;
          }
        }
        if (attempt >= 3) {
          window.dispatchEvent(new CustomEvent("auth:session-expired"));
        } else {
          this.scheduleAuthVerify();
        }
      } catch {
        if (attempt >= 3) {
          this._globalPaused = false;
          this.authVerifyAttempts = 0;
          this.scheduleTick();
        } else {
          this.scheduleAuthVerify();
        }
      }
    }, delay);
  }

  private canvasAuthVerifyAttempts = new Map<string, number>();

  private scheduleCanvasAuthVerify(canvasId: string): void {
    const attempts = (this.canvasAuthVerifyAttempts.get(canvasId) ?? 0) + 1;
    this.canvasAuthVerifyAttempts.set(canvasId, attempts);
    const delay = attempts <= 1 ? 1500 : 3000;
    setTimeout(async () => {
      try {
        const r = await fetch("/api/auth/me", { credentials: "include" });
        if (r.status >= 500) {
          if (attempts >= 3) {
            console.warn(`[SyncEngine] Canvas ${canvasId} auth check returned ${r.status} after ${attempts} attempts — resetting attempts, will re-arm`);
            this.canvasAuthVerifyAttempts.delete(canvasId);
            this.scheduleCanvasAuthVerify(canvasId);
          } else {
            this.scheduleCanvasAuthVerify(canvasId);
          }
          return;
        }
        if (r.ok) {
          const data = await r.json();
          if (data.sessionExpired) {
            this._globalPaused = true;
            window.dispatchEvent(new CustomEvent("auth:session-expired"));
            return;
          }
          if (data.user) {
            const bucketState = this.getCanvasBucketState(canvasId);
            bucketState.paused = false;
            bucketState.consecutiveFailures = 0;
            bucketState.backoffMs = 0;
            this.canvasAuthVerifyAttempts.delete(canvasId);
            console.warn(`[SyncEngine] Canvas ${canvasId} resumed after auth re-verify`);
            this.scheduleTick();
            return;
          }
        }
        if (attempts >= 3) {
          console.warn(`[SyncEngine] Canvas ${canvasId} remains paused after ${attempts} auth re-verify attempts — canvas-level permission issue, will re-arm`);
          this.canvasAuthVerifyAttempts.delete(canvasId);
          setTimeout(() => {
            const state = this._canvasState.get(canvasId);
            if (state && state.paused) {
              this.scheduleCanvasAuthVerify(canvasId);
            }
          }, BACKOFF_MAX);
        } else {
          this.scheduleCanvasAuthVerify(canvasId);
        }
      } catch {
        if (attempts >= 3) {
          console.warn(`[SyncEngine] Canvas ${canvasId} auth check network error after ${attempts} attempts — resetting attempts, will re-arm`);
          this.canvasAuthVerifyAttempts.delete(canvasId);
          this.scheduleCanvasAuthVerify(canvasId);
        } else {
          this.scheduleCanvasAuthVerify(canvasId);
        }
      }
    }, delay);
  }
}
