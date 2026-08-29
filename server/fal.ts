import path from "node:path";
import mime from "mime-types";
import { fal } from "@fal-ai/client";
import { pool } from "./db.js";
import { createNotification } from "./notifications.js";
import { refundCreditsWithFallback } from "./credits/creditGate.js";
import { rehostExternalUrlToR2, isR2HostedUrl, getFileStream, parseFileUrl, toLocalUploadsPath } from "./storage.js";
import { getFalKey } from "./config/userConfig.js";
import { LOCAL_MODE } from "./config/runtime.js";

/**
 * Rehost a fal.ai result URL onto our own R2 bucket so the URL is durable
 * (fal.media URLs expire) and so the asset is reachable from our network for
 * later use as a reference. Returns the R2 URL on success or the original URL
 * unchanged on failure — callers always get a usable URL even if rehost fails.
 */
async function rehostFalResultToR2(
  url: string | null,
  jobId: string,
  type: "image" | "video" | "svg" | "audio"
): Promise<string | null> {
  if (!url) return url;
  if (isR2HostedUrl(url)) return url;
  if (url.startsWith("data:")) return url;
  if (!/^https?:\/\//i.test(url)) return url;
  try {
    const bucket = "generations";
    const pathPrefix = `${type}/${jobId}`;
    const r2Url = await rehostExternalUrlToR2(url, bucket, pathPrefix);
    console.log(`[fal.ai] Rehosted job ${jobId} result to R2: ${r2Url}`);
    return r2Url;
  } catch (err) {
    console.error(`[fal.ai] Failed to rehost job ${jobId} result to R2 (keeping fal URL):`, err instanceof Error ? err.message : err);
    return url;
  }
}

type FalUserNotification = {
  title: string;
  message: string;
  severity: "error" | "warning" | "info";
  retryable: boolean;
};

const FAL_ERROR_NOTIFICATIONS: Record<string, (ctx?: any, msg?: string) => FalUserNotification> = {
  content_policy_violation: () => ({
    title: "Content flagged",
    message: "Your prompt or image was flagged by safety filters. Try rephrasing or using a different image.",
    severity: "warning",
    retryable: false,
  }),
  no_media_generated: (_ctx: any, msg?: string) => {
    const lowerMsg = (msg || "").toLowerCase();
    if (lowerMsg.includes("unsafe") || lowerMsg.includes("safety")) {
      return {
        title: "Content guideline violation",
        message: "Your prompt was flagged for violating content guidelines. Please revise your prompt and try again.",
        severity: "warning" as const,
        retryable: false,
      };
    }
    return {
      title: "Generation failed",
      message: "The model couldn't produce output for this prompt. Try adjusting your prompt or parameters.",
      severity: "warning" as const,
      retryable: false,
    };
  },
  generation_timeout: () => ({
    title: "Generation timed out",
    message: "This took too long to process. Try again or simplify your request.",
    severity: "error",
    retryable: true,
  }),
  image_too_small: (ctx) => ({
    title: "Image too small",
    message: `Minimum dimensions: ${ctx?.min_width}×${ctx?.min_height}px.`,
    severity: "warning",
    retryable: false,
  }),
  image_too_large: (ctx) => ({
    title: "Image too large",
    message: `Maximum dimensions: ${ctx?.max_width}×${ctx?.max_height}px.`,
    severity: "warning",
    retryable: false,
  }),
  image_aspect_ratio_error: (ctx) => {
    const min = ctx?.min_aspect_ratio;
    const max = ctx?.max_aspect_ratio;
    const range = (typeof min === "number" && typeof max === "number")
      ? `between ${min}:1 and ${max}:1`
      : "within the supported range";
    return {
      title: "Reference image too wide or tall",
      message: `This model needs reference images ${range}. Try cropping closer to a standard ratio.`,
      severity: "warning",
      retryable: false,
    };
  },
  image_load_error: () => ({
    title: "Image couldn't be loaded",
    message: "The image may be corrupted or in an unsupported format.",
    severity: "error",
    retryable: false,
  }),
  unsupported_image_format: (ctx) => ({
    title: "Unsupported image format",
    message: `Supported formats: ${ctx?.supported_formats?.join(", ")}.`,
    severity: "warning",
    retryable: false,
  }),
  file_download_error: () => ({
    title: "File couldn't be downloaded",
    message: "The file URL isn't accessible. Make sure it's publicly available.",
    severity: "error",
    retryable: false,
  }),
  file_too_large: (ctx) => ({
    title: "File too large",
    message: `Maximum file size: ${Math.round((ctx?.max_size || 0) / 1048576)}MB.`,
    severity: "warning",
    retryable: false,
  }),
  unsupported_video_format: (ctx) => ({
    title: "Unsupported video format",
    message: `Supported formats: ${ctx?.supported_formats?.join(", ")}.`,
    severity: "warning",
    retryable: false,
  }),
  video_duration_too_long: (ctx) => ({
    title: "Video too long",
    message: `Maximum duration: ${ctx?.max_duration}s. Yours: ${ctx?.provided_duration}s.`,
    severity: "warning",
    retryable: false,
  }),
  video_duration_too_short: (ctx) => ({
    title: "Video too short",
    message: `Minimum duration: ${ctx?.min_duration}s. Yours: ${ctx?.provided_duration}s.`,
    severity: "warning",
    retryable: false,
  }),
  unsupported_audio_format: (ctx) => ({
    title: "Unsupported audio format",
    message: `Supported formats: ${ctx?.supported_formats?.join(", ")}.`,
    severity: "warning",
    retryable: false,
  }),
  audio_duration_too_long: (ctx) => ({
    title: "Audio too long",
    message: `Maximum duration: ${ctx?.max_duration}s. Yours: ${ctx?.provided_duration}s.`,
    severity: "warning",
    retryable: false,
  }),
  audio_duration_too_short: (ctx) => ({
    title: "Audio too short",
    message: `Minimum duration: ${ctx?.min_duration}s. Yours: ${ctx?.provided_duration}s.`,
    severity: "warning",
    retryable: false,
  }),
  face_detection_error: () => ({
    title: "No face detected",
    message: "This model requires a clear face in the image. Try a different photo.",
    severity: "warning",
    retryable: false,
  }),
  greater_than: (ctx) => ({
    title: "Invalid parameter",
    message: `Value must be greater than ${ctx?.gt}.`,
    severity: "warning",
    retryable: false,
  }),
  greater_than_equal: (ctx) => ({
    title: "Invalid parameter",
    message: `Value must be at least ${ctx?.ge}.`,
    severity: "warning",
    retryable: false,
  }),
  less_than: (ctx) => ({
    title: "Invalid parameter",
    message: `Value must be less than ${ctx?.lt}.`,
    severity: "warning",
    retryable: false,
  }),
  less_than_equal: (ctx) => ({
    title: "Invalid parameter",
    message: `Value must be at most ${ctx?.le}.`,
    severity: "warning",
    retryable: false,
  }),
  multiple_of: (ctx) => ({
    title: "Invalid parameter",
    message: `Value must be a multiple of ${ctx?.multiple_of}.`,
    severity: "warning",
    retryable: false,
  }),
  one_of: (ctx) => ({
    title: "Invalid option",
    message: `Allowed values: ${ctx?.expected?.join(", ")}.`,
    severity: "warning",
    retryable: false,
  }),
  sequence_too_short: (ctx) => ({
    title: "Too few items",
    message: `Minimum required: ${ctx?.min_length}.`,
    severity: "warning",
    retryable: false,
  }),
  sequence_too_long: (ctx) => ({
    title: "Too many items",
    message: `Maximum allowed: ${ctx?.max_length}.`,
    severity: "warning",
    retryable: false,
  }),
  feature_not_supported: () => ({
    title: "Feature not supported",
    message: "This combination of parameters isn't supported by the model.",
    severity: "warning",
    retryable: false,
  }),
  invalid_archive: (ctx) => ({
    title: "Invalid archive",
    message: `Supported formats: ${ctx?.supported_extensions?.join(", ")}.`,
    severity: "error",
    retryable: false,
  }),
  archive_file_count_below_minimum: (ctx) => ({
    title: "Too few files in archive",
    message: `Minimum ${ctx?.min_count} files required. Found ${ctx?.provided_count}.`,
    severity: "warning",
    retryable: false,
  }),
  archive_file_count_exceeds_maximum: (ctx) => ({
    title: "Too many files in archive",
    message: `Maximum ${ctx?.max_count} files allowed. Found ${ctx?.provided_count}.`,
    severity: "warning",
    retryable: false,
  }),
  internal_server_error: () => ({
    title: "Server error",
    message: "Something went wrong on the generation server. Retrying automatically.",
    severity: "error",
    retryable: true,
  }),
  downstream_service_error: () => ({
    title: "Service error",
    message: "A required service is having issues. Try again in a moment.",
    severity: "error",
    retryable: true,
  }),
  downstream_service_unavailable: () => ({
    title: "Service unavailable",
    message: "A required service is temporarily down. Try again shortly.",
    severity: "error",
    retryable: true,
  }),
};

function parseFalError(err: unknown): { errorType: string | null; errorTitle: string; errorMessage: string; severity: "error" | "warning" | "info"; errorDetail: Record<string, unknown> | null } {
  const errBody = (err as any)?.body ?? (err as any)?.detail ?? (err as any)?.response ?? null;
  const detail = errBody?.detail?.[0] ?? (Array.isArray(errBody) ? errBody[0] : null);
  const errorType = detail?.type ?? null;
  const ctx = detail?.ctx ?? null;

  if (errorType && FAL_ERROR_NOTIFICATIONS[errorType]) {
    const notif = FAL_ERROR_NOTIFICATIONS[errorType](ctx, detail?.msg);
    return {
      errorType,
      errorTitle: notif.title,
      errorMessage: notif.message,
      severity: notif.severity,
      errorDetail: detail ? { type: errorType, ctx, msg: detail.msg } : null,
    };
  }

  const httpStatus = (err as any)?.status ?? 0;
  if (httpStatus >= 500) {
    return {
      errorType: "server_error",
      errorTitle: "Server error",
      errorMessage: "Something went wrong. Retrying automatically.",
      severity: "error",
      errorDetail: detail,
    };
  }

  return {
    errorType: errorType || "unknown",
    errorTitle: "Generation failed",
    errorMessage: detail?.msg || (err instanceof Error ? err.message : "An unexpected error occurred."),
    severity: "error",
    errorDetail: detail,
  };
}

/**
 * Configure the fal client with the currently-effective key and report whether
 * one exists. The key can come from the user's local Settings (userConfig) or
 * a FAL_KEY/VITE_FAL_KEY env var, and may change at runtime — so we resolve it
 * on every dispatch rather than once at module load.
 */
export function ensureFalConfigured(): boolean {
  const key = getFalKey();
  if (key) {
    fal.config({ credentials: key });
    return true;
  }
  return false;
}

if (!ensureFalConfigured()) {
  console.warn("[fal.ai] No fal.ai API key set — add one in Settings (or set FAL_KEY) before generating.");
}

type ModelConfig = {
  falModelId: string;
  type: "image" | "video" | "svg" | "audio";
  buildInput: (params: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>;
};

export function isValidImageUrl(url: string): boolean {
  if (url.startsWith("data:image/")) return true;
  try {
    const parsed = new URL(url);
    if (parsed.pathname === "/" || parsed.pathname === "") return false;
    const knownCdnDomains = ["fal.media", "fal.ai", "v3.fal.media", "storage.googleapis.com", "cdn.replit.com", "r2.dev"];
    if (knownCdnDomains.some((d) => parsed.hostname.endsWith(d))) return true;
    const imageExtensions = /\.(png|jpg|jpeg|gif|webp|bmp|tiff|svg|avif)(\?.*)?$/i;
    if (imageExtensions.test(parsed.pathname)) return true;
    if (parsed.pathname.startsWith("/uploads/")) return true;
    return false;
  } catch {
    return false;
  }
}

function normalizeSeedanceResolution(value: unknown): "480p" | "720p" | "1080p" {
  if (typeof value === "string") {
    const v = value.toLowerCase().trim();
    if (v === "480p" || v === "480") return "480p";
    if (v === "720p" || v === "720") return "720p";
    if (v === "1080p" || v === "1080") return "1080p";
  }
  return "1080p";
}

function normalizeSeedanceDuration(value: unknown): string {
  const n = typeof value === "number" ? value : parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return "5";
  const clamped = Math.max(4, Math.min(15, Math.round(n)));
  return String(clamped);
}

export function sanitizeUrl(url: unknown): string | undefined {
  if (typeof url !== "string" || !url) return undefined;
  let cleaned = url.trim();
  const cssUrlMatch = cleaned.match(/^url\(["']?(.*?)["']?\)$/);
  if (cssUrlMatch) cleaned = cssUrlMatch[1];
  if (cleaned.startsWith("data:") || cleaned.startsWith("http://") || cleaned.startsWith("https://")) {
    if (!isValidImageUrl(cleaned)) return undefined;
    return cleaned;
  }
  return undefined;
}

/**
 * Structured error thrown when an input URL can't be hosted/fetched into a
 * shape fal.ai will accept. Carries an `error_code` so route handlers can
 * surface a friendly 400 to the client instead of letting the failure
 * bubble up as a base64/decode error from fal.
 */
export class ReferenceInputError extends Error {
  error_code: string;
  status: number;
  constructor(error_code: string, message: string, status: number = 400) {
    super(message);
    this.name = "ReferenceInputError";
    this.error_code = error_code;
    this.status = status;
  }
}

async function ensureHostedUrl(url: string): Promise<string> {
  if (!url.startsWith("data:")) return url;
  try {
    const resp = await fetch(url);
    const blob = await resp.blob();
    let ext = "bin";
    let defaultType = "application/octet-stream";
    if (url.startsWith("data:image/png")) { ext = "png"; defaultType = "image/png"; }
    else if (url.startsWith("data:image/webp")) { ext = "webp"; defaultType = "image/webp"; }
    else if (url.startsWith("data:image/")) { ext = "jpg"; defaultType = "image/jpeg"; }
    else if (url.startsWith("data:audio/webm")) { ext = "webm"; defaultType = "audio/webm"; }
    else if (url.startsWith("data:audio/wav")) { ext = "wav"; defaultType = "audio/wav"; }
    else if (url.startsWith("data:audio/mp3") || url.startsWith("data:audio/mpeg")) { ext = "mp3"; defaultType = "audio/mpeg"; }
    else if (url.startsWith("data:audio/ogg")) { ext = "ogg"; defaultType = "audio/ogg"; }
    else if (url.startsWith("data:audio/")) { ext = "wav"; defaultType = "audio/wav"; }
    const file = new File([blob], `upload.${ext}`, { type: blob.type || defaultType });
    return await fal.storage.upload(file);
  } catch (e) {
    console.error("[fal.ai] Failed to upload data URL to fal storage:", e);
    // Surface a structured error instead of returning the raw data: URL —
    // fal would otherwise reject it later with a confusing base64 message.
    throw new ReferenceInputError(
      "reference_upload_failed",
      "Couldn't upload the inline reference image. Try regenerating or re-uploading it.",
    );
  }
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Make a single reference URL fetchable by fal.ai's remote servers.
 *
 * In LOCAL_MODE, reference assets live on the user's disk and are served over
 * loopback "/uploads/..." URLs that fal.ai cannot reach across the network. We
 * read the bytes straight off disk (no self-fetch — avoids the loopback SSRF
 * block and doesn't care which port the server bound) and upload them to
 * fal.storage, returning the resulting fal.media URL. data: URIs and
 * already-public URLs (fal.media, R2, etc.) pass through untouched. Cloud mode
 * is a no-op — stored R2 URLs are already public.
 */
export async function ensureFalReachableUrl(url: string): Promise<string> {
  if (!url || typeof url !== "string") return url;
  if (!LOCAL_MODE) return url;
  if (url.startsWith("data:")) return url;
  const uploadsPath = toLocalUploadsPath(url);
  if (!uploadsPath) return url; // already a public/remote URL
  const parsed = parseFileUrl(uploadsPath);
  if (!parsed) return url;
  const { Body } = await getFileStream(parsed.bucket, parsed.path);
  if (!Body) {
    throw new ReferenceInputError(
      "reference_unreachable",
      "That reference file couldn't be found in local storage. Re-add it and try again.",
    );
  }
  const buf = await streamToBuffer(Body);
  const filename = path.posix.basename(parsed.path) || "reference";
  const contentType = (mime.lookup(filename) || "application/octet-stream") as string;
  const file = new File([buf], filename, { type: contentType });
  const falUrl = await fal.storage.upload(file);
  console.log(`[fal.ai] Uploaded local reference ${uploadsPath} -> ${falUrl}`);
  return falUrl;
}

const FAL_REFERENCE_URL_FIELDS = [
  "firstFrameUrl", "lastFrameUrl", "image_url", "video_url", "audio_url",
] as const;

/**
 * Resolve every reference URL carried in a generation's params to a
 * fal-reachable URL before the model's buildInput runs. This is the single
 * choke point: doing it here means every model (image edit, i2v/r2v video,
 * motion-control avatar, upscale, voice-changer) gets local references
 * uploaded to fal.storage without any per-model change. LOCAL_MODE only.
 */
async function makeReferencesFalReachable(params: Record<string, unknown>): Promise<void> {
  if (!LOCAL_MODE) return;
  for (const field of FAL_REFERENCE_URL_FIELDS) {
    const v = params[field];
    if (typeof v === "string" && v) {
      params[field] = await ensureFalReachableUrl(v);
    }
  }
  if (Array.isArray(params.referenceImageUrls)) {
    const out: unknown[] = [];
    for (const v of params.referenceImageUrls) {
      out.push(typeof v === "string" && v ? await ensureFalReachableUrl(v) : v);
    }
    params.referenceImageUrls = out;
  }
}

function parseImageDimensions(buf: Buffer): { width: number; height: number } | null {
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
      const width = buf.readUInt32BE(16);
      const height = buf.readUInt32BE(20);
      return { width, height };
    }
    if (buf[0] === 0xFF && buf[1] === 0xD8) {
      let offset = 2;
      while (offset < buf.length - 1) {
        if (buf[offset] !== 0xFF) break;
        const marker = buf[offset + 1];
        if (marker === 0xC0 || marker === 0xC2) {
          const height = buf.readUInt16BE(offset + 5);
          const width = buf.readUInt16BE(offset + 7);
          return { width, height };
        }
        const segLen = buf.readUInt16BE(offset + 2);
        offset += 2 + segLen;
      }
    }
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
      const width = buf.readUInt16LE(26) & 0x3FFF;
      const height = buf.readUInt16LE(28) & 0x3FFF;
      return { width, height };
    }
  } catch { /* ignore parse errors */ }
  return null;
}

const NANO_BANANA_ASPECT_RATIOS = [
  "21:9", "16:9", "3:2", "4:3", "5:4", "1:1", "4:5", "3:4", "2:3", "9:16",
  "4:1", "1:4", "8:1", "1:8",
] as const;

function normalizeNanoBananaAspectRatio(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed === "auto") return "auto";
  if ((NANO_BANANA_ASPECT_RATIOS as readonly string[]).includes(trimmed)) return trimmed;

  const parts = trimmed.split(":");
  let ratio: number | null = null;
  if (parts.length === 2) {
    const w = parseFloat(parts[0]);
    const h = parseFloat(parts[1]);
    if (w > 0 && h > 0) ratio = w / h;
  } else {
    const n = parseFloat(trimmed);
    if (n > 0) ratio = n;
  }
  if (ratio === null || !isFinite(ratio)) return null;

  let best = NANO_BANANA_ASPECT_RATIOS[0];
  let bestDiff = Infinity;
  for (const ar of NANO_BANANA_ASPECT_RATIOS) {
    const [w, h] = ar.split(":").map(Number);
    const diff = Math.abs(Math.log(ratio) - Math.log(w / h));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = ar;
    }
  }
  return best;
}

function pickGptImage2Size(res: string, aspectRatio: string | undefined): { width: number; height: number } {
  let w = 1, h = 1;
  if (aspectRatio) {
    const parts = aspectRatio.split(":").map(Number);
    if (parts[0] && parts[1]) { w = parts[0]; h = parts[1]; }
  }
  const ratio = w / h;
  const isSquare = Math.abs(ratio - 1) < 0.05;
  const longSide = res === "2k" ? 2560 : 1536;
  const squareSide = res === "2k" ? 2048 : 1024;
  if (isSquare) return { width: squareSide, height: squareSide };
  if (ratio > 1) {
    return { width: longSide, height: Math.round(longSide / ratio / 8) * 8 };
  }
  return { width: Math.round(longSide * ratio / 8) * 8, height: longSide };
}

const MODEL_MAP: Record<string, ModelConfig> = {
  "nano-banana-2-t2i": {
    falModelId: "fal-ai/nano-banana-2",
    type: "image",
    buildInput(params) {
      const normalizedAr = normalizeNanoBananaAspectRatio(params.aspect_ratio);
      const input: Record<string, unknown> = {
        prompt: params.prompt || "",
        num_images: params.imageNumber || 1,
        output_format: "png",
      };
      if (normalizedAr) {
        input.aspect_ratio = normalizedAr;
      }
      if (params.resolution) {
        const resStr = (params.resolution as string).toLowerCase();
        if (resStr === "1k") {
          const base = 1080;
          if (normalizedAr && normalizedAr !== "auto") {
            const [w, h] = normalizedAr.split(":").map(Number);
            if (w && h) {
              const ratio = w / h;
              input.image_size = {
                width: Math.round(ratio >= 1 ? base : base * ratio),
                height: Math.round(ratio >= 1 ? base / ratio : base),
              };
            } else {
              input.image_size = { width: base, height: base };
            }
          } else {
            input.image_size = { width: base, height: base };
          }
        } else {
          input.resolution = resStr.toUpperCase();
        }
      }
      return input;
    },
  },
  "nano-banana-2": {
    falModelId: "fal-ai/nano-banana-2/edit",
    type: "image",
    buildInput(params) {
      const normalizedAr = normalizeNanoBananaAspectRatio(params.aspect_ratio);
      const input: Record<string, unknown> = {
        prompt: params.prompt || "",
        num_images: params.imageNumber || 1,
        output_format: "png",
      };
      if (normalizedAr) {
        input.aspect_ratio = normalizedAr;
      }
      if (params.resolution) {
        const resStr = (params.resolution as string).toLowerCase();
        if (resStr === "1k") {
          const base = 1080;
          if (normalizedAr && normalizedAr !== "auto") {
            const [w, h] = normalizedAr.split(":").map(Number);
            if (w && h) {
              const ratio = w / h;
              input.image_size = {
                width: Math.round(ratio >= 1 ? base : base * ratio),
                height: Math.round(ratio >= 1 ? base / ratio : base),
              };
            } else {
              input.image_size = { width: base, height: base };
            }
          } else {
            input.image_size = { width: base, height: base };
          }
        } else {
          input.resolution = resStr.toUpperCase();
        }
      }
      if (params.referenceImageUrls && Array.isArray(params.referenceImageUrls)) {
        const cleaned = params.referenceImageUrls.map(sanitizeUrl).filter((u): u is string => !!u);
        if (cleaned.length > 0) {
          input.image_urls = cleaned;
        }
      }
      return input;
    },
  },
  "seedream-t2i": {
    falModelId: "fal-ai/bytedance/seedream/v4.5/text-to-image",
    type: "image",
    buildInput(params) {
      const input: Record<string, unknown> = {
        prompt: params.prompt || "",
        num_images: params.imageNumber || 1,
      };
      if (params.aspect_ratio) {
        const [w, h] = (params.aspect_ratio as string).split(":").map(Number);
        if (w && h) {
          const base = params.resolution === "4k" ? 3840 : params.resolution === "2k" ? 2048 : 1024;
          const ratio = w / h;
          const longEdge = base;
          const shortEdge = Math.round(longEdge / Math.max(ratio, 1 / ratio));
          const evenShort = shortEdge % 2 === 0 ? shortEdge : shortEdge + 1;
          const evenLong = longEdge % 2 === 0 ? longEdge : longEdge + 1;
          input.image_size = {
            width: ratio >= 1 ? evenLong : evenShort,
            height: ratio >= 1 ? evenShort : evenLong,
          };
        }
      }
      return input;
    },
  },
  "seedream-edit": {
    falModelId: "fal-ai/bytedance/seedream/v4.5/edit",
    type: "image",
    buildInput(params) {
      const input: Record<string, unknown> = {
        prompt: params.prompt || "",
        num_images: params.imageNumber || 1,
      };
      if (params.aspect_ratio) {
        const [w, h] = (params.aspect_ratio as string).split(":").map(Number);
        if (w && h) {
          const base = params.resolution === "4k" ? 3840 : params.resolution === "2k" ? 2048 : 1024;
          const ratio = w / h;
          const longEdge = base;
          const shortEdge = Math.round(longEdge / Math.max(ratio, 1 / ratio));
          const evenShort = shortEdge % 2 === 0 ? shortEdge : shortEdge + 1;
          const evenLong = longEdge % 2 === 0 ? longEdge : longEdge + 1;
          input.image_size = {
            width: ratio >= 1 ? evenLong : evenShort,
            height: ratio >= 1 ? evenShort : evenLong,
          };
        }
      }
      if (params.referenceImageUrls && Array.isArray(params.referenceImageUrls)) {
        const cleaned = params.referenceImageUrls.map(sanitizeUrl).filter(Boolean);
        if (cleaned.length > 0) {
          input.image_urls = cleaned;
        }
      }
      return input;
    },
  },
  "gpt-image-2-t2i": {
    falModelId: "fal-ai/gpt-image-2",
    type: "image",
    buildInput(params) {
      const quality = (params.quality as string) || "high";
      const res = ((params.resolution as string) || "1k").toLowerCase();
      const input: Record<string, unknown> = {
        prompt: params.prompt || "",
        num_images: params.imageNumber || 1,
        quality,
      };
      input.image_size = pickGptImage2Size(res, params.aspect_ratio as string | undefined);
      return input;
    },
  },
  "gpt-image-2-edit": {
    falModelId: "fal-ai/gpt-image-2/edit",
    type: "image",
    buildInput(params) {
      const quality = (params.quality as string) || "high";
      const res = ((params.resolution as string) || "1k").toLowerCase();
      const input: Record<string, unknown> = {
        prompt: params.prompt || "",
        num_images: params.imageNumber || 1,
        quality,
      };
      input.image_size = pickGptImage2Size(res, params.aspect_ratio as string | undefined);
      if (params.referenceImageUrls && Array.isArray(params.referenceImageUrls)) {
        const cleaned = params.referenceImageUrls.map(sanitizeUrl).filter((u): u is string => !!u);
        if (cleaned.length > 0) {
          input.image_urls = cleaned;
        }
      }
      return input;
    },
  },
  "kling-o3-pro-t2v": {
    falModelId: "fal-ai/kling-video/o3/pro/text-to-video",
    type: "video",
    buildInput(params) {
      const input: Record<string, unknown> = {
        prompt: params.prompt || "",
        duration: params.duration ? String(params.duration) : "5",
        negative_prompt: "blur, distort, and low quality",
      };
      if (params.aspect_ratio) {
        input.aspect_ratio = params.aspect_ratio;
      }
      input.generate_audio = params.generateAudio === true;
      return input;
    },
  },
  "kling-o3-pro-i2v": {
    falModelId: "fal-ai/kling-video/o3/pro/image-to-video",
    type: "video",
    buildInput(params) {
      const input: Record<string, unknown> = {
        prompt: params.prompt || "",
        duration: params.duration ? String(params.duration) : "5",
        negative_prompt: "blur, distort, and low quality",
      };
      // Per fal docs, this O3 endpoint uses `image_url` for the start frame
      // and `end_image_url` for the optional end frame. Unknown fields
      // (e.g. `tail_image_url`) are silently dropped, causing the end
      // frame to have no effect on the generated clip.
      const firstFrame = sanitizeUrl(params.firstFrameUrl);
      if (firstFrame) {
        input.image_url = firstFrame;
      }
      const lastFrame = sanitizeUrl(params.lastFrameUrl);
      if (lastFrame) {
        input.end_image_url = lastFrame;
      }
      if (lastFrame) {
        input.generate_audio = false;
      } else {
        input.generate_audio = params.generateAudio === true;
      }
      return input;
    },
  },
  "kling-o3-pro-r2v": {
    falModelId: "fal-ai/kling-video/o3/pro/reference-to-video",
    type: "video",
    buildInput(params) {
      const input: Record<string, unknown> = {
        prompt: params.prompt || "",
        duration: params.duration ? String(params.duration) : "5",
        negative_prompt: "blur, distort, and low quality",
      };
      if (params.aspect_ratio) {
        input.aspect_ratio = params.aspect_ratio;
      }
      // Kling O3 reference-to-video expects an `elements` array of OBJECTS
      // (not a flat `image_urls` array). Each element is a "subject" that
      // can be referenced in the prompt as @Element1, @Element2, etc. Per
      // fal validation, every element must contain BOTH `frontal_image_url`
      // and at least one `reference_image_urls` entry (or a `video_url`) —
      // omitting either trips: "either frontal image url and reference
      // image url or video url must be provided." Our UX gives users one
      // image per subject, so we use the same URL for both fields: the
      // image acts as the frontal view AND the only reference angle.
      // Cap at 4 elements to match Kling's prompt syntax limit
      // (@Element1..@Element4).
      if (params.referenceImageUrls && Array.isArray(params.referenceImageUrls)) {
        const cleaned = params.referenceImageUrls.map(sanitizeUrl).filter((u): u is string => !!u);
        if (cleaned.length > 0) {
          input.elements = cleaned.slice(0, 4).map((url) => ({
            frontal_image_url: url,
            reference_image_urls: [url],
          }));
        }
      }
      input.generate_audio = params.generateAudio === true;
      return input;
    },
  },
  "kling-o3-4k-t2v": {
    falModelId: "fal-ai/kling-video/o3/4k/text-to-video",
    type: "video",
    buildInput(params) {
      const input: Record<string, unknown> = {
        prompt: params.prompt || "",
        duration: params.duration ? String(params.duration) : "5",
        negative_prompt: "blur, distort, and low quality",
      };
      if (params.aspect_ratio) {
        input.aspect_ratio = params.aspect_ratio;
      }
      input.generate_audio = params.generateAudio === true;
      return input;
    },
  },
  "kling-o3-4k-i2v": {
    falModelId: "fal-ai/kling-video/o3/4k/image-to-video",
    type: "video",
    buildInput(params) {
      const input: Record<string, unknown> = {
        prompt: params.prompt || "",
        duration: params.duration ? String(params.duration) : "5",
        negative_prompt: "blur, distort, and low quality",
      };
      // Per fal docs: `image_url` (start frame, required), `end_image_url`
      // (end frame, optional). See kling-o3-pro-i2v for context.
      const firstFrame = sanitizeUrl(params.firstFrameUrl);
      if (firstFrame) {
        input.image_url = firstFrame;
      }
      const lastFrame = sanitizeUrl(params.lastFrameUrl);
      if (lastFrame) {
        input.end_image_url = lastFrame;
      }
      if (lastFrame) {
        input.generate_audio = false;
      } else {
        input.generate_audio = params.generateAudio === true;
      }
      return input;
    },
  },
  "kling-o3-4k-r2v": {
    falModelId: "fal-ai/kling-video/o3/4k/reference-to-video",
    type: "video",
    buildInput(params) {
      const input: Record<string, unknown> = {
        prompt: params.prompt || "",
        duration: params.duration ? String(params.duration) : "5",
        negative_prompt: "blur, distort, and low quality",
      };
      if (params.aspect_ratio) {
        input.aspect_ratio = params.aspect_ratio;
      }
      // Kling O3 reference-to-video expects an `elements` array of OBJECTS
      // (not a flat `image_urls` array). Each element is a "subject" that
      // can be referenced in the prompt as @Element1, @Element2, etc. Each
      // element MUST contain both `frontal_image_url` and at least one
      // `reference_image_urls` entry (or a `video_url`). With one image
      // per subject in our UX, we use the same URL for both fields.
      // See kling-o3-pro-r2v above for the full rationale.
      if (params.referenceImageUrls && Array.isArray(params.referenceImageUrls)) {
        const cleaned = params.referenceImageUrls.map(sanitizeUrl).filter((u): u is string => !!u);
        if (cleaned.length > 0) {
          input.elements = cleaned.slice(0, 4).map((url) => ({
            frontal_image_url: url,
            reference_image_urls: [url],
          }));
        }
      }
      input.generate_audio = params.generateAudio === true;
      return input;
    },
  },
  "seedance-2.0-t2v": {
    falModelId: "bytedance/seedance-2.0/text-to-video",
    type: "video",
    buildInput(params) {
      const input: Record<string, unknown> = {
        prompt: params.prompt || "",
        duration: normalizeSeedanceDuration(params.duration),
        resolution: normalizeSeedanceResolution(params.resolution),
        generate_audio: params.generateAudio === true,
      };
      if (params.aspect_ratio) {
        input.aspect_ratio = params.aspect_ratio;
      }
      if (params.end_user_id) {
        input.end_user_id = params.end_user_id;
      }
      return input;
    },
  },
  "seedance-2.0-i2v": {
    falModelId: "bytedance/seedance-2.0/image-to-video",
    type: "video",
    buildInput(params) {
      const input: Record<string, unknown> = {
        prompt: params.prompt || "",
        duration: normalizeSeedanceDuration(params.duration),
        resolution: normalizeSeedanceResolution(params.resolution),
        generate_audio: params.generateAudio === true,
      };
      if (params.aspect_ratio) {
        input.aspect_ratio = params.aspect_ratio;
      }
      const firstFrame = sanitizeUrl(params.firstFrameUrl);
      if (firstFrame) {
        input.image_url = firstFrame;
      }
      const lastFrame = sanitizeUrl(params.lastFrameUrl);
      if (lastFrame) {
        input.end_image_url = lastFrame;
      }
      if (params.end_user_id) {
        input.end_user_id = params.end_user_id;
      }
      return input;
    },
  },
  "seedance-2.0-r2v": {
    falModelId: "bytedance/seedance-2.0/reference-to-video",
    type: "video",
    async buildInput(params) {
      const input: Record<string, unknown> = {
        prompt: params.prompt || "",
        duration: normalizeSeedanceDuration(params.duration),
        resolution: normalizeSeedanceResolution(params.resolution),
      };
      if (params.aspect_ratio) {
        input.aspect_ratio = params.aspect_ratio;
      }
      if (params.referenceImageUrls && Array.isArray(params.referenceImageUrls)) {
        const cleaned = params.referenceImageUrls.map(sanitizeUrl).filter((u): u is string => !!u);
        if (cleaned.length > 0) {
          input.image_urls = cleaned.slice(0, 3);
        }
      }
      const videoUrl = sanitizeUrl(params.video_url);
      if (videoUrl) {
        input.video_url = videoUrl;
      }
      if (params.audio_url) {
        let audioUrl = params.audio_url as string;
        if (audioUrl.startsWith("data:")) {
          audioUrl = await ensureHostedUrl(audioUrl);
        }
        input.audio_url = audioUrl;
      }
      if (params.end_user_id) {
        input.end_user_id = params.end_user_id;
      }
      return input;
    },
  },
  "veo3.1-lite-t2v": {
    falModelId: "fal-ai/veo3.1/lite",
    type: "video",
    buildInput(params) {
      const dur = String(params.duration || "6").replace(/s$/, "");
      const input: Record<string, unknown> = {
        prompt: params.prompt || "",
        duration: `${dur}s`,
        generate_audio: params.generateAudio === true,
      };
      if (params.aspect_ratio) {
        input.aspect_ratio = params.aspect_ratio;
      }
      return input;
    },
  },
  "veo3.1-lite-i2v": {
    falModelId: "fal-ai/veo3.1/lite/image-to-video",
    type: "video",
    buildInput(params) {
      const dur = String(params.duration || "6").replace(/s$/, "");
      const input: Record<string, unknown> = {
        prompt: params.prompt || "",
        duration: `${dur}s`,
        generate_audio: params.generateAudio === true,
      };
      if (params.aspect_ratio) {
        input.aspect_ratio = params.aspect_ratio;
      }
      const firstFrame = sanitizeUrl(params.firstFrameUrl);
      if (firstFrame) {
        input.image_url = firstFrame;
      }
      return input;
    },
  },
  "veo3.1-lite-flf2v": {
    falModelId: "fal-ai/veo3.1/lite/first-last-frame-to-video",
    type: "video",
    buildInput(params) {
      const dur = String(params.duration || "6").replace(/s$/, "");
      const input: Record<string, unknown> = {
        prompt: params.prompt || "",
        duration: `${dur}s`,
        generate_audio: params.generateAudio === true,
      };
      if (params.aspect_ratio) {
        input.aspect_ratio = params.aspect_ratio;
      }
      const firstFrame = sanitizeUrl(params.firstFrameUrl);
      if (firstFrame) {
        input.first_frame_image = firstFrame;
      }
      const lastFrame = sanitizeUrl(params.lastFrameUrl);
      if (lastFrame) {
        input.last_frame_image = lastFrame;
      }
      return input;
    },
  },
  "seedvr-upscale": {
    falModelId: "fal-ai/seedvr/upscale/image",
    type: "image",
    buildInput(params) {
      const input: Record<string, unknown> = {
        upscale_mode: "factor",
        upscale_factor: params.upscale_factor || 2,
        noise_scale: 0.1,
        output_format: "png",
      };
      if (params.referenceImageUrls && Array.isArray(params.referenceImageUrls)) {
        const cleaned = params.referenceImageUrls.map(sanitizeUrl).filter((u): u is string => !!u);
        if (cleaned.length > 0) {
          input.image_url = cleaned[0];
        }
      }
      return input;
    },
  },
  // Topaz video upscale. UpscalePanel sends `upscale_factor` (1/2/4 derived
  // from the user's output-resolution tier choice) and `target_fps` (30 or
  // 60). The Topaz/Gaia 2 selection is encoded as the model key — both
  // dispatch to the same fal endpoint but with a different `model` field.
  "topaz-upscale-video": {
    falModelId: "fal-ai/topaz/upscale/video",
    type: "video",
    buildInput(params) {
      const input: Record<string, unknown> = {
        model: "Proteus",
      };
      const videoUrl = sanitizeUrl(params.video_url);
      if (videoUrl) input.video_url = videoUrl;
      const factor = Number(params.upscale_factor);
      if (Number.isFinite(factor) && factor > 0) {
        input.upscale_factor = Math.max(1, Math.min(4, factor));
      }
      const fps = Number(params.target_fps);
      if (Number.isFinite(fps) && fps > 0) {
        input.target_fps = Math.max(16, Math.min(60, Math.round(fps)));
      }
      return input;
    },
  },
  "topaz-upscale-video-gaia2": {
    falModelId: "fal-ai/topaz/upscale/video",
    type: "video",
    buildInput(params) {
      const input: Record<string, unknown> = {
        model: "Gaia 2",
      };
      const videoUrl = sanitizeUrl(params.video_url);
      if (videoUrl) input.video_url = videoUrl;
      const factor = Number(params.upscale_factor);
      if (Number.isFinite(factor) && factor > 0) {
        input.upscale_factor = Math.max(1, Math.min(4, factor));
      }
      const fps = Number(params.target_fps);
      if (Number.isFinite(fps) && fps > 0) {
        input.target_fps = Math.max(16, Math.min(60, Math.round(fps)));
      }
      return input;
    },
  },
  pixelcut_remove_bg: {
    falModelId: "pixelcut/background-removal",
    type: "image",
    buildInput(params) {
      const input: Record<string, unknown> = {};
      if (params.referenceImageUrls && Array.isArray(params.referenceImageUrls)) {
        const cleaned = params.referenceImageUrls.map(sanitizeUrl).filter((u): u is string => !!u);
        if (cleaned.length > 0) {
          input.image_url = cleaned[0];
        }
      }
      return input;
    },
  },
  remove_bg: {
    falModelId: "fal-ai/bria/background/remove",
    type: "image",
    buildInput(params) {
      const input: Record<string, unknown> = {};
      if (params.referenceImageUrls && Array.isArray(params.referenceImageUrls)) {
        const cleaned = params.referenceImageUrls.map(sanitizeUrl).filter((u): u is string => !!u);
        if (cleaned.length > 0) {
          input.image_url = cleaned[0];
        }
      }
      return input;
    },
  },
  "kling-3.0-mc": {
    falModelId: "fal-ai/kling-video/v3/pro/motion-control",
    type: "video",
    async buildInput(params) {
      const input: Record<string, unknown> = {};
      if (params.prompt && typeof params.prompt === "string" && params.prompt.trim()) {
        input.prompt = params.prompt.trim();
      }
      if (params.image_url) {
        input.image_url = await ensureHostedUrl(params.image_url as string);
      }
      if (params.video_url) {
        input.video_url = params.video_url;
      }
      if (params.character_orientation) {
        input.character_orientation = params.character_orientation;
      }
      if (params.keep_original_sound !== undefined) {
        input.keep_original_sound = params.keep_original_sound;
      }
      return input;
    },
  },
  "kling-2.6-mc": {
    falModelId: "fal-ai/kling-video/v2.6/pro/motion-control",
    type: "video",
    async buildInput(params) {
      const input: Record<string, unknown> = {};
      if (params.prompt && typeof params.prompt === "string" && params.prompt.trim()) {
        input.prompt = params.prompt.trim();
      }
      if (params.image_url) {
        input.image_url = await ensureHostedUrl(params.image_url as string);
      }
      if (params.video_url) {
        input.video_url = params.video_url;
      }
      if (params.character_orientation) {
        input.character_orientation = params.character_orientation;
      }
      if (params.keep_original_sound !== undefined) {
        input.keep_original_sound = params.keep_original_sound;
      }
      return input;
    },
  },
  "recraft-v4-vector": {
    falModelId: "fal-ai/recraft/v4/pro/text-to-vector",
    type: "svg",
    buildInput(params) {
      const input: Record<string, unknown> = {
        prompt: params.prompt || "",
      };
      if (params.image_size) {
        input.image_size = params.image_size;
      }
      if (params.colors && Array.isArray(params.colors) && params.colors.length > 0) {
        input.colors = params.colors;
      }
      return input;
    },
  },
  "recraft-vectorize": {
    falModelId: "fal-ai/recraft/vectorize",
    type: "svg",
    buildInput(params) {
      return {
        image_url: params.image_url || (params.referenceImageUrls && params.referenceImageUrls[0]) || "",
      };
    },
  },
  "minimax-tts": {
    falModelId: "fal-ai/minimax/speech-2.8-hd",
    type: "audio",
    buildInput(params) {
      const voiceId = (params.voice as string) || "Friendly_Person";
      const voiceSetting: Record<string, unknown> = {
        voice_id: voiceId,
        speed: params.speed ? Number(params.speed) : 1.0,
      };
      if (params.emotion && typeof params.emotion === "string" && params.emotion !== "neutral") {
        voiceSetting.emotion = params.emotion;
      }
      const input: Record<string, unknown> = {
        prompt: (params.text as string) || (params.prompt as string) || "",
        voice_setting: voiceSetting,
        output_format: "url",
      };
      const fmt = (params.outputFormat || params.output_format || "mp3") as string;
      if (fmt && fmt !== "mp3") {
        input.audio_setting = { format: fmt };
      }
      return input;
    },
  },
  "elevenlabs-voice-changer": {
    falModelId: "fal-ai/elevenlabs/voice-changer",
    type: "audio",
    async buildInput(params) {
      const stabilityMap: Record<string, number> = { low: 0.3, medium: 0.5, high: 0.8 };
      const similarityMap: Record<string, number> = { low: 0.3, medium: 0.5, high: 0.8 };
      let audioUrl = params.audio_url as string;
      if (audioUrl && audioUrl.startsWith("data:")) {
        audioUrl = await ensureHostedUrl(audioUrl);
      }
      const input: Record<string, unknown> = {
        audio_url: audioUrl,
        voice: (params.voice as string) || "Rachel",
      };
      if (params.stability && typeof params.stability === "string") {
        input.stability = stabilityMap[params.stability] ?? 0.5;
      }
      if (params.similarity_boost && typeof params.similarity_boost === "string") {
        input.similarity_boost = similarityMap[params.similarity_boost] ?? 0.5;
      }
      if (params.output_format) {
        input.output_format = params.output_format;
      }
      return input;
    },
  },
  "elevenlabs-sfx": {
    falModelId: "fal-ai/elevenlabs/sound-effects/v2",
    type: "audio",
    buildInput(params) {
      const input: Record<string, unknown> = {
        text: (params.prompt as string) || "",
      };
      if (params.duration_seconds !== undefined) {
        input.duration_seconds = Number(params.duration_seconds);
      }
      if (params.prompt_influence !== undefined) {
        input.prompt_influence = Number(params.prompt_influence);
      }
      return input;
    },
  },
  "minimax-music": {
    falModelId: "fal-ai/minimax-music/v2.6",
    type: "audio",
    buildInput(params) {
      const input: Record<string, unknown> = {
        prompt: (params.prompt as string) || "",
      };
      if (params.lyrics) {
        input.lyrics = params.lyrics as string;
      }
      if (params.is_instrumental !== undefined) {
        input.is_instrumental = Boolean(params.is_instrumental);
      }
      return input;
    },
  },
  bria_expand: {
    falModelId: "fal-ai/bria/expand",
    type: "image",
    async buildInput(params) {
      const input: Record<string, unknown> = {};
      let imageBlob: Blob | null = null;
      let imgW = 1024, imgH = 1024;

      if (params.referenceImageUrls && Array.isArray(params.referenceImageUrls)) {
        const cleaned = params.referenceImageUrls.map(sanitizeUrl).filter((u): u is string => !!u);
        if (cleaned.length > 0) {
          let imageUrl = cleaned[0];
          try {
            const resp = await fetch(imageUrl);
            if (resp.ok) {
              imageBlob = await resp.blob();
              if (!imageUrl.includes("fal.media") && !imageUrl.startsWith("data:")) {
                const file = new File([imageBlob], "input.png", { type: imageBlob.type || "image/png" });
                const uploaded = await fal.storage.upload(file);
                imageUrl = uploaded;
              }
            }
          } catch (e) {
            console.error("[fal.ai] Failed to fetch/upload image for resize:", e);
          }
          input.image_url = imageUrl;

          if (imageBlob) {
            try {
              const buf = Buffer.from(await imageBlob.arrayBuffer());
              const dims = parseImageDimensions(buf);
              if (dims) { imgW = dims.width; imgH = dims.height; }
            } catch { /* fallback to defaults */ }
          }
        }
      }

      const arStr = (params.aspect_ratio as string) || "1:1";
      const [aw, ah] = arStr.split(":").map(Number);
      const targetRatio = (aw && ah) ? aw / ah : 1;
      const srcRatio = imgW / imgH;

      let canvasW: number, canvasH: number;
      if (targetRatio > srcRatio) {
        canvasW = Math.round(imgH * targetRatio);
        canvasH = imgH;
      } else {
        canvasW = imgW;
        canvasH = Math.round(imgW / targetRatio);
      }
      const maxDim = 5000;
      if (canvasW > maxDim || canvasH > maxDim) {
        const scale = maxDim / Math.max(canvasW, canvasH);
        canvasW = Math.round(canvasW * scale);
        canvasH = Math.round(canvasH * scale);
      }

      input.canvas_size = [canvasW, canvasH];
      input.original_image_size = [imgW, imgH];
      const ox = Math.round((canvasW - imgW) / 2);
      const oy = Math.round((canvasH - imgH) / 2);
      input.original_image_location = [ox, oy];

      if (params.prompt && typeof params.prompt === "string" && params.prompt.trim()) {
        input.prompt = params.prompt.trim();
      }
      return input;
    },
  },
};

export function getModelConfig(modelName: string): ModelConfig | undefined {
  return MODEL_MAP[modelName];
}

/** Enumerate the available generation models (key + media type) for the MCP
 *  `list_models` tool. Internal fal ids and buildInput closures are not exposed. */
export function listAvailableModels(): { key: string; type: ModelConfig["type"] }[] {
  return Object.entries(MODEL_MAP).map(([key, cfg]) => ({ key, type: cfg.type }));
}

const TYPE_ALLOWED_MODELS: Record<string, string[]> = {
  text_to_image: ["nano-banana-2-t2i", "seedream-t2i", "gpt-image-2-t2i"],
  image_to_image: ["nano-banana-2", "seedream-edit", "gpt-image-2-edit"],
  video_gen: ["kling-o3-pro-t2v", "kling-o3-pro-i2v", "kling-o3-pro-r2v", "kling-o3-4k-t2v", "kling-o3-4k-i2v", "kling-o3-4k-r2v", "veo3.1-lite-t2v", "veo3.1-lite-i2v", "veo3.1-lite-flf2v", "seedance-2.0-t2v", "seedance-2.0-i2v", "seedance-2.0-r2v"],
  remove_bg: ["pixelcut_remove_bg", "remove_bg"],
  resize: ["bria_expand"],
  upscale: ["seedvr-upscale", "topaz-upscale-video", "topaz-upscale-video-gaia2"],
  avatar: ["kling-3.0-mc", "kling-2.6-mc"],
  text_to_vector: ["recraft-v4-vector"],
  image_to_vector: ["recraft-vectorize"],
  audio_music: ["minimax-music"],
  audio_tts: ["minimax-tts"],
  audio_sfx: ["elevenlabs-sfx"],
  audio_voice_changer: ["elevenlabs-voice-changer"],
  clearcheck: ["clearcheck"],
};

export function resolveModelName(type: string, modelParam?: string): string | null {
  const allowed = TYPE_ALLOWED_MODELS[type];
  if (!allowed) return null;
  if (modelParam && allowed.includes(modelParam)) return modelParam;
  return allowed[0];
}

async function refundJobCredits(jobId: string, reason: string): Promise<void> {
  try {
    const jobResult = await pool.query(
      `SELECT user_id, credits_charged, workspace_id FROM jobs WHERE id = $1`,
      [jobId]
    );
    if (jobResult.rows.length > 0) {
      const { user_id, credits_charged, workspace_id } = jobResult.rows[0];
      if (credits_charged > 0) {
        await refundCreditsWithFallback(user_id, credits_charged, reason, jobId, workspace_id || undefined);
      }
    }
  } catch (err) {
    console.error(`[fal.ai] Failed to refund credits for job ${jobId}:`, err);
  }
}

// In-process registry of jobs whose poll loop is currently active. Used by the
// SSE-connect listener to avoid double-resuming a job that's already polling.
const activePolls = new Set<string>();

export function isPollingJob(jobId: string): boolean {
  return activePolls.has(jobId);
}

let hasListenersFn: (() => boolean) | null = null;
export function setFalListenersChecker(fn: (() => boolean) | null): void {
  hasListenersFn = fn;
}

// When called with hasListeners() returning false, the poll loop slows its
// cadence to a low-frequency idle interval (after a 60s grace window) so
// jobs still finish in-process even when no SSE client is connected. The
// loop never aborts on listener absence — it's only bounded by the outer
// maxPollTimeMs guard. cleanupStaleGenerations / resumeFalPolling still
// cover cold-start recovery for jobs that genuinely outlive the timeout.
function unrefSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (t && typeof t.unref === "function") t.unref();
  });
}

