/**
 * Higgsfield as a second generation route: the user's own `higgsfield` CLI
 * (subscription login, no key in this app) plus the official skills repo
 * mirrored into the skill store so the operator can read them.
 *
 * The operator never gets a shell: it calls the `higgsfield` MCP tool with an
 * argument list, and the MCP process runs the CLI (server/mcp/index.ts).
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR, ensureDataDir } from "../config/runtime.js";
import { cleanEnv } from "./claudeOperator.js";
import { writeSkill } from "../skills/skillStore.js";

const SKILLS_REPO = "https://github.com/higgsfield-ai/skills.git";
const SKILLS_DIR = path.join(DATA_DIR, "higgsfield-skills");
/** The media skills. brandkit/websites/game-generation need a shell and python — not this app's job. */
const SKILL_SET = ["generate", "soul-id", "product-photoshoot", "marketplace-cards", "video-explainer", "youtube-thumbnail"];

export function higgsfieldBinary(): string | null {
  const home = os.homedir();
  for (const c of [path.join(home, ".local", "bin", "higgsfield"), "/opt/homebrew/bin/higgsfield", "/usr/local/bin/higgsfield", path.join(home, ".npm-global", "bin", "higgsfield")]) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

export interface HiggsfieldStatus { installed: boolean; loggedIn: boolean; account: string; skills: number }

export function higgsfieldStatus(): Promise<HiggsfieldStatus> {
  const bin = higgsfieldBinary();
  const skills = SKILL_SET.filter((n) => fs.existsSync(path.join(SKILLS_DIR, `higgsfield-${n}`, "SKILL.md"))).length;
  if (!bin) return Promise.resolve({ installed: false, loggedIn: false, account: "", skills });
  return new Promise((resolve) => {
    execFile(bin, ["account", "status", "--no-color"], { env: cleanEnv(), timeout: 20_000 }, (err, stdout, stderr) => {
      const out = `${stdout}${stderr}`.trim();
      const loggedIn = !err && !/session expired|not authenticated/i.test(out);
      resolve({ installed: true, loggedIn, account: loggedIn ? out.split("\n")[0].slice(0, 120) : "", skills });
    });
  });
}

/** Install (to ~/.local, no sudo) and/or sign in — both interactive, so Terminal. */
export function setupHiggsfield(): void {
  ensureDataDir();
  const script = path.join(DATA_DIR, "higgsfield-setup.command");
  fs.writeFileSync(
    script,
    `#!/bin/bash\nexport PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/.npm-global/bin:$PATH"\n` +
      `command -v higgsfield >/dev/null || curl -fsSL https://raw.githubusercontent.com/higgsfield-ai/cli/main/install.sh | sh -s -- --prefix=$HOME/.local\n` +
      `higgsfield account status || higgsfield auth login\n`,
    { mode: 0o755 },
  );
  execFile("open", ["-a", "Terminal", script], (err) => { if (err) console.error("[higgsfield] failed to open Terminal:", err); });
}

/** Clone/pull the official skills and mirror the media ones into the store as
 *  `higgsfield-<name>`, shell wording rewritten for the MCP tool. */
export async function syncHiggsfieldSkills(): Promise<{ ok: boolean; error?: string; skills: string[] }> {
  const git = (args: string[], cwd?: string) => new Promise<{ code: number | null; out: string }>((resolve) => {
    const c = spawn("git", args, { cwd, env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; c.stdout.on("data", (d) => { out += d; }); c.stderr.on("data", (d) => { out += d; });
    c.on("error", (e) => resolve({ code: 127, out: e.message })); c.on("close", (code) => resolve({ code, out }));
  });
  const r = fs.existsSync(path.join(SKILLS_DIR, ".git"))
    ? await git(["pull", "-q", "--ff-only"], SKILLS_DIR)
    : await git(["clone", "-q", "--depth", "1", SKILLS_REPO, SKILLS_DIR]);
  if (r.code !== 0) return { ok: false, error: r.out.trim().slice(0, 300) || "git failed", skills: [] };
  const done: string[] = [];
  for (const n of SKILL_SET) {
    const dir = path.join(SKILLS_DIR, `higgsfield-${n}`);
    let raw: string;
    try { raw = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"); } catch { continue; }
    const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
    // `description: |` block scalar → one line, cut at the first "Use when".
    const desc = (fm ? /description:\s*\|?\s*\n?((?:[ \t]+\S[^\n]*\n?)+)/.exec(fm[1])?.[1] ?? "" : "")
      .replace(/\s+/g, " ").trim().split(/\s*Use when:/)[0].slice(0, 200);
    const body = (fm ? raw.slice(fm[0].length) : raw)
      .replace(/```bash\n([\s\S]*?)```/g, (_m, code: string) => "```\n" + code + "```");
    const slug = `higgsfield-${n}`;
    writeSkill(slug, [
      "---", `title: Higgsfield · ${n.replace(/-/g, " ")}`, `description: ${desc}`, "label: Higgsfield", "---", "",
      `> Official Higgsfield skill (${SKILLS_REPO.replace(/\.git$/, "")}), mirrored ${new Date().toISOString().slice(0, 10)}.`,
      `> You have no shell: every \`higgsfield …\` line below is a call to the \`higgsfield\` tool with the words after \`higgsfield\` as \`args\`.`,
      `> Its result images/videos land on the canvas by themselves. Files named \`references/…\` are at ${dir}/references/ — read them with read_local_file.`,
      "", body,
    ].join("\n"), "operator");
    done.push(slug);
  }
  return { ok: true, skills: done };
}
