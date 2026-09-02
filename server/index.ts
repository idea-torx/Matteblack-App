import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import jwt from "jsonwebtoken";
import { pool, initDB } from "./db.js";
import redisClient from "./services/redisClient.js";
import { getDirtyCanvases, getCanvas as getCanvasFromRedis, reAddDirtyCanvases, evictCanvas, setNodes as redisSetNodes, evictNode as redisEvictNode, type RedisNodeUpdate } from "./services/canvasRedisCache.js";
import { sendEmailChangeVerification, sendInvitationEmail } from "./email.js";
import platformRoutes from "./routes/platform.js";
import folderRoutes from "./routes/folders.js";
import bucketRoutes from "./routes/buckets.js";
import assetRoutes from "./routes/assets.js";
import audioRoutes from "./routes/audio.js";
import trashRoutes from "./routes/trash.js";
import axiomRoutes from "./routes/axioms.js";
import styleRoutes from "./routes/styles.js";
import canvasRoutes, { broadcastCanvasUpdate, hasAnySseClients, onSseClientConnected, sseEventsHandler, sseSessionActivityMiddleware } from "./routes/canvas.js";
import presenceRoutes from "./routes/presence.js";
import sharingRoutes from "./routes/sharing.js";
import { isSharingV1EnabledForUser } from "./services/projectAccess.js";
import { registerCheckpointFlush, scheduleCanvasFlush, flushCanvasNow } from "./services/canvasCheckpointScheduler.js";
import notificationRoutes from "./routes/notifications.js";
import agentRoutes from "./routes/agent.js";
import operatorRoutes from "./routes/operator.js";
import operatorJobRoutes from "./routes/operatorJobs.js";
import { startScheduler } from "./operator/scheduler.js";
import skillRoutes from "./routes/skills.js";
import customModelRoutes from "./routes/customModels.js";
import setupRoutes from "./routes/setup.js";
import { seedBuiltinSkills } from "./skills/builtin.js";
import githubRoutes from "./routes/github.js";
import agentTimelineRoutes from "./routes/agentTimeline.js";
import cinemaExportRoutes from "./routes/cinemaExport.js";
import agentCutsRoutes from "./routes/agentCuts.js";
import agentRenderRoutes from "./routes/agentRender.js";
import brandIqRoutes from "./routes/brandIq.js";
import { getFileStream, resolveToR2Url, saveFile, rehostExternalUrlToR2, isR2HostedUrl, isLocalUploadsUrl } from "./storage.js";
import { dispatchToFal, resolveModelName, sanitizeUrl, handleFalResult, resumeFalPolling, setFalListenersChecker, isPollingJob, ensureFalConfigured } from "./fal.js";
import { LOCAL_MODE, UPLOADS_DIR, ensureDataDir, MCP_ENDPOINT_PATH } from "./config/runtime.js";
import { setMcpToken } from "./mcpToken.js";
import { estimateFalCost, falPricedModelKeys, falEndpointFor } from "./config/falCost.js";
import { unitPriceFor, falPricingStatus, scheduleFalPricingRefresh } from "./services/falPricing.js";
import fs from "node:fs";
import { getUserConfig, setUserConfig, maskKey, getFalKey, getAnthropicKey } from "./config/userConfig.js";
import { ensureLocalUser } from "./seedLocal.js";
import { createNotification } from "./notifications.js";
import { checkAndDebit, refundCredits, refundCreditsWithFallback, retryPendingRefunds, calculateModelCost } from "./credits/creditGate.js";
import type { PricingParams } from "./credits/creditGate.js";
import adminCreditsRoutes from "./routes/adminCredits.js";
import paymentRoutes, { handleStripeWebhook, backfillPendingPurchases, backfillMissingSubscriptions } from "./routes/payments.js";
import { STRIPE_PUBLISHABLE_KEY as STRIPE_PK, CREDITS_PER_DOLLAR, MIN_PURCHASE_CENTS, MAX_PURCHASE_CENTS, PLAN_CONFIG } from "./stripe.js";
import { fal } from "@fal-ai/client";
import probe from "probe-image-size";
import multer from "multer";
import {
  requireAuth, requireVerifiedEmail, injectUserId, getLocalUserFromSession,
  isTransientError, isPermanentAuthError,
  createSession, invalidateUserSessions, invalidateSessionByCookie, startSessionCleanup,
  WOS_COOKIE_NAME, DEV_COOKIE_NAME, DEV_AUTH_BYPASS, DEV_JWT_SECRET,
  WORKOS_CLIENT_ID, WORKOS_COOKIE_PASSWORD, workos,
  type AuthRequest,
} from "./sessions.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001;


app.use(cors({ origin: true, credentials: true }));

// The Stripe webhook needs the raw body (mounted before express.json()). In
// LOCAL_MODE there is no Stripe account and no inbound webhooks, so skip it
// entirely rather than register a route that can only 400 on a missing secret.
if (!LOCAL_MODE) {
  app.post("/api/webhooks/stripe", express.raw({ type: "application/json" }), handleStripeWebhook);
}

app.use(express.json({ limit: "50mb" }));
app.use(cookieParser());

const SUPERADMIN_DOMAIN = (process.env.SUPERADMIN_DOMAIN ?? "matteblack.io").toLowerCase().trim();

function isSuperAdminEmail(email: string): boolean {
  if (!SUPERADMIN_DOMAIN) return false;
  return email.toLowerCase().trim().endsWith(`@${SUPERADMIN_DOMAIN}`);
}

const USER_RECORD_CACHE = new Map<string, { user: Record<string, string | boolean | null>; expires: number }>();
const USER_RECORD_CACHE_TTL_MS = 30_000;

function getUserFromCache(userId: string): Record<string, string | boolean | null> | null {
  const entry = USER_RECORD_CACHE.get(userId);
  if (!entry) return null;
  if (entry.expires <= Date.now()) {
    USER_RECORD_CACHE.delete(userId);
    return null;
  }
  return entry.user;
}

function setUserInCache(userId: string, user: Record<string, string | boolean | null>): void {
  USER_RECORD_CACHE.set(userId, { user, expires: Date.now() + USER_RECORD_CACHE_TTL_MS });
  if (USER_RECORD_CACHE.size > 5000) {
    const now = Date.now();
    for (const [key, entry] of USER_RECORD_CACHE) {
      if (entry.expires <= now) USER_RECORD_CACHE.delete(key);
    }
  }
}

function evictUserFromCache(userId: string): void {
  USER_RECORD_CACHE.delete(userId);
}

function mapUser(u: Record<string, string | boolean | null>) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    avatarUrl: u.avatar_url ?? null,
    firstName: u.first_name ?? null,
    lastName: u.last_name ?? null,
    phone: u.phone ?? null,
    dateOfBirth: u.date_of_birth ?? null,
    billingLine1: u.billing_line1 ?? null,
    billingLine2: u.billing_line2 ?? null,
    billingCity: u.billing_city ?? null,
    billingState: u.billing_state ?? null,
    billingZip: u.billing_zip ?? null,
    billingCountry: u.billing_country ?? null,
    role: u.role ?? "user",
    emailVerified: u.email_verified === true,
    tosAcceptedAt: u.tos_accepted_at ?? null,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUUID(value: string): boolean {
  return UUID_RE.test(value);
}

app.get("/api/auth/mode", (_req, res) => {
  // `local` tells the frontend it is running in the login-less desktop build;
  // `devAuth` stays true so no WorkOS sign-in flow is ever initiated.
  res.json({ devAuth: DEV_AUTH_BYPASS || LOCAL_MODE, local: LOCAL_MODE });
});

// --- User-provided API keys (local desktop build) --------------------------
// Keys are stored on the local device (userConfig) and used to call fal.ai /
// Anthropic directly. GET reports only masked status; the real values are
// never returned to the client. In cloud mode these endpoints still work but
// keys usually come from env vars, so they report as env-provided.
function settingsStatus() {
  const cfg = getUserConfig();
  const fal = getFalKey();
  const anthropic = getAnthropicKey();
  return {
    falKey: { set: !!fal, masked: maskKey(fal), source: cfg.falKey ? "local" : (fal ? "env" : null) },
    anthropicKey: { set: !!anthropic, masked: maskKey(anthropic), source: cfg.anthropicKey ? "local" : (anthropic ? "env" : null) },
  };
}

app.get("/api/settings", requireAuth, (_req, res) => {
  res.json(settingsStatus());
});

app.post("/api/settings", requireAuth, (req, res) => {
  const body = (req.body ?? {}) as { falKey?: unknown; anthropicKey?: unknown };
  const patch: { falKey?: string; anthropicKey?: string } = {};
  if (typeof body.falKey === "string") patch.falKey = body.falKey;
  if (typeof body.anthropicKey === "string") patch.anthropicKey = body.anthropicKey;
  setUserConfig(patch);
  if ("falKey" in patch) ensureFalConfigured(); // pick up the new key immediately
  res.json(settingsStatus());
});

if (DEV_AUTH_BYPASS) {
  app.get("/auth/dev-login", async (req, res) => {
    try {
      const email = (req.query.email as string || "").toLowerCase().trim();
      if (!email) {
        res.status(400).json({ error: "Missing email parameter" });
        return;
      }

      const existingUser = await pool.query(
        "SELECT id FROM users WHERE email = $1",
        [email]
      );

      let userId: string;

      if (existingUser.rows.length > 0) {
        userId = existingUser.rows[0].id;
        await pool.query(
          "UPDATE users SET role = 'superadmin', email_verified = true WHERE id = $1",
          [userId]
        );
        evictUserFromCache(userId);
      } else {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const displayName = email.split("@")[0];
          const userResult = await client.query(
            "INSERT INTO users (email, password_hash, display_name, role, email_verified) VALUES ($1, NULL, $2, 'superadmin', true) RETURNING id, display_name",
            [email, displayName]
          );
          const newUser = userResult.rows[0];
          userId = newUser.id;
          const wsResult = await client.query(
            "INSERT INTO workspaces (name, owner_id) VALUES ($1, $2) RETURNING id",
            [`${newUser.display_name}'s Team`, newUser.id]
          );
          await client.query(
            "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
            [wsResult.rows[0].id, newUser.id]
          );
          await client.query(
            "INSERT INTO credits (user_id, balance) VALUES ($1, 0)",
            [newUser.id]
          );
          await client.query("COMMIT");
        } catch (txErr) {
          await client.query("ROLLBACK");
          throw txErr;
        } finally {
          client.release();
        }
      }

      const token = jwt.sign({ userId }, DEV_JWT_SECRET, { expiresIn: "30d" });
      res.cookie(DEV_COOKIE_NAME, token, {
        httpOnly: true,
        secure: false,
        sameSite: "lax",
        maxAge: 30 * 24 * 60 * 60 * 1000,
        path: "/",
      });
      console.log(`[dev-auth] Logged in as ${email} (userId: ${userId})`);
      const rawRedirect = typeof req.query.redirect === "string" ? req.query.redirect : "";
      const safeRedirect = rawRedirect.startsWith("/") && !rawRedirect.startsWith("//") ? rawRedirect : "/";
      res.redirect(safeRedirect);
    } catch (err) {
      console.error("Dev login error:", err);
      res.status(500).json({ error: "Dev login failed" });
    }
  });
}

app.get("/auth/login", (req, res) => {
  const rawRedirect = typeof req.query.redirect === "string" ? req.query.redirect : "";
  const safeRedirect = rawRedirect.startsWith("/") && !rawRedirect.startsWith("//") ? rawRedirect : "";
  if (safeRedirect) {
    res.cookie("post_login_redirect", safeRedirect, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 10 * 60 * 1000,
      path: "/",
    });
  }
  if (DEV_AUTH_BYPASS) {
    res.redirect(`/auth/dev-login?email=dev@localhost.com${safeRedirect ? `&redirect=${encodeURIComponent(safeRedirect)}` : ""}`);
    return;
  }
  try {
    const redirectUri = process.env.WORKOS_REDIRECT_URI || `${process.env.APP_URL || "http://localhost:5000"}/auth/callback`;
    const authorizationUrl = workos.userManagement.getAuthorizationUrl({
      provider: "authkit",
      redirectUri,
      clientId: WORKOS_CLIENT_ID,
    });
    res.redirect(authorizationUrl);
  } catch (err) {
    console.error("Auth login error:", err);
    res.status(500).json({ error: "Failed to initiate login" });
  }
});

app.get("/auth/callback", async (req, res) => {
  const callbackStart = Date.now();
  try {
    const code = req.query.code as string;
    console.log("[auth/callback] Received callback, code present:", !!code);
    if (!code) {
      res.status(400).send("Missing authorization code");
      return;
    }

    const codeExchangeStart = Date.now();
    const { user: workosUser, sealedSession } = await workos.userManagement.authenticateWithCode({
      code,
      clientId: WORKOS_CLIENT_ID,
      session: {
        sealSession: true,
        cookiePassword: WORKOS_COOKIE_PASSWORD,
      },
    });
    console.log(`[auth/callback] WorkOS code exchange: ${Date.now() - codeExchangeStart}ms`);

    const dbLookupStart = Date.now();
    const normalizedEmail = workosUser.email.toLowerCase().trim();
    const existingUser = await pool.query(
      "SELECT id, email, display_name, avatar_url, workos_user_id FROM users WHERE email = $1",
      [normalizedEmail]
    );
    console.log(`[auth/callback] DB user lookup: ${Date.now() - dbLookupStart}ms`);

    let localUserId: string;

    if (existingUser.rows.length > 0) {
      const localUser = existingUser.rows[0];
      localUserId = localUser.id;
      const updates: string[] = ["email_verified = true"];
      const values: unknown[] = [];
      let idx = 1;

      if (!localUser.workos_user_id) {
        updates.push(`workos_user_id = $${idx++}`);
        values.push(workosUser.id);
      }
      if (!localUser.display_name && (workosUser.firstName || workosUser.lastName)) {
        updates.push(`display_name = $${idx++}`);
        values.push(`${workosUser.firstName || ""} ${workosUser.lastName || ""}`.trim());
      }
      if (!localUser.avatar_url && workosUser.profilePictureUrl) {
        updates.push(`avatar_url = $${idx++}`);
        values.push(workosUser.profilePictureUrl);
      }
      if (isSuperAdminEmail(normalizedEmail)) {
        updates.push(`role = 'superadmin'`);
      }

      values.push(localUser.id);
      await pool.query(
        `UPDATE users SET ${updates.join(", ")} WHERE id = $${idx}`,
        values
      );
      evictUserFromCache(localUser.id);
    } else {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const assignedRole = isSuperAdminEmail(normalizedEmail) ? "superadmin" : "user";
        const displayName = workosUser.firstName
          ? `${workosUser.firstName} ${workosUser.lastName || ""}`.trim()
          : normalizedEmail.split("@")[0];
        const userResult = await client.query(
          "INSERT INTO users (email, password_hash, display_name, avatar_url, role, email_verified, workos_user_id) VALUES ($1, NULL, $2, $3, $4, true, $5) RETURNING id, display_name",
          [normalizedEmail, displayName, workosUser.profilePictureUrl || null, assignedRole, workosUser.id]
        );
        const newUser = userResult.rows[0];
        localUserId = newUser.id;
        const wsResult = await client.query(
          "INSERT INTO workspaces (name, owner_id) VALUES ($1, $2) RETURNING id",
          [`${newUser.display_name}'s Team`, newUser.id]
        );
        await client.query(
          "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
          [wsResult.rows[0].id, newUser.id]
        );
        await client.query(
          "INSERT INTO credits (user_id, balance) VALUES ($1, 0)",
          [newUser.id]
        );
        await client.query("COMMIT");
      } catch (txErr) {
        await client.query("ROLLBACK");
        throw txErr;
      } finally {
        client.release();
      }
    }

    const sessionCreateStart = Date.now();
    await createSession(localUserId, workosUser.id, sealedSession).catch((err) => {
      console.error("[session] Failed to create session record on login:", err);
    });
    console.log(`[auth/callback] Session DB insert: ${Date.now() - sessionCreateStart}ms`);

    res.cookie(WOS_COOKIE_NAME, sealedSession, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 400 * 24 * 60 * 60 * 1000,
      path: "/",
    });
    console.log(`[auth/callback] Total duration: ${Date.now() - callbackStart}ms`);
    const postRedirect = (req.cookies?.post_login_redirect as string) || "";
    const safePostRedirect = postRedirect.startsWith("/") && !postRedirect.startsWith("//") ? postRedirect : "/";
    if (postRedirect) res.clearCookie("post_login_redirect", { path: "/" });
    res.redirect(safePostRedirect);
  } catch (err) {
    console.error("Auth callback error:", err);
    res.redirect("/?auth_error=1");
  }
});

app.post("/auth/logout", async (req, res) => {
  const logoutStart = Date.now();
  if (DEV_AUTH_BYPASS) {
    res.clearCookie(DEV_COOKIE_NAME, { path: "/" });
    res.json({ ok: true });
    return;
  }

  const sessionCookie = req.cookies?.[WOS_COOKIE_NAME];

  const invalidateStart = Date.now();
  if (sessionCookie) {
    invalidateSessionByCookie(sessionCookie).catch(() => {});
  }
  res.clearCookie(WOS_COOKIE_NAME, { path: "/" });
  console.log(`[auth/logout] Session invalidated + cookie cleared: ${Date.now() - invalidateStart}ms`);

  try {
    if (sessionCookie) {
      const session = workos.userManagement.loadSealedSession({
        sessionData: sessionCookie,
        cookiePassword: WORKOS_COOKIE_PASSWORD,
      });
      const LOGOUT_URL_TIMEOUT_MS = 3000;
      const workosStart = Date.now();
      const logoutUrl = await Promise.race([
        session.getLogoutUrl(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), LOGOUT_URL_TIMEOUT_MS)),
      ]);
      console.log(`[auth/logout] WorkOS getLogoutUrl: ${Date.now() - workosStart}ms`);
      console.log(`[auth/logout] Total duration: ${Date.now() - logoutStart}ms`);
      if (logoutUrl) {
        res.json({ ok: true, logoutUrl });
        return;
      }
    }
  } catch {
  }
  console.log(`[auth/logout] Total duration: ${Date.now() - logoutStart}ms`);
  res.json({ ok: true });
});

