/**
 * Scheduled operator runs — "every Monday at 9, make three new variants of the
 * hero shot".
 *
 * A row in `operator_jobs` holds a cron expression and a prompt; this module
 * ticks every 30s, picks the jobs whose `next_run_at` has passed, and drives the
 * SAME runOperator() path the foreground panel uses, so generations land on the
 * canvas exactly as they do for a typed message. On completion a notification
 * fires.
 *
 * TIME ZONE: cron expressions are interpreted in the SERVER MACHINE's local time
 * zone (whatever `new Date()` reports). This is a desktop app — the machine's
 * clock is the user's clock. No per-job tz field.
 */
import { pool } from "../db.js";
import { createNotification } from "../notifications.js";
import { setOperatorContext } from "../services/operatorCanvasContext.js";
import { runOperator, EFFORT_LEVELS, type EffortLevel, type RunnerId } from "./claudeOperator.js";

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------

// Fields: minute hour day-of-month month day-of-week.
// Each accepts * , a , a,b , a-b , star-slash-n , a-b/n .
const FIELDS: { min: number; max: number }[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7 },  // day of week (0 and 7 are both Sunday)
];

function parseField(spec: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const [range, stepStr] = part.split("/");
    const step = stepStr === undefined ? 1 : Number(stepStr);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${part}"`);
    let lo: number, hi: number;
    if (range === "*") {
      lo = min; hi = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-").map(Number);
      lo = a; hi = b;
    } else {
      lo = Number(range);
      // A bare number with a step means "from here to the end" (`5/10`).
      hi = stepStr === undefined ? lo : max;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`bad range in "${part}"`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export interface Cron {
  minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>;
  /** Standard cron: when BOTH dom and dow are restricted, either matching wins. */
  domRestricted: boolean; dowRestricted: boolean;
}

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("cron must have 5 fields: minute hour day-of-month month day-of-week");
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i].min, FIELDS[i].max));
  if (dow.delete(7)) dow.add(0); // 7 === Sunday
  return { minute, hour, dom, month, dow, domRestricted: parts[2] !== "*", dowRestricted: parts[4] !== "*" };
}

function dateMatches(c: Cron, d: Date): boolean {
  if (!c.month.has(d.getMonth() + 1)) return false;
  const dom = c.dom.has(d.getDate());
  const dow = c.dow.has(d.getDay());
  if (c.domRestricted && c.dowRestricted) return dom || dow;
  if (c.domRestricted) return dom;
  if (c.dowRestricted) return dow;
  return true;
}

/**
 * The next local-time instant strictly after `from` that matches `cron`.
 * Throws on a malformed expression (the routes use that to validate input).
 *
 * ponytail: day-then-minute scan capped at 5 years — plenty for 5-field cron,
 * and it costs nothing next to spawning a CLI. A real cron library only earns
 * its place if we ever add @yearly/L/# syntax.
 */
export function computeNext(cron: string, from: Date = new Date()): Date {
  const c = parseCron(cron);
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1); // strictly after
  const limit = new Date(from.getTime() + 5 * 366 * 24 * 3600_000);
  while (d <= limit) {
    if (!dateMatches(c, d)) {
      // Skip to the start of the next day. setDate/setHours handle DST and month
      // rollover the way the local calendar does.
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() + 1);
      continue;
    }
    if (!c.hour.has(d.getHours())) {
      d.setMinutes(0);
      d.setHours(d.getHours() + 1);
      continue;
    }
    if (!c.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1);
      continue;
    }
    return d;
  }
  throw new Error(`cron "${cron}" never matches`);
}

// ---------------------------------------------------------------------------
// Running one job
// ---------------------------------------------------------------------------

export interface OperatorJob {
  id: string;
  user_id: string;
  name: string;
  prompt: string;
  cron: string;
  runner: string | null;
  model: string | null;
  effort: string | null;
  fails: number;
}

const MAX_FAILS = 3;

// ponytail: one job at a time, process-wide. Each run spawns a CLI that can
// generate for minutes; two of them racing on the same canvas is worse than a
// late job. Give it a small worker pool if users ever schedule enough to queue.
let inFlight = false;

/** Run one job to completion and record the outcome. Never rejects.
 *  Holds the module-wide in-flight flag, so a manual "Run now" and the tick
 *  can't drive two CLIs at once; returns false if it declined for that reason. */
