import { Router, Request, Response, NextFunction } from "express";
import { pool } from "../db.js";
import { deriveEdges, type ProvenanceEdge } from "../canvas/edges.js";
import { saveFile, copyFile, parseFileUrl } from "../storage.js";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import redisClient from "../services/redisClient.js";
import { setNodes, evictNode, evictCanvas, warmCanvas, isCanvasWarm, getCanvas, upsertNodesPostgres, type RedisNodeUpdate } from "../services/canvasRedisCache.js";
import { scheduleCanvasFlush } from "../services/canvasCheckpointScheduler.js";
import { getProjectAccess, logShareEvent, isSharingV1EnabledForUser } from "../services/projectAccess.js";
import {
  addSession as presenceAddSession,
  removeSession as presenceRemoveSession,
  sweepIdle as presenceSweepIdle,
  type PresenceSessionInput,
} from "../services/presence/PresenceRegistry.js";
import {
  broadcastPresenceIdle,
  broadcastPresenceJoin,
  broadcastPresenceLeave,
  sendPresenceSnapshot,
  type PresenceSseTransport,
} from "../services/presence/presenceBroadcast.js";
import { release as releaseCursorBucket, sweepIdleBuckets as sweepCursorBuckets } from "../services/presence/cursorRateLimiter.js";

const BATCH_CONCURRENCY_LIMIT = 10;
const BATCH_QUEUE_TIMEOUT_MS = 8000;
let batchConcurrent = 0;
const batchWaiters: Array<() => void> = [];

function acquireBatchSlot(): Promise<void> {
  if (batchConcurrent < BATCH_CONCURRENCY_LIMIT) {
    batchConcurrent++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = batchWaiters.indexOf(waiter);
      if (idx !== -1) batchWaiters.splice(idx, 1);
      reject(new Error("batch_queue_timeout"));
    }, BATCH_QUEUE_TIMEOUT_MS);
    const waiter = () => {
      clearTimeout(timer);
      resolve();
    };
    batchWaiters.push(waiter);
  });
}

function releaseBatchSlot(): void {
  const next = batchWaiters.shift();
  if (next) {
    next();
  } else {
    batchConcurrent--;
  }
}

interface AuthRequest extends Request {
  userId?: string;
}

const MAX_CONCURRENT_VIEWERS_PER_CANVAS = 25;

function countCanvasViewers(canvasId: string): number {
  const set = sseClients.get(canvasId);
  if (!set) return 0;
  let n = 0;
  for (const c of set) if (c.role === "viewer") n++;
  return n;
}

async function ensureCanvasAccess(
  req: AuthRequest,
  res: Response,
  canvasId: string,
  mode: "read" | "write"
): Promise<{ ok: true; role: "owner" | "viewer"; ownerId: string | null; workspaceId: string | null; projectType: string | null } | { ok: false }> {
  const access = await getProjectAccess(req.userId, canvasId);
  if (!access.exists) {
    res.status(404).json({ error: "Canvas not found" });
    return { ok: false };
  }
  if (access.role === "none") {
    res.status(403).json({ error: "Not authorized" });
    return { ok: false };
  }
  // Sharing-v1 rollout flag: if access was granted as a viewer (i.e. via
  // project_participants, not workspace ownership), the user must have the
  // sharing feature enabled. This keeps the entire viewer surface behind the
  // feature flag end-to-end.
  if (access.role === "viewer" && !(await isSharingV1EnabledForUser(req.userId))) {
    res.status(403).json({ error: "Not authorized" });
    return { ok: false };
  }
  if (mode === "write" && access.role !== "owner") {
    logShareEvent("mutation_blocked", {
      userId: req.userId,
      projectId: canvasId,
      method: req.method,
      path: req.path,
    });
    res.status(403).json({ error: "Read-only access" });
    return { ok: false };
  }
  return { ok: true, role: access.role as "owner" | "viewer", ownerId: access.ownerId, workspaceId: access.workspaceId, projectType: access.projectType };
}

interface BatchNodeUpdate {
  id?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
  z_index?: number;
  locked?: boolean;
  metadata?: Record<string, unknown>;
  node_type?: string;
  src?: string;
  label?: string;
  gradient?: string;
  asset_id?: string | null;
  visible?: boolean;
}

const router = Router();

interface SseClient {
  res: Response;
  sessionId: string;
  lastActivityMs: number;
  role: "owner" | "viewer";
  userId: string | null;
}

const sseClients = new Map<string, Set<SseClient>>();
const SSE_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

type SseConnectListener = () => void;
const sseConnectListeners = new Set<SseConnectListener>();

export function onSseClientConnected(listener: SseConnectListener): () => void {
  sseConnectListeners.add(listener);
  return () => sseConnectListeners.delete(listener);
}

export function hasAnySseClients(): boolean {
  for (const clients of sseClients.values()) {
    if (clients.size > 0) return true;
  }
  return false;
}

export function touchSseSession(sessionId: string): void {
  if (!sessionId) return;
  const now = Date.now();
  for (const clients of sseClients.values()) {
    for (const client of clients) {
      if (client.sessionId === sessionId) client.lastActivityMs = now;
    }
  }
}

export function sseSessionActivityMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const sessionId = (req.headers["x-canvas-session-id"] as string) || "";
  if (sessionId) touchSseSession(sessionId);
  next();
}

/**
 * Single drain path for evicting a dead/disconnected SSE client. Any code
 * path that detects the connection is gone (TCP close, write failure, idle
 * eviction, manual end) MUST funnel through here so PresenceRegistry stays
 * in sync with sseClients and `presence:leave` is broadcast exactly once.
 *
 * Returns true if the client was actually removed (vs. a no-op because it
 * had already been replaced/cleaned up).
 */
function dropDeadSseClient(canvasId: string, client: SseClient): boolean {
  const clients = sseClients.get(canvasId);
  if (!clients) return false;
  const wasRegistered = clients.delete(client);
  if (clients.size === 0) {
    sseClients.delete(canvasId);
    stopHeartbeatIfEmpty();
  }
  if (!wasRegistered) return false;
  handleSessionDisconnected(canvasId, client);
  return true;
}

function broadcastCanvasUpdate(canvasId: string, excludeSessionId: string): void {
  const clients = sseClients.get(canvasId);
  if (!clients || clients.size === 0) return;
  const payload = JSON.stringify({ type: "canvas:updated", canvasId, timestamp: Date.now() });
  const message = `data: ${payload}\n\n`;
  const now = Date.now();
  const dead: SseClient[] = [];
  for (const client of clients) {
    if (excludeSessionId && client.sessionId === excludeSessionId) continue;
    try {
      client.res.write(message);
      client.lastActivityMs = now;
    } catch {
      dead.push(client);
    }
  }
  for (const c of dead) dropDeadSseClient(canvasId, c);
}

// Heartbeat interval is intentionally short so a lost connection is detected
// (write failure → presence:leave) within ~5s, satisfying the presence
// "leave within ~5s" SLA. The traffic cost is one tiny `: heartbeat\n\n`
// comment per active SSE client per tick.
const SSE_HEARTBEAT_INTERVAL = 5_000;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function stopHeartbeatIfEmpty(): void {
  if (heartbeatTimer && sseClients.size === 0) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function ensureHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const [canvasId, clients] of sseClients) {
      const dead: SseClient[] = [];
      for (const client of clients) {
        if (now - client.lastActivityMs > SSE_IDLE_TIMEOUT_MS) {
          try { client.res.end(); } catch { /* response already torn down */ }
          dead.push(client);
          continue;
        }
        try {
          client.res.write(": heartbeat\n\n");
        } catch {
          dead.push(client);
        }
      }
      for (const c of dead) dropDeadSseClient(canvasId, c);
    }
    // Idle-cursor sweep: anyone whose last cursor update is older than the
    // idle threshold transitions to idle and we broadcast presence:idle.
    const idleTransitions = presenceSweepIdle(now);
    for (const t of idleTransitions) {
      broadcastPresenceIdle(presenceTransport, t.canvasId, t.sessionId);
    }
    sweepCursorBuckets(now);
    stopHeartbeatIfEmpty();
  }, SSE_HEARTBEAT_INTERVAL);
  if (heartbeatTimer && typeof heartbeatTimer.unref === "function") {
    heartbeatTimer.unref();
  }
}

