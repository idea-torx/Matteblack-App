export type PresenceRole = "owner" | "viewer";

export interface PresenceViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface PresenceCursor {
  x: number;
  y: number;
  viewport?: PresenceViewport;
}

export interface PresenceUser {
  sessionId: string;
  userId: string | null;
  displayName: string;
  avatarUrl: string | null;
  role: PresenceRole;
  color: string;
  joinedAt: number;
  lastCursor: PresenceCursor | null;
  lastCursorAt: number | null;
  idle: boolean;
}

export interface PresenceSelf {
  sessionId: string;
  userId: string | null;
  displayName: string;
  avatarUrl: string | null;
  role: PresenceRole;
  color: string;
  /**
   * Per-session secret issued by the server when the SSE connection is
   * established. The client must echo this token on every cursor POST so
   * that another participant cannot spoof this session's cursor by guessing
   * or reusing the publicly-broadcast sessionId. Never exposed in
   * presence:join / presence:snapshot.users / presence:cursor — only sent
   * to the owning client via presence:snapshot.me.
   */
  bindingToken: string;
}

export interface PresenceSnapshotEvent {
  type: "presence:snapshot";
  canvasId: string;
  me: PresenceSelf;
  users: PresenceUser[];
  timestamp: number;
}

export interface PresenceJoinEvent {
  type: "presence:join";
  canvasId: string;
  user: PresenceUser;
  timestamp: number;
}

export interface PresenceLeaveEvent {
  type: "presence:leave";
  canvasId: string;
  sessionId: string;
  userId: string | null;
  timestamp: number;
}

export interface PresenceCursorEvent {
  type: "presence:cursor";
  canvasId: string;
  sessionId: string;
  userId: string | null;
  x: number;
  y: number;
  viewport?: PresenceViewport;
  timestamp: number;
}

export interface PresenceIdleEvent {
  type: "presence:idle";
  canvasId: string;
  sessionId: string;
  timestamp: number;
}

export interface PresenceActiveEvent {
  type: "presence:active";
  canvasId: string;
  sessionId: string;
  timestamp: number;
}

export type PresenceEvent =
  | PresenceSnapshotEvent
  | PresenceJoinEvent
  | PresenceLeaveEvent
  | PresenceCursorEvent
  | PresenceIdleEvent
  | PresenceActiveEvent;

export interface CursorPostBody {
  sessionId: string;
  bindingToken: string;
  x: number;
  y: number;
  viewport?: PresenceViewport;
}

export const PRESENCE_IDLE_AFTER_MS = 60_000;
export const PRESENCE_CURSOR_RATE_PER_SEC = 25;
export const PRESENCE_COLOR_PALETTE: readonly string[] = [
  "#6366f1",
  "#ec4899",
  "#f59e0b",
  "#10b981",
  "#3b82f6",
  "#8b5cf6",
  "#ef4444",
  "#14b8a6",
  "#f97316",
  "#06b6d4",
  "#a855f7",
  "#22c55e",
  "#eab308",
  "#0ea5e9",
  "#d946ef",
  "#84cc16",
];