app.get("/api/auth/me", async (req, res) => {
  const meStart = Date.now();
  const sessionLookupStart = Date.now();
  const result = await getLocalUserFromSession(req, res);
  console.log(`[api/auth/me] Session lookup: ${Date.now() - sessionLookupStart}ms`);
  if (!result) {
    res.json({ user: null });
    return;
  }
  if (result.transient) {
    res.set("Retry-After", "2");
    res.status(503).json({ user: null, transient: true });
    return;
  }
  if (result.sessionExpired || !result.userId) {
    res.json({ user: null, sessionExpired: true });
    return;
  }
  try {
    const cachedUser = getUserFromCache(result.userId);

    const dbStart = Date.now();
    const dbPromise = cachedUser
      ? Promise.resolve(null)
      : pool.query(
          "SELECT id, email, display_name, avatar_url, first_name, last_name, phone, date_of_birth, billing_line1, billing_line2, billing_city, billing_state, billing_zip, billing_country, role, email_verified, tos_accepted_at FROM users WHERE id = $1",
          [result.userId]
        );

    const workosGetStart = Date.now();
    const workosPromise = (!DEV_AUTH_BYPASS && result.workosUserId)
      ? workos.userManagement.getUser(result.workosUserId).catch(() => null)
      : Promise.resolve(null);

    const [userResult, workosUser] = await Promise.all([dbPromise, workosPromise]);

    if (!cachedUser) {
      console.log(`[api/auth/me] DB user fetch: ${Date.now() - dbStart}ms`);
    }
    if (!DEV_AUTH_BYPASS && result.workosUserId) {
      console.log(`[api/auth/me] WorkOS getUser: ${Date.now() - workosGetStart}ms`);
    }

    let u: Record<string, string | boolean | null>;
    if (cachedUser) {
      u = cachedUser;
    } else {
      if (!userResult || userResult.rows.length === 0) {
        res.clearCookie(DEV_AUTH_BYPASS ? DEV_COOKIE_NAME : WOS_COOKIE_NAME, { path: "/" });
        res.json({ user: null });
        return;
      }
      u = userResult.rows[0];
      setUserInCache(result.userId, u);
    }

    const mapped = mapUser(u);

    let authMethod = DEV_AUTH_BYPASS ? "DevBypass" : "AuthKit";
    if (!DEV_AUTH_BYPASS && result.workosUserId && workosUser) {
      if (workosUser.profilePictureUrl) {
        authMethod = "Social (Google/GitHub)";
      } else {
        authMethod = "Email";
      }
    }

    const sharingFlagAll = (process.env.FEATURE_SHARING_V1 || "").toLowerCase() === "all";
    const sharingAllowlist = (process.env.FEATURE_SHARING_V1_EMAILS || "")
      .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    const userEmail = String((u as Record<string, unknown>).email || "").toLowerCase();
    const sharingEnabled = sharingFlagAll || sharingAllowlist.includes(userEmail);

    console.log(`[api/auth/me] Total duration: ${Date.now() - meStart}ms`);
    res.json({ user: { ...mapped, authMethod }, features: { sharingV1: sharingEnabled } });
  } catch {
    res.json({ user: null });
  }
});

app.get("/api/auth/verify-email", async (req, res) => {
  try {
    const { token } = req.query;
    if (!token || typeof token !== "string") {
      res.status(400).json({ error: "Token is required" });
      return;
    }
    const result = await pool.query(
      "SELECT id, user_id, email, type, expires_at FROM email_verification_tokens WHERE token = $1",
      [token]
    );
    if (result.rows.length === 0) {
      res.status(400).json({ error: "Invalid or expired token" });
      return;
    }
    const record = result.rows[0];
    if (new Date(record.expires_at) < new Date()) {
      await pool.query("DELETE FROM email_verification_tokens WHERE id = $1", [record.id]);
      res.status(400).json({ error: "Token has expired. Please request a new verification email." });
      return;
    }

    if (record.type === "email_change") {
      const existing = await pool.query("SELECT id FROM users WHERE email = $1 AND id != $2", [record.email, record.user_id]);
      if (existing.rows.length > 0) {
        await pool.query("DELETE FROM email_verification_tokens WHERE id = $1", [record.id]);
        res.status(409).json({ error: "Email is already in use by another account" });
        return;
      }
      await pool.query("UPDATE users SET email = $1, email_verified = true WHERE id = $2", [record.email, record.user_id]);
      evictUserFromCache(record.user_id);
    }

    await pool.query("DELETE FROM email_verification_tokens WHERE id = $1", [record.id]);
    res.json({ ok: true, type: record.type });
  } catch (err) {
    console.error("Verify email error:", err);
    res.status(500).json({ error: "Verification failed" });
  }
});

app.patch("/api/auth/profile", requireAuth, async (req, res) => {
  try {
    const userId = (req as AuthRequest).userId;
    const {
      displayName, email, avatarUrl,
      firstName, lastName, phone, dateOfBirth,
      billingLine1, billingLine2, billingCity, billingState, billingZip, billingCountry,
    } = req.body;
    const updates: string[] = [];
    const values: unknown[] = [];
    let idx = 1;
    if (displayName !== undefined) { updates.push(`display_name = $${idx++}`); values.push(displayName); }
    if (avatarUrl !== undefined) { updates.push(`avatar_url = $${idx++}`); values.push(avatarUrl); }
    if (firstName !== undefined) { updates.push(`first_name = $${idx++}`); values.push(firstName); }
    if (lastName !== undefined) { updates.push(`last_name = $${idx++}`); values.push(lastName); }
    if (phone !== undefined) { updates.push(`phone = $${idx++}`); values.push(phone); }
    if (dateOfBirth !== undefined) { updates.push(`date_of_birth = $${idx++}`); values.push(dateOfBirth || null); }
    if (billingLine1 !== undefined) { updates.push(`billing_line1 = $${idx++}`); values.push(billingLine1); }
    if (billingLine2 !== undefined) { updates.push(`billing_line2 = $${idx++}`); values.push(billingLine2); }
    if (billingCity !== undefined) { updates.push(`billing_city = $${idx++}`); values.push(billingCity); }
    if (billingState !== undefined) { updates.push(`billing_state = $${idx++}`); values.push(billingState); }
    if (billingZip !== undefined) { updates.push(`billing_zip = $${idx++}`); values.push(billingZip); }
    if (billingCountry !== undefined) { updates.push(`billing_country = $${idx++}`); values.push(billingCountry); }
    let emailChangeRequested = false;
    if (email !== undefined) {
      const normalizedNewEmail = email.toLowerCase().trim();
      const currentUser = await pool.query("SELECT email FROM users WHERE id = $1", [userId]);
      const currentEmail = currentUser.rows[0]?.email || "";
      if (normalizedNewEmail !== currentEmail) {
        if (isSuperAdminEmail(normalizedNewEmail) && !isSuperAdminEmail(currentEmail)) {
          res.status(403).json({ error: "Cannot change email to a restricted domain" });
          return;
        }
        const existing = await pool.query("SELECT id FROM users WHERE email = $1 AND id != $2", [normalizedNewEmail, userId]);
        if (existing.rows.length > 0) { res.status(409).json({ error: "Email already in use" }); return; }

        await pool.query("DELETE FROM email_verification_tokens WHERE user_id = $1 AND type = 'email_change'", [userId]);
        const vToken = crypto.randomBytes(32).toString("hex");
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await pool.query(
          "INSERT INTO email_verification_tokens (user_id, token, email, type, expires_at) VALUES ($1, $2, $3, 'email_change', $4)",
          [userId, vToken, normalizedNewEmail, expiresAt]
        );
        try {
          await sendEmailChangeVerification(normalizedNewEmail, vToken);
        } catch (emailErr) {
          console.error("Failed to send email change verification:", emailErr);
        }
        emailChangeRequested = true;
      }
    }
    if (updates.length === 0 && !emailChangeRequested) { res.status(400).json({ error: "No fields to update" }); return; }
    if (updates.length === 0) {
      const current = await pool.query(
        "SELECT id, email, display_name, avatar_url, first_name, last_name, phone, date_of_birth, billing_line1, billing_line2, billing_city, billing_state, billing_zip, billing_country, role, email_verified, tos_accepted_at FROM users WHERE id = $1",
        [userId]
      );
      res.json({ user: mapUser(current.rows[0]), emailChangeRequested: true, message: "Verification email sent to new address" });
      return;
    }
    values.push(userId);
    const result = await pool.query(
      `UPDATE users SET ${updates.join(", ")} WHERE id = $${idx} RETURNING id, email, display_name, avatar_url, first_name, last_name, phone, date_of_birth, billing_line1, billing_line2, billing_city, billing_state, billing_zip, billing_country, role, email_verified, tos_accepted_at`,
      values
    );
    evictUserFromCache(userId!);
    res.json({ user: mapUser(result.rows[0]), ...(emailChangeRequested ? { emailChangeRequested: true, message: "Verification email sent to new address" } : {}) });
  } catch (err: unknown) {
    console.error("Profile update error:", err);
    res.status(500).json({ error: "Update failed" });
  }
});


app.post("/api/auth/accept-tos", requireAuth, async (req, res) => {
  try {
    const userId = (req as AuthRequest).userId;
    const result = await pool.query(
      "UPDATE users SET tos_accepted_at = NOW() WHERE id = $1 RETURNING tos_accepted_at",
      [userId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    evictUserFromCache(userId!);
    res.json({ tosAcceptedAt: result.rows[0].tos_accepted_at });
  } catch (err) {
    console.error("Accept TOS error:", err);
    res.status(500).json({ error: "Failed to accept TOS" });
  }
});

async function getCallerRole(userId: string, workspaceId: string): Promise<string | null> {
  const r = await pool.query(
    `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [workspaceId, userId]
  );
  return r.rows.length > 0 ? r.rows[0].role : null;
}

function isAdminOrOwner(role: string | null): boolean {
  return role === "owner" || role === "admin";
}

app.get("/api/workspace", requireAuth, requireVerifiedEmail, async (req, res) => {
  try {
    const userId = (req as AuthRequest).userId;
    const wsId = req.query.workspace_id as string | undefined;
    let query: string;
    let params: unknown[];
    if (wsId) {
      query = `SELECT w.id, w.name, w.owner_id, w.type, w.created_at
               FROM workspaces w
               JOIN workspace_members wm ON wm.workspace_id = w.id
               WHERE w.id = $1 AND wm.user_id = $2
               LIMIT 1`;
      params = [wsId, userId];
    } else {
      query = `SELECT w.id, w.name, w.owner_id, w.type, w.created_at
               FROM workspaces w
               JOIN workspace_members wm ON wm.workspace_id = w.id
               WHERE wm.user_id = $1
               LIMIT 1`;
      params = [userId];
    }
    const result = await pool.query(query, params);
    if (result.rows.length === 0) {
      res.status(404).json({ error: "No workspace found" });
      return;
    }
    const ws = result.rows[0];
    res.json({ workspace: { id: ws.id, name: ws.name, ownerId: ws.owner_id, type: ws.type } });
  } catch (err: unknown) {
    console.error("Get workspace error:", err);
    res.status(500).json({ error: "Failed to get workspace" });
  }
});

app.patch("/api/workspace", requireAuth, requireVerifiedEmail, async (req, res) => {
  try {
    const userId = (req as AuthRequest).userId;
    const { name } = req.body;
    const workspace_id = req.body.workspace_id || (req.query.workspace_id as string);
    if (!name || !name.trim()) {
      res.status(400).json({ error: "Workspace name is required" });
      return;
    }
    let wsId: string;
    if (workspace_id) {
      wsId = workspace_id;
    } else {
      const wsResult = await pool.query(
        `SELECT w.id FROM workspaces w JOIN workspace_members wm ON wm.workspace_id = w.id WHERE wm.user_id = $1 LIMIT 1`,
        [userId]
      );
      if (wsResult.rows.length === 0) {
        res.status(404).json({ error: "No workspace found" });
        return;
      }
      wsId = wsResult.rows[0].id;
    }
    const role = await getCallerRole(userId, wsId);
    if (!isAdminOrOwner(role)) {
      res.status(403).json({ error: "Only owners and admins can rename the workspace" });
      return;
    }
    const result = await pool.query(
      "UPDATE workspaces SET name = $1 WHERE id = $2 RETURNING id, name, owner_id",
      [name.trim(), wsId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    const ws = result.rows[0];
    res.json({ workspace: { id: ws.id, name: ws.name, ownerId: ws.owner_id } });
  } catch (err: unknown) {
    console.error("Update workspace error:", err);
    res.status(500).json({ error: "Failed to update workspace" });
  }
});

app.get("/api/workspace/members", requireAuth, requireVerifiedEmail, async (req, res) => {
  try {
    const userId = (req as AuthRequest).userId;
    const wsId = req.query.workspace_id as string | undefined;
    let workspaceId: string;
    if (wsId) {
      workspaceId = wsId;
    } else {
      const wsResult = await pool.query(
        `SELECT w.id FROM workspaces w
         JOIN workspace_members wm ON wm.workspace_id = w.id
         WHERE wm.user_id = $1 LIMIT 1`,
        [userId]
      );
      if (wsResult.rows.length === 0) {
        res.json({ members: [] });
        return;
      }
      workspaceId = wsResult.rows[0].id;
    }
    const memberCheck = await pool.query(
      `SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId]
    );
    if (memberCheck.rows.length === 0) {
      res.status(403).json({ error: "Not a member of this workspace" });
      return;
    }
    const result = await pool.query(
      `SELECT u.id, u.email, u.display_name, u.avatar_url, wm.role, wm.joined_at
       FROM workspace_members wm
       JOIN users u ON u.id = wm.user_id
       WHERE wm.workspace_id = $1
       ORDER BY wm.joined_at ASC`,
      [workspaceId]
    );
    const pendingInvites = await pool.query(
      `SELECT id, email, role, status, sent_at, invited_by, expires_at FROM workspace_invitations
       WHERE workspace_id = $1 AND status = 'pending'
       ORDER BY sent_at DESC`,
      [workspaceId]
    );
    res.json({
      members: result.rows.map((r) => ({
        id: r.id,
        email: r.email,
        displayName: r.display_name,
        avatarUrl: r.avatar_url ?? null,
        role: r.role,
        joinedAt: r.joined_at,
      })),
      pendingInvitations: pendingInvites.rows.map((r) => ({
        id: r.id,
        email: r.email,
        role: r.role,
        status: r.status,
        sentAt: r.sent_at,
        invitedBy: r.invited_by,
        expiresAt: r.expires_at,
      })),
    });
  } catch (err: unknown) {
    console.error("Get members error:", err);
    res.status(500).json({ error: "Failed to get members" });
  }
});

app.patch("/api/workspace/members/:memberId/role", requireAuth, requireVerifiedEmail, async (req, res) => {
  try {
    const userId = (req as AuthRequest).userId;
    const memberId = req.params.memberId;
    const { role, workspace_id } = req.body;
    if (!role || !["admin", "member"].includes(role)) {
      res.status(400).json({ error: "Role must be 'admin' or 'member'" });
      return;
    }
    if (!workspace_id) {
      res.status(400).json({ error: "workspace_id is required" });
      return;
    }
    const callerRole = await getCallerRole(userId, workspace_id);
    if (!isAdminOrOwner(callerRole)) {
      res.status(403).json({ error: "Only owners and admins can change roles" });
      return;
    }
    const targetRole = await getCallerRole(memberId, workspace_id);
    if (!targetRole) {
      res.status(404).json({ error: "Member not found in workspace" });
      return;
    }
    if (targetRole === "owner") {
      res.status(403).json({ error: "Cannot change the owner's role" });
      return;
    }
    if (callerRole === "admin" && role !== "member") {
      res.status(403).json({ error: "Admins can only assign the member role" });
      return;
    }
    await pool.query(
      `UPDATE workspace_members SET role = $1 WHERE workspace_id = $2 AND user_id = $3`,
      [role, workspace_id, memberId]
    );

    const wsInfo = await pool.query(`SELECT name FROM workspaces WHERE id = $1`, [workspace_id]);
    const wsName = wsInfo.rows[0]?.name || "Workspace";
    await createNotification({
      userId: memberId,
      type: "team_role_changed",
      title: "Role updated",
      message: `Your role in ${wsName} has been changed to ${role}.`,
      severity: "info",
      metadata: { workspace_id, new_role: role },
    }).catch((notifErr: unknown) => {
      console.error("[notification] Failed to send team_role_changed notification:", notifErr);
    });

    res.json({ ok: true });
  } catch (err: unknown) {
    console.error("Change role error:", err);
    res.status(500).json({ error: "Failed to change role" });
  }
});

