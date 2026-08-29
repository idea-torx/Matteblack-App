import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { PresenceSelf, PresenceUser } from "./types";

export interface RemoteCursorSample {
  x: number;
  y: number;
  receivedAt: number;
}

export interface RemoteSession {
  sessionId: string;
  userId: string | null;
  displayName: string;
  avatarUrl: string | null;
  color: string;
  role: PresenceUser["role"];
  idle: boolean;
  joinedAt: number;
  lastCursor: RemoteCursorSample | null;
  /** Previous sample, kept for client-side interpolation. */
  prevCursor: RemoteCursorSample | null;
}

interface PresenceStateShape {
  canvasId: string | null;
  selfSessionId: string | null;
  bindingToken: string | null;
  self: PresenceSelf | null;
  /** Other sessions on the canvas, keyed by sessionId. Excludes self. */
  sessions: Map<string, RemoteSession>;

  reset: (canvasId: string | null) => void;
  applySnapshot: (canvasId: string, me: PresenceSelf, users: PresenceUser[]) => void;
  applyJoin: (canvasId: string, user: PresenceUser) => void;
  applyLeave: (canvasId: string, sessionId: string) => void;
  applyCursor: (
    canvasId: string,
    sessionId: string,
    x: number,
    y: number,
    receivedAt: number,
  ) => void;
  applyIdle: (canvasId: string, sessionId: string, idle: boolean) => void;
}

function fromUser(user: PresenceUser, prev?: RemoteSession): RemoteSession {
  const lastCursor = user.lastCursor && user.lastCursorAt
    ? { x: user.lastCursor.x, y: user.lastCursor.y, receivedAt: user.lastCursorAt }
    : null;
  return {
    sessionId: user.sessionId,
    userId: user.userId,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    color: user.color,
    role: user.role,
    idle: user.idle,
    joinedAt: user.joinedAt,
    lastCursor: lastCursor ?? prev?.lastCursor ?? null,
    prevCursor: prev?.lastCursor ?? null,
  };
}

export const usePresenceStore = create<PresenceStateShape>((set) => ({
  canvasId: null,
  selfSessionId: null,
  bindingToken: null,
  self: null,
  sessions: new Map(),

  reset(canvasId) {
    set(() => ({
      canvasId,
      selfSessionId: null,
      bindingToken: null,
      self: null,
      sessions: new Map(),
    }));
  },

  applySnapshot(canvasId, me, users) {
    set(() => {
      const next = new Map<string, RemoteSession>();
      for (const u of users) {
        if (u.sessionId === me.sessionId) continue;
        next.set(u.sessionId, fromUser(u));
      }
      return {
        canvasId,
        selfSessionId: me.sessionId,
        bindingToken: me.bindingToken,
        self: me,
        sessions: next,
      };
    });
  },

  applyJoin(canvasId, user) {
    set((state) => {
      if (state.canvasId !== canvasId) return state;
      if (state.selfSessionId === user.sessionId) return state;
      if (state.sessions.has(user.sessionId)) return state;
      const next = new Map(state.sessions);
      next.set(user.sessionId, fromUser(user));
      return { sessions: next };
    });
  },

  applyLeave(canvasId, sessionId) {
    set((state) => {
      if (state.canvasId !== canvasId) return state;
      if (!state.sessions.has(sessionId)) return state;
      const next = new Map(state.sessions);
      next.delete(sessionId);
      return { sessions: next };
    });
  },

  applyCursor(canvasId, sessionId, x, y, receivedAt) {
    set((state) => {
      if (state.canvasId !== canvasId) return state;
      if (state.selfSessionId === sessionId) return state;
      const existing = state.sessions.get(sessionId);
      if (!existing) return state;
      const next = new Map(state.sessions);
      next.set(sessionId, {
        ...existing,
        idle: false,
        prevCursor: existing.lastCursor,
        lastCursor: { x, y, receivedAt },
      });
      return { sessions: next };
    });
  },

  applyIdle(canvasId, sessionId, idle) {
    set((state) => {
      if (state.canvasId !== canvasId) return state;
      const existing = state.sessions.get(sessionId);
      if (!existing || existing.idle === idle) return state;
      const next = new Map(state.sessions);
      next.set(sessionId, { ...existing, idle });
      return { sessions: next };
    });
  },

}));

/**
 * Stable selector hooks. Components that only need a single session avoid
 * re-rendering when other sessions update.
 *
 * IMPORTANT: any selector that derives a fresh container (Array.from(...),
 * object literal, etc.) MUST be wrapped in `useShallow`. Without it, the
 * selector returns a new reference on every render which makes Zustand's
 * underlying useSyncExternalStore see a "changed snapshot", triggering an
 * infinite re-render loop ("getSnapshot should be cached" warning).
 * `useRemoteSession` is safe as-is because it returns the stored object
 * by identity (or null), not a new container.
 */
export const useRemoteSessions = (): RemoteSession[] =>
  usePresenceStore(useShallow((s) => Array.from(s.sessions.values())));

export const useRemoteSession = (sessionId: string | null): RemoteSession | null =>
  usePresenceStore((s) => (sessionId ? s.sessions.get(sessionId) ?? null : null));

export const usePresenceBinding = (): { sessionId: string | null; bindingToken: string | null } =>
  usePresenceStore(
    useShallow((s) => ({ sessionId: s.selfSessionId, bindingToken: s.bindingToken })),
  );
