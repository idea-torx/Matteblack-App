/**
 * Programmatic art — the operator writes HTML/CSS, the app rasterizes it and
 * drops the PNG on the canvas as an ordinary image node.
 *
 * Deliberately NOT a live HTML node type: a PNG participates in frame export,
 * the cinema timeline and `transform_media` for free, where an iframe would
 * need its own raster path for every one of them. The markup is kept beside the
 * PNG so the agent can read it back and re-render an edit — that is the whole
 * editing story, no hand-editing surface in the UI.
 */
import { Router, type Response, type NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";
import { requireAuth, type AuthRequest } from "../sessions.js";
import { getMcpToken } from "../mcpToken.js";
import { pool } from "../db.js";
import { broadcastCanvasUpdate } from "./canvas.js";
import { getOperatorContext } from "../services/operatorCanvasContext.js";
import { placeNext, placeholderSize, fallbackViewport, type Rect } from "../utils/canvasPlacement.js";
import { saveFile, getFileStream, parseFileUrl } from "../storage.js";
import { canRenderHtml, renderHtmlToPng } from "../utils/htmlRender.js";
import { resolveLocalPath } from "../utils/localPath.js";
import { underBlenderDir } from "../utils/blenderPath.js";
import { resolveUploadPath } from "../utils/uploadPath.js";
import { UPLOADS_DIR, DATA_DIR } from "../config/runtime.js";
import fs from "node:fs";
import probe from "probe-image-size";
import path from "node:path";

const router = Router();

/** 256KB of markup. A CSS art page is a few KB; past this it isn't art. */
const MAX_HTML_BYTES = 256_000;

export function requireMcpToken(req: AuthRequest, res: Response, next: NextFunction): void {
  if (process.env.MB_MCP_NO_TOKEN === "1") { next(); return; }
  const expected = getMcpToken();
  if (!expected) { res.status(503).json({ error: "MCP bridge not ready." }); return; }
  if (req.header("x-matteblack-token") !== expected) { res.status(401).json({ error: "Invalid MCP token." }); return; }
  next();
}

function activeCanvas(req: AuthRequest): string | null {
  return getOperatorContext(req.userId ?? "")?.canvasId ?? null;
}

/** Where a fresh render lands: the row-cursor cascade the generators use. */
async function placeNewNode(
  canvasId: string, userId: string, size: { w: number; h: number },
): Promise<{ rect: Rect; z: number }> {
  const existing = await pool.query(
    `SELECT x, y, width, height, node_type FROM canvas_nodes WHERE canvas_id = $1`,
    [canvasId],
  );
  const occupied: Rect[] = existing.rows
    .filter((r: { node_type: string }) => r.node_type !== "frame" && r.node_type !== "group")
    .map((r: { x: number; y: number; width: number; height: number }) => ({
      x: Number(r.x), y: Number(r.y), w: Number(r.width), h: Number(r.height),
    }));
  const ctx = getOperatorContext(userId);
  const rect = placeNext({
    viewport: ctx?.viewport ?? fallbackViewport(occupied, size),
    occupied,
    size,
  });
  const zRes = await pool.query(`SELECT COALESCE(MAX(z_index), 0) AS z FROM canvas_nodes WHERE canvas_id = $1`, [canvasId]);
  return { rect, z: ((zRes.rows[0]?.z as number) ?? 0) + 1 };
}

/** 12MB per image — a poster background, not a raw camera file. */
const MAX_IMAGE_BYTES = 12_000_000;
const MAX_IMAGES = 8;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
};

type Resolved = string | { error: string };

const mb = (n: number) => `${(n / 1_000_000).toFixed(1)}MB`;