app.delete("/api/workspace/members/:memberId", requireAuth, requireVerifiedEmail, async (req, res) => {
  try {
    const userId = (req as AuthRequest).userId;
    const memberId = req.params.memberId;
    const wsId = req.query.workspace_id as string | undefined;
    if (!wsId) {
      res.status(400).json({ error: "workspace_id is required" });
      return;
    }
    const callerRole = await getCallerRole(userId, wsId);
    if (!isAdminOrOwner(callerRole)) {
      res.status(403).json({ error: "Only owners and admins can remove members" });
      return;
    }
    const targetRole = await getCallerRole(memberId, wsId);
    if (!targetRole) {
      res.status(404).json({ error: "Member not found in workspace" });
      return;
    }
    if (targetRole === "owner") {
      res.status(403).json({ error: "Cannot remove the workspace owner" });
      return;
    }
    const wsInfo = await pool.query(`SELECT name FROM workspaces WHERE id = $1`, [wsId]);
    const wsName = wsInfo.rows[0]?.name || "Workspace";

    await pool.query(
      `DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [wsId, memberId]
    );

    await createNotification({
      userId: memberId,
      type: "team_member_removed",
      title: "Removed from workspace",
      message: `You have been removed from ${wsName}.`,
      severity: "warning",
      metadata: { workspace_id: wsId },
    }).catch((notifErr: unknown) => {
      console.error("[notification] Failed to send team_member_removed notification:", notifErr);
    });

    res.json({ ok: true });
  } catch (err: unknown) {
    console.error("Remove member error:", err);
    res.status(500).json({ error: "Failed to remove member" });
  }
});

app.get("/api/workspace/invitations", requireAuth, requireVerifiedEmail, async (req, res) => {
  try {
    const userId = (req as AuthRequest).userId;
    const wsId = req.query.workspace_id as string | undefined;
    if (!wsId) {
      res.status(400).json({ error: "workspace_id is required" });
      return;
    }
    const workspaceId = wsId;
    const role = await getCallerRole(userId, workspaceId);
    if (!isAdminOrOwner(role)) {
      res.status(403).json({ error: "Only owners and admins can view invitations" });
      return;
    }
    const result = await pool.query(
      `SELECT id, email, role, status, sent_at, invited_by, expires_at FROM workspace_invitations
       WHERE workspace_id = $1 AND status = 'pending'
       ORDER BY sent_at DESC`,
      [workspaceId]
    );
    res.json({
      invitations: result.rows.map((r) => ({
        id: r.id,
        email: r.email,
        role: r.role,
        status: r.status,
        sentAt: r.sent_at,
        invitedBy: r.invited_by,
        expiresAt: r.expires_at,
      })),
    });
  } catch (err: unknown) {
    console.error("Get invitations error:", err);
    res.status(500).json({ error: "Failed to get invitations" });
  }
});

app.post("/api/workspace/invitations", requireAuth, requireVerifiedEmail, async (req, res) => {
  try {
    const userId = (req as AuthRequest).userId;
    const { email, role: invRole, workspace_id } = req.body;
    if (!email || !email.trim()) {
      res.status(400).json({ error: "Email is required" });
      return;
    }
    const assignRole = invRole && ["admin", "member"].includes(invRole) ? invRole : "member";
    if (!workspace_id) {
      res.status(400).json({ error: "workspace_id is required" });
      return;
    }
    const wsId: string = workspace_id;
    const callerRole = await getCallerRole(userId, wsId);
    if (!isAdminOrOwner(callerRole)) {
      res.status(403).json({ error: "Only workspace owners and admins can send invitations" });
      return;
    }
    const existingMember = await pool.query(
      `SELECT 1 FROM workspace_members wm JOIN users u ON u.id = wm.user_id
       WHERE wm.workspace_id = $1 AND u.email = $2`,
      [wsId, email.toLowerCase().trim()]
    );
    if (existingMember.rows.length > 0) {
      res.status(409).json({ error: "User is already a member of this workspace" });
      return;
    }
    const existingInvite = await pool.query(
      `SELECT id FROM workspace_invitations WHERE workspace_id = $1 AND email = $2 AND status = 'pending'`,
      [wsId, email.toLowerCase().trim()]
    );
    if (existingInvite.rows.length > 0) {
      res.status(409).json({ error: "An invitation has already been sent to this email" });
      return;
    }
    const token = uuidv4();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const result = await pool.query(
      `INSERT INTO workspace_invitations (workspace_id, email, token, role, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, email, role, status, sent_at, invited_by, expires_at`,
      [wsId, email.toLowerCase().trim(), token, assignRole, userId, expiresAt]
    );
    const inv = result.rows[0];
    console.log(`[Invitation] Invite sent to ${inv.email} as ${inv.role} (id: ${inv.id})`);

    const wsInfo = await pool.query(`SELECT name FROM workspaces WHERE id = $1`, [wsId]);
    const inviterInfo = await pool.query(`SELECT display_name, email FROM users WHERE id = $1`, [userId]);
    const workspaceName = wsInfo.rows[0]?.name || "Workspace";
    const inviterName = inviterInfo.rows[0]?.display_name || inviterInfo.rows[0]?.email || "A team member";

    const emailResult = await sendInvitationEmail({
      to: inv.email,
      token,
      workspaceName,
      inviterName,
      role: inv.role,
    });

    const inviteeUser = await pool.query(
      `SELECT id FROM users WHERE email = $1`,
      [email.toLowerCase().trim()]
    );
    if (inviteeUser.rows.length > 0) {
      await createNotification({
        userId: inviteeUser.rows[0].id,
        type: "team_invite_received",
        title: "Workspace invitation",
        message: `${inviterName} invited you to join ${workspaceName} as ${assignRole}.`,
        severity: "info",
        metadata: { workspace_id: wsId, invitation_id: inv.id, role: assignRole },
      }).catch((notifErr: unknown) => {
        console.error("[notification] Failed to send team_invite_received notification:", notifErr);
      });
    }

    res.json({
      invitation: {
        id: inv.id,
        email: inv.email,
        role: inv.role,
        status: inv.status,
        sentAt: inv.sent_at,
        invitedBy: inv.invited_by,
        expiresAt: inv.expires_at,
        emailSent: emailResult.sent,
      },
      email_sent: emailResult.sent,
      ...(emailResult.error ? { email_error: emailResult.error } : {}),
    });
  } catch (err: unknown) {
    console.error("Send invitation error:", err);
    res.status(500).json({ error: "Failed to send invitation" });
  }
});

app.post("/api/workspace/invitations/:id/resend", requireAuth, requireVerifiedEmail, async (req, res) => {
  try {
    const userId = (req as AuthRequest).userId;
    const invId = req.params.id;
    const { workspace_id } = req.body;
    if (!workspace_id) {
      res.status(400).json({ error: "workspace_id is required" });
      return;
    }
    const wsId: string = workspace_id;
    const callerRole = await getCallerRole(userId, wsId);
    if (!isAdminOrOwner(callerRole)) {
      res.status(403).json({ error: "Only workspace owners and admins can resend invitations" });
      return;
    }
    const oldInvResult = await pool.query(
      `SELECT id, email, role, invited_by FROM workspace_invitations WHERE id = $1 AND workspace_id = $2 AND status = 'pending'`,
      [invId, wsId]
    );
    if (oldInvResult.rows.length === 0) {
      res.status(404).json({ error: "Invitation not found" });
      return;
    }
    const oldInv = oldInvResult.rows[0];
    const newToken = uuidv4();
    const newExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const resendClient = await pool.connect();
    let inv: Record<string, unknown>;
    try {
      await resendClient.query("BEGIN");
      await resendClient.query(
        `UPDATE workspace_invitations SET status = 'superseded' WHERE id = $1`,
        [invId]
      );
      const insertResult = await resendClient.query(
        `INSERT INTO workspace_invitations (workspace_id, email, token, role, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, email, role, status, sent_at, invited_by, expires_at`,
        [wsId, oldInv.email, newToken, oldInv.role, oldInv.invited_by || userId, newExpiresAt]
      );
      await resendClient.query("COMMIT");
      inv = insertResult.rows[0];
    } catch (txErr) {
      await resendClient.query("ROLLBACK");
      throw txErr;
    } finally {
      resendClient.release();
    }
    console.log(`[Invitation] Resent invite to ${inv.email} (id: ${inv.id})`);

    const wsInfo = await pool.query(`SELECT name FROM workspaces WHERE id = $1`, [wsId]);
    const inviterInfo = await pool.query(`SELECT display_name, email FROM users WHERE id = $1`, [userId]);
    const workspaceName = wsInfo.rows[0]?.name || "Workspace";
    const inviterName = inviterInfo.rows[0]?.display_name || inviterInfo.rows[0]?.email || "A team member";

    const emailResult = await sendInvitationEmail({
      to: inv.email,
      token: newToken,
      workspaceName,
      inviterName,
      role: inv.role,
    });

    res.json({
      invitation: {
        id: inv.id,
        email: inv.email,
        role: inv.role,
        status: inv.status,
        sentAt: inv.sent_at,
        invitedBy: inv.invited_by,
        expiresAt: inv.expires_at,
        emailSent: emailResult.sent,
      },
      email_sent: emailResult.sent,
      ...(emailResult.error ? { email_error: emailResult.error } : {}),
    });
  } catch (err: unknown) {
    console.error("Resend invitation error:", err);
    res.status(500).json({ error: "Failed to resend invitation" });
  }
});

app.delete("/api/workspace/invitations/:id", requireAuth, requireVerifiedEmail, async (req, res) => {
  try {
    const userId = (req as AuthRequest).userId;
    const invId = req.params.id;
    const wsId = req.query.workspace_id as string | undefined;
    if (!wsId) {
      res.status(400).json({ error: "workspace_id is required" });
      return;
    }
    const workspaceId = wsId;
    const callerRole = await getCallerRole(userId, workspaceId);
    if (!isAdminOrOwner(callerRole)) {
      res.status(403).json({ error: "Only workspace owners and admins can revoke invitations" });
      return;
    }
    const result = await pool.query(
      `UPDATE workspace_invitations SET status = 'revoked'
       WHERE id = $1 AND workspace_id = $2 AND status = 'pending' RETURNING id`,
      [invId, workspaceId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Invitation not found" });
      return;
    }
    res.json({ ok: true });
  } catch (err: unknown) {
    console.error("Revoke invitation error:", err);
    res.status(500).json({ error: "Failed to revoke invitation" });
  }
});

app.get("/api/invite/:token", async (req, res) => {
  try {
    const { token } = req.params;
    const result = await pool.query(
      `SELECT wi.id, wi.email, wi.role, wi.status, wi.expires_at, wi.invited_by, wi.workspace_id,
              w.name AS workspace_name,
              u.display_name AS inviter_name, u.email AS inviter_email
       FROM workspace_invitations wi
       JOIN workspaces w ON w.id = wi.workspace_id
       LEFT JOIN users u ON u.id = wi.invited_by
       WHERE wi.token = $1`,
      [token]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Invitation not found" });
      return;
    }
    const inv = result.rows[0];
    if (inv.status === "superseded") {
      res.status(410).json({ error: "This invite link has been superseded. Please ask for a new invitation." });
      return;
    }
    if (inv.status !== "pending") {
      res.status(410).json({ error: `Invitation has already been ${inv.status}` });
      return;
    }
    if (inv.expires_at && new Date(inv.expires_at) < new Date()) {
      res.status(410).json({ error: "Invitation has expired" });
      return;
    }
    res.json({
      invitation: {
        workspaceName: inv.workspace_name,
        inviterName: inv.inviter_name || inv.inviter_email || "A team member",
        role: inv.role,
        expiresAt: inv.expires_at,
        email: inv.email,
      },
    });
  } catch (err: unknown) {
    console.error("Get invite info error:", err);
    res.status(500).json({ error: "Failed to get invitation info" });
  }
});

app.post("/api/invite/:token/accept", requireAuth, requireVerifiedEmail, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const { token } = req.params;
    const result = await pool.query(
      `SELECT wi.id, wi.workspace_id, wi.role, wi.status, wi.expires_at, wi.email, wi.invited_by
       FROM workspace_invitations wi
       WHERE wi.token = $1`,
      [token]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Invitation not found" });
      return;
    }
    const inv = result.rows[0];
    if (inv.status === "superseded") {
      res.status(410).json({ error: "This invite link has been superseded. Please ask for a new invitation." });
      return;
    }
    if (inv.status !== "pending") {
      if (inv.status === "accepted") {
        const alreadyMember = await pool.query(
          `SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
          [inv.workspace_id, userId]
        );
        if (alreadyMember.rows.length > 0) {
          res.json({ workspace_id: inv.workspace_id, role: inv.role, already_member: true });
          return;
        }
      }
      res.status(400).json({ error: `Invitation has already been ${inv.status}` });
      return;
    }
    if (inv.expires_at && new Date(inv.expires_at) < new Date()) {
      res.status(400).json({ error: "Invitation has expired" });
      return;
    }
    const userResult = await pool.query(`SELECT email, email_verified FROM users WHERE id = $1`, [userId]);
    if (userResult.rows.length === 0) {
      res.status(403).json({ error: "User not found" });
      return;
    }
    const userEmail = userResult.rows[0].email.toLowerCase().trim();
    const invEmail = inv.email.toLowerCase().trim();
    if (userEmail !== invEmail) {
      res.status(403).json({ error: "This invitation was sent to a different email address" });
      return;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (workspace_id, user_id) DO UPDATE
           SET role = EXCLUDED.role
           WHERE workspace_members.role <> 'owner'`,
        [inv.workspace_id, userId, inv.role]
      );
      await client.query(
        `UPDATE workspace_invitations SET status = 'accepted' WHERE id = $1`,
        [inv.id]
      );
      await client.query("COMMIT");
    } catch (txErr) {
      await client.query("ROLLBACK");
      throw txErr;
    } finally {
      client.release();
    }
    const wsInfo = await pool.query(`SELECT name FROM workspaces WHERE id = $1`, [inv.workspace_id]);
    const joinerInfo = await pool.query(`SELECT display_name, email FROM users WHERE id = $1`, [userId]);
    const wsName = wsInfo.rows[0]?.name || "Workspace";
    const joinerName = joinerInfo.rows[0]?.display_name || joinerInfo.rows[0]?.email || "Someone";

    if (inv.invited_by) {
      await createNotification({
        userId: inv.invited_by,
        type: "team_invite_accepted",
        title: "Invitation accepted",
        message: `${joinerName} has joined ${wsName}.`,
        severity: "success",
        metadata: { workspace_id: inv.workspace_id, new_member_id: userId },
      }).catch((notifErr: unknown) => {
        console.error("[notification] Failed to send team_invite_accepted notification:", notifErr);
      });
    }

    res.json({ workspace_id: inv.workspace_id, role: inv.role });
  } catch (err: unknown) {
    console.error("Accept invite error:", err);
    res.status(500).json({ error: "Failed to accept invitation" });
  }
});

app.delete("/api/workspaces/:id", requireAuth, requireVerifiedEmail, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const wsId = req.params.id;
    const wsResult = await pool.query(
      `SELECT w.id, w.type, w.owner_id FROM workspaces w WHERE w.id = $1`,
      [wsId]
    );
    if (wsResult.rows.length === 0) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    const ws = wsResult.rows[0];
    if (ws.owner_id !== userId) {
      res.status(403).json({ error: "Only the workspace owner can delete it" });
      return;
    }
    if (ws.type === "personal") {
      res.status(403).json({ error: "Your personal workspace cannot be deleted" });
      return;
    }
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [wsId]);
    res.json({ ok: true });
  } catch (err: unknown) {
    console.error("Delete workspace error:", err);
    res.status(500).json({ error: "Failed to delete workspace" });
  }
});

app.get("/api/workspaces", requireAuth, requireVerifiedEmail, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const result = await pool.query(
      `SELECT w.id, w.name, w.type, w.owner_id, wm.role
       FROM workspaces w
       JOIN workspace_members wm ON wm.workspace_id = w.id
       WHERE wm.user_id = $1
       ORDER BY w.created_at ASC`,
      [userId]
    );
    res.json(result.rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      owner_id: r.owner_id,
      role: r.role,
    })));
  } catch (err: unknown) {
    console.error("List workspaces error:", err);
    res.status(500).json({ error: "Failed to list workspaces" });
  }
});

app.post("/api/workspaces", requireAuth, requireVerifiedEmail, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const { name } = req.body;
    if (!name || !name.trim()) {
      res.status(400).json({ error: "Workspace name is required" });
      return;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const wsResult = await client.query(
        `INSERT INTO workspaces (name, owner_id, type) VALUES ($1, $2, 'org') RETURNING id, name, type, owner_id, created_at`,
        [name.trim(), userId]
      );
      const ws = wsResult.rows[0];
      await client.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [ws.id, userId]
      );
      await client.query('COMMIT');
      res.json({
        id: ws.id,
        name: ws.name,
        type: ws.type,
        owner_id: ws.owner_id,
        created_at: ws.created_at,
      });
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }
  } catch (err: unknown) {
    console.error("Create workspace error:", err);
    res.status(500).json({ error: "Failed to create workspace" });
  }
});

app.get("/api/credits", requireAuth, requireVerifiedEmail, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const workspaceId = req.query.workspace_id as string | undefined;

    const userResult = await pool.query(
      `SELECT role FROM users WHERE id = $1`,
      [userId]
    );
    const role = userResult.rows.length > 0 ? userResult.rows[0].role : "user";
    if (role === "superadmin") {
      res.json({ balance: 0, unlimited: true });
      return;
    }

    // Look up the active subscription so we can return a stable period
    // allotment (e.g. "10,000 credits / month") instead of letting the
    // denominator drift upward whenever a refund or grant fires. See
    // task #465: lifetime SUM(amount > 0) was used as the "of Y" reference
    // and grew with every refund — periodAllotment fixes that.
    const subSql = workspaceId
      ? `SELECT credits_per_period, current_period_start, current_period_end
           FROM subscriptions
          WHERE workspace_id = $1 AND status IN ('active', 'past_due')
          ORDER BY created_at DESC LIMIT 1`
      : `SELECT credits_per_period, current_period_start, current_period_end
           FROM subscriptions
          WHERE user_id = $1 AND workspace_id IS NULL AND status IN ('active', 'past_due')
          ORDER BY created_at DESC LIMIT 1`;

    if (workspaceId) {
      const wsCheck = await pool.query(
        `SELECT w.type FROM workspaces w
         JOIN workspace_members wm ON wm.workspace_id = w.id
         WHERE w.id = $1 AND wm.user_id = $2 AND w.type = 'org'`,
        [workspaceId, userId]
      );

      if (wsCheck.rows.length > 0) {
        const result = await pool.query(
          `SELECT balance FROM workspace_credits WHERE workspace_id = $1`,
          [workspaceId]
        );
        const balance = result.rows.length > 0 ? result.rows[0].balance : 0;
        const wsTotalResult = await pool.query(
          // Exclude refund rows: they're not "received credits", they're a
          // restoration of money the user already paid for. Counting them
          // here used to inflate the displayed denominator (e.g. plan cap
          // 10,000 + 589 in refunds → "of 10,589") which made it look like
          // refunds were giving users free credits above their balance.
          `SELECT COALESCE(SUM(amount), 0) as total FROM credit_ledger
           WHERE org_id = $1 AND amount > 0 AND reason NOT LIKE 'refund:%'`,
          [workspaceId]
        );
        const totalReceived = Number(wsTotalResult.rows[0]?.total || 0);
        const subRes = await pool.query(subSql, [workspaceId]);
        const periodAllotment = subRes.rows.length > 0 ? Number(subRes.rows[0].credits_per_period || 0) : 0;
        const periodUsed = periodAllotment > 0 ? Math.max(0, periodAllotment - balance) : 0;
        const bonusCredits = periodAllotment > 0 ? Math.max(0, balance - periodAllotment) : 0;
        res.json({
          balance,
          totalReceived,
          periodAllotment,
          periodUsed,
          bonusCredits,
          unlimited: false,
          workspace: true,
        });
        return;
      }
    }

    const result = await pool.query(
      `SELECT balance FROM credits WHERE user_id = $1`,
      [userId]
    );
    const balance = result.rows.length > 0 ? result.rows[0].balance : 0;
    const totalResult = await pool.query(
      // Exclude refund rows for the same reason as the workspace branch
      // above: a refund restores credits the user already paid for, it is
      // not an additional grant, so it must not bump the "of Y" denominator.
      `SELECT COALESCE(SUM(amount), 0) as total FROM credit_ledger
       WHERE user_id = $1 AND org_id IS NULL AND amount > 0 AND reason NOT LIKE 'refund:%'`,
      [userId]
    );
    const totalReceived = Number(totalResult.rows[0]?.total || 0);
    const subRes = await pool.query(subSql, [userId]);
    const periodAllotment = subRes.rows.length > 0 ? Number(subRes.rows[0].credits_per_period || 0) : 0;
    const periodUsed = periodAllotment > 0 ? Math.max(0, periodAllotment - balance) : 0;
    const bonusCredits = periodAllotment > 0 ? Math.max(0, balance - periodAllotment) : 0;
    res.json({
      balance,
      totalReceived,
      periodAllotment,
      periodUsed,
      bonusCredits,
      unlimited: false,
      workspace: false,
    });
  } catch (err: unknown) {
    console.error("Get credits error:", err);
    res.status(500).json({ error: "Failed to get credits" });
  }
});

app.get("/api/pricing", requireAuth, async (_req: AuthRequest, res) => {
  try {
    // Pricing rows + the typeMap below are the source of truth for cost
    // estimates rendered on action buttons (e.g. UpscalePanel). Browsers
    // happily cache JSON GET responses by default, which means a stale
    // pricing payload from before topaz rows existed can persist across
    // dev-server restarts and silently break the per-second cost display.
    // Force fresh fetches so estimateCost always sees the live typeMap.
    res.setHeader("Cache-Control", "no-store");
    const rows = await pool.query(
      `SELECT model_key, base_cost, resolution_multipliers, duration_multipliers, feature_surcharges
       FROM model_pricing WHERE is_active = true`
    );
    const typeMap: Record<string, string[]> = {
      text_to_image: ["nano-banana-2-t2i", "seedream-5-t2i", "seedream-t2i", "gpt-image-2-t2i"],
      image_to_image: ["nano-banana-2", "seedream-5-edit", "seedream-edit", "gpt-image-2-edit"],
      video_gen: ["gemini-omni-t2v", "gemini-omni-i2v", "kling-o3-pro-t2v", "kling-o3-pro-i2v", "kling-o3-pro-r2v", "kling-o3-4k-t2v", "kling-o3-4k-i2v", "kling-o3-4k-r2v", "veo3.1-lite-t2v", "veo3.1-lite-i2v", "veo3.1-lite-flf2v", "seedance-2.5-t2v", "seedance-2.5-i2v", "seedance-2.5-r2v", "seedance-2.0-t2v", "seedance-2.0-i2v", "seedance-2.0-r2v", "h3-max-t2v"],
      remove_bg: ["pixelcut_remove_bg", "remove_bg"],
      resize: ["bria_expand"],
      upscale: ["seedvr-upscale", "topaz-upscale-video", "topaz-upscale-video-gaia2"],
      avatar: ["kling-3.0-mc", "kling-2.6-mc"],
      text_to_vector: ["recraft-v4-vector"],
      image_to_vector: ["recraft-vectorize"],
      audio_music: ["minimax-music"],
      audio_tts: ["minimax-tts"],
      audio_sfx: ["elevenlabs-sfx"],
      audio_voice_changer: ["elevenlabs-voice-changer"],
      clearcheck: ["clearcheck"],
    };
    res.json({ rows: rows.rows, typeMap });
  } catch (err) {
    console.error("Pricing fetch error:", err);
    res.status(500).json({ error: "Failed to fetch pricing" });
  }
});

app.post("/api/estimate-cost", requireAuth, requireVerifiedEmail, async (req: AuthRequest, res) => {
  try {
    const { type, model, resolution, duration, features, quantity } = req.body;
    if (!type) {
      res.status(400).json({ error: "type is required" });
      return;
    }
    const safeQuantity = Math.max(1, Math.min(100, parseInt(quantity) || 1));
    const pricing: PricingParams = {};
    if (model) {
      const resolved = resolveModelName(type, model);
      if (resolved) pricing.modelKey = resolved;
    } else {
      const resolved = resolveModelName(type);
      if (resolved) pricing.modelKey = resolved;
    }
    if (resolution) pricing.resolution = resolution;
    if (duration) pricing.duration = duration;
    if (type === "audio_tts" && typeof req.body.characters === "number" && req.body.characters > 0) {
      pricing.characters = req.body.characters;
    }
    if (features && Array.isArray(features) && features.length > 0) pricing.features = features;
    const result = await calculateModelCost(type, safeQuantity, pricing);
    if ("error" in result) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ cost: result.totalCost, breakdown: result.breakdown });
  } catch (err: unknown) {
    console.error("Estimate cost error:", err);
    res.status(500).json({ error: "Failed to estimate cost" });
  }
});

/**
 * AT-COST fal.ai pricing — what fal actually charges, in USD, no margin.
 *
 * Deliberately a different endpoint from /api/estimate-cost (which returns
 * retail credits). The rules live server-side in config/falCost.ts because
 * several are matrices or formulas, not a multiplier table the client could
 * evaluate; the client memoises results per parameter combination instead.
 */
app.get("/api/fal-cost", requireAuth, async (_req: AuthRequest, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    models: falPricedModelKeys().map((modelKey) => ({
      modelKey,
      endpoint: falEndpointFor(modelKey),
      livePrice: unitPriceFor(modelKey) ?? null,
    })),
    status: falPricingStatus(),
  });
});

app.post("/api/fal-cost/estimate", requireAuth, async (req: AuthRequest, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [req.body];
    if (items.length > 50) {
      res.status(400).json({ error: "Too many items" });
      return;
    }
    const results = items.map((item: Record<string, unknown>) => {
      const modelKey = typeof item?.modelKey === "string" ? item.modelKey : null;
      if (!modelKey) return { modelKey: null, estimate: null };
      const duration = Number(item.duration);
      const quantity = Number(item.quantity);
      const characters = Number(item.characters);
      const megapixels = Number(item.megapixels);
      const estimate = estimateFalCost(
        modelKey,
        {
          resolution: typeof item.resolution === "string" ? item.resolution : undefined,
          features: Array.isArray(item.features) ? (item.features as string[]) : undefined,
          duration: isFinite(duration) && duration > 0 ? duration : undefined,
          quantity: isFinite(quantity) && quantity > 0 ? quantity : undefined,
          characters: isFinite(characters) && characters > 0 ? characters : undefined,
          megapixels: isFinite(megapixels) && megapixels > 0 ? megapixels : undefined,
        },
        // Live-refreshed unit price when we have one; the rule falls back to
        // its verified snapshot otherwise.
        unitPriceFor(modelKey)
      );
      return { modelKey, estimate };
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({ results });
  } catch (err) {
    console.error("Fal cost estimate error:", err);
    res.status(500).json({ error: "Failed to estimate fal cost" });
  }
});

app.get("/api/usage", requireAuth, requireVerifiedEmail, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const workspaceId = req.query.workspace_id as string | undefined;

    if (workspaceId) {
      const memberCheck = await pool.query(
        `SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
        [workspaceId, userId]
      );
      if (memberCheck.rows.length === 0) {
        res.status(403).json({ error: "Not a member of this workspace" });
        return;
      }
    }

    // Pull the active subscription's period window first. When a
    // subscription exists, ALL aggregates (jobs, agent ledger, refunds)
    // are scoped to its current period so the headline "net used"
    // reconciles with the Account panel arithmetic
    // (periodAllotment − currentBalance). When no subscription exists,
    // scope is unbounded (matches legacy behavior).
    const subPeriodSql = workspaceId
      ? `SELECT credits_per_period, current_period_start, current_period_end
           FROM subscriptions WHERE workspace_id = $1 AND status IN ('active','past_due')
           ORDER BY created_at DESC LIMIT 1`
      : `SELECT credits_per_period, current_period_start, current_period_end
           FROM subscriptions WHERE user_id = $1 AND workspace_id IS NULL AND status IN ('active','past_due')
           ORDER BY created_at DESC LIMIT 1`;
    const subPeriodRes = await pool.query(subPeriodSql, [workspaceId || userId]);
    const periodAllotment = subPeriodRes.rows.length > 0 ? Number(subPeriodRes.rows[0].credits_per_period || 0) : 0;
    const periodStart: Date | null = subPeriodRes.rows[0]?.current_period_start || null;
    const periodEnd: Date | null = subPeriodRes.rows[0]?.current_period_end || null;
    const hasPeriod = !!(periodStart && periodEnd);

    // Current balance — needed for the canonical netUsed calculation
    // when an active subscription is present.
    let currentBalance = 0;
    if (workspaceId) {
      const balRes = await pool.query(`SELECT balance FROM workspace_credits WHERE workspace_id = $1`, [workspaceId]);
      currentBalance = balRes.rows.length > 0 ? Number(balRes.rows[0].balance) : 0;
    } else {
      const balRes = await pool.query(`SELECT balance FROM credits WHERE user_id = $1`, [userId]);
      currentBalance = balRes.rows.length > 0 ? Number(balRes.rows[0].balance) : 0;
    }

    // Build job-table WHERE with optional period scoping on `created_at`.
    const conditions = ["user_id = $1"];
    const values: unknown[] = [userId];
    if (workspaceId) {
      conditions.push(`workspace_id = $${values.length + 1}`);
      values.push(workspaceId);
    }
    if (hasPeriod) {
      conditions.push(`created_at >= $${values.length + 1}`);
      values.push(periodStart!);
      conditions.push(`created_at < $${values.length + 1}`);
      values.push(periodEnd!);
    }
    const where = conditions.join(" AND ");

    const totalResult = await pool.query(
      `SELECT COALESCE(SUM(credits_charged), 0) AS total_credits, COUNT(*)::int AS total_jobs FROM jobs WHERE ${where}`,
      values
    );

    // Refunds (positive non-grant ledger adjustments) — surfaced so users
    // can reconcile gross vs net used. Period-scoped to match jobs above.
    const ledgerScopeWhere = workspaceId ? `user_id = $1 AND org_id = $2` : `user_id = $1 AND org_id IS NULL`;
    const ledgerScopeVals: unknown[] = workspaceId ? [userId, workspaceId] : [userId];
    const periodFilter = hasPeriod
      ? ` AND created_at >= $${ledgerScopeVals.length + 1} AND created_at < $${ledgerScopeVals.length + 2}`
      : "";
    const periodVals = hasPeriod ? [periodStart!, periodEnd!] : [];

    const refundsRes = await pool.query(
      `SELECT COALESCE(SUM(amount), 0)::bigint AS refunds, COUNT(*)::int AS refund_count
         FROM credit_ledger
        WHERE ${ledgerScopeWhere}
          AND amount > 0
          AND reason LIKE 'refund:%'
          ${periodFilter}`,
      [...ledgerScopeVals, ...periodVals]
    );
    const refundsTotal = Number(refundsRes.rows[0]?.refunds || 0);

    // Recent refund entries (non-agent only — agent refunds are folded
    // into per-turn aggregation below via reference_id).
    const recentRefundsRes = await pool.query(
      `SELECT id, reason, amount, reference_id, metadata, created_at
         FROM credit_ledger
        WHERE ${ledgerScopeWhere}
          AND amount > 0
          AND reason LIKE 'refund:%'
          AND reason NOT LIKE 'refund:agent_chat%'
          ${periodFilter}
        ORDER BY created_at DESC
        LIMIT 10`,
      [...ledgerScopeVals, ...periodVals]
    );
    const byTypeResult = await pool.query(
      `SELECT type, COALESCE(SUM(credits_charged), 0) AS credits, COUNT(*)::int AS count FROM jobs WHERE ${where} GROUP BY type ORDER BY credits DESC`,
      values
    );
    const byModelResult = await pool.query(
      `SELECT model, type, COALESCE(SUM(credits_charged), 0) AS credits, COUNT(*)::int AS count
       FROM jobs WHERE ${where} AND model IS NOT NULL AND model <> ''
       GROUP BY model, type
       ORDER BY credits DESC`,
      values
    );
    const recentResult = await pool.query(
      `SELECT id, model, type, COALESCE(credits_charged, 0) AS credits_charged, created_at
       FROM jobs WHERE ${where}
       ORDER BY created_at DESC
       LIMIT 10`,
      values
    );

    // Agent chat doesn't write to the `jobs` table — credits are charged
    // directly via the credit_ledger using checkAndDebit / refund helpers.
    // Merge those entries into /api/usage so Claude Sonnet/Haiku activity
    // shows up in the user-facing usage screen.
    //
    // Attribution rule: roll up every related ledger row (reservation +
    // refund + settlement) by `reference_id` and pick the model from the
    // *reservation* row's metadata. The reservation always has metadata;
    // refund rows only have metadata for newer turns (see
    // refundCreditsWithFallback metadata plumbing). This keeps refunds
    // from getting attributed to `unknown` and inflating Sonnet's net
    // cost — the requirement that the model usage screen show the right
    // totals depends on this.
    // Agent ledger is scoped the same way as jobs: by user/workspace and,
    // if a subscription exists, by the current period window. We also
    // split *gross debits* (reservations) from *refunds* on this side so
    // grossCharged is true gross (not net of agent refunds).
    const agentVals: unknown[] = [userId];
    const agentConds = ["cl.user_id = $1"];
    if (workspaceId) {
      agentConds.push(`cl.org_id = $${agentVals.length + 1}`);
      agentVals.push(workspaceId);
    }
    if (hasPeriod) {
      agentConds.push(`cl.created_at >= $${agentVals.length + 1}`);
      agentVals.push(periodStart!);
      agentConds.push(`cl.created_at < $${agentVals.length + 1}`);
      agentVals.push(periodEnd!);
    }
    const ledgerWhereCl = agentConds.join(" AND ");
    const agentReasonClause = `(
      reason = 'generation:agent_chat'
      OR reason = 'agent_chat_settlement'
      OR reason LIKE 'refund:agent_chat%'
    )`;

    const perTurnSql = `
      WITH agent_rows AS (
        SELECT reference_id, amount, reason, metadata, created_at
          FROM credit_ledger cl
         WHERE ${ledgerWhereCl}
           AND ${agentReasonClause}
           AND reference_id IS NOT NULL
      ),
      per_turn AS (
        SELECT
          ar.reference_id,
          SUM(-ar.amount)::bigint AS net_credits,
          SUM(CASE WHEN ar.amount < 0 THEN -ar.amount ELSE 0 END)::bigint AS gross_debits,
          SUM(CASE WHEN ar.amount > 0 THEN ar.amount ELSE 0 END)::bigint AS refund_credits,
          MIN(ar.created_at) AS first_at,
          MAX(CASE WHEN ar.reason = 'generation:agent_chat'
                   THEN COALESCE(ar.metadata->>'model', 'unknown')
                   ELSE NULL END) AS reservation_model,
          MAX(COALESCE(ar.metadata->>'model', NULL)) AS any_model
          FROM agent_rows ar
         GROUP BY ar.reference_id
      )
      SELECT reference_id,
             net_credits,
             gross_debits,
             refund_credits,
             first_at,
             COALESCE(reservation_model, any_model, 'unknown') AS model
        FROM per_turn
    `;

    const [agentLedgerByModel, agentLedgerTotal, agentLedgerRecent] = await Promise.all([
      pool.query(
        `SELECT model, SUM(net_credits)::bigint AS credits, COUNT(*)::int AS count
           FROM (${perTurnSql}) t
          GROUP BY model`,
        agentVals
      ),
      pool.query(
        `SELECT COALESCE(SUM(net_credits), 0)::bigint AS total_credits,
                COALESCE(SUM(gross_debits), 0)::bigint AS total_gross,
                COALESCE(SUM(refund_credits), 0)::bigint AS total_refunds,
                COUNT(*)::int AS total_turns
           FROM (${perTurnSql}) t`,
        agentVals
      ),
      pool.query(
        `SELECT reference_id AS id,
                model,
                'agent_chat' AS type,
                net_credits AS credits_charged,
                first_at AS created_at
           FROM (${perTurnSql}) t
          ORDER BY first_at DESC
          LIMIT 10`,
        agentVals
      ),
    ]);

    const modelGroupsMap = new Map<
      string,
      {
        model: string;
        total_credits: number;
        total_count: number;
        variations: { type: string; credits: number; count: number }[];
      }
    >();
    for (const r of byModelResult.rows) {
      const credits = Number(r.credits);
      const count = Number(r.count);
      let group = modelGroupsMap.get(r.model);
      if (!group) {
        group = { model: r.model, total_credits: 0, total_count: 0, variations: [] };
        modelGroupsMap.set(r.model, group);
      }
      group.variations.push({ type: r.type, credits, count });
      group.total_credits += credits;
      group.total_count += count;
    }
    for (const r of agentLedgerByModel.rows) {
      const credits = Number(r.credits);
      const count = Number(r.count);
      if (credits === 0 && count === 0) continue;
      let group = modelGroupsMap.get(r.model);
      if (!group) {
        group = { model: r.model, total_credits: 0, total_count: 0, variations: [] };
        modelGroupsMap.set(r.model, group);
      }
      group.variations.push({ type: "agent_chat", credits, count });
      group.total_credits += credits;
      group.total_count += count;
    }
    const byModel = Array.from(modelGroupsMap.values()).sort(
      (a, b) => b.total_credits - a.total_credits || b.total_count - a.total_count
    );
    for (const g of byModel) {
      g.variations.sort((a, b) => b.credits - a.credits || b.count - a.count);
    }

    // Merge the agent_chat row into by_type as well so the type breakdown
    // mirrors the model breakdown.
    const byType = byTypeResult.rows.map((r) => ({
      type: r.type as string,
      credits: Number(r.credits),
      count: Number(r.count),
    }));
    const agentTotalCredits = Number(agentLedgerTotal.rows[0]?.total_credits ?? 0);
    const agentTotalGross = Number(agentLedgerTotal.rows[0]?.total_gross ?? 0);
    const agentTotalTurns = Number(agentLedgerTotal.rows[0]?.total_turns ?? 0);
    if (agentTotalTurns > 0) {
      byType.push({ type: "agent_chat", credits: agentTotalCredits, count: agentTotalTurns });
      byType.sort((a, b) => b.credits - a.credits);
    }

    // Merge recent: combine job recents, agent recents, and refund recents.
    // Refund rows show up as a distinct "refund" type so the UI can label
    // them separately and so the user can reconcile gross vs net used.
    const recent = [
      ...recentResult.rows.map((r) => ({
        id: r.id as string,
        model: r.model as string | null,
        type: r.type as string,
        credits_charged: Number(r.credits_charged),
        created_at: r.created_at as Date,
      })),
      ...agentLedgerRecent.rows.map((r) => ({
        id: r.id as string,
        model: r.model as string | null,
        type: r.type as string,
        credits_charged: Number(r.credits_charged),
        created_at: r.created_at as Date,
      })),
      ...recentRefundsRes.rows.map((r) => ({
        id: r.id as string,
        model: (r.metadata?.model as string | undefined) ?? null,
        // Strip the "refund:" prefix so the UI can show e.g. "fal_failure".
        type: `refund:${(r.reason as string).replace(/^refund:/, "")}`,
        credits_charged: -Number(r.amount),
        created_at: r.created_at as Date,
      })),
    ]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 10);

    // True gross: jobs.credits_charged (gross by construction; refunds
    // don't decrement it) + agent reservation debits (gross_debits, the
    // sum of negative ledger entries flipped positive — refunds excluded).
    // refundsTotal includes BOTH agent-chat refunds and non-agent refunds,
    // so gross − refunds gives the in-period net activity.
    const jobsGross = Number(totalResult.rows[0].total_credits);
    const grossCharged = jobsGross + agentTotalGross;
    // Canonical net used: when an active subscription period is in scope,
    // derive from the same source as the Account panel
    // (periodAllotment − currentBalance) so the two screens reconcile to
    // the credit. Otherwise (no active sub) fall back to the activity-
    // derived value.
    const netUsed = hasPeriod
      ? Math.max(0, periodAllotment - currentBalance)
      : Math.max(0, grossCharged - refundsTotal);

    res.json({
      total_credits: jobsGross + agentTotalCredits,
      total_jobs: Number(totalResult.rows[0].total_jobs) + agentTotalTurns,
      gross_charged: grossCharged,
      refunds: refundsTotal,
      net_used: netUsed,
      period_allotment: periodAllotment,
      period_start: periodStart,
      period_end: periodEnd,
      by_type: byType,
      by_model: byModel,
      recent,
    });
  } catch (err: unknown) {
    console.error("Get usage error:", err);
    res.status(500).json({ error: "Failed to get usage" });
  }
});

const falUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

app.post("/api/upload-to-fal", requireAuth, requireVerifiedEmail, falUpload.single("file"), async (req: AuthRequest, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: "No file provided" });
      return;
    }

    const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/svg+xml"];
    const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"];
    const allAllowed = [...ALLOWED_IMAGE_TYPES, ...ALLOWED_VIDEO_TYPES];
    const mime = req.file.mimetype;

    if (!allAllowed.includes(mime)) {
      res.status(400).json({ error: `Unsupported file type: ${mime}` });
      return;
    }

    const isImage = ALLOWED_IMAGE_TYPES.includes(mime);
    const maxSize = isImage ? 10 * 1024 * 1024 : 100 * 1024 * 1024;
    if (req.file.size > maxSize) {
      res.status(400).json({ error: `File too large. Max ${isImage ? "10 MB" : "100 MB"}.` });
      return;
    }

    const ext = mime === "video/quicktime" ? "mov" : mime === "image/svg+xml" ? "svg" : mime.split("/")[1];
    const file = new File([req.file.buffer], `upload.${ext}`, { type: mime });
    const url = await fal.storage.upload(file);

    res.json({ url });
  } catch (err: unknown) {
    console.error("Upload to fal error:", err);
    res.status(500).json({ error: "Failed to upload file" });
  }
});

