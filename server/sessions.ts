import express, { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import type { WorkOS } from "@workos-inc/node";
import { createRequire } from "node:module";
import { pool } from "./db.js";
import { LOCAL_MODE, LOCAL_USER_ID } from "./config/runtime.js";

// Type-only import + lazy require: WorkOS is never constructed in local/desktop
// mode, so the `@workos-inc/node` package is never loaded and can be dropped
// from the bundle.
const nodeRequire = createRequire(import.meta.url);

interface AuthRequest extends Request {
  userId?: string;
}

const DEV_AUTH_BYPASS = process.env.NODE_ENV !== "production" && process.env.DEV_AUTH_BYPASS === "true";
const WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID || "";
const WORKOS_COOKIE_PASSWORD = process.env.WORKOS_COOKIE_PASSWORD || "";
// WorkOS is never constructed in local or dev-bypass mode (no API key needed).
const workos: WorkOS = (LOCAL_MODE || DEV_AUTH_BYPASS)
  ? (null as unknown as WorkOS)
  : new (nodeRequire("@workos-inc/node").WorkOS as typeof WorkOS)(process.env.WORKOS_API_KEY, { clientId: WORKOS_CLIENT_ID });
const WOS_COOKIE_NAME = "wos-session";
const DEV_COOKIE_NAME = "dev-session";
const DEV_JWT_SECRET = process.env.DEV_JWT_SECRET || (DEV_AUTH_BYPASS ? "dev-jwt-secret-local-only" : "");

const SESSION_TTL_DAYS = 30;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const REVALIDATION_WINDOW_MS = 5 * 60 * 1000;

const refreshMutex = new Map<string, Promise<{ sealedSession?: string; failed: boolean; transient?: boolean }>>();
const refreshCache = new Map<string, { result: { sealedSession?: string; failed: boolean; transient?: boolean }; expires: number }>();
const REFRESH_CACHE_TTL_MS = 5000;

const SESSION_MEMORY_CACHE = new Map<string, { userId: string; workosUserId?: string; expires: number }>();
const SESSION_MEMORY_CACHE_TTL_MS = 25_000;

function getSessionFromMemoryCache(cookieHash: string): { userId: string; workosUserId?: string } | null {
  const entry = SESSION_MEMORY_CACHE.get(cookieHash);
  if (!entry) return null;
  if (entry.expires <= Date.now()) {
    SESSION_MEMORY_CACHE.delete(cookieHash);
    return null;
  }
  return { userId: entry.userId, workosUserId: entry.workosUserId };
}

function setSessionInMemoryCache(cookieHash: string, userId: string, workosUserId?: string): void {
  SESSION_MEMORY_CACHE.set(cookieHash, { userId, workosUserId, expires: Date.now() + SESSION_MEMORY_CACHE_TTL_MS });
  if (SESSION_MEMORY_CACHE.size > 2000) {
    const now = Date.now();
    for (const [key, entry] of SESSION_MEMORY_CACHE) {
      if (entry.expires <= now) SESSION_MEMORY_CACHE.delete(key);
    }
  }
}

function evictSessionFromMemoryCache(cookieHash: string): void {
  SESSION_MEMORY_CACHE.delete(cookieHash);
}

function sessionLog(event: string, details: Record<string, unknown>) {
  const safe: Record<string, unknown> = { event };
  if (details.sessionId) safe.sessionId = details.sessionId;
  if (details.userId) safe.userId = details.userId;
  if (details.workosUserId) safe.workosUserId = details.workosUserId;
  if (details.reason) safe.reason = details.reason;
  if (details.error) safe.error = details.error;
  if (details.attempt) safe.attempt = details.attempt;
  if (details.transient !== undefined) safe.transient = details.transient;
  if (details.message) safe.message = details.message;
  console.log(`[session] ${event}`, JSON.stringify(safe));
}

export function isTransientError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes("timeout") || msg.includes("timed out") || msg.includes("econnreset") || msg.includes("econnrefused") ||
        msg.includes("network") || msg.includes("socket") || msg.includes("etimedout") ||
        msg.includes("enotfound") || msg.includes("fetch failed") ||
        msg.includes("terminated unexpectedly") || msg.includes("connection refused") ||
        msg.includes("connection reset") || msg.includes("connection closed") ||
        msg.includes("connection lost")) {
      return true;
    }
  }
  if (err && typeof err === "object" && "status" in err) {
    const status = (err as { status: number }).status;
    if (status >= 500) return true;
  }
  return false;
}