/** One `images` entry -> a data: URI, or why it couldn't be read. */
async function toDataUri(ref: string): Promise<Resolved> {
  try {
    if (/^data:image\//i.test(ref)) return ref;

    const upload = resolveUploadPath(ref, UPLOADS_DIR);
    if (upload) {
      const b = fs.readFileSync(upload.path);
      if (b.byteLength > MAX_IMAGE_BYTES) return { error: `${mb(b.byteLength)}, over the ${mb(MAX_IMAGE_BYTES)} limit` };
      return `data:${upload.mime};base64,${b.toString("base64")}`;
    }

    if (/^https?:\/\//i.test(ref)) {
      const r = await fetch(ref);
      if (!r.ok) return { error: `fetch failed (HTTP ${r.status})` };
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.byteLength > MAX_IMAGE_BYTES) return { error: `${mb(buf.byteLength)}, over the ${mb(MAX_IMAGE_BYTES)} limit` };
      const mime = (r.headers.get("content-type") || "").split(";")[0].trim();
      if (!mime.startsWith("image/")) return { error: `that URL served ${mime || "no content-type"}, not an image` };
      return `data:${mime};base64,${buf.toString("base64")}`;
    }

    // Anything else is a path on this machine — same guard as read_local_file.
    const local = resolveLocalPath(ref);
    if ("error" in local) return { error: local.error };
    const mime = MIME_BY_EXT[path.extname(local.path).toLowerCase()];
    if (!mime) return { error: `unsupported file type ${path.extname(local.path) || "(none)"}` };
    const b = fs.readFileSync(local.path);
    if (b.byteLength > MAX_IMAGE_BYTES) return { error: `${mb(b.byteLength)}, over the ${mb(MAX_IMAGE_BYTES)} limit` };
    return `data:${mime};base64,${b.toString("base64")}`;
  } catch (err) {
    return { error: err instanceof Error ? err.message : "could not be read" };
  }
}

/**
 * Substitute `asset:NAME` placeholders with the actual image bytes.
 *
 * The point is that the bytes never touch the agent's context: it writes a
 * short name and a path or URL, and the pixels are attached here. Inlining as
 * data: URIs rather than leaving remote URLs in the markup also means the
 * offscreen capture is not racing the network for the thing it is capturing.
 *
 * Returns the names that could not be resolved so the caller can say which,
 * rather than silently rendering a page full of broken images.
 */
export async function inlineAssets(
  html: string,
  images: unknown,
  resolve: (ref: string) => Promise<Resolved | null> = toDataUri,
): Promise<{ html: string; missing: string[]; problems: string[] }> {
  if (!images || typeof images !== "object" || Array.isArray(images)) return { html, missing: [], problems: [] };
  const missing: string[] = [];
  // Same names, with the reason attached — "ERR_INVALID_URL" for an oversized
  // file cost a whole debugging cycle, so the key and the cause both go back.
  const problems: string[] = [];
  let out = html;
  // Longest name first: with {bg, bg2} in that order, substituting `asset:bg`
  // would eat the prefix of `asset:bg2` and leave a stray "2" in the markup.
  const entries = Object.entries(images as Record<string, unknown>)
    .slice(0, MAX_IMAGES)
    .sort((a, b) => b[0].length - a[0].length);
  for (const [name, ref] of entries) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || typeof ref !== "string" || !ref.trim()) {
      missing.push(name);
      problems.push(`${name}: not a usable name/path pair`);
      continue;
    }
    const uri = await resolve(ref.trim());
    if (!uri || typeof uri !== "string") {
      missing.push(name);
      problems.push(`${name}: ${uri && uri.error ? uri.error : "could not be read"}`);
      continue;
    }
    out = out.split(`asset:${name}`).join(uri);
  }
  return { html: out, missing, problems };
}

type StoredHtml = { html: string; width: number | null; height: number | null; images: Record<string, string> };

/** The markup a rendered node was made from, as stored beside its PNG. */
async function loadNodeHtml(canvasId: string, nodeId: string): Promise<StoredHtml | { error: string }> {
  const found = await pool.query(`SELECT metadata FROM canvas_nodes WHERE id = $1 AND canvas_id = $2`, [nodeId, canvasId]);
  const meta = found.rows[0]?.metadata as { html_url?: string; pixel_width?: number; pixel_height?: number; images?: Record<string, string> } | undefined;
  if (!meta?.html_url) return { error: "That node wasn't rendered from HTML." };
  const ref = parseFileUrl(meta.html_url);
  if (!ref) return { error: "The source markup is no longer on disk." };
  const { Body } = await getFileStream(ref.bucket, ref.path);
  if (!Body) return { error: "The source markup is no longer on disk." };
  const chunks: Buffer[] = [];
  for await (const chunk of Body) chunks.push(Buffer.from(chunk));
  return {
    html: Buffer.concat(chunks).toString("utf8"),
    width: meta.pixel_width ?? null,
    height: meta.pixel_height ?? null,
    images: meta.images ?? {},
  };
}

