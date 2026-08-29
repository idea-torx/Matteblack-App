import { useState, useEffect } from "react";

export type EstimateParams = {
  type: string;
  model?: string;
  resolution?: string;
  duration?: string | number;
  features?: string[];
  quantity?: number;
  characters?: number;
};

type EstimateResult = {
  cost: number | null;
  loading: boolean;
};

type PricingRow = {
  model_key: string;
  base_cost: number;
  resolution_multipliers: Record<string, number> | null;
  duration_multipliers: Record<string, number> | null;
  feature_surcharges: Record<string, number> | null;
};

type PricingTable = {
  rows: PricingRow[];
  typeMap: Record<string, string[]>;
};

let pricingCache: PricingTable | null = null;
let pricingFetchPromise: Promise<PricingTable> | null = null;

/**
 * Shared with `useFalCost`, which needs the same typeMap to turn a panel's
 * `{ type, model }` into the model key fal prices are keyed by.
 */
export function fetchPricing(): Promise<PricingTable> {
  if (pricingCache) return Promise.resolve(pricingCache);
  if (pricingFetchPromise) return pricingFetchPromise;
  pricingFetchPromise = fetch("/api/pricing", { credentials: "include" })
    .then((r) => (r.ok ? r.json() : null))
    .then((data: PricingTable | null) => {
      if (data) {
        pricingCache = data;
        pricingFetchPromise = null;
      }
      return data ?? { rows: [], typeMap: {} };
    })
    .catch(() => {
      pricingFetchPromise = null;
      return { rows: [], typeMap: {} };
    });
  return pricingFetchPromise;
}

/**
 * Panel `{ type, model }` -> the model key both the credit table and fal's
 * price table are keyed by. Falls back to the first model of the type, which
 * is what the panels default to when no model is chosen.
 */
export function resolveModelKey(params: EstimateParams, table: PricingTable): string | null {
  const allowed = table?.typeMap?.[params.type];
  if (!allowed?.length) return null;
  return params.model && allowed.includes(params.model) ? params.model : allowed[0];
}

function computeCost(params: EstimateParams, table: PricingTable): number | null {
  const modelKey = resolveModelKey(params, table);
  if (!modelKey) return null;

  const row = table.rows.find((r) => r.model_key === modelKey);
  if (!row) return null;

  const quantity = Math.max(1, Math.min(100, Math.floor(params.quantity ?? 1)));
  let resolutionMultiplier = 1;
  let durationMultiplier = 1;
  const featureSurchargeMap: Record<string, number> = {};

  if (params.resolution && row.resolution_multipliers) {
    const mult = row.resolution_multipliers[params.resolution.toLowerCase()];
    if (typeof mult === "number") resolutionMultiplier = mult;
  }

  const dm = row.duration_multipliers;
  if (dm) {
    if (dm.per_1000_characters && typeof params.characters === "number" && params.characters > 0) {
      const blocks = Math.ceil(params.characters / 1000);
      durationMultiplier = blocks * dm.per_1000_characters;
    } else if (params.duration) {
      const durStr = String(params.duration);
      if (dm.per_minute) {
        const secs = parseFloat(durStr);
        if (!isNaN(secs) && secs > 0) durationMultiplier = Math.ceil(secs / 60) * dm.per_minute;
      } else if (dm.per_second) {
        const secs = parseFloat(durStr);
        if (!isNaN(secs) && secs > 0) durationMultiplier = secs * dm.per_second;
      } else {
        const mult = dm[durStr];
        if (typeof mult === "number") durationMultiplier = mult;
      }
    }
  }

  if (params.features && row.feature_surcharges) {
    for (const feat of params.features) {
      const s = row.feature_surcharges[feat];
      if (typeof s === "number") featureSurchargeMap[feat] = s;
    }
  }

  const surchargeTotal = Object.values(featureSurchargeMap).reduce((a, b) => a + b, 0);
  return Math.round((row.base_cost + surchargeTotal) * resolutionMultiplier * durationMultiplier * quantity);
}

export function useEstimateCost(params: EstimateParams | null): EstimateResult {
  const [table, setTable] = useState<PricingTable | null>(pricingCache);

  useEffect(() => {
    if (pricingCache) {
      setTable(pricingCache);
      return;
    }
    let cancelled = false;
    fetchPricing().then((t) => {
      if (!cancelled) setTable(t);
    });
    return () => { cancelled = true; };
  }, []);

  if (!params || !params.type || !table) {
    return { cost: null, loading: !table };
  }

  const cost = computeCost(params, table);
  return { cost, loading: false };
}
