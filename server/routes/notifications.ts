import { Router, Request, Response } from "express";
import { pool } from "../db.js";

interface AuthRequest extends Request {
  userId?: string;
}

const router = Router();

router.get("/api/notifications", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    const result = await pool.query(
      `SELECT id, type, title, message, severity, metadata, read, created_at
       FROM notifications
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    const unreadResult = await pool.query(
      `SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND read = FALSE`,
      [userId]
    );

    res.json({
      notifications: result.rows,
      unread_count: unreadResult.rows[0].count,
    });
  } catch (err) {
    console.error("Get notifications error:", err);
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

router.patch("/api/notifications/:id/read", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const notifId = req.params.id;

    await pool.query(
      `UPDATE notifications SET read = TRUE WHERE id = $1 AND user_id = $2`,
      [notifId, userId]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("Mark notification read error:", err);
    res.status(500).json({ error: "Failed to mark notification as read" });
  }
});

router.post("/api/notifications/read-all", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;

    await pool.query(
      `UPDATE notifications SET read = TRUE WHERE user_id = $1 AND read = FALSE`,
      [userId]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("Mark all notifications read error:", err);
    res.status(500).json({ error: "Failed to mark all notifications as read" });
  }
});

export default router;
