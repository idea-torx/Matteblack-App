import { Router, Request, Response } from "express";
import { pool, getOrCreateDefaultFolder } from "../db.js";
import multer from "multer";
import { saveFile, deleteFile } from "../storage.js";
import { v4 as uuidv4 } from "uuid";
import path from "path";

interface AuthRequest extends Request {
  userId?: string;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const router = Router();

router.get("/api/assets", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { type, folder_id, project_id, source } = req.query;

    let where = "WHERE user_id = $1 AND deleted_at IS NULL";
    const params: unknown[] = [userId];
    let idx = 2;

    if (type) {
      where += ` AND type = $${idx++}`;
      params.push(type);
    }
    if (folder_id === "null" || folder_id === "unfiled") {
      where += " AND folder_id IS NULL";
    } else if (folder_id) {
      where += ` AND folder_id = $${idx++}`;
      params.push(folder_id);
    }
    if (project_id) {
      where += ` AND project_id = $${idx++}`;
      params.push(project_id);
    }
    if (source) {
      where += ` AND source = $${idx++}`;
      params.push(source);
    }

    const result = await pool.query(
      `SELECT * FROM assets ${where} ORDER BY created_at DESC`,
      params
    );
    res.json({ assets: result.rows });
  } catch (err) {
    console.error("List assets error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to fetch assets" } });
  }
});

router.post("/api/assets", upload.single("file"), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { name, type, source, metadata, folder_id } = req.body;

    if (!name || !type) {
      res.status(400).json({ error: { code: "MISSING_FIELDS", message: "name and type are required" } });
      return;
    }
    if (!["image", "video", "vector", "audio"].includes(type)) {
      res.status(400).json({ error: { code: "INVALID_TYPE", message: "type must be image, video, vector, or audio" } });
      return;
    }

    let fileUrl = "";
    let fileType = null;
    if (req.file) {
      const extMap: Record<string, string> = { image: ".png", vector: ".svg", video: ".mp4", audio: ".mp3" };
      const ext = path.extname(req.file.originalname) || extMap[type] || ".bin";
      fileUrl = await saveFile(`users/${userId}`, `assets/${uuidv4()}${ext}`, req.file.buffer);
      fileType = req.file.mimetype;
    }

    let targetFolderId: string;
    if (folder_id) {
      const folderCheck = await pool.query(
        "SELECT id FROM folders WHERE id = $1 AND user_id = $2",
        [folder_id, userId]
      );
      if (folderCheck.rows.length === 0) {
        res.status(403).json({ error: { code: "FORBIDDEN", message: "Folder not found or not owned by user" } });
        return;
      }
      targetFolderId = folder_id;
    } else {
      targetFolderId = await getOrCreateDefaultFolder(userId, "Uploads");
    }

    const result = await pool.query(
      `INSERT INTO assets (user_id, type, source, name, file_url, file_type, metadata, folder_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [userId, type, source || "upload", name, fileUrl, fileType, metadata ? (typeof metadata === "string" ? JSON.parse(metadata) : metadata) : {}, targetFolderId]
    );
    res.status(201).json({ asset: result.rows[0] });
  } catch (err) {
    console.error("Create asset error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to create asset" } });
  }
});

router.get("/api/assets/:id", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { id } = req.params;
    const result = await pool.query(
      `SELECT * FROM assets WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [id, userId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Asset not found" });
      return;
    }
    res.json({ asset: result.rows[0] });
  } catch (err) {
    console.error("Get asset error:", err);
    res.status(500).json({ error: "Failed to get asset" });
  }
});

router.put("/api/assets/:id/folder", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { id } = req.params;
    const { folder_id } = req.body;

    if (folder_id) {
      const folderCheck = await pool.query(
        "SELECT id FROM folders WHERE id = $1 AND user_id = $2",
        [folder_id, userId]
      );
      if (folderCheck.rows.length === 0) {
        res.status(403).json({ error: { code: "FORBIDDEN", message: "Folder not found or not owned by user" } });
        return;
      }
    }

    const result = await pool.query(
      "UPDATE assets SET folder_id = $1, updated_at = now() WHERE id = $2 AND user_id = $3 RETURNING *",
      [folder_id || null, id, userId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Asset not found" } });
      return;
    }
    res.json({ asset: result.rows[0] });
  } catch (err) {
    console.error("Move asset to folder error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to move asset" } });
  }
});

router.delete("/api/assets/:id", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { id } = req.params;

    const result = await pool.query(
      "UPDATE assets SET deleted_at = now(), folder_id = NULL WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING *",
      [id, userId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Asset not found" } });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("Soft-delete asset error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to delete asset" } });
  }
});

router.post("/api/assets/save-from-canvas", async (req: AuthRequest, res: Response) => {
  const client = await pool.connect();
  try {
    const userId = req.userId!;
    const { project_id, name, file_url, metadata, type, folder_id, default_folder } = req.body;

    if (!name) {
      res.status(400).json({ error: { code: "MISSING_FIELD", message: "name is required" } });
      return;
    }

    const assetType = type === "video" ? "video" : type === "vector" ? "vector" : "image";

    let targetFolderId: string;
    if (folder_id) {
      const folderCheck = await pool.query(
        "SELECT id FROM folders WHERE id = $1 AND user_id = $2",
        [folder_id, userId]
      );
      if (folderCheck.rows.length === 0) {
        res.status(400).json({ error: { code: "INVALID_FOLDER", message: "Folder not found" } });
        return;
      }
      targetFolderId = folder_id;
    } else {
      const allowedDefaults = ["Uploads", "Generations"];
      const folderName = allowedDefaults.includes(default_folder) ? default_folder : "Generations";
      targetFolderId = await getOrCreateDefaultFolder(userId, folderName);
    }

    await client.query("BEGIN");

    const result = await client.query(
      `INSERT INTO assets (user_id, type, folder_id, project_id, source, name, file_url, file_type, metadata)
       VALUES ($1, $2, $3, $4, 'canvas', $5, $6, NULL, $7)
       RETURNING *`,
      [userId, assetType, targetFolderId, project_id || null, name, file_url || "", metadata ? (typeof metadata === "string" ? JSON.parse(metadata) : metadata) : {}]
    );

    await client.query("COMMIT");
    res.status(201).json({ asset: result.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Save from canvas error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Couldn't save to library. Try again." } });
  } finally {
    client.release();
  }
});

export default router;
