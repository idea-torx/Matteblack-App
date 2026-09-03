/**
 * Skill library API. Serves both the in-app Skills panel (session auth) and the
 * MCP bridge (per-boot token) — Claude reads skills to follow them and writes
 * skills back when the user says "save that as a skill".
 */
import { Router, type Response, type NextFunction } from "express";
import { requireAuth, type AuthRequest } from "../sessions.js";
import { getMcpToken } from "../mcpToken.js";
import { listSkills, readSkill, writeSkill, deleteSkill, slugify, readPins, setPin, SKILLS_DIR,
  listSkillHistory, readSkillVersion, readActors, reviewMayWrite, mergeFrontmatter,
  recordSkillUse, skillUsage, type Actor, type SkillMeta } from "../skills/skillStore.js";
import { pool } from "../db.js";
import { BUILTIN_SKILLS, isBuiltinSkill, markSeeded } from "../skills/builtin.js";

const router = Router();

/** Who is writing. The MCP bridge stamps `operator` on a live turn and `review`
 *  on the after-turn pass; anything else is the user's own panel. */
function actorOf(req: AuthRequest): Actor {
  const h = req.header("x-falforge-actor");
  return h === "operator" || h === "review" ? h : "user";
}

/** Either the paired MCP process (loopback + per-boot token) or a signed-in
 *  user. Skills are on-disk documents in the user's own data dir, so there's
 *  nothing further to scope them to. */
function allowMcpOrUser(req: AuthRequest, res: Response, next: NextFunction): void {
  const expected = getMcpToken();
  if (process.env.MB_MCP_NO_TOKEN === "1") { next(); return; }
  if (expected && req.header("x-matteblack-token") === expected) { next(); return; }
  requireAuth(req, res, next);
}

/** Does this skill match a free-text query? Title, description, tags and body —
 *  the body because a search for a model name should find the skill using it. */
function matches(s: SkillMeta, q: string): boolean {
  const hay = `${s.title} ${s.description} ${s.tags.join(" ")} ${readSkill(s.slug)?.body ?? ""}`.toLowerCase();
  return hay.includes(q);
}

router.get("/api/skills", allowMcpOrUser, (req: AuthRequest, res) => {
  // `system` marks a skill the app ships — editable like any other, but with a
  // factory version to reset back to.
  const pins = readPins();
  const usage = skillUsage();
  const q = String(req.query.q ?? "").trim().toLowerCase();
  const kind = String(req.query.kind ?? "").trim();
  let skills = listSkills();
  if (kind) skills = skills.filter((s) => s.kind === kind);
  if (q) skills = skills.filter((s) => matches(s, q));
  res.json({
    skills: skills.map((s) => ({
      ...s,
      system: isBuiltinSkill(s.slug),
      pinned: pins.includes(s.slug),
      uses: usage[s.slug]?.uses ?? 0,
      lastUsed: usage[s.slug]?.lastUsed || undefined,
    })),
    dir: SKILLS_DIR,
  });
});

router.get("/api/skills/:slug", allowMcpOrUser, (req: AuthRequest, res) => {
  const skill = readSkill(req.params.slug);
  if (!skill) { res.status(404).json({ error: "No such skill." }); return; }
  // Only the MCP bridge's get_skill counts as a use — the panel opening a file
  // for editing is not the skill being followed.
  if (req.header("x-matteblack-token") || process.env.MB_MCP_NO_TOKEN === "1") recordSkillUse(skill.slug);
  res.json({ ...skill, system: isBuiltinSkill(skill.slug), pinned: readPins().includes(skill.slug) });
});

router.put("/api/skills/:slug", allowMcpOrUser, (req: AuthRequest, res) => {
  const payload = (req.body ?? {}) as { body?: unknown; meta?: unknown };
  if (!slugify(req.params.slug)) { res.status(400).json({ error: "Invalid skill name." }); return; }
  const meta = payload.meta && typeof payload.meta === "object" ? payload.meta as Record<string, unknown> : null;
  // `body` alone rewrites the markdown; `meta` alone edits the header of what is
  // already on disk, so the panel never has to hand-write YAML.
  let text = typeof payload.body === "string" ? payload.body : meta ? readSkill(req.params.slug)?.body ?? "" : null;
  if (text === null) { res.status(400).json({ error: "Expected a markdown `body` string or a `meta` object." }); return; }
  if (meta) text = mergeFrontmatter(text, meta);
  const body = { body: text };
  // 1MB: a skill is a script, not an asset. Bounded so a runaway agent write
  // can't fill the user's disk one PUT at a time.
  if (body.body.length > 1_000_000) { res.status(413).json({ error: "Skill is too large (1MB max)." }); return; }
  const actor = actorOf(req);
  const slug = slugify(req.params.slug);
  const existing = readSkill(slug);
  // The after-turn review pass runs with nobody watching, so it is the one
  // writer that has to keep its hands off documents the user owns. A live
  // operator turn is not restricted: the user is right there.
  if (actor === "review" && existing) {
    const factory = BUILTIN_SKILLS[slug];
    const ok = reviewMayWrite({
      pinned: readPins().includes(slug),
      lastActor: readActors()[slug],
      isFactoryText: !!factory && existing.body.trim() === factory.trim(),
    });
    if (!ok) { res.status(409).json({ error: `"${slug}" is pinned or hand-edited by the user — ask before changing it.` }); return; }
  }
  res.json(writeSkill(req.params.slug, body.body, actor));
});

