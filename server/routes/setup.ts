/**
 * Setup routes — the in-app installer for the local components the app shells
 * out to (see server/setup/doctor.ts).
 *
 *   GET  /api/setup/doctor   — one row per component
 *   POST /api/setup/install  — open that component's install command in Terminal
 */
import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { requireAuth, type AuthRequest } from "../sessions.js";
import { DATA_DIR, ensureDataDir } from "../config/runtime.js";
import { doctor } from "../setup/doctor.js";
import { probeFalKey } from "../fal.js";

const router = Router();

router.get("/api/setup/doctor", requireAuth, (_req: AuthRequest, res) => {
  res.json({ rows: doctor() });
});

/** Installers want a real terminal: sudo prompts, progress, and a window the
 *  user can read. We only ever run OUR command for a known id — the client
 *  sends an id, never a command. */
router.post("/api/setup/install", requireAuth, (req: AuthRequest, res) => {
  const id = (req.body || {}).id as unknown;
  const row = doctor().find((r) => r.id === id);
  if (!row || !row.install) {
    res.status(400).json({ error: "unknown or uninstallable component" });
    return;
  }
  ensureDataDir();
  const script = path.join(DATA_DIR, `install-${row.id}.command`);
  fs.writeFileSync(
    script,
    `#!/bin/bash\nexport PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"\n${row.install}\necho\necho "Done — switch back to Fal Forge."\n`,
    { mode: 0o755 },
  );
  fs.chmodSync(script, 0o755);
  execFile("open", ["-a", "Terminal", script], (err) => {
    if (err) console.error("[setup] failed to open Terminal:", err);
  });
  res.json({ ok: true });
});

/** Settings → Setup: is the fal key saved and accepted? Same probe as the
 *  operator's check_setup tool. */
router.get("/api/setup/fal-check", requireAuth, async (_req: AuthRequest, res) => {
  res.json(await probeFalKey());
});

export default router;
