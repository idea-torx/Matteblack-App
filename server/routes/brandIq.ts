// Brand IQ — workspace-scoped brand profile CRUD + ingestion + synthesis.
//
// All endpoints require authentication and verify workspace membership
// (mirroring server/routes/agent.ts). The router is mounted at the app
// root in server/index.ts so each path is /api/brand-iq/*.
//
// Profile data shape (data JSONB column):
//   {
//     mission?: string,
//     vision?: string,
//     audience?: string,
//     tone?: string,
//     do?: string[],
//     dont?: string[],
//     palette?: { name?: string, hex: string }[],
//     typography?: { display?: string, body?: string, mono?: string },
//     urls?: string[],
//   }

import { Router } from "express";
import multer from "multer";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import Anthropic from "@anthropic-ai/sdk";
import type { ImageBlockParam, MessageParam, TextBlockParam } from "@anthropic-ai/sdk/resources/messages.js";
import { pool } from "../db.js";
import { requireAuth, requireVerifiedEmail, type AuthRequest } from "../sessions.js";
import { saveFile, deleteFile, parseFileUrl } from "../storage.js";
import { crawlUrl, type CrawlEvidence } from "../services/brandIqCrawler.js";
import { extractDocumentText } from "../services/brandIqDocExtractor.js";
import { getAnthropicKey } from "../config/userConfig.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASSET_ROLES = new Set(["logo_light", "logo_dark", "graphic", "inspiration", "document"]);
const SUPPORTED_DOC_MIMES = new Set([
  "text/plain",
  "text/markdown",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SYNTH_MODEL = process.env.ANTHROPIC_SONNET_MODEL || "claude-sonnet-4-6";

// Lazily build the Anthropic client from the currently-effective key (user
// Settings / userConfig first, then ANTHROPIC_API_KEY), rebuilding only when
// the key changes so a runtime-added key takes effect without a restart.
let _anthropicClient: Anthropic | null = null;
let _anthropicClientKey: string | undefined;
function getAnthropicClient(): Anthropic | null {
  const key = getAnthropicKey();
  if (!key) return null;
  if (_anthropicClient && _anthropicClientKey === key) return _anthropicClient;
  _anthropicClient = new Anthropic({ apiKey: key });
  _anthropicClientKey = key;
  return _anthropicClient;
}

function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

async function userHasWorkspaceAccess(userId: string, workspaceId: string): Promise<boolean> {
  if (!isUuid(workspaceId)) return false;
  const r = await pool.query(
    `SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 LIMIT 1`,
    [workspaceId, userId]
  );
  return r.rows.length > 0;
}

async function loadProfileForUser(
  userId: string,
  profileId: string,
): Promise<{ row: BrandProfileRow; workspaceId: string } | null> {
  if (!isUuid(profileId)) return null;
  const r = await pool.query(
    `SELECT bp.*, EXISTS (
       SELECT 1 FROM workspace_members wm
       WHERE wm.workspace_id = bp.workspace_id AND wm.user_id = $2
     ) AS has_access
     FROM brand_iq_profiles bp WHERE bp.id = $1`,
    [profileId, userId]
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0] as BrandProfileRow & { has_access: boolean };
  if (!row.has_access) return null;
  return { row, workspaceId: row.workspace_id };
}

type BrandProfileRow = {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  is_default: boolean;
  archived_at: string | null;
  tags: string[];
  avatar_color: string;
  data: Record<string, unknown>;
  design_md: string;
  design_md_url: string | null;
  crawl_evidence: Record<string, CrawlEvidence>;
  created_at: string;
  updated_at: string;
};

type BrandAssetRow = {
  id: string;
  profile_id: string;
  asset_id: string;
  role: string;
  extracted_text: string | null;
  source_mime: string | null;
  doc_role: string | null;
  extraction_status: string | null;
  sort_order: number;
  created_at: string;
  asset_name: string;
  asset_type: string;
  asset_file_url: string;
  asset_file_type: string | null;
};

function shapeProfile(row: BrandProfileRow, assets: BrandAssetRow[] = []): Record<string, unknown> {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    name: row.name,
    slug: row.slug,
    is_default: row.is_default,
    archived_at: row.archived_at,
    tags: row.tags || [],
    avatar_color: row.avatar_color,
    data: row.data || {},
    design_md: row.design_md || "",
    design_md_url: row.design_md_url,
    crawl_evidence: row.crawl_evidence || {},
    created_at: row.created_at,
    updated_at: row.updated_at,
    assets: assets.map((a) => ({
      id: a.id,
      asset_id: a.asset_id,
      role: a.role,
      doc_role: a.doc_role,
      extraction_status: a.extraction_status,
      source_mime: a.source_mime,
      extracted_text_preview: a.extracted_text ? a.extracted_text.slice(0, 280) : null,
      sort_order: a.sort_order,
      created_at: a.created_at,
      name: a.asset_name,
      type: a.asset_type,
      file_url: a.asset_file_url,
      file_type: a.asset_file_type,
    })),
  };
}

async function loadAssets(profileId: string): Promise<BrandAssetRow[]> {
  const r = await pool.query(
    `SELECT bia.*, a.name AS asset_name, a.type AS asset_type, a.file_url AS asset_file_url, a.file_type AS asset_file_type
     FROM brand_iq_assets bia
     JOIN assets a ON a.id = bia.asset_id
     WHERE bia.profile_id = $1 AND a.deleted_at IS NULL
     ORDER BY bia.sort_order ASC, bia.created_at ASC`,
    [profileId]
  );
  return r.rows as BrandAssetRow[];
}

// ---------- LIST + READ ----------

router.get("/api/brand-iq", requireAuth, requireVerifiedEmail, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const wsRaw = typeof req.query.workspace_id === "string" ? req.query.workspace_id : "";
  if (!isUuid(wsRaw)) {
    res.status(400).json({ error: "workspace_id is required" });
    return;
  }
  if (!(await userHasWorkspaceAccess(userId, wsRaw))) {
    res.status(403).json({ error: "Not a member of this workspace" });
    return;
  }
  const includeArchived = req.query.include_archived === "1" || req.query.include_archived === "true";
  const profileWhere = includeArchived ? "WHERE workspace_id = $1" : "WHERE workspace_id = $1 AND archived_at IS NULL";
  const r = await pool.query(
    `SELECT * FROM brand_iq_profiles ${profileWhere}
     ORDER BY is_default DESC, updated_at DESC`,
    [wsRaw]
  );
  const profileRows = r.rows as BrandProfileRow[];

  // Hydrate assets for every profile in a single batched join. Without
  // this the list endpoint returns `assets: []` for every profile and
  // the panel — which only re-fetches the full profile after upload or
  // save — shows uploaded logos/docs as missing on every reload, even
  // though the underlying rows + storage files are intact. We group in
  // JS rather than aggregating in SQL so the row shape stays identical
  // to loadAssets() (one source of truth for shapeProfile).
  const assetsByProfile = new Map<string, BrandAssetRow[]>();
  if (profileRows.length > 0) {
    const ids = profileRows.map((p) => p.id);
    const a = await pool.query(
      `SELECT bia.*, a.name AS asset_name, a.type AS asset_type, a.file_url AS asset_file_url, a.file_type AS asset_file_type
       FROM brand_iq_assets bia
       JOIN assets a ON a.id = bia.asset_id
       WHERE bia.profile_id = ANY($1::uuid[]) AND a.deleted_at IS NULL
       ORDER BY bia.profile_id, bia.sort_order ASC, bia.created_at ASC`,
      [ids]
    );
    for (const row of a.rows as BrandAssetRow[]) {
      const list = assetsByProfile.get(row.profile_id) || [];
      list.push(row);
      assetsByProfile.set(row.profile_id, list);
    }
  }
  res.json({
    profiles: profileRows.map((row) => shapeProfile(row, assetsByProfile.get(row.id) || [])),
  });
});