export function isPermanentAuthError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes("invalid") || msg.includes("revoked") ||
        msg.includes("unauthorized") || msg.includes("forbidden") || msg.includes("malformed") ||
        msg.includes("corrupted") || msg.includes("seal")) {
      return true;
    }
  }
  if (err && typeof err === "object" && "status" in err) {
    const status = (err as { status: number }).status;
    if (status === 401 || status === 403) return true;
  }
  return false;
}

function hashCookie(cookieValue: string): string {
  return crypto.createHash("sha256").update(cookieValue).digest("hex");
}

export async function createSession(userId: string, workosUserId: string | null, cookieValue: string): Promise<string> {
  const cookieHash = hashCookie(cookieValue);
  const result = await pool.query(
    `INSERT INTO sessions (user_id, workos_user_id, cookie_hash, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '${SESSION_TTL_DAYS} days')
     RETURNING id`,
    [userId, workosUserId, cookieHash]
  );
  const sessionId = result.rows[0].id;
  sessionLog("created", { sessionId, userId, workosUserId });
  return sessionId;
}

export async function validateSessionByCookie(cookieValue: string): Promise<{ sessionId: string; userId: string; workosUserId: string | null; lastVerifiedAt: Date } | null> {
  const cookieHash = hashCookie(cookieValue);
  const result = await pool.query(
    `SELECT id, user_id, workos_user_id, last_verified_at FROM sessions
     WHERE cookie_hash = $1 AND is_valid = true AND expires_at > NOW()
     ORDER BY created_at DESC LIMIT 1`,
    [cookieHash]
  );
  if (result.rows.length === 0) return null;
  return {
    sessionId: result.rows[0].id,
    userId: result.rows[0].user_id,
    workosUserId: result.rows[0].workos_user_id,
    lastVerifiedAt: new Date(result.rows[0].last_verified_at),
  };
}

export async function refreshSessionByCookie(oldCookieValue: string, newCookieValue: string): Promise<void> {
  const oldHash = hashCookie(oldCookieValue);
  const newHash = hashCookie(newCookieValue);
  await pool.query(
    `UPDATE sessions SET cookie_hash = $1, expires_at = NOW() + INTERVAL '${SESSION_TTL_DAYS} days'
     WHERE cookie_hash = $2 AND is_valid = true`,
    [newHash, oldHash]
  );
  sessionLog("refreshed", { message: "session cookie rotated" });
}

export async function invalidateSessionByCookie(cookieValue: string): Promise<void> {
  const cookieHash = hashCookie(cookieValue);
  evictSessionFromMemoryCache(cookieHash);
  await pool.query(
    `UPDATE sessions SET is_valid = false WHERE cookie_hash = $1 AND is_valid = true`,
    [cookieHash]
  );
  sessionLog("invalidated_by_cookie", { message: "session invalidated via cookie hash" });
}

export async function markSessionVerified(sessionId: string): Promise<void> {
  await pool.query(
    `UPDATE sessions SET last_verified_at = NOW() WHERE id = $1 AND is_valid = true`,
    [sessionId]
  );
}

export async function invalidateSession(sessionId: string): Promise<void> {
  await pool.query(
    `UPDATE sessions SET is_valid = false WHERE id = $1`,
    [sessionId]
  );
  sessionLog("invalidated", { sessionId });
}

export async function invalidateUserSessions(userId: string): Promise<number> {
  const result = await pool.query(
    `UPDATE sessions SET is_valid = false WHERE user_id = $1 AND is_valid = true RETURNING id`,
    [userId]
  );
  const count = result.rowCount ?? 0;
  sessionLog("invalidated_all", { userId, message: `${count} sessions invalidated` });
  return count;
}