app.post("/api/gif-maker/create", requireAuth, requireVerifiedEmail, falUpload.single("file"), async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const canvasId = req.body.canvas_id;
  let debitResult: { success: boolean; cost?: number; ledgerId?: string; [k: string]: unknown } | null = null;
  try {
    if (!req.file) {
      res.status(400).json({ error: "File is required" });
      return;
    }
    if (!canvasId) {
      res.status(400).json({ error: "canvas_id is required" });
      return;
    }

    const gifWorkspaceId = req.body.workspace_id;
    debitResult = await checkAndDebit(userId, "gif_maker", 1, undefined, gifWorkspaceId || undefined);
    if (!debitResult.success) {
      const status = debitResult.retryAfterSeconds ? 429 : debitResult.required ? 402 : 400;
      res.status(status).json({
        error: debitResult.error,
        required: debitResult.required,
        balance: debitResult.balance,
        retryAfterSeconds: debitResult.retryAfterSeconds,
      });
      return;
    }

    const file = new File([req.file.buffer], `gif-${Date.now()}.gif`, { type: "image/gif" });
    const url = await fal.storage.upload(file);

    const canvasCheck = await pool.query(
      `SELECT id FROM canvas_states WHERE id = $1 AND user_id = $2`,
      [canvasId, userId]
    );
    if (canvasCheck.rows.length === 0) {
      console.warn(`[gif-maker] canvas ${canvasId} not owned by user ${userId}, skipping placement`);
    }

    res.json({ success: true, url });
  } catch (err) {
    console.error("GIF maker error:", err);
    if (debitResult && debitResult.success && debitResult.cost && debitResult.cost > 0) {
      await refundCreditsWithFallback(userId, debitResult.cost, "gif_maker_failed", debitResult.ledgerId as string, gifWorkspaceId || undefined);
    }
    res.status(500).json({ error: "GIF creation failed" });
  }
});


app.get("/api/seedance/verification", requireAuth, async (req: AuthRequest, res) => {
  try {
    const result = await pool.query(
      `SELECT country_code FROM seedance_verified_users WHERE user_id = $1`,
      [req.userId]
    );
    if (result.rows.length > 0) {
      res.json({ verified: true, country_code: result.rows[0].country_code });
    } else {
      res.json({ verified: false });
    }
  } catch (err) {
    console.error("[seedance] verification check error:", err);
    res.status(500).json({ error: "Failed to check verification status" });
  }
});

app.post("/api/seedance/verify", requireAuth, async (req: AuthRequest, res) => {
  try {
    const { full_legal_name, business_name, business_email, country_code } = req.body;
    if (!full_legal_name || !business_name || !business_email || !country_code) {
      res.status(400).json({ error: "All fields are required: full_legal_name, business_name, business_email, country_code" });
      return;
    }
    const cc = String(country_code).trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(cc)) {
      res.status(400).json({ error: "Invalid country code. Must be a 2-letter ISO code." });
      return;
    }
    const blocked = ["US", "JP"];
    if (blocked.includes(cc)) {
      res.status(403).json({ error: "Seedance 2.0 is not available in your region (US/Japan)" });
      return;
    }
    await pool.query(
      `INSERT INTO seedance_verified_users (user_id, full_legal_name, business_name, business_email, country_code)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE SET
         full_legal_name = EXCLUDED.full_legal_name,
         business_name = EXCLUDED.business_name,
         business_email = EXCLUDED.business_email,
         country_code = EXCLUDED.country_code,
         verified_at = NOW()`,
      [req.userId, String(full_legal_name).trim(), String(business_name).trim(), String(business_email).trim(), cc]
    );
    res.json({ verified: true, country_code: cc });
  } catch (err) {
    console.error("[seedance] verify error:", err);
    res.status(500).json({ error: "Failed to save verification" });
  }
});

const MINIMAX_VOICE_IDS = new Set([
  "Wise_Woman", "Friendly_Person", "Inspirational_girl", "Deep_Voice_Man",
  "Calm_Woman", "Casual_Guy", "Lively_Girl", "Patient_Man", "Young_Knight",
  "Determined_Man", "Lovely_Girl", "Decent_Boy", "Imposing_Manner",
  "Elegant_Man", "Abbess", "Sweet_Girl_2", "Exuberant_Girl",
]);
const ttsPreviewCache = new Map<string, string>();
const ttsPreviewGenerating = new Map<string, Promise<string>>();

async function generateVoicePreview(voiceId: string): Promise<string> {
  const sampleText = "Hello! This is a preview of how this voice sounds. I hope you enjoy it.";
  if (!ensureFalConfigured()) {
    throw new Error("No fal.ai API key configured. Add your key in Settings.");
  }
  const result = await fal.subscribe("fal-ai/minimax/speech-2.8-hd", {
    input: {
      prompt: sampleText,
      voice_setting: { voice_id: voiceId, speed: 1.0 },
      output_format: "url",
    },
  });
  type FalTtsResult = {
    data?: { audio?: { url?: string }; url?: string };
    audio?: { url?: string };
    url?: string;
  };
  const typed = result as FalTtsResult;
  const audio = typed.data?.audio ?? typed.audio;
  const audioUrl = audio?.url || typed.data?.url || typed.url;
  if (!audioUrl) throw new Error("No audio URL returned");

  const audioResp = await fetch(audioUrl);
  const audioBuffer = Buffer.from(await audioResp.arrayBuffer());
  const ext = audioUrl.includes(".wav") ? "wav" : "mp3";
  const r2Path = `tts-previews/${voiceId}.${ext}`;
  const permanentUrl = await saveFile("shared", r2Path, audioBuffer);

  await pool.query(
    `INSERT INTO tts_voice_previews (voice_id, url) VALUES ($1, $2) ON CONFLICT (voice_id) DO UPDATE SET url = $2`,
    [voiceId, permanentUrl]
  );
  ttsPreviewCache.set(voiceId, permanentUrl);
  return permanentUrl;
}

(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tts_voice_previews (
        voice_id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    const { rows } = await pool.query(`SELECT voice_id, url FROM tts_voice_previews`);
    for (const row of rows) {
      ttsPreviewCache.set(row.voice_id, row.url);
    }
    console.log(`[tts-preview] Loaded ${rows.length} cached voice previews`);

    const missing = [...MINIMAX_VOICE_IDS].filter((id) => !ttsPreviewCache.has(id));
    if (missing.length > 0 && !ensureFalConfigured()) {
      // No fal key yet (common on a fresh local install). Skip the boot-time
      // pre-generation instead of firing N failing fal calls + stack traces;
      // previews are generated lazily once the user adds a key in Settings.
      console.log(`[tts-preview] Skipping pre-generation of ${missing.length} previews — no fal.ai key configured yet.`);
    } else if (missing.length > 0) {
      console.log(`[tts-preview] Pre-generating ${missing.length} missing voice previews...`);
      (async () => {
        for (const voiceId of missing) {
          try {
            await generateVoicePreview(voiceId);
            console.log(`[tts-preview] Generated preview for ${voiceId} (${ttsPreviewCache.size}/${MINIMAX_VOICE_IDS.size})`);
          } catch (err) {
            console.error(`[tts-preview] Failed to generate preview for ${voiceId}:`, err);
          }
        }
        console.log(`[tts-preview] Pre-generation complete. ${ttsPreviewCache.size}/${MINIMAX_VOICE_IDS.size} voices cached.`);
      })();
    }
  } catch (err) {
    console.error("[tts-preview] Failed to init cache table:", err);
  }
})();

app.get("/api/tts-previews", async (_req, res) => {
  const previews: Record<string, string> = {};
  for (const [voiceId, url] of ttsPreviewCache) {
    previews[voiceId] = url;
  }
  res.json({ previews });
});

app.get("/api/tts-preview", requireAuth, async (req: AuthRequest, res) => {
  try {
    const voiceId = (req.query.voice_id as string) || "Friendly_Person";
    if (!MINIMAX_VOICE_IDS.has(voiceId)) {
      res.status(400).json({ error: "Invalid voice ID" });
      return;
    }

    const cached = ttsPreviewCache.get(voiceId);
    if (cached) {
      res.json({ url: cached });
      return;
    }

    let generatePromise = ttsPreviewGenerating.get(voiceId);
    if (!generatePromise) {
      generatePromise = generateVoicePreview(voiceId).finally(() => {
        ttsPreviewGenerating.delete(voiceId);
      });
      ttsPreviewGenerating.set(voiceId, generatePromise);
    }

    const url = await generatePromise;
    res.json({ url });
  } catch (err) {
    console.error("[tts-preview] Error:", err);
    res.status(500).json({ error: "Preview generation failed" });
  }
});

