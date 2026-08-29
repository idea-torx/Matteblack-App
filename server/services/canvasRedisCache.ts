import redisClient from "./redisClient.js";
import { pool } from "../db.js";

function canvasKey(canvasId: string): string {
  return `canvas:nodes:${canvasId}`;
}

const DIRTY_SET_KEY = "canvas:dirty";

export interface RedisNodeUpdate {
  id: string;
  [key: string]: unknown;
}

const SET_NODES_LUA = `
local key = KEYS[1]
local dirtyKey = KEYS[2]
local canvasId = ARGV[1]
local ts = ARGV[2]
for i = 3, #ARGV, 2 do
  local nodeId = ARGV[i]
  local updateJson = ARGV[i+1]
  local existing = redis.call('HGET', key, nodeId)
  local merged
  if existing then
    merged = cjson.decode(existing)
  else
    merged = { _partial = true }
  end
  local updates = cjson.decode(updateJson)
  for k, v in pairs(updates) do
    merged[k] = v
  end
  merged['_updated_at'] = ts
  redis.call('HSET', key, nodeId, cjson.encode(merged))
end
redis.call('SADD', dirtyKey, canvasId)
return 1
`;

export async function setNodes(canvasId: string, updates: RedisNodeUpdate[]): Promise<void> {
  if (!redisClient) return;
  const key = canvasKey(canvasId);

  const coalesced = new Map<string, RedisNodeUpdate>();
  for (const update of updates) {
    const existing = coalesced.get(update.id);
    if (existing) {
      coalesced.set(update.id, { ...existing, ...update });
    } else {
      coalesced.set(update.id, { ...update });
    }
  }

  if (coalesced.size === 0) return;

  const args: string[] = [canvasId, new Date().toISOString()];
  for (const [nodeId, update] of coalesced) {
    args.push(nodeId, JSON.stringify(update));
  }
  await redisClient.eval(SET_NODES_LUA, 2, key, DIRTY_SET_KEY, ...args);
}

export async function getCanvas(canvasId: string): Promise<Record<string, unknown>[] | null> {
  if (!redisClient) return null;
  const raw = await redisClient.hgetall(canvasKey(canvasId));
  if (!raw || Object.keys(raw).length === 0) return null;
  return Object.values(raw).map((v) => JSON.parse(v));
}

export async function evictNode(canvasId: string, nodeId: string): Promise<void> {
  if (!redisClient) return;
  const pipeline = redisClient.pipeline();
  pipeline.hdel(canvasKey(canvasId), nodeId);
  pipeline.sadd(DIRTY_SET_KEY, canvasId);
  const results = await pipeline.exec();
  if (results) {
    const failed = results.filter(([err]) => err !== null);
    if (failed.length > 0) {
      console.error("[redis] evictNode pipeline failures:", failed.map(([err]) => err));
    }
  }
}

export async function evictCanvas(canvasId: string): Promise<void> {
  if (!redisClient) return;
  const pipeline = redisClient.pipeline();
  pipeline.del(canvasKey(canvasId));
  pipeline.srem(DIRTY_SET_KEY, canvasId);
  const results = await pipeline.exec();
  if (results) {
    const failed = results.filter(([err]) => err !== null);
    if (failed.length > 0) {
      console.error("[redis] evictCanvas pipeline failures:", failed.map(([err]) => err));
    }
  }
}

const SPOP_BATCH_LUA = `
local result = {}
local count = tonumber(ARGV[1])
for i = 1, count do
  local v = redis.call('SPOP', KEYS[1])
  if v then
    result[i] = v
  else
    break
  end
end
return result
`;

export async function getDirtyCanvases(): Promise<string[]> {
  if (!redisClient) return [];
  const size = await redisClient.scard(DIRTY_SET_KEY);
  if (size === 0) return [];
  const members = await redisClient.eval(SPOP_BATCH_LUA, 1, DIRTY_SET_KEY, String(size)) as string[];
  return members ?? [];
}

