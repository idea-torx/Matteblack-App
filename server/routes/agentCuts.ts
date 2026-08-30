/**
 * Agent cuts — the operator writes the recipe for a finished piece into a local
 * per-project git repo, and reads back what it made before.
 *
 * Paired with `set_timeline`: that call lays the cut on the timeline, this one
 * records how it was made. The operator has no Write and no Bash, so the commit
 * happens here, server-side, on a tool call it can name but not improvise
 * around — same shape as `gh` brokering GitHub auth.
 */
import { Router, type Response, type NextFunction } from "express";
import { requireAuth, type AuthRequest } from "../sessions.js";
import { pool } from "../db.js";
import { getMcpToken } from "../mcpToken.js";
import { saveCut, listProjects, readIndex, readCut, type Cut } from "../cuts/cutStore.js";

const router = Router();

function requireMcpToken(req: AuthRequest, res: Response, next: NextFunction): void {
  if (process.env.MB_MCP_NO_TOKEN === "1") { next(); return; }
  const expected = getMcpToken();
  if (!expected) { res.status(503).json({ error: "MCP bridge not ready." }); return; }
  if (req.header("x-matteblack-token") !== expected) { res.status(401).json({ error: "Invalid MCP token." }); return; }
  next();
}

/**
 * The reusable half of a cut is its language, so a save also files that text in
 * the user's Prompts library (the `styles` table) where it can be dragged onto
 * a canvas later. The look block is the whole point of it — one description that
 * held a piece together — and shot 1 is the fallback when there wasn't one.
 * Best-effort: a cut is already committed to git by the time this runs, and
 * failing the save over a library row would lose the manifest for nothing.
 */
async function saveCutPrompt(userId: string, cut: Cut): Promise<boolean> {
  const text = (cut.look || cut.shots?.[0]?.prompt || "").trim();
  const name = (cut.title || "").trim();
  if (!text || !name) return false;
  try {
    // Same name, same user, same text = the same prompt saved twice (re-saving a
    // cut after a tweak). A changed look is a new row, on purpose — the old one
    // may already be on a canvas.
    const dupe = await pool.query(
      "SELECT id FROM styles WHERE user_id = $1 AND name = $2 AND prompt = $3 LIMIT 1",
      [userId, name, text],
    );
    if (dupe.rows.length) return false;
    await pool.query("INSERT INTO styles (user_id, name, prompt) VALUES ($1, $2, $3)", [userId, name, text]);
    return true;
  } catch (err) {
    console.error("[agent/cut] prompt save failed:", err);
    return false;
  }
}

/** Save the cut: one manifest, one commit, index rebuilt, prompt filed. */
router.post("/api/agent/cut", requireMcpToken, requireAuth, async (req: AuthRequest, res) => {
  try {
    const cut = (req.body ?? {}) as Cut;
    const saved = await saveCut(cut);
    const promptSaved = await saveCutPrompt(req.userId!, cut);
    res.json({ ...saved, promptSaved });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save the cut.";
    // A validation message is the agent's to act on; anything else is ours.
    if (/required|at least one/i.test(message)) { res.status(400).json({ error: message }); return; }
    console.error("[agent/cut] save failed:", err);
    res.status(500).json({ error: message });
  }
});

/** Recall: projects, one project's index, or one manifest in full. */
router.get("/api/agent/cuts", requireMcpToken, requireAuth, (req: AuthRequest, res) => {
  const project = typeof req.query.project === "string" ? req.query.project : "";
  const file = typeof req.query.file === "string" ? req.query.file : "";
  if (!project) { res.json({ projects: listProjects() }); return; }
  if (file) {
    const body = readCut(project, file);
    if (!body) { res.status(404).json({ error: `No cut "${file}" in project "${project}".` }); return; }
    res.json({ project, file, body });
    return;
  }
  const index = readIndex(project);
  if (index === null) { res.status(404).json({ error: `No cuts saved for project "${project}".` }); return; }
  res.json({ project, index });
});

export default router;
