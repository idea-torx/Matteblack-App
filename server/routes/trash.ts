import { Router, Request, Response } from "express";
import { pool } from "../db.js";
import { deleteFile, parseFileUrl } from "../storage.js";

interface AuthRequest extends Request {
  userId?: string;
}

const router = Router();

router.get("/api/trash", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;

    const [assets, audio] = await Promise.all([
      pool.query(
        "SELECT id, name, type, file_url, metadata, deleted_at, created_at FROM assets WHERE user_id = $1 AND deleted_at IS NOT NULL AND deleted_at > now() - interval '30 days' ORDER BY deleted_at DESC",
        [userId]
      ),
      pool.query(
        "SELECT id, name, audio_class, file_url, duration_seconds, metadata, deleted_at, created_at FROM audio_assets WHERE user_id = $1 AND deleted_at IS NOT NULL AND deleted_at > now() - interval '30 days' ORDER BY deleted_at DESC",
        [userId]
      ),
    ]);

    const items = [
      ...assets.rows.map((r: any) => ({ ...r, trash_type: "asset" })),
      ...audio.rows.map((r: any) => ({ ...r, trash_type: "audio" })),
    ].sort((a, b) => new Date(b.deleted_at).getTime() - new Date(a.deleted_at).getTime());

    res.json({ items, count: items.length });
  } catch (err) {
    console.error("List trash error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to fetch trash" } });
  }
});

router.put("/api/trash/restore/:trashType/:id", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { trashType, id } = req.params;

    const table = trashType === "asset" ? "assets" : trashType === "audio" ? "audio_assets" : null;
    if (!table) {
      res.status(400).json({ error: { code: "INVALID_TYPE", message: "trash type must be 'asset' or 'audio'" } });
      return;
    }

    const result = await pool.query(
      `UPDATE ${table} SET deleted_at = NULL WHERE id = $1 AND user_id = $2 AND deleted_at IS NOT NULL RETURNING *`,
      [id, userId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Trashed item not found" } });
      return;
    }
    res.json({ ok: true, item: result.rows[0] });
  } catch (err) {
    console.error("Restore from trash error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to restore item" } });
  }
});

router.delete("/api/trash/:trashType/:id", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { trashType, id } = req.params;

    const table = trashType === "asset" ? "assets" : trashType === "audio" ? "audio_assets" : null;
    if (!table) {
      res.status(400).json({ error: { code: "INVALID_TYPE", message: "trash type must be 'asset' or 'audio'" } });
      return;
    }

    const item = await pool.query(
      `SELECT * FROM ${table} WHERE id = $1 AND user_id = $2 AND deleted_at IS NOT NULL`,
      [id, userId]
    );
    if (item.rows.length === 0) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Trashed item not found" } });
      return;
    }

    const row = item.rows[0];
    const parsed = row.file_url ? parseFileUrl(row.file_url) : null;
    if (parsed) {
      await deleteFile(parsed.bucket, parsed.path).catch(() => {});
    }

    await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Permanent delete error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to permanently delete" } });
  }
});

router.delete("/api/trash/empty", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;

    const [assets, audio] = await Promise.all([
      pool.query("SELECT file_url FROM assets WHERE user_id = $1 AND deleted_at IS NOT NULL", [userId]),
      pool.query("SELECT file_url FROM audio_assets WHERE user_id = $1 AND deleted_at IS NOT NULL", [userId]),
    ]);

    const allFiles = [...assets.rows, ...audio.rows];
    for (const row of allFiles) {
      const parsed = row.file_url ? parseFileUrl(row.file_url) : null;
      if (parsed) {
        await deleteFile(parsed.bucket, parsed.path).catch(() => {});
      }
    }

    await Promise.all([
      pool.query("DELETE FROM assets WHERE user_id = $1 AND deleted_at IS NOT NULL", [userId]),
      pool.query("DELETE FROM audio_assets WHERE user_id = $1 AND deleted_at IS NOT NULL", [userId]),
    ]);

    res.json({ ok: true });
  } catch (err) {
    console.error("Empty trash error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to empty trash" } });
  }
});

export default router;
