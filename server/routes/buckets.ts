import { Router, Request, Response } from "express";
import { pool } from "../db.js";

interface AuthRequest extends Request {
  userId?: string;
}

const router = Router();

async function checkWorkspaceRole(userId: string, workspaceId: string): Promise<string | null> {
  const result = await pool.query(
    "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
    [workspaceId, userId]
  );
  return result.rows.length > 0 ? result.rows[0].role : null;
}

function isAdminOrOwner(role: string | null): boolean {
  return role === "admin" || role === "owner";
}

router.get("/api/buckets", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { type, scope, workspace_id } = req.query;
    if (!type) {
      res.status(400).json({ error: { code: "MISSING_FIELD", message: "type query parameter is required" } });
      return;
    }
    let result;
    if (scope === "org" && workspace_id) {
      const role = await checkWorkspaceRole(userId, workspace_id as string);
      if (!role) {
        res.status(403).json({ error: { code: "NOT_MEMBER", message: "Not a member of this workspace" } });
        return;
      }
      result = await pool.query(
        "SELECT * FROM buckets WHERE workspace_id = $1 AND type = $2 ORDER BY sort_order ASC, name ASC",
        [workspace_id, type]
      );
    } else {
      result = await pool.query(
        "SELECT * FROM buckets WHERE user_id = $1 AND type = $2 ORDER BY sort_order ASC, name ASC",
        [userId, type]
      );
    }
    res.json({ buckets: result.rows });
  } catch (err) {
    console.error("List buckets error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to fetch buckets" } });
  }
});

router.post("/api/buckets", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { name, type, scope, workspace_id } = req.body;
    if (!name || !type) {
      res.status(400).json({ error: { code: "MISSING_FIELDS", message: "name and type are required" } });
      return;
    }
    const validTypes = ["axiom", "style"];
    if (!validTypes.includes(type)) {
      res.status(400).json({ error: { code: "INVALID_TYPE", message: `type must be one of: ${validTypes.join(", ")}` } });
      return;
    }

    let result;
    if (scope === "org" && workspace_id) {
      const role = await checkWorkspaceRole(userId, workspace_id);
      if (!role) {
        res.status(403).json({ error: { code: "NOT_MEMBER", message: "Not a member of this workspace" } });
        return;
      }
      if (!isAdminOrOwner(role)) {
        res.status(403).json({ error: { code: "FORBIDDEN", message: "Only admins and owners can manage workspace buckets" } });
        return;
      }
      result = await pool.query(
        "INSERT INTO buckets (workspace_id, name, type) VALUES ($1, $2, $3) RETURNING *",
        [workspace_id, name.trim(), type]
      );
    } else {
      result = await pool.query(
        "INSERT INTO buckets (user_id, name, type) VALUES ($1, $2, $3) RETURNING *",
        [userId, name.trim(), type]
      );
    }
    res.status(201).json({ bucket: result.rows[0] });
  } catch (err: any) {
    if (err.code === "23505") {
      res.status(409).json({ error: { code: "DUPLICATE_NAME", message: "A bucket with this name already exists" } });
      return;
    }
    console.error("Create bucket error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to create bucket" } });
  }
});

router.put("/api/buckets/:id", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { id } = req.params;
    const { name } = req.body;
    if (!name) {
      res.status(400).json({ error: { code: "MISSING_FIELD", message: "name is required" } });
      return;
    }
    const bucket = await pool.query("SELECT * FROM buckets WHERE id = $1", [id]);
    if (bucket.rows.length === 0) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Bucket not found" } });
      return;
    }
    const b = bucket.rows[0];
    if (b.user_id && b.user_id !== userId) {
      res.status(403).json({ error: { code: "FORBIDDEN", message: "Not your bucket" } });
      return;
    }
    if (b.workspace_id) {
      const role = await checkWorkspaceRole(userId, b.workspace_id);
      if (!role) {
        res.status(403).json({ error: { code: "NOT_MEMBER", message: "Not a member of this workspace" } });
        return;
      }
      if (!isAdminOrOwner(role)) {
        res.status(403).json({ error: { code: "FORBIDDEN", message: "Only admins and owners can manage workspace buckets" } });
        return;
      }
    }
    const result = await pool.query(
      "UPDATE buckets SET name = $1, updated_at = now() WHERE id = $2 RETURNING *",
      [name.trim(), id]
    );
    res.json({ bucket: result.rows[0] });
  } catch (err: any) {
    if (err.code === "23505") {
      res.status(409).json({ error: { code: "DUPLICATE_NAME", message: "A bucket with this name already exists" } });
      return;
    }
    console.error("Rename bucket error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to rename bucket" } });
  }
});

router.delete("/api/buckets/:id", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { id } = req.params;
    const bucket = await pool.query("SELECT * FROM buckets WHERE id = $1", [id]);
    if (bucket.rows.length === 0) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Bucket not found" } });
      return;
    }
    const b = bucket.rows[0];
    if (b.user_id && b.user_id !== userId) {
      res.status(403).json({ error: { code: "FORBIDDEN", message: "Not your bucket" } });
      return;
    }
    if (b.workspace_id) {
      const role = await checkWorkspaceRole(userId, b.workspace_id);
      if (!role) {
        res.status(403).json({ error: { code: "NOT_MEMBER", message: "Not a member of this workspace" } });
        return;
      }
      if (!isAdminOrOwner(role)) {
        res.status(403).json({ error: { code: "FORBIDDEN", message: "Only admins and owners can manage workspace buckets" } });
        return;
      }
    }
    await pool.query("DELETE FROM buckets WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete bucket error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to delete bucket" } });
  }
});

export default router;
