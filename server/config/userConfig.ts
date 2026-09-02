/**
 * Local user configuration store — the desktop equivalent of "Replit Secrets".
 *
 * In the cloud build, provider API keys came from host-injected environment
 * variables. In the local build the user brings their OWN keys, entered in the
 * app's Settings panel and persisted (unencrypted) in a JSON file inside the
 * per-user data directory. Environment variables still work as a fallback, so
 * power users / CI can supply keys the old way.
 */
import fs from "node:fs";
import { CONFIG_PATH, ensureDataDir } from "./runtime.js";

export interface UserConfig {
  /** fal.ai API key — the core generation engine. */
  falKey?: string;
  /** Anthropic API key — optional, powers the AI agent + Brand IQ. */
  anthropicKey?: string;
  /** Optional override for the `claude` binary path (auto-detected otherwise). */
  claudeCodePath?: string;
  /** Which agent CLI drives the in-app operator. Default "claude". */
  operatorRunner?: "claude" | "codex";
}

type ConfigKey = keyof UserConfig;

let cache: UserConfig | null = null;

function load(): UserConfig {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    cache = parsed && typeof parsed === "object" ? (parsed as UserConfig) : {};
  } catch {
    cache = {};
  }
  return cache;
}

function persist(cfg: UserConfig): void {
  ensureDataDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  cache = cfg;
}

/** Full config object (config file merged view). */
export function getUserConfig(): UserConfig {
  return { ...load() };
}

/**
 * Apply a partial update. An empty string clears a key; `undefined` leaves it
 * unchanged. Returns the updated config.
 */
export function setUserConfig(patch: Partial<Record<ConfigKey, string>>): UserConfig {
  const cfg = { ...load() };
  for (const [key, value] of Object.entries(patch) as [ConfigKey, string | undefined][]) {
    if (value === undefined) continue;
    if (value === "") {
      delete cfg[key];
    } else {
      // ponytail: one narrow field (operatorRunner) is a union, not string; the
      // route validates it before it gets here.
      (cfg as Record<ConfigKey, string>)[key] = value.trim();
    }
  }
  persist(cfg);
  return { ...cfg };
}

/** fal.ai key: user config first, then FAL_KEY / VITE_FAL_KEY env fallback. */
export function getFalKey(): string | undefined {
  return load().falKey || process.env.FAL_KEY || process.env.VITE_FAL_KEY || undefined;
}

/** Anthropic key: user config first, then ANTHROPIC_API_KEY env fallback. */
export function getAnthropicKey(): string | undefined {
  return load().anthropicKey || process.env.ANTHROPIC_API_KEY || undefined;
}

/** Which CLI runs the operator. Unknown/unset falls back to Claude Code, so a
 *  hand-edited config can never leave the panel pointing at nothing. */
export function getOperatorRunner(): "claude" | "codex" {
  return load().operatorRunner === "codex" ? "codex" : "claude";
}

/** Optional explicit `claude` binary path override from config. */
export function getClaudeCodePath(): string | undefined {
  return load().claudeCodePath || process.env.MB_CLAUDE_PATH || undefined;
}

/** Mask a secret for display: keep the last 4 chars, e.g. "…a1b2". */
export function maskKey(key: string | undefined): string | null {
  if (!key) return null;
  const tail = key.slice(-4);
  return `…${tail}`;
}
