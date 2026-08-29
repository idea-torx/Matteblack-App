import { Router, Response, NextFunction } from "express";
import { pool } from "../db.js";
import multer from "multer";
import { saveFile, deleteFile, copyFile, parseFileUrl } from "../storage.js";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { requireAuth, type AuthRequest } from "../sessions.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

async function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.userId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    return;
  }
  const result = await pool.query("SELECT role FROM users WHERE id = $1", [req.userId]);
  const role = result.rows.length > 0 ? result.rows[0].role : null;
  if (!role || (role !== "admin" && role !== "superadmin")) {
    res.status(403).json({ error: { code: "FORBIDDEN", message: "Admin access required" } });
    return;
  }
  next();
}

const router = Router();

router.get("/api/platform-library", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId || null;
    const { type, tag, search } = req.query;

    let where = "WHERE pi.is_published = true";
    const params: unknown[] = [];
    let idx = 1;

    if (type) {
      where += ` AND pi.type = $${idx++}`;
      params.push(type);
    }
    if (tag) {
      where += ` AND $${idx++} = ANY(pi.tags)`;
      params.push(tag);
    }
    if (search) {
      where += ` AND (pi.name ILIKE $${idx} OR pi.description ILIKE $${idx})`;
      params.push(`%${search}%`);
      idx++;
    }

    const userIdParam = `$${idx}`;
    params.push(userId);

    const query = `
      SELECT
        pi.*,
        COALESCE(cc.cnt, 0) AS content_count,
        CASE
          WHEN pi.is_free THEN true
          WHEN ue.id IS NOT NULL THEN true
          WHEN oe.id IS NOT NULL THEN true
          ELSE false
        END AS user_has_access,
        CASE
          WHEN pi.is_free THEN 'free'
          WHEN ue.id IS NOT NULL THEN ue.source
          WHEN oe.id IS NOT NULL THEN oe.source
          ELSE NULL
        END AS access_source
      FROM platform_items pi
      LEFT JOIN (
        SELECT platform_item_id, COUNT(*) AS cnt FROM platform_item_contents GROUP BY platform_item_id
      ) cc ON cc.platform_item_id = pi.id
      LEFT JOIN (
        SELECT DISTINCT ON (platform_item_id) id, platform_item_id, source
        FROM user_entitlements
        WHERE user_id = ${userIdParam} AND is_active = true AND (expires_at IS NULL OR expires_at > now())
      ) ue ON ue.platform_item_id = pi.id
      LEFT JOIN (
        SELECT DISTINCT ON (oe2.platform_item_id) oe2.id, oe2.platform_item_id, oe2.source
        FROM org_entitlements oe2
        JOIN workspace_members wm ON wm.workspace_id = oe2.workspace_id AND wm.user_id = ${userIdParam}
        WHERE oe2.is_active = true AND (oe2.expires_at IS NULL OR oe2.expires_at > now())
      ) oe ON oe.platform_item_id = pi.id
      ${where}
      ORDER BY pi.sort_order ASC, pi.created_at DESC
    `;

    const result = await pool.query(query, params);
    res.json({
      items: result.rows.map((r) => ({
        id: r.id,
        type: r.type,
        name: r.name,
        slug: r.slug,
        description: r.description,
        thumbnail_url: r.thumbnail_url,
        preview_urls: r.preview_urls || [],
        is_free: r.is_free,
        price_cents: r.price_cents,
        tags: r.tags || [],
        user_has_access: r.user_has_access,
        access_source: r.access_source,
        content_count: parseInt(r.content_count),
        sort_order: r.sort_order,
        created_at: r.created_at,
      })),
    });
  } catch (err) {
    console.error("Platform library list error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to fetch platform items" } });
  }
});

