/**
 * Live at-cost fal.ai pricing.
 *
 * `config/falCost.ts` carries a verified snapshot of fal's unit prices plus the
 * conditional rules the pricing API flattens away. This service keeps the
 * *unit prices* honest over time by refreshing them from fal:
 *
 *   GET https://api.fal.ai/v1/models/pricing?endpoint_id=<id>
 *     -> { prices: [{ endpoint_id, unit_price, unit, currency }] }
 *
 * Three constraints shape the design:
 *
 *  1. The endpoint is RATE LIMITED — ~10 rapid calls earns a 429. So the refresh
 *     is serialized with a delay between endpoints and exponential backoff on
 *     429, and it never runs on a request path.
 *  2. The user may not have a fal key yet (fresh install, key entered later).
 *     No key simply means "use the snapshot" — never an error.
 *  3. The app must work offline. The cache is written to disk and read back on
 *     boot, and the snapshot is the floor under everything.
 *
 * Net effect: `unitPriceFor()` answers instantly from memory and is always
 * defined; freshness improves in the background when a key and network exist.
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, ensureDataDir } from "../config/runtime.js";
import { getFalKey } from "../config/userConfig.js";
import { FAL_COST_RULES, falPricedModelKeys, type FalUnit } from "../config/falCost.js";

const CACHE_PATH = path.join(DATA_DIR, "fal-pricing-cache.json");

/** Refresh at most once a day — fal changes prices on the order of months. */
const TTL_MS = 24 * 60 * 60 * 1000;
/** Gap between endpoint queries. ~10 rapid calls trips the limiter. */
const REQUEST_GAP_MS = 4_000;
/** 429 backoff: attempt N waits BACKOFF_MS * (N + 1). */
const BACKOFF_MS = 8_000;
const MAX_ATTEMPTS = 4;

export type LivePrice = {
  endpoint: string;
  unitPrice: number;
  unit: FalUnit | string;
  /** Epoch ms this price was fetched. */
  fetchedAt: number;
};

type CacheFile = {
  version: 1;
  /** Epoch ms of the last completed refresh sweep. */
  refreshedAt: number;
  prices: Record<string, LivePrice>;
};

/** endpoint id -> live price. Empty until a refresh lands. */
let live: Record<string, LivePrice> = {};
let refreshedAt = 0;
let loaded = false;
let inFlight: Promise<void> | null = null;

function loadCache(): void {
  if (loaded) return;
  loaded = true;
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")) as CacheFile;
    if (parsed?.version === 1 && parsed.prices && typeof parsed.prices === "object") {
      live = parsed.prices;
      refreshedAt = parsed.refreshedAt || 0;
    }
  } catch {
    // No cache yet (or it's corrupt) — the snapshot covers us.
  }
}

function saveCache(): void {
  try {
    ensureDataDir();
    const payload: CacheFile = { version: 1, refreshedAt, prices: live };
    fs.writeFileSync(CACHE_PATH, JSON.stringify(payload, null, 2));
  } catch (err) {
    console.warn("[falPricing] could not write cache:", (err as Error).message);
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch one endpoint's price, retrying through 429s.
 * Returns null on any non-recoverable failure — callers keep the snapshot.
 */
async function fetchPrice(endpoint: string, key: string): Promise<LivePrice | null> {
  const url = `https://api.fal.ai/v1/models/pricing?endpoint_id=${encodeURIComponent(endpoint)}`;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { headers: { Authorization: `Key ${key}` } });
    } catch {
      return null; // offline
    }
    if (res.status === 429) {
      await wait(BACKOFF_MS * (attempt + 1));
      continue;
    }
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as
      | { prices?: Array<{ unit_price?: number; unit?: string }> }
      | null;
    const first = body?.prices?.[0];
    if (!first || typeof first.unit_price !== "number") return null;
    return {
      endpoint,
      unitPrice: first.unit_price,
      unit: (first.unit as FalUnit) ?? "units",
      fetchedAt: Date.now(),
    };
  }
  return null; // still rate limited after MAX_ATTEMPTS
}

/** Distinct endpoints across all priced models (several model keys share one). */
function allEndpoints(): string[] {
  const set = new Set<string>();
  for (const key of falPricedModelKeys()) {
    const rule = FAL_COST_RULES[key];
    if (rule?.endpoint) set.add(rule.endpoint);
  }
  return [...set];
}

/**
 * Sweep every endpoint, serialized. Safe to call repeatedly — concurrent calls
 * share one sweep, and a sweep inside the TTL is a no-op unless `force`.
 */
export function refreshFalPricing(opts: { force?: boolean } = {}): Promise<void> {
  loadCache();
  if (inFlight) return inFlight;
  if (!opts.force && Date.now() - refreshedAt < TTL_MS) return Promise.resolve();

  const key = getFalKey();
  if (!key) return Promise.resolve(); // no key yet — snapshot stands

  inFlight = (async () => {
    const endpoints = allEndpoints();
    let ok = 0;
    for (const endpoint of endpoints) {
      const price = await fetchPrice(endpoint, key);
      if (price) {
        live[endpoint] = price;
        ok++;
      }
      await wait(REQUEST_GAP_MS);
    }
    if (ok > 0) {
      refreshedAt = Date.now();
      saveCache();
    }
    console.log(`[falPricing] refreshed ${ok}/${endpoints.length} endpoint prices`);
  })()
    .catch((err) => {
      console.warn("[falPricing] refresh failed:", (err as Error).message);
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/**
 * Live unit price for a model key, or undefined to fall back to the snapshot.
 * Only returns a live value when the billing unit still matches what the rule
 * expects — if fal re-denominates an endpoint (per-second to per-generation,
 * say), the local rule's arithmetic no longer applies and the snapshot is the
 * safer answer until the rule is updated.
 */
export function unitPriceFor(modelKey: string): number | undefined {
  loadCache();
  const rule = FAL_COST_RULES[modelKey];
  if (!rule) return undefined;
  const hit = live[rule.endpoint];
  if (!hit || hit.unit !== rule.unit) return undefined;
  return hit.unitPrice;
}

/** Freshness metadata, for the settings panel / debugging. */
export function falPricingStatus(): {
  refreshedAt: number | null;
  endpointsCached: number;
  hasKey: boolean;
} {
  loadCache();
  return {
    refreshedAt: refreshedAt || null,
    endpointsCached: Object.keys(live).length,
    hasKey: !!getFalKey(),
  };
}

/**
 * Kick off a background refresh shortly after boot. Deliberately delayed so it
 * never competes with startup, and deliberately un-awaited.
 */
export function scheduleFalPricingRefresh(delayMs = 30_000): void {
  const timer = setTimeout(() => {
    void refreshFalPricing();
  }, delayMs);
  timer.unref?.();
}
