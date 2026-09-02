/**
 * Scheduled operator runs — CRUD over `operator_jobs`.
 *
 *   GET    /api/operator/jobs
 *   POST   /api/operator/jobs        {name, prompt, cron, runner?, model?, effort?}
 *   PATCH  /api/operator/jobs/:id    {enabled?, name?, prompt?, cron?}
 *   DELETE /api/operator/jobs/:id
 *   POST   /api/operator/jobs/:id/run   — fire now, returns immediately
 *
 * Cron is interpreted in the server machine's LOCAL time zone; see
 * server/operator/scheduler.ts.
 */
import { Router } from "express";
import { requireAuth, type AuthRequest } from "../sessions.js";
import { pool } from "../db.js";
import { computeNext, runJob, type OperatorJob } from "../operator/scheduler.js";

const router = Router();

const COLS = `id, name, prompt, cron, runner, model, effort, enabled,
              last_run_at, next_run_at, last_result, last_error, fails, created_at`;

function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
}

router.get("/api/operator/jobs", requireAuth, async (req: AuthRequest, res) => {
  const r = await pool.query(
    `SELECT ${COLS} FROM operator_jobs WHERE user_id = $1 ORDER BY created_at DESC`,
    [req.userId],
  );
  res.json({ jobs: r.rows });
});

router.post("/api/operator/jobs", requireAuth, async (req: AuthRequest, res) => {
  const b = (req.body || {}) as Record<string, unknown>;
  const name = str(b.name, 120);
  const prompt = str(b.prompt, 8000);
  const cron = str(b.cron, 120);
  if (!name || !prompt || !cron) {
    res.status(400).json({ error: "name, prompt and cron are required" });
    return;
  }
  let next: Date;
  try {
    next = computeNext(cron);
  } catch (err) {
    res.status(400).json({ error: `Invalid cron: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }
  const r = await pool.query(
    `INSERT INTO operator_jobs (user_id, name, prompt, cron, runner, model, effort, next_run_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLS}`,
    [req.userId, name, prompt, cron, str(b.runner, 32), str(b.model, 120), str(b.effort, 16), next],
  );
  res.json({ job: r.rows[0] });
});

router.patch("/api/operator/jobs/:id", requireAuth, async (req: AuthRequest, res) => {
  const b = (req.body || {}) as Record<string, unknown>;
  const sets: string[] = [];
  const vals: unknown[] = [req.params.id, req.userId];
  const push = (sql: string, v: unknown) => { vals.push(v); sets.push(`${sql} = $${vals.length}`); };

  const name = str(b.name, 120);
  if (name) push("name", name);
  const prompt = str(b.prompt, 8000);
  if (prompt) push("prompt", prompt);
  const cron = str(b.cron, 120);
  if (cron) {
    try {
      push("next_run_at", computeNext(cron));
    } catch (err) {
      res.status(400).json({ error: `Invalid cron: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    push("cron", cron);
  }
  if (typeof b.enabled === "boolean") {
    push("enabled", b.enabled);
    // Re-enabling clears the failure count that paused it, and re-arms the
    // clock — otherwise a job paused after 3 failures has next_run_at NULL and
    // would sit enabled but never fire.
    if (b.enabled) {
      push("fails", 0);
      if (!cron) {
        const cur = await pool.query(`SELECT cron FROM operator_jobs WHERE id = $1 AND user_id = $2`, [req.params.id, req.userId]);
        if (cur.rows.length === 0) { res.status(404).json({ error: "not found" }); return; }
        try { push("next_run_at", computeNext(cur.rows[0].cron as string)); } catch { /* bad stored cron */ }
      }
    }
  }
  if (sets.length === 0) { res.status(400).json({ error: "nothing to update" }); return; }

  const r = await pool.query(
    `UPDATE operator_jobs SET ${sets.join(", ")} WHERE id = $1 AND user_id = $2 RETURNING ${COLS}`,
    vals,
  );
  if (r.rows.length === 0) { res.status(404).json({ error: "not found" }); return; }
  res.json({ job: r.rows[0] });
});

router.delete("/api/operator/jobs/:id", requireAuth, async (req: AuthRequest, res) => {
  const r = await pool.query(`DELETE FROM operator_jobs WHERE id = $1 AND user_id = $2`, [req.params.id, req.userId]);
  if (!r.rowCount) { res.status(404).json({ error: "not found" }); return; }
  res.json({ ok: true });
});

router.post("/api/operator/jobs/:id/run", requireAuth, async (req: AuthRequest, res) => {
  const r = await pool.query(
    `SELECT id, user_id, name, prompt, cron, runner, model, effort, fails
       FROM operator_jobs WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.userId],
  );
  const job = r.rows[0] as OperatorJob | undefined;
  if (!job) { res.status(404).json({ error: "not found" }); return; }
  // Fire and forget: a run spawns a CLI for minutes. The result lands on the
  // canvas and in a notification, same as a scheduled tick.
  runJob(job).catch((err) => console.error("[operator-jobs] run failed:", err));
  res.json({ started: true });
});

export default router;
