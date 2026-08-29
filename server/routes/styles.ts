import { Router, Request, Response } from "express";
import { pool } from "../db.js";
import multer from "multer";
import { saveFile } from "../storage.js";
import { v4 as uuidv4 } from "uuid";
import path from "path";

interface AuthRequest extends Request {
  userId?: string;
}

const ALLOWED_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const ALLOWED_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const router = Router();

router.post("/api/styles/upload-image", upload.single("file"), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    if (!req.file) {
      res.status(400).json({ error: { code: "NO_FILE", message: "No file uploaded" } });
      return;
    }
    const ext = (path.extname(req.file.originalname) || ".png").toLowerCase();
    if (!ALLOWED_IMAGE_MIMES.has(req.file.mimetype) || !ALLOWED_IMAGE_EXTS.has(ext)) {
      res.status(400).json({ error: { code: "INVALID_TYPE", message: "Only PNG, JPEG, WebP and GIF images are allowed" } });
      return;
    }
    const fileUrl = await saveFile(`users/${userId}`, `styles/${uuidv4()}${ext}`, req.file.buffer);
    res.json({ url: fileUrl });
  } catch (err) {
    console.error("Style image upload error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to upload image" } });
  }
});

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

router.get("/api/styles", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { scope, workspace_id, bucket_id } = req.query;

    let query: string;
    const params: any[] = [];

    if (scope === "org" && workspace_id) {
      const role = await checkWorkspaceRole(userId, workspace_id as string);
      if (!role) {
        res.status(403).json({ error: { code: "NOT_MEMBER", message: "Not a member of this workspace" } });
        return;
      }
      query = "SELECT * FROM styles WHERE workspace_id = $1";
      params.push(workspace_id);
      if (bucket_id) {
        query += " AND bucket_id = $2";
        params.push(bucket_id);
      }
    } else {
      query = "SELECT * FROM styles WHERE user_id = $1";
      params.push(userId);
      if (bucket_id) {
        query += " AND bucket_id = $2";
        params.push(bucket_id);
      }
    }

    query += " ORDER BY created_at DESC";
    const result = await pool.query(query, params);
    res.json({ styles: result.rows });
  } catch (err) {
    console.error("List styles error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to fetch styles" } });
  }
});

router.get("/api/styles/:id", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { id } = req.params;
    const result = await pool.query("SELECT * FROM styles WHERE id = $1", [id]);
    if (result.rows.length === 0) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Style not found" } });
      return;
    }
    const style = result.rows[0];
    if (style.user_id && style.user_id !== userId) {
      res.status(403).json({ error: { code: "FORBIDDEN", message: "Not your style" } });
      return;
    }
    if (style.workspace_id) {
      const role = await checkWorkspaceRole(userId, style.workspace_id);
      if (!role) {
        res.status(403).json({ error: { code: "NOT_MEMBER", message: "Not a member of this workspace" } });
        return;
      }
    }
    res.json({ style });
  } catch (err) {
    console.error("Get style error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to fetch style" } });
  }
});

router.post("/api/styles", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { name, prompt, image_url, bucket_id, scope, workspace_id } = req.body;

    if (!name || !prompt) {
      res.status(400).json({ error: { code: "MISSING_FIELDS", message: "name and prompt are required" } });
      return;
    }

    if (bucket_id) {
      const bucketCheck = await pool.query("SELECT id, user_id, workspace_id, type FROM buckets WHERE id = $1", [bucket_id]);
      if (bucketCheck.rows.length === 0) {
        res.status(400).json({ error: { code: "INVALID_BUCKET", message: "Bucket not found" } });
        return;
      }
      const bucket = bucketCheck.rows[0];
      if (bucket.type !== "style") {
        res.status(400).json({ error: { code: "INVALID_BUCKET", message: "Bucket is not a style bucket" } });
        return;
      }
      if (scope === "org" && workspace_id) {
        if (bucket.workspace_id !== workspace_id) {
          res.status(403).json({ error: { code: "FORBIDDEN", message: "Bucket does not belong to this workspace" } });
          return;
        }
      } else {
        if (bucket.user_id !== userId) {
          res.status(403).json({ error: { code: "FORBIDDEN", message: "Bucket does not belong to you" } });
          return;
        }
      }
    }

    let result;
    if (scope === "org" && workspace_id) {
      const role = await checkWorkspaceRole(userId, workspace_id);
      if (!role) {
        res.status(403).json({ error: { code: "NOT_MEMBER", message: "Not a member of this workspace" } });
        return;
      }
      if (!isAdminOrOwner(role)) {
        res.status(403).json({ error: { code: "FORBIDDEN", message: "Only admins and owners can create workspace styles" } });
        return;
      }
      result = await pool.query(
        `INSERT INTO styles (workspace_id, name, prompt, image_url, bucket_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [workspace_id, name.trim(), prompt, image_url || null, bucket_id || null]
      );
    } else {
      result = await pool.query(
        `INSERT INTO styles (user_id, name, prompt, image_url, bucket_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [userId, name.trim(), prompt, image_url || null, bucket_id || null]
      );
    }

    res.status(201).json({ style: result.rows[0] });
  } catch (err) {
    console.error("Create style error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to create style" } });
  }
});