const presenceTransport: PresenceSseTransport = {
  writeToCanvas(canvasId, message, excludeSessionId) {
    const clients = sseClients.get(canvasId);
    if (!clients || clients.size === 0) return;
    const now = Date.now();
    const dead: SseClient[] = [];
    for (const client of clients) {
      if (excludeSessionId && client.sessionId === excludeSessionId) continue;
      try {
        client.res.write(message);
        client.lastActivityMs = now;
      } catch {
        dead.push(client);
      }
    }
    // Funnel write-failure cleanup through the central drain so we always
    // emit presence:leave and release the rate-limit bucket. Without this,
    // a write failure here would silently leave a ghost in PresenceRegistry.
    for (const c of dead) dropDeadSseClient(canvasId, c);
  },
  writeToSession(canvasId, sessionId, message) {
    const clients = sseClients.get(canvasId);
    if (!clients) return false;
    for (const client of clients) {
      if (client.sessionId !== sessionId) continue;
      try {
        client.res.write(message);
        client.lastActivityMs = Date.now();
        return true;
      } catch {
        dropDeadSseClient(canvasId, client);
        return false;
      }
    }
    return false;
  },
};

export function getPresenceTransport(): PresenceSseTransport {
  return presenceTransport;
}

function handleSessionDisconnected(canvasId: string, client: SseClient): void {
  const removed = presenceRemoveSession(canvasId, client.sessionId);
  if (removed) {
    broadcastPresenceLeave(presenceTransport, canvasId, client.sessionId, client.userId);
  }
  releaseCursorBucket(client.sessionId);
}

async function fetchPresenceUserInfo(
  userId: string | null | undefined
): Promise<{ displayName: string; avatarUrl: string | null }> {
  if (!userId) return { displayName: "Guest", avatarUrl: null };
  try {
    const r = await pool.query(
      `SELECT display_name, avatar_url FROM users WHERE id = $1`,
      [userId]
    );
    if (r.rows.length === 0) return { displayName: "Member", avatarUrl: null };
    const row = r.rows[0];
    const displayName = (row.display_name && String(row.display_name).trim()) || "Member";
    const avatarUrl = row.avatar_url ? String(row.avatar_url) : null;
    return { displayName, avatarUrl };
  } catch (err) {
    console.warn("[presence] fetchPresenceUserInfo failed:", err);
    return { displayName: "Member", avatarUrl: null };
  }
}

/**
 * SSE connection handler. Exported so it can be mounted with `injectUserId`
 * (rather than `requireAuth`) at the app level — that allows guest/share-v1
 * viewers to subscribe to presence where the canvas-access layer permits.
 * Authenticated mutation routes still mount via the requireAuth chain.
 */
export const sseEventsHandler = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { canvasId } = req.params;
    const sessionId = (req.query.sessionId as string) || "";

    // Presence dedupe + rate-limiting are keyed by sessionId; an empty value
    // would collapse multiple clients onto the same registry entry and break
    // both the per-session token bucket and the reconnect-dedupe path.
    if (!sessionId) {
      res.status(400).json({ error: "sessionId is required" });
      return;
    }

    const access = await ensureCanvasAccess(req, res, canvasId, "read");
    if (!access.ok) return;

    // Reconnect dedupe must run BEFORE the viewer cap check so a self-reconnect
    // at the cap doesn't get rejected. We tear down any prior SSE connection
    // sharing this sessionId — its later cleanup is no-op-protected because
    // it'll find itself no longer registered in the bucket.
    const existingBucket = sseClients.get(canvasId);
    if (existingBucket) {
      for (const existing of Array.from(existingBucket)) {
        if (existing.sessionId === sessionId) {
          try { existing.res.end(); } catch { /* response already torn down */ }
          existingBucket.delete(existing);
        }
      }
      if (existingBucket.size === 0) {
        sseClients.delete(canvasId);
        stopHeartbeatIfEmpty();
      }
    }

    if (access.role === "viewer" && countCanvasViewers(canvasId) >= MAX_CONCURRENT_VIEWERS_PER_CANVAS) {
      logShareEvent("viewer_cap_reached", { userId: req.userId, projectId: canvasId, cap: MAX_CONCURRENT_VIEWERS_PER_CANVAS });
      res.status(429).json({ error: "Viewer limit reached for this project" });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    res.write(": connected\n\n");

    const userId = req.userId ?? null;
    const client: SseClient = { res, sessionId, lastActivityMs: Date.now(), role: access.role, userId };
    if (!sseClients.has(canvasId)) {
      sseClients.set(canvasId, new Set());
    }
    const bucket = sseClients.get(canvasId)!;
    bucket.add(client);
    ensureHeartbeat();

    // Wire cleanup BEFORE awaiting any I/O so that a TCP close arriving
    // mid-await still triggers presence:leave. The cleanup is guarded by
    // bucket membership: if a newer reconnect has already replaced this
    // client (and removed it from the bucket), the registry/leave path is
    // skipped so we don't tear down the new session.
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      // dropDeadSseClient is a no-op if a fresh reconnect with the same
      // sessionId has already replaced this client in the bucket — that
      // protects the new presence entry from being torn down by the old
      // connection's late close event.
      dropDeadSseClient(canvasId, client);
    };

    req.on("close", cleanup);
    req.on("error", cleanup);

    // Per-session secret used by the cursor POST endpoint to verify that the
    // caller actually owns this SSE connection. Guards against another
    // participant spoofing this session's cursor by guessing/reusing the
    // publicly-broadcast sessionId — important for guest sessions where there
    // is no userId to bind authorship to.
    const bindingToken = uuidv4();

    // Register presence and broadcast join. Snapshot is sent to this client
    // first so it sees the existing roster before its own join is fanned out.
    const userInfo = await fetchPresenceUserInfo(userId);

    // Bail out early if the connection was torn down during the user lookup.
    if (cleanedUp) return;

    const presenceInput: PresenceSessionInput = {
      sessionId,
      userId,
      displayName: userInfo.displayName,
      avatarUrl: userInfo.avatarUrl,
      role: access.role,
      bindingToken,
    };
    const addResult = presenceAddSession(canvasId, presenceInput);

    // If addSession evicted a stale entry with the same sessionId, broadcast
    // a leave for it so other clients drop the ghost before the join arrives.
    for (const evicted of addResult.evicted) {
      broadcastPresenceLeave(presenceTransport, canvasId, evicted.sessionId, evicted.userId, sessionId);
    }

    const snapshotDelivered = sendPresenceSnapshot(
      presenceTransport,
      canvasId,
      {
        sessionId,
        userId,
        displayName: addResult.user.displayName,
        avatarUrl: addResult.user.avatarUrl,
        role: addResult.user.role,
        color: addResult.user.color,
        bindingToken,
      },
      addResult.snapshot
    );
    // If the snapshot write failed, the new client was already torn down by
    // dropDeadSseClient (which also broadcast presence:leave for it). Emitting
    // presence:join now would leave a ghost in every other client's roster
    // with no matching leave to come, so abort the rest of the connect flow.
    if (!snapshotDelivered) return;

    broadcastPresenceJoin(presenceTransport, canvasId, addResult.user, sessionId);

    for (const listener of sseConnectListeners) {
      try { listener(); } catch (err) { console.error("[sse] connect listener error:", err); }
    }
  } catch (err) {
    console.error("SSE connection error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to establish SSE connection" });
    }
  }
};