export async function cleanupExpiredSessions(): Promise<number> {
  const result = await pool.query(
    `DELETE FROM sessions WHERE expires_at < NOW() OR (is_valid = false AND updated_at < NOW() - INTERVAL '7 days')`
  );
  const count = result.rowCount ?? 0;
  if (count > 0) {
    sessionLog("cleanup", { message: `${count} expired/invalid sessions removed` });
  }
  return count;
}

export async function refreshSessionWithRetry(
  session: ReturnType<typeof workos.userManagement.loadSealedSession>,
  sessionKey: string
): Promise<{ sealedSession?: string; failed: boolean; transient?: boolean }> {
  const cached = refreshCache.get(sessionKey);
  if (cached && cached.expires > Date.now()) {
    return cached.result;
  }

  const existing = refreshMutex.get(sessionKey);
  if (existing) return existing;

  const doRefresh = async (): Promise<{ sealedSession?: string; failed: boolean; transient?: boolean }> => {
    const MAX_RETRIES = 2;
    let lastWasTransient = false;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const refreshResult = await session.refresh();
        if (refreshResult.authenticated && refreshResult.sealedSession) {
          sessionLog("refresh_success", { sessionKey: sessionKey.slice(0, 8), message: "new sealed session" });
          return { sealedSession: refreshResult.sealedSession, failed: false };
        }
        if (refreshResult.authenticated) {
          sessionLog("refresh_success", { sessionKey: sessionKey.slice(0, 8), message: "authenticated without new session" });
          return { failed: false };
        }
        sessionLog("refresh_unauthenticated", { sessionKey: sessionKey.slice(0, 8), reason: refreshResult.reason });
        return { failed: true };
      } catch (err) {
        lastWasTransient = isTransientError(err);
        sessionLog("refresh_attempt_failed", {
          sessionKey: sessionKey.slice(0, 8),
          attempt: `${attempt + 1}/${MAX_RETRIES + 1}`,
          transient: lastWasTransient,
          error: err instanceof Error ? err.message : String(err),
        });

        if (!lastWasTransient || attempt === MAX_RETRIES) {
          return { failed: true, transient: lastWasTransient };
        }
        await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
    return { failed: true, transient: lastWasTransient };
  };

  const promise = doRefresh().then((result) => {
    if (!result.failed) {
      refreshCache.set(sessionKey, { result, expires: Date.now() + REFRESH_CACHE_TTL_MS });
      if (refreshCache.size > 1000) {
        const now = Date.now();
        for (const [key, entry] of refreshCache) {
          if (entry.expires <= now) refreshCache.delete(key);
        }
      }
    }
    return result;
  }).finally(() => {
    refreshMutex.delete(sessionKey);
  });
  refreshMutex.set(sessionKey, promise);
  return promise;
}

async function verifyWithWorkOS(
  sessionCookie: string,
  sessionKey: string,
  res?: express.Response,
): Promise<{ userId: string; workosUserId: string; currentCookie: string } | { failed: true; sessionExpired?: boolean; transient?: boolean } | null> {
  const session = workos.userManagement.loadSealedSession({
    sessionData: sessionCookie,
    cookiePassword: WORKOS_COOKIE_PASSWORD,
  });
  let result = await session.authenticate();
  let currentCookie = sessionCookie;

  if (!result.authenticated && (result.reason === "invalid_jwt" || result.reason === "invalid_session_cookie")) {
    const initialReason = result.reason;
    sessionLog("refresh_attempt", { sessionKey: sessionKey.slice(0, 8), reason: initialReason });
    const refreshOutcome = await refreshSessionWithRetry(session, sessionKey);

    if (refreshOutcome.sealedSession) {
      currentCookie = refreshOutcome.sealedSession;
      if (res) {
        res.cookie(WOS_COOKIE_NAME, currentCookie, {
          httpOnly: true,
          secure: true,
          sameSite: "lax",
          maxAge: 400 * 24 * 60 * 60 * 1000,
          path: "/",
        });
      }
      result = await workos.userManagement.loadSealedSession({
        sessionData: currentCookie,
        cookiePassword: WORKOS_COOKIE_PASSWORD,
      }).authenticate();
    } else if (!refreshOutcome.failed) {
      try {
        result = await session.authenticate();
      } catch {
        sessionLog("reauth_failed", { sessionKey: sessionKey.slice(0, 8) });
        return null;
      }
    } else if (refreshOutcome.transient || initialReason === "invalid_jwt") {
      sessionLog("refresh_transient_failure", { sessionKey: sessionKey.slice(0, 8), reason: initialReason });
      return { failed: true, transient: true };
    } else {
      sessionLog("refresh_permanent_failure", { sessionKey: sessionKey.slice(0, 8) });
      await invalidateSessionByCookie(sessionCookie).catch(() => {});
      if (res) {
        res.clearCookie(WOS_COOKIE_NAME, { path: "/" });
      }
      return { failed: true, sessionExpired: true };
    }
  }

  if (!result.authenticated) {
    const permanentReasons = ["session_revoked", "no_session_found"];
    if (result.reason === "invalid_jwt" || result.reason === "invalid_session_cookie") {
      sessionLog("refresh_transient_failure", { sessionKey: sessionKey.slice(0, 8), reason: result.reason });
      return { failed: true, transient: true };
    }
    if (!permanentReasons.includes(result.reason ?? "")) {
      return null;
    }
    await invalidateSessionByCookie(sessionCookie).catch(() => {});
    if (res) {
      res.clearCookie(WOS_COOKIE_NAME, { path: "/" });
    }
    return { failed: true, sessionExpired: true };
  }

  const workosUserId = result.user.id;

  const byWorkosId = await pool.query(
    "SELECT id FROM users WHERE workos_user_id = $1",
    [workosUserId]
  );
  if (byWorkosId.rows.length > 0) {
    return { userId: byWorkosId.rows[0].id, workosUserId, currentCookie };
  }

  return null;
}