/** Every previous body, newest first. The panel restores from these. */
router.get("/api/skills/:slug/history", allowMcpOrUser, (req: AuthRequest, res) => {
  res.json({ versions: listSkillHistory(req.params.slug) });
});

router.post("/api/skills/:slug/restore", allowMcpOrUser, (req: AuthRequest, res) => {
  const version = String((req.body ?? {}).version ?? "");
  const body = readSkillVersion(req.params.slug, version);
  if (body === null) { res.status(404).json({ error: "No such version." }); return; }
  // Goes through writeSkill, so the restore itself is versioned and undoable.
  res.json({ ...writeSkill(req.params.slug, body, actorOf(req)), body });
});

/** Pin/unpin: pinned skills ride along with every operator run. */
router.post("/api/skills/:slug/pin", allowMcpOrUser, (req: AuthRequest, res) => {
  const slug = slugify(req.params.slug);
  if (!readSkill(slug)) { res.status(404).json({ error: "No such skill." }); return; }
  res.json({ pinned: setPin(slug, req.body?.pinned !== false).includes(slug) });
});

/** Restore a built-in skill to its shipped text. */
router.post("/api/skills/:slug/reset", allowMcpOrUser, (req: AuthRequest, res) => {
  const body = BUILTIN_SKILLS[slugify(req.params.slug)];
  if (!body) { res.status(404).json({ error: "That skill isn't a built-in." }); return; }
  const meta = writeSkill(req.params.slug, body);
  markSeeded(meta.slug, body);
  res.json({ ...meta, body });
});

// ---------------------------------------------------------------------------
// Registry — publishing a skill to the shared platform library, and installing
// one from it. Skills are free: they ship as `is_free`, and the price_cents /
// user_entitlements columns on these tables stay null.
// ponytail: the billing hooks (price_cents, stripe ids, entitlements) already
// exist in platform_items/user_entitlements and are deliberately unwired here —
// wire them the way styles do if skills ever get sold.
// ---------------------------------------------------------------------------

/** Publish (or re-publish) this skill as a platform_item of type `skill`. */
router.post("/api/skills/:slug/publish", requireAuth, async (req: AuthRequest, res) => {
  const skill = readSkill(req.params.slug);
  if (!skill) { res.status(404).json({ error: "No such skill." }); return; }
  const { rows } = await pool.query(
    `INSERT INTO platform_items (type, name, description, slug, thumbnail_url, preview_urls, metadata, tags, is_free, is_published, created_by)
     VALUES ('skill', $1, $2, $3, $4, $5, $6, $7, true, $8, $9)
     ON CONFLICT (slug) DO UPDATE SET
       name = EXCLUDED.name, description = EXCLUDED.description, thumbnail_url = EXCLUDED.thumbnail_url,
       preview_urls = EXCLUDED.preview_urls, metadata = EXCLUDED.metadata, tags = EXCLUDED.tags,
       is_published = EXCLUDED.is_published, updated_at = now()
     RETURNING id, is_published`,
    [skill.title, skill.description, skill.slug, skill.cover ?? null, skill.examples,
      JSON.stringify({ kind: skill.kind, version: skill.version, author: skill.author ?? null }),
      skill.tags, skill.visibility === "public", req.userId],
  );
  const item = rows[0] as { id: string; is_published: boolean };
  // One content row holds the markdown itself, so installing is a single read.
  await pool.query("DELETE FROM platform_item_contents WHERE platform_item_id = $1", [item.id]);
  await pool.query(
    `INSERT INTO platform_item_contents (platform_item_id, name, content_type, metadata)
     VALUES ($1, $2, 'skill', $3)`,
    [item.id, skill.title, JSON.stringify({ markdown: skill.body, version: skill.version })],
  );
  res.json({ itemId: item.id, published: item.is_published, version: skill.version });
});

/** Copy a published registry skill into the local library. */
router.post("/api/skills/install", requireAuth, async (req: AuthRequest, res) => {
  const { itemId, slug } = (req.body ?? {}) as { itemId?: string; slug?: string };
  if (!itemId && !slug) { res.status(400).json({ error: "Expected `itemId` or `slug`." }); return; }
  const { rows } = await pool.query(
    `SELECT pi.id, pi.slug, pi.metadata, c.metadata AS content
       FROM platform_items pi
       LEFT JOIN platform_item_contents c ON c.platform_item_id = pi.id AND c.content_type = 'skill'
      WHERE pi.type = 'skill' AND pi.is_published = true AND ${itemId ? "pi.id = $1" : "pi.slug = $1"}
      LIMIT 1`,
    [itemId || slug],
  );
  if (!rows.length) { res.status(404).json({ error: "No such published skill." }); return; }
  const row = rows[0] as { id: string; slug: string; metadata: Record<string, unknown>; content: { markdown?: string; version?: string } | null };
  const markdown = row.content?.markdown;
  if (!markdown) { res.status(404).json({ error: "That registry item has no markdown." }); return; }
  const version = String(row.content?.version ?? row.metadata?.version ?? "1");
  const existing = readSkill(row.slug);
  const source = `registry/${row.id}`;
  if (existing?.source === source && existing.version === version) { res.json({ slug: row.slug, status: "current" }); return; }
  const meta = writeSkill(row.slug, mergeFrontmatter(markdown, { source, version }), "user");
  res.json({ slug: meta.slug, status: existing ? "updated" : "installed", version });
});

router.delete("/api/skills/:slug", allowMcpOrUser, (req: AuthRequest, res) => {
  res.json({ deleted: deleteSkill(req.params.slug) });
});

export default router;