router.get("/api/projects/:workspaceId", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { workspaceId } = req.params;
    const scope = (req.query.scope as string) === "shared" ? "shared" : "owned";

    const memberCheck = await pool.query(
      `SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId]
    );
    if (memberCheck.rows.length === 0) {
      res.status(403).json({ error: "Not a member of this workspace" });
      return;
    }

    const wsTypeRes = await pool.query(
      `SELECT type FROM workspaces WHERE id = $1`,
      [workspaceId]
    );
    const isTeamWorkspace = wsTypeRes.rows[0]?.type === "org";

    if (scope === "shared") {
      if (!(await isSharingV1EnabledForUser(userId))) { res.json({ projects: [] }); return; }
      // Shared projects are listed across ALL workspaces the user has access to:
      // a project shared with the viewer lives in the OWNER's workspace, not the
      // viewer's, so filtering by the viewer's active workspace would always
      // return an empty list for cross-workspace shares.
      const shared = await pool.query(
        `SELECT cs.*,
          COALESCE(nc.node_count, 0)::int as node_count,
          COALESCE(th.thumbnails, '[]'::json) as thumbnails,
          u.display_name AS owner_display_name,
          u.email AS owner_email,
          'viewer'::text AS viewer_role
         FROM project_participants pp
         JOIN canvas_states cs ON cs.id = pp.project_id
         LEFT JOIN users u ON u.id = cs.user_id
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int as node_count FROM canvas_nodes cn WHERE cn.canvas_id = cs.id
         ) nc ON true
         LEFT JOIN LATERAL (
           SELECT COALESCE(json_agg(sub.src), '[]'::json) as thumbnails FROM (
             SELECT cn.src FROM canvas_nodes cn
             WHERE cn.canvas_id = cs.id AND cn.node_type IN ('image', 'video') AND cn.src IS NOT NULL AND cn.src != ''
             ORDER BY (cn.node_type = 'video'), cn.updated_at DESC LIMIT 3
           ) sub
         ) th ON true
         WHERE pp.user_id = $1
           AND NOT EXISTS (
             SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = cs.workspace_id AND wm.user_id = $1
           )
         ORDER BY pp.last_seen_at DESC`,
        [userId]
      );
      res.json({ projects: shared.rows });
      return;
    }

    const ownerFilter = isTeamWorkspace ? "" : "AND cs.user_id = $2";
    const queryParams: (string)[] = isTeamWorkspace
      ? [workspaceId]
      : [workspaceId, userId];
    let projects = await pool.query(
      `SELECT cs.*,
        COALESCE(nc.node_count, 0)::int as node_count,
        COALESCE(th.thumbnails, '[]'::json) as thumbnails,
        u.display_name AS owner_display_name,
        u.email AS owner_email
       FROM canvas_states cs
       LEFT JOIN users u ON u.id = cs.user_id
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int as node_count FROM canvas_nodes cn WHERE cn.canvas_id = cs.id
       ) nc ON true
       LEFT JOIN LATERAL (
         SELECT COALESCE(json_agg(sub.src), '[]'::json) as thumbnails FROM (
           SELECT cn.src FROM canvas_nodes cn
           WHERE cn.canvas_id = cs.id AND cn.node_type IN ('image', 'video') AND cn.src IS NOT NULL AND cn.src != ''
           ORDER BY (cn.node_type = 'video'), cn.updated_at DESC LIMIT 3
         ) sub
       ) th ON true
       WHERE cs.workspace_id = $1 ${ownerFilter}
       ORDER BY cs.updated_at DESC`,
      queryParams
    );

    if (projects.rows.length === 0) {
      const defaultName = "Untitled Project";
      const created = await pool.query(
        `INSERT INTO canvas_states (workspace_id, user_id, name, project_type) VALUES ($1, $2, $3, 'design') RETURNING *`,
        [workspaceId, userId, defaultName]
      );
      projects = await pool.query(
        `SELECT cs.*, 0 as node_count FROM canvas_states cs WHERE cs.id = $1`,
        [created.rows[0].id]
      );
    }

    res.json({ projects: projects.rows });
  } catch (err) {
    console.error("List projects error:", err);
    res.status(500).json({ error: "Failed to list projects" });
  }
});

router.post("/api/projects/:workspaceId", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { workspaceId } = req.params;
    const { name } = req.body;
    const defaultName = "Untitled Project";

    const memberCheck = await pool.query(
      `SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId]
    );
    if (memberCheck.rows.length === 0) {
      res.status(403).json({ error: "Not a member of this workspace" });
      return;
    }

    const result = await pool.query(
      `INSERT INTO canvas_states (workspace_id, user_id, name, project_type) VALUES ($1, $2, $3, 'design') RETURNING *`,
      [workspaceId, userId, name || defaultName]
    );

    res.json({ project: result.rows[0] });
  } catch (err) {
    console.error("Create project error:", err);
    res.status(500).json({ error: "Failed to create project" });
  }
});

router.put("/api/projects/:projectId/rename", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { projectId } = req.params;
    const { name } = req.body;

    if (!name?.trim()) {
      res.status(400).json({ error: "Name is required" });
      return;
    }

    const access = await getProjectAccess(userId, projectId);
    if (!access.exists) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (access.role !== "owner") {
      res.status(403).json({ error: "Not authorized" });
      return;
    }

    const result = await pool.query(
      `UPDATE canvas_states SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [name.trim(), projectId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    res.json({ project: result.rows[0] });
  } catch (err) {
    console.error("Rename project error:", err);
    res.status(500).json({ error: "Failed to rename project" });
  }
});

router.delete("/api/projects/:projectId", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { projectId } = req.params;

    const access = await getProjectAccess(userId, projectId);
    if (!access.exists) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (access.role !== "owner") {
      res.status(403).json({ error: "Not authorized" });
      return;
    }

    const result = await pool.query(
      `DELETE FROM canvas_states WHERE id = $1 RETURNING id`,
      [projectId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    evictCanvas(projectId).catch((err) => {
      console.error("[redis] Failed to evict canvas from cache:", err);
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Delete project error:", err);
    res.status(500).json({ error: "Failed to delete project" });
  }
});

router.get("/api/audio-projects/:workspaceId", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { workspaceId } = req.params;

    const memberCheck = await pool.query(
      `SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId]
    );
    if (memberCheck.rows.length === 0) {
      res.status(403).json({ error: "Not a member of this workspace" });
      return;
    }

    let projects = await pool.query(
      `SELECT * FROM audio_projects WHERE workspace_id = $1 AND user_id = $2 ORDER BY updated_at DESC`,
      [workspaceId, userId]
    );

    if (projects.rows.length === 0) {
      const created = await pool.query(
        `INSERT INTO audio_projects (workspace_id, user_id, name) VALUES ($1, $2, 'My Audio Project') RETURNING *`,
        [workspaceId, userId]
      );
      projects = { rows: created.rows } as typeof projects;
    }

    res.json({ projects: projects.rows });
  } catch (err) {
    console.error("List audio projects error:", err);
    res.status(500).json({ error: "Failed to list audio projects" });
  }
});

router.post("/api/audio-projects/:workspaceId", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { workspaceId } = req.params;
    const { name } = req.body;

    const memberCheck = await pool.query(
      `SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId]
    );
    if (memberCheck.rows.length === 0) {
      res.status(403).json({ error: "Not a member of this workspace" });
      return;
    }

    const result = await pool.query(
      `INSERT INTO audio_projects (workspace_id, user_id, name) VALUES ($1, $2, $3) RETURNING *`,
      [workspaceId, userId, name || "Untitled Audio Project"]
    );

    res.json({ project: result.rows[0] });
  } catch (err) {
    console.error("Create audio project error:", err);
    res.status(500).json({ error: "Failed to create audio project" });
  }
});

router.put("/api/audio-projects/:workspaceId/:projectId/rename", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { workspaceId, projectId } = req.params;
    const { name } = req.body;

    const memberCheck = await pool.query(
      `SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId]
    );
    if (memberCheck.rows.length === 0) {
      res.status(403).json({ error: "Not a member of this workspace" });
      return;
    }

    if (!name?.trim()) {
      res.status(400).json({ error: "Name is required" });
      return;
    }

    const result = await pool.query(
      `UPDATE audio_projects SET name = $1 WHERE id = $2 AND workspace_id = $3 AND user_id = $4 RETURNING *`,
      [name.trim(), projectId, workspaceId, userId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: "Audio project not found" });
      return;
    }

    res.json({ project: result.rows[0] });
  } catch (err) {
    console.error("Rename audio project error:", err);
    res.status(500).json({ error: "Failed to rename audio project" });
  }
});

