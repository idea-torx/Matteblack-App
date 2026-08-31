// Feature surcharges may be either:
//   - a plain number  → multiplied by duration & resolution along with base_cost
//                        (the legacy per-second behavior, kept for back-compat)
//   - { flat: N }     → added once to the total AFTER the duration / resolution
//                        multipliers, regardless of clip length. Use this for
//                        fees that the upstream provider charges per generation
//                        rather than per second (e.g. Kling O3 Pro audio).
export type FeatureSurcharge = number | { flat: number };

export type ModelPricingConfig = {
  model_key: string;
  base_cost: number;
  resolution_multipliers: Record<string, number> | null;
  duration_multipliers: Record<string, number> | null;
  feature_surcharges: Record<string, FeatureSurcharge> | null;
  input_token_net_cost_per_million?: number;
  output_token_net_cost_per_million?: number;
};

const RESOLUTION_MULTIPLIERS = { "0.5k": 0.75, "1k": 1.0, "2k": 1.5, "4k": 2.0 };
const GEMINI_OMNI_RESOLUTION_MULTIPLIERS = { "360p": 0.2, "720p": 0.667, "1080p": 1.0, "4k": 2.0 };
const SEEDANCE_RESOLUTION_MULTIPLIERS = { "480p": 0.20, "720p": 0.45, "1080p": 1.0 };

