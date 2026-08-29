import {
  PRESENCE_COLOR_PALETTE,
  PRESENCE_IDLE_AFTER_MS,
  type PresenceCursor,
  type PresenceRole,
  type PresenceUser,
  type PresenceViewport,
} from "../../../shared/presence.js";

export interface PresenceSessionInput {
  sessionId: string;
  userId: string | null;
  displayName: string;
  avatarUrl: string | null;
  role: PresenceRole;
  /**
   * Server-issued secret bound to this presence session. Stored privately;
   * never leaked in snapshot/join/cursor broadcasts. Used to verify that a
   * cursor POST actually originates from the owning SSE connection.
   */
  bindingToken: string;
}

export interface AddSessionResult {
  user: PresenceUser;
  snapshot: PresenceUser[];
  evicted: PresenceUser[];
}

interface InternalEntry {
  user: PresenceUser;
  bindingToken: string;
}

export interface SetCursorResult {
  user: PresenceUser;
  wasIdle: boolean;
}

const canvasSessions = new Map<string, Map<string, InternalEntry>>();

export function colorFromUserId(userId: string | null, fallbackKey: string): string {
  const key = userId && userId.length > 0 ? userId : `guest:${fallbackKey}`;
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  const index = Math.abs(hash) % PRESENCE_COLOR_PALETTE.length;
  return PRESENCE_COLOR_PALETTE[index];
}

function getCanvasMap(canvasId: string): Map<string, InternalEntry> {
  let bucket = canvasSessions.get(canvasId);
  if (!bucket) {
    bucket = new Map();
    canvasSessions.set(canvasId, bucket);
  }
  return bucket;
}

function dropCanvasIfEmpty(canvasId: string): void {
  const bucket = canvasSessions.get(canvasId);
  if (bucket && bucket.size === 0) {
    canvasSessions.delete(canvasId);
  }
}

export function addSession(canvasId: string, input: PresenceSessionInput): AddSessionResult {
  const bucket = getCanvasMap(canvasId);
  const evicted: PresenceUser[] = [];

  const existing = bucket.get(input.sessionId);
  if (existing) {
    bucket.delete(input.sessionId);
    evicted.push(existing.user);
  }

  const user: PresenceUser = {
    sessionId: input.sessionId,
    userId: input.userId,
    displayName: input.displayName || (input.userId ? "Member" : "Guest"),
    avatarUrl: input.avatarUrl ?? null,
    role: input.role,
    color: colorFromUserId(input.userId, input.sessionId),
    joinedAt: Date.now(),
    lastCursor: null,
    lastCursorAt: null,
    idle: false,
  };

  const snapshot: PresenceUser[] = [];
  for (const entry of bucket.values()) snapshot.push(entry.user);

  bucket.set(input.sessionId, { user, bindingToken: input.bindingToken });
  return { user, snapshot, evicted };
}

export function removeSession(canvasId: string, sessionId: string): PresenceUser | null {
  const bucket = canvasSessions.get(canvasId);
  if (!bucket) return null;
  const entry = bucket.get(sessionId) ?? null;
  if (entry) {
    bucket.delete(sessionId);
    dropCanvasIfEmpty(canvasId);
    return entry.user;
  }
  return null;
}

export function getSession(canvasId: string, sessionId: string): PresenceUser | null {
  return canvasSessions.get(canvasId)?.get(sessionId)?.user ?? null;
}

/**
 * Returns the private binding token for the given session, or null if the
 * session is not registered. Used by the cursor endpoint to verify that the
 * caller actually owns the SSE connection associated with `sessionId`.
 */
export function getBindingToken(canvasId: string, sessionId: string): string | null {
  return canvasSessions.get(canvasId)?.get(sessionId)?.bindingToken ?? null;
}

export function getSnapshot(canvasId: string, excludeSessionId?: string): PresenceUser[] {
  const bucket = canvasSessions.get(canvasId);
  if (!bucket) return [];
  const out: PresenceUser[] = [];
  for (const entry of bucket.values()) {
    if (excludeSessionId && entry.user.sessionId === excludeSessionId) continue;
    out.push(entry.user);
  }
  return out;
}

export function setCursor(
  canvasId: string,
  sessionId: string,
  x: number,
  y: number,
  viewport?: PresenceViewport
): SetCursorResult | null {
  const entry = canvasSessions.get(canvasId)?.get(sessionId);
  if (!entry) return null;
  const user = entry.user;
  const wasIdle = user.idle;
  const cursor: PresenceCursor = viewport ? { x, y, viewport } : { x, y };
  user.lastCursor = cursor;
  user.lastCursorAt = Date.now();
  user.idle = false;
  return { user, wasIdle };
}

export interface IdleTransition {
  canvasId: string;
  sessionId: string;
}

export function sweepIdle(now: number = Date.now()): IdleTransition[] {
  const newlyIdle: IdleTransition[] = [];
  for (const [canvasId, bucket] of canvasSessions) {
    for (const entry of bucket.values()) {
      const user = entry.user;
      if (user.idle) continue;
      const last = user.lastCursorAt ?? user.joinedAt;
      if (now - last > PRESENCE_IDLE_AFTER_MS) {
        user.idle = true;
        newlyIdle.push({ canvasId, sessionId: user.sessionId });
      }
    }
  }
  return newlyIdle;
}

export function getActiveCanvasIds(): string[] {
  return Array.from(canvasSessions.keys());
}

export function clearAll(): void {
  canvasSessions.clear();
}