router.delete("/api/audio-projects/:workspaceId/:projectId", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { workspaceId, projectId } = req.params;

    const memberCheck = await pool.query(
      `SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId]
    );
    if (memberCheck.rows.length === 0) {
      res.status(403).json({ error: "Not a member of this workspace" });
      return;
    }

    const result = await pool.query(
      `DELETE FROM audio_projects WHERE id = $1 AND workspace_id = $2 AND user_id = $3 RETURNING id`,
      [projectId, workspaceId, userId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: "Audio project not found" });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Delete audio project error:", err);
    res.status(500).json({ error: "Failed to delete audio project" });
  }
});

router.get("/api/audio-projects/:projectId/clips", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { projectId } = req.params;
    const result = await pool.query(
      `SELECT c.* FROM audio_clips c
       JOIN audio_projects p ON p.id = c.project_id
       WHERE c.project_id = $1 AND p.user_id = $2
       ORDER BY c.sort_order ASC, c.created_at DESC`,
      [projectId, userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("List audio clips error:", err);
    res.status(500).json({ error: "Failed to list audio clips" });
  }
});

router.post("/api/audio-projects/:projectId/clips", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { projectId } = req.params;
    const { id, type, prompt, duration, voice, style, audio_url, job_id } = req.body;
    const result = await pool.query(
      `INSERT INTO audio_clips (id, project_id, user_id, type, prompt, duration, voice, style, audio_url, job_id)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
       WHERE EXISTS (SELECT 1 FROM audio_projects WHERE id = $2 AND user_id = $3)
       RETURNING *`,
      [id || undefined, projectId, userId, type || 'tts', prompt || '', duration || '0:00', voice || null, style || null, audio_url || null, job_id || null]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Audio project not found" });
      return;
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Create audio clip error:", err);
    res.status(500).json({ error: "Failed to create audio clip" });
  }
});

router.put("/api/audio-clips/:clipId", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { clipId } = req.params;
    const { audio_url, duration, job_id } = req.body;
    const sets: string[] = [];
    const vals: unknown[] = [];
    let idx = 1;
    if (audio_url !== undefined) { sets.push(`audio_url = $${idx++}`); vals.push(audio_url); }
    if (duration !== undefined) { sets.push(`duration = $${idx++}`); vals.push(duration); }
    if (job_id !== undefined) { sets.push(`job_id = $${idx++}`); vals.push(job_id); }
    if (sets.length === 0) { res.json({ ok: true }); return; }
    vals.push(clipId, userId);
    const result = await pool.query(
      `UPDATE audio_clips SET ${sets.join(", ")} WHERE id = $${idx++} AND user_id = $${idx} RETURNING *`,
      vals
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Audio clip not found" });
      return;
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Update audio clip error:", err);
    res.status(500).json({ error: "Failed to update audio clip" });
  }
});

router.post("/api/audio-clips/:clipId/save-to-library", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { clipId } = req.params;

    const clipResult = await pool.query(
      `SELECT * FROM audio_clips WHERE id = $1 AND user_id = $2`,
      [clipId, userId]
    );
    if (clipResult.rows.length === 0) {
      res.status(404).json({ error: "Audio clip not found" });
      return;
    }

    const clip = clipResult.rows[0];

    if (clip.saved_asset_id) {
      res.status(409).json({ error: "Clip already saved to library", asset_id: clip.saved_asset_id });
      return;
    }

    if (!clip.audio_url) {
      res.status(400).json({ error: "Clip has no audio URL" });
      return;
    }

    const typeToClass: Record<string, string> = {
      tts: "voice",
      voicechanger: "voice",
      music: "music",
      sfx: "sound_effect",
    };
    const audioClass = typeToClass[clip.type] || "sound_effect";

    const name = clip.prompt
      ? clip.prompt.substring(0, 100)
      : `${clip.type} clip`;

    let permanentUrl = clip.audio_url;

    const parsedAudioUrl = parseFileUrl(clip.audio_url);
    if (parsedAudioUrl) {
      const ext = path.extname(parsedAudioUrl.path) || ".mp3";
      const destFileName = `${uuidv4()}${ext}`;
      permanentUrl = await copyFile(parsedAudioUrl.bucket, parsedAudioUrl.path, `users/${userId}`, `audio-library/${destFileName}`);
    } else if (clip.audio_url.startsWith("http")) {
      const response = await fetch(clip.audio_url);
      if (!response.ok) {
        res.status(500).json({ error: "Failed to download audio file" });
        return;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      const ext = path.extname(new URL(clip.audio_url).pathname) || ".mp3";
      const destFileName = `${uuidv4()}${ext}`;
      permanentUrl = await saveFile(`users/${userId}`, `audio-library/${destFileName}`, buffer);
    }

    const assetResult = await pool.query(
      `INSERT INTO audio_assets (user_id, audio_class, folder_id, name, file_url, file_type, metadata, source)
       VALUES ($1, $2, NULL, $3, $4, $5, $6, 'canvas')
       RETURNING *`,
      [
        userId,
        audioClass,
        name,
        permanentUrl,
        "audio/mpeg",
        JSON.stringify({
          source: "generated",
          clip_type: clip.type,
          clip_id: clipId,
          prompt: clip.prompt || null,
          style: clip.style || null,
          type: clip.type || null,
          voice: clip.voice || null,
        }),
      ]
    );

    const asset = assetResult.rows[0];

    await pool.query(
      `UPDATE audio_clips SET saved_asset_id = $1 WHERE id = $2`,
      [asset.id, clipId]
    );

    res.json({ ok: true, asset });
  } catch (err) {
    console.error("Save to library error:", err);
    res.status(500).json({ error: "Failed to save to library" });
  }
});

router.delete("/api/audio-clips/:clipId", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { clipId } = req.params;
    const result = await pool.query(
      `DELETE FROM audio_clips WHERE id = $1 AND user_id = $2 RETURNING id, saved_asset_id`,
      [clipId, userId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Audio clip not found" });
      return;
    }

    const savedAssetId = result.rows[0].saved_asset_id;
    if (savedAssetId) {
      await pool.query(
        `UPDATE audio_assets SET deleted_at = now(), folder_id = NULL WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [savedAssetId, userId]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Delete audio clip error:", err);
    res.status(500).json({ error: "Failed to delete audio clip" });
  }
});

