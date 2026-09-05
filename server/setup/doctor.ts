/**
 * Setup doctor — which local components the app needs, and how to install the
 * missing ones. macOS only for now.
 *
 * The packaged Electron app inherits a minimal PATH (no ~/.zshrc), so every
 * probe searches the known install dirs explicitly, the way the operator
 * runners already do for `claude`/`codex`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveClaudeBinary } from "../operator/runners/claude.js";
import { resolveCodexBinary } from "../operator/runners/codex.js";
import { resolveOpencodeBinary } from "../operator/runners/opencode.js";

export const COMPONENT_IDS = ["brew", "git", "ffmpeg", "blender", "claude", "codex", "opencode"] as const;
export type ComponentId = (typeof COMPONENT_IDS)[number];

export type DoctorRow = {
  id: ComponentId;
  label: string;
  found: boolean;
  path: string;
  /** Shell command the Install button runs, or null when we can't offer one. */
  install: string | null;
  note?: string;
};

const HOME = os.homedir();

/** Known install dirs, most-specific first; PATH is appended as a fallback. */
const CANDIDATES: Record<string, string[]> = {
  brew: ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"],
  git: ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"],
  ffmpeg: ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"],
  ffprobe: ["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe", "/usr/bin/ffprobe"],
  blender: ["/Applications/Blender.app/Contents/MacOS/Blender", "/opt/homebrew/bin/blender", "/usr/local/bin/blender"],
  npm: ["/opt/homebrew/bin/npm", "/usr/local/bin/npm", path.join(HOME, ".npm-global", "bin", "npm")],
};

/** Resolve one binary. Falls back to the bare name so a spawn can still try PATH. */
export function resolveBin(id: string): { path: string; found: boolean } {
  if (id === "claude") return resolveClaudeBinary();
  if (id === "codex") return resolveCodexBinary();
  if (id === "opencode") return resolveOpencodeBinary();
  const fromPath = (process.env.PATH || "").split(path.delimiter).filter(Boolean).map((d) => path.join(d, id));
  for (const c of [...(CANDIDATES[id] || []), ...fromPath]) {
    try { if (fs.existsSync(c)) return { path: c, found: true }; } catch { /* unreadable */ }
  }
  return { path: id, found: false };
}

/** Resolved path for a binary we shell out to (ffmpeg/ffprobe/git). */
export const bin = (id: string): string => resolveBin(id).path;

const BREW_FIRST = "Install Homebrew first";

const BREW_INSTALL =
  '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';

/**
 * One row per component. `resolve` is injectable so the install-command logic
 * can be tested without real binaries.
 */
export function doctor(resolve: (id: string) => { path: string; found: boolean } = resolveBin): DoctorRow[] {
  const bins = Object.fromEntries(
    [...COMPONENT_IDS, "npm"].map((id) => [id, resolve(id)]),
  ) as Record<string, { path: string; found: boolean }>;
  const brew = bins.brew.found;

  const row = (id: ComponentId, label: string, install: string | null, note?: string): DoctorRow => ({
    id, label, found: bins[id].found, path: bins[id].path, install, note,
  });

  return [
    row("brew", "Homebrew", BREW_INSTALL, "Package manager used to install the rest"),
    row("git", "Git", "xcode-select --install", "Comes with Xcode Command Line Tools"),
    row("ffmpeg", "FFmpeg", brew ? "brew install ffmpeg" : null, brew ? "Needed for video tails and export" : BREW_FIRST),
    row("blender", "Blender", brew ? "brew install --cask blender" : null, brew ? "Grey-box 3D scenes and playblasts for the agent" : BREW_FIRST),
    row("claude", "Claude Code CLI", "curl -fsSL https://claude.ai/install.sh | bash"),
    row(
      "codex",
      "OpenAI Codex CLI",
      brew ? "brew install --cask codex" : bins.npm.found ? "npm i -g @openai/codex" : null,
      brew || bins.npm.found ? undefined : BREW_FIRST,
    ),
    row("opencode", "OpenCode CLI", "curl -fsSL https://opencode.ai/install | bash"),
  ];
}