router.get("/api/brand-iq/:id", requireAuth, requireVerifiedEmail, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const loaded = await loadProfileForUser(userId, req.params.id);
  if (!loaded) {
    res.status(404).json({ error: "Brand profile not found" });
    return;
  }
  const assets = await loadAssets(loaded.row.id);
  res.json({ profile: shapeProfile(loaded.row, assets) });
});

// ---------- CREATE ----------

router.post("/api/brand-iq", requireAuth, requireVerifiedEmail, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const { workspace_id, name, avatar_color, tags, set_default, data, design_md, crawl_evidence } = req.body || {};
  if (!isUuid(workspace_id)) {
    res.status(400).json({ error: "workspace_id is required" });
    return;
  }
  if (!(await userHasWorkspaceAccess(userId, workspace_id))) {
    res.status(403).json({ error: "Not a member of this workspace" });
    return;
  }
  const safeName = (typeof name === "string" && name.trim()) ? name.trim().slice(0, 120) : "Untitled brand";
  const safeColor = typeof avatar_color === "string" && /^#[0-9a-fA-F]{6}$/.test(avatar_color) ? avatar_color : "#6366f1";
  const safeTags = Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string").slice(0, 12) : [];
  const safeData = data && typeof data === "object" ? data : {};
  // brand_iq_profiles.design_md is NOT NULL DEFAULT '' — never insert null,
  // or the DB rejects the row when the caller (e.g. the panel's New flow)
  // omits the field.
  const safeDesignMd = typeof design_md === "string" ? design_md.slice(0, 100_000) : "";
  const safeEvidence = crawl_evidence && typeof crawl_evidence === "object" ? crawl_evidence : {};
  const slug = safeName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60) || "brand";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (set_default) {
      await client.query(
        `UPDATE brand_iq_profiles SET is_default = FALSE
         WHERE workspace_id = $1 AND archived_at IS NULL AND is_default = TRUE`,
        [workspace_id]
      );
    }
    const r = await client.query(
      `INSERT INTO brand_iq_profiles
         (workspace_id, name, slug, avatar_color, tags, is_default, data, design_md, crawl_evidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb)
       RETURNING *`,
      [
        workspace_id,
        safeName,
        slug,
        safeColor,
        safeTags,
        !!set_default,
        JSON.stringify(safeData),
        safeDesignMd,
        JSON.stringify(safeEvidence),
      ]
    );
    await client.query("COMMIT");
    res.status(201).json({ profile: shapeProfile(r.rows[0] as BrandProfileRow) });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[brand-iq] create error", err);
    res.status(500).json({ error: "Failed to create brand profile" });
  } finally {
    client.release();
  }
});

// ---------- UPDATE ----------

