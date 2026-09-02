import test from "node:test";
import assert from "node:assert/strict";
import { doctor } from "./doctor.js";

const fake = (present: string[]) => (id: string) =>
  present.includes(id) ? { path: `/fake/${id}`, found: true } : { path: id, found: false };

const get = (rows: ReturnType<typeof doctor>, id: string) => rows.find((r) => r.id === id)!;

test("brew present → brew installs for ffmpeg and codex", () => {
  const rows = doctor(fake(["brew"]));
  assert.equal(get(rows, "ffmpeg").install, "brew install ffmpeg");
  assert.equal(get(rows, "codex").install, "brew install --cask codex");
  assert.equal(get(rows, "codex").note, undefined);
});

test("no brew, npm present → npm for codex, ffmpeg not installable", () => {
  const rows = doctor(fake(["npm"]));
  assert.equal(get(rows, "codex").install, "npm i -g @openai/codex");
  assert.equal(get(rows, "ffmpeg").install, null);
  assert.equal(get(rows, "ffmpeg").note, "Install Homebrew first");
});

test("neither brew nor npm → codex not installable", () => {
  const rows = doctor(fake([]));
  assert.equal(get(rows, "codex").install, null);
  assert.equal(get(rows, "codex").note, "Install Homebrew first");
  assert.match(get(rows, "brew").install!, /Homebrew\/install/);
  assert.equal(get(rows, "git").install, "xcode-select --install");
  assert.match(get(rows, "opencode").install!, /opencode\.ai\/install/);
});

test("found/path come from the resolver", () => {
  const rows = doctor(fake(["git", "brew", "ffmpeg", "claude", "codex", "opencode"]));
  assert.ok(rows.every((r) => r.found));
  assert.equal(get(rows, "claude").path, "/fake/claude");
});