/** Apply the agent's find/replace edits to stored markup.
 *  Each `find` must appear exactly once — an ambiguous or stale edit is a wrong
 *  render, and a wrong render costs a whole round trip to notice. */
export function applyEdits(html: string, edits: { find: string; replace: string }[]): string | { error: string } {
  let out = html;
  for (const e of edits) {
    if (typeof e?.find !== "string" || !e.find || typeof e?.replace !== "string") {
      return { error: "Each edit needs a non-empty `find` string and a `replace` string." };
    }
    const n = out.split(e.find).length - 1;
    if (n === 0) return { error: `edit not applied — no match for ${JSON.stringify(e.find.slice(0, 80))}. Call get_html and copy the text exactly.` };
    if (n > 1) return { error: `edit not applied — ${n} matches for ${JSON.stringify(e.find.slice(0, 80))}. Include more surrounding text to make it unique.` };
    out = out.split(e.find).join(e.replace);
  }
  return out;
}

/** Render markup to a PNG on the canvas. With `nodeId`, re-renders that node. */
router.post("/api/agent/render-html", requireMcpToken, requireAuth, async (req: AuthRequest, res) => {
  const body = (req.body ?? {}) as { html?: unknown; width?: unknown; height?: unknown; label?: unknown; nodeId?: unknown; images?: unknown; edits?: unknown };
  const edits = Array.isArray(body.edits) ? (body.edits as { find: string; replace: string }[]) : null;
  if (edits && typeof body.nodeId !== "string") {
    res.status(400).json({ error: "`edits` revises an existing piece — pass the `nodeId` too." });
    return;
  }
  if (!edits && (typeof body.html !== "string" || !body.html.trim())) {
    res.status(400).json({ error: "Expected an `html` string — a complete document." });
    return;
  }
  if (typeof body.html === "string" && Buffer.byteLength(body.html, "utf8") > MAX_HTML_BYTES) {
    res.status(413).json({ error: `That document is over ${MAX_HTML_BYTES / 1000}KB. Inline less, or split it into separate pieces.` });
    return;
  }
  if (!canRenderHtml()) {
    res.status(503).json({ error: "HTML rendering is only available in the desktop app." });
    return;
  }
  const canvasId = activeCanvas(req);
  if (!canvasId) { res.status(400).json({ error: "No canvas is open — ask the user to open the canvas first." }); return; }
  const userId = req.userId ?? "";
  const label = (typeof body.label === "string" && body.label.trim() ? body.label : "HTML art").slice(0, 80);
  const nodeId = typeof body.nodeId === "string" ? body.nodeId : null;
  const clamp = (n: number, fallback: number) => Math.max(1, Math.min(4096, Math.round(n) || fallback));

  try {
    // With `edits`, the document is the stored one with the agent's patches
    // applied — a two-word change costs two short strings instead of re-emitting
    // the whole page, which is the slow half of every revision.
    let source = typeof body.html === "string" ? body.html : "";
    let images = body.images;
    let baseW: number | null = null;
    let baseH: number | null = null;
    if (edits) {
      const stored = await loadNodeHtml(canvasId, nodeId as string);
      if ("error" in stored) { res.status(404).json({ error: stored.error }); return; }
      const applied = applyEdits(stored.html, edits);
      if (typeof applied !== "string") { res.status(400).json({ error: applied.error }); return; }
      source = applied;
      if (images === undefined) images = stored.images;
      baseW = stored.width;
      baseH = stored.height;
      if (Buffer.byteLength(source, "utf8") > MAX_HTML_BYTES) {
        res.status(413).json({ error: `That edit takes the document over ${MAX_HTML_BYTES / 1000}KB.` });
        return;
      }
    }
    const width = clamp(Number(body.width), baseW || 1080);
    const height = clamp(Number(body.height), baseH || 1350);

    // Attach the pixels here, not in the agent's context: it wrote `asset:name`.
    const { html: markup, missing, problems } = await inlineAssets(source, images);
    const { png, map } = await renderHtmlToPng(markup, width, height);
    const stem = uuidv4();
    const src = await saveFile(`users/${userId}/html`, `${stem}.png`, png);
    // Element map beside the markup: the canvas fetches it to let the user pick
    // a piece of the render and point the agent at it. Rebuilt every render.
    const mapUrl = await saveFile(`users/${userId}/html`, `${stem}.map.json`, Buffer.from(JSON.stringify(map), "utf8"));
    // The markup lives next to the PNG rather than in the node's jsonb: canvas
    // sync ships every node's metadata on every load, and art pages are KBs.
    const htmlUrl = await saveFile(`users/${userId}/html`, `${stem}.html`, Buffer.from(source, "utf8"));
    // The markup is stored with its `asset:` placeholders intact, so the map of
    // names to paths has to travel with it or a later edit re-renders blank.
    // It is a handful of short strings, unlike the markup itself.
    const imageMap = images && typeof images === "object" && !Array.isArray(images) ? images : {};
    const metadata = { source: "agent", kind: "html", html_url: htmlUrl, map_url: mapUrl, pixel_width: width, pixel_height: height, images: imageMap };

    if (nodeId) {
      const upd = await pool.query(
        `UPDATE canvas_nodes SET src = $1, label = $2, metadata = metadata || $3::jsonb
          WHERE id = $4 AND canvas_id = $5 RETURNING id`,
        [src, label, JSON.stringify(metadata), nodeId, canvasId],
      );
      if (upd.rows.length === 0) { res.status(404).json({ error: "No such node on the open canvas." }); return; }
      broadcastCanvasUpdate(canvasId, "");
      res.json({ nodeId, src, width, height, replaced: true, missing, problems });
      return;
    }

    const size = placeholderSize("quality", `${width}:${height}`, "image");
    const { rect, z } = await placeNewNode(canvasId, userId, size);
    const id = uuidv4();
    await pool.query(
      `INSERT INTO canvas_nodes (id, canvas_id, node_type, x, y, width, height, rotation, z_index, locked, visible, label, src, gradient, metadata, asset_id, job_id)
       VALUES ($1, $2, 'image', $3, $4, $5, $6, 0, $7, false, true, $8, $9, '', $10, NULL, NULL)`,
      [id, canvasId, rect.x, rect.y, size.w, size.h, z, label, src, JSON.stringify(metadata)],
    );
    broadcastCanvasUpdate(canvasId, "");
    res.json({ nodeId: id, src, width, height, replaced: false, missing, problems });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Render failed.";
    console.error("[agent/render-html] failed:", err);
    res.status(500).json({ error: message });
  }
});

