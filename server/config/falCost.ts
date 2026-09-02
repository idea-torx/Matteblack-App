// AT-COST fal.ai pricing — real USD, no margin.
//
// This is deliberately SEPARATE from `modelPricing.ts`. That file holds the
// retail credit prices (margin baked into each integer `base_cost` by hand);
// this one holds what fal actually charges. The two must never be conflated:
// the observed margin across the catalog ranges from 0.8x to ~50x, so retail
// prices cannot be converted to cost by any single divisor.
//
// SOURCES (both agree wherever they overlap):
//   1. fal's live pricing API, queried 2026-07-24 with a real key:
//        GET https://api.fal.ai/v1/models/pricing?endpoint_id=<id>
//        -> { prices: [{ endpoint_id, unit_price, unit, currency }] }
//      This gives the authoritative unit price + billing unit, and is what
//      `services/falPricing.ts` refreshes at runtime.
//   2. The per-model fal.ai model pages, for the CONDITIONALS the API flattens.
//
// Why we still need a local table when a live API exists: the API returns ONE
// headline unit_price per endpoint and hides every conditional. Kling O3 Pro
// reports $0.14/s — that is the audio-ON price; audio-off is $0.112/s. Veo 3.1
// Lite reports $0.05/s, which is 1080p-no-audio / 720p-with-audio; the real
// grid has four cells. So: live API supplies `unit_price`, this file supplies
// the modifier rules on top of it.
//
// NOTE: fal's pricing API is rate limited (429 after ~10 rapid calls), which is
// why `falPricing.ts` serializes, backs off, and caches to disk. The snapshot
// values below are the fallback when the API is unreachable or the user has no
// key configured yet.

/** Billing units fal reports. */
export type FalUnit =
  | "images"
  | "seconds"
  | "minutes"
  | "generations"
  | "megapixels"
  | "1000 characters"
  | "audios"
  | "units"
  | "compute seconds";

/**
 * How confident the estimate is:
 *  - "exact"   — deterministic from the inputs we have (flat per-image, per-second, etc.)
 *  - "approx"  — depends on something we can't know before dispatch (output
 *                megapixels, GPU compute seconds, exact frame dimensions).
 */
export type CostAccuracy = "exact" | "approx";

export type FalCostEstimate = {
  usd: number;
  accuracy: CostAccuracy;
  /** Human-readable basis, e.g. "$0.112/s x 5s". Shown in tooltips / to the agent. */
  basis: string;
};

export type CostParams = {
  /** Seconds of output video/audio. */
  duration?: number;
  /** Resolution token as the panels emit it: "1k" | "1080p" | "720p_60" | ... */
  resolution?: string;
  /** Feature flags, e.g. ["generate_audio"], ["quality_low"], ["web_search"]. */
  features?: string[];
  /** Number of outputs. */
  quantity?: number;
  /** Characters, for TTS. */
  characters?: number;
  /** Output megapixels, for per-megapixel models. */
  megapixels?: number;
};

type Rule = {
  /** fal endpoint id — the key for the live pricing lookup. */
  endpoint: string;
  /** Snapshot of fal's headline unit_price (USD), verified 2026-07-24. */
  unitPrice: number;
  unit: FalUnit;
  /**
   * Compute cost in USD. `unitPrice` is passed in so a live-refreshed value
   * overrides the snapshot automatically for the simple models. Models whose
   * real price is a matrix (gpt-image-2) or a formula (seedance) ignore it and
   * say so in a comment.
   */
  cost: (p: CostParams, unitPrice: number) => FalCostEstimate;
};

const n = (p: CostParams, k: "duration" | "quantity" | "characters" | "megapixels", d: number) => {
  const v = p[k];
  return typeof v === "number" && isFinite(v) && v > 0 ? v : d;
};
const has = (p: CostParams, f: string) => !!p.features?.includes(f);
const qty = (p: CostParams) => Math.max(1, Math.floor(n(p, "quantity", 1)));