router.get("/api/platform-library/:slug", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId || null;
    const { slug } = req.params;

    const itemResult = await pool.query(
      "SELECT * FROM platform_items WHERE slug = $1 AND is_published = true",
      [slug]
    );
    if (itemResult.rows.length === 0) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Item not found" } });
      return;
    }
    const item = itemResult.rows[0];

    const accessResult = await pool.query(`
      SELECT 'free' AS source FROM platform_items WHERE id = $1 AND is_free = true
      UNION ALL
      SELECT source FROM user_entitlements WHERE platform_item_id = $1 AND user_id = $2 AND is_active = true AND (expires_at IS NULL OR expires_at > now())
      UNION ALL
      SELECT oe.source FROM org_entitlements oe
      JOIN workspace_members wm ON wm.workspace_id = oe.workspace_id AND wm.user_id = $2
      WHERE oe.platform_item_id = $1 AND oe.is_active = true AND (oe.expires_at IS NULL OR oe.expires_at > now())
      LIMIT 1
    `, [item.id, userId]);

    const hasAccess = accessResult.rows.length > 0;
    const accessSource = hasAccess ? accessResult.rows[0].source : null;

    let contents: unknown[] = [];
    if (hasAccess) {
      const contentsResult = await pool.query(
        "SELECT * FROM platform_item_contents WHERE platform_item_id = $1 ORDER BY sort_order ASC",
        [item.id]
      );
      contents = contentsResult.rows;
    }

    const countResult = await pool.query(
      "SELECT COUNT(*) AS cnt FROM platform_item_contents WHERE platform_item_id = $1",
      [item.id]
    );

    res.json({
      item: {
        id: item.id,
        type: item.type,
        name: item.name,
        slug: item.slug,
        description: item.description,
        thumbnail_url: item.thumbnail_url,
        preview_urls: item.preview_urls || [],
        is_free: item.is_free,
        price_cents: item.price_cents,
        tags: item.tags || [],
        user_has_access: hasAccess,
        access_source: accessSource,
        content_count: parseInt(countResult.rows[0].cnt),
        sort_order: item.sort_order,
        created_at: item.created_at,
        contents,
      },
    });
  } catch (err) {
    console.error("Platform library detail error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to fetch platform item" } });
  }
});

router.post("/api/platform-library/save-to-space", requireAuth, async (req: AuthRequest, res: Response) => {
  const client = await pool.connect();
  let copiedFileBucket: string | null = null;
  let copiedFilePath: string | null = null;
  try {
    const userId = req.userId!;
    const { platform_item_content_id, destination, workspace_id } = req.body;

    if (!platform_item_content_id) {
      res.status(400).json({ error: { code: "MISSING_FIELD", message: "platform_item_content_id is required" } });
      return;
    }

    const contentResult = await pool.query(
      `SELECT pic.*, pi.id AS item_id, pi.is_free, pi.is_published
       FROM platform_item_contents pic
       JOIN platform_items pi ON pi.id = pic.platform_item_id
       WHERE pic.id = $1`,
      [platform_item_content_id]
    );
    if (contentResult.rows.length === 0 || !contentResult.rows[0].is_published) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Content not found" } });
      return;
    }

    const content = contentResult.rows[0];
    const itemId = content.item_id;

    if (!content.is_free) {
      if (destination === "org") {
        if (!workspace_id) {
          res.status(400).json({ error: { code: "MISSING_FIELD", message: "workspace_id is required for org destination" } });
          return;
        }
        const orgAccessResult = await pool.query(
          `SELECT 1 FROM org_entitlements WHERE workspace_id = $1 AND platform_item_id = $2 AND is_active = true AND (expires_at IS NULL OR expires_at > now())`,
          [workspace_id, itemId]
        );
        if (orgAccessResult.rows.length === 0) {
          res.status(403).json({ error: { code: "NO_ACCESS", message: "This workspace does not have access to this item" } });
          return;
        }
      } else {
        const accessResult = await pool.query(`
          SELECT 1 FROM user_entitlements WHERE platform_item_id = $1 AND user_id = $2 AND is_active = true AND (expires_at IS NULL OR expires_at > now())
          UNION ALL
          SELECT 1 FROM org_entitlements oe
          JOIN workspace_members wm ON wm.workspace_id = oe.workspace_id AND wm.user_id = $2
          WHERE oe.platform_item_id = $1 AND oe.is_active = true AND (oe.expires_at IS NULL OR oe.expires_at > now())
          LIMIT 1
        `, [itemId, userId]);

        if (accessResult.rows.length === 0) {
          res.status(403).json({ error: { code: "NO_ACCESS", message: "Unlock this item first" } });
          return;
        }
      }
    }

    if (destination === "org") {
      if (!workspace_id) {
        res.status(400).json({ error: { code: "MISSING_FIELD", message: "workspace_id is required for org destination" } });
        return;
      }
      const memberCheck = await pool.query(
        "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
        [workspace_id, userId]
      );
      if (memberCheck.rows.length === 0) {
        res.status(403).json({ error: { code: "NOT_MEMBER", message: "You're not a member of this workspace" } });
        return;
      }
      const allowedRoles = ["member", "admin", "owner"];
      if (!allowedRoles.includes(memberCheck.rows[0].role)) {
        res.status(403).json({ error: { code: "INSUFFICIENT_ROLE", message: "You must be at least a member to save to this workspace" } });
        return;
      }
    }

    let newFileUrl = content.file_url;
    const parsedUrl = content.file_url ? parseFileUrl(content.file_url) : null;
    if (parsedUrl) {
      const ext = path.extname(parsedUrl.path);
      const destBucket = destination === "org" ? `workspaces/${workspace_id}` : `users/${userId}`;
      const destPath = `saved/${uuidv4()}${ext}`;
      newFileUrl = await copyFile(parsedUrl.bucket, parsedUrl.path, destBucket, destPath);
      copiedFileBucket = destBucket;
      copiedFilePath = destPath;
    }

    await client.query("BEGIN");

    const contentType = content.content_type;
    let resultId: string;

    const isOrgSave = destination === "org" && workspace_id;

    if (contentType === "asset") {
      const assetType = content.file_type?.startsWith("video") ? "video" : "image";
      const result = await client.query(
        `INSERT INTO assets (user_id, workspace_id, type, source, name, file_url, file_type, metadata)
         VALUES ($1, $2, $3, 'platform', $4, $5, $6, $7)
         RETURNING id`,
        [userId, isOrgSave ? workspace_id : null, assetType, content.name, newFileUrl || '', content.file_type, content.metadata ?? {}]
      );
      resultId = result.rows[0].id;
    } else {
      const result = await client.query(
        `INSERT INTO assets (user_id, workspace_id, type, source, name, file_url, file_type, metadata)
         VALUES ($1, $2, 'image', 'platform', $3, $4, $5, $6)
         RETURNING id`,
        [userId, isOrgSave ? workspace_id : null, content.name, newFileUrl || '', content.file_type, { ...(content.metadata ?? {}), platform_content_type: contentType }]
      );
      resultId = result.rows[0].id;
    }

    await client.query("COMMIT");
    copiedFileBucket = null;
    copiedFilePath = null;
    res.status(201).json({ id: resultId });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (copiedFileBucket && copiedFilePath) {
      deleteFile(copiedFileBucket, copiedFilePath).catch((delErr: unknown) => {
        console.error("[platform] Failed to clean up orphaned R2 file after DB failure:", delErr);
      });
    }
    console.error("Save to space error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Couldn't save. Try again." } });
  } finally {
    client.release();
  }
});