export async function getLocalUserFromSession(req: express.Request, res?: express.Response): Promise<{ userId: string; workosUserId?: string; sessionExpired?: boolean; transient?: boolean } | null> {
  // Login-less local desktop build: every request is the single local user.
  // No cookies, no WorkOS, no DB session lookup — the user row is seeded at
  // startup (see ensureLocalUser in index.ts).
  if (LOCAL_MODE) {
    return { userId: LOCAL_USER_ID };
  }
  if (DEV_AUTH_BYPASS) {
    const devCookie = req.cookies?.[DEV_COOKIE_NAME];
    if (!devCookie) return null;
    try {
      const payload = jwt.verify(devCookie, DEV_JWT_SECRET) as { userId: string };
      if (payload.userId) {
        return { userId: payload.userId };
      }
    } catch {
    }
    return null;
  }

  const sessionCookie = req.cookies?.[WOS_COOKIE_NAME];
  if (!sessionCookie) return null;

  const cookieHash = hashCookie(sessionCookie);
  const sessionKey = cookieHash.slice(0, 32);

  const memoryCached = getSessionFromMemoryCache(cookieHash);
  if (memoryCached) {
    return { userId: memoryCached.userId, workosUserId: memoryCached.workosUserId };
  }

  try {
    const dbSession = await validateSessionByCookie(sessionCookie);

    if (dbSession) {
      const timeSinceVerify = Date.now() - dbSession.lastVerifiedAt.getTime();
      if (timeSinceVerify < REVALIDATION_WINDOW_MS) {
        setSessionInMemoryCache(cookieHash, dbSession.userId, dbSession.workosUserId ?? undefined);
        return { userId: dbSession.userId, workosUserId: dbSession.workosUserId ?? undefined };
      }

      sessionLog("db_revalidation", { sessionId: dbSession.sessionId, userId: dbSession.userId, message: "revalidation window expired, re-verifying with WorkOS" });
      const workosResult = await verifyWithWorkOS(sessionCookie, sessionKey, res);

      if (workosResult === null) {
        await invalidateSession(dbSession.sessionId).catch(() => {});
        return null;
      }
      if ("failed" in workosResult) {
        if (workosResult.transient) {
          return { userId: dbSession.userId, workosUserId: dbSession.workosUserId ?? undefined };
        }
        await invalidateSession(dbSession.sessionId).catch(() => {});
        return { userId: "", sessionExpired: workosResult.sessionExpired };
      }

      if (workosResult.currentCookie !== sessionCookie) {
        evictSessionFromMemoryCache(cookieHash);
        await refreshSessionByCookie(sessionCookie, workosResult.currentCookie).catch(() => {});
        const newCookieHash = hashCookie(workosResult.currentCookie);
        setSessionInMemoryCache(newCookieHash, workosResult.userId, workosResult.workosUserId);
      } else {
        await markSessionVerified(dbSession.sessionId).catch(() => {});
        setSessionInMemoryCache(cookieHash, workosResult.userId, workosResult.workosUserId);
      }
      return { userId: workosResult.userId, workosUserId: workosResult.workosUserId };
    }

    const workosResult = await verifyWithWorkOS(sessionCookie, sessionKey, res);

    if (workosResult === null) {
      return null;
    }
    if ("failed" in workosResult) {
      if (workosResult.transient) {
        return { userId: "", transient: true };
      }
      return { userId: "", sessionExpired: workosResult.sessionExpired };
    }

    await createSession(workosResult.userId, workosResult.workosUserId, workosResult.currentCookie).catch(() => {});
    sessionLog("workos_fallback_session_created", { userId: workosResult.userId, workosUserId: workosResult.workosUserId });
    const effectiveCookieHash = workosResult.currentCookie !== sessionCookie ? hashCookie(workosResult.currentCookie) : cookieHash;
    setSessionInMemoryCache(effectiveCookieHash, workosResult.userId, workosResult.workosUserId);
    return { userId: workosResult.userId, workosUserId: workosResult.workosUserId };
  } catch (outerErr) {
    sessionLog("auth_error", {
      sessionKey: sessionKey.slice(0, 8),
      error: outerErr instanceof Error ? outerErr.message : String(outerErr),
      transient: isTransientError(outerErr),
    });
    if (isTransientError(outerErr)) {
      return { userId: "", transient: true };
    }
    if (isPermanentAuthError(outerErr)) {
      await invalidateSessionByCookie(sessionCookie).catch(() => {});
      if (res) {
        res.clearCookie(WOS_COOKIE_NAME, { path: "/" });
      }
      return { userId: "", sessionExpired: true };
    }
    return null;
  }
}

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const result = await getLocalUserFromSession(req, res);
  if (result?.transient) {
    res.set("Retry-After", "2");
    res.status(503).json({ error: "Temporary server error" });
    return;
  }
  if (!result || result.sessionExpired || !result.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  req.userId = result.userId;
  next();
}