app.post("/api/generate", requireAuth, requireVerifiedEmail, async (req: AuthRequest, res) => {
  let debitResult: { success: boolean; cost?: number; ledgerId?: string; [k: string]: unknown } | null = null;
  const userId = req.userId!;
  const preGeneratedJobId = uuidv4();
  try {
    const { type, params, workspace_id } = req.body;
    if (!type) {
      res.status(400).json({ error: "type is required" });
      return;
    }

    const imageNumber = parseInt(req.body.imageNumber) || 1;
    const quantity = (type === "text_to_image" || type === "image_to_image") ? imageNumber : 1;

    const pricingParams: PricingParams = {};
    const FAL_TYPES_SET = new Set(["text_to_image", "image_to_image", "video_gen", "remove_bg", "resize", "upscale", "avatar", "text_to_vector", "image_to_vector", "audio_music", "audio_tts", "audio_sfx", "audio_voice_changer"]);
    if (FAL_TYPES_SET.has(type)) {
      const preResolvedModel = resolveModelName(type, req.body.model);
      if (preResolvedModel) pricingParams.modelKey = preResolvedModel;
    }
    if (req.body.resolution) pricingParams.resolution = req.body.resolution;
    if (req.body.duration) pricingParams.duration = req.body.duration;
    if (type === "audio_tts" && typeof req.body.text === "string" && req.body.text.length > 0) {
      pricingParams.characters = req.body.text.length;
    }
    const activeFeatures: string[] = [];
    if (req.body.webSearch) activeFeatures.push("web_search");
    if (req.body.highThinking) activeFeatures.push("high_thinking");
    if (req.body.generateAudio) activeFeatures.push("generate_audio");
    if (req.body.quality === "low") activeFeatures.push("quality_low");
    else if (req.body.quality === "medium") activeFeatures.push("quality_medium");
    if (activeFeatures.length > 0) pricingParams.features = activeFeatures;

    if (type === "avatar") {
      if (req.body.ref_video_duration) {
        const refDur = Number(req.body.ref_video_duration);
        if (!isNaN(refDur) && refDur > 0) {
          pricingParams.duration = String(refDur);
        }
      } else {
        console.warn("[pricing] Avatar generation missing ref_video_duration, using base cost only");
      }
    }

    debitResult = await checkAndDebit(userId, type, quantity, preGeneratedJobId, workspace_id || undefined, pricingParams);
    if (!debitResult.success) {
      const status = debitResult.retryAfterSeconds ? 429 : debitResult.required ? 402 : 400;
      res.status(status).json({
        error: debitResult.error,
        required: debitResult.required,
        balance: debitResult.balance,
        retryAfterSeconds: debitResult.retryAfterSeconds,
      });
      return;
    }

    const FAL_TYPES = new Set(["text_to_image", "image_to_image", "video_gen", "remove_bg", "resize", "upscale", "avatar", "text_to_vector", "image_to_vector", "audio_music", "audio_tts", "audio_sfx", "audio_voice_changer"]);
    let resolvedModel: string | null = null;
    if (FAL_TYPES.has(type)) {
      resolvedModel = resolveModelName(type, req.body.model);
      if (!resolvedModel) {
        if (debitResult.cost > 0) {
          await refundCreditsWithFallback(userId, debitResult.cost, "invalid_model", preGeneratedJobId, workspace_id || undefined);
        }
        res.status(400).json({ error: "Invalid model for this generation type" });
        return;
      }
    }
    // Seedance 2.0 region/business-verification gate removed (2026-05) —
    // the model is no longer region-restricted by the provider. The
    // `seedance_verified_users` table is intentionally kept in case the
    // gate needs to come back.

    const fullParams: Record<string, unknown> = {
      ...(params || {}),
      prompt: req.body.prompt || params?.prompt || "",
      ...(resolvedModel ? { model: resolvedModel } : {}),
    };

    if (resolvedModel && resolvedModel.startsWith("seedance-")) {
      fullParams.end_user_id = userId;
    }

    // `@elementN` reference tags are only meaningful on Kling O3 r2v
    // endpoints (reference-to-video). Every other variant — Kling i2v / t2v,
    // Veo, Seedance — silently rejects them with "Invalid reference index N
    // for element. Only 0 elements provided." because those endpoints don't
    // ship an `image_urls` array. Strip the tags from the dispatched prompt
    // as a safety net so a stray `@element1` left behind by the agent (or
    // typed by the user in the right-panel prompt while picking i2v mode)
    // doesn't fail the whole job. The `\b` keeps `@elementary` untouched.
    if (
      type === "video_gen" &&
      typeof fullParams.prompt === "string" &&
      !(typeof resolvedModel === "string" && resolvedModel.startsWith("kling-o3-") && resolvedModel.endsWith("-r2v"))
    ) {
      const original = fullParams.prompt as string;
      if (/@element\d+\b/i.test(original)) {
        fullParams.prompt = original
          .replace(/@element\d+\b/gi, "")
          .replace(/[ \t]{2,}/g, " ")
          .trim();
      }
    }

    if (req.body.resolution) fullParams.resolution = req.body.resolution;
    if (req.body.imageNumber) fullParams.imageNumber = req.body.imageNumber;
    // NOTE (local build): fal.ai fetches reference image URLs from its own
    // servers, so localhost "/uploads/..." references are not remotely
    // reachable. Base generation works; local reference images need uploading
    // to fal.storage or inlining as data URIs — see CONVERSION.md.
    const baseUrl = process.env.APP_URL || `${req.protocol}://${req.get("host") || "localhost:5000"}`;
    if (req.body.referenceImageUrls) {
      fullParams.referenceImageUrls = (req.body.referenceImageUrls as string[]).map((url: string) => {
        if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("data:")) return url;
        return `${baseUrl}${url.startsWith("/") ? "" : "/"}${url}`;
      });
    }
    // Continuation references for chunk-chained long-form video. Same
    // absolutize treatment as the image refs: an extracted tail is written to
    // local uploads, so it arrives here as "/uploads/..." and fal can't fetch a
    // relative path.
    if (req.body.referenceVideoUrls) {
      fullParams.referenceVideoUrls = (req.body.referenceVideoUrls as string[]).map((url: string) => {
        if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("data:")) return url;
        return `${baseUrl}${url.startsWith("/") ? "" : "/"}${url}`;
      });
    }
    if (req.body.duration) fullParams.duration = req.body.duration;
    if (req.body.generateAudio !== undefined) fullParams.generateAudio = req.body.generateAudio;
    if (req.body.firstFrameUrl) {
      const url = req.body.firstFrameUrl as string;
      fullParams.firstFrameUrl = (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("data:")) ? url : `${baseUrl}${url.startsWith("/") ? "" : "/"}${url}`;
    }
    if (req.body.lastFrameUrl) {
      const url = req.body.lastFrameUrl as string;
      fullParams.lastFrameUrl = (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("data:")) ? url : `${baseUrl}${url.startsWith("/") ? "" : "/"}${url}`;
    }
    if (req.body.aspect_ratio || params?.aspect_ratio) fullParams.aspect_ratio = req.body.aspect_ratio || params?.aspect_ratio;

    // Pre-flight: Kling video models reject reference images whose long edge
    // is more than 2.5x the short edge (a fal.ai-side hard limit, allowed
    // range [0.4, 2.5]). Probe the supplied refs with a short timeout and
    // fail early with a clear, refundable error so the user understands why
    // — otherwise the cryptic image_aspect_ratio_error only surfaces after
    // dispatch. We read from fullParams so refs that arrived via the spread
    // `params` (not just top-level fields) are also covered, and only
    // target the i2v/r2v Kling video models that actually consume image
    // refs (motion-control avatar models use image_url/video_url instead).
    // Probe failures are non-blocking; if we can't read the image, let
    // fal.ai be the source of truth.
    const KLING_REF_MODELS = new Set([
      "kling-o3-pro-i2v", "kling-o3-pro-r2v",
      "kling-o3-4k-i2v", "kling-o3-4k-r2v",
    ]);
    if (resolvedModel && KLING_REF_MODELS.has(resolvedModel)) {
      const KLING_MAX_RATIO = 2.5;
      // Strip IPv6 brackets so a URL like http://[::1]/x compares cleanly,
      // and lower-case once. We classify hostnames conservatively — anything
      // that looks like a loopback/link-local/private IP literal or an
      // internal-looking hostname is rejected before we issue an outbound
      // probe request.
      const isPrivateHost = (rawHost: string): boolean => {
        let h = rawHost.toLowerCase();
        if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
        // Hostname-style internal markers
        if (h === "localhost" || h === "0.0.0.0" || h === "0") return true;
        if (h.endsWith(".local") || h.endsWith(".internal")) return true;
        // IPv4 loopback (full 127/8) + RFC1918 + link-local + CGNAT (100.64/10)
        if (/^127\./.test(h)) return true;
        if (/^10\./.test(h)) return true;
        if (/^192\.168\./.test(h)) return true;
        if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
        if (/^169\.254\./.test(h)) return true;
        if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true;
        // IPv6 loopback / unspecified / link-local / unique-local
        if (h === "::" || h === "::1") return true;
        if (/^fe[89ab][0-9a-f]:/i.test(h)) return true; // fe80::/10 link-local
        if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true; // fc00::/7 unique-local
        // IPv4-mapped IPv6 loopback (::ffff:127.x.x.x and ::ffff:7f00:*)
        if (/^::ffff:127\./i.test(h)) return true;
        if (/^::ffff:7f[0-9a-f]{2}:/i.test(h)) return true;
        return false;
      };
      const isProbeable = (url: string): boolean => {
        if (url.startsWith("data:")) return false; // probe can't fetch data: URIs anyway
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
          if (isPrivateHost(parsed.hostname)) return false;
          return true;
        } catch {
          return false;
        }
      };
      // Absolutize relative refs and WRITE BACK into fullParams so the
      // probe path and the dispatch path operate on the same canonical
      // URLs. Without this, refs that arrived only via the spread `params`
      // object would be probed pre-flight as absolute but then dropped by
      // fal.ts's sanitizeUrl at dispatch (which rejects relative values).
      const absolutize = (raw: unknown): string | null => {
        const cleaned = typeof raw === "string" ? raw.trim() : "";
        if (!cleaned) return null;
        if (cleaned.startsWith("http://") || cleaned.startsWith("https://") || cleaned.startsWith("data:")) {
          return sanitizeUrl(cleaned) || null;
        }
        const abs = `${baseUrl}${cleaned.startsWith("/") ? "" : "/"}${cleaned}`;
        return sanitizeUrl(abs) || null;
      };
      const firstFrame = absolutize(fullParams.firstFrameUrl);
      if (firstFrame) fullParams.firstFrameUrl = firstFrame;
      const lastFrame = absolutize(fullParams.lastFrameUrl);
      if (lastFrame) fullParams.lastFrameUrl = lastFrame;
      for (const key of ["referenceImageUrls", "referenceVideoUrls"] as const) {
        if (!Array.isArray(fullParams[key])) continue;
        const absRefs: string[] = [];
        for (const r of fullParams[key] as unknown[]) {
          const u = absolutize(r);
          if (u) absRefs.push(u);
        }
        fullParams[key] = absRefs;
      }
      const candidates: string[] = [];
      if (firstFrame && isProbeable(firstFrame)) candidates.push(firstFrame);
      if (lastFrame && isProbeable(lastFrame)) candidates.push(lastFrame);
      if (Array.isArray(fullParams.referenceImageUrls)) {
        for (const u of fullParams.referenceImageUrls as string[]) {
          if (isProbeable(u)) candidates.push(u);
        }
      }
      let offender: { width: number; height: number } | null = null;
      for (const url of candidates) {
        try {
          const probed = await Promise.race([
            probe(url),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("probe timeout")), 4000)),
          ]);
          if (!probed?.width || !probed?.height) continue;
          const long = Math.max(probed.width, probed.height);
          const short = Math.min(probed.width, probed.height);
          if (short > 0 && long / short > KLING_MAX_RATIO) {
            offender = { width: probed.width, height: probed.height };
            break;
          }
        } catch {
          // Probe failure is non-blocking — fal.ai will surface the real
          // error if the image is actually invalid.
        }
      }
      if (offender) {
        if (debitResult.cost > 0) {
          await refundCreditsWithFallback(userId, debitResult.cost, "kling_aspect_ratio", preGeneratedJobId, workspace_id || undefined);
        }
        res.status(400).json({
          error: `Kling needs reference images between 1:2.5 and 2.5:1 (yours is ${offender.width}×${offender.height}). Try cropping closer to a standard ratio.`,
        });
        return;
      }
    }

    if (req.body.upscale_factor) fullParams.upscale_factor = req.body.upscale_factor;

    if (req.body.image_url) fullParams.image_url = req.body.image_url;
    if (req.body.video_url) fullParams.video_url = req.body.video_url;
    if (req.body.target_fps !== undefined) fullParams.target_fps = req.body.target_fps;
    if (req.body.character_orientation) fullParams.character_orientation = req.body.character_orientation;
    if (req.body.keep_original_sound !== undefined) fullParams.keep_original_sound = req.body.keep_original_sound;
    if (req.body.style) fullParams.style = req.body.style;
    if (req.body.image_size) fullParams.image_size = req.body.image_size;
    if (req.body.colors) fullParams.colors = req.body.colors;
    if (req.body.lyrics !== undefined) fullParams.lyrics = req.body.lyrics;
    if (req.body.is_instrumental !== undefined) fullParams.is_instrumental = req.body.is_instrumental;
    if (req.body.text) fullParams.text = req.body.text;
    if (req.body.voice) fullParams.voice = req.body.voice;
    if (req.body.speed) fullParams.speed = req.body.speed;
    if (req.body.stability) fullParams.stability = req.body.stability;
    if (req.body.similarity_boost) fullParams.similarity_boost = req.body.similarity_boost;
    if (req.body.emotion) fullParams.emotion = req.body.emotion;
    if (req.body.duration_seconds !== undefined) fullParams.duration_seconds = req.body.duration_seconds;
    if (req.body.prompt_influence !== undefined) fullParams.prompt_influence = req.body.prompt_influence;
    if (req.body.audio_url) fullParams.audio_url = req.body.audio_url;
    if (req.body.quality) fullParams.quality = req.body.quality;

    if (type === "avatar") {
      if (!fullParams.image_url || !fullParams.video_url) {
        if (debitResult.cost > 0) {
          await refundCreditsWithFallback(userId, debitResult.cost, "validation_failed", preGeneratedJobId, workspace_id || undefined);
        }
        res.status(400).json({ error: "Avatar generation requires both a character image and a reference video" });
        return;
      }
    }

    // Video-targeted upscale (Topaz) consumes `video_url` instead of an image
    // reference array — short-circuit the image-ref validation/rehost loop in
    // that case. The fal model's buildInput will validate the URL itself.
    const isVideoUpscale = type === "upscale" && typeof fullParams.video_url === "string" && (fullParams.video_url as string).length > 0;
    if (isVideoUpscale) {
      // Per-second pricing requires a positive duration. Reject (and refund)
      // rather than silently bill the base × resolution multiplier with no
      // duration term — that path would underbill long videos and contradict
      // the fal pricing schedule.
      const durRaw = fullParams.duration;
      const durNum = typeof durRaw === "number" ? durRaw : typeof durRaw === "string" ? parseFloat(durRaw) : NaN;
      if (!Number.isFinite(durNum) || durNum <= 0) {
        if (debitResult.cost > 0) {
          await refundCreditsWithFallback(userId, debitResult.cost, "missing_video_duration", preGeneratedJobId, workspace_id || undefined);
        }
        res.status(400).json({ error: "Video duration is required to price video upscale jobs. Please reselect the video and try again." });
        return;
      }
    }
    if (!isVideoUpscale && (type === "image_to_image" || type === "remove_bg" || type === "resize" || type === "upscale")) {
      const rawUrls = fullParams.referenceImageUrls as string[] | undefined;
      const validUrls = (rawUrls || []).map(sanitizeUrl).filter((u): u is string => !!u);
      if (validUrls.length === 0) {
        if (debitResult.cost > 0) {
          await refundCreditsWithFallback(userId, debitResult.cost, "no_valid_images", preGeneratedJobId, workspace_id || undefined);
        }
        res.status(400).json({ error: "No valid reference images provided for this generation type" });
        return;
      }
      // Backfill: any reference still pointing at a fal.media (or other non-R2)
      // URL is a leftover from before we started persisting results to R2.
      // Re-host now so the upcoming fal request gets a stable, fetchable URL,
      // and patch the matching canvas_node so the refresh self-heals too. If
      // the source URL is unreachable (e.g. fal CDN expired), surface a clear
      // error instead of letting fal blow up downstream with a base64 message.
      const rehosted: string[] = [];
      for (const u of validUrls) {
        if (u.startsWith("data:") || isR2HostedUrl(u)) {
          rehosted.push(u);
          continue;
        }
        // LOCAL_MODE: references on the user's own disk (served over loopback
        // "/uploads/...") are already durable and must NOT go through the
        // SSRF-guarded rehoster, which rejects loopback hosts. Leave them
        // as-is; dispatchToFal uploads them to fal.storage at generation time.
        if (LOCAL_MODE && isLocalUploadsUrl(u)) {
          rehosted.push(u);
          continue;
        }
        try {
          const r2Url = await rehostExternalUrlToR2(u, "generations", `references/${userId}`);
          rehosted.push(r2Url);
          if (r2Url !== u) {
            try {
              // Scope by ownership so a colliding URL can't mutate nodes
               // belonging to other users / workspaces.
              await pool.query(
                `UPDATE canvas_nodes
                    SET src = $1, updated_at = NOW()
                  WHERE src = $2
                    AND canvas_id IN (SELECT id FROM canvas_states WHERE user_id = $3)`,
                [r2Url, u, userId]
              );
            } catch (patchErr) {
              console.warn("[generate] backfill: failed to patch canvas_nodes src:", patchErr);
            }
          }
        } catch (rehostErr) {
          console.error(`[generate] backfill: failed to rehost reference URL ${u}:`, rehostErr instanceof Error ? rehostErr.message : rehostErr);
          // Self-heal: stamp the matching canvas node(s) with a metadata flag
          // so the canvas / panels can render a "can't be used as a reference"
          // affordance instead of letting the user retry the same broken URL.
          try {
            await pool.query(
              `UPDATE canvas_nodes
                 SET metadata = COALESCE(metadata, '{}'::jsonb)
                                || jsonb_build_object(
                                     'reference_unreachable', true,
                                     'reference_unreachable_at', to_jsonb(NOW())
                                   ),
                     updated_at = NOW()
               WHERE src = $1
                 AND canvas_id IN (SELECT id FROM canvas_states WHERE user_id = $2)`,
              [u, userId]
            );
          } catch (markErr) {
            console.warn("[generate] backfill: failed to mark node unreachable:", markErr);
          }
          if (debitResult.cost > 0) {
            await refundCreditsWithFallback(userId, debitResult.cost, "reference_unreachable", preGeneratedJobId, workspace_id || undefined);
          }
          res.status(400).json({
            error: "This reference image is no longer reachable on the original host. Regenerate it and try again.",
            error_code: "reference_unreachable",
          });
          return;
        }
      }
      fullParams.referenceImageUrls = rehosted;
    }

    let workspaceId: string;
    if (workspace_id) {
      const wsCheck = await pool.query(
        `SELECT w.id FROM workspaces w
         JOIN workspace_members wm ON wm.workspace_id = w.id
         WHERE w.id = $1 AND wm.user_id = $2`,
        [workspace_id, userId]
      );
      if (wsCheck.rows.length === 0) {
        if (debitResult.cost > 0) {
          await refundCreditsWithFallback(userId, debitResult.cost, "workspace_validation_failed", preGeneratedJobId, workspace_id || undefined);
        }
        res.status(403).json({ error: "Not a member of the specified workspace" });
        return;
      }
      workspaceId = wsCheck.rows[0].id;
    } else {
      const wsResult = await pool.query(
        `SELECT w.id FROM workspaces w
         JOIN workspace_members wm ON wm.workspace_id = w.id
         WHERE wm.user_id = $1 LIMIT 1`,
        [userId]
      );
      if (wsResult.rows.length === 0) {
        if (debitResult.cost > 0) {
          await refundCreditsWithFallback(userId, debitResult.cost, "no_workspace_found", preGeneratedJobId, workspace_id || undefined);
        }
        res.status(404).json({ error: "No workspace found" });
        return;
      }
      workspaceId = wsResult.rows[0].id;
    }

    const effectiveCost = debitResult.cost;

    const jobId = preGeneratedJobId;
    // Brand IQ tagging: when the agent dispatched this job under an active
    // brand profile, jobs.params already contains brand_profile_id. Promote
    // it onto jobs.metadata so analytics + the Library "filter by brand"
    // affordance can index on a stable, top-level metadata field instead of
    // having to dig into the JSONB params blob.
    const brandTag =
      (fullParams && typeof fullParams === "object" && typeof (fullParams as Record<string, unknown>).brand_profile_id === "string")
        ? { brand_profile_id: (fullParams as Record<string, string>).brand_profile_id }
        : {};
    await pool.query(
      `INSERT INTO jobs (id, user_id, workspace_id, type, model, params, status, credits_charged, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $8::jsonb)`,
      [jobId, userId, workspaceId, type, resolvedModel, JSON.stringify(fullParams), effectiveCost, JSON.stringify(brandTag)]
    );

    res.json({ job_id: jobId, status: "queued" });

    if (resolvedModel) {
      dispatchToFal(jobId, resolvedModel, fullParams).catch((err) => {
        console.error(`[fal.ai] Background dispatch error for job ${jobId}:`, err);
      });
    }
  } catch (err: unknown) {
    console.error("Create job error:", err);
    if (debitResult && debitResult.success && debitResult.cost > 0) {
      await refundCreditsWithFallback(userId, debitResult.cost, "job_creation_failed", preGeneratedJobId, workspace_id || undefined);
    }
    res.status(500).json({ error: "Failed to create job" });
  }
});

app.get("/api/job/:job_id", requireAuth, requireVerifiedEmail, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const jobId = req.params.job_id;
    if (!isValidUUID(jobId)) {
      res.status(400).json({ error: "Invalid job_id" });
      return;
    }
    const result = await pool.query(
      `SELECT id AS job_id, user_id, workspace_id, type, model, params, status, progress, result_url, error, error_type, metadata, credits_charged, created_at, updated_at
       FROM jobs WHERE id = $1`,
      [jobId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    const job = result.rows[0];
    if (job.user_id !== userId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    res.json(job);
  } catch (err: unknown) {
    console.error("Get job error:", err);
    res.status(500).json({ error: "Failed to get job" });
  }
});

app.get("/api/job/:job_id/recycle", requireAuth, requireVerifiedEmail, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const jobId = req.params.job_id;
    if (!isValidUUID(jobId)) {
      res.status(400).json({ error: "Invalid job_id" });
      return;
    }
    const result = await pool.query(
      `SELECT user_id, params FROM jobs WHERE id = $1`,
      [jobId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    const job = result.rows[0];
    if (job.user_id !== userId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const params = (job.params || {}) as Record<string, unknown>;
    const prompt = typeof params.prompt === "string" ? params.prompt : "";
    const collected: string[] = [];
    const singleImage = sanitizeUrl(params.image_url);
    if (singleImage) collected.push(singleImage);
    const firstFrame = sanitizeUrl(params.firstFrameUrl);
    if (firstFrame) collected.push(firstFrame);
    if (Array.isArray(params.referenceImageUrls)) {
      for (const u of params.referenceImageUrls) {
        const cleaned = sanitizeUrl(u);
        if (cleaned) collected.push(cleaned);
      }
    }
    const lastFrame = sanitizeUrl(params.lastFrameUrl);
    if (lastFrame) collected.push(lastFrame);
    const seen = new Set<string>();
    const referenceImageUrls = collected.filter((u) => {
      if (seen.has(u)) return false;
      seen.add(u);
      return true;
    });
    res.json({ prompt, referenceImageUrls });
  } catch (err: unknown) {
    console.error("Recycle job error:", err);
    res.status(500).json({ error: "Failed to load recycle data" });
  }
});

app.get("/api/jobs", requireAuth, requireVerifiedEmail, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const status = req.query.status as string | undefined;
    const type = req.query.type as string | undefined;
    const workspaceId = req.query.workspace_id as string | undefined;
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

    const conditions = ["user_id = $1"];
    const values: unknown[] = [userId];
    let idx = 2;

    if (workspaceId) {
      const memberCheck = await pool.query(
        `SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
        [workspaceId, userId]
      );
      if (memberCheck.rows.length === 0) {
        res.status(403).json({ error: "Not a member of this workspace" });
        return;
      }
      conditions.push(`workspace_id = $${idx++}`);
      values.push(workspaceId);
    }
    if (status) {
      conditions.push(`status = $${idx++}`);
      values.push(status);
    }
    if (type) {
      conditions.push(`type = $${idx++}`);
      values.push(type);
    }

    values.push(limit, offset);
    const result = await pool.query(
      `SELECT id AS job_id, user_id, workspace_id, type, model, params, status, progress, result_url, error, credits_charged, created_at, updated_at
       FROM jobs
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      values
    );
    res.json({ jobs: result.rows });
  } catch (err: unknown) {
    console.error("List jobs error:", err);
    res.status(500).json({ error: "Failed to list jobs" });
  }
});

app.post("/api/job/:job_id/cancel", requireAuth, requireVerifiedEmail, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const jobId = req.params.job_id;
    if (!isValidUUID(jobId)) {
      res.status(400).json({ error: "Invalid job_id" });
      return;
    }
    const existing = await pool.query(
      `SELECT id, user_id, status FROM jobs WHERE id = $1`,
      [jobId]
    );
    if (existing.rows.length === 0) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    if (existing.rows[0].user_id !== userId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const updated = await pool.query(
      `UPDATE jobs SET status = 'cancelled' WHERE id = $1 AND user_id = $2 AND status IN ('queued', 'pending', 'processing')
       RETURNING id AS job_id, user_id, workspace_id, type, model, params, status, progress, result_url, error, credits_charged, created_at, updated_at`,
      [jobId, userId]
    );
    if (updated.rows.length === 0) {
      res.status(400).json({ error: "Job cannot be cancelled" });
      return;
    }
    res.json(updated.rows[0]);
  } catch (err: unknown) {
    console.error("Cancel job error:", err);
    res.status(500).json({ error: "Failed to cancel job" });
  }
});

app.delete("/api/auth/account", requireAuth, async (req, res) => {
  try {
    const userId = (req as AuthRequest).userId;
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    evictUserFromCache(userId!);
    res.clearCookie(WOS_COOKIE_NAME, { path: "/" });
    res.json({ ok: true });
  } catch (err: unknown) {
    console.error("Delete account error:", err);
    res.status(500).json({ error: "Failed to delete account" });
  }
});


if (LOCAL_MODE) {
  // Serve locally-stored files straight from disk (no cloud redirect).
  app.use("/uploads", express.static(UPLOADS_DIR, { fallthrough: false, maxAge: "1h" }));
} else {
  app.get("/uploads/{*splat}", (_req, res) => {
    const originalPath = _req.params.splat || _req.path.slice("/uploads/".length);
    const r2Url = resolveToR2Url(`/uploads/${originalPath}`);
    const qs = _req.originalUrl.includes("?") ? _req.originalUrl.slice(_req.originalUrl.indexOf("?")) : "";
    res.redirect(301, r2Url + qs);
  });
}

const publicAudioPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "audio");
app.use("/audio", express.static(publicAudioPath));

const distPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
app.use(express.static(distPath));

app.post("/api/clearcheck", requireAuth, requireVerifiedEmail, async (req, res) => {
  const { handleClearcheck } = await import("./clearcheck.js");
  return handleClearcheck(req as AuthRequest, res, pool);
});