export async function runJob(job: OperatorJob): Promise<boolean> {
  if (inFlight) return false;
  inFlight = true;
  try {
    await runJobInner(job);
  } finally {
    inFlight = false;
  }
  return true;
}

async function runJobInner(job: OperatorJob): Promise<void> {
  // Same setup the foreground turn does, minus the viewport/attachments the
  // panel supplies. With no canvasId the generation path falls back to the
  // user's default canvas (resolveOrCreateCanvasForUser), which is where an
  // unattended run should land.
  setOperatorContext(job.user_id, {});

  const chunks: string[] = [];
  let failure: string | null = null;
  try {
    await runOperator({
      message: `Scheduled run "${job.name}": ${job.prompt}`,
      runner: (job.runner as RunnerId) || undefined,
      model: job.model || undefined,
      effort: EFFORT_LEVELS.includes(job.effort as EffortLevel) ? (job.effort as EffortLevel) : undefined,
      onEvent: (e) => {
        if (e.type === "text") chunks.push(e.text);
        else if (e.type === "error") failure = e.message;
        else if (e.type === "done") {
          if (e.isError) failure = e.result || "operator reported an error";
          else if (e.result) chunks.push(e.result);
        }
      },
    });
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }

  const result = chunks.join("").trim();
  let next: Date | null = null;
  try { next = computeNext(job.cron); } catch { /* validated on write; leave null and let it stop */ }

  if (failure) {
    const fails = job.fails + 1;
    const paused = fails >= MAX_FAILS;
    await pool.query(
      `UPDATE operator_jobs
          SET last_run_at = NOW(), next_run_at = $2, last_error = $3, fails = $4, enabled = $5
        WHERE id = $1`,
      [job.id, paused ? null : next, String(failure).slice(0, 2000), fails, !paused],
    );
    await createNotification({
      userId: job.user_id,
      type: "operator_job",
      title: job.name,
      message: paused
        ? `Scheduled run paused after ${MAX_FAILS} failures: ${String(failure).slice(0, 200)}`
        : String(failure).slice(0, 200),
      severity: "error",
      metadata: { jobId: job.id, paused },
    });
    return;
  }

  await pool.query(
    `UPDATE operator_jobs
        SET last_run_at = NOW(), next_run_at = $2, last_result = $3, last_error = NULL, fails = 0
      WHERE id = $1`,
    [job.id, next, result.slice(0, 2000)],
  );
  await createNotification({
    userId: job.user_id,
    type: "operator_job",
    title: job.name,
    message: result.slice(0, 200) || "Scheduled run finished.",
    severity: "success",
    metadata: { jobId: job.id },
  });
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

const TICK_MS = 30_000;

async function tick(): Promise<void> {
  if (inFlight) return;
  try {
    const due = await pool.query(
      `SELECT id, user_id, name, prompt, cron, runner, model, effort, fails
         FROM operator_jobs
        WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= NOW()
        ORDER BY next_run_at ASC LIMIT 1`,
    );
    const job = due.rows[0] as OperatorJob | undefined;
    if (job) {
      console.log(`[scheduler] running job "${job.name}" (${job.id})`);
      await runJob(job);
    }
  } catch (err) {
    console.error("[scheduler] tick failed:", err);
  }
}

/** Start the 30s scheduler loop. Call once, after the DB is ready. */
export function startScheduler(): void {
  // A job whose next_run_at was never set (or was lost) would never fire.
  pool
    .query(`SELECT id, cron FROM operator_jobs WHERE enabled AND next_run_at IS NULL`)
    .then(async (r) => {
      for (const row of r.rows as { id: string; cron: string }[]) {
        try {
          await pool.query(`UPDATE operator_jobs SET next_run_at = $2 WHERE id = $1`, [row.id, computeNext(row.cron)]);
        } catch { /* bad cron on an old row — leave it parked */ }
      }
    })
    .catch((err) => console.error("[scheduler] backfill failed:", err));

  const timer = setInterval(() => { void tick(); }, TICK_MS);
  if (typeof timer.unref === "function") timer.unref();
  console.log("[scheduler] scheduled operator runs armed (30s tick, local time zone)");
}
