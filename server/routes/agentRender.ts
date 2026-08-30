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

const router = Router();

/** 256KB of markup. A CSS art page is a few KB; past this it isn't art. */
const MAX_HTML_BYTES = 256_000;

function requireMcpToken(req: AuthRequest, res: Response, next: NextFunction): void {
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

/** Render markup to a PNG on the canvas. With `nodeId`, re-renders that node. */
router.post("/api/agent/render-html", requireMcpToken, requireAuth, async (req: AuthRequest, res) => {
  const body = (req.body ?? {}) as { html?: unknown; width?: unknown; height?: unknown; label?: unknown; nodeId?: unknown };
  if (typeof body.html !== "string" || !body.html.trim()) {
    res.status(400).json({ error: "Expected an `html` string — a complete document." });
    return;
  }
  if (Buffer.byteLength(body.html, "utf8") > MAX_HTML_BYTES) {
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
  const width = Math.max(1, Math.min(4096, Math.round(Number(body.width)) || 1080));
  const height = Math.max(1, Math.min(4096, Math.round(Number(body.height)) || 1350));
  const label = (typeof body.label === "string" && body.label.trim() ? body.label : "HTML art").slice(0, 80);
  const nodeId = typeof body.nodeId === "string" ? body.nodeId : null;

  try {
    const png = await renderHtmlToPng(body.html, width, height);
    const stem = uuidv4();
    const src = await saveFile(`users/${userId}/html`, `${stem}.png`, png);
    // The markup lives next to the PNG rather than in the node's jsonb: canvas
    // sync ships every node's metadata on every load, and art pages are KBs.
    const htmlUrl = await saveFile(`users/${userId}/html`, `${stem}.html`, Buffer.from(body.html, "utf8"));
    const metadata = { source: "agent", kind: "html", html_url: htmlUrl, pixel_width: width, pixel_height: height };

    if (nodeId) {
      const upd = await pool.query(
        `UPDATE canvas_nodes SET src = $1, label = $2, metadata = metadata || $3::jsonb
          WHERE id = $4 AND canvas_id = $5 RETURNING id`,
        [src, label, JSON.stringify(metadata), nodeId, canvasId],
      );
      if (upd.rows.length === 0) { res.status(404).json({ error: "No such node on the open canvas." }); return; }
      broadcastCanvasUpdate(canvasId, "");
      res.json({ nodeId, src, width, height, replaced: true });
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
    res.json({ nodeId: id, src, width, height, replaced: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Render failed.";
    console.error("[agent/render-html] failed:", err);
    res.status(500).json({ error: message });
  }
});

/** Read back the markup behind a rendered node, so an edit starts from it. */
router.get("/api/agent/html/:nodeId", requireMcpToken, requireAuth, async (req: AuthRequest, res) => {
  const canvasId = activeCanvas(req);
  if (!canvasId) { res.status(400).json({ error: "No canvas is open." }); return; }
  try {
    const found = await pool.query(
      `SELECT metadata FROM canvas_nodes WHERE id = $1 AND canvas_id = $2`,
      [req.params.nodeId, canvasId],
    );
    const meta = found.rows[0]?.metadata as { html_url?: string; pixel_width?: number; pixel_height?: number } | undefined;
    if (!meta?.html_url) { res.status(404).json({ error: "That node wasn't rendered from HTML." }); return; }
    const ref = parseFileUrl(meta.html_url);
    if (!ref) { res.status(404).json({ error: "The source markup is no longer on disk." }); return; }
    const { Body } = await getFileStream(ref.bucket, ref.path);
    if (!Body) { res.status(404).json({ error: "The source markup is no longer on disk." }); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of Body) chunks.push(Buffer.from(chunk));
    res.json({
      html: Buffer.concat(chunks).toString("utf8"),
      width: meta.pixel_width ?? null,
      height: meta.pixel_height ?? null,
    });
  } catch (err) {
    console.error("[agent/html] read failed:", err);
    res.status(500).json({ error: "Failed to read the source markup." });
  }
});

export default router;