router.get("/api/platform-library/entitlements/mine", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const result = await pool.query(
      `SELECT ue.*, row_to_json(pi.*) AS platform_item
       FROM user_entitlements ue
       JOIN platform_items pi ON pi.id = ue.platform_item_id
       WHERE ue.user_id = $1 AND ue.is_active = true`,
      [userId]
    );
    res.json({ entitlements: result.rows });
  } catch (err) {
    console.error("Entitlements error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to fetch entitlements" } });
  }
});

router.post("/api/admin/platform-library", requireAdmin, upload.single("thumbnail"), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const { type, name, description, slug, is_free, price_cents, tags, metadata } = req.body;

    if (!type || !name || !slug) {
      res.status(400).json({ error: { code: "MISSING_FIELDS", message: "type, name, and slug are required" } });
      return;
    }

    let thumbnailUrl = null;
    if (req.file) {
      const ext = path.extname(req.file.originalname) || ".png";
      thumbnailUrl = await saveFile("platform-library", `${slug}/thumbnail${ext}`, req.file.buffer);
    }

    const result = await pool.query(
      `INSERT INTO platform_items (type, name, description, slug, thumbnail_url, is_free, price_cents, tags, metadata, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        type, name, description || null, slug,
        thumbnailUrl, is_free === "true" || is_free === true,
        price_cents ? parseInt(price_cents) : null,
        tags ? (typeof tags === "string" ? JSON.parse(tags) : tags) : [],
        metadata ? (typeof metadata === "string" ? JSON.parse(metadata) : metadata) : {},
        userId,
      ]
    );
    res.status(201).json({ item: result.rows[0] });
  } catch (err: any) {
    if (err.code === "23505") {
      res.status(409).json({ error: { code: "DUPLICATE_SLUG", message: "An item with this slug already exists" } });
      return;
    }
    console.error("Admin create platform item error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to create item" } });
  }
});

router.put("/api/admin/platform-library/:id", requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const fields = req.body;
    const updates: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    const allowedFields = ["name", "description", "slug", "thumbnail_url", "is_free", "price_cents",
      "stripe_product_id", "stripe_price_id", "is_published", "sort_order", "tags", "metadata", "preview_urls"];

    for (const field of allowedFields) {
      if (fields[field] !== undefined) {
        updates.push(`${field} = $${idx++}`);
        values.push(fields[field]);
      }
    }

    if (updates.length === 0) {
      res.status(400).json({ error: { code: "NO_FIELDS", message: "No fields to update" } });
      return;
    }

    values.push(id);
    const result = await pool.query(
      `UPDATE platform_items SET ${updates.join(", ")} WHERE id = $${idx} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Item not found" } });
      return;
    }

    res.json({ item: result.rows[0] });
  } catch (err) {
    console.error("Admin update platform item error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to update item" } });
  }
});