async function pollFalUntilComplete(
  falModelId: string,
  requestId: string,
  jobId: string,
  pollIntervalMs = 2000,
  maxPollTimeMs = 10 * 60 * 1000,
  hasListeners?: () => boolean
): Promise<void> {
  activePolls.add(jobId);
  try {
    const start = Date.now();
    while (Date.now() - start < maxPollTimeMs) {
      const jobStatus = await pool.query(`SELECT status FROM jobs WHERE id = $1`, [jobId]);
      if (jobStatus.rows.length > 0 && jobStatus.rows[0].status === 'cancelled') {
        try { await fal.queue.cancel(falModelId, { requestId }); } catch {}
        throw new Error("Job cancelled during polling");
      }

      let status: { status: string };
      try {
        status = await fal.queue.status(falModelId, { requestId, logs: false });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isDefinitivelyGone = msg.includes("not found") || msg.includes("404") || msg.includes("invalid") || msg.includes("expired");
        if (isDefinitivelyGone) {
          throw new Error(`fal.ai request not found or expired: ${msg}`);
        }
        console.warn(`[fal.ai] Transient status check error for ${jobId}, will retry: ${msg}`);
        await unrefSleep(pollIntervalMs);
        continue;
      }

      if (status.status === "COMPLETED") {
        return;
      }
      if (status.status !== "IN_QUEUE" && status.status !== "IN_PROGRESS") {
        throw new Error(`fal.ai job ended with terminal status: ${status.status}`);
      }

      // Listener-aware pacing: keep polling at the fast interval whenever a
      // client is connected (so results land instantly), and back off to a
      // slow interval when nobody is watching. The previous behaviour aborted
      // the poll loop entirely on the very first iteration with no listeners,
      // which left jobs stuck in 'processing' until the next SSE reconnect or
      // cold start — even when fal had already completed seconds later. The
      // tail of any long-running job (>10 min) is still bounded by the
      // outer maxPollTimeMs guard, so this can't run forever.
      const elapsed = Date.now() - start;
      const POLL_GRACE_MS = 60_000;
      const SLOW_POLL_MS = 15_000;
      const listenersConnected = !hasListeners || hasListeners();
      let nextSleepMs = pollIntervalMs;
      if (!listenersConnected && elapsed > POLL_GRACE_MS) {
        nextSleepMs = SLOW_POLL_MS;
      }
      await unrefSleep(nextSleepMs);
    }
    throw new Error("Generation timed out waiting for fal.ai result");
  } finally {
    activePolls.delete(jobId);
  }
}

