import type {
  PresenceCursorEvent,
  PresenceEvent,
  PresenceJoinEvent,
  PresenceLeaveEvent,
  PresenceSelf,
  PresenceSnapshotEvent,
  PresenceUser,
  PresenceViewport,
} from "../../../shared/presence.js";

/**
 * Transport adapter for writing SSE messages to the existing canvas SSE
 * client pool. Implemented by `server/routes/canvas.ts` (which owns the
 * `sseClients` map). Kept as a tiny interface so this module has no Express
 * coupling and can be unit-tested with a fake transport.
 */
export interface PresenceSseTransport {
  /** Write a message to every client on a canvas, optionally excluding one session. */
  writeToCanvas(canvasId: string, message: string, excludeSessionId?: string): void;
  /** Write a message to a single session on a canvas. Returns true if delivered. */
  writeToSession(canvasId: string, sessionId: string, message: string): boolean;
}

function encode(event: PresenceEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export function sendPresenceSnapshot(
  transport: PresenceSseTransport,
  canvasId: string,
  me: PresenceSelf,
  users: PresenceUser[]
): boolean {
  const event: PresenceSnapshotEvent = {
    type: "presence:snapshot",
    canvasId,
    me,
    users,
    timestamp: Date.now(),
  };
  return transport.writeToSession(canvasId, me.sessionId, encode(event));
}

export function broadcastPresenceJoin(
  transport: PresenceSseTransport,
  canvasId: string,
  user: PresenceUser,
  excludeSessionId: string
): void {
  const event: PresenceJoinEvent = {
    type: "presence:join",
    canvasId,
    user,
    timestamp: Date.now(),
  };
  transport.writeToCanvas(canvasId, encode(event), excludeSessionId);
}

export function broadcastPresenceLeave(
  transport: PresenceSseTransport,
  canvasId: string,
  sessionId: string,
  userId: string | null,
  excludeSessionId?: string
): void {
  const event: PresenceLeaveEvent = {
    type: "presence:leave",
    canvasId,
    sessionId,
    userId,
    timestamp: Date.now(),
  };
  transport.writeToCanvas(canvasId, encode(event), excludeSessionId);
}

export function broadcastPresenceCursor(
  transport: PresenceSseTransport,
  canvasId: string,
  params: {
    sessionId: string;
    userId: string | null;
    x: number;
    y: number;
    viewport?: PresenceViewport;
  }
): void {
  const event: PresenceCursorEvent = {
    type: "presence:cursor",
    canvasId,
    sessionId: params.sessionId,
    userId: params.userId,
    x: params.x,
    y: params.y,
    viewport: params.viewport,
    timestamp: Date.now(),
  };
  transport.writeToCanvas(canvasId, encode(event), params.sessionId);
}

export function broadcastPresenceIdle(
  transport: PresenceSseTransport,
  canvasId: string,
  sessionId: string
): void {
  transport.writeToCanvas(
    canvasId,
    encode({ type: "presence:idle", canvasId, sessionId, timestamp: Date.now() }),
    sessionId
  );
}

export function broadcastPresenceActive(
  transport: PresenceSseTransport,
  canvasId: string,
  sessionId: string
): void {
  transport.writeToCanvas(
    canvasId,
    encode({ type: "presence:active", canvasId, sessionId, timestamp: Date.now() }),
    sessionId
  );
}