router.patch("/api/brand-iq/:id", requireAuth, requireVerifiedEmail, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const loaded = await loadProfileForUser(userId, req.params.id);
  if (!loaded) {
    res.status(404).json({ error: "Brand profile not found" });
    return;
  }
  const { name, avatar_color, tags, data, design_md } = req.body || {};
  const updates: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (typeof name === "string" && name.trim()) {
    updates.push(`name = $${idx++}`); values.push(name.trim().slice(0, 120));
  }
  if (typeof avatar_color === "string" && /^#[0-9a-fA-F]{6}$/.test(avatar_color)) {
    updates.push(`avatar_color = $${idx++}`); values.push(avatar_color);
  }
  if (Array.isArray(tags)) {
    const safe = tags.filter((t): t is string => typeof t === "string").slice(0, 12);
    updates.push(`tags = $${idx++}`); values.push(safe);
  }
  if (data && typeof data === "object") {
    updates.push(`data = $${idx++}::jsonb`); values.push(JSON.stringify(data));
  }
  if (typeof design_md === "string") {
    updates.push(`design_md = $${idx++}`); values.push(design_md.slice(0, 100_000));
  }
  if (updates.length === 0) {
    res.json({ profile: shapeProfile(loaded.row, await loadAssets(loaded.row.id)) });
    return;
  }
  values.push(loaded.row.id);
  const r = await pool.query(
    `UPDATE brand_iq_profiles SET ${updates.join(", ")} WHERE id = $${idx} RETURNING *`,
    values
  );
  const updated = r.rows[0] as BrandProfileRow;

  // Whenever design_md is rewritten, snapshot it to R2 so we always have an
  // immutable record next to the workspace's assets. Best-effort — failures
  // here just leave design_md_url alone.
  if (typeof design_md === "string") {
    try {
      const snapshotUrl = await saveFile(
        "brand-iq",
        `${updated.workspace_id}/${updated.id}/design.md`,
        Buffer.from(updated.design_md, "utf-8"),
      );
      const r2 = await pool.query(
        `UPDATE brand_iq_profiles SET design_md_url = $1 WHERE id = $2 RETURNING *`,
        [snapshotUrl, updated.id]
      );
      res.json({ profile: shapeProfile(r2.rows[0] as BrandProfileRow, await loadAssets(updated.id)) });
      return;
    } catch (err) {
      console.warn("[brand-iq] design.md snapshot failed", err);
    }
  }

  res.json({ profile: shapeProfile(updated, await loadAssets(updated.id)) });
});

// ---------- DELETE / ARCHIVE ----------

router.delete("/api/brand-iq/:id", requireAuth, requireVerifiedEmail, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const loaded = await loadProfileForUser(userId, req.params.id);
  if (!loaded) {
    res.status(404).json({ error: "Brand profile not found" });
    return;
  }
  // Soft-delete by default (archives the profile so it can be restored).
  // Pass ?hard=1 to permanently delete the row + its asset link rows +
  // any project overrides + any sticky chat references. The CASCADE on
  // brand_iq_assets / project_brand_overrides handles the related rows;
  // we explicitly null the FK on agent_chats and remove brand-iq assets
  // (source = 'brand_iq') so we don't orphan files in storage.
  const hard = req.query.hard === "1" || req.query.hard === "true";
  if (!hard) {
    await pool.query(
      `UPDATE brand_iq_profiles SET archived_at = NOW(), is_default = FALSE WHERE id = $1`,
      [loaded.row.id]
    );
    res.json({ ok: true, mode: "archived" });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Detach from any chats that pinned this brand. We null the FK
    // rather than delete the chat — losing chat history on a brand
    // delete would be surprising.
    await client.query(
      `UPDATE agent_chats SET brand_profile_id = NULL WHERE brand_profile_id = $1`,
      [loaded.row.id]
    );
    // Soft-delete the asset rows that were uploaded specifically for
    // this brand (source = 'brand_iq'); CASCADE on brand_iq_assets
    // handles the link rows themselves.
    await client.query(
      `UPDATE assets
         SET deleted_at = NOW()
       WHERE deleted_at IS NULL
         AND source = 'brand_iq'
         AND (metadata->>'brand_profile_id') = $1`,
      [loaded.row.id]
    );
    await client.query(
      `DELETE FROM brand_iq_profiles WHERE id = $1`,
      [loaded.row.id]
    );
    await client.query("COMMIT");
    res.json({ ok: true, mode: "deleted" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[brand-iq] hard delete error", err);
    res.status(500).json({ error: "Failed to delete brand profile" });
  } finally {
    client.release();
  }
});

router.post("/api/brand-iq/:id/restore", requireAuth, requireVerifiedEmail, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const loaded = await loadProfileForUser(userId, req.params.id);
  if (!loaded) { res.status(404).json({ error: "Brand profile not found" }); return; }
  await pool.query(
    `UPDATE brand_iq_profiles SET archived_at = NULL WHERE id = $1`,
    [loaded.row.id]
  );
  res.json({ ok: true });
});

// ---------- DEFAULTS ----------

