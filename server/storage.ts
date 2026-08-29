import type { S3Client } from "@aws-sdk/client-s3";
import { createRequire } from "node:module";
import mime from "mime-types";
import path from "path";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import { promises as dns } from "node:dns";
import net from "node:net";
import { LOCAL_MODE, UPLOADS_DIR } from "./config/runtime.js";

// ---------------------------------------------------------------------------
// Backend selection
//
// LOCAL_MODE  -> files live on local disk under UPLOADS_DIR and are served by
//                the Express app at the "/uploads/<bucket>/<path>" route. No
//                cloud credentials required.
// cloud       -> Cloudflare R2 (S3-compatible), configured via R2_* env vars.
//
// All exported functions keep identical signatures across both backends so no
// call site needs to change.
// ---------------------------------------------------------------------------

const R2_REQUIRED_VARS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_PUBLIC_URL"] as const;

// Type-only import of S3Client above (erased at build) + a lazy require of the
// whole @aws-sdk/client-s3 module here. In LOCAL_MODE storage is local disk and
// none of this runs, so the (heavy) AWS SDK is never loaded and can be dropped
// from the desktop bundle. `nodeRequire` is renamed so esbuild leaves it as a
// real runtime require of an external package.
const nodeRequire = createRequire(import.meta.url);
type AwsS3Module = typeof import("@aws-sdk/client-s3");
let _awsMod: AwsS3Module | null = null;
function aws(): AwsS3Module {
  if (!_awsMod) _awsMod = nodeRequire("@aws-sdk/client-s3") as AwsS3Module;
  return _awsMod;
}

let s3: S3Client | null = null;
let R2_BUCKET_NAME = "";
let R2_PUBLIC_URL = "";