export async function reAddDirtyCanvases(canvasIds: string[]): Promise<void> {
  if (!redisClient || canvasIds.length === 0) return;
  await redisClient.sadd(DIRTY_SET_KEY, ...canvasIds);
}

export async function isCanvasWarm(canvasId: string): Promise<boolean> {
  if (!redisClient) return false;
  const exists = await redisClient.exists(canvasKey(canvasId));
  return exists > 0;
}

const WARM_CANVAS_LUA = `
local key = KEYS[1]
for i = 1, #ARGV, 2 do
  redis.call('HSETNX', key, ARGV[i], ARGV[i+1])
end
return 1
`;

export async function warmCanvas(canvasId: string, nodes: Record<string, unknown>[]): Promise<void> {
  if (!redisClient || nodes.length === 0) return;
  const key = canvasKey(canvasId);
  const args: string[] = [];
  for (const node of nodes) {
    const id = node.id as string;
    args.push(id, JSON.stringify(node));
  }
  await redisClient.eval(WARM_CANVAS_LUA, 1, key, ...args);
}

/**
 * Directly upsert canvas node updates into Postgres using a partial
 * INSERT ... ON CONFLICT DO UPDATE. Null fields in the payload leave the
 * existing Postgres value untouched (COALESCE guard). This is the single
 * direct-write path for committed mutations — it bypasses the 30-second
 * checkpoint and makes Postgres the authoritative source of truth immediately.
 */