router.post("/api/brand-iq/:id/default", requireAuth, requireVerifiedEmail, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const loaded = await loadProfileForUser(userId, req.params.id);
  if (!loaded) { res.status(404).json({ error: "Brand profile not found" }); return; }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE brand_iq_profiles SET is_default = FALSE
       WHERE workspace_id = $1 AND archived_at IS NULL AND is_default = TRUE`,
      [loaded.workspaceId]
    );
    await client.query(
      `UPDATE brand_iq_profiles SET is_default = TRUE WHERE id = $1`,
      [loaded.row.id]
    );
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[brand-iq] set default error", err);
    res.status(500).json({ error: "Failed to set default" });
  } finally {
    client.release();
  }
});

router.delete("/api/brand-iq/:id/default", requireAuth, requireVerifiedEmail, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const loaded = await loadProfileForUser(userId, req.params.id);
  if (!loaded) { res.status(404).json({ error: "Brand profile not found" }); return; }
  await pool.query(
    `UPDATE brand_iq_profiles SET is_default = FALSE WHERE id = $1`,
    [loaded.row.id]
  );
  res.json({ ok: true });
});

// ---------- PROJECT OVERRIDES ----------

router.post("/api/brand-iq/project/:projectId", requireAuth, requireVerifiedEmail, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const projectId = req.params.projectId;
  if (!isUuid(projectId)) { res.status(400).json({ error: "Invalid project_id" }); return; }
  const { brand_profile_id } = req.body || {};
  // Verify project membership through canvas_states.workspace_id
  const proj = await pool.query(
    `SELECT cs.workspace_id FROM canvas_states cs WHERE cs.id = $1`,
    [projectId]
  );
  if (proj.rows.length === 0) { res.status(404).json({ error: "Project not found" }); return; }
  const wsId = proj.rows[0].workspace_id as string | null;
  if (!wsId || !(await userHasWorkspaceAccess(userId, wsId))) {
    res.status(403).json({ error: "Not a member of this project's workspace" });
    return;
  }

  if (brand_profile_id == null) {
    await pool.query(`DELETE FROM project_brand_overrides WHERE project_id = $1`, [projectId]);
    res.json({ ok: true, brand_profile_id: null });
    return;
  }
  if (!isUuid(brand_profile_id)) { res.status(400).json({ error: "Invalid brand_profile_id" }); return; }
  // Ensure the brand profile belongs to the same workspace.
  const bp = await pool.query(
    `SELECT id FROM brand_iq_profiles WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL`,
    [brand_profile_id, wsId]
  );
  if (bp.rows.length === 0) {
    res.status(400).json({ error: "Brand profile is not in this workspace" });
    return;
  }
  await pool.query(
    `INSERT INTO project_brand_overrides (project_id, brand_profile_id)
     VALUES ($1, $2)
     ON CONFLICT (project_id) DO UPDATE SET brand_profile_id = EXCLUDED.brand_profile_id, updated_at = NOW()`,
    [projectId, brand_profile_id]
  );
  res.json({ ok: true, brand_profile_id });
});

router.get("/api/brand-iq/project/:projectId", requireAuth, requireVerifiedEmail, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const projectId = req.params.projectId;
  if (!isUuid(projectId)) { res.status(400).json({ error: "Invalid project_id" }); return; }
  const proj = await pool.query(
    `SELECT cs.workspace_id FROM canvas_states cs WHERE cs.id = $1`,
    [projectId]
  );
  if (proj.rows.length === 0) { res.status(404).json({ error: "Project not found" }); return; }
  const wsId = proj.rows[0].workspace_id as string | null;
  if (!wsId || !(await userHasWorkspaceAccess(userId, wsId))) {
    res.status(403).json({ error: "Not a member of this project's workspace" });
    return;
  }
  const r = await pool.query(
    `SELECT brand_profile_id FROM project_brand_overrides WHERE project_id = $1`,
    [projectId]
  );
  res.json({ brand_profile_id: r.rows[0]?.brand_profile_id || null });
});

// ---------- ASSET UPLOAD (logo / graphic / inspiration) ----------

router.post(
  "/api/brand-iq/:id/assets",
  requireAuth,
  requireVerifiedEmail,
  upload.single("file"),
  async (req: AuthRequest, res) => {
    const userId = req.userId!;
    const loaded = await loadProfileForUser(userId, req.params.id);
    if (!loaded) { res.status(404).json({ error: "Brand profile not found" }); return; }
    if (!req.file) { res.status(400).json({ error: "file is required" }); return; }
    const role = String(req.body?.role || "").trim();
    if (!ASSET_ROLES.has(role) || role === "document") {
      res.status(400).json({ error: "role must be logo_light, logo_dark, graphic, or inspiration" });
      return;
    }
    const mime = (req.file.mimetype || "").toLowerCase();
    if (!mime.startsWith("image/") && !mime.includes("svg")) {
      res.status(400).json({ error: "Only image uploads are supported here. Use /documents for text docs." });
      return;
    }
    const ext = path.extname(req.file.originalname) || ".png";
    const fileUrl = await saveFile(
      `users/${userId}`,
      `brand-iq/${loaded.row.id}/${uuidv4()}${ext}`,
      req.file.buffer,
    );
    const assetType = mime.includes("svg") ? "vector" : "image";
    const asset = await pool.query(
      `INSERT INTO assets (user_id, type, source, name, file_url, file_type, metadata)
       VALUES ($1, $2, 'brand_iq', $3, $4, $5, $6)
       RETURNING id, name, type, file_url, file_type`,
      [
        userId,
        assetType,
        req.body?.name || req.file.originalname || `${role} asset`,
        fileUrl,
        mime,
        // Mirror the source on metadata so consumers that only project
        // metadata (e.g. asset library filters) can also key off it.
        JSON.stringify({ brand_profile_id: loaded.row.id, role, source: "brand_iq" }),
      ]
    );

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Logos enforce uniqueness — replace any existing same-role link.
      if (role === "logo_light" || role === "logo_dark") {
        await client.query(
          `DELETE FROM brand_iq_assets WHERE profile_id = $1 AND role = $2`,
          [loaded.row.id, role]
        );
      }
      const link = await client.query(
        `INSERT INTO brand_iq_assets (profile_id, asset_id, role, source_mime)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [loaded.row.id, asset.rows[0].id, role, mime]
      );
      await client.query(
        `UPDATE brand_iq_profiles SET updated_at = NOW() WHERE id = $1`,
        [loaded.row.id]
      );
      await client.query("COMMIT");
      res.status(201).json({
        link: link.rows[0],
        asset: asset.rows[0],
      });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[brand-iq] asset upload error", err);
      res.status(500).json({ error: "Failed to attach asset" });
    } finally {
      client.release();
    }
  }
);

// ---------- DOCUMENT UPLOAD (.md / .txt / .pdf / .docx) ----------