if (!LOCAL_MODE) {
  const missing = R2_REQUIRED_VARS.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required R2 environment variables: ${missing.join(", ")}. Set these in your environment, or run with LOCAL_MODE=true to use local disk storage.`);
  }
  const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID!;
  R2_BUCKET_NAME = process.env.R2_BUCKET_NAME!;
  R2_PUBLIC_URL = process.env.R2_PUBLIC_URL!.replace(/\/$/, "");
  s3 = new (aws().S3Client)({
    region: "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
}

// --- local-disk helpers ----------------------------------------------------

function localPathFor(bucket: string, filePath: string): string {
  // Guard against path traversal from user-supplied bucket / path segments.
  const rel = path.posix.join(bucket, filePath).replace(/^\/+/, "");
  const full = path.resolve(UPLOADS_DIR, rel);
  const root = path.resolve(UPLOADS_DIR);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error("Invalid storage path");
  }
  return full;
}

function localUrlFor(bucket: string, filePath: string): string {
  return `/uploads/${bucket}/${filePath}`;
}

// --- public API -------------------------------------------------------------

export async function saveFile(bucket: string, filePath: string, data: Buffer): Promise<string> {
  const contentType = mime.lookup(filePath) || "application/octet-stream";
  if (LOCAL_MODE) {
    const full = localPathFor(bucket, filePath);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, data);
    return localUrlFor(bucket, filePath);
  }
  const key = `${bucket}/${filePath}`;
  await s3!.send(new (aws().PutObjectCommand)({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    Body: data,
    ContentType: contentType,
  }));
  return `${R2_PUBLIC_URL}/${key}`;
}

export function getFileUrl(bucket: string, filePath: string): string {
  if (LOCAL_MODE) return localUrlFor(bucket, filePath);
  return `${R2_PUBLIC_URL}/${bucket}/${filePath}`;
}

export async function deleteFile(bucket: string, filePath: string): Promise<void> {
  if (LOCAL_MODE) {
    await fsp.rm(localPathFor(bucket, filePath), { force: true });
    return;
  }
  const key = `${bucket}/${filePath}`;
  await s3!.send(new (aws().DeleteObjectCommand)({
    Bucket: R2_BUCKET_NAME,
    Key: key,
  }));
}

export async function copyFile(
  srcBucket: string,
  srcPath: string,
  destBucket: string,
  destPath: string
): Promise<string> {
  if (LOCAL_MODE) {
    const src = localPathFor(srcBucket, srcPath);
    const dest = localPathFor(destBucket, destPath);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(src, dest);
    return localUrlFor(destBucket, destPath);
  }
  const srcKey = `${srcBucket}/${srcPath}`;
  const destKey = `${destBucket}/${destPath}`;
  await s3!.send(new (aws().CopyObjectCommand)({
    Bucket: R2_BUCKET_NAME,
    CopySource: `${R2_BUCKET_NAME}/${srcKey}`,
    Key: destKey,
  }));
  return `${R2_PUBLIC_URL}/${destKey}`;
}

export function resolveToR2Url(url: string): string {
  // In local mode the "/uploads/..." URL is served directly, so it is already
  // resolved. In cloud mode, rewrite the legacy "/uploads/" prefix to R2.
  if (LOCAL_MODE) return url;
  if (url.startsWith("/uploads/")) {
    return `${R2_PUBLIC_URL}/${url.slice("/uploads/".length)}`;
  }
  return url;
}

export async function getFileStream(bucket: string, filePath: string): Promise<{ Body: NodeJS.ReadableStream | null }> {
  if (LOCAL_MODE) {
    const full = localPathFor(bucket, filePath);
    if (!fs.existsSync(full)) return { Body: null };
    return { Body: fs.createReadStream(full) };
  }
  const key = `${bucket}/${filePath}`;
  const response = await s3!.send(new (aws().GetObjectCommand)({
    Bucket: R2_BUCKET_NAME,
    Key: key,
  }));
  return response as unknown as { Body: NodeJS.ReadableStream | null };
}

export function getR2PublicUrl(): string {
  return R2_PUBLIC_URL;
}

export function isR2HostedUrl(url: string): boolean {
  if (!url || typeof url !== "string") return false;
  if (url.startsWith("/uploads/")) return true;
  return !!R2_PUBLIC_URL && url.startsWith(R2_PUBLIC_URL);
}

/**
 * Normalize a URL that points at our own local-disk uploads store to its
 * canonical "/uploads/<bucket>/<path>" form, or return null if it isn't one.
 *
 * Accepts both the stored relative form ("/uploads/...") and an absolute URL
 * on a loopback host (e.g. "http://localhost:5000/uploads/..."), which is how
 * references arrive after the /api/generate handler absolutizes them against
 * APP_URL / the request host. Such URLs are durable on the user's disk but are
 * NOT reachable by fal.ai's remote servers, so any caller about to hand one to
 * fal must first upload the bytes to fal.storage (see fal.ts).
 */
export function toLocalUploadsPath(url: string): string | null {
  if (!url || typeof url !== "string") return null;
  if (url.startsWith("/uploads/")) return url;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const loopback =
      host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" ||
      host === "::1" || host.endsWith(".localhost");
    if (loopback && u.pathname.startsWith("/uploads/")) return u.pathname;
  } catch { /* not an absolute URL — fall through */ }
  return null;
}

export function isLocalUploadsUrl(url: string): boolean {
  return toLocalUploadsPath(url) !== null;
}

function extFromContentTypeOrUrl(url: string, contentType: string): string {
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("png")) return ".png";
  if (ct.includes("webp")) return ".webp";
  if (ct.includes("jpeg") || ct.includes("jpg")) return ".jpg";
  if (ct.includes("svg")) return ".svg";
  if (ct.includes("gif")) return ".gif";
  if (ct.includes("mp4")) return ".mp4";
  if (ct.includes("webm")) return ".webm";
  if (ct.includes("quicktime")) return ".mov";
  if (ct.includes("mpeg") && ct.includes("audio")) return ".mp3";
  if (ct.includes("audio/mp3")) return ".mp3";
  if (ct.includes("wav")) return ".wav";
  if (ct.includes("ogg")) return ".ogg";
  try {
    const u = new URL(url);
    const ext = path.extname(u.pathname);
    if (ext) return ext;
  } catch { /* ignore */ }
  return ".bin";
}

// SSRF defense for the rehoster — same shape as brandIqCrawler. Any URL
// whose hostname resolves to loopback / RFC1918 / link-local / CGNAT /
// metadata / multicast / IPv6 ULA is rejected before we issue a fetch,
// and every redirect hop is re-validated by `fetchWithSafeRedirects`.
const REHOST_FETCH_TIMEOUT_MS = 15_000;
const REHOST_MAX_BYTES = 50 * 1024 * 1024; // 50 MB cap on rehosted assets
const REHOST_MAX_REDIRECTS = 4;
const REHOST_ALLOWED_CONTENT_TYPES = [
  "image/", "video/", "audio/", "application/octet-stream",
];

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local + AWS metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80:") || lower.startsWith("fec0:")) return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("ff")) return true;
  const m = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return isPrivateIPv4(m[1]);
  return false;
}

async function assertPublicHost(hostname: string): Promise<void> {
  const ipKind = net.isIP(hostname);
  if (ipKind === 4) {
    if (isPrivateIPv4(hostname)) throw new Error("URL resolves to a non-public address");
    return;
  }
  if (ipKind === 6) {
    if (isPrivateIPv6(hostname)) throw new Error("URL resolves to a non-public address");
    return;
  }
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".local") || lower.endsWith(".internal")) {
    throw new Error("URL resolves to a non-public address");
  }
  let addrs: { address: string; family: number }[] = [];
  try {
    addrs = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error("DNS lookup failed");
  }
  if (addrs.length === 0) throw new Error("DNS lookup returned no addresses");
  for (const a of addrs) {
    const bad = a.family === 4 ? isPrivateIPv4(a.address) : isPrivateIPv6(a.address);
    if (bad) throw new Error("URL resolves to a non-public address");
  }
}

function validateRehostUrl(u: URL): void {
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error("Only http/https URLs are supported");
  }
  if (u.port && u.port !== "" && u.port !== "80" && u.port !== "443") {
    throw new Error("Only default http/https ports are supported");
  }
}

async function fetchWithSafeRedirects(startUrl: URL, signal: AbortSignal): Promise<{ resp: Response; finalUrl: string }> {
  let current = startUrl;
  for (let hop = 0; hop <= REHOST_MAX_REDIRECTS; hop++) {
    validateRehostUrl(current);
    await assertPublicHost(current.hostname);
    const resp = await fetch(current.toString(), {
      method: "GET",
      redirect: "manual",
      signal,
    });
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get("location");
      if (!loc) throw new Error(`Redirect ${resp.status} with no Location`);
      try { current = new URL(loc, current); }
      catch { throw new Error("Invalid redirect target"); }
      continue;
    }
    return { resp, finalUrl: current.toString() };
  }
  throw new Error("Too many redirects");
}

/**
 * Download an externally-hosted file (e.g. fal.media result) and persist it
 * to R2. Returns the R2 public URL on success. Throws on any failure so the
 * caller can decide whether to fall back to the original URL or surface an
 * error to the user.
 *
 * SSRF-hardened: rejects non-public hostnames / IPs (loopback, RFC1918,
 * link-local, CGNAT, IPv6 ULA, AWS metadata) before issuing a fetch and
 * re-validates each redirect hop. A 15s timeout and 50 MB cap bound the
 * outbound request, and content-type must be image/video/audio/octet-stream.
 */
export async function rehostExternalUrlToR2(
  url: string,
  bucket: string,
  pathPrefix: string
): Promise<string> {
  if (!url || typeof url !== "string") {
    throw new Error("rehostExternalUrlToR2: missing url");
  }
  if (isR2HostedUrl(url)) return url;
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("rehostExternalUrlToR2: only http(s) URLs are supported");
  }

  let parsed: URL;
  try { parsed = new URL(url); }
  catch { throw new Error("rehostExternalUrlToR2: invalid URL"); }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REHOST_FETCH_TIMEOUT_MS);
  let resp: Response;
  try {
    const result = await fetchWithSafeRedirects(parsed, controller.signal);
    resp = result.resp;
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    throw new Error(`rehostExternalUrlToR2: download failed (${resp.status})`);
  }
  const contentType = (resp.headers.get("content-type") || "").toLowerCase();
  if (contentType && !REHOST_ALLOWED_CONTENT_TYPES.some((p) => contentType.startsWith(p))) {
    throw new Error(`rehostExternalUrlToR2: unsupported content-type (${contentType})`);
  }
  const declaredLen = parseInt(resp.headers.get("content-length") || "", 10);
  if (Number.isFinite(declaredLen) && declaredLen > REHOST_MAX_BYTES) {
    throw new Error(`rehostExternalUrlToR2: file exceeds max size (${declaredLen} bytes)`);
  }

  // Stream so we can hard-stop at REHOST_MAX_BYTES even when content-length
  // is missing or lying. Without this a remote could send unbounded data.
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (resp.body) {
    const reader = resp.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > REHOST_MAX_BYTES) {
        try { await reader.cancel(); } catch { /* ignore */ }
        throw new Error("rehostExternalUrlToR2: file exceeds max size");
      }
      chunks.push(value);
    }
  } else {
    const ab = await resp.arrayBuffer();
    if (ab.byteLength > REHOST_MAX_BYTES) {
      throw new Error("rehostExternalUrlToR2: file exceeds max size");
    }
    chunks.push(new Uint8Array(ab));
    total = ab.byteLength;
  }
  if (total === 0) {
    throw new Error("rehostExternalUrlToR2: empty body");
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)), total);
  const ext = extFromContentTypeOrUrl(url, contentType);
  const cleanPrefix = pathPrefix.replace(/^\/+|\/+$/g, "");
  const filePath = `${cleanPrefix}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`;
  return await saveFile(bucket, filePath, buf);
}

export function parseFileUrl(url: string): { bucket: string; path: string } | null {
  if (url.startsWith("/uploads/")) {
    const relativePath = url.slice("/uploads/".length);
    const parts = relativePath.split("/");
    return { bucket: parts[0], path: parts.slice(1).join("/") };
  }
  if (R2_PUBLIC_URL && url.startsWith(R2_PUBLIC_URL)) {
    const relativePath = url.slice(R2_PUBLIC_URL.length + 1);
    const parts = relativePath.split("/");
    return { bucket: parts[0], path: parts.slice(1).join("/") };
  }
  return null;
}

export { s3, R2_BUCKET_NAME };
