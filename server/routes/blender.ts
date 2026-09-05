/**
 * The Blender panel's own routes — the sessions the agent bridge leaves behind
 * under <DATA_DIR>/blender/<slug>/, plus the harness defaults the user picks.
 *
 * Read-only listing, one spawn (open the .blend in Blender), one delete. The
 * runs themselves still go through /api/agent/blender/run.
 */
import { Router } from "express";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { requireAuth, type AuthRequest } from "../sessions.js";
import { DATA_DIR } from "../config/runtime.js";
import { resolveBin } from "../setup/doctor.js";
import { getBlenderConfig, setBlenderConfig, type BlenderConfig } from "../config/userConfig.js";
import { listSessions, SESSION_RE } from "../utils/blenderPath.js";

const router = Router();

/** Session dir for a slug, or null when the slug is not one. */
function sessionDir(id: string): string | null {
  if (!SESSION_RE.test(id)) return null;
  const root = path.join(DATA_DIR, "blender");
  const dir = path.join(root, id);
  return path.resolve(dir) === path.join(root, id) && fs.existsSync(dir) ? dir : null;
}

router.get("/api/blender/sessions", requireAuth, (_req: AuthRequest, res) => {
  res.json({ sessions: listSessions(path.join(DATA_DIR, "blender")), blender: resolveBin("blender").found });
});

router.post("/api/blender/sessions/:id/open", requireAuth, (req: AuthRequest, res) => {
  const dir = sessionDir(req.params.id);
  if (!dir) { res.status(404).json({ error: "No such session." }); return; }
  const bin = resolveBin("blender");
  if (!bin.found) { res.status(503).json({ error: "Blender isn't installed." }); return; }
  const child = spawn(bin.path, [path.join(dir, "scene.blend")], { detached: true, stdio: "ignore" });
  child.unref();
  res.json({ ok: true });
});

router.delete("/api/blender/sessions/:id", requireAuth, (req: AuthRequest, res) => {
  const dir = sessionDir(req.params.id);
  if (!dir) { res.status(404).json({ error: "No such session." }); return; }
  fs.rmSync(dir, { recursive: true, force: true });
  res.json({ ok: true });
});

router.get("/api/blender/config", requireAuth, (_req: AuthRequest, res) => {
  res.json(getBlenderConfig());
});

router.post("/api/blender/config", requireAuth, (req: AuthRequest, res) => {
  const b = (req.body ?? {}) as Partial<BlenderConfig>;
  res.json(setBlenderConfig({
    look: b.look === "lit" || b.look === "grey" ? b.look : undefined,
    width: Number(b.width) || undefined,
    height: Number(b.height) || undefined,
    fps: Number(b.fps) || undefined,
  }));
});

export default router;