app.get("/api/clearcheck/audits", requireAuth, async (req: AuthRequest, res) => {
  try {
    const result = await pool.query(
      `SELECT id, source, file_name, status, labels, moderation_flags, image_file_url, report_file_url, created_at
       FROM clearcheck_audits WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.userId]
    );
    res.json({ audits: result.rows });
  } catch (err) {
    console.error("Failed to fetch clearcheck audits:", err);
    res.status(500).json({ error: "Failed to load audit log" });
  }
});

app.get("/api/clearcheck/audits/:id/download", requireAuth, async (req: AuthRequest, res) => {
  try {
    const result = await pool.query(
      `SELECT report_file_url FROM clearcheck_audits WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.userId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Audit not found" });
      return;
    }
    const reportUrl = result.rows[0].report_file_url;
    if (!reportUrl) {
      res.status(404).json({ error: "Report file not available" });
      return;
    }
    if (reportUrl.startsWith("http")) {
      res.redirect(reportUrl);
      return;
    }
    const relPath = reportUrl.startsWith("/uploads/") ? reportUrl.slice("/uploads/".length) : reportUrl.replace(/^\//, "");
    const parts = relPath.split("/");
    const bucket = parts[0];
    const filePath = parts.slice(1).join("/");
    try {
      const r2Response = await getFileStream(bucket, filePath);
      if (!r2Response.Body) {
        res.status(404).json({ error: "Report file not found" });
        return;
      }
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="clearcheck-report.zip"`);
      const stream = r2Response.Body as NodeJS.ReadableStream;
      stream.pipe(res);
    } catch {
      res.status(404).json({ error: "Report file not found" });
      return;
    }
  } catch (err) {
    console.error("Failed to download clearcheck report:", err);
    res.status(500).json({ error: "Download failed" });
  }
});

app.get(/^\/(?!api(?:\/|$))/, (_req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

app.use(injectUserId, platformRoutes);

// NOTE: intentionally outside requireAuth/requireVerifiedEmail middleware.
// navigator.sendBeacon is fire-and-forget — the browser ignores the response,
// so a 401/403 from requireAuth would silently drop the write. Auth is checked
// inline and this route always returns HTTP 200.
app.post("/api/canvas/beacon-flush", injectUserId, async (req: AuthRequest, res: Response) => {
  res.status(200);
  try {
    const userId = req.userId;
    if (!userId) {
      res.json({ ok: false, reason: "unauthenticated" });
      return;
    }

    const { canvasId, mutations } = req.body ?? {};

    if (!canvasId || typeof canvasId !== "string") {
      res.json({ ok: false, reason: "missing canvasId" });
      return;
    }

    if (!Array.isArray(mutations) || mutations.length === 0) {
      res.json({ ok: false, reason: "no mutations" });
      return;
    }

    const authCheck = await pool.query(
      `SELECT cs.id FROM canvas_states cs
       WHERE cs.id = $1
       AND (cs.user_id = $2 OR EXISTS (
         SELECT 1 FROM workspace_members wm
         WHERE wm.workspace_id = cs.workspace_id AND wm.user_id = $2
       ))`,
      [canvasId, userId]
    );
    if (authCheck.rows.length === 0) {
      res.json({ ok: false, reason: "not authorized" });
      return;
    }

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    type BeaconMutation =
      | { type: "update"; nodeId: string; fields: Record<string, unknown> }
      | { type: "delete"; nodeId: string };

    const validMutations: BeaconMutation[] = (mutations as BeaconMutation[]).filter(
      (m) =>
        m &&
        (m.type === "update" || m.type === "delete") &&
        typeof m.nodeId === "string" &&
        uuidRegex.test(m.nodeId)
    );

    if (validMutations.length === 0) {
      res.json({ ok: true, processed: 0 });
      return;
    }

    const updates = validMutations.filter(
      (m): m is { type: "update"; nodeId: string; fields: Record<string, unknown> } =>
        m.type === "update"
    );
    const deletes = validMutations.filter(
      (m): m is { type: "delete"; nodeId: string } => m.type === "delete"
    );

    const mergedUpdates = new Map<string, Record<string, unknown>>();
    for (const mut of updates) {
      const existing = mergedUpdates.get(mut.nodeId) ?? {};
      const fields = { ...mut.fields };
      if (typeof fields.src === "string" && fields.src.startsWith("blob:")) {
        delete fields.src;
      }
      mergedUpdates.set(mut.nodeId, { ...existing, ...fields });
    }

    const allCandidateIds = [...new Set(validMutations.map((m) => m.nodeId))];
    const existingNodesResult = await pool.query(
      `SELECT id FROM canvas_nodes WHERE canvas_id = $1 AND id = ANY($2::uuid[])`,
      [canvasId, allCandidateIds]
    );
    const existingNodeIds = new Set(existingNodesResult.rows.map((r: { id: string }) => r.id));

    const deletedNodeIds = new Set(
      deletes.filter((m) => existingNodeIds.has(m.nodeId)).map((m) => m.nodeId)
    );

    const confirmedUpdates = new Map<string, Record<string, unknown>>();
    for (const [nodeId, fields] of mergedUpdates) {
      if (existingNodeIds.has(nodeId) && !deletedNodeIds.has(nodeId)) {
        confirmedUpdates.set(nodeId, fields);
      }
    }
    const confirmedDeletes = deletes.filter((m) => deletedNodeIds.has(m.nodeId));
    const allDeleteNodeIds = deletes.map((m) => m.nodeId);

    const pgPromises: Promise<unknown>[] = [];

    for (const [nodeId, fields] of confirmedUpdates) {
      const { x, y, width, height, rotation, z_index, locked, visible, label, src, gradient, asset_id, metadata, node_type } = fields as Record<string, unknown>;
      pgPromises.push(
        pool.query(
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
            metadata = COALESCE($13, metadata),
            node_type = COALESCE($14, node_type),
            updated_at = NOW()
          WHERE id = $15 AND canvas_id = $16`,
          [
            x ?? null,
            y ?? null,
            width ?? null,
            height ?? null,
            rotation ?? null,
            z_index ?? null,
            locked ?? null,
            visible ?? null,
            label ?? null,
            src ?? null,
            gradient ?? null,
            asset_id ?? null,
            metadata != null ? JSON.stringify(metadata) : null,
            node_type ?? null,
            nodeId,
            canvasId,
          ]
        ).catch((err) => {
          console.error(`[beacon-flush] PG update failed for node ${nodeId}:`, err);
        })
      );
    }

    if (confirmedDeletes.length > 0) {
      const deleteNodeIds = confirmedDeletes.map((m) => m.nodeId);
      const deleteNodesResult = await pool.query(
        `SELECT id, node_type, src, label, job_id FROM canvas_nodes WHERE canvas_id = $1 AND id = ANY($2::uuid[])`,
        [canvasId, deleteNodeIds]
      ).catch(() => null);
      if (deleteNodesResult) {
        for (const node of deleteNodesResult.rows) {
          if (node.src && (node.node_type === "image" || node.node_type === "video" || node.node_type === "svg" || node.node_type === "audio")) {
            const archiveType = node.node_type === "svg" ? "vector" : node.node_type;
            pgPromises.push(
              pool.query(
                `INSERT INTO assets (user_id, type, source, name, file_url, metadata, deleted_at)
                 VALUES ($1, $2, 'canvas', $3, $4, $5, NOW())`,
                [userId, archiveType, node.label || "Canvas item", node.src, JSON.stringify({ canvas_node_id: node.id, job_id: node.job_id })]
              ).catch((err) => {
                console.error(`[beacon-flush] Asset archive failed for node ${node.id}:`, err);
              })
            );
          }
          // Cancel still-in-flight job when its placeholder node is deleted
          // via the batched dirty-flush path (keyboard delete, context menu,
          // multi-select). Mirrors the per-node DELETE route + the
          // /api/job/:job_id/cancel endpoint so fal.ts polling aborts.
          if (node.job_id) {
            pgPromises.push(
              pool.query(
                `UPDATE jobs SET status = 'cancelled'
                 WHERE id = $1 AND user_id = $2
                 AND status IN ('queued', 'pending', 'processing')`,
                [node.job_id, userId]
              ).catch((err) => {
                console.error(`[beacon-flush] Cancel job ${node.job_id} on node delete failed:`, err);
              })
            );
          }
        }
      }
    }

    for (const mut of confirmedDeletes) {
      pgPromises.push(
        pool.query(
          `DELETE FROM canvas_nodes WHERE id = $1 AND canvas_id = $2`,
          [mut.nodeId, canvasId]
        ).catch((err) => {
          console.error(`[beacon-flush] PG delete failed for node ${mut.nodeId}:`, err);
        })
      );
    }

    for (const nodeId of allDeleteNodeIds) {
      pgPromises.push(
        pool.query(
          `INSERT INTO canvas_node_tombstones (node_id, canvas_id) VALUES ($1, $2) ON CONFLICT (node_id) DO NOTHING`,
          [nodeId, canvasId]
        ).catch((err) => {
          console.error(`[beacon-flush] PG tombstone insert failed for node ${nodeId}:`, err);
        })
      );
    }

    const redisPromises: Promise<unknown>[] = [];

    const redisUpdates: RedisNodeUpdate[] = Array.from(confirmedUpdates.entries()).map(([nodeId, fields]) => ({
      id: nodeId,
      ...fields,
    }));

    if (redisClient && redisUpdates.length > 0) {
      redisPromises.push(
        redisSetNodes(canvasId, redisUpdates).catch((err) => {
          console.error("[beacon-flush] Redis setNodes failed:", err);
        })
      );
    }
    for (const nodeId of allDeleteNodeIds) {
      if (redisClient) {
        redisPromises.push(
          redisEvictNode(canvasId, nodeId).catch((err) => {
            console.error(`[beacon-flush] Redis evictNode failed for ${nodeId}:`, err);
          })
        );
      }
    }

    await Promise.all([...pgPromises, ...redisPromises]);

    if (confirmedUpdates.size > 0 || confirmedDeletes.length > 0) {
      const sessionId = (req.headers["x-canvas-session-id"] as string) || (req.body?.sessionId as string) || "";
      broadcastCanvasUpdate(canvasId, sessionId);
      scheduleCanvasFlush();
    }

    res.json({ ok: true, processed: validMutations.length });
  } catch (err) {
    console.error("[beacon-flush] Unexpected error:", err);
    res.json({ ok: false, reason: "internal error" });
  }
});

// Mount agentRoutes before the requireAuth chain so the public
// /api/agent/status endpoint isn't gated by global auth middleware.
// (The /api/agent/chat handler enforces requireAuth + requireVerifiedEmail itself.)
app.use(agentRoutes);
app.use(brandIqRoutes);
app.use(operatorRoutes);
app.use(operatorJobRoutes);
seedBuiltinSkills();
app.use(skillRoutes);
app.use(customModelRoutes);
app.use(setupRoutes);
app.use(githubRoutes);
app.use(agentTimelineRoutes);
app.use(cinemaExportRoutes);
app.use(agentCutsRoutes);
app.use(agentRenderRoutes);
app.use(requireAuth, requireVerifiedEmail, folderRoutes);
app.use(requireAuth, requireVerifiedEmail, bucketRoutes);
app.use(requireAuth, requireVerifiedEmail, assetRoutes);
app.use(requireAuth, requireVerifiedEmail, audioRoutes);
app.use(requireAuth, requireVerifiedEmail, trashRoutes);
app.use(requireAuth, requireVerifiedEmail, axiomRoutes);
app.use(requireAuth, requireVerifiedEmail, styleRoutes);
// Presence subscriptions (SSE GET) and cursor POST are mounted with
// `injectUserId` instead of `requireAuth` so that guest/share-v1 viewers can
// participate in the presence channel where the canvas-access layer permits
// it (today access still rejects unauth users, but the path is open for the
// share-v1 enablement). The handlers themselves perform full canvas-access
// + per-session ownership/binding-token checks before doing anything.
app.get(
  "/api/canvas/:canvasId/events",
  injectUserId,
  sseSessionActivityMiddleware,
  sseEventsHandler,
);
app.use(injectUserId, sseSessionActivityMiddleware, presenceRoutes);

// All other canvas mutation endpoints stay behind the strict auth chain.
app.use(requireAuth, requireVerifiedEmail, sseSessionActivityMiddleware, canvasRoutes);
async function requireSharingV1(req: Request, res: Response, next: NextFunction) {
  const userId = (req as Request & { userId?: string }).userId;
  if (await isSharingV1EnabledForUser(userId)) return next();
  res.status(404).json({ error: "Not found" });
}
app.use(requireAuth, requireVerifiedEmail, requireSharingV1, sharingRoutes);
app.use(requireAuth, requireVerifiedEmail, notificationRoutes);
app.use("/api/admin/credits", requireAuth, requireVerifiedEmail, adminCreditsRoutes);
app.get("/api/payments/config", (_req, res) => {
  res.json({
    publishableKey: STRIPE_PK,
    creditsPerDollar: CREDITS_PER_DOLLAR,
    minPurchaseCents: MIN_PURCHASE_CENTS,
    maxPurchaseCents: MAX_PURCHASE_CENTS,
    plans: Object.fromEntries(
      Object.entries(PLAN_CONFIG).map(([tier, cfg]) => [
        tier,
        { creditsPerPeriod: cfg.creditsPerPeriod, amountCents: cfg.amountCents },
      ])
    ),
  });
});
app.use(requireAuth, requireVerifiedEmail, paymentRoutes);

async function cleanupStaleGenerations(): Promise<void> {
  try {
    const inflightJobs = await pool.query(
      `SELECT j.id, j.model, j.fal_request_id, j.user_id, j.credits_charged, j.workspace_id
       FROM jobs j
       WHERE j.status = 'processing'
         AND j.fal_request_id IS NOT NULL
         AND j.result_url IS NULL`
    );

    if (inflightJobs.rows.length > 0) {
      console.log(`[startup] Found ${inflightJobs.rows.length} in-flight job(s) with fal_request_id, checking status...`);
      for (const row of inflightJobs.rows) {
        const falStatus = await handleFalResult(row.id, row.model, row.fal_request_id);
        if (falStatus === "completed") {
          console.log(`[startup] Recovered completed result for job ${row.id}`);
        } else if (falStatus === "running") {
          console.log(`[startup] Job ${row.id} still running on fal.ai, resuming polling in background`);
          resumeFalPolling(row.id, row.model, row.fal_request_id).catch((err) => {
            console.error(`[startup] Background polling failed for job ${row.id}:`, err);
          });
        } else {
          console.log(`[startup] Job ${row.id} confirmed dead on fal.ai, marking failed`);
          await pool.query(
            `UPDATE jobs SET status = 'failed', error = $2, error_type = 'fal_confirmed_failure', updated_at = NOW()
             WHERE id = $1 AND status NOT IN ('complete', 'failed', 'cancelled')`,
            [row.id, "Generation failed — fal.ai request not found or expired"]
          );
          if (row.credits_charged > 0) {
            await refundCreditsWithFallback(row.user_id, row.credits_charged, "fal_confirmed_failure", row.id, row.workspace_id || undefined);
            console.log(`[startup] Refunded ${row.credits_charged} credits for confirmed-dead job ${row.id}`);
          }
        }
      }
    }

    // Mark queued/pending jobs without a fal_request_id older than 10
    // minutes as failed (they never made it to fal.ai). The canvas
    // placeholder polling on the client will surface the failure in
    // place; we just need to refund credits and stop dispatch attempts.
    const staleQueued = await pool.query(
      `UPDATE jobs SET status = 'failed', error = $1, error_type = 'generation_timeout', updated_at = NOW()
       WHERE status IN ('queued', 'pending')
         AND fal_request_id IS NULL
         AND created_at < NOW() - INTERVAL '10 minutes'
       RETURNING id, user_id, credits_charged, workspace_id`,
      ["Generation timed out"]
    );
    if (staleQueued.rows.length > 0) {
      for (const row of staleQueued.rows) {
        if (row.credits_charged > 0) {
          await refundCreditsWithFallback(row.user_id, row.credits_charged, "generation_timeout", row.id, row.workspace_id || undefined);
          console.log(`[startup] Refunded ${row.credits_charged} credits for timed-out queued job ${row.id}`);
        }
      }
      console.log(`[startup] Marked ${staleQueued.rows.length} stale queued job(s) as failed`);
    } else {
      console.log(`[startup] No stale generations found`);
    }
  } catch (err) {
    console.error("[startup] Failed to cleanup stale generations:", err);
  }
}