router.delete("/api/admin/platform-library/:id", requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      "UPDATE platform_items SET is_published = false WHERE id = $1 RETURNING *",
      [id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Item not found" } });
      return;
    }
    res.json({ item: result.rows[0] });
  } catch (err) {
    console.error("Admin delete platform item error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to delete item" } });
  }
});

router.post("/api/admin/platform-library/:id/contents", requireAdmin, upload.single("file"), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { name, content_type, metadata } = req.body;

    if (!name || !content_type) {
      res.status(400).json({ error: { code: "MISSING_FIELDS", message: "name and content_type are required" } });
      return;
    }

    const itemResult = await pool.query("SELECT slug FROM platform_items WHERE id = $1", [id]);
    if (itemResult.rows.length === 0) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Item not found" } });
      return;
    }

    let fileUrl = null;
    let fileType = null;
    if (req.file) {
      const ext = path.extname(req.file.originalname);
      fileUrl = await saveFile("platform-library", `${itemResult.rows[0].slug}/contents/${uuidv4()}${ext}`, req.file.buffer);
      fileType = req.file.mimetype;
    }

    const result = await pool.query(
      `INSERT INTO platform_item_contents (platform_item_id, name, content_type, file_url, file_type, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [id, name, content_type, fileUrl, fileType, metadata ? (typeof metadata === "string" ? JSON.parse(metadata) : metadata) : {}]
    );
    res.status(201).json({ content: result.rows[0] });
  } catch (err) {
    console.error("Admin add content error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to add content" } });
  }
});

router.delete("/api/admin/platform-library/:id/contents/:contentId", requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { id, contentId } = req.params;
    const result = await pool.query(
      "DELETE FROM platform_item_contents WHERE id = $1 AND platform_item_id = $2 RETURNING *",
      [contentId, id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Content not found" } });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("Admin delete content error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to delete content" } });
  }
});

router.post("/api/admin/platform-library/grant", requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.userId!;
    const { platform_item_id, user_id, workspace_id, source } = req.body;

    if (!platform_item_id) {
      res.status(400).json({ error: { code: "MISSING_FIELD", message: "platform_item_id is required" } });
      return;
    }

    if (user_id) {
      const result = await pool.query(
        `INSERT INTO user_entitlements (user_id, platform_item_id, source, granted_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, platform_item_id) DO UPDATE SET is_active = true, granted_at = now()
         RETURNING *`,
        [user_id, platform_item_id, source || "grant", adminId]
      );
      res.status(201).json({ entitlement: result.rows[0] });
    } else if (workspace_id) {
      const result = await pool.query(
        `INSERT INTO org_entitlements (workspace_id, platform_item_id, source, granted_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (workspace_id, platform_item_id) DO UPDATE SET is_active = true, granted_at = now()
         RETURNING *`,
        [workspace_id, platform_item_id, source || "grant", adminId]
      );
      res.status(201).json({ entitlement: result.rows[0] });
    } else {
      res.status(400).json({ error: { code: "MISSING_FIELD", message: "user_id or workspace_id is required" } });
    }
  } catch (err) {
    console.error("Admin grant error:", err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to grant entitlement" } });
  }
});

export default router;
