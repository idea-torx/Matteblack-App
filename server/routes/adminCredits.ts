import { Router, Request, Response } from "express";
import { pool } from "../db.js";

interface AuthRequest extends Request {
  userId?: string;
}

async function requireSuperAdmin(req: AuthRequest, res: Response, next: () => void) {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const result = await pool.query(`SELECT role FROM users WHERE id = $1`, [userId]);
  if (result.rows.length === 0 || result.rows[0].role !== "superadmin") {
    res.status(403).json({ error: "Superadmin access required" });
    return;
  }
  next();
}

const router = Router();

router.get("/config", requireSuperAdmin, async (_req: AuthRequest, res: Response) => {
  res.json({ config: [], message: "Flat credit config has been removed. Use model pricing instead." });
});

router.post("/grant", requireSuperAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { user_id, amount, reason } = req.body;
    if (!user_id || !amount) {
      res.status(400).json({ error: "user_id and amount are required" });
      return;
    }

    const credits = parseInt(amount);
    if (isNaN(credits) || credits <= 0) {
      res.status(400).json({ error: "amount must be a positive integer" });
      return;
    }

    const userCheck = await pool.query(`SELECT id FROM users WHERE id = $1`, [user_id]);
    if (userCheck.rows.length === 0) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const updated = await client.query(
        `INSERT INTO credits (user_id, balance) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET balance = credits.balance + $2, updated_at = NOW()
         RETURNING balance`,
        [user_id, credits]
      );

      const newBalance = updated.rows[0].balance;

      await client.query(
        `INSERT INTO credit_ledger (user_id, amount, balance_after, reason)
         VALUES ($1, $2, $3, $4)`,
        [user_id, credits, newBalance, `admin_grant:${reason || "manual"}`]
      );

      await client.query("COMMIT");

      await pool.query(
        `DELETE FROM low_balance_alerts WHERE user_id = $1`,
        [user_id]
      );

      res.json({ user_id, new_balance: newBalance, granted: credits });
    } catch (txErr) {
      await client.query("ROLLBACK");
      throw txErr;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("[admin/credits] grant error:", err);
    res.status(500).json({ error: "Failed to grant credits" });
  }
});

router.get("/ledger", requireSuperAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
    const userId = req.query.user_id as string | undefined;
    const reason = req.query.reason as string | undefined;
    const dateFrom = req.query.date_from as string | undefined;
    const dateTo = req.query.date_to as string | undefined;

    const conditions: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (userId) {
      conditions.push(`cl.user_id = $${idx++}`);
      values.push(userId);
    }
    if (reason) {
      conditions.push(`cl.reason LIKE $${idx++}`);
      values.push(`%${reason}%`);
    }
    if (dateFrom) {
      conditions.push(`cl.created_at >= $${idx++}`);
      values.push(dateFrom);
    }
    if (dateTo) {
      conditions.push(`cl.created_at <= $${idx++}`);
      values.push(dateTo);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countResult = await pool.query(
      `SELECT COUNT(*) AS total FROM credit_ledger cl ${whereClause}`,
      values
    );
    const total = parseInt(countResult.rows[0].total, 10);

    values.push(limit, offset);
    const result = await pool.query(
      `SELECT cl.id, cl.user_id, u.email AS user_email, u.display_name AS user_name,
              cl.amount, cl.balance_after, cl.reason, cl.reference_id, cl.created_at
       FROM credit_ledger cl
       LEFT JOIN users u ON u.id = cl.user_id
       ${whereClause}
       ORDER BY cl.created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      values
    );

    res.json({ ledger: result.rows, total, limit, offset });
  } catch (err) {
    console.error("[admin/credits] ledger error:", err);
    res.status(500).json({ error: "Failed to fetch credit ledger" });
  }
});

router.get("/rate-limits", requireSuperAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT id, generation_type, max_requests, window_seconds, updated_by, updated_at
       FROM rate_limits ORDER BY generation_type`
    );
    res.json({ rateLimits: result.rows });
  } catch (err) {
    console.error("[admin/credits] rate limits list error:", err);
    res.status(500).json({ error: "Failed to fetch rate limits" });
  }
});

