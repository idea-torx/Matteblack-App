import { pool } from "./db.js";

export async function createNotification(params: {
  userId: string;
  type: string;
  title: string;
  message: string;
  severity?: "info" | "warning" | "error" | "success";
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, message, severity, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        params.userId,
        params.type,
        params.title,
        params.message,
        params.severity || "info",
        JSON.stringify(params.metadata || {}),
      ]
    );
  } catch (err) {
    console.error("[Notifications] Failed to create notification:", err);
  }
}

export const LOW_CREDIT_THRESHOLD = 20;
