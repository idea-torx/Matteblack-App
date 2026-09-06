import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import express from "express";

// Real HTTP disconnects and child processes, without a model or user data.
test("first-turn handoff, rapid follow-ups, Stop, and review share one writer", { timeout: 30_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "matteblack-session-test-"));
  process.env.LOCAL_MODE = "true";
  process.env.MATTEBLACK_DATA_DIR = dir;
  const cli = path.join(dir, "codex.cjs");
  process.env.MB_CODEX_PATH = cli;
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ operatorRunner: "codex" }));
  fs.writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs');
const dir = ${JSON.stringify(dir)};
let prompt = '';
process.stdin.on('data', b => prompt += b);
process.stdin.on('end', () => {
  const lock = dir + '/writer';
  const emit = event => console.log(JSON.stringify(event));
  let previous;
  try { previous = Number(fs.readFileSync(lock, 'utf8')); } catch {}
  if (previous) {
    let alive = false;
    try { process.kill(previous, 0); alive = true; } catch {}
    if (alive) { fs.appendFileSync(dir + '/conflicts', 'overlap\\n'); process.exit(1); }
  }
  fs.writeFileSync(lock, String(process.pid));
  const review = prompt.startsWith('Review this conversation');
  fs.appendFileSync(dir + '/starts', JSON.stringify({ pid: process.pid, message: review ? 'review' : prompt.split('\\n')[0] }) + '\\n');
  // Exercise the SIGKILL fallback: the native CLI can ignore SIGTERM.
  process.on('SIGTERM', () => {});
  emit({ type: 'thread.started', thread_id: 'lamp-thread' });
  if (prompt.startsWith('finish')) {
    emit({ type: 'item.started', item: { type: 'mcp_tool_call', id: 'tool', tool: 'get_skill', arguments: {} } });
    emit({ type: 'turn.completed' });
    process.exit(0);
  }
  setInterval(() => {}, 1000);
});
`, { mode: 0o700 });

  const { pool } = await import("../db.js");
  // Queries are incidental to this regression; never use the artist's database.
  pool.query = (async () => ({ rows: [], rowCount: 0 })) as typeof pool.query;
  const { default: router } = await import("./operator.js");
  const { claimSessionTurn } = await import("../operator/sessionTurns.js");
  const app = express().use(express.json()).use(router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/api/operator/message`;
  const controllers: AbortController[] = [];
  const starts = (): { pid: number; message: string }[] => {
    try { return fs.readFileSync(path.join(dir, "starts"), "utf8").trim().split("\n").map(line => JSON.parse(line)); }
    catch { return []; }
  };
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!condition()) { assert.ok(Date.now() < deadline, "condition timed out"); await delay(20); }
  };
  async function send(message: string, sessionId?: string) {
    const ac = new AbortController();
    controllers.push(ac);
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, sessionId }), signal: ac.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    let text = "";
    const drained = (async () => {
      try { for (;;) { const part = await reader.read(); if (part.done) break; text += new TextDecoder().decode(part.value); } }
      catch (err) { if (!ac.signal.aborted) throw err; }
    })();
    return { ac, drained, text: () => text };
  }
  try {
    const first = await send("hold first");
    await until(() => first.text().includes('"sessionId":"codex:lamp-thread"'));
    const firstPid = starts()[0].pid;
    assert.equal(claimSessionTurn("codex:lamp-thread", true), undefined, "review cannot displace a live turn");
    const second = await send("hold second", "codex:lamp-thread");
    await until(() => starts().length === 2);
    assert.equal(alive(firstPid), false, "resume must wait for first writer to exit");
    await first.drained;

    // Both arrive while the previous native process is shutting down.
    const middle = await send("must never spawn", "codex:lamp-thread");
    const latest = await send("hold latest", "codex:lamp-thread");
    await until(() => starts().length === 3);
    assert.equal(starts()[2].message, "hold latest");
    await Promise.all([second.drained, middle.drained]);
    latest.ac.abort();
    await until(() => !alive(starts()[2].pid));
    await latest.drained;

    const complete = await send("finish normally", "codex:lamp-thread");
    await complete.drained;
    await until(() => starts().some(s => s.message === "review"));
    const reviewPid = starts().at(-1)!.pid;
    const resumed = await send("hold after review", "codex:lamp-thread");
    await until(() => starts().at(-1)?.message === "hold after review");
    assert.equal(alive(reviewPid), false);
    resumed.ac.abort();
    await until(() => !alive(starts().at(-1)!.pid));
    await resumed.drained;
    assert.equal(fs.existsSync(path.join(dir, "conflicts")), false, "never two live writers");
    assert.ok(!starts().some(s => s.message === "must never spawn"));
    for (const response of [first, second, middle, complete, resumed]) assert.ok(!response.text().includes('"type":"error"'), response.text());
  } finally {
    for (const ac of controllers) ac.abort();
    for (const { pid } of starts()) if (alive(pid)) process.kill(pid, "SIGKILL");
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
