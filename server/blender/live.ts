import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BRIDGE_PY } from "./bridge.js";

// One visible Blender owns a session. Files are the local mailbox; no extra
// server, sockets, or Python dependencies. A PID survives an app restart.
export function livePid(dir: string): number | null {
  try {
    const { pid } = JSON.parse(fs.readFileSync(path.join(dir, "live.json"), "utf8"));
    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);
    return pid;
  } catch { return null; }
}

export function openLiveBlender(bin: string, dir: string): void {
  if (livePid(dir)) return;
  fs.mkdirSync(dir, { recursive: true });
  const bridge = path.join(dir, "bridge.py");
  fs.writeFileSync(bridge, BRIDGE_PY);
  const blend = path.join(dir, "scene.blend");
  const addon = [
    path.join(import.meta.dirname, "../../blender/matteblack_addon.py"),
    path.join(import.meta.dirname, "../blender/matteblack_addon.py"),
  ].find((p) => fs.existsSync(p));
  const log = fs.openSync(path.join(dir, "live.log"), "a");
  try {
    const child = spawn(bin, [
      ...(fs.existsSync(blend) ? [blend] : ["--factory-startup"]),
      "--python", bridge, "--", "--live", dir, addon ?? "",
    ], { detached: true, stdio: ["ignore", log, log] });
    child.on("error", (err) => {
      fs.appendFileSync(path.join(dir, "live.log"), `\n${err.message}\n`);
    });
    child.unref();
    if (child.pid) fs.writeFileSync(path.join(dir, "live.json"), JSON.stringify({ pid: child.pid }));
  } finally { fs.closeSync(log); }
}

export async function runLiveStep<T>(bin: string, dir: string, command: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const wasAlive = livePid(dir);
  if (!wasAlive) {
    // Abandoned queued work is never replayed after a crashed/closed window.
    fs.rmSync(path.join(dir, "command.json"), { force: true });
    fs.rmSync(path.join(dir, "running.json"), { force: true });
  }
  openLiveBlender(bin, dir);
  const pending = path.join(dir, "command.json");
  const running = path.join(dir, "running.json");
  if (fs.existsSync(pending) || fs.existsSync(running)) {
    throw new Error("Blender still has a step pending. Finish or undo it in the visible window before retrying.");
  }
  const id = String(command.id);
  const result = path.join(dir, `result-${id}.json`);
  const temp = pending + ".tmp";
  // Expiry prevents an abandoned queued step from executing after a long modal dialog.
  fs.writeFileSync(temp, JSON.stringify({ ...command, expires: Date.now() + 15 * 60_000 }));
  fs.renameSync(temp, pending);
  try {
    const started = Date.now();
    const deadline = started + 15 * 60_000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (fs.existsSync(result)) return JSON.parse(fs.readFileSync(result, "utf8")) as T;
      const state = JSON.parse(fs.readFileSync(path.join(dir, "live.json"), "utf8"));
      if (!state.ready && Date.now() - started > 30_000) throw new Error("Blender opened but its live bridge did not start. Check live.log in the session directory.");
      if (!livePid(dir)) throw new Error("The visible Blender session closed. Its last saved scene and checkpoints are retained.");
      await delay(250, undefined, { signal });
    }
    throw new Error("Blender is still busy. Check its visible window; an executing Python step must finish before another can start.");
  } finally {
    // Never kill the artist's Blender. A queued step can be cancelled; an
    // executing bpy call is synchronous and must return before the UI responds.
    try {
      const queued = JSON.parse(fs.readFileSync(pending, "utf8"));
      if (queued.id === command.id) fs.rmSync(pending);
    } catch { /* already claimed */ }
  }
}