router.post(
  "/api/brand-iq/:id/documents",
  requireAuth,
  requireVerifiedEmail,
  upload.single("file"),
  async (req: AuthRequest, res) => {
    const userId = req.userId!;
    const loaded = await loadProfileForUser(userId, req.params.id);
    if (!loaded) { res.status(404).json({ error: "Brand profile not found" }); return; }
    if (!req.file) { res.status(400).json({ error: "file is required" }); return; }
    const docRole = (typeof req.body?.doc_role === "string" ? req.body.doc_role : "general").slice(0, 60);

    const mime = (req.file.mimetype || "").toLowerCase();
    const lowerName = req.file.originalname.toLowerCase();
    const allowed =
      SUPPORTED_DOC_MIMES.has(mime) ||
      lowerName.endsWith(".md") ||
      lowerName.endsWith(".markdown") ||
      lowerName.endsWith(".txt") ||
      lowerName.endsWith(".pdf") ||
      lowerName.endsWith(".docx");
    if (!allowed) {
      res.status(400).json({ error: "Unsupported document type. Use .md, .txt, .pdf, or .docx" });
      return;
    }

    const extracted = await extractDocumentText(req.file.buffer, req.file.originalname, mime);
    const ext = path.extname(req.file.originalname) || ".bin";
    const fileUrl = await saveFile(
      `users/${userId}`,
      `brand-iq/${loaded.row.id}/docs/${uuidv4()}${ext}`,
      req.file.buffer,
    );

    // Documents stored as image-typed assets would break the type CHECK; we
    // store them as 'vector' to satisfy the existing constraint and tag the
    // metadata so the UI can disambiguate. The brand_iq_assets row carries
    // the canonical `role = document` link.
    const asset = await pool.query(
      `INSERT INTO assets (user_id, type, source, name, file_url, file_type, metadata)
       VALUES ($1, 'vector', 'brand_iq', $2, $3, $4, $5)
       RETURNING id, name, type, file_url, file_type`,
      [
        userId,
        req.file.originalname,
        fileUrl,
        mime || extracted.mime,
        JSON.stringify({ brand_profile_id: loaded.row.id, role: "document", doc_role: docRole, kind: "brand_doc", source: "brand_iq" }),
      ]
    );
    const link = await pool.query(
      `INSERT INTO brand_iq_assets (profile_id, asset_id, role, doc_role, extracted_text, source_mime, extraction_status)
       VALUES ($1, $2, 'document', $3, $4, $5, $6)
       RETURNING *`,
      [
        loaded.row.id,
        asset.rows[0].id,
        docRole,
        extracted.ok ? extracted.text : null,
        extracted.ok ? extracted.mime : extracted.mime,
        extracted.ok ? (extracted.truncated ? "truncated" : "ok") : `error:${extracted.error.slice(0, 200)}`,
      ]
    );
    await pool.query(`UPDATE brand_iq_profiles SET updated_at = NOW() WHERE id = $1`, [loaded.row.id]);
    res.status(201).json({ link: link.rows[0], asset: asset.rows[0], extraction: extracted });
  }
);

// ---------- DETACH ASSET ----------

router.delete("/api/brand-iq/:id/assets/:linkId", requireAuth, requireVerifiedEmail, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const loaded = await loadProfileForUser(userId, req.params.id);
  if (!loaded) { res.status(404).json({ error: "Brand profile not found" }); return; }
  const linkId = req.params.linkId;
  if (!isUuid(linkId)) { res.status(400).json({ error: "Invalid link id" }); return; }
  const link = await pool.query(
    `SELECT bia.id, bia.asset_id, a.user_id AS asset_owner, a.file_url
     FROM brand_iq_assets bia
     JOIN assets a ON a.id = bia.asset_id
     WHERE bia.id = $1 AND bia.profile_id = $2`,
    [linkId, loaded.row.id]
  );
  if (link.rows.length === 0) { res.status(404).json({ error: "Asset link not found" }); return; }
  const row = link.rows[0];
  await pool.query(`DELETE FROM brand_iq_assets WHERE id = $1`, [linkId]);
  // If this user owns the underlying asset and no other links reference it,
  // soft-delete the asset and try to purge the R2 file. We keep failures
  // non-fatal so the link removal still appears successful.
  if (row.asset_owner === userId) {
    const remaining = await pool.query(
      `SELECT 1 FROM brand_iq_assets WHERE asset_id = $1 LIMIT 1`,
      [row.asset_id]
    );
    if (remaining.rows.length === 0) {
      await pool.query(`UPDATE assets SET deleted_at = NOW() WHERE id = $1`, [row.asset_id]);
      const parsed = parseFileUrl(row.file_url || "");
      if (parsed) { try { await deleteFile(parsed.bucket, parsed.path); } catch { /* ignore */ } }
    }
  }
  res.json({ ok: true });
});

// ---------- URL CRAWL ----------

