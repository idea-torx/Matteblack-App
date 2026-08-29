/**
 * Seed the single local user for the login-less desktop build.
 *
 * The cloud build creates users on WorkOS sign-in / dev-login. The local build
 * has no login, so a fixed superadmin user (+ personal workspace + credits) is
 * upserted on startup. Superadmin makes every generation bypass the credit
 * gate (see creditGate.ts), so the local user has effectively unlimited use.
 * Idempotent — safe to run on every boot.
 */
import { pool } from "./db.js";
import {
  LOCAL_USER_ID,
  LOCAL_WORKSPACE_ID,
  LOCAL_USER_EMAIL,
  LOCAL_USER_NAME,
} from "./config/runtime.js";

export async function ensureLocalUser(): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, email, password_hash, display_name, role, email_verified)
     VALUES ($1, $2, NULL, $3, 'superadmin', true)
     ON CONFLICT (id) DO UPDATE SET role = 'superadmin', email_verified = true`,
    [LOCAL_USER_ID, LOCAL_USER_EMAIL, LOCAL_USER_NAME]
  );

  await pool.query(
    `INSERT INTO workspaces (id, name, owner_id, type)
     VALUES ($1, 'My Workspace', $2, 'personal')
     ON CONFLICT (id) DO NOTHING`,
    [LOCAL_WORKSPACE_ID, LOCAL_USER_ID]
  );

  await pool.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role)
     VALUES ($1, $2, 'owner')
     ON CONFLICT (workspace_id, user_id) DO NOTHING`,
    [LOCAL_WORKSPACE_ID, LOCAL_USER_ID]
  );

  await pool.query(
    `INSERT INTO credits (user_id, balance)
     VALUES ($1, 1000000000)
     ON CONFLICT (user_id) DO NOTHING`,
    [LOCAL_USER_ID]
  );

  console.log(`[startup] Local user ready (${LOCAL_USER_EMAIL}).`);
}