router.get("/api/canvas/:canvasId/load", async (req: AuthRequest, res: Response) => {
  try {
    const { canvasId } = req.params;

    const access = await ensureCanvasAccess(req, res, canvasId, "read");
    if (!access.ok) return;

    const canvas = await pool.query(
      `SELECT cs.* FROM canvas_states cs WHERE cs.id = $1`,
      [canvasId]
    );

    if (canvas.rows.length === 0) {
      res.status(404).json({ error: "Canvas not found" });
      return;
    }

    const canvasState = canvas.rows[0];
    canvasState.viewer_role = access.role;

    // Orphan reconciliation for "generating" placeholder nodes that the agent
    // dropped on canvas. The client normally polls the linked job and mutates
    // the node to image/video on success or marks metadata.status='failed' on
    // failure, but if the user closed the tab mid-generation those placeholders
    // would otherwise stay shimmering forever. We resolve them here on load.
    try {
      // 1) Successful jobs with a usable result_url → convert placeholder
      //    into the appropriate image/video node, in place.
      await pool.query(
        `UPDATE canvas_nodes cn
            SET node_type = CASE
                  WHEN COALESCE(j.type, '') ILIKE '%video%' THEN 'video'
                  ELSE 'image'
                END,
                src = j.result_url,
                metadata = COALESCE(cn.metadata, '{}'::jsonb)
                           - 'status' - 'errorMsg'
                           || jsonb_build_object('reconciled', true)
          FROM jobs j
         WHERE cn.canvas_id = $1
           AND cn.node_type = 'generating'
           AND cn.job_id = j.id
           AND j.status IN ('succeeded', 'completed', 'success')
           AND j.result_url IS NOT NULL
           AND j.result_url <> ''`,
        [canvasState.id]
      );

      // 2) Failed / cancelled jobs → mark the placeholder as failed so the
      //    GeneratingNode renders its error treatment.
      await pool.query(
        `UPDATE canvas_nodes cn
            SET metadata = COALESCE(cn.metadata, '{}'::jsonb)
                           || jsonb_build_object(
                                'status', 'failed',
                                'errorMsg', COALESCE(j.error, 'Generation failed')
                              )
          FROM jobs j
         WHERE cn.canvas_id = $1
           AND cn.node_type = 'generating'
           AND cn.job_id = j.id
           AND j.status IN ('failed', 'cancelled', 'canceled', 'error')
           AND COALESCE(cn.metadata->>'status', '') <> 'failed'`,
        [canvasState.id]
      );

      // 3) Generating nodes with no linked job that are stale (> 10 min):
      //    we have no way to recover, so mark them failed.
      await pool.query(
        `UPDATE canvas_nodes
            SET metadata = COALESCE(metadata, '{}'::jsonb)
                           || jsonb_build_object(
                                'status', 'failed',
                                'errorMsg', 'Generation timed out'
                              )
          WHERE canvas_id = $1
            AND node_type = 'generating'
            AND job_id IS NULL
            AND created_at < NOW() - INTERVAL '10 minutes'
            AND COALESCE(metadata->>'status', '') <> 'failed'`,
        [canvasState.id]
      );

      // 4) Generating nodes whose linked job is still non-terminal but the
      //    node is very old (> 30 min). These are effectively wedged — the
      //    job worker may have died — so we mark the node failed so the user
      //    can dismiss it instead of seeing a perpetual shimmer.
      await pool.query(
        `UPDATE canvas_nodes cn
            SET metadata = COALESCE(cn.metadata, '{}'::jsonb)
                           || jsonb_build_object(
                                'status', 'failed',
                                'errorMsg', 'Generation timed out'
                              )
           FROM jobs j
          WHERE cn.canvas_id = $1
            AND cn.node_type = 'generating'
            AND cn.job_id = j.id
            AND j.status NOT IN ('succeeded', 'success', 'completed', 'failed', 'cancelled', 'canceled', 'error')
            AND cn.created_at < NOW() - INTERVAL '30 minutes'
            AND COALESCE(cn.metadata->>'status', '') <> 'failed'`,
        [canvasState.id]
      );
    } catch (reconcileErr) {
      // Reconciliation is best-effort; never fail the load on it.
      console.warn("[canvas:load] generating-node reconciliation failed:", reconcileErr);
    }

    const nodes = await pool.query(
      `SELECT cn.* FROM canvas_nodes cn
       WHERE cn.canvas_id = $1
         AND cn.id NOT IN (
           SELECT node_id FROM canvas_node_tombstones WHERE canvas_id = $1
         )
       ORDER BY cn.z_index ASC`,
      [canvasState.id]
    );

    let resultNodes: Record<string, unknown>[] = nodes.rows;

    if (process.env.NODE_ENV !== 'production') {
      console.log(
        `[canvas:load] canvasId=${canvasState.id} pgNodePositions=${JSON.stringify(
          nodes.rows.map((n: Record<string, unknown>) => ({ id: n.id, x: n.x, y: n.y }))
        )}`
      );
    }

    try {
      // LOAD STRATEGY: Postgres is the authoritative source of truth for committed data.
      // We read Postgres first (above) and then merge Redis on top as a performance
      // optimisation — Redis may contain in-flight ephemeral updates (mid-drag positions,
      // etc.) that have not yet been committed to Postgres. If Redis is unavailable or
      // empty, the Postgres data is returned directly with no data loss.
      const warm = await isCanvasWarm(canvasState.id);
      if (process.env.NODE_ENV !== 'production') {
        console.log(`[canvas:load] canvasId=${canvasState.id} isCanvasWarm=${warm}`);
      }
      if (warm) {
        const redisNodes = await getCanvas(canvasState.id);
        if (process.env.NODE_ENV !== 'production') {
          console.log(
            `[canvas:load] canvasId=${canvasState.id} redisNodePositions=${JSON.stringify(
              (redisNodes ?? []).map((n: Record<string, unknown>) => ({ id: n.id, x: n.x, y: n.y }))
            )}`
          );
        }
        if (redisNodes && redisNodes.length > 0) {
          const tombstoneResult = await pool.query(
            `SELECT node_id FROM canvas_node_tombstones WHERE canvas_id = $1`,
            [canvasState.id]
          ).catch(() => ({ rows: [] as { node_id: string }[] }));
          const tombstonedIds = new Set(tombstoneResult.rows.map((r) => r.node_id));

          const redisById = new Map<string, Record<string, unknown>>();
          for (const redisNode of redisNodes) {
            if (!tombstonedIds.has(redisNode.id as string)) {
              redisById.set(redisNode.id as string, redisNode);
            }
          }
          const merged: Record<string, unknown>[] = nodes.rows.map((pgNode) => {
            const redisNode = redisById.get(pgNode.id as string);
            if (!redisNode) return pgNode;
            const pgUpdatedAt = pgNode.updated_at ? new Date(pgNode.updated_at as string).getTime() : 0;
            if (pgUpdatedAt > 0) {
              if (!redisNode._updated_at) {
                return pgNode;
              }
              const redisUpdatedAt = new Date(redisNode._updated_at as string).getTime();
              if (redisUpdatedAt <= pgUpdatedAt) {
                return pgNode;
              }
            }
            return { ...pgNode, ...redisNode };
          });
          resultNodes = merged.sort((a, b) =>
            ((a.z_index as number) ?? 0) - ((b.z_index as number) ?? 0)
          );
        }
      } else if (nodes.rows.length > 0) {
        warmCanvas(canvasState.id, nodes.rows).catch((err) => {
          console.error("[redis] Failed to warm canvas cache:", err);
        });
      }
    } catch (err) {
      console.debug("[redis] Redis load failed, falling back to Postgres:", err);
    }

    let cinemaTracks: unknown[] = [];
    let cinemaClips: unknown[] = [];
    try {
      // Idempotent orphan sweep: if the canvas no longer has a live cinema
      // node (e.g. a previous bug left tracks/clips behind), wipe the rows so
      // they cannot be re-attached on next load. Safe to run repeatedly.
      const hasCinema = resultNodes.some(
        (n) => (n as { node_type?: string }).node_type === "cinema"
      );
      if (!hasCinema) {
        await pool.query(`DELETE FROM cinema_clips WHERE canvas_id = $1`, [canvasState.id]);
        await pool.query(`DELETE FROM cinema_tracks WHERE canvas_id = $1`, [canvasState.id]);
      } else {
        // One-time adoption of pre-multi-node rows: they were canvas-scoped, so
        // they belong to whichever cinema frame the canvas already had.
        const firstCinema = resultNodes.find(
          (n) => (n as { node_type?: string }).node_type === "cinema"
        ) as { id: string } | undefined;
        if (firstCinema) {
          await pool.query(
            `UPDATE cinema_tracks SET node_id = $2 WHERE canvas_id = $1 AND node_id = ''`,
            [canvasState.id, firstCinema.id]
          );
        }
        const tracksResult = await pool.query(
          `SELECT * FROM cinema_tracks WHERE canvas_id = $1 ORDER BY sort_order ASC`,
          [canvasState.id]
        );
        cinemaTracks = tracksResult.rows;
        if (tracksResult.rows.length > 0) {
          const tombstonesResult = await pool.query(
            `SELECT clip_id FROM cinema_clip_tombstones WHERE canvas_id = $1`,
            [canvasState.id]
          );
          const tombIds = new Set(tombstonesResult.rows.map((r: { clip_id: string }) => r.clip_id));
          const clipsResult = await pool.query(
            `SELECT * FROM cinema_clips WHERE canvas_id = $1 ORDER BY sort_order ASC`,
            [canvasState.id]
          );
          cinemaClips = clipsResult.rows.filter((c: { id: string }) => !tombIds.has(c.id));
        }
      }
    } catch (cinemaErr) {
      console.error("[canvas:load] cinema timeline load error:", cinemaErr);
    }

    let tombstonedNodeIds: string[] = [];
    try {
      const tombResult = await pool.query(
        `SELECT node_id FROM canvas_node_tombstones WHERE canvas_id = $1`,
        [canvasState.id]
      );
      tombstonedNodeIds = tombResult.rows.map((r: { node_id: string }) => r.node_id);
    } catch (tombErr) {
      console.warn("[canvas:load] tombstone fetch failed:", tombErr);
    }

    res.json({ canvas: canvasState, nodes: resultNodes, cinemaTracks, cinemaClips, tombstonedNodeIds });
  } catch (err) {
    console.error("Load canvas error:", err);
    res.status(500).json({ error: "Failed to load canvas" });
  }
});

router.put("/api/canvas/:canvasId", async (req: AuthRequest, res: Response) => {
  try {
    const { canvasId } = req.params;
    const { viewport_x, viewport_y, viewport_zoom } = req.body;

    const access = await ensureCanvasAccess(req, res, canvasId, "write");
    if (!access.ok) return;

    const result = await pool.query(
      `UPDATE canvas_states SET viewport_x = COALESCE($1, viewport_x), viewport_y = COALESCE($2, viewport_y), viewport_zoom = COALESCE($3, viewport_zoom) WHERE id = $4 RETURNING *`,
      [viewport_x, viewport_y, viewport_zoom, canvasId]
    );

    res.json({ canvas: result.rows[0] });
  } catch (err) {
    console.error("Update canvas error:", err);
    res.status(500).json({ error: "Failed to update canvas" });
  }
});

