/**
 * Runtime mode detection and local data paths.
 *
 * The app can run in two modes:
 *  - "cloud"  — the original Replit/production deployment: WorkOS auth, a
 *               managed Postgres (DATABASE_URL), Cloudflare R2 storage, Stripe.
 *  - "local"  — the login-less open-source desktop build: an embedded Postgres
 *               (PGlite) under a per-user data directory, files on local disk,
 *               a single fixed local user, and no billing.
 *
 * LOCAL_MODE is enabled explicitly with LOCAL_MODE=true, or inferred when
 * neither a cloud database nor WorkOS credentials are configured (which is the
 * default for someone who just cloned the repo and ran it).
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export const LOCAL_MODE: boolean =
  process.env.LOCAL_MODE === "true" ||
  (process.env.LOCAL_MODE !== "false" &&
    !process.env.DATABASE_URL &&
    !process.env.WORKOS_API_KEY);

/**
 * Where all local state lives: embedded Postgres, uploaded/generated files,
 * and the user config (API keys). Override with MATTEBLACK_DATA_DIR — the
 * Electron shell sets this to app.getPath("userData").
 */
export const DATA_DIR: string =
  process.env.MATTEBLACK_DATA_DIR || path.join(os.homedir(), ".matteblack");

export const PG_DATA_DIR = path.join(DATA_DIR, "pgdata");
export const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
export const CONFIG_PATH = path.join(DATA_DIR, "config.json");

/**
 * Discovery file for the MCP bridge (Phase J). The server writes its bound
 * loopback baseUrl + a per-boot token here on startup; the out-of-process stdio
 * MCP server (`server/mcp/index.ts`, spawned by Claude Desktop/Code) reads it to
 * find the running app. Lives in the same data dir so both processes agree on it
 * via MATTEBLACK_DATA_DIR.
 */
export const MCP_ENDPOINT_PATH = path.join(DATA_DIR, "mcp-endpoint.json");

/**
 * Fixed identity for the single local user. Deterministic UUIDs so the same
 * rows are reused across restarts. These are only ever used when LOCAL_MODE.
 */
export const LOCAL_USER_ID = "00000000-0000-4000-8000-000000000001";
export const LOCAL_WORKSPACE_ID = "00000000-0000-4000-8000-000000000002";
export const LOCAL_USER_EMAIL = "local@matteblack.app";
export const LOCAL_USER_NAME = "Local User";

let ensured = false;
/** Create the data directory tree. Safe to call repeatedly. */
export function ensureDataDir(): void {
  if (ensured) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  ensured = true;
}

if (LOCAL_MODE) {
  // Make sure downstream modules that read NODE_ENV treat a bare local run as
  // development (enables the in-memory Redis fallback, non-secure cookies, …).
  if (!process.env.NODE_ENV) process.env.NODE_ENV = "development";
  console.log(`[runtime] LOCAL_MODE enabled — data dir: ${DATA_DIR}`);
}
