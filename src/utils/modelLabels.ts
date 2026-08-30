export type ModelInfo = {
  displayName: string;
  variation: string;
};

const MODEL_INFO: Record<string, ModelInfo> = {
  "nano-banana-2-t2i": { displayName: "Nano Banana 2", variation: "Text → Image" },
  "nano-banana-2": { displayName: "Nano Banana 2", variation: "Image → Image" },
  "seedream-t2i": { displayName: "Seedream", variation: "Text → Image" },
  "seedream-edit": { displayName: "Seedream", variation: "Image → Image" },
  "gpt-image-2-t2i": { displayName: "GPT Image 2", variation: "Text → Image" },
  "gpt-image-2-edit": { displayName: "GPT Image 2", variation: "Image → Image" },
  "kling-o3-pro-t2v": { displayName: "Kling O3 Pro", variation: "Text → Video" },
  "kling-o3-pro-i2v": { displayName: "Kling O3 Pro", variation: "Image → Video" },
  "kling-o3-pro-r2v": { displayName: "Kling O3 Pro", variation: "Reference → Video" },
  "kling-o3-4k-t2v": { displayName: "Kling O3 4K", variation: "Text → Video" },
  "kling-o3-4k-i2v": { displayName: "Kling O3 4K", variation: "Image → Video" },
  "kling-o3-4k-r2v": { displayName: "Kling O3 4K", variation: "Reference → Video" },
  "kling-2.6-mc": { displayName: "Kling 2.6 Avatar", variation: "Motion Control" },
  "kling-3.0-mc": { displayName: "Kling 3.0 Avatar", variation: "Motion Control" },
  "veo3.1-lite-t2v": { displayName: "Veo 3.1 Lite", variation: "Text → Video" },
  "veo3.1-lite-i2v": { displayName: "Veo 3.1 Lite", variation: "Image → Video" },
  "veo3.1-lite-flf2v": { displayName: "Veo 3.1 Lite", variation: "First/Last Frame → Video" },
  "h3-max-t2v": { displayName: "MiniMax H3 Max", variation: "Text → Video" },
  "seedance-2.0-t2v": { displayName: "Seedance 2.0", variation: "Text → Video" },
  "seedance-2.0-i2v": { displayName: "Seedance 2.0", variation: "Image → Video" },
  "seedance-2.0-r2v": { displayName: "Seedance 2.0", variation: "Reference → Video" },
  "seedvr-upscale": { displayName: "SeedVR Upscale", variation: "Upscale" },
  "pixelcut_remove_bg": { displayName: "Pixelcut", variation: "Background Removal" },
  "remove_bg": { displayName: "Background Removal", variation: "Background Removal" },
  "bria_expand": { displayName: "Bria Expand", variation: "Resize / Expand" },
  "recraft-v4-vector": { displayName: "Recraft Vector", variation: "Text → Vector" },
  "recraft-vectorize": { displayName: "Recraft Vectorize", variation: "Image → Vector" },
  "minimax-tts": { displayName: "Minimax TTS", variation: "Text to Speech" },
  "minimax-music": { displayName: "Minimax Music", variation: "Music" },
  "elevenlabs-sfx": { displayName: "ElevenLabs SFX", variation: "Sound Effects" },
  "elevenlabs-voice-changer": { displayName: "ElevenLabs Voice Changer", variation: "Voice Changer" },
  "clearcheck": { displayName: "Clearcheck", variation: "Clearcheck" },
  "claude-sonnet": { displayName: "Claude Sonnet 4.6", variation: "Agent Chat" },
  "claude-haiku": { displayName: "Claude Haiku 4.5", variation: "Agent Chat" },
  "claude-opus": { displayName: "Claude Opus", variation: "Agent Chat" },
};

const TYPE_LABELS: Record<string, string> = {
  text_to_image: "Text → Image",
  image_to_image: "Image → Image",
  video_gen: "Video",
  remove_bg: "Background Removal",
  resize: "Resize",
  upscale: "Upscale",
  avatar: "Motion Control",
  text_to_vector: "Text → Vector",
  image_to_vector: "Image → Vector",
  audio_music: "Music",
  audio_tts: "Text to Speech",
  audio_sfx: "Sound Effects",
  audio_voice_changer: "Voice Changer",
  clearcheck: "Clearcheck",
};

export function getModelDisplayName(modelKey: string | null | undefined): string {
  if (!modelKey) return "Unknown model";
  const info = MODEL_INFO[modelKey];
  if (info) return info.displayName;
  return modelKey;
}

export function getVariationLabel(modelKey: string | null | undefined, type: string): string {
  // Refund rows from /api/usage arrive as `refund:<original_reason>`.
  // Surface them as a friendly "Refund" with the underlying reason so
  // users can see what was credited back (task #465).
  if (typeof type === "string" && type.startsWith("refund:")) {
    const reason = type.slice("refund:".length).replace(/_/g, " ");
    return reason ? `Refund · ${reason}` : "Refund";
  }
  if (modelKey) {
    const info = MODEL_INFO[modelKey];
    if (info) return info.variation;
  }
  return TYPE_LABELS[type] ?? type;
}

export function formatRelativeTime(isoTimestamp: string): string {
  const then = new Date(isoTimestamp).getTime();
  if (!Number.isFinite(then)) return "";
  const now = Date.now();
  const diffSec = Math.max(0, Math.round((now - then) / 1000));
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay === 1) return "yesterday";
  if (diffDay < 7) return `${diffDay}d ago`;
  const diffWk = Math.round(diffDay / 7);
  if (diffWk < 5) return `${diffWk}w ago`;
  const diffMo = Math.round(diffDay / 30);
  if (diffMo < 12) return `${diffMo}mo ago`;
  const diffYr = Math.round(diffDay / 365);
  return `${diffYr}y ago`;
}
