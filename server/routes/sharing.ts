import { Router, Request, Response } from "express";
import { randomBytes } from "crypto";
import { pool } from "../db.js";
import { getProjectAccess, logShareEvent } from "../services/projectAccess.js";

interface AuthRequest extends Request {
  userId?: string;
}

const router = Router();

function generateShareToken(): string {
  return randomBytes(24).toString("base64url");
}

function publicShareUrl(req: Request, token: string): string {
  const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0] || req.protocol || "https";
  const host = (req.headers["x-forwarded-host"] as string)?.split(",")[0] || req.get("host") || "";
  const base = host ? `${proto}://${host}` : "";
  return `${base}/share/${token}`;
}

router.get("/api/projects/:projectId/share", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { projectId } = req.params;
    const access = await getProjectAccess(userId, projectId);
    if (!access.exists) { res.status(404).json({ error: "Project not found" }); return; }
    if (access.role !== "owner") { res.status(403).json({ error: "Only the project owner can manage sharing" }); return; }

    const settings = await pool.query(
      `SELECT enabled, share_token FROM project_share_settings WHERE project_id = $1`,
      [projectId]
    );
    const row = settings.rows[0] || { enabled: false, share_token: null };
    const url = row.enabled && row.share_token ? publicShareUrl(req, row.share_token) : null;

    const participants = await pool.query(
      `SELECT pp.user_id, pp.role, pp.joined_at, pp.last_seen_at,
              u.display_name, u.email, u.avatar_url
       FROM project_participants pp
       JOIN users u ON u.id = pp.user_id
       WHERE pp.project_id = $1
       ORDER BY pp.joined_at ASC`,
      [projectId]
    );

    res.json({
      enabled: !!row.enabled,
      shareUrl: url,
      participants: participants.rows,
    });
  } catch (err) {
    console.error("Get share settings error:", err);
    res.status(500).json({ error: "Failed to get share settings" });
  }
});

router.put("/api/projects/:projectId/share", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { projectId } = req.params;
    const enabled = !!req.body?.enabled;

    const access = await getProjectAccess(userId, projectId);
    if (!access.exists) { res.status(404).json({ error: "Project not found" }); return; }
    if (access.role !== "owner") { res.status(403).json({ error: "Only the project owner can manage sharing" }); return; }

    if (enabled) {
      const existing = await pool.query(
        `SELECT share_token FROM project_share_settings WHERE project_id = $1`,
        [projectId]
      );
      let token: string;
      if (existing.rows.length > 0 && existing.rows[0].share_token) {
        token = existing.rows[0].share_token;
        await pool.query(
          `UPDATE project_share_settings SET enabled = TRUE, updated_at = NOW() WHERE project_id = $1`,
          [projectId]
        );
      } else {
        token = generateShareToken();
        await pool.query(
          `INSERT INTO project_share_settings (project_id, enabled, share_token)
           VALUES ($1, TRUE, $2)
           ON CONFLICT (project_id) DO UPDATE SET enabled = TRUE, share_token = COALESCE(project_share_settings.share_token, EXCLUDED.share_token), updated_at = NOW()`,
          [projectId, token]
        );
        const refreshed = await pool.query(
          `SELECT share_token FROM project_share_settings WHERE project_id = $1`,
          [projectId]
        );
        token = refreshed.rows[0].share_token;
      }
      logShareEvent("link_enabled", { userId, projectId });
      res.json({ enabled: true, shareUrl: publicShareUrl(req, token) });
    } else {
      await pool.query(
        `INSERT INTO project_share_settings (project_id, enabled, share_token)
         VALUES ($1, FALSE, NULL)
         ON CONFLICT (project_id) DO UPDATE SET enabled = FALSE, share_token = NULL, updated_at = NOW()`,
        [projectId]
      );
      logShareEvent("link_disabled", { userId, projectId });
      res.json({ enabled: false, shareUrl: null });
    }
  } catch (err) {
    console.error("Update share settings error:", err);
    res.status(500).json({ error: "Failed to update share settings" });
  }
});

router.post("/api/share/redeem", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const token = (req.body?.token as string) || "";
    if (!token) { res.status(400).json({ error: "Missing token" }); return; }

    const settings = await pool.query(
      `SELECT pss.project_id, pss.enabled, cs.user_id AS owner_id, cs.workspace_id, cs.project_type
       FROM project_share_settings pss
       JOIN canvas_states cs ON cs.id = pss.project_id
       WHERE pss.share_token = $1`,
      [token]
    );
    if (settings.rows.length === 0) { res.status(404).json({ error: "Invalid or expired share link" }); return; }
    const row = settings.rows[0];
    if (!row.enabled) { res.status(410).json({ error: "Sharing has been turned off for this project" }); return; }

    const projectId = row.project_id as string;

    if (row.owner_id === userId) {
      res.json({ projectId, role: "owner", workspaceId: row.workspace_id, projectType: row.project_type });
      return;
    }

    const wm = await pool.query(
      `SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [row.workspace_id, userId]
    );
    if (wm.rows.length > 0) {
      res.json({ projectId, role: "owner", workspaceId: row.workspace_id, projectType: row.project_type });
      return;
    }

    await pool.query(
      `INSERT INTO project_participants (project_id, user_id, role)
       VALUES ($1, $2, 'viewer')
       ON CONFLICT (project_id, user_id) DO UPDATE SET last_seen_at = NOW()`,
      [projectId, userId]
    );
    logShareEvent("viewer_joined", { userId, projectId });

    res.json({ projectId, role: "viewer", workspaceId: row.workspace_id, projectType: row.project_type });
  } catch (err) {
    console.error("Redeem share error:", err);
    res.status(500).json({ error: "Failed to redeem share link" });
  }
});

router.get("/api/projects/:projectId/access", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { projectId } = req.params;
    const access = await getProjectAccess(userId, projectId);
    if (!access.exists) { res.status(404).json({ error: "Project not found" }); return; }
    if (access.role === "none") { res.status(403).json({ error: "Not authorized" }); return; }
    let ownerDisplayName: string | null = null;
    let ownerEmail: string | null = null;
    if (access.ownerId) {
      try {
        const u = await pool.query(`SELECT display_name, email FROM users WHERE id = $1`, [access.ownerId]);
        ownerDisplayName = u.rows[0]?.display_name || null;
        ownerEmail = u.rows[0]?.email || null;
      } catch {}
    }
    res.json({
      role: access.role,
      ownerId: access.ownerId,
      ownerDisplayName,
      ownerEmail,
      workspaceId: access.workspaceId,
      projectType: access.projectType,
    });
  } catch (err) {
    console.error("Get project access error:", err);
    res.status(500).json({ error: "Failed to get project access" });
  }
});

export default router;