/** Per-image models with the standard 0.5k/1k/2k/4k ladder. */
const STD_RES: Record<string, number> = { "0.5k": 0.75, "1k": 1.0, "2k": 1.5, "4k": 2.0 };

const flatPerUnit =
  (unitLabel: string): Rule["cost"] =>
  (p, unitPrice) => {
    const q = qty(p);
    return {
      usd: unitPrice * q,
      accuracy: "exact",
      basis: q > 1 ? `$${unitPrice} x ${q} ${unitLabel}` : `$${unitPrice}/${unitLabel}`,
    };
  };

const perSecond =
  (): Rule["cost"] =>
  (p, unitPrice) => {
    const secs = n(p, "duration", 5);
    return {
      usd: unitPrice * secs * qty(p),
      accuracy: "exact",
      basis: `$${unitPrice}/s x ${secs}s`,
    };
  };

export const FAL_COST_RULES: Record<string, Rule> = {
  // ---- Image ------------------------------------------------------------
  // $0.08/image, standard resolution ladder, plus two optional surcharges
  // (web_search $0.015, high_thinking $0.002) that belong to nano-banana —
  // NOT to seedream, where modelPricing.ts currently misattributes them.
  "nano-banana-2-t2i": {
    endpoint: "fal-ai/nano-banana-2",
    unitPrice: 0.08,
    unit: "images",
    cost: (p, unitPrice) => {
      const mult = STD_RES[(p.resolution ?? "1k").toLowerCase()] ?? 1;
      const extras = (has(p, "web_search") ? 0.015 : 0) + (has(p, "high_thinking") ? 0.002 : 0);
      const q = qty(p);
      return {
        usd: (unitPrice * mult + extras) * q,
        accuracy: "exact",
        basis: `$${unitPrice}/img x ${mult} (${p.resolution ?? "1k"})${extras ? ` + $${extras.toFixed(3)}` : ""}${q > 1 ? ` x ${q}` : ""}`,
      };
    },
  },
  "nano-banana-2": {
    endpoint: "fal-ai/nano-banana-2/edit",
    unitPrice: 0.08,
    unit: "images",
    cost: (p, unitPrice) => FAL_COST_RULES["nano-banana-2-t2i"].cost(p, unitPrice),
  },

  // Seedream v4.5 is a FLAT $0.04/image on fal — no resolution tiers and no
  // web_search/high_thinking surcharges, contrary to modelPricing.ts.
  "seedream-t2i": {
    endpoint: "fal-ai/bytedance/seedream/v4.5/text-to-image",
    unitPrice: 0.04,
    unit: "images",
    cost: flatPerUnit("image"),
  },
  "seedream-edit": {
    endpoint: "fal-ai/bytedance/seedream/v4.5/edit",
    unitPrice: 0.04,
    unit: "images",
    cost: flatPerUnit("image"),
  },

  // Seedream 5 Lite: flat $0.035/image, every size.
  "seedream-5-t2i": {
    endpoint: "fal-ai/bytedance/seedream/v5/lite/text-to-image",
    unitPrice: 0.035,
    unit: "images",
    cost: flatPerUnit("image"),
  },
  "seedream-5-edit": {
    endpoint: "fal-ai/bytedance/seedream/v5/lite/edit",
    unitPrice: 0.035,
    unit: "images",
    cost: flatPerUnit("image"),
  },

  // GPT-Image-2 bills in CUSTOM UNITS: the live API reports unit="units",
  // unit_price=$1, i.e. the billed quantity IS the dollar amount and is only
  // known after the fact (x-fal-billable-units on the result fetch). So the
  // live unitPrice is useless for prediction and we use fal's published
  // quality x resolution matrix instead. Default quality is HIGH.
  "gpt-image-2-t2i": {
    endpoint: "fal-ai/gpt-image-2",
    unitPrice: 1,
    unit: "units",
    cost: (p) => {
      const big = (p.resolution ?? "1k").toLowerCase() === "2k";
      const q = has(p, "quality_low") ? "low" : has(p, "quality_medium") ? "medium" : "high";
      const table = big
        ? { low: 0.007, medium: 0.056, high: 0.222 }
        : { low: 0.006, medium: 0.053, high: 0.211 };
      const each = table[q];
      const count = qty(p);
      return {
        usd: each * count,
        accuracy: "exact",
        basis: `$${each} (${q}, ${big ? "2k" : "1k"})${count > 1 ? ` x ${count}` : ""}`,
      };
    },
  },
  // Editing costs more than t2i because the input image is tokenised.
  "gpt-image-2-edit": {
    endpoint: "fal-ai/gpt-image-2/edit",
    unitPrice: 1,
    unit: "units",
    cost: (p) => {
      const big = (p.resolution ?? "1k").toLowerCase() === "2k";
      const q = has(p, "quality_low") ? "low" : has(p, "quality_medium") ? "medium" : "high";
      const table = big
        ? { low: 0.019, medium: 0.068, high: 0.234 }
        : { low: 0.015, medium: 0.061, high: 0.219 };
      const each = table[q];
      const count = qty(p);
      return {
        usd: each * count,
        accuracy: "exact",
        basis: `$${each} (${q}, ${big ? "2k" : "1k"}, edit)${count > 1 ? ` x ${count}` : ""}`,
      };
    },
  },

  // ---- Video ------------------------------------------------------------
  // Kling O3 Pro: audio is PER-SECOND ($0.112 -> $0.14), not the flat fee
  // modelPricing.ts models it as. The live API's $0.14 is the audio-ON price.
  ...(["t2v", "i2v", "r2v"] as const).reduce<Record<string, Rule>>((acc, v) => {
    const ep =
      v === "t2v" ? "text-to-video" : v === "i2v" ? "image-to-video" : "reference-to-video";
    acc[`kling-o3-pro-${v}`] = {
      endpoint: `fal-ai/kling-video/o3/pro/${ep}`,
      unitPrice: 0.14,
      unit: "seconds",
      cost: (p) => {
        const secs = n(p, "duration", 5);
        const rate = has(p, "generate_audio") ? 0.14 : 0.112;
        return {
          usd: rate * secs,
          accuracy: "exact",
          basis: `$${rate}/s x ${secs}s (audio ${has(p, "generate_audio") ? "on" : "off"})`,
        };
      },
    };
    // O3 4K is $0.42/s with or without audio.
    acc[`kling-o3-4k-${v}`] = {
      endpoint: `fal-ai/kling-video/o3/4k/${ep}`,
      unitPrice: 0.42,
      unit: "seconds",
      cost: perSecond(),
    };
    return acc;
  }, {}),

  "kling-3.0-mc": {
    endpoint: "fal-ai/kling-video/v3/pro/motion-control",
    unitPrice: 0.168,
    unit: "seconds",
    cost: perSecond(),
  },
  "kling-2.6-mc": {
    endpoint: "fal-ai/kling-video/v2.6/pro/motion-control",
    unitPrice: 0.112,
    unit: "seconds",
    cost: perSecond(),
  },

  // Veo 3.1 Lite: a 2x2 grid of resolution x audio. The live API's $0.05/s is
  // only one cell of it.
  ...(["t2v", "i2v", "flf2v"] as const).reduce<Record<string, Rule>>((acc, v) => {
    const ep =
      v === "t2v" ? "fal-ai/veo3.1/lite"
      : v === "i2v" ? "fal-ai/veo3.1/lite/image-to-video"
      : "fal-ai/veo3.1/lite/first-last-frame-to-video";
    acc[`veo3.1-lite-${v}`] = {
      endpoint: ep,
      unitPrice: 0.05,
      unit: "seconds",
      cost: (p) => {
        const secs = n(p, "duration", 5);
        const hd = (p.resolution ?? "720p").toLowerCase().startsWith("1080");
        const audio = has(p, "generate_audio");
        const rate = hd ? (audio ? 0.08 : 0.05) : audio ? 0.05 : 0.03;
        return {
          usd: rate * secs,
          accuracy: "exact",
          basis: `$${rate}/s x ${secs}s (${hd ? "1080p" : "720p"}, audio ${audio ? "on" : "off"})`,
        };
      },
    };
    return acc;
  }, {}),

  // H3 Max Turbo: half of H3 Max's per-second rate. Standard rates (fal's
  // launch promo is 75% off until 2026-09-07; we quote standard so an
  // estimate never comes in under the bill).
  ...(["t2v", "i2v"] as const).reduce<Record<string, Rule>>((acc, v) => {
    acc[`h3-turbo-${v}`] = {
      endpoint: `minimax/h3-max-turbo/${v === "t2v" ? "text-to-video" : "image-to-video"}`,
      unitPrice: 0.04,
      unit: "seconds",
      cost: (p) => {
        const secs = n(p, "duration", 5);
        const lo = (p.resolution ?? "768p").toLowerCase().startsWith("480");
        const rate = lo ? 0.025 : 0.04;
        return { usd: rate * secs, accuracy: "exact", basis: `$${rate}/s x ${secs}s (${lo ? "480P" : "768P"})` };
      },
    };
    return acc;
  }, {}),

  // MiniMax H3 Max: flat per-second, two resolution tiers. Standard rates
  // (fal's launch promo halves these until 2026-09-01; we quote the standard
  // rate so an estimate never comes in under the bill).
  //
  // All three modes bill at the same per-second rate, same as Kling and
  // Seedance above. Only t2v's rate is snapshot-verified; i2v/r2v inherit it,
  // and `falPricing.ts` overwrites all three from the live API on first
  // refresh. Chunk-chained long-form multiplies these, so a per-clip estimate
  // is the thing standing between the user and a surprise bill.
  ...(["t2v", "i2v", "r2v"] as const).reduce<Record<string, Rule>>((acc, v) => {
    const ep =
      v === "t2v" ? "text-to-video" : v === "i2v" ? "image-to-video" : "reference-to-video";
    acc[`h3-max-${v}`] = {
      endpoint: `minimax/h3-max/${ep}`,
      unitPrice: 0.08,
      unit: "seconds",
      cost: (p) => {
        const secs = n(p, "duration", 5);
        const lo = (p.resolution ?? "768p").toLowerCase().startsWith("480");
        const rate = lo ? 0.05 : 0.08;
        return { usd: rate * secs, accuracy: "exact", basis: `$${rate}/s x ${secs}s (${lo ? "480P" : "768P"})` };
      },
    };
    return acc;
  }, {}),

  // Seedance 2.0 is TOKEN billed: the live API reports $0.014 per 1000 "units"
  // (tokens). fal's formula is tokens = (h * w * duration * fps) / 1024 at
  // fps=24. Verified against fal's published per-second rates:
  //   1080p (1920x1080): 48600 tok/s -> $0.680/s  (page says $0.682/s)
  //    720p (1280x720):  21600 tok/s -> $0.302/s  (page says $0.3034/s)
  // Marked "approx" because the true frame size depends on aspect ratio; we
  // use the nominal 16:9 dimensions for the tier.
  // Gemini Omni Flash 1.1: flat per-second by resolution.
  ...(["t2v", "i2v"] as const).reduce<Record<string, Rule>>((acc, v) => {
    acc[`gemini-omni-${v}`] = {
      endpoint: `google/gemini-omni-flash/v1.1/${v === "t2v" ? "text-to-video" : "image-to-video"}`,
      unitPrice: 0.10,
      unit: "seconds",
      cost: (p) => {
        const secs = n(p, "duration", 8);
        const res = (p.resolution ?? "720p").toLowerCase();
        const rate: Record<string, number> = { "360p": 0.03, "720p": 0.10, "1080p": 0.15, "4k": 0.30 };
        const r = rate[res] ?? rate["720p"];
        return { usd: r * secs, accuracy: "exact", basis: `$${r}/s x ${secs}s (${res})` };
      },
    };
    return acc;
  }, {}),

  // Seedance 2.5: same token formula, $0.0214 per 1000 tokens at every tier.
  ...(["t2v", "i2v", "r2v"] as const).reduce<Record<string, Rule>>((acc, v) => {
    const ep =
      v === "t2v" ? "text-to-video" : v === "i2v" ? "image-to-video" : "reference-to-video";
    acc[`seedance-2.5-${v}`] = {
      endpoint: `bytedance/seedance-2.5/${ep}`,
      unitPrice: 0.0214,
      unit: "units",
      cost: (p, unitPrice) => FAL_COST_RULES[`seedance-2.0-${v}`].cost(p, unitPrice),
    };
    return acc;
  }, {}),

  ...(["t2v", "i2v", "r2v"] as const).reduce<Record<string, Rule>>((acc, v) => {
    const ep =
      v === "t2v" ? "text-to-video" : v === "i2v" ? "image-to-video" : "reference-to-video";
    acc[`seedance-2.0-${v}`] = {
      endpoint: `bytedance/seedance-2.0/${ep}`,
      unitPrice: 0.014,
      unit: "units",
      cost: (p, unitPrice) => {
        const secs = n(p, "duration", 5);
        const res = (p.resolution ?? "1080p").toLowerCase();
        const dims: Record<string, [number, number]> =
          { "480p": [854, 480], "720p": [1280, 720], "1080p": [1920, 1080], "4k": [3840, 2160] };
        const [w, h] = dims[res] ?? dims["1080p"];
        const tokens = (w * h * secs * 24) / 1024;
        return {
          usd: (tokens / 1000) * unitPrice,
          accuracy: "approx",
          basis: `${Math.round(tokens / 1000)}k tokens @ $${unitPrice}/1k (${res}, ${secs}s)`,
        };
      },
    };
    return acc;
  }, {}),

  // Topaz: $0.01/s <=720p, $0.02/s 720p-1080p, $0.08/s >1080p; x2 at 60fps.
  // Resolution keys are the `tier_fps` tokens UpscalePanel emits.
  "topaz-upscale-video": {
    endpoint: "fal-ai/topaz/upscale/video",
    unitPrice: 0.01,
    unit: "seconds",
    cost: (p) => {
      const secs = n(p, "duration", 5);
      const rates: Record<string, number> = {
        "720p_30": 0.01, "720p_60": 0.02,
        "1080p_30": 0.02, "1080p_60": 0.04,
        "4k_30": 0.08, "4k_60": 0.16,
      };
      const rate = rates[(p.resolution ?? "1080p_30").toLowerCase()] ?? 0.02;
      return { usd: rate * secs, accuracy: "exact", basis: `$${rate}/s x ${secs}s` };
    },
  },
  // Gaia 2 is half price across every tier (same fal endpoint, different model arg).
  "topaz-upscale-video-gaia2": {
    endpoint: "fal-ai/topaz/upscale/video",
    unitPrice: 0.005,
    unit: "seconds",
    cost: (p) => {
      const base = FAL_COST_RULES["topaz-upscale-video"].cost(p, 0.01);
      const secs = n(p, "duration", 5);
      const rate = base.usd / 2 / secs;
      return { usd: base.usd / 2, accuracy: "exact", basis: `$${rate}/s x ${secs}s (Gaia 2)` };
    },
  },

  // ---- Tools ------------------------------------------------------------
  // Per MEGAPIXEL of output, so cost scales with the image being upscaled.
  "seedvr-upscale": {
    endpoint: "fal-ai/seedvr/upscale/image",
    unitPrice: 0.001,
    unit: "megapixels",
    cost: (p, unitPrice) => {
      const mp = n(p, "megapixels", 4);
      return {
        usd: unitPrice * mp,
        accuracy: "approx",
        basis: `$${unitPrice}/MP x ~${mp}MP`,
      };
    },
  },
  // Billed on GPU COMPUTE SECONDS — genuinely unpredictable before dispatch.
  // ~2s is typical for a background removal.
  "pixelcut_remove_bg": {
    endpoint: "pixelcut/background-removal",
    unitPrice: 0.00125,
    unit: "compute seconds",
    cost: (p, unitPrice) => ({
      usd: unitPrice * 2 * qty(p),
      accuracy: "approx",
      basis: `$${unitPrice}/compute-s x ~2s`,
    }),
  },
  "remove_bg": {
    endpoint: "fal-ai/bria/background/remove",
    unitPrice: 0.018,
    unit: "generations",
    cost: flatPerUnit("generation"),
  },
  "bria_expand": {
    endpoint: "fal-ai/bria/expand",
    unitPrice: 0.04,
    unit: "generations",
    cost: flatPerUnit("generation"),
  },
  "recraft-v4-vector": {
    endpoint: "fal-ai/recraft/v4/pro/text-to-vector",
    unitPrice: 0.3,
    unit: "images",
    cost: flatPerUnit("image"),
  },
  "recraft-vectorize": {
    endpoint: "fal-ai/recraft/vectorize",
    unitPrice: 0.01,
    unit: "images",
    cost: flatPerUnit("image"),
  },

  // ---- Audio ------------------------------------------------------------
  "minimax-tts": {
    endpoint: "fal-ai/minimax/speech-2.8-hd",
    unitPrice: 0.1,
    unit: "1000 characters",
    cost: (p, unitPrice) => {
      const chars = n(p, "characters", 1000);
      const blocks = Math.ceil(chars / 1000);
      return {
        usd: unitPrice * blocks,
        accuracy: "exact",
        basis: `$${unitPrice}/1k chars x ${blocks} (${chars} chars)`,
      };
    },
  },
  "elevenlabs-voice-changer": {
    endpoint: "fal-ai/elevenlabs/voice-changer",
    unitPrice: 0.3,
    unit: "minutes",
    cost: (p, unitPrice) => {
      const secs = n(p, "duration", 30);
      const mins = secs / 60;
      return {
        usd: unitPrice * mins,
        accuracy: "exact",
        basis: `$${unitPrice}/min x ${mins.toFixed(2)}min`,
      };
    },
  },
  "elevenlabs-sfx": {
    endpoint: "fal-ai/elevenlabs/sound-effects/v2",
    unitPrice: 0.002,
    unit: "seconds",
    cost: perSecond(),
  },
  "minimax-music": {
    endpoint: "fal-ai/minimax-music/v2.6",
    unitPrice: 0.15,
    unit: "audios",
    cost: flatPerUnit("track"),
  },
};

/** Model keys that have an at-cost rule. `clearcheck` is deliberately absent — it runs on AWS Rekognition, not fal. */
export function falPricedModelKeys(): string[] {
  return Object.keys(FAL_COST_RULES);
}

export function falEndpointFor(modelKey: string): string | undefined {
  return FAL_COST_RULES[modelKey]?.endpoint;
}

/**
 * At-cost USD for one generation. `liveUnitPrice` (from services/falPricing.ts)
 * overrides the snapshot when available; models whose cost is a matrix or a
 * formula ignore it by design.
 */
export function estimateFalCost(
  modelKey: string,
  params: CostParams = {},
  liveUnitPrice?: number,
): FalCostEstimate | null {
  const rule = FAL_COST_RULES[modelKey];
  if (!rule) return null;
  const unitPrice =
    typeof liveUnitPrice === "number" && isFinite(liveUnitPrice) && liveUnitPrice > 0
      ? liveUnitPrice
      : rule.unitPrice;
  const out = rule.cost(params, unitPrice);
  return { ...out, usd: Math.max(0, out.usd) };
}
