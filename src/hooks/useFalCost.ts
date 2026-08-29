import { useEffect, useState } from "react";
import { fetchPricing, resolveModelKey, type EstimateParams } from "./useEstimateCost";

/**
 * AT-COST fal.ai price for a pending generation, in USD.
 *
 * The sibling `useEstimateCost` returns retail *credits* and computes them in
 * the browser from a multiplier table. This one can't: several fal prices are
 * quality x resolution matrices or token formulas rather than multipliers, so
 * the rules live server-side in `server/config/falCost.ts` and we ask for the
 * number. It takes the exact same params object the panels already build for
 * `useEstimateCost`, and every distinct combination is fetched once and
 * memoised for the life of the page — panels change params on discrete user
 * choices, not on keystrokes, so this is a handful of localhost round-trips.
 */

export type FalCostEstimate = {
  usd: number;
  /** "approx" when the real cost depends on something unknowable pre-dispatch. */
  accuracy: "exact" | "approx";
  /** Human-readable derivation, e.g. "$0.112/s x 5s (audio off)". */
  basis: string;
};

const cache = new Map<string, FalCostEstimate | null>();
const inFlight = new Map<string, Promise<FalCostEstimate | null>>();

type Resolved = EstimateParams & { modelKey: string };

function cacheKey(p: Resolved): string {
  return JSON.stringify([
    p.modelKey,
    p.resolution ?? "",
    p.duration ?? "",
    [...(p.features ?? [])].sort(),
    p.quantity ?? 1,
    p.characters ?? 0,
  ]);
}

function fetchEstimate(p: Resolved): Promise<FalCostEstimate | null> {
  const key = cacheKey(p);
  if (cache.has(key)) return Promise.resolve(cache.get(key)!);
  const existing = inFlight.get(key);
  if (existing) return existing;

  const duration = typeof p.duration === "string" ? parseFloat(p.duration) : p.duration;
  const promise = fetch("/api/fal-cost/estimate", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      modelKey: p.modelKey,
      resolution: p.resolution,
      duration: typeof duration === "number" && isFinite(duration) ? duration : undefined,
      features: p.features,
      quantity: p.quantity,
      characters: p.characters,
    }),
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      const estimate = (data?.results?.[0]?.estimate ?? null) as FalCostEstimate | null;
      cache.set(key, estimate);
      return estimate;
    })
    .catch(() => null)
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, promise);
  return promise;
}

export function useFalCost(params: EstimateParams | null | undefined): {
  estimate: FalCostEstimate | null;
  loading: boolean;
} {
  const [estimate, setEstimate] = useState<FalCostEstimate | null>(null);
  const [loading, setLoading] = useState(false);

  // Serialise the params so the effect keys on their VALUE. Keying on the
  // object reference would refetch on every render, since panels rebuild the
  // params object inline.
  const paramsKey = params?.type ? JSON.stringify(params) : null;

  useEffect(() => {
    if (!paramsKey || !params) {
      setEstimate(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchPricing()
      .then((table) => {
        const modelKey = resolveModelKey(params, table);
        if (!modelKey) return null;
        return fetchEstimate({ ...params, modelKey });
      })
      .then((result) => {
        if (cancelled) return;
        setEstimate(result);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramsKey]);

  return { estimate, loading };
}

/**
 * Format USD for a generate button. fal prices span four orders of magnitude
 * ($0.002 sound effects to $3.40 Seedance clips), so a fixed 2dp would render
 * much of the catalog as "$0.00". Three decimals under a cent, two above.
 */
export function formatUsd(usd: number): string {
  if (!isFinite(usd) || usd <= 0) return "$0";
  return usd < 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
}