// Crawl is async + non-blocking: each requested URL is immediately marked
// `status: 'pending'` in crawl_evidence and the actual fetch runs in the
// background. The client polls GET /api/brand-iq/:id/urls/status (or the
// regular profile fetch) for completion. Lets the UI render per-URL
// progress without holding the request open through 12 fetches.
router.post("/api/brand-iq/:id/urls", requireAuth, requireVerifiedEmail, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const loaded = await loadProfileForUser(userId, req.params.id);
  if (!loaded) { res.status(404).json({ error: "Brand profile not found" }); return; }
  const rawUrls = Array.isArray(req.body?.urls) ? req.body.urls : [];
  const urls = rawUrls
    .filter((u: unknown): u is string => typeof u === "string" && u.trim().length > 0)
    .map((u: string) => u.trim())
    .slice(0, 12);
  if (urls.length === 0) { res.status(400).json({ error: "Provide at least one URL" }); return; }

  const startedAt = new Date().toISOString();
  const pendingMap: Record<string, CrawlEvidence> = {};
  for (const url of urls) {
    pendingMap[url] = { url, ok: false, fetched_at: startedAt, status: 0, error: undefined } as CrawlEvidence;
    (pendingMap[url] as CrawlEvidence & { state?: string }).state = "pending";
  }
  const merged = { ...(loaded.row.crawl_evidence || {}), ...pendingMap };
  const data = { ...(loaded.row.data || {}) } as Record<string, unknown>;
  const existingUrls = Array.isArray(data.urls) ? (data.urls as string[]) : [];
  data.urls = Array.from(new Set([...existingUrls, ...urls])).slice(0, 24);

  const r = await pool.query(
    `UPDATE brand_iq_profiles
     SET crawl_evidence = $1::jsonb, data = $2::jsonb, updated_at = NOW()
     WHERE id = $3
     RETURNING *`,
    [JSON.stringify(merged), JSON.stringify(data), loaded.row.id]
  );
  res.status(202).json({
    profile: shapeProfile(r.rows[0] as BrandProfileRow, await loadAssets(loaded.row.id)),
    queued: urls,
  });

  // Fire-and-forget background work — each URL writes its own row update
  // so progress shows up incrementally.
  //
  // We previously used `jsonb_set(crawl_evidence, $path, ...)` with the
  // path interpolated as `{${JSON.stringify(url)}}`. That works for
  // simple URLs but is fragile: Postgres parses the path as a text[]
  // literal, so URLs containing braces, commas, backslashes, or
  // double-quotes can either error out or write to the wrong key. We
  // now do a read-modify-write merge inside a SERIALIZABLE-safe
  // pattern: read current evidence with FOR UPDATE, merge in JS, then
  // write the whole object back. Per-URL work is sequential so there's
  // no concurrent overlap on the same row from this loop.
  const writeEvidence = async (url: string, payload: CrawlEvidence & { state: string }) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const cur = await client.query(
        `SELECT crawl_evidence FROM brand_iq_profiles WHERE id = $1 FOR UPDATE`,
        [loaded.row.id]
      );
      if (cur.rows.length === 0) { await client.query("ROLLBACK"); return; }
      const merged = { ...((cur.rows[0].crawl_evidence as Record<string, CrawlEvidence>) || {}) };
      merged[url] = payload;
      await client.query(
        `UPDATE brand_iq_profiles
           SET crawl_evidence = $1::jsonb, updated_at = NOW()
         WHERE id = $2`,
        [JSON.stringify(merged), loaded.row.id]
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("[brand-iq] crawl evidence write failed", err);
    } finally {
      client.release();
    }
  };
  void (async () => {
    for (const url of urls) {
      try {
        const evidence = await crawlUrl(url);
        await writeEvidence(url, { ...evidence, state: evidence.ok ? "ok" : "error" });
      } catch (err) {
        await writeEvidence(url, {
          url, ok: false, fetched_at: new Date().toISOString(),
          error: err instanceof Error ? err.message : "Crawl failed",
          state: "error",
        });
      }
    }
  })();
});

// Lightweight polling endpoint — returns just the crawl_evidence map so
// the UI can poll without re-shaping the whole profile + assets payload.
router.get("/api/brand-iq/:id/urls/status", requireAuth, requireVerifiedEmail, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const loaded = await loadProfileForUser(userId, req.params.id);
  if (!loaded) { res.status(404).json({ error: "Brand profile not found" }); return; }
  res.json({ crawl_evidence: loaded.row.crawl_evidence || {} });
});

router.delete("/api/brand-iq/:id/urls", requireAuth, requireVerifiedEmail, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const loaded = await loadProfileForUser(userId, req.params.id);
  if (!loaded) { res.status(404).json({ error: "Brand profile not found" }); return; }
  const target = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  if (!target) { res.status(400).json({ error: "url is required" }); return; }
  const evidence = { ...(loaded.row.crawl_evidence || {}) };
  delete evidence[target];
  const data = { ...(loaded.row.data || {}) } as Record<string, unknown>;
  const urls = Array.isArray(data.urls) ? (data.urls as string[]).filter((u) => u !== target) : [];
  data.urls = urls;
  const r = await pool.query(
    `UPDATE brand_iq_profiles SET crawl_evidence = $1::jsonb, data = $2::jsonb, updated_at = NOW()
     WHERE id = $3 RETURNING *`,
    [JSON.stringify(evidence), JSON.stringify(data), loaded.row.id]
  );
  res.json({ profile: shapeProfile(r.rows[0] as BrandProfileRow, await loadAssets(loaded.row.id)) });
});

// ---------- SYNTHESIZE design.md ----------