router.put("/rate-limits/:id", requireSuperAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { max_requests, window_seconds } = req.body;
    const updates: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (max_requests !== undefined) {
      const mr = parseInt(max_requests);
      if (isNaN(mr) || mr < 1) {
        res.status(400).json({ error: "Invalid max_requests" });
        return;
      }
      updates.push(`max_requests = $${idx++}`);
      values.push(mr);
    }

    if (window_seconds !== undefined) {
      const ws = parseInt(window_seconds);
      if (isNaN(ws) || ws < 1) {
        res.status(400).json({ error: "Invalid window_seconds" });
        return;
      }
      updates.push(`window_seconds = $${idx++}`);
      values.push(ws);
    }

    if (updates.length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }

    updates.push(`updated_by = $${idx++}`);
    values.push(req.userId);
    updates.push(`updated_at = NOW()`);

    values.push(id);
    const result = await pool.query(
      `UPDATE rate_limits SET ${updates.join(", ")} WHERE id = $${idx} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: "Rate limit entry not found" });
      return;
    }

    res.json({ rateLimit: result.rows[0] });
  } catch (err) {
    console.error("[admin/credits] rate limit update error:", err);
    res.status(500).json({ error: "Failed to update rate limit" });
  }
});

router.get("/settings", requireSuperAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(`SELECT key, value, updated_at FROM credit_settings`);
    const settings: Record<string, string> = {};
    for (const row of result.rows) {
      settings[row.key] = row.value;
    }
    res.json({ settings });
  } catch (err) {
    console.error("[admin/credits] settings error:", err);
    res.status(500).json({ error: "Failed to fetch credit settings" });
  }
});

router.put("/settings/:key", requireSuperAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { key } = req.params;
    const { value } = req.body;
    if (value === undefined) {
      res.status(400).json({ error: "value is required" });
      return;
    }

    const result = await pool.query(
      `INSERT INTO credit_settings (key, value, updated_by, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $3, updated_at = NOW()
       RETURNING *`,
      [key, String(value), req.userId]
    );

    res.json({ setting: result.rows[0] });
  } catch (err) {
    console.error("[admin/credits] setting update error:", err);
    res.status(500).json({ error: "Failed to update setting" });
  }
});

router.get("/model-pricing", requireSuperAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT id, model_key, base_cost, resolution_multipliers, duration_multipliers, feature_surcharges,
              input_token_net_cost_per_million, output_token_net_cost_per_million,
              is_active, updated_by, updated_at
       FROM model_pricing ORDER BY model_key`
    );
    res.json({ modelPricing: result.rows });
  } catch (err) {
    console.error("[admin/credits] model pricing list error:", err);
    res.status(500).json({ error: "Failed to fetch model pricing" });
  }
});

