/**
 * Pure filesystem helpers for the Blender session tree under <dataDir>/blender.
 *
 * The sandbox for importing a Blender output by local path: only files the
 * bridge itself wrote, under <dataDir>/blender/, may become canvas nodes.
 *
 * Both sides are resolved through symlinks first, so `../` in the name and a
 * symlink pointing out of the tree both land outside the root and are refused.
 */
import fs from "node:fs";
import path from "node:path";

export function underBlenderDir(
  file: string,
  root: string,
  realpath: (p: string) => string = fs.realpathSync,
): { path: string } | { error: string } {
  let real: string;
  try { real = realpath(file); } catch { return { error: `No such file: ${file}` }; }
  let base: string;
  try { base = realpath(root); } catch { return { error: `No Blender session directory yet: ${root}` }; }
  if (real !== base && !real.startsWith(base + path.sep)) {
    return { error: `Refusing to import from outside ${base}` };
  }
  return { path: real };
}

/** A session slug: the only shape the bridge and the panel will touch. */
export const SESSION_RE = /^[a-z0-9-]{1,40}$/;

export type BlenderSession = {
  id: string;
  updatedAt: string;
  steps: number;
  /** Newest render filenames, up to 4. out/ is not served, so names only. */
  renders: string[];
  renderCount: number;
};

const ls = (dir: string): string[] => { try { return fs.readdirSync(dir); } catch { return []; } };
const mtime = (p: string): number => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };

/** Every session dir under `root` that actually holds a scene, newest first. */
export function listSessions(root: string): BlenderSession[] {
  return ls(root)
    .filter((id) => SESSION_RE.test(id) && fs.existsSync(path.join(root, id, "scene.blend")))
    .map((id) => {
      const dir = path.join(root, id);
      const outDir = path.join(dir, "out");
      const renders = ls(outDir)
        .filter((f) => !f.startsWith("."))
        .sort((a, b) => mtime(path.join(outDir, b)) - mtime(path.join(outDir, a)));
      return {
        id,
        updatedAt: new Date(mtime(path.join(dir, "scene.blend"))).toISOString(),
        steps: ls(dir).filter((f) => /^step-\d+\.py$/.test(f)).length,
        renders: renders.slice(0, 4),
        renderCount: renders.length,
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