router.post("/api/brand-iq/:id/synthesize", requireAuth, requireVerifiedEmail, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const loaded = await loadProfileForUser(userId, req.params.id);
  if (!loaded) { res.status(404).json({ error: "Brand profile not found" }); return; }
  const anthropicClient = getAnthropicClient();
  if (!anthropicClient) {
    res.status(503).json({ error: "Synthesis is unavailable — add your Anthropic API key in Settings" });
    return;
  }
  const assets = await loadAssets(loaded.row.id);
  const data = (loaded.row.data || {}) as Record<string, unknown>;
  const evidence = (loaded.row.crawl_evidence || {}) as Record<string, CrawlEvidence>;

  const formBlock = JSON.stringify(
    {
      name: loaded.row.name,
      tags: loaded.row.tags,
      mission: data.mission,
      vision: data.vision,
      audience: data.audience,
      tone: data.tone,
      do: data.do,
      dont: data.dont,
      palette: data.palette,
      typography: data.typography,
      urls: data.urls,
    },
    null,
    2,
  );

  const docs = assets
    .filter((a) => a.role === "document" && a.extracted_text)
    .map((a) => `### ${a.asset_name} (${a.doc_role || "general"})\n${(a.extracted_text || "").slice(0, 12_000)}`)
    .join("\n\n");

  const crawls = Object.values(evidence)
    .filter((e) => e.ok)
    .slice(0, 6)
    .map((e) => {
      const og = e.og ? Object.entries(e.og).slice(0, 6).map(([k, v]) => `${k}: ${v}`).join("\n") : "";
      const heads = (e.headings || []).slice(0, 12).map((h) => `${"#".repeat(h.level)} ${h.text}`).join("\n");
      return `### ${e.url}\nTitle: ${e.title || ""}\nDescription: ${e.description || ""}\n${og ? "OpenGraph:\n" + og + "\n" : ""}${heads ? "\n" + heads + "\n" : ""}\n${(e.text || "").slice(0, 4_000)}`;
    })
    .join("\n\n");

  const visionBlocks: ImageBlockParam[] = [];
  for (const a of assets) {
    if ((a.role === "logo_light" || a.role === "logo_dark" || a.role === "graphic" || a.role === "inspiration") &&
        a.asset_file_url && /^https?:\/\//i.test(a.asset_file_url)) {
      visionBlocks.push({ type: "image", source: { type: "url", url: a.asset_file_url } });
      if (visionBlocks.length >= 6) break;
    }
  }

  const userText = [
    "You are synthesizing a Brand IQ design.md document for a creative team.",
    "Use the structured fields, extracted documents, crawled site evidence, and the attached brand images to write a concise, opinionated brand brief in markdown.",
    "",
    "Required structure (use these exact H2 headers, in this order):",
    "## Identity",
    "## Audience",
    "## Voice & Tone",
    "## Visual Language",
    "## Palette",
    "## Typography",
    "## Imagery & Logo Usage",
    "## Do / Don't",
    "## Source notes",
    "",
    "Rules:",
    "- Be specific. Quote concrete words from the form/docs/crawl when useful.",
    "- Palette section MUST list each color as `- HEX — name (role)` using the hex codes from the form when present.",
    "- Typography section MUST mention the display, body, and mono fonts from the form when set.",
    "- Imagery & Logo Usage MUST describe what the attached logo(s) look like and how to apply them (light vs dark backgrounds, padding, do/don't).",
    "- Source notes lists every URL crawled and every document name used.",
    "- Keep total length under 3000 words.",
    "",
    "## Form data (JSON)",
    "```json",
    formBlock,
    "```",
    docs ? `\n## Documents\n${docs}` : "",
    crawls ? `\n## Crawled site evidence\n${crawls}` : "",
  ].filter(Boolean).join("\n");

  const content: (TextBlockParam | ImageBlockParam)[] = [];
  if (visionBlocks.length > 0) content.push(...visionBlocks);
  content.push({ type: "text", text: userText });
  const messages: MessageParam[] = [{ role: "user", content }];

  try {
    const resp = await anthropicClient.messages.create({
      model: SYNTH_MODEL,
      max_tokens: 4096,
      system: "You are a senior brand strategist. Output only the markdown document, no preamble.",
      messages,
    });
    const designMd = resp.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    if (!designMd) {
      res.status(502).json({ error: "Synthesis returned no text" });
      return;
    }

    // Synthesize is propose-only: return the draft markdown without
    // touching the stored profile. The client shows the proposed text + a
    // diff against the current design_md and the user separately commits
    // via PUT /api/brand-iq/:id/design-md (below).
    res.json({
      profile_id: loaded.row.id,
      proposed_design_md: designMd,
      current_design_md: loaded.row.design_md || "",
    });
  } catch (err) {
    console.error("[brand-iq] synthesize error", err);
    const msg = err instanceof Error ? err.message : "Synthesis failed";
    res.status(502).json({ error: msg });
  }
});

// ---------- ANALYZE from canvas selection ----------
//
// Given a list of canvas-selected references (each with an optional
// image URL + text/dimension metadata), produce a per-reference deep
// style breakdown design.md and return it through the same propose-only
// shape as /synthesize. The model is explicitly told NOT to blend
// references into a single average style — every selection becomes its
// own first-class block with an exact-recreation prompt.
type CanvasReferenceInput = {
  url?: string;
  name?: string;
  width?: number;
  height?: number;
  aspect_ratio?: string;
  kind?: "image" | "text" | "frame" | "other";
  text_content?: string;
};

const MAX_VISION_REFS = 6;

