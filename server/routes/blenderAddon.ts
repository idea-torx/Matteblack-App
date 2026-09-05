/**
 * Install the Matteblack Blender add-on (blender/matteblack_addon.py) into the
 * user's Blender add-ons folder and switch it on.
 *
 *   GET  /api/setup/blender-addon  — { installed, path }
 *   POST /api/setup/blender-addon  — { ok, installedTo, enabled, log }
 */
import { Router } from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { requireAuth, type AuthRequest } from "../sessions.js";

const router = Router();

const USER_BLENDER = path.join(os.homedir(), "Library", "Application Support", "Blender");
const APP_BLENDER = "/Applications/Blender.app/Contents/MacOS/Blender";
const APP_RESOURCES = "/Applications/Blender.app/Contents/Resources";

/** Highest `<major>.<minor>` directory name, or null. */
export function pickVersionDir(names: string[]): string | null {
  const versions = names
    .filter((n) => /^\d+\.\d+$/.test(n))
    .sort((a, b) => {
      const [am, an] = a.split(".").map(Number);
      const [bm, bn] = b.split(".").map(Number);
      return am - bm || an - bn;
    });
  return versions.length ? versions[versions.length - 1] : null;
}

function ls(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}

/** The add-on lives beside the server bundle: repo root in dev, resources/app packaged. */
function addonSource(): string | null {
  return [
    path.join(import.meta.dirname, "..", "..", "blender", "matteblack_addon.py"),
    path.join(import.meta.dirname, "..", "blender", "matteblack_addon.py"),
  ].find((p) => fs.existsSync(p)) ?? null;
}

/** Where Blender reads user add-ons from. Falls back to the shipped app's
 *  version when the user dir does not exist yet. */
function addonsDir(): string | null {
  const version = pickVersionDir(ls(USER_BLENDER)) ?? pickVersionDir(ls(APP_RESOURCES));
  return version ? path.join(USER_BLENDER, version, "scripts", "addons") : null;
}

// ponytail: dup of doctor blender lookup, fold in when doctor lands
function blenderBin(): string | null {
  for (const dir of (process.env.PATH || "").split(":")) {
    if (dir && fs.existsSync(path.join(dir, "blender"))) return path.join(dir, "blender");
  }
  return fs.existsSync(APP_BLENDER) ? APP_BLENDER : null;
}

function installedPath(): string | null {
  const dir = addonsDir();
  if (!dir) return null;
  const p = path.join(dir, "matteblack_addon.py");
  return fs.existsSync(p) ? p : null;
}

router.get("/api/setup/blender-addon", requireAuth, (_req: AuthRequest, res) => {
  const p = installedPath();
  res.json({ installed: !!p, path: p ?? addonsDir() });
});

router.post("/api/setup/blender-addon", requireAuth, (_req: AuthRequest, res) => {
  const src = addonSource();
  const dir = addonsDir();
  if (!src) { res.status(500).json({ error: "Add-on file is missing from this build." }); return; }
  if (!dir) { res.status(400).json({ error: "Blender is not installed." }); return; }
  const installedTo = path.join(dir, "matteblack_addon.py");
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(src, installedTo);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Copy failed." });
    return;
  }
  const bin = blenderBin();
  if (!bin) { res.json({ ok: true, installedTo, enabled: false, log: "Blender binary not found — enable the add-on by hand." }); return; }
  execFile(bin, ["--background", "--python-expr",
    "import bpy; bpy.ops.preferences.addon_enable(module='matteblack_addon'); bpy.ops.wm.save_userpref()"],
    { timeout: 60_000 }, (err, stdout, stderr) => {
      res.json({ ok: true, installedTo, enabled: !err, log: `${stdout}${stderr}`.trim().slice(-2000) });
    });
});

export default router;
