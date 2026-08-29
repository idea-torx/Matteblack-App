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

router.post("/api/axioms/upload-image", upload.single("file"), async (req: AuthRequest, res: Response) => {
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
    const fileUrl = await saveFile(`users/${userId}`, `axioms/${uuidv4()}${ext}`, req.file.buffer);
    res.json({ url: fileUrl });
  } catch (err) {
    console.error("Axiom image upload error:", err);
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

router.get("/api/axioms", async (req: AuthRequest, res: Response) => {
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
      query = "SELECT * FROM axioms WHERE workspace_id = $1";
      params.push(workspace_id);
      if (bucket_id) {
        query += " AND bucket_id = $2";
        params.push(bucket_id);
      }
    } else {
      query = "SELECT * FROM axioms WHERE user_id = $1";
      params.push(userId);
      if (bucket_id) {
        query += " AND bucket_id = $2";
        params.push(bucket_id);
      }
    }

    query += " ORDER BY created_at DESC";
    const result = await pool.query(query, params);
    res.json({ axioms: result.rows });
  } catch (err) {
    console.error("List axioms error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to fetch axioms" } });
  }
});

router.get("/api/axioms/:id", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { id } = req.params;
    const result = await pool.query("SELECT * FROM axioms WHERE id = $1", [id]);
    if (result.rows.length === 0) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Axiom not found" } });
      return;
    }
    const axiom = result.rows[0];
    if (axiom.user_id && axiom.user_id !== userId) {
      res.status(403).json({ error: { code: "FORBIDDEN", message: "Not your axiom" } });
      return;
    }
    if (axiom.workspace_id) {
      const role = await checkWorkspaceRole(userId, axiom.workspace_id);
      if (!role) {
        res.status(403).json({ error: { code: "NOT_MEMBER", message: "Not a member of this workspace" } });
        return;
      }
    }
    res.json({ axiom });
  } catch (err) {
    console.error("Get axiom error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to fetch axiom" } });
  }
});

router.post("/api/axioms", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { name, description, images, bucket_id, scope, workspace_id } = req.body;

    if (!name || !images || !Array.isArray(images) || images.length === 0) {
      res.status(400).json({ error: { code: "MISSING_FIELDS", message: "name and images are required" } });
      return;
    }

    if (bucket_id) {
      const bucketCheck = await pool.query("SELECT id, user_id, workspace_id FROM buckets WHERE id = $1", [bucket_id]);
      if (bucketCheck.rows.length === 0) {
        res.status(400).json({ error: { code: "INVALID_BUCKET", message: "Bucket not found" } });
        return;
      }
      const bucket = bucketCheck.rows[0];
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
      result = await pool.query(
        `INSERT INTO axioms (workspace_id, name, description, images, bucket_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [workspace_id, name.trim(), description || "", JSON.stringify(images), bucket_id || null]
      );
    } else {
      result = await pool.query(
        `INSERT INTO axioms (user_id, name, description, images, bucket_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [userId, name.trim(), description || "", JSON.stringify(images), bucket_id || null]
      );
    }

    res.status(201).json({ axiom: result.rows[0] });
  } catch (err) {
    console.error("Create axiom error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to create axiom" } });
  }
});

router.put("/api/axioms/:id", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { id } = req.params;
    const { name, description, images, bucket_id } = req.body;

    const existing = await pool.query("SELECT * FROM axioms WHERE id = $1", [id]);
    if (existing.rows.length === 0) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Axiom not found" } });
      return;
    }
    const axiom = existing.rows[0];

    if (axiom.user_id && axiom.user_id !== userId) {
      res.status(403).json({ error: { code: "FORBIDDEN", message: "Not your axiom" } });
      return;
    }
    if (axiom.workspace_id) {
      const role = await checkWorkspaceRole(userId, axiom.workspace_id);
      if (!role) {
        res.status(403).json({ error: { code: "NOT_MEMBER", message: "Not a member of this workspace" } });
        return;
      }
    }

    if (bucket_id !== undefined && bucket_id !== null) {
      const bucketCheck = await pool.query("SELECT id, user_id, workspace_id FROM buckets WHERE id = $1", [bucket_id]);
      if (bucketCheck.rows.length === 0) {
        res.status(400).json({ error: { code: "INVALID_BUCKET", message: "Bucket not found" } });
        return;
      }
      const bucket = bucketCheck.rows[0];
      if (axiom.workspace_id) {
        if (bucket.workspace_id !== axiom.workspace_id) {
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
    if (description !== undefined) { updates.push(`description = $${idx++}`); params.push(description); }
    if (images !== undefined) { updates.push(`images = $${idx++}`); params.push(JSON.stringify(images)); }
    if (bucket_id !== undefined) { updates.push(`bucket_id = $${idx++}`); params.push(bucket_id); }
    updates.push(`updated_at = now()`);

    if (updates.length === 1) {
      res.json({ axiom });
      return;
    }

    params.push(id);
    const result = await pool.query(
      `UPDATE axioms SET ${updates.join(", ")} WHERE id = $${idx} RETURNING *`,
      params
    );
    res.json({ axiom: result.rows[0] });
  } catch (err) {
    console.error("Update axiom error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to update axiom" } });
  }
});

router.delete("/api/axioms/:id", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { id } = req.params;

    const existing = await pool.query("SELECT * FROM axioms WHERE id = $1", [id]);
    if (existing.rows.length === 0) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Axiom not found" } });
      return;
    }
    const axiom = existing.rows[0];

    if (axiom.user_id && axiom.user_id !== userId) {
      res.status(403).json({ error: { code: "FORBIDDEN", message: "Not your axiom" } });
      return;
    }
    if (axiom.workspace_id) {
      const role = await checkWorkspaceRole(userId, axiom.workspace_id);
      if (!role) {
        res.status(403).json({ error: { code: "NOT_MEMBER", message: "Not a member of this workspace" } });
        return;
      }
    }

    await pool.query("DELETE FROM axioms WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete axiom error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to delete axiom" } });
  }
});

export default router;
