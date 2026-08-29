import { Router, Request, Response } from "express";
import { pool } from "../db.js";

interface AuthRequest extends Request {
  userId?: string;
}

const router = Router();

router.get("/api/folders", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { type } = req.query;
    if (!type) {
      res.status(400).json({ error: { code: "MISSING_FIELD", message: "type query parameter is required" } });
      return;
    }
    const isMediaRequest = type === "image" || type === "video";
    const result = isMediaRequest
      ? await pool.query(
          "SELECT * FROM folders WHERE user_id = $1 AND type = 'media' ORDER BY sort_order ASC, name ASC",
          [userId]
        )
      : await pool.query(
          "SELECT * FROM folders WHERE user_id = $1 AND type = $2 ORDER BY sort_order ASC, name ASC",
          [userId, type]
        );
    res.json({ folders: result.rows });
  } catch (err) {
    console.error("List folders error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to fetch folders" } });
  }
});

router.post("/api/folders", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { name, type } = req.body;
    if (!name || !type) {
      res.status(400).json({ error: { code: "MISSING_FIELDS", message: "name and type are required" } });
      return;
    }
    const validTypes = ["image", "video", "media", "music", "voice", "sound_effect"];
    if (!validTypes.includes(type)) {
      res.status(400).json({ error: { code: "INVALID_TYPE", message: `type must be one of: ${validTypes.join(", ")}` } });
      return;
    }
    const actualType = (type === "image" || type === "video") ? "media" : type;
    const result = await pool.query(
      "INSERT INTO folders (user_id, name, type) VALUES ($1, $2, $3) RETURNING *",
      [userId, name.trim(), actualType]
    );
    res.status(201).json({ folder: result.rows[0] });
  } catch (err: any) {
    if (err.code === "23505") {
      res.status(409).json({ error: { code: "DUPLICATE_NAME", message: "A folder with this name already exists" } });
      return;
    }
    console.error("Create folder error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to create folder" } });
  }
});

router.put("/api/folders/:id", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { id } = req.params;
    const { name } = req.body;
    if (!name) {
      res.status(400).json({ error: { code: "MISSING_FIELD", message: "name is required" } });
      return;
    }
    const result = await pool.query(
      "UPDATE folders SET name = $1, updated_at = now() WHERE id = $2 AND user_id = $3 RETURNING *",
      [name.trim(), id, userId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Folder not found" } });
      return;
    }
    res.json({ folder: result.rows[0] });
  } catch (err: any) {
    if (err.code === "23505") {
      res.status(409).json({ error: { code: "DUPLICATE_NAME", message: "A folder with this name already exists" } });
      return;
    }
    console.error("Rename folder error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to rename folder" } });
  }
});

router.delete("/api/folders/:id", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { id } = req.params;
    const result = await pool.query(
      "DELETE FROM folders WHERE id = $1 AND user_id = $2 RETURNING *",
      [id, userId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Folder not found" } });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete folder error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to delete folder" } });
  }
});

export default router;