router.post("/api/canvas/:canvasId/nodes", async (req: AuthRequest, res: Response) => {
  try {
    const { canvasId } = req.params;

    const access = await ensureCanvasAccess(req, res, canvasId, "write");
    if (!access.ok) return;

    const { client_id, node_type, x, y, width, height, rotation, z_index, label, src, gradient, asset_id, job_id, metadata } = req.body;

    const sanitizedSrc = (typeof src === 'string' && src.startsWith('blob:')) ? '' : (src || '');

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const validClientId = typeof client_id === 'string' && UUID_RE.test(client_id) ? client_id : null;

    const maxZ = await pool.query(
      `SELECT COALESCE(MAX(z_index), 0) + 1 as next_z FROM canvas_nodes WHERE canvas_id = $1`,
      [canvasId]
    );

    let result;
    if (validClientId) {
      await pool.query(
        `DELETE FROM canvas_node_tombstones WHERE node_id = $1 AND canvas_id = $2`,
        [validClientId, canvasId]
      );
      result = await pool.query(
        `INSERT INTO canvas_nodes (id, canvas_id, node_type, x, y, width, height, rotation, z_index, label, src, gradient, asset_id, job_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (id) DO UPDATE SET updated_at = NOW()
         RETURNING *`,
        [
          validClientId,
          canvasId,
          node_type || 'image',
          x || 0,
          y || 0,
          width || 256,
          height || 256,
          rotation || 0,
          z_index ?? maxZ.rows[0].next_z,
          label || '',
          sanitizedSrc,
          gradient || '',
          asset_id || null,
          job_id || null,
          metadata ? JSON.stringify(metadata) : '{}'
        ]
      );
    } else {
      result = await pool.query(
        `INSERT INTO canvas_nodes (canvas_id, node_type, x, y, width, height, rotation, z_index, label, src, gradient, asset_id, job_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING *`,
        [
          canvasId,
          node_type || 'image',
          x || 0,
          y || 0,
          width || 256,
          height || 256,
          rotation || 0,
          z_index ?? maxZ.rows[0].next_z,
          label || '',
          sanitizedSrc,
          gradient || '',
          asset_id || null,
          job_id || null,
          metadata ? JSON.stringify(metadata) : '{}'
        ]
      );
    }

    const createdNode = result.rows[0];

    if (redisClient) {
      setNodes(canvasId, [createdNode as RedisNodeUpdate]).catch((err) => {
        console.error("[redis] Failed to write new node to cache:", err);
      });
      scheduleCanvasFlush();
    }

    const sessionId = (req.headers["x-canvas-session-id"] as string) || "";
    broadcastCanvasUpdate(canvasId, sessionId);

    res.json({ node: createdNode });
  } catch (err) {
    console.error("Create canvas node error:", err);
    res.status(500).json({ error: "Failed to create node" });
  }
});

router.get("/api/canvas/:canvasId/nodes/:nodeId", async (req: AuthRequest, res: Response) => {
  try {
    const { canvasId, nodeId } = req.params;

    const access = await ensureCanvasAccess(req, res, canvasId, "read");
    if (!access.ok) return;

    const result = await pool.query(
      `SELECT cn.* FROM canvas_nodes cn WHERE cn.canvas_id = $1 AND cn.id = $2`,
      [canvasId, nodeId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: "Node not found" });
      return;
    }

    res.json({ node: result.rows[0] });
  } catch (err) {
    console.error("Get canvas node error:", err);
    res.status(500).json({ error: "Failed to get node" });
  }
});

router.put("/api/canvas/:canvasId/nodes/:nodeId", async (req: AuthRequest, res: Response) => {
  try {
    const { canvasId, nodeId } = req.params;

    const access = await ensureCanvasAccess(req, res, canvasId, "write");
    if (!access.ok) return;

    const nodeExists = await pool.query(
      `SELECT 1 FROM canvas_nodes WHERE id = $1 AND canvas_id = $2`,
      [nodeId, canvasId]
    );
    if (nodeExists.rows.length === 0) {
      res.status(404).json({ error: "Node not found" });
      return;
    }

    const { x, y, width, height, rotation, z_index, locked, visible, label, src, gradient, asset_id, job_id, metadata } = req.body;

    const sanitizedSrc = (typeof src === 'string' && src.startsWith('blob:')) ? null : src;

    const result = await pool.query(
      `UPDATE canvas_nodes SET
        x = COALESCE($1, x),
        y = COALESCE($2, y),
        width = COALESCE($3, width),
        height = COALESCE($4, height),
        rotation = COALESCE($5, rotation),
        z_index = COALESCE($6, z_index),
        locked = COALESCE($7, locked),
        visible = COALESCE($8, visible),
        label = COALESCE($9, label),
        src = COALESCE($10, src),
        gradient = COALESCE($11, gradient),
        asset_id = COALESCE($12, asset_id),
        job_id = COALESCE($13, job_id),
        metadata = COALESCE($14, metadata)
      WHERE id = $15 RETURNING *`,
      [x, y, width, height, rotation, z_index, locked, visible, label, sanitizedSrc, gradient, asset_id, job_id, metadata ? JSON.stringify(metadata) : null, nodeId]
    );

    const updatedNode = result.rows[0];

    if (redisClient && updatedNode) {
      setNodes(canvasId, [updatedNode as RedisNodeUpdate]).catch((err) => {
        console.error("[redis] Failed to sync updated node to cache:", err);
      });
      scheduleCanvasFlush();
    }

    res.json({ node: updatedNode });
  } catch (err) {
    console.error("Update canvas node error:", err);
    res.status(500).json({ error: "Failed to update node" });
  }
});