router.post("/api/brand-iq/:id/analyze-from-canvas", requireAuth, requireVerifiedEmail, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const loaded = await loadProfileForUser(userId, req.params.id);
  if (!loaded) { res.status(404).json({ error: "Brand profile not found" }); return; }
  const anthropicClient = getAnthropicClient();
  if (!anthropicClient) {
    res.status(503).json({ error: "Analysis is unavailable — add your Anthropic API key in Settings" });
    return;
  }
  const rawRefs = Array.isArray(req.body?.references) ? req.body.references : [];
  const refs: CanvasReferenceInput[] = rawRefs
    .filter((r: unknown): r is Record<string, unknown> => !!r && typeof r === "object")
    .map((r) => ({
      url: typeof r.url === "string" ? r.url : undefined,
      name: typeof r.name === "string" ? r.name.slice(0, 200) : undefined,
      width: typeof r.width === "number" ? r.width : undefined,
      height: typeof r.height === "number" ? r.height : undefined,
      aspect_ratio: typeof r.aspect_ratio === "string" ? r.aspect_ratio : undefined,
      kind: (r.kind === "image" || r.kind === "text" || r.kind === "frame" || r.kind === "other")
        ? r.kind
        : (typeof r.url === "string" ? "image" : "other"),
      text_content: typeof r.text_content === "string" ? r.text_content.slice(0, 4_000) : undefined,
    }))
    .slice(0, 24);
  if (refs.length === 0) {
    res.status(400).json({ error: "Provide at least one canvas reference" });
    return;
  }

  // Build per-reference text descriptors and (capped) image blocks.
  const visionBlocks: ImageBlockParam[] = [];
  const refDescriptors: string[] = [];
  let visionCount = 0;
  refs.forEach((r, i) => {
    const idx = i + 1;
    const lines: string[] = [`### Reference ${idx} — ${r.name || (r.kind === "image" ? "Image" : r.kind === "text" ? "Text" : "Item")}`];
    lines.push(`- kind: ${r.kind || "other"}`);
    if (r.width && r.height) lines.push(`- dimensions: ${Math.round(r.width)}×${Math.round(r.height)}`);
    if (r.aspect_ratio) lines.push(`- aspect_ratio: ${r.aspect_ratio}`);
    if (r.text_content) lines.push(`- text_content: ${r.text_content.slice(0, 800)}`);
    if (r.url && r.kind === "image" && /^https?:\/\//i.test(r.url)) {
      if (visionCount < MAX_VISION_REFS) {
        visionBlocks.push({ type: "image", source: { type: "url", url: r.url } });
        lines.push(`- image: attached (vision block #${visionCount + 1})`);
        visionCount += 1;
      } else {
        lines.push(`- image: ${r.url} (skipped from vision — over the ${MAX_VISION_REFS}-image cap)`);
      }
    } else if (r.url) {
      lines.push(`- url: ${r.url}`);
    }
    refDescriptors.push(lines.join("\n"));
  });

  const userText = [
    "You are analyzing a set of canvas references the user picked as visual inspiration for a brand profile.",
    "Each reference must be treated as its own exact-recreation target. Do NOT blend them into one average style — when references contradict each other, document that they're distinct options the user can pick from.",
    "",
    "Output a single markdown document with this exact top-level structure (use the exact H2 headers, in this order):",
    "## Identity",
    "## Common threads",
    "## References",
    "## How to use these references",
    "",
    "Rules:",
    "- ## Identity: 2–4 sentences, only the genuinely shared identity signal across all refs.",
    "- ## Common threads: bulleted list of traits that repeat across EVERY reference. If nothing repeats, say so honestly in one line — do not invent shared traits.",
    "- ## References: one `### Reference N — {short name}` subsection per input, in the order provided. Each subsection MUST contain the following labeled bullets in this order:",
    "    - **Description**: one line.",
    "    - **Palette**: hex list (e.g. `#0F172A, #F5F5F7, #3B82F6`) read directly from the image.",
    "    - **Typography**: cues / family vibe / weight / case (or 'n/a' if no text).",
    "    - **Composition / framing**: layout, focal placement, negative space, rule of thirds, etc.",
    "    - **Lighting**: direction, hardness, color temperature, contrast.",
    "    - **Lens / camera**: focal length feel, depth of field, perspective.",
    "    - **Texture & post-processing**: grain, halation, color grade, sharpness, noise.",
    "    - **Subject treatment**: how the subject is staged.",
    "    - **Mood**: 3–6 adjectives.",
    "    - **Exact recreation prompt**: a single self-contained prompt the user could paste into the Create panel verbatim to reproduce this reference's style. Be specific (palette hexes, lens, lighting, mood).",
    "- ## How to use these references: explain that the agent should match a SINGLE chosen reference (not blend) when generating against this brand, and that the user can name a reference by number (e.g. \"use Reference 2's style\") to lock to that style.",
    "- Keep total length under 3000 words.",
    "- Do NOT add any preamble or trailing commentary — output only the markdown document.",
    "",
    "## Reference inputs",
    refDescriptors.join("\n\n"),
  ].join("\n");

  const content: (TextBlockParam | ImageBlockParam)[] = [];
  if (visionBlocks.length > 0) content.push(...visionBlocks);
  content.push({ type: "text", text: userText });
  const messages: MessageParam[] = [{ role: "user", content }];

  // Send headers immediately and write a single whitespace byte every
  // 15s so the Replit edge proxy doesn't kill the connection during
  // long vision calls. Whitespace is ignored by JSON.parse, so the
  // client's `r.json()` still sees a valid object once we end().
  res.status(200);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-store");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  const heartbeat = setInterval(() => {
    try { res.write(" "); } catch { /* ignore */ }
  }, 15_000);
  const finalize = (payload: Record<string, unknown>) => {
    clearInterval(heartbeat);
    try { res.end(JSON.stringify(payload)); } catch { /* ignore */ }
  };

  try {
    const resp = await anthropicClient.messages.create({
      model: SYNTH_MODEL,
      max_tokens: 6000,
      system: "You are a senior art director performing a per-reference style breakdown. Output only the markdown document, no preamble. Treat each reference as its own first-class style — never average or blend them.",
      messages,
    });
    const designMd = resp.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!designMd) {
      finalize({ error: "Analysis returned no text" });
      return;
    }
    finalize({
      profile_id: loaded.row.id,
      proposed_design_md: designMd,
      current_design_md: loaded.row.design_md || "",
      vision_count: visionCount,
      reference_count: refs.length,
    });
  } catch (err) {
    console.error("[brand-iq] analyze-from-canvas error", err);
    const msg = err instanceof Error ? err.message : "Analysis failed";
    finalize({ error: msg });
  }
});

// ---------- COMMIT design.md ----------
//
// Persists a (typically synthesize-proposed, possibly user-edited)
// markdown body to brand_iq_profiles.design_md and snapshots it to R2.
// Kept separate from /synthesize so the user can review + diff before
// any DB write happens.
router.put("/api/brand-iq/:id/design-md", requireAuth, requireVerifiedEmail, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const loaded = await loadProfileForUser(userId, req.params.id);
  if (!loaded) { res.status(404).json({ error: "Brand profile not found" }); return; }
  const body = (req.body || {}) as { design_md?: unknown };
  if (typeof body.design_md !== "string") {
    res.status(400).json({ error: "design_md (string) required" });
    return;
  }
  const designMd = body.design_md.slice(0, 100_000);
  let snapshotUrl: string | null = null;
  try {
    snapshotUrl = await saveFile(
      "brand-iq",
      `${loaded.workspaceId}/${loaded.row.id}/design.md`,
      Buffer.from(designMd, "utf-8"),
    );
  } catch (err) {
    console.warn("[brand-iq] design-md snapshot upload failed", err);
  }
  const r = await pool.query(
    `UPDATE brand_iq_profiles
     SET design_md = $1, design_md_url = COALESCE($2, design_md_url), updated_at = NOW()
     WHERE id = $3
     RETURNING *`,
    [designMd, snapshotUrl, loaded.row.id]
  );
  res.json({
    profile: shapeProfile(r.rows[0] as BrandProfileRow, await loadAssets(loaded.row.id)),
    design_md: designMd,
  });
});

export default router;