// RECONCILIATION PASS: This checkpoint is no longer the primary durability mechanism.
// Committed mutations are now dual-written to both Redis and Postgres immediately via
// upsertNodesPostgres in the batch endpoint. This pass serves as a catch-up for
// edge-case ephemeral writes (browser crash mid-drag) and Redis garbage collection.
// It logs a warning when it finds a Redis value that diverges from Postgres for a
// committed field — this indicates a mutation that was not dual-written (e.g. a
// crash before pointer-up). In that case, it still writes to Postgres to prevent data
// loss, but the warning signals unexpected divergence.
async function flushCanvasCheckpoint(): Promise<void> {
  if (!redisClient) return;
  const dirtyCanvases = await getDirtyCanvases().catch((err) => {
    console.error("[canvas-checkpoint] Failed to pop dirty canvases:", err);
    return [] as string[];
  });
  if (dirtyCanvases.length === 0) return;

  let reconciledCount = 0;
  let totalNodeCount = 0;
  let divergenceCount = 0;
  const failedCanvases: string[] = [];

  for (const canvasId of dirtyCanvases) {
    try {
      const redisNodes = await getCanvasFromRedis(canvasId);
      if (!redisNodes || redisNodes.length === 0) {
        reconciledCount++;
        continue;
      }
      totalNodeCount += redisNodes.length;

      // Fetch current Postgres state for these nodes to detect divergence.
      const nodeIds = redisNodes.map((n) => n.id as string).filter(Boolean);
      let pgRows: Record<string, Record<string, unknown>> = {};
      if (nodeIds.length > 0) {
        const pgResult = await pool.query(
          `SELECT id, x, y, width, height, rotation, updated_at FROM canvas_nodes WHERE id = ANY($1::uuid[])`,
          [nodeIds]
        ).catch(() => null);
        if (pgResult) {
          for (const row of pgResult.rows) {
            pgRows[row.id as string] = row;
          }
        }
      }

      // Log divergence for committed geometry fields (x, y, width, height, rotation).
      // Divergence here means a mutation may not have been dual-written — likely a
      // browser crash or mid-drag eviction. We still write through to prevent data loss.
      const geometryFields = ["x", "y", "width", "height", "rotation"] as const;
      for (const node of redisNodes) {
        if (node._partial) continue;
        const pg = pgRows[node.id as string];
        if (!pg) continue;
        for (const field of geometryFields) {
          if (node[field] !== undefined && node[field] !== null && pg[field] !== undefined) {
            const redisVal = Number(node[field]);
            const pgVal = Number(pg[field]);
            if (Math.abs(redisVal - pgVal) > 0.001) {
              divergenceCount++;
              console.warn(
                `[canvas-checkpoint] Divergence detected for node ${node.id} field "${field}": ` +
                `Redis=${redisVal} Postgres=${pgVal} — writing Redis value through (likely missed dual-write)`
              );
            }
          }
        }
      }

      // Filter out tombstoned (deleted) nodes to prevent resurrection.
      // Tombstones are authoritative in Postgres — no TTL, no Redis dependency.
      const tombstoneResult = await pool.query(
        `SELECT node_id FROM canvas_node_tombstones WHERE canvas_id = $1 AND node_id = ANY($2::uuid[])`,
        [canvasId, nodeIds]
      ).catch(() => ({ rows: [] as { node_id: string }[] }));
      const tombstonedIds = new Set(tombstoneResult.rows.map((r) => r.node_id));
      if (tombstonedIds.size > 0) {
        console.log(`[canvas-checkpoint] canvasId=${canvasId} skipping ${tombstonedIds.size} tombstoned node(s): ${[...tombstonedIds].join(", ")}`);
        await pool.query(
          `DELETE FROM canvas_nodes WHERE id = ANY($1::uuid[])`,
          [[...tombstonedIds]]
        ).catch((err) => console.error(`[canvas-checkpoint] Failed to delete tombstoned nodes for canvas ${canvasId}:`, err));
      }
      const filteredNodes = redisNodes.filter((n) => !tombstonedIds.has(n.id as string));
      if (filteredNodes.length === 0) {
        await evictCanvas(canvasId).catch((evictErr) => {
          console.error(`[canvas-checkpoint] Post-reconciliation evictCanvas failed for ${canvasId}:`, evictErr);
        });
        reconciledCount++;
        continue;
      }

      const checkpointStart = new Date();
      const staleRedisNodes = new Set<string>();
      for (const node of filteredNodes) {
        const pg = pgRows[node.id as string];
        if (!pg || !pg.updated_at) continue;
        if (!node._updated_at) {
          staleRedisNodes.add(node.id as string);
          continue;
        }
        const pgUpdatedAt = new Date(pg.updated_at as string).getTime();
        const redisUpdatedAt = new Date(node._updated_at as string).getTime();
        if (redisUpdatedAt <= pgUpdatedAt) {
          staleRedisNodes.add(node.id as string);
        }
      }
      if (staleRedisNodes.size > 0) {
        console.log(`[canvas-checkpoint] canvasId=${canvasId} skipping ${staleRedisNodes.size} stale Redis node(s) (Postgres has newer committed data)`);
      }
      const checkpointNodes = filteredNodes.filter((n) => !staleRedisNodes.has(n.id as string));
      if (checkpointNodes.length === 0) {
        await evictCanvas(canvasId).catch((evictErr) => {
          console.error(`[canvas-checkpoint] Post-reconciliation evictCanvas failed for ${canvasId}:`, evictErr);
        });
        reconciledCount++;
        continue;
      }

      const fullNodes = checkpointNodes.filter((n) => !n._partial);
      const partialNodes = checkpointNodes.filter((n) => !!n._partial);

      // --- Full nodes: normal batch upsert ---
      if (fullNodes.length > 0) {
        const values: unknown[] = [];
        const placeholders: string[] = [];
        let idx = 1;
        const snapshotParamIdx = idx++;
        for (const node of fullNodes) {
          placeholders.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
          values.push(
            node.id,
            canvasId,
            node.node_type ?? "image",
            node.x ?? 0,
            node.y ?? 0,
            node.width ?? 256,
            node.height ?? 256,
            node.rotation ?? 0,
            node.z_index ?? 0,
            node.locked ?? false,
            node.visible ?? true,
            node.label ?? "",
            node.src ?? "",
            node.gradient ?? "",
            node.metadata ? JSON.stringify(node.metadata) : "{}",
            node.asset_id ?? null,
            node.job_id ?? null
          );
        }
        values.unshift(checkpointStart.toISOString());
        await pool.query(
          `INSERT INTO canvas_nodes (id, canvas_id, node_type, x, y, width, height, rotation, z_index, locked, visible, label, src, gradient, metadata, asset_id, job_id)
           VALUES ${placeholders.join(", ")}
           ON CONFLICT (id) DO UPDATE SET
             x = EXCLUDED.x,
             y = EXCLUDED.y,
             width = EXCLUDED.width,
             height = EXCLUDED.height,
             rotation = EXCLUDED.rotation,
             z_index = EXCLUDED.z_index,
             locked = EXCLUDED.locked,
             visible = EXCLUDED.visible,
             label = CASE WHEN EXCLUDED.label != '' THEN EXCLUDED.label ELSE canvas_nodes.label END,
             src = CASE WHEN EXCLUDED.src != '' THEN EXCLUDED.src ELSE canvas_nodes.src END,
             gradient = CASE WHEN EXCLUDED.gradient != '' THEN EXCLUDED.gradient ELSE canvas_nodes.gradient END,
             metadata = CASE WHEN EXCLUDED.metadata::text != '{}' THEN EXCLUDED.metadata ELSE canvas_nodes.metadata END,
             node_type = CASE WHEN EXCLUDED.node_type IS NOT NULL AND EXCLUDED.node_type != 'image' THEN EXCLUDED.node_type ELSE canvas_nodes.node_type END,
             asset_id = CASE WHEN EXCLUDED.asset_id IS NOT NULL THEN EXCLUDED.asset_id ELSE canvas_nodes.asset_id END,
             job_id = CASE WHEN EXCLUDED.job_id IS NOT NULL THEN EXCLUDED.job_id ELSE canvas_nodes.job_id END
           WHERE canvas_nodes.updated_at < $${snapshotParamIdx}::timestamptz`,
          values
        );
      }

      // --- Partial nodes: UPDATE-only, backfilling geometry from Postgres ---
      // Partial records (sparse Redis entries from cache-miss mutations) must never
      // INSERT — they lack required NOT NULL geometry columns. Only update existing rows,
      // using the Postgres row as fallback for any field not present in Redis.
      for (const node of partialNodes) {
        const pg = pgRows[node.id as string];
        if (!pg) {
          // No existing Postgres row — skip. A partial record cannot create a new node.
          console.warn(`[canvas-checkpoint] Skipping partial node ${node.id} for canvas ${canvasId}: no existing Postgres row`);
          continue;
        }
        await pool.query(
          `UPDATE canvas_nodes SET
             x = $1, y = $2, width = $3, height = $4, rotation = $5,
             z_index = $6,
             label = CASE WHEN $7 != '' THEN $7 ELSE label END,
             src = CASE WHEN $8 != '' THEN $8 ELSE src END,
             gradient = CASE WHEN $9 != '' THEN $9 ELSE gradient END,
             metadata = CASE WHEN $10::text != '{}' THEN $10::jsonb ELSE metadata END,
             asset_id = CASE WHEN $11::uuid IS NOT NULL THEN $11::uuid ELSE asset_id END,
             job_id = CASE WHEN $12::uuid IS NOT NULL THEN $12::uuid ELSE job_id END
           WHERE id = $13::uuid AND updated_at < $14::timestamptz`,
          [
            node.x !== undefined ? node.x : pg.x,
            node.y !== undefined ? node.y : pg.y,
            node.width !== undefined ? node.width : pg.width,
            node.height !== undefined ? node.height : pg.height,
            node.rotation !== undefined ? node.rotation : pg.rotation,
            node.z_index !== undefined ? node.z_index : pg.z_index ?? 0,
            node.label ?? "",
            node.src ?? "",
            node.gradient ?? "",
            node.metadata ? JSON.stringify(node.metadata) : "{}",
            node.asset_id ?? null,
            node.job_id ?? null,
            node.id,
            checkpointStart.toISOString(),
          ]
        );
      }
      await evictCanvas(canvasId).catch((evictErr) => {
        console.error(`[canvas-checkpoint] Post-reconciliation evictCanvas failed for ${canvasId}:`, evictErr);
      });

      reconciledCount++;
    } catch (err: any) {
      if (err?.code === '23503') {
        console.warn(`[canvas-checkpoint] Canvas ${canvasId} no longer exists in DB — evicting from Redis and removing from dirty set`);
        await evictCanvas(canvasId).catch((evictErr) => {
          console.error(`[canvas-checkpoint] evictCanvas failed for ${canvasId}:`, evictErr);
        });
        if (redisClient) {
          await redisClient.srem("canvas:dirty", canvasId).catch((sremErr) => {
            console.error(`[canvas-checkpoint] srem failed for ${canvasId}:`, sremErr);
          });
        }
      } else {
        console.error(`[canvas-checkpoint] Failed to reconcile canvas ${canvasId}:`, err);
        failedCanvases.push(canvasId);
      }
    }
  }

  if (failedCanvases.length > 0) {
    await reAddDirtyCanvases(failedCanvases).catch((err) => {
      console.error("[canvas-checkpoint] Failed to re-add dirty canvases after failure:", err);
    });
    console.warn(`[canvas-checkpoint] Re-added ${failedCanvases.length} canvas(es) to dirty set for retry`);
  }

  if (divergenceCount > 0) {
    console.warn(`[canvas-checkpoint] Reconciliation found ${divergenceCount} divergent field(s) across ${reconciledCount} canvas(es) — these indicate missed dual-writes`);
  }
  console.debug(`[canvas-checkpoint] Reconciled ${reconciledCount} canvas(es), ${totalNodeCount} node(s)`);
}

async function deduplicateCanvasNodes() {
  try {
    const countRes = await pool.query(`
      SELECT COUNT(*) as total FROM (
        SELECT canvas_id, src, node_type, ROUND(x / 50) as gx, ROUND(y / 50) as gy
        FROM canvas_nodes
        WHERE src != '' AND node_type != 'text' AND node_type != 'shape'
        GROUP BY canvas_id, src, node_type, ROUND(x / 50), ROUND(y / 50)
        HAVING COUNT(*) > 3
      ) groups
    `);
    const dupGroups = parseInt(countRes.rows[0].total, 10);
    if (dupGroups === 0) {
      console.log("[startup] No duplicate canvas node groups found.");
      return;
    }
    console.log(`[startup] Found ${dupGroups} duplicate canvas node groups — deduplicating...`);
    const result = await pool.query(`
      DELETE FROM canvas_nodes
      WHERE id IN (
        SELECT id FROM (
          SELECT id,
                 ROW_NUMBER() OVER (
                   PARTITION BY canvas_id, src, node_type, ROUND(x / 50), ROUND(y / 50)
                   ORDER BY created_at ASC
                 ) as rn
          FROM canvas_nodes
          WHERE src != '' AND node_type != 'text' AND node_type != 'shape'
        ) ranked
        WHERE rn > 1
      )
    `);
    console.log(`[startup] Deduplication complete — removed ${result.rowCount} duplicate canvas nodes.`);
  } catch (err) {
    console.error("[startup] Canvas node deduplication failed:", err);
  }
}

async function start() {
  if (LOCAL_MODE) {
    ensureDataDir();
  }
  await initDB();
  console.log("[startup] initDB complete");
  if (LOCAL_MODE) {
    await ensureLocalUser();
    console.log("[startup] ensureLocalUser complete");
  }

  registerCheckpointFlush(flushCanvasCheckpoint);
  setFalListenersChecker(hasAnySseClients);

  // Resume polling for in-flight fal.ai jobs whenever a client (re)connects.
  // Polling for jobs whose canvas has no live SSE listeners pauses to let the
  // event loop go idle; this picks them back up.
  let sseResumeInflight = false;
  onSseClientConnected(() => {
    if (sseResumeInflight) return;
    sseResumeInflight = true;
    (async () => {
      try {
        const inflight = await pool.query(
          `SELECT id, model, fal_request_id FROM jobs
           WHERE status = 'processing' AND fal_request_id IS NOT NULL AND result_url IS NULL`
        );
        for (const row of inflight.rows) {
          if (isPollingJob(row.id)) continue;
          resumeFalPolling(row.id, row.model, row.fal_request_id).catch((err) => {
            console.error(`[fal.ai] SSE-resume polling failed for job ${row.id}:`, err);
          });
        }
      } catch (err) {
        console.error("[fal.ai] SSE-resume scan failed:", err);
      } finally {
        sseResumeInflight = false;
      }
    })();
  });

  // Ensure Postgres tombstone table exists (no TTL, source of truth for deleted nodes).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS canvas_node_tombstones (
      node_id UUID PRIMARY KEY,
      canvas_id UUID NOT NULL,
      deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_cnt_canvas_id ON canvas_node_tombstones (canvas_id)
  `);
  console.log("[startup] canvas_node_tombstones table ready.");

  startSessionCleanup();
  // Scheduled operator runs (cron in the machine's local time zone).
  startScheduler();
  deduplicateCanvasNodes().catch((err) => {
    console.error("[startup] Canvas node dedup failed:", err);
  });
  cleanupStaleGenerations().catch((err) => {
    console.error("[startup] Cleanup stale generations failed:", err);
  });
  // Host/port are env-configurable so the Electron shell can bind loopback on
  // an ephemeral port (PORT=0) and avoid colliding with anything on 3001. The
  // OS assigns the real port; we read it back from the listening socket and
  // emit a machine-parseable handshake line so the parent (Electron main) knows
  // where to point the renderer. `process.send` (present when forked) also gets
  // the port over IPC — the more robust channel when available.
  const HOST = process.env.SERVER_HOST || "0.0.0.0";
  const server = app.listen(PORT, HOST, () => {
    const addr = server.address();
    const boundPort = typeof addr === "object" && addr ? addr.port : PORT;
    // Publish the actual bound port back into the env so in-process loopback
    // self-calls (e.g. dispatchAgentGeneration → /api/generate) resolve the
    // real port even when we bound an ephemeral one (PORT=0 under Electron).
    process.env.PORT = String(boundPort);
    console.log(`Server running on port ${boundPort}`);
    console.log(`[server-ready] ${JSON.stringify({ port: boundPort, host: HOST })}`);
    if (typeof process.send === "function") {
      try { process.send({ type: "server-ready", port: boundPort, host: HOST }); } catch { /* no IPC channel */ }
    }
    // Phase J (MCP bridge): publish a discovery file so the out-of-process stdio
    // MCP server (spawned by Claude Desktop/Code) can find this app's ephemeral
    // loopback port. Loopback is always 127.0.0.1 even when we bind 0.0.0.0. The
    // token is per-boot; J3 will enforce it via middleware (LOCAL_MODE currently
    // authenticates any loopback call as the local superadmin, so it's advisory).
    if (LOCAL_MODE) {
      try {
        ensureDataDir();
        const mcpToken = crypto.randomUUID();
        // Stash the token in-process so requireMcpToken (routes/agent.ts) can
        // validate the header the MCP server sends — same value as the file.
        setMcpToken(mcpToken);
        const endpoint = {
          baseUrl: `http://127.0.0.1:${boundPort}`,
          token: mcpToken,
          pid: process.pid,
          updatedAt: new Date().toISOString(),
        };
        fs.writeFileSync(MCP_ENDPOINT_PATH, JSON.stringify(endpoint, null, 2), "utf8");
        console.log(`[mcp] endpoint published → ${MCP_ENDPOINT_PATH}`);
      } catch (err) {
        console.error("[mcp] failed to publish endpoint discovery file:", err);
      }
    }
    // Phase L: refresh fal's at-cost unit prices in the background. Delayed and
    // un-awaited so it never competes with startup; a no-op without a fal key.
    scheduleFalPricingRefresh();
  });
  // The desktop shell pins a port so the renderer keeps one origin across
  // restarts — localStorage (chat history, prefs) is keyed by origin, and an
  // ephemeral port silently threw it away every launch. If something else
  // already holds the pinned port, fall back to ephemeral rather than refusing
  // to boot: a lost history beats a dead app.
  server.on("error", (err) => {
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE" && PORT !== 0) {
      console.warn(`[server] port ${PORT} in use — falling back to an ephemeral port`);
      server.listen(0, HOST);
      return;
    }
    console.error("[server] listen failed:", err);
    process.exit(1);
  });
  // Stripe billing reconciliation jobs (purchase/subscription backfill, refund
  // retries) are meaningless in a free, single-user local app — skip both the
  // one-shot startup passes and the recurring timers under LOCAL_MODE.
  if (!LOCAL_MODE) {
    backfillPendingPurchases().catch((err) => {
      console.error("[startup] Backfill pending purchases failed:", err);
    });
    backfillMissingSubscriptions().catch((err) => {
      console.error("[startup] Backfill missing subscriptions failed:", err);
    });
    retryPendingRefunds().catch((err) => {
      console.error("[startup] Retry pending refunds failed:", err);
    });
    const SUBSCRIPTION_BACKFILL_INTERVAL_MS = 6 * 60 * 60 * 1000;
    const subscriptionBackfillTimer = setInterval(() => {
      backfillMissingSubscriptions().catch((err) => {
        console.error("[periodic] Backfill missing subscriptions failed:", err);
      });
    }, SUBSCRIPTION_BACKFILL_INTERVAL_MS);
    if (typeof subscriptionBackfillTimer.unref === "function") subscriptionBackfillTimer.unref();

    const PENDING_REFUNDS_INTERVAL_MS = 5 * 60 * 1000;
    const pendingRefundsTimer = setInterval(() => {
      retryPendingRefunds().catch((err) => {
        console.error("[periodic] Retry pending refunds failed:", err);
      });
    }, PENDING_REFUNDS_INTERVAL_MS);
    if (typeof pendingRefundsTimer.unref === "function") pendingRefundsTimer.unref();
  }

  // Canvas checkpoint flush is now event-driven via scheduleCanvasFlush() in
  // server/services/canvasCheckpointScheduler.ts. No always-on setInterval here.

  const TOMBSTONE_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
  const tombstonePruneTimer = setInterval(() => {
    pool.query(
      `DELETE FROM canvas_node_tombstones WHERE deleted_at < NOW() - INTERVAL '30 days'`
    ).then((result) => {
      if (result.rowCount && result.rowCount > 0) {
        console.log(`[tombstone-prune] Removed ${result.rowCount} tombstone(s) older than 30 days`);
      }
    }).catch((err) => {
      console.error("[tombstone-prune] Failed to prune old tombstones:", err);
    });
  }, TOMBSTONE_PRUNE_INTERVAL_MS);
  if (typeof tombstonePruneTimer.unref === "function") tombstonePruneTimer.unref();

  process.on("SIGTERM", async () => {
    console.log("[shutdown] SIGTERM received — running final canvas checkpoint flush...");
    await flushCanvasNow().catch((err) => {
      console.error("[shutdown] Final canvas checkpoint failed:", err);
    });
    await pool.end().catch((err) => {
      console.error("[shutdown] pool.end() error:", err);
    });
    if (redisClient) {
      await redisClient.quit().catch((err) => {
        console.error("[shutdown] redis.quit() error:", err);
      });
    }
    process.exit(0);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