export const MODEL_PRICING_CONFIG: ModelPricingConfig[] = [
  { model_key: "nano-banana-2-t2i", base_cost: 16, resolution_multipliers: RESOLUTION_MULTIPLIERS, duration_multipliers: null, feature_surcharges: null },
  { model_key: "nano-banana-2", base_cost: 16, resolution_multipliers: RESOLUTION_MULTIPLIERS, duration_multipliers: null, feature_surcharges: null },
  { model_key: "seedream-t2i", base_cost: 6, resolution_multipliers: RESOLUTION_MULTIPLIERS, duration_multipliers: null, feature_surcharges: { "web_search": 2, "high_thinking": 1 } },
  { model_key: "seedream-edit", base_cost: 6, resolution_multipliers: RESOLUTION_MULTIPLIERS, duration_multipliers: null, feature_surcharges: { "web_search": 2, "high_thinking": 1 } },
  // Seedream 5 Lite is a flat $0.035/image at 2K-4K, so no resolution ladder.
  { model_key: "seedream-5-t2i", base_cost: 6, resolution_multipliers: null, duration_multipliers: null, feature_surcharges: null },
  { model_key: "seedream-5-edit", base_cost: 6, resolution_multipliers: null, duration_multipliers: null, feature_surcharges: null },
  { model_key: "gpt-image-2-t2i", base_cost: 21, resolution_multipliers: { "1k": 1.0, "2k": 1.67 }, duration_multipliers: null, feature_surcharges: { "quality_medium": -15, "quality_low": -19 } },
  { model_key: "gpt-image-2-edit", base_cost: 21, resolution_multipliers: { "1k": 1.0, "2k": 1.67 }, duration_multipliers: null, feature_surcharges: { "quality_medium": -15, "quality_low": -19 } },
  // kling-2.6-t2v / kling-2.6-i2v are kept here SOLELY so historical generation
  // rows continue to resolve a price; the model keys are no longer dispatched
  // (replaced by kling-o3-pro / kling-o3-4k variants below).
  { model_key: "kling-2.6-t2v", base_cost: 14, resolution_multipliers: null, duration_multipliers: { "per_second": 1 }, feature_surcharges: { "generate_audio": 14 } },
  { model_key: "kling-2.6-i2v", base_cost: 14, resolution_multipliers: null, duration_multipliers: { "per_second": 1 }, feature_surcharges: { "generate_audio": 14 } },
  { model_key: "kling-3.0-mc", base_cost: 34, resolution_multipliers: null, duration_multipliers: { "per_second": 1 }, feature_surcharges: null },
  { model_key: "kling-2.6-mc", base_cost: 34, resolution_multipliers: null, duration_multipliers: { "per_second": 1 }, feature_surcharges: null },
  // Kling O3 Pro: per-second cost 14 (`duration_multipliers.per_second: 1`).
  // The audio surcharge is FLAT — fal charges +18 cr per generation regardless
  // of clip length — so it uses the `{ flat: 18 }` form, applied AFTER the
  // duration multiplier in creditGate. 5s audio-off = 70 cr; 5s audio-on =
  // 70 + 18 = 88 cr; 10s audio-on = 140 + 18 = 158 cr.
  { model_key: "kling-o3-pro-t2v", base_cost: 14, resolution_multipliers: null, duration_multipliers: { "per_second": 1 }, feature_surcharges: { "generate_audio": { flat: 18 } } },
  { model_key: "kling-o3-pro-i2v", base_cost: 14, resolution_multipliers: null, duration_multipliers: { "per_second": 1 }, feature_surcharges: { "generate_audio": { flat: 18 } } },
  { model_key: "kling-o3-pro-r2v", base_cost: 14, resolution_multipliers: null, duration_multipliers: { "per_second": 1 }, feature_surcharges: { "generate_audio": { flat: 18 } } },
  // Kling O3 4K: per-second cost 53, no audio surcharge (price is identical
  // with or without audio). 5s = 265 credits.
  { model_key: "kling-o3-4k-t2v", base_cost: 53, resolution_multipliers: null, duration_multipliers: { "per_second": 1 }, feature_surcharges: null },
  { model_key: "kling-o3-4k-i2v", base_cost: 53, resolution_multipliers: null, duration_multipliers: { "per_second": 1 }, feature_surcharges: null },
  { model_key: "kling-o3-4k-r2v", base_cost: 53, resolution_multipliers: null, duration_multipliers: { "per_second": 1 }, feature_surcharges: null },
  { model_key: "seedvr-upscale", base_cost: 8, resolution_multipliers: null, duration_multipliers: null, feature_surcharges: null },
  // Topaz video upscale (`fal-ai/topaz/upscale/video`). Pricing per fal docs:
  //   ≤720p output: $0.01/s   720p–1080p: $0.02/s   >1080p: $0.08/s
  //   ×2 at 60fps. Gaia 2 model is half price across the board.
  // CREDITS_PER_DOLLAR=100 → $0.01/s = 1 cr/s at fal cost. We charge a 50% net
  // margin (≈2× fal's raw cost), so Topaz base_cost=4 / Gaia 2 base_cost=2;
  // multipliers are identical so the only difference between the two rows is
  // the integer base_cost (Gaia 2 = ½ Topaz). Resolution keys are the
  // tier_fps tokens emitted by UpscalePanel.
  { model_key: "topaz-upscale-video", base_cost: 4, resolution_multipliers: { "720p_30": 0.5, "720p_60": 1, "1080p_30": 1, "1080p_60": 2, "4k_30": 4, "4k_60": 8 }, duration_multipliers: { "per_second": 1 }, feature_surcharges: null },
  { model_key: "topaz-upscale-video-gaia2", base_cost: 2, resolution_multipliers: { "720p_30": 0.5, "720p_60": 1, "1080p_30": 1, "1080p_60": 2, "4k_30": 4, "4k_60": 8 }, duration_multipliers: { "per_second": 1 }, feature_surcharges: null },
  { model_key: "pixelcut_remove_bg", base_cost: 2, resolution_multipliers: null, duration_multipliers: null, feature_surcharges: null },
  { model_key: "remove_bg", base_cost: 4, resolution_multipliers: null, duration_multipliers: null, feature_surcharges: null },
  { model_key: "bria_expand", base_cost: 6, resolution_multipliers: null, duration_multipliers: null, feature_surcharges: null },
  { model_key: "recraft-v4-vector", base_cost: 30, resolution_multipliers: null, duration_multipliers: null, feature_surcharges: null },
  { model_key: "recraft-vectorize", base_cost: 4, resolution_multipliers: null, duration_multipliers: null, feature_surcharges: null },
  { model_key: "minimax-tts", base_cost: 8, resolution_multipliers: null, duration_multipliers: { "per_1000_characters": 1 }, feature_surcharges: null },
  { model_key: "elevenlabs-voice-changer", base_cost: 30, resolution_multipliers: null, duration_multipliers: null, feature_surcharges: null },
  { model_key: "elevenlabs-sfx", base_cost: 10, resolution_multipliers: null, duration_multipliers: { "per_second": 1 }, feature_surcharges: null },
  { model_key: "minimax-music", base_cost: 30, resolution_multipliers: null, duration_multipliers: null, feature_surcharges: null },
  { model_key: "clearcheck", base_cost: 100, resolution_multipliers: null, duration_multipliers: null, feature_surcharges: null },
  { model_key: "veo3.1-lite-t2v", base_cost: 6, resolution_multipliers: null, duration_multipliers: { "per_second": 1 }, feature_surcharges: { "generate_audio": 4 } },
  { model_key: "veo3.1-lite-i2v", base_cost: 6, resolution_multipliers: null, duration_multipliers: { "per_second": 1 }, feature_surcharges: { "generate_audio": 4 } },
  { model_key: "veo3.1-lite-flf2v", base_cost: 6, resolution_multipliers: null, duration_multipliers: { "per_second": 1 }, feature_surcharges: { "generate_audio": 4 } },
  // H3 Max: 12 credits/s at 768P ($0.08/s fal), 480P scaled to fal's own ratio.
  { model_key: "h3-max-t2v", base_cost: 12, resolution_multipliers: { "480p": 0.625, "768p": 1.0 }, duration_multipliers: { "per_second": 1 }, feature_surcharges: null },
  // Gemini Omni Flash 1.1: $0.15/s at 1080p, scaled by the resolution ladder.
  { model_key: "gemini-omni-t2v", base_cost: 20, resolution_multipliers: GEMINI_OMNI_RESOLUTION_MULTIPLIERS, duration_multipliers: { "per_second": 1 }, feature_surcharges: null },
  { model_key: "gemini-omni-i2v", base_cost: 20, resolution_multipliers: GEMINI_OMNI_RESOLUTION_MULTIPLIERS, duration_multipliers: { "per_second": 1 }, feature_surcharges: null },
  // Seedance 2.5 is $0.0214/1k tokens against 2.0's $0.014 — 1.53x, so 139 cr/s.
  { model_key: "seedance-2.5-t2v", base_cost: 139, resolution_multipliers: SEEDANCE_RESOLUTION_MULTIPLIERS, duration_multipliers: { "per_second": 1 }, feature_surcharges: null },
  { model_key: "seedance-2.5-i2v", base_cost: 139, resolution_multipliers: SEEDANCE_RESOLUTION_MULTIPLIERS, duration_multipliers: { "per_second": 1 }, feature_surcharges: null },
  { model_key: "seedance-2.5-r2v", base_cost: 139, resolution_multipliers: SEEDANCE_RESOLUTION_MULTIPLIERS, duration_multipliers: { "per_second": 1 }, feature_surcharges: null },
  { model_key: "seedance-2.0-t2v", base_cost: 91, resolution_multipliers: SEEDANCE_RESOLUTION_MULTIPLIERS, duration_multipliers: { "per_second": 1 }, feature_surcharges: null },
  { model_key: "seedance-2.0-i2v", base_cost: 91, resolution_multipliers: SEEDANCE_RESOLUTION_MULTIPLIERS, duration_multipliers: { "per_second": 1 }, feature_surcharges: null },
  { model_key: "seedance-2.0-r2v", base_cost: 91, resolution_multipliers: SEEDANCE_RESOLUTION_MULTIPLIERS, duration_multipliers: { "per_second": 1 }, feature_surcharges: null },
  { model_key: "claude-opus", base_cost: 8, resolution_multipliers: null, duration_multipliers: { "per_1000_characters": 1 }, feature_surcharges: { "vision": 4 } },
  { model_key: "claude-sonnet", base_cost: 4, resolution_multipliers: null, duration_multipliers: { "per_1000_characters": 1 }, feature_surcharges: { "vision": 2 }, input_token_net_cost_per_million: 3, output_token_net_cost_per_million: 15 },
  { model_key: "claude-haiku", base_cost: 1, resolution_multipliers: null, duration_multipliers: { "per_1000_characters": 1 }, feature_surcharges: { "vision": 1 } },
];
