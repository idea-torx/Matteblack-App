/**
 * Connector routes — Settings → Connectors (see server/operator/connectors.ts).
 *
 *   GET  /api/connectors         — the user's MCP servers + the catalog
 *   POST /api/connectors/add     — register a catalog entry with both CLIs
 *   POST /api/connectors/login   — start the CLI's own OAuth for one server
 *   POST /api/connectors/enable  — hand one server to the operator, or take it back
 *   POST /api/connectors/higgsfield/setup — install/sign in the Higgsfield CLI, mirror its skills
 */
import { Router } from "express";
import { requireAuth, type AuthRequest } from "../sessions.js";
import { CATALOG, addConnector, listConnectors, loginConnector } from "../operator/connectors.js";
import { setConnectorEnabled } from "../config/userConfig.js";
import { higgsfieldStatus, setupHiggsfield, syncHiggsfieldSkills } from "../operator/higgsfield.js";

const router = Router();

router.get("/api/connectors", requireAuth, async (_req: AuthRequest, res) => {
  const [connectors, higgsfield] = await Promise.all([listConnectors(), higgsfieldStatus()]);
  res.json({ connectors, catalog: CATALOG, higgsfield });
});

/** Higgsfield CLI: install/sign in happens in Terminal (interactive OAuth);
 *  the skills mirror runs here. Idempotent — the button doubles as "update". */
router.post("/api/connectors/higgsfield/setup", requireAuth, async (_req: AuthRequest, res) => {
  const status = await higgsfieldStatus();
  if (!status.installed || !status.loggedIn) setupHiggsfield();
  res.json({ ok: true, ...(await syncHiggsfieldSkills()) });
});

router.post("/api/connectors/add", requireAuth, async (req: AuthRequest, res) => {
  // The client sends a catalog id, never a URL: nothing outside CATALOG can be
  // registered from here.
  const id = (req.body || {}).id;
  if (typeof id !== "string" || !CATALOG.some((c) => c.id === id)) {
    res.status(400).json({ error: "unknown connector" });
    return;
  }
  res.json(await addConnector(id));
});

/** Both mutating routes below name an EXISTING server, so re-listing is the
 *  validation: a name the CLIs don't know is not something we act on. */
async function resolve(body: unknown): Promise<{ runner: "claude" | "codex" | "opencode"; name: string } | null> {
  const { runner, name } = (body || {}) as { runner?: unknown; name?: unknown };
  if ((runner !== "claude" && runner !== "codex" && runner !== "opencode") || typeof name !== "string") return null;
  const known = await listConnectors();
  return known.some((c) => c.runner === runner && c.name === name) ? { runner, name } : null;
}

router.post("/api/connectors/login", requireAuth, async (req: AuthRequest, res) => {
  const hit = await resolve(req.body);
  if (!hit) { res.status(400).json({ error: "unknown server" }); return; }
  loginConnector(hit.runner, hit.name);
  res.json({ ok: true });
});

router.post("/api/connectors/enable", requireAuth, async (req: AuthRequest, res) => {
  const hit = await resolve(req.body);
  if (!hit) { res.status(400).json({ error: "unknown server" }); return; }
  res.json({ ok: true, enabled: setConnectorEnabled(hit.runner, hit.name, (req.body || {}).enabled === true) });
});

export default router;
