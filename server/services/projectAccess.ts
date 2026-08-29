import { pool } from "../db.js";

export type ProjectAccessRole = "owner" | "viewer" | "none";

export async function isSharingV1EnabledForUser(userId: string | null | undefined): Promise<boolean> {
  if ((process.env.FEATURE_SHARING_V1 || "").toLowerCase() === "all") return true;
  if (!userId) return false;
  try {
    const r = await pool.query(`SELECT email FROM users WHERE id = $1`, [userId]);
    return isSharingV1Enabled(r.rows[0]?.email);
  } catch { return false; }
}

export function isSharingV1Enabled(email: string | null | undefined): boolean {
  const all = (process.env.FEATURE_SHARING_V1 || "").toLowerCase() === "all";
  if (all) return true;
  const allow = (process.env.FEATURE_SHARING_V1_EMAILS || "")
    .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const e = String(email || "").toLowerCase();
  return !!e && allow.includes(e);
}

export interface ProjectAccessResult {
  role: ProjectAccessRole;
  canvasId: string;
  workspaceId: string | null;
  ownerId: string | null;
  projectType: string | null;
  exists: boolean;
}

export async function getProjectAccess(
  userId: string | undefined | null,
  projectId: string
): Promise<ProjectAccessResult> {
  const empty: ProjectAccessResult = {
    role: "none",
    canvasId: projectId,
    workspaceId: null,
    ownerId: null,
    projectType: null,
    exists: false,
  };
  if (!projectId) return empty;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(projectId)) return empty;

  const rs = await pool.query(
    `SELECT cs.id, cs.user_id, cs.workspace_id, cs.project_type
     FROM canvas_states cs WHERE cs.id = $1`,
    [projectId]
  );
  if (rs.rows.length === 0) return empty;
  const row = rs.rows[0];
  const result: ProjectAccessResult = {
    role: "none",
    canvasId: row.id,
    workspaceId: row.workspace_id,
    ownerId: row.user_id,
    projectType: row.project_type,
    exists: true,
  };
  if (!userId) return result;

  if (row.user_id === userId) {
    result.role = "owner";
    return result;
  }

  const wm = await pool.query(
    `SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [row.workspace_id, userId]
  );
  if (wm.rows.length > 0) {
    result.role = "owner";
    return result;
  }

  const pp = await pool.query(
    `SELECT role FROM project_participants WHERE project_id = $1 AND user_id = $2`,
    [projectId, userId]
  );
  if (pp.rows.length > 0) {
    const r = pp.rows[0].role;
    result.role = r === "viewer" ? "viewer" : (r === "owner" ? "owner" : "viewer");
    return result;
  }

  return result;
}

export function logShareEvent(event: string, details: Record<string, unknown>): void {
  try {
    console.log(`[share] ${event}`, JSON.stringify(details));
  } catch {
    console.log(`[share] ${event}`);
  }
}
