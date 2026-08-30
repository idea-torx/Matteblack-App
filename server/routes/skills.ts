/**
 * Skill library API. Serves both the in-app Skills panel (session auth) and the
 * MCP bridge (per-boot token) — Claude reads skills to follow them and writes
 * skills back when the user says "save that as a skill".
 */
import { Router, type Response, type NextFunction } from "express";
import { requireAuth, type AuthRequest } from "../sessions.js";
import { getMcpToken } from "../mcpToken.js";
import { listSkills, readSkill, writeSkill, deleteSkill, slugify, readPins, setPin, SKILLS_DIR } from "../skills/skillStore.js";
import { BUILTIN_SKILLS, isBuiltinSkill, markSeeded } from "../skills/builtin.js";

const router = Router();

/** Either the paired MCP process (loopback + per-boot token) or a signed-in
 *  user. Skills are on-disk documents in the user's own data dir, so there's
 *  nothing further to scope them to. */
function allowMcpOrUser(req: AuthRequest, res: Response, next: NextFunction): void {
  const expected = getMcpToken();
  if (process.env.MB_MCP_NO_TOKEN === "1") { next(); return; }
  if (expected && req.header("x-matteblack-token") === expected) { next(); return; }
  requireAuth(req, res, next);
}

router.get("/api/skills", allowMcpOrUser, (_req: AuthRequest, res) => {
  // `system` marks a skill the app ships — editable like any other, but with a
  // factory version to reset back to.
  const pins = readPins();
  res.json({
    skills: listSkills().map((s) => ({ ...s, system: isBuiltinSkill(s.slug), pinned: pins.includes(s.slug) })),
    dir: SKILLS_DIR,
  });
});

router.get("/api/skills/:slug", allowMcpOrUser, (req: AuthRequest, res) => {
  const skill = readSkill(req.params.slug);
  if (!skill) { res.status(404).json({ error: "No such skill." }); return; }
  res.json({ ...skill, system: isBuiltinSkill(skill.slug), pinned: readPins().includes(skill.slug) });
});

router.put("/api/skills/:slug", allowMcpOrUser, (req: AuthRequest, res) => {
  const body = (req.body ?? {}) as { body?: unknown };
  if (typeof body.body !== "string") { res.status(400).json({ error: "Expected a markdown `body` string." }); return; }
  if (!slugify(req.params.slug)) { res.status(400).json({ error: "Invalid skill name." }); return; }
  // 1MB: a skill is a script, not an asset. Bounded so a runaway agent write
  // can't fill the user's disk one PUT at a time.
  if (body.body.length > 1_000_000) { res.status(413).json({ error: "Skill is too large (1MB max)." }); return; }
  res.json(writeSkill(req.params.slug, body.body));
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

router.delete("/api/skills/:slug", allowMcpOrUser, (req: AuthRequest, res) => {
  res.json({ deleted: deleteSkill(req.params.slug) });
});

export default router;