export async function upsertNodesPostgres(canvasId: string, updates: RedisNodeUpdate[]): Promise<void> {
  if (updates.length === 0) return;

  const allIds = updates.map((n) => n.id).filter(Boolean);
  if (allIds.length > 0) {
    await pool.query(
      `DELETE FROM canvas_node_tombstones WHERE canvas_id = $1 AND node_id = ANY($2::uuid[])`,
      [canvasId, allIds]
    ).catch((err) => {
      console.error("[upsertNodesPostgres] Failed to clear tombstones:", err);
    });
  }
  const filtered = updates;

  const fullNodes: RedisNodeUpdate[] = [];
  const partialNodes: RedisNodeUpdate[] = [];

  for (const node of filtered) {
    const hasAllRequired =
      node.node_type !== undefined && node.node_type !== null &&
      node.x !== undefined && node.x !== null &&
      node.y !== undefined && node.y !== null &&
      node.width !== undefined && node.width !== null &&
      node.height !== undefined && node.height !== null &&
      node.rotation !== undefined && node.rotation !== null;
    if (hasAllRequired) {
      fullNodes.push(node);
    } else {
      partialNodes.push(node);
    }
  }

  // --- Full nodes: batch INSERT ... ON CONFLICT DO UPDATE ---
  if (fullNodes.length > 0) {
    const rowPlaceholders: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    for (const node of fullNodes) {
      const batchSrc = (typeof node.src === "string" && (node.src as string).startsWith("blob:"))
        ? null
        : (node.src !== undefined ? (node.src as string | null) : null);
      const metadata = node.metadata !== undefined ? JSON.stringify(node.metadata) : null;

      rowPlaceholders.push(
        `($${idx++}::uuid, $${idx++}::uuid, $${idx++}::text, $${idx++}::float8, $${idx++}::float8, $${idx++}::float8, $${idx++}::float8, $${idx++}::float8, $${idx++}::int, $${idx++}::boolean, $${idx++}::boolean, $${idx++}::text, $${idx++}::text, $${idx++}::text, $${idx++}::jsonb, $${idx++}::uuid, $${idx++}::uuid)`
      );
      values.push(
        node.id,
        canvasId,
        node.node_type,
        node.x,
        node.y,
        node.width,
        node.height,
        node.rotation,
        node.z_index !== undefined ? node.z_index : 0,
        node.locked !== undefined ? node.locked : false,
        node.visible !== undefined ? node.visible : true,
        node.label !== undefined ? (node.label as string | null) : null,
        batchSrc,
        node.gradient !== undefined ? (node.gradient as string | null) : null,
        metadata,
        node.asset_id !== undefined ? node.asset_id : null,
        node.job_id !== undefined ? node.job_id : null
      );
    }

    await pool.query(
      `INSERT INTO canvas_nodes (id, canvas_id, node_type, x, y, width, height, rotation, z_index, locked, visible, label, src, gradient, metadata, asset_id, job_id)
       VALUES ${rowPlaceholders.join(", ")}
       ON CONFLICT (id) DO UPDATE SET
         node_type = COALESCE(EXCLUDED.node_type, canvas_nodes.node_type),
         x = COALESCE(EXCLUDED.x, canvas_nodes.x),
         y = COALESCE(EXCLUDED.y, canvas_nodes.y),
         width = COALESCE(EXCLUDED.width, canvas_nodes.width),
         height = COALESCE(EXCLUDED.height, canvas_nodes.height),
         rotation = COALESCE(EXCLUDED.rotation, canvas_nodes.rotation),
         z_index = COALESCE(EXCLUDED.z_index, canvas_nodes.z_index),
         locked = COALESCE(EXCLUDED.locked, canvas_nodes.locked),
         visible = COALESCE(EXCLUDED.visible, canvas_nodes.visible),
         label = COALESCE(EXCLUDED.label, canvas_nodes.label),
         src = COALESCE(EXCLUDED.src, canvas_nodes.src),
         gradient = COALESCE(EXCLUDED.gradient, canvas_nodes.gradient),
         metadata = COALESCE(EXCLUDED.metadata, canvas_nodes.metadata),
         asset_id = COALESCE(EXCLUDED.asset_id, canvas_nodes.asset_id),
         job_id = COALESCE(EXCLUDED.job_id, canvas_nodes.job_id),
         updated_at = NOW()`,
      values
    );
  }

  // --- Partial nodes: UPDATE-only, COALESCE preserves existing values ---
  // Never INSERT — these nodes lack required NOT NULL geometry. If the node exists
  // in Postgres, only the provided fields are updated. If it does not exist (orphan),
  // the UPDATE matches 0 rows and is a safe no-op.
  for (const node of partialNodes) {
    const batchSrc = (typeof node.src === "string" && (node.src as string).startsWith("blob:"))
      ? null
      : (node.src !== undefined ? (node.src as string | null) : null);
    const metadata = node.metadata !== undefined ? JSON.stringify(node.metadata) : null;

    await pool.query(
      `UPDATE canvas_nodes SET
         node_type = COALESCE($1::text, node_type),
         x = COALESCE($2::float8, x),
         y = COALESCE($3::float8, y),
         width = COALESCE($4::float8, width),
         height = COALESCE($5::float8, height),
         rotation = COALESCE($6::float8, rotation),
         z_index = COALESCE($7::int, z_index),
         locked = COALESCE($8::boolean, locked),
         visible = COALESCE($9::boolean, visible),
         label = COALESCE($10::text, label),
         src = COALESCE($11::text, src),
         gradient = COALESCE($12::text, gradient),
         metadata = COALESCE($13::jsonb, metadata),
         asset_id = COALESCE($14::uuid, asset_id),
         job_id = COALESCE($15::uuid, job_id),
         updated_at = NOW()
       WHERE id = $16::uuid`,
      [
        node.node_type !== undefined ? node.node_type : null,
        node.x !== undefined ? node.x : null,
        node.y !== undefined ? node.y : null,
        node.width !== undefined ? node.width : null,
        node.height !== undefined ? node.height : null,
        node.rotation !== undefined ? node.rotation : null,
        node.z_index !== undefined ? node.z_index : null,
        node.locked !== undefined ? node.locked : null,
        node.visible !== undefined ? node.visible : null,
        node.label !== undefined ? (node.label as string | null) : null,
        batchSrc,
        node.gradient !== undefined ? (node.gradient as string | null) : null,
        metadata,
        node.asset_id !== undefined ? node.asset_id : null,
        node.job_id !== undefined ? node.job_id : null,
        node.id,
      ]
    );
  }
}