export async function handleFalResult(
  jobId: string,
  modelName: string,
  falRequestId: string
): Promise<"completed" | "running" | "dead"> {
  const config = MODEL_MAP[modelName];
  if (!config) return "dead";

  let status: { status: string };
  try {
    status = await fal.queue.status(config.falModelId, { requestId: falRequestId, logs: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isDefinitivelyGone = msg.includes("not found") || msg.includes("404") || msg.includes("invalid") || msg.includes("expired");
    if (isDefinitivelyGone) {
      console.log(`[fal.ai] handleFalResult: job ${jobId} request definitively gone: ${msg}`);
      return "dead";
    }
    console.log(`[fal.ai] handleFalResult: transient error checking job ${jobId}, treating as still running: ${msg}`);
    return "running";
  }

  if (status.status === "IN_QUEUE" || status.status === "IN_PROGRESS") {
    return "running";
  }

  if (status.status !== "COMPLETED") {
    return "dead";
  }

  try {
    const result = await fal.queue.result(config.falModelId, { requestId: falRequestId });
    const data = result.data as Record<string, unknown>;

    let resultUrl: string | null = null;
    let svgContent: string | null = null;

    if (config.type === "image" || config.type === "svg") {
      const images = data.images as Array<{ url: string }> | undefined;
      if (images && images.length > 0) resultUrl = images[0].url;
      if (!resultUrl) {
        const image = data.image as { url: string } | undefined;
        if (image?.url) resultUrl = image.url;
      }
      if (config.type === "svg" && resultUrl) {
        try {
          const svgResp = await fetch(resultUrl);
          const contentType = svgResp.headers.get("content-type") || "";
          const text = await svgResp.text();
          if (contentType.includes("svg") || text.trimStart().startsWith("<svg") || text.trimStart().startsWith("<?xml")) {
            svgContent = text;
          }
        } catch {}
      }
    } else if (config.type === "video") {
      const video = data.video as { url: string } | undefined;
      if (video) resultUrl = video.url;
    } else if (config.type === "audio") {
      const audio = data.audio as { url: string } | undefined;
      if (audio?.url) resultUrl = audio.url;
    }

    if (!resultUrl && data.url) resultUrl = data.url as string;

    const jobMetadata: Record<string, unknown> = config.type === 'svg' ? { asset_type: 'svg' } : {};
    if (svgContent) jobMetadata.svg_content = svgContent;

    const originalFalUrl = resultUrl;
    resultUrl = await rehostFalResultToR2(resultUrl, jobId, config.type);
    if (originalFalUrl && resultUrl !== originalFalUrl) {
      jobMetadata.fal_result_url = originalFalUrl;
    }

    await pool.query(
      `UPDATE jobs SET status = 'complete', result_url = $2, metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb, updated_at = NOW()
       WHERE id = $1 AND status NOT IN ('complete', 'failed', 'cancelled')`,
      [jobId, resultUrl, JSON.stringify(jobMetadata)]
    );

    console.log(`[fal.ai] Recovery: Job ${jobId} completed with result_url=${resultUrl ? 'yes' : 'no'}`);
    return "completed";
  } catch (err) {
    console.error(`[fal.ai] Recovery: Failed to fetch result for job ${jobId}:`, err);
    return "dead";
  }
}

export async function resumeFalPolling(
  jobId: string,
  modelName: string,
  falRequestId: string
): Promise<void> {
  const config = MODEL_MAP[modelName];
  if (!config) return;

  try {
    await pollFalUntilComplete(config.falModelId, falRequestId, jobId, 2000, 10 * 60 * 1000, hasListenersFn ?? undefined);
    const result = await fal.queue.result(config.falModelId, { requestId: falRequestId });
    const data = result.data as Record<string, unknown>;

    let resultUrl: string | null = null;
    let svgContent: string | null = null;

    if (config.type === "image" || config.type === "svg") {
      const images = data.images as Array<{ url: string }> | undefined;
      if (images && images.length > 0) resultUrl = images[0].url;
      if (!resultUrl) {
        const image = data.image as { url: string } | undefined;
        if (image?.url) resultUrl = image.url;
      }
      if (config.type === "svg" && resultUrl) {
        try {
          const svgResp = await fetch(resultUrl);
          const contentType = svgResp.headers.get("content-type") || "";
          const text = await svgResp.text();
          if (contentType.includes("svg") || text.trimStart().startsWith("<svg") || text.trimStart().startsWith("<?xml")) {
            svgContent = text;
          }
        } catch {}
      }
    } else if (config.type === "video") {
      const video = data.video as { url: string } | undefined;
      if (video) resultUrl = video.url;
    } else if (config.type === "audio") {
      const audio = data.audio as { url: string } | undefined;
      if (audio?.url) resultUrl = audio.url;
    }

    if (!resultUrl && data.url) resultUrl = data.url as string;

    const jobMetadata: Record<string, unknown> = config.type === 'svg' ? { asset_type: 'svg' } : {};
    if (svgContent) jobMetadata.svg_content = svgContent;

    const originalFalUrl = resultUrl;
    resultUrl = await rehostFalResultToR2(resultUrl, jobId, config.type);
    if (originalFalUrl && resultUrl !== originalFalUrl) {
      jobMetadata.fal_result_url = originalFalUrl;
    }

    await pool.query(
      `UPDATE jobs SET status = 'complete', result_url = $2, metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb, updated_at = NOW()
       WHERE id = $1 AND status NOT IN ('complete', 'failed', 'cancelled')`,
      [jobId, resultUrl, JSON.stringify(jobMetadata)]
    );
    console.log(`[fal.ai] Resumed polling: Job ${jobId} completed`);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[fal.ai] Resumed polling failed for job ${jobId}:`, errorMsg);

    const isFalTerminal = errorMsg.includes("not found") || errorMsg.includes("expired")
      || errorMsg.includes("404") || errorMsg.includes("invalid")
      || errorMsg.includes("ended with terminal status");

    if (isFalTerminal) {
      const failResult = await pool.query(
        `UPDATE jobs SET status = 'failed', error = $2, error_type = 'fal_confirmed_failure', updated_at = NOW()
         WHERE id = $1 AND status NOT IN ('complete', 'failed', 'cancelled')
         RETURNING id`,
        [jobId, `Generation failed: ${errorMsg}`.slice(0, 500)]
      );
      if (failResult.rows.length > 0) {
        await refundJobCredits(jobId, "fal_confirmed_failure");
      }
    } else {
      console.log(`[fal.ai] Job ${jobId} poll ended without fal-confirmed failure — keeping recoverable`);
      await pool.query(
        `UPDATE jobs SET updated_at = NOW() WHERE id = $1 AND status = 'processing'`,
        [jobId]
      );
    }
  }
}

export async function dispatchToFal(
  jobId: string,
  modelName: string,
  params: Record<string, unknown>
): Promise<void> {
  const config = MODEL_MAP[modelName];
  if (!config) {
    await pool.query(
      `UPDATE jobs SET status = 'failed', error = $2, updated_at = NOW() WHERE id = $1`,
      [jobId, `Unknown model: ${modelName}`]
    );
    await refundJobCredits(jobId, "generation_failed_unknown_model");
    return;
  }

  if (!ensureFalConfigured()) {
    await pool.query(
      `UPDATE jobs SET status = 'failed', error = 'No fal.ai API key configured. Add your key in Settings.', updated_at = NOW() WHERE id = $1`,
      [jobId]
    );
    await refundJobCredits(jobId, "generation_failed_no_key");
    return;
  }

  try {
    const startCheck = await pool.query(
      `UPDATE jobs SET status = 'processing', updated_at = NOW() WHERE id = $1 AND status IN ('pending', 'queued') RETURNING id`,
      [jobId]
    );
    if (startCheck.rows.length === 0) {
      const currentStatus = await pool.query(`SELECT status FROM jobs WHERE id = $1`, [jobId]);
      if (currentStatus.rows.length > 0 && currentStatus.rows[0].status === 'cancelled') {
        console.log(`[fal.ai] Job ${jobId} was cancelled before dispatch, skipping.`);
        return;
      }
    }
    // Local references (files on the user's disk, served over loopback) are not
    // reachable by fal.ai's servers — upload them to fal.storage first. No-op in
    // cloud mode. Must run before buildInput so every model sees fal URLs.
    await makeReferencesFalReachable(params);
    const input = await config.buildInput(params);
    console.log(`[fal.ai] Job ${jobId} model=${modelName} input=`, JSON.stringify(input));
    const submitResult = await fal.queue.submit(config.falModelId, {
      input,
    });
    const falRequestId = submitResult.request_id;
    console.log(`[fal.ai] Job ${jobId} submitted to queue, request_id=${falRequestId}`);

    await pool.query(
      `UPDATE jobs SET fal_request_id = $2, updated_at = NOW() WHERE id = $1`,
      [jobId, falRequestId]
    );

    await pollFalUntilComplete(config.falModelId, falRequestId, jobId, 2000, 10 * 60 * 1000, hasListenersFn ?? undefined);

    const result = await fal.queue.result(config.falModelId, { requestId: falRequestId });
    const data = result.data as Record<string, unknown>;
    console.log(`[fal.ai] Job ${jobId} raw response keys:`, Object.keys(data), JSON.stringify(data).slice(0, 500));
    let resultUrl: string | null = null;

    let svgContent: string | null = null;

    if (config.type === "image" || config.type === "svg") {
      const images = data.images as Array<{ url: string }> | undefined;
      if (images && images.length > 0) {
        resultUrl = images[0].url;
      }
      if (!resultUrl) {
        const image = data.image as { url: string } | undefined;
        if (image?.url) {
          resultUrl = image.url;
        }
      }
      if (config.type === "svg" && resultUrl) {
        try {
          const svgResp = await fetch(resultUrl);
          const contentType = svgResp.headers.get("content-type") || "";
          const text = await svgResp.text();
          if (contentType.includes("svg") || text.trimStart().startsWith("<svg") || text.trimStart().startsWith("<?xml")) {
            svgContent = text;
          }
        } catch (svgErr) {
          console.error(`[fal.ai] Failed to fetch SVG content for job ${jobId}:`, svgErr);
        }
      }
    } else if (config.type === "video") {
      const video = data.video as { url: string } | undefined;
      if (video) {
        resultUrl = video.url;
      }
    } else if (config.type === "audio") {
      const audio = data.audio as { url: string } | undefined;
      if (audio?.url) {
        resultUrl = audio.url;
      }
    }

    if (!resultUrl && data.url) {
      resultUrl = data.url as string;
    }

    const jobCheck = await pool.query(
      `SELECT status, user_id FROM jobs WHERE id = $1`,
      [jobId]
    );
    const wasCancelled = jobCheck.rows.length > 0 && jobCheck.rows[0].status === 'cancelled';

    const jobMetadata: Record<string, unknown> = config.type === 'svg' ? { asset_type: 'svg' } : {};
    if (svgContent) jobMetadata.svg_content = svgContent;

    // Re-host the fal.media result onto our own R2 bucket so the URL is durable
    // (fal CDN URLs expire) and so the asset is reachable from our network when
    // selected as a reference for a follow-up generation.
    const originalFalUrl = resultUrl;
    resultUrl = await rehostFalResultToR2(resultUrl, jobId, config.type);
    if (originalFalUrl && resultUrl !== originalFalUrl) {
      jobMetadata.fal_result_url = originalFalUrl;
    }

    if (wasCancelled && resultUrl) {
      const userId = jobCheck.rows[0].user_id;
      await pool.query(
        `INSERT INTO assets (user_id, type, source, name, file_url, metadata, deleted_at)
         VALUES ($1, $2, 'platform', $3, $4, $5, NOW())`,
        [
          userId,
          config.type === 'svg' ? 'vector' : config.type === 'video' ? 'video' : config.type === 'audio' ? 'audio' : 'image',
          `Cancelled generation ${jobId}`,
          resultUrl,
          JSON.stringify({ job_id: jobId, cancelled: true, ...jobMetadata }),
        ]
      );
      await pool.query(
        `UPDATE jobs SET result_url = $2, metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb, updated_at = NOW() WHERE id = $1`,
        [jobId, resultUrl, JSON.stringify(jobMetadata)]
      );
    } else {
      const updated = await pool.query(
        `UPDATE jobs SET status = 'complete', result_url = $2, metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb, updated_at = NOW() WHERE id = $1 RETURNING user_id`,
        [jobId, resultUrl, JSON.stringify(jobMetadata)]
      );
      console.log(`[fal.ai] Job ${jobId} marked complete, result_url=${resultUrl ? 'set' : 'MISSING'} (rows=${updated.rowCount})`);
      // Safety-net notification so the user always learns the job finished
      // even if the inline polling in the chat / canvas card silently misses
      // the transition (page reload, network blip, message removed from
      // local state, etc.). The notification is informational only —
      // primary delivery is still the inline card via /api/job polling.
      if (resultUrl && updated.rows.length > 0) {
        const userId = updated.rows[0].user_id;
        const kindLabel =
          config.type === "video" ? "Video"
          : config.type === "audio" ? "Audio"
          : config.type === "svg" ? "Vector"
          : "Image";
        createNotification({
          userId,
          type: "generation_complete",
          title: `${kindLabel} ready`,
          message: `Your ${kindLabel.toLowerCase()} generation finished.`,
          severity: "info",
          metadata: { job_id: jobId, result_url: resultUrl, model: modelName, kind: config.type },
        });
      }
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const errBody = (err as any)?.body ?? (err as any)?.detail ?? (err as any)?.response ?? null;
    console.error(`[fal.ai] Dispatch failed for job ${jobId}:`, errorMsg);
    if (errBody) console.error(`[fal.ai] Error details:`, JSON.stringify(errBody, null, 2));

    const failCheck = await pool.query(`SELECT status, user_id, fal_request_id FROM jobs WHERE id = $1`, [jobId]);
    if (failCheck.rows.length > 0 && failCheck.rows[0].status === 'cancelled') {
      return;
    }

    const hasFalRequestId = failCheck.rows.length > 0 && failCheck.rows[0].fal_request_id;
    const isLocalTimeout = errorMsg.includes("timed out waiting for fal.ai result");

    if (hasFalRequestId && isLocalTimeout) {
      console.log(`[fal.ai] Job ${jobId} poll timed out but has fal_request_id — keeping recoverable for startup re-poll`);
      await pool.query(
        `UPDATE jobs SET updated_at = NOW() WHERE id = $1 AND status = 'processing'`,
        [jobId]
      );
      return;
    }

    // Reference input failures (couldn't host the user-supplied data URL,
    // SSRF-blocked URL, etc.) get their own error_type so the client and
    // notification layer can render a "fix the reference and try again"
    // affordance instead of the generic fal failure copy.
    if (err instanceof ReferenceInputError) {
      await pool.query(
        `UPDATE jobs SET status = 'failed', error = $2, error_type = $3, updated_at = NOW() WHERE id = $1`,
        [jobId, err.message.slice(0, 500), err.error_code]
      );
      await refundJobCredits(jobId, "reference_input_failed");
      if (failCheck.rows.length > 0) {
        const userId = failCheck.rows[0].user_id;
        createNotification({
          userId,
          type: "fal_error",
          title: "Reference can't be used",
          message: err.message,
          severity: "warn",
          metadata: { job_id: jobId, error_type: err.error_code },
        });
      }
      return;
    }

    const parsed = parseFalError(err);
    const friendlyError = `${parsed.errorTitle}: ${parsed.errorMessage}`;

    await pool.query(
      `UPDATE jobs SET status = 'failed', error = $2, error_type = $3, error_detail = $4, updated_at = NOW() WHERE id = $1`,
      [jobId, friendlyError.slice(0, 500), parsed.errorType, parsed.errorDetail ? JSON.stringify(parsed.errorDetail) : null]
    );

    await refundJobCredits(jobId, "generation_failed");

    if (failCheck.rows.length > 0) {
      const userId = failCheck.rows[0].user_id;
      createNotification({
        userId,
        type: "fal_error",
        title: parsed.errorTitle,
        message: parsed.errorMessage,
        severity: parsed.severity,
        metadata: { job_id: jobId, error_type: parsed.errorType, ...(parsed.errorDetail || {}) },
      });
    }
  }
}