/** A rendered node's markup with its images attached, for the live iframe the
 *  canvas shows in place of the PNG. Session auth; the node must be the user's. */
async function ownedNodeHtml(nodeId: string, userId: string): Promise<{ canvasId: string; stored: StoredHtml } | { error: string; status: number }> {
  if (!/^[0-9a-f-]{36}$/i.test(nodeId)) return { error: "bad request", status: 400 };
  const owner = await pool.query(`SELECT n.canvas_id FROM canvas_nodes n JOIN canvas_states c ON c.id = n.canvas_id WHERE n.id = $1 AND c.user_id = $2`, [nodeId, userId]);
  const canvasId = owner.rows[0]?.canvas_id as string | undefined;
  if (!canvasId) return { error: "No such node.", status: 404 };
  const stored = await loadNodeHtml(canvasId, nodeId);
  if ("error" in stored) return { error: stored.error, status: 404 };
  return { canvasId, stored };
}

router.get("/api/canvas/html-live/:nodeId", requireAuth, async (req: AuthRequest, res) => {
  try {
    const got = await ownedNodeHtml(req.params.nodeId, req.userId ?? "");
    if ("error" in got) { res.status(got.status).json({ error: got.error }); return; }
    const { html } = await inlineAssets(got.stored.html, got.stored.images);
    res.type("html").send(html);
  } catch (err) {
    console.error("[canvas/html-live] failed:", err);
    res.status(500).json({ error: "Failed to read the source markup." });
  }
});

