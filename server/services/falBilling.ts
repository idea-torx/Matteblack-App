/**
 * Reconcile what we *estimated* a job would cost against what fal *billed*.
 *
 * fal's Platform API exposes one billing event per request id
 * (`GET /v1/models/billing-events?request_id=`) with the final USD figure.
 * After a job completes we fetch that event, store it on the job's metadata
 * (`fal_cost_usd`, `fal_units`, `fal_unit_price`, `fal_estimate_usd`) and
 * warn when the estimator was off by more than 5% — that log line is how a
 * stale conditional rate (audio surcharge, resolution grid, promo) surfaces
 * without anyone re-reading fal's model pages.
 *
 * Billing events lag the result by seconds to minutes, so a miss retries on
 * a widening schedule. Uses the user's own fal key; no extra spend.
 */
import { pool } from "../db.js";
import { getFalKey } from "../config/userConfig.js";
import { estimateFalCost, type CostParams } from "../config/falCost.js";
import { unitPriceFor } from "./falPricing.js";

const RETRY_MS = [5_000, 30_000, 120_000, 600_000];
const MISMATCH_TOLERANCE = 0.05;

export type BillingEvent = {
  request_id: string;
  endpoint_id: string;
  output_units: number | null;
  unit_price: number | null;
  cost_total: number;
};

/** Map a job's stored params onto the estimator's CostParams. */
export function jobCostParams(params: Record<string, unknown>): CostParams {
  const num = (v: unknown) => {
    const n = Number(v);
    return isFinite(n) && n > 0 ? n : undefined;
  };
  return {
    duration: num(params.duration),
    resolution: typeof params.resolution === "string" ? params.resolution : undefined,
    quantity: num(params.num_images ?? params.quantity),
    // Boolean flags (generate_audio: true, ...) are the rules' feature names.
    features: Object.keys(params).filter((k) => params[k] === true),
  };
}

type BillingLookup = Map<string, BillingEvent> | "rate_limited" | "forbidden" | null;

/**
 * fal only lets ADMIN-scoped keys read billing. A plain API key gets 403; we
 * remember that and stop calling, so a normal key never spams the endpoint.
 */
let billingState: "unknown" | "ok" | "forbidden" = "unknown";
export const falBillingStatus = () => billingState;

/** One call for up to 50 request ids (fal's cap on the comma-separated filter). */
export async function fetchBillingEvents(requestIds: string[], key: string): Promise<BillingLookup> {
  if (billingState === "forbidden") return "forbidden";
  const url = `https://api.fal.ai/v1/models/billing-events?request_id=${encodeURIComponent(requestIds.join(","))}&limit=${requestIds.length}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: `Key ${key}` } });
  } catch {
    return null;
  }
  if (res.status === 429) return "rate_limited";
  if (res.status === 403) {
    billingState = "forbidden";
    console.warn("[fal-billing] this fal key cannot read billing (needs ADMIN scope). Create one at fal.ai/dashboard/keys to reconcile billed costs.");
    return "forbidden";
  }
  if (!res.ok) return null;
  billingState = "ok";
  const body = (await res.json().catch(() => null)) as { billing_events?: BillingEvent[] } | null;
  const map = new Map<string, BillingEvent>();
  for (const ev of body?.billing_events ?? []) {
    if (ev && typeof ev.cost_total === "number") map.set(ev.request_id, ev);
  }
  return map;
}

async function record(jobId: string, model: string, params: Record<string, unknown>, ev: BillingEvent): Promise<void> {
  const est = estimateFalCost(model, jobCostParams(params ?? {}), unitPriceFor(model));
  const patch = {
    fal_cost_usd: ev.cost_total,
    fal_units: ev.output_units,
    fal_unit_price: ev.unit_price,
    fal_estimate_usd: est?.usd ?? null,
  };
  await pool.query(
    `UPDATE jobs SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
    [jobId, JSON.stringify(patch)]
  );
  if (est && ev.cost_total > 0 && Math.abs(est.usd - ev.cost_total) / ev.cost_total > MISMATCH_TOLERANCE) {
    console.warn(
      `[fal-billing] estimate mismatch ${model}: estimated $${est.usd.toFixed(4)} (${est.basis}) billed $${ev.cost_total.toFixed(4)} (${ev.output_units} x ${ev.unit_price}) params=${JSON.stringify(params)}`
    );
  } else {
    console.log(`[fal-billing] job ${jobId} ${model} billed $${ev.cost_total.toFixed(4)}`);
  }
}

export async function reconcileJob(jobId: string, attempt = 0): Promise<boolean> {
  const key = getFalKey();
  if (!key || billingState === "forbidden") return false;
  const r = await pool.query(
    `SELECT model, params, fal_request_id, metadata FROM jobs WHERE id = $1`,
    [jobId]
  );
  const row = r.rows[0];
  if (!row?.fal_request_id || row.metadata?.fal_cost_usd != null) return false;

  const found = await fetchBillingEvents([row.fal_request_id], key);
  const ev = found instanceof Map ? found.get(row.fal_request_id) : undefined;
  if (!ev) {
    if (found !== "forbidden" && attempt < RETRY_MS.length) {
      setTimeout(() => void reconcileJob(jobId, attempt + 1).catch(() => {}), RETRY_MS[attempt]).unref();
    }
    return false;
  }
  await record(jobId, row.model, row.params, ev);
  return true;
}

/** Backfill completed jobs that never got reconciled (startup, or first run after upgrade). */
export async function reconcileRecentJobs(limit = 200): Promise<void> {
  const key = getFalKey();
  if (!key) return;
  const r = await pool.query(
    `SELECT id, model, params, fal_request_id FROM jobs
      WHERE status = 'complete' AND fal_request_id IS NOT NULL
        AND (metadata->>'fal_cost_usd') IS NULL
        AND created_at > NOW() - INTERVAL '30 days'
      ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  for (let i = 0; i < r.rows.length; i += 50) {
    const chunk = r.rows.slice(i, i + 50);
    const found = await fetchBillingEvents(chunk.map((j) => j.fal_request_id), key);
    if (!(found instanceof Map)) return; // forbidden / rate limited / offline: try again next boot
    for (const j of chunk) {
      const ev = found.get(j.fal_request_id);
      if (ev) await record(j.id, j.model, j.params, ev).catch(() => {});
    }
    // ponytail: fixed gap between pages; fal rate-limits the platform API hard.
    await new Promise((res) => setTimeout(res, 4_000));
  }
}