router.delete("/api/canvas/:canvasId/nodes/:nodeId", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { canvasId, nodeId } = req.params;

    // First check canvas ownership — this is the only real auth gate.
    // A missing node is NOT an auth failure; treat it as already-deleted (200).
    const access = await ensureCanvasAccess(req, res, canvasId, "write");
    if (!access.ok) return;

    // Fetch node details for optional asset archiving before deleting.
    const nodeCheck = await pool.query(
      `SELECT * FROM canvas_nodes WHERE id = $1 AND canvas_id = $2`,
      [nodeId, canvasId]
    );

    if (nodeCheck.rows.length > 0) {
      const node = nodeCheck.rows[0];
      if (node.src && (node.node_type === "image" || node.node_type === "video" || node.node_type === "svg" || node.node_type === "audio")) {
        const archiveType = node.node_type === "svg" ? "vector" : node.node_type;
        await pool.query(
          `INSERT INTO assets (user_id, type, source, name, file_url, metadata, deleted_at)
           VALUES ($1, $2, 'canvas', $3, $4, $5, NOW())`,
          [
            userId,
            archiveType,
            node.label || "Canvas item",
            node.src,
            JSON.stringify({ canvas_node_id: node.id, job_id: node.job_id }),
          ]
        );
      }
      // Cancel the underlying job when a still-in-flight placeholder is
      // dismissed/deleted from the canvas. Gated on the same in-flight
      // statuses as POST /api/job/:job_id/cancel so finished jobs are
      // unaffected and the fal.ts polling loop sees the cancellation.
      if (node.job_id) {
        try {
          await pool.query(
            `UPDATE jobs SET status = 'cancelled'
             WHERE id = $1 AND user_id = $2
             AND status IN ('queued', 'pending', 'processing')`,
            [node.job_id, userId]
          );
        } catch (err) {
          console.error("[canvas] Failed to cancel job on node delete:", err);
        }
      }

      // A cinema frame owns the cinema_tracks rows tagged with its node id (and
      // their clips). Cascade-delete just those (tombstoning each clip) in the
      // same transaction as the node delete + tombstone write, so an in-flight
      // client `cinema/sync` flush cannot resurrect them — and so deleting one
      // frame leaves every other frame's timeline alone. (Legacy node_id ''
      // rows are adopted by the loader, so by here every row is tagged.)
      if (node.node_type === "cinema") {
        const cinemaClient = await pool.connect();
        try {
          await cinemaClient.query("BEGIN");
          const orphanClips = await cinemaClient.query(
            `SELECT c.id FROM cinema_clips c
               JOIN cinema_tracks t ON t.id = c.track_id
              WHERE c.canvas_id = $1 AND t.node_id = $2`,
            [canvasId, nodeId]
          );
          for (const r of orphanClips.rows as { id: string }[]) {
            await cinemaClient.query(
              `INSERT INTO cinema_clip_tombstones (canvas_id, clip_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
              [canvasId, r.id]
            );
          }
          await cinemaClient.query(
            `DELETE FROM cinema_clips WHERE canvas_id = $1 AND track_id IN (
               SELECT id FROM cinema_tracks WHERE canvas_id = $1 AND node_id = $2)`,
            [canvasId, nodeId]
          );
          await cinemaClient.query(
            `DELETE FROM cinema_tracks WHERE canvas_id = $1 AND node_id = $2`,
            [canvasId, nodeId]
          );
          await cinemaClient.query(`DELETE FROM canvas_nodes WHERE id = $1`, [nodeId]);
          await cinemaClient.query(
            `INSERT INTO canvas_node_tombstones (node_id, canvas_id) VALUES ($1, $2) ON CONFLICT (node_id) DO NOTHING`,
            [nodeId, canvasId]
          );
          await cinemaClient.query("COMMIT");
        } catch (cinemaErr) {
          await cinemaClient.query("ROLLBACK").catch(() => {});
          console.error("[canvas] Cinema cascade-delete failed:", cinemaErr);
          throw cinemaErr;
        } finally {
          cinemaClient.release();
        }
      } else {
        await pool.query(`DELETE FROM canvas_nodes WHERE id = $1`, [nodeId]);
      }
    }

    // Always write tombstone — even if the node was already gone from canvas_nodes.
    // This prevents resurrection if the node somehow re-appears in Redis or a
    // stale create mutation replays from the client dirty queue.
    await pool.query(
      `INSERT INTO canvas_node_tombstones (node_id, canvas_id) VALUES ($1, $2) ON CONFLICT (node_id) DO NOTHING`,
      [nodeId, canvasId]
    );

    try {
      await evictNode(canvasId, nodeId);
    } catch (err) {
      console.error("[redis] Failed to evict node from cache (tombstone is authoritative):", err);
    }
    scheduleCanvasFlush();

    const sessionId = (req.headers["x-canvas-session-id"] as string) || "";
    broadcastCanvasUpdate(canvasId, sessionId);

    res.json({ success: true });
  } catch (err) {
    console.error("Delete canvas node error:", err);
    res.status(500).json({ error: "Failed to delete node" });
  }
});

router.post("/api/canvas/:canvasId/nodes/batch", async (req: AuthRequest, res: Response) => {
  try {
    await acquireBatchSlot();
  } catch (slotErr) {
    res.status(503).json({ error: "Server too busy, try again later" });
    return;
  }
  try {
    const { canvasId } = req.params;

    const access = await ensureCanvasAccess(req, res, canvasId, "write");
    if (!access.ok) return;
    const canvas = { project_type: access.projectType };

    const { updates, committed } = req.body;
    if (!Array.isArray(updates) || updates.length === 0) {
      res.status(400).json({ error: "updates must be a non-empty array" });
      return;
    }

    const isCommitted = committed === true;

    const typedUpdates = updates as BatchNodeUpdate[];
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const warnings: string[] = [];

    const invalidIds = typedUpdates
      .filter((u) => u.id && !uuidRegex.test(u.id))
      .map((u) => u.id);
    if (invalidIds.length > 0) {
      res.status(400).json({ error: `Invalid node IDs: ${invalidIds.join(', ')}` });
      return;
    }

    const nodeIds = typedUpdates
      .filter((u): u is BatchNodeUpdate & { id: string } => !!u.id && uuidRegex.test(u.id))
      .map((u) => u.id);
    if (nodeIds.length === 0) {
      res.status(400).json({ error: "No valid node IDs in updates" });
      return;
    }

    const fieldErrors: string[] = [];
    for (const u of typedUpdates) {
      if (!u.id) continue;
      if (u.x !== undefined && typeof u.x !== 'number') fieldErrors.push(`Node ${u.id}: x must be a number`);
      if (u.y !== undefined && typeof u.y !== 'number') fieldErrors.push(`Node ${u.id}: y must be a number`);
      if (u.width !== undefined && (typeof u.width !== 'number' || u.width < 0)) fieldErrors.push(`Node ${u.id}: width must be a non-negative number`);
      if (u.height !== undefined && (typeof u.height !== 'number' || u.height < 0)) fieldErrors.push(`Node ${u.id}: height must be a non-negative number`);
    }
    if (fieldErrors.length > 0) {
      res.status(400).json({ error: "Invalid update fields", details: fieldErrors });
      return;
    }

    const existingNodes = await pool.query(
      `SELECT id FROM canvas_nodes WHERE canvas_id = $1 AND id = ANY($2::uuid[])`,
      [canvasId, nodeIds]
    );
    const validIds = new Set(existingNodes.rows.map((r: { id: string }) => r.id));

    const tombstoneCheck = await pool.query(
      `SELECT node_id FROM canvas_node_tombstones WHERE canvas_id = $1 AND node_id = ANY($2::uuid[])`,
      [canvasId, nodeIds]
    );
    const tombstonedIds = new Set(tombstoneCheck.rows.map((r: { node_id: string }) => r.node_id));
    for (const tid of tombstonedIds) {
      validIds.delete(tid);
    }

    const validUpdates = typedUpdates.filter((u) => u.id && validIds.has(u.id));
    const skippedIds = typedUpdates.filter((u) => u.id && !validIds.has(u.id)).map((u) => u.id);
    for (const skippedId of skippedIds) {
      const reason = tombstonedIds.has(skippedId!) ? "is tombstoned on" : "does not belong to";
      warnings.push(`Node ${skippedId} ${reason} canvas ${canvasId}, skipped`);
    }

    // Cinema nodes are now first-class on any canvas (Task #482 collapsed
    // the cinema project_type into design), so no node_type stripping
    // happens here — without this, cinema nodes inserted via the Cinema
    // rail would never persist and would vanish on refresh.
    const sanitizedUpdates = validUpdates.map((u) => {
      const batchSrc = (typeof u.src === 'string' && u.src.startsWith('blob:')) ? null : u.src;
      return { ...u, src: batchSrc };
    });

    if (isCommitted) {
      await upsertNodesPostgres(canvasId, sanitizedUpdates as RedisNodeUpdate[]);
    }

    if (redisClient) {
      try {
        await setNodes(canvasId, sanitizedUpdates as RedisNodeUpdate[]);
      } catch (redisErr) {
        console.error("[redis] setNodes failed (Postgres write succeeded, non-fatal):", redisErr);
      }
      scheduleCanvasFlush();
    }

    if (isCommitted && validUpdates.length > 0) {
      const sessionId = (req.headers["x-canvas-session-id"] as string) || "";
      broadcastCanvasUpdate(canvasId, sessionId);
    }

    const nonTombstoneWarnings = warnings.filter((w) => !w.includes("tombstoned"));
    if (nonTombstoneWarnings.length > 0) {
      console.warn("Batch update warnings:", nonTombstoneWarnings);
    }
    res.json({ success: true, warnings, skipped: skippedIds });
  } catch (err) {
    console.error("Batch update canvas nodes error:", err);
    res.status(500).json({ error: "Failed to batch update nodes" });
  } finally {
    releaseBatchSlot();
  }
});

/** Provenance edges for a canvas: which node's output was an input to which.
 *  Read-only, derived from jobs.params — nothing is written to record it. */
export async function loadCanvasEdges(canvasId: string): Promise<ProvenanceEdge[]> {
  const { rows } = await pool.query(
    `SELECT cn.id, cn.src, j.type AS job_type, j.params, j.result_url, a.file_url
       FROM canvas_nodes cn
       LEFT JOIN jobs j ON j.id = cn.job_id
       LEFT JOIN assets a ON a.id = cn.asset_id
      WHERE cn.canvas_id = $1
      ORDER BY cn.created_at`,
    [canvasId],
  );
  return deriveEdges(
    rows.map((r: Record<string, unknown>) => ({
      id: r.id as string,
      jobType: (r.job_type as string | null) ?? null,
      params: (r.params as Record<string, unknown> | null) ?? null,
      urls: [r.result_url as string | null, r.file_url as string | null, r.src as string | null],
    })),
  );
}

router.get("/api/canvas/:canvasId/edges", async (req: AuthRequest, res: Response) => {
  try {
    const { canvasId } = req.params;
    const access = await ensureCanvasAccess(req, res, canvasId, "read");
    if (!access.ok) return;
    res.json({ edges: await loadCanvasEdges(canvasId) });
  } catch (err) {
    console.error("Load canvas edges error:", err);
    res.status(500).json({ error: "Failed to load canvas edges" });
  }
});

router.get("/api/canvas/:canvasId/cinema/timeline", async (req: AuthRequest, res: Response) => {
  try {
    const { canvasId } = req.params;

    const access = await ensureCanvasAccess(req, res, canvasId, "read");
    if (!access.ok) return;

    const tracks = await pool.query(
      `SELECT * FROM cinema_tracks WHERE canvas_id = $1 ORDER BY sort_order ASC`,
      [canvasId]
    );

    const tombstones = await pool.query(
      `SELECT clip_id FROM cinema_clip_tombstones WHERE canvas_id = $1`,
      [canvasId]
    );
    const tombstonedIds = new Set(tombstones.rows.map((r: { clip_id: string }) => r.clip_id));

    const clips = await pool.query(
      `SELECT * FROM cinema_clips WHERE canvas_id = $1 ORDER BY sort_order ASC`,
      [canvasId]
    );

    const activeClips = clips.rows.filter((c: { id: string }) => !tombstonedIds.has(c.id));

    res.json({ tracks: tracks.rows, clips: activeClips });
  } catch (err) {
    console.error("Load cinema timeline error:", err);
    res.status(500).json({ error: "Failed to load cinema timeline" });
  }
});

router.post("/api/canvas/:canvasId/cinema/sync", async (req: AuthRequest, res: Response) => {
  try {
    const { canvasId } = req.params;
    const { tracks, clips, deletedClipIds, deletedTrackIds } = req.body;
    // Which cinema frame this timeline belongs to. Older clients don't send it;
    // '' matches the legacy canvas-scoped rows.
    const nodeId: string = typeof req.body?.nodeId === "string" ? req.body.nodeId : "";

    const access = await ensureCanvasAccess(req, res, canvasId, "write");
    if (!access.ok) return;

    // Refuse to write tracks/clips for a cinema frame that is gone or
    // tombstoned — otherwise a queued client sync flushed after the user
    // deleted the frame would resurrect orphan rows that the next page load
    // would re-attach to a freshly created cinema node.
    const parentCheck = await pool.query(
      `SELECT 1 FROM canvas_nodes
        WHERE canvas_id = $1 AND node_type = 'cinema'
          AND ($2 = '' OR id::text = $2)
          AND id NOT IN (SELECT node_id FROM canvas_node_tombstones WHERE canvas_id = $1)
        LIMIT 1`,
      [canvasId, nodeId]
    );
    if (parentCheck.rows.length === 0) {
      return res.status(409).json({ error: "Cinema frame not found for canvas" });
    }

    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const isUuid = (v: unknown): v is string => typeof v === "string" && uuidRe.test(v);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      if (Array.isArray(deletedClipIds) && deletedClipIds.length > 0) {
        for (const clipId of deletedClipIds.filter(isUuid)) {
          await client.query(
            `INSERT INTO cinema_clip_tombstones (canvas_id, clip_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [canvasId, clipId]
          );
        }
        const validDeletedClipIds = deletedClipIds.filter(isUuid);
        if (validDeletedClipIds.length > 0) {
          await client.query(
            `DELETE FROM cinema_clips WHERE canvas_id = $1 AND id = ANY($2::uuid[])`,
            [canvasId, validDeletedClipIds]
          );
        }
      }

      if (Array.isArray(deletedTrackIds) && deletedTrackIds.length > 0) {
        const validDeletedTrackIds = deletedTrackIds.filter(isUuid);
        if (validDeletedTrackIds.length > 0) {
          const orphanClips = await client.query(
            `SELECT id FROM cinema_clips WHERE track_id = ANY($1::uuid[])`,
            [validDeletedTrackIds]
          );
          const orphanIds = orphanClips.rows.map((r: { id: string }) => r.id);
          if (orphanIds.length > 0) {
            for (const clipId of orphanIds) {
              await client.query(
                `INSERT INTO cinema_clip_tombstones (canvas_id, clip_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                [canvasId, clipId]
              );
            }
          }
          await client.query(
            `DELETE FROM cinema_tracks WHERE canvas_id = $1 AND node_id = $3 AND id = ANY($2::uuid[])`,
            [canvasId, validDeletedTrackIds, nodeId]
          );
        }
      }

      if (Array.isArray(tracks) && tracks.length > 0) {
        for (const track of tracks) {
          if (!isUuid(track.id)) continue;
          await client.query(
            `INSERT INTO cinema_tracks (id, canvas_id, node_id, track_type, sort_order, muted)
             VALUES ($1, $2, $5, $3, $4, $6)
             ON CONFLICT (id) DO UPDATE SET
               track_type = COALESCE(EXCLUDED.track_type, cinema_tracks.track_type),
               sort_order = COALESCE(EXCLUDED.sort_order, cinema_tracks.sort_order),
               node_id = EXCLUDED.node_id,
               muted = EXCLUDED.muted,
               updated_at = NOW()
             WHERE cinema_tracks.canvas_id = $2`,
            [track.id, canvasId, track.track_type, track.sort_order ?? 0, nodeId, track.muted === true]
          );
        }
      }

      if (Array.isArray(clips) && clips.length > 0) {
        const validClips = clips.filter((c: { id: string; track_id: string }) => isUuid(c.id) && isUuid(c.track_id));
        const clipIds = validClips.map((c: { id: string }) => c.id);

        const tombstoned = clipIds.length > 0 ? await client.query(
          `SELECT clip_id FROM cinema_clip_tombstones WHERE canvas_id = $1 AND clip_id = ANY($2::uuid[])`,
          [canvasId, clipIds]
        ) : { rows: [] };
        const tombstonedSet = new Set(tombstoned.rows.map((r: { clip_id: string }) => r.clip_id));

        const validTrackIds = await client.query(
          `SELECT id FROM cinema_tracks WHERE canvas_id = $1 AND node_id = $2`,
          [canvasId, nodeId]
        );
        const validTrackIdSet = new Set(validTrackIds.rows.map((r: { id: string }) => r.id));

        for (const clip of validClips) {
          if (tombstonedSet.has(clip.id)) continue;
          if (!validTrackIdSet.has(clip.track_id)) continue;
          await client.query(
            `INSERT INTO cinema_clips (id, track_id, canvas_id, source_node_id, src, clip_type, duration, start_offset, trim_start, trim_end, volume, label, linked_clip_id, sort_order)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
             ON CONFLICT (id) DO UPDATE SET
               track_id = COALESCE(EXCLUDED.track_id, cinema_clips.track_id),
               source_node_id = COALESCE(EXCLUDED.source_node_id, cinema_clips.source_node_id),
               src = COALESCE(EXCLUDED.src, cinema_clips.src),
               clip_type = COALESCE(EXCLUDED.clip_type, cinema_clips.clip_type),
               duration = COALESCE(EXCLUDED.duration, cinema_clips.duration),
               start_offset = COALESCE(EXCLUDED.start_offset, cinema_clips.start_offset),
               trim_start = COALESCE(EXCLUDED.trim_start, cinema_clips.trim_start),
               trim_end = COALESCE(EXCLUDED.trim_end, cinema_clips.trim_end),
               volume = COALESCE(EXCLUDED.volume, cinema_clips.volume),
               label = COALESCE(EXCLUDED.label, cinema_clips.label),
               linked_clip_id = EXCLUDED.linked_clip_id,
               sort_order = COALESCE(EXCLUDED.sort_order, cinema_clips.sort_order),
               updated_at = NOW()
             WHERE cinema_clips.canvas_id = $3`,
            [
              clip.id, clip.track_id, canvasId,
              clip.source_node_id || '', clip.src || '', clip.clip_type || 'video',
              clip.duration ?? 3, clip.start_offset ?? 0,
              clip.trim_start ?? 0, clip.trim_end ?? 0, clip.volume ?? 1,
              clip.label || '', clip.linked_clip_id || null, clip.sort_order ?? 0
            ]
          );
        }
      }

      await client.query("COMMIT");
      res.json({ success: true });
    } catch (txErr) {
      await client.query("ROLLBACK");
      throw txErr;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Cinema timeline sync error:", err);
    res.status(500).json({ error: "Failed to sync cinema timeline" });
  }
});

export { broadcastCanvasUpdate };
export default router;