/** The user edited a node's live DOM (dragged elements): store the serialized
 *  markup as the new source and re-render its PNG, so the agent's next edit and
 *  every export start from where things are. */
router.post("/api/canvas/html-save", requireAuth, async (req: AuthRequest, res) => {
  const { nodeId, html } = (req.body ?? {}) as { nodeId?: unknown; html?: unknown };
  if (typeof nodeId !== "string" || typeof html !== "string" || !html.trim()) { res.status(400).json({ error: "bad request" }); return; }
  const userId = req.userId ?? "";
  try {
    const got = await ownedNodeHtml(nodeId, userId);
    if ("error" in got) { res.status(got.status).json({ error: got.error }); return; }
    const { canvasId, stored } = got;
    // Put the `asset:` placeholders back so the stored markup stays small and editable.
    let source = html;
    for (const [name, ref] of Object.entries(stored.images ?? {})) {
      const uri = await toDataUri(ref);
      if (typeof uri === "string") source = source.split(uri).join(`asset:${name}`);
    }
    if (Buffer.byteLength(source, "utf8") > MAX_HTML_BYTES) { res.status(413).json({ error: "document too large" }); return; }
    const width = stored.width || 1080, height = stored.height || 1350;
    const { png, map } = await renderHtmlToPng(html, width, height);
    const stem = uuidv4();
    const src = await saveFile(`users/${userId}/html`, `${stem}.png`, png);
    const mapUrl = await saveFile(`users/${userId}/html`, `${stem}.map.json`, Buffer.from(JSON.stringify(map), "utf8"));
    const htmlUrl = await saveFile(`users/${userId}/html`, `${stem}.html`, Buffer.from(source, "utf8"));
    await pool.query(`UPDATE canvas_nodes SET src = $1, metadata = metadata || $2::jsonb WHERE id = $3 AND canvas_id = $4`,
      [src, JSON.stringify({ html_url: htmlUrl, map_url: mapUrl }), nodeId, canvasId]);
    broadcastCanvasUpdate(canvasId, (req.headers["x-canvas-session-id"] as string) || "");
    res.json({ nodeId, src, mapUrl, htmlUrl });
  } catch (err) {
    console.error("[canvas/html-save] failed:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "Save failed." });
  }
});

router.get("/api/agent/html/:nodeId", requireMcpToken, requireAuth, async (req: AuthRequest, res) => {
  const canvasId = activeCanvas(req);
  if (!canvasId) { res.status(400).json({ error: "No canvas is open." }); return; }
  try {
    const stored = await loadNodeHtml(canvasId, req.params.nodeId);
    if ("error" in stored) { res.status(404).json(stored); return; }
    // `?inline=1` swaps the `asset:` placeholders for the real bytes, so the
    // markup stands on its own as a file the user can open in a browser.
    if (req.query.inline) {
      const { html } = await inlineAssets(stored.html, stored.images);
      res.json({ ...stored, html });
      return;
    }
    res.json(stored);
  } catch (err) {
    console.error("[agent/html] read failed:", err);
    res.status(500).json({ error: "Failed to read the source markup." });
  }
});

/** Put a finished file from elsewhere — a Higgsfield result, any https media —
 *  on the open canvas as an ordinary image/video node. Downloaded here so the
 *  node outlives the source link. */
const MAX_IMPORT_BYTES = 200_000_000;

const kindForExt = (ext: string, ct = ""): "image" | "video" | null =>
  /^(mp4|webm|mov)$/.test(ext) || ct.startsWith("video/") ? "video"
    : /^(png|jpe?g|webp|gif)$/.test(ext) || ct.startsWith("image/") ? "image" : null;

/** The one way bytes become a canvas node: used by import-url and by the
 *  Blender bridge, which has a local file rather than a URL. */
export async function placeMediaNode(opts: {
  userId: string; canvasId: string; buf: Buffer; ext: string;
  kind: "image" | "video"; label?: string; metadata: Record<string, unknown>;
}): Promise<{ nodeId: string; src: string; kind: "image" | "video" }> {
  const { userId, canvasId, buf, ext, kind } = opts;
  const src = await saveFile(`users/${userId}/imports`, `${uuidv4()}.${ext}`, buf);
  // ponytail: videos land 16:9 and let the player fit; images take their real ratio.
  let aspect = kind === "video" ? "16:9" : "1:1";
  if (kind === "image") { try { const d = probe.sync(buf); if (d) aspect = `${d.width}:${d.height}`; } catch { /* unknown format: square */ } }
  const size = placeholderSize("quality", aspect, kind);
  const { rect, z } = await placeNewNode(canvasId, userId, size);
  const id = uuidv4();
  await pool.query(
    `INSERT INTO canvas_nodes (id, canvas_id, node_type, x, y, width, height, rotation, z_index, locked, visible, label, src, gradient, metadata, asset_id, job_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, false, true, $9, $10, '', $11, NULL, NULL)`,
    [id, canvasId, kind, rect.x, rect.y, size.w, size.h, z, opts.label ?? "", src, JSON.stringify(opts.metadata)],
  );
  broadcastCanvasUpdate(canvasId, "");
  return { nodeId: id, src, kind };
}

/** Only files the Blender bridge wrote may be imported by path — resolved
 *  through symlinks first, so `../` and a link out both land outside and fail. */
const BLENDER_DIR = path.join(DATA_DIR, "blender");
export async function importLocalMedia(opts: {
  userId: string; canvasId: string; file: string; label?: string; metadata: Record<string, unknown>;
}): Promise<{ nodeId: string; src: string; kind: "image" | "video" } | { error: string }> {
  const guard = underBlenderDir(opts.file, BLENDER_DIR);
  if ("error" in guard) return guard;
  const real = guard.path;
  const ext = path.extname(real).slice(1).toLowerCase();
  const kind = kindForExt(ext);
  if (!kind) return { error: `Not an image or video: ${real}` };
  const buf = fs.readFileSync(real);
  if (buf.byteLength > MAX_IMPORT_BYTES) return { error: "File over 200MB." };
  return placeMediaNode({ ...opts, buf, ext, kind });
}
router.post("/api/agent/import-url", requireMcpToken, requireAuth, async (req: AuthRequest, res) => {
  const canvasId = activeCanvas(req);
  if (!canvasId) { res.status(400).json({ error: "No canvas is open." }); return; }
  const userId = req.userId!;
  const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  const label = typeof req.body?.label === "string" ? req.body.label.slice(0, 200) : "";
  // The Blender add-on's "send to canvas" hands over a local file under <dataDir>/blender/.
  const file = typeof req.body?.path === "string" ? req.body.path.trim() : "";
  if (file) {
    const r = await importLocalMedia({ userId, canvasId, file, label, metadata: { source: "blender", kind: "manual" } });
    if ("error" in r) res.status(400).json(r); else res.json(r);
    return;
  }
  if (!/^https:\/\//i.test(url)) { res.status(400).json({ error: "url must be https." }); return; }
  try {
    const r = await fetch(url);
    if (!r.ok) { res.status(502).json({ error: `HTTP ${r.status} fetching ${url}` }); return; }
    const ct = (r.headers.get("content-type") || "").split(";")[0];
    const ext = /\.([a-z0-9]{2,4})(\?|$)/i.exec(url)?.[1]?.toLowerCase() || ct.split("/")[1] || "bin";
    const kind = kindForExt(ext, ct);
    if (!kind) { res.json({ skipped: `not an image or video (${ct || ext})` }); return; }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.byteLength > MAX_IMPORT_BYTES) { res.status(413).json({ error: "File over 200MB." }); return; }
    res.json(await placeMediaNode({
      userId, canvasId, buf, ext, kind, label, metadata: { source: "import", origin: url },
    }));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Import failed." });
  }
});

export default router;
