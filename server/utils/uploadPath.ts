/**
 * Mapping a `/uploads/...` URL back to the file on disk, for inlining locally
 * served images as Anthropic vision blocks.
 *
 * Split out of agent.ts purely so the traversal guard is testable — see
 * uploadPath.test.ts. Same shape as localPath.ts next door.
 */
import path from "node:path";

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export type ResolvedUpload = { path: string; mime: string };

/**
 * The `/uploads/...` -> confined on-disk path, with NO opinion about file type.
 *
 * Split out from resolveUploadPath because the traversal guard is reusable and
 * the image-MIME gate is not: video tail extraction needs the same resolution
 * for .mp4, and routing it through the image-gated function returned null and
 * looked like a missing file. Keep the type check in the caller that needs one.
 */
export function resolveUploadFile(url: string, uploadsDir: string): string | null {
  if (typeof url !== "string" || !url.startsWith("/uploads/")) return null;
  let rel: string;
  try {
    rel = decodeURIComponent(url.slice("/uploads/".length).split("?")[0]);
  } catch {
    return null;
  }
  if (!rel) return null;
  // Resolve BEFORE confining — `..` must be normalised away first or the
  // prefix check below is one segment away from useless.
  const full = path.resolve(uploadsDir, rel);
  if (full !== uploadsDir && !full.startsWith(uploadsDir + path.sep)) return null;
  return full;
}

export function resolveUploadPath(url: string, uploadsDir: string): ResolvedUpload | null {
  const full = resolveUploadFile(url, uploadsDir);
  if (!full) return null;
  const mime = IMAGE_MIME[path.extname(full).toLowerCase()];
  if (!mime) return null;
  return { path: full, mime };
}
