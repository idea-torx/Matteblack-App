import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { resolveUploadPath } from "./uploadPath.js";

/** Explicit [] clears; omitted references keep the session's existing set. */
export function sessionReferences(sessionDir: string, files: unknown, attachmentDir: string): string[] {
  const manifest = path.join(sessionDir, "references.json");
  const reading = files === undefined;
  if (reading) {
    if (!fs.existsSync(manifest)) return [];
    files = JSON.parse(fs.readFileSync(manifest, "utf8"));
  }
  if (!Array.isArray(files) || files.length > 16 || files.some((f) => typeof f !== "string")) {
    throw new Error("references must be an array of up to 16 staged image paths; [] clears the saved set.");
  }
  const root = files.length ? fs.realpathSync(attachmentDir) : "";
  const paths = files.map((f) => {
    const real = fs.realpathSync(f);
    if (!real.startsWith(root + path.sep) || !/\.(png|jpg|jpeg|webp|gif)$/i.test(real)) {
      throw new Error("References must be staged image files from the attached references.");
    }
    return real;
  });
  if (reading) return paths;
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(manifest + ".tmp", JSON.stringify(paths));
  fs.renameSync(manifest + ".tmp", manifest);
  return paths;
}

const EXT_FOR_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

/** Labels follow file identity when references are reordered or replaced. */
export function sessionReferenceLabels(sessionDir: string, files: string[], labels?: unknown): string[] {
  const manifest = path.join(sessionDir, "reference-labels.json");
  if (labels !== undefined && (!Array.isArray(labels) || labels.length !== files.length || labels.some((s) => typeof s !== "string" || s.length > 80))) {
    throw new Error("referenceLabels must contain one label (up to 80 characters) per reference; use an empty string for unlabeled.");
  }
  const previous: Record<string, string> = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, "utf8")) : {};
  const next = Object.fromEntries(files.map((file, i) => [file, labels === undefined ? previous[file] ?? "" : (labels as string[])[i].trim()]));
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(manifest + ".tmp", JSON.stringify(next));
  fs.renameSync(manifest + ".tmp", manifest);
  return files.map((file) => next[file]);
}

/**
 * Copy the turn's reference images into the operator's working directory and
 * return their paths.
 *
 * The operator runs as a `claude -p` subprocess, so there is no message array to
 * push vision blocks onto — the only way it can actually SEE an attachment is to
 * Read the file. Without this it got a text note saying images were attached and
 * nothing else, and correctly reported that it couldn't see them.
 *
 * Content-addressed files survive later turns and are safe to reference from
 * a saved Blender session. Identical attachments reuse the same file.
 */
export async function stageAttachments(urls: string[], dir: string, uploadsDir: string): Promise<string[]> {
  const paths: string[] = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      let bytes: Buffer;
      let ext: string;
      const local = resolveUploadPath(url, uploadsDir);
      if (local) {
        bytes = fs.readFileSync(local.path);
        ext = EXT_FOR_MIME[local.mime] || ".png";
      } else if (/^https?:\/\//i.test(url)) {
        const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        if (!r.ok) continue;
        bytes = Buffer.from(await r.arrayBuffer());
        ext = EXT_FOR_MIME[(r.headers.get("content-type") || "").split(";")[0].trim()] || ".png";
      } else if (url.startsWith("data:image/")) {
        const m = url.match(/^data:([^;]+);base64,(.+)$/);
        if (!m) continue;
        bytes = Buffer.from(m[2], "base64");
        ext = EXT_FOR_MIME[m[1]] || ".png";
      } else {
        continue;
      }
      fs.mkdirSync(dir, { recursive: true });
      const full = path.join(dir, `reference-${createHash("sha256").update(bytes).digest("hex")}${ext}`);
      fs.writeFileSync(full, bytes);
      paths.push(fs.realpathSync(full));
    } catch {
      /* one bad attachment must not fail the turn */
    }
  }
  return paths;
}