export function requireVerifiedEmail(req: AuthRequest, res: Response, next: NextFunction) {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  pool.query("SELECT email_verified FROM users WHERE id = $1", [userId])
    .then((result) => {
      if (result.rows.length === 0) {
        res.status(401).json({ error: "User not found" });
        return;
      }
      if (!result.rows[0].email_verified) {
        sessionLog("unverified_email_blocked", { userId });
        res.status(403).json({ error: "Email not verified" });
        return;
      }
      next();
    })
    .catch(() => {
      res.status(500).json({ error: "Server error" });
    });
}

export async function injectUserId(req: AuthRequest, res: Response, next: NextFunction) {
  const result = await getLocalUserFromSession(req, res);
  if (result) req.userId = result.userId;
  next();
}

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export function startSessionCleanup() {
  cleanupExpiredSessions().catch((err) => {
    console.error("[session] Initial session cleanup failed:", err);
  });

  cleanupTimer = setInterval(() => {
    cleanupExpiredSessions().catch((err) => {
      console.error("[session] Periodic session cleanup failed:", err);
    });
  }, CLEANUP_INTERVAL_MS);
  // Don't keep the event loop alive solely for this timer — sessions are
  // Postgres-backed, so missing a cleanup tick during idle is harmless and
  // it will run again on the next request / cold start.
  if (cleanupTimer && typeof cleanupTimer.unref === "function") cleanupTimer.unref();

  sessionLog("cleanup_started", { intervalMs: CLEANUP_INTERVAL_MS });
}

export function stopSessionCleanup() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

export {
  WOS_COOKIE_NAME,
  DEV_COOKIE_NAME,
  DEV_AUTH_BYPASS,
  DEV_JWT_SECRET,
  WORKOS_CLIENT_ID,
  WORKOS_COOKIE_PASSWORD,
  workos,
};

export type { AuthRequest };