router.put("/api/styles/:id", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { id } = req.params;
    const { name, prompt, image_url, bucket_id } = req.body;

    const existing = await pool.query("SELECT * FROM styles WHERE id = $1", [id]);
    if (existing.rows.length === 0) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Style not found" } });
      return;
    }
    const style = existing.rows[0];

    if (style.user_id && style.user_id !== userId) {
      res.status(403).json({ error: { code: "FORBIDDEN", message: "Not your style" } });
      return;
    }
    if (style.workspace_id) {
      const role = await checkWorkspaceRole(userId, style.workspace_id);
      if (!role) {
        res.status(403).json({ error: { code: "NOT_MEMBER", message: "Not a member of this workspace" } });
        return;
      }
      if (!isAdminOrOwner(role)) {
        res.status(403).json({ error: { code: "FORBIDDEN", message: "Only admins and owners can edit workspace styles" } });
        return;
      }
    }

    if (bucket_id !== undefined && bucket_id !== null) {
      const bucketCheck = await pool.query("SELECT id, user_id, workspace_id, type FROM buckets WHERE id = $1", [bucket_id]);
      if (bucketCheck.rows.length === 0) {
        res.status(400).json({ error: { code: "INVALID_BUCKET", message: "Bucket not found" } });
        return;
      }
      const bucket = bucketCheck.rows[0];
      if (bucket.type !== "style") {
        res.status(400).json({ error: { code: "INVALID_BUCKET", message: "Bucket is not a style bucket" } });
        return;
      }
      if (style.workspace_id) {
        if (bucket.workspace_id !== style.workspace_id) {
          res.status(403).json({ error: { code: "FORBIDDEN", message: "Bucket does not belong to this workspace" } });
          return;
        }
      } else {
        if (bucket.user_id !== userId) {
          res.status(403).json({ error: { code: "FORBIDDEN", message: "Bucket does not belong to you" } });
          return;
        }
      }
    }

    const updates: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (name !== undefined) { updates.push(`name = $${idx++}`); params.push(name.trim()); }
    if (prompt !== undefined) { updates.push(`prompt = $${idx++}`); params.push(prompt); }
    if (image_url !== undefined) { updates.push(`image_url = $${idx++}`); params.push(image_url); }
    if (bucket_id !== undefined) { updates.push(`bucket_id = $${idx++}`); params.push(bucket_id); }
    updates.push(`updated_at = now()`);

    if (updates.length === 1) {
      res.json({ style });
      return;
    }

    params.push(id);
    const result = await pool.query(
      `UPDATE styles SET ${updates.join(", ")} WHERE id = $${idx} RETURNING *`,
      params
    );
    res.json({ style: result.rows[0] });
  } catch (err) {
    console.error("Update style error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to update style" } });
  }
});

router.delete("/api/styles/:id", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { id } = req.params;

    const existing = await pool.query("SELECT * FROM styles WHERE id = $1", [id]);
    if (existing.rows.length === 0) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Style not found" } });
      return;
    }
    const style = existing.rows[0];

    if (style.user_id && style.user_id !== userId) {
      res.status(403).json({ error: { code: "FORBIDDEN", message: "Not your style" } });
      return;
    }
    if (style.workspace_id) {
      const role = await checkWorkspaceRole(userId, style.workspace_id);
      if (!role) {
        res.status(403).json({ error: { code: "NOT_MEMBER", message: "Not a member of this workspace" } });
        return;
      }
      if (!isAdminOrOwner(role)) {
        res.status(403).json({ error: { code: "FORBIDDEN", message: "Only admins and owners can delete workspace styles" } });
        return;
      }
    }

    await pool.query("DELETE FROM styles WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete style error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to delete style" } });
  }
});

export default router;