router.put("/model-pricing/:id", requireSuperAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const {
      base_cost,
      resolution_multipliers,
      duration_multipliers,
      feature_surcharges,
      is_active,
      input_token_net_cost_per_million,
      output_token_net_cost_per_million,
    } = req.body;
    const updates: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (base_cost !== undefined) {
      const cost = parseInt(base_cost);
      if (isNaN(cost) || cost < 0) {
        res.status(400).json({ error: "Invalid base_cost" });
        return;
      }
      updates.push(`base_cost = $${idx++}`);
      values.push(cost);
    }

    // Token rates accept fractional dollars per 1M tokens (e.g. Sonnet's
    // $3 input / $15 output). They're persisted as NUMERIC(12,4) so
    // values like 0.075 round-trip cleanly. Admins enter the *net*
    // Anthropic price; the platform margin is applied automatically at
    // billing time.
    if (input_token_net_cost_per_million !== undefined) {
      const v = Number(input_token_net_cost_per_million);
      if (!Number.isFinite(v) || v < 0) {
        res.status(400).json({ error: "Invalid input_token_net_cost_per_million" });
        return;
      }
      updates.push(`input_token_net_cost_per_million = $${idx++}`);
      values.push(v);
    }

    if (output_token_net_cost_per_million !== undefined) {
      const v = Number(output_token_net_cost_per_million);
      if (!Number.isFinite(v) || v < 0) {
        res.status(400).json({ error: "Invalid output_token_net_cost_per_million" });
        return;
      }
      updates.push(`output_token_net_cost_per_million = $${idx++}`);
      values.push(v);
    }

    if (resolution_multipliers !== undefined) {
      updates.push(`resolution_multipliers = $${idx++}`);
      values.push(resolution_multipliers ? JSON.stringify(resolution_multipliers) : null);
    }

    if (duration_multipliers !== undefined) {
      updates.push(`duration_multipliers = $${idx++}`);
      values.push(duration_multipliers ? JSON.stringify(duration_multipliers) : null);
    }

    if (feature_surcharges !== undefined) {
      updates.push(`feature_surcharges = $${idx++}`);
      values.push(feature_surcharges ? JSON.stringify(feature_surcharges) : null);
    }

    if (is_active !== undefined) {
      updates.push(`is_active = $${idx++}`);
      values.push(!!is_active);
    }

    if (updates.length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }

    updates.push(`updated_by = $${idx++}`);
    values.push(req.userId);
    updates.push(`updated_at = NOW()`);

    values.push(id);
    const result = await pool.query(
      `UPDATE model_pricing SET ${updates.join(", ")} WHERE id = $${idx} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: "Model pricing entry not found" });
      return;
    }

    res.json({ modelPricing: result.rows[0] });
  } catch (err) {
    console.error("[admin/credits] model pricing update error:", err);
    res.status(500).json({ error: "Failed to update model pricing" });
  }
});

router.get("/workspace-balances", requireSuperAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT wc.workspace_id, w.name AS workspace_name, w.type AS workspace_type, wc.balance, wc.updated_at
       FROM workspace_credits wc
       JOIN workspaces w ON w.id = wc.workspace_id
       ORDER BY wc.updated_at DESC`
    );
    res.json({ workspaceCredits: result.rows });
  } catch (err) {
    console.error("[admin/credits] workspace balances error:", err);
    res.status(500).json({ error: "Failed to fetch workspace credit balances" });
  }
});

router.post("/workspace-grant", requireSuperAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { workspace_id, amount, reason } = req.body;
    if (!workspace_id || !amount) {
      res.status(400).json({ error: "workspace_id and amount are required" });
      return;
    }

    const credits = parseInt(amount);
    if (isNaN(credits) || credits <= 0) {
      res.status(400).json({ error: "amount must be a positive integer" });
      return;
    }

    const wsCheck = await pool.query(`SELECT id FROM workspaces WHERE id = $1`, [workspace_id]);
    if (wsCheck.rows.length === 0) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const updated = await client.query(
        `INSERT INTO workspace_credits (workspace_id, balance) VALUES ($1, $2)
         ON CONFLICT (workspace_id) DO UPDATE SET balance = workspace_credits.balance + $2, updated_at = NOW()
         RETURNING balance`,
        [workspace_id, credits]
      );

      const newBalance = updated.rows[0].balance;

      await client.query(
        `INSERT INTO credit_ledger (user_id, org_id, amount, balance_after, reason)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.userId, workspace_id, credits, newBalance, `admin_grant:${reason || "manual"}`]
      );

      await client.query("COMMIT");

      await pool.query(
        `DELETE FROM low_balance_alerts WHERE workspace_id = $1`,
        [workspace_id]
      );

      res.json({ workspace_id, new_balance: newBalance, granted: credits });
    } catch (txErr) {
      await client.query("ROLLBACK");
      throw txErr;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("[admin/credits] workspace grant error:", err);
    res.status(500).json({ error: "Failed to grant workspace credits" });
  }
});

router.get("/users", requireSuperAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const search = req.query.search as string | undefined;
    let query = `SELECT id, email, display_name FROM users`;
    const values: unknown[] = [];

    if (search) {
      query += ` WHERE email ILIKE $1 OR display_name ILIKE $1`;
      values.push(`%${search}%`);
    }

    query += ` ORDER BY email LIMIT 50`;
    const result = await pool.query(query, values);
    res.json({ users: result.rows });
  } catch (err) {
    console.error("[admin/credits] users search error:", err);
    res.status(500).json({ error: "Failed to search users" });
  }
});

export default router;
