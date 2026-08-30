/**
 * GitHub repo library API. Serves the Repos panel (session auth) and the MCP
 * bridge (per-boot token) — Claude calls list_repos to find out which repos the
 * user attached and where they're checked out, then reads them with its own
 * file tools.
 */
import { Router, type Response, type NextFunction } from "express";
import { requireAuth, type AuthRequest } from "../sessions.js";
import { getMcpToken } from "../mcpToken.js";
import {
  ghStatus, ghApi, ghLoginStart, readStore, writeStore, cloneOrPull, removeClone,
  repoStats, REPOS_DIR, type Repo,
} from "../github/ghCli.js";

const router = Router();

function allowMcpOrUser(req: AuthRequest, res: Response, next: NextFunction): void {
  const expected = getMcpToken();
  if (process.env.MB_MCP_NO_TOKEN === "1") { next(); return; }
  if (expected && req.header("x-matteblack-token") === expected) { next(); return; }
  requireAuth(req, res, next);
}

function fail(res: Response, e: unknown, code = 500): void {
  res.status(code).json({ error: e instanceof Error ? e.message : String(e) });
}

router.get("/api/github/status", requireAuth, async (_req: AuthRequest, res) => {
  try { res.json(await ghStatus()); } catch (e) { fail(res, e); }
});

/** Kick off gh's device-code login; the panel shows the code and polls status. */
router.post("/api/github/login", requireAuth, async (_req: AuthRequest, res) => {
  try { res.json(await ghLoginStart()); } catch (e) { fail(res, e, 400); }
});

/** The signed-in user's repos, most recently pushed first. */
router.get("/api/github/available", requireAuth, async (req: AuthRequest, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  try {
    type GhRepo = {
      full_name: string; description: string | null; private: boolean;
      default_branch: string; pushed_at: string;
    };
    const rows = q
      ? (await ghApi<{ items: GhRepo[] }>(
          `search/repositories?q=${encodeURIComponent(`${q} user:@me fork:true`)}&per_page=50`,
        )).items ?? []
      : await ghApi<GhRepo[]>("user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member");
    res.json({
      repos: rows.slice(0, 200).map((r) => ({
        nameWithOwner: r.full_name,
        description: r.description ?? "",
        private: r.private,
        defaultBranch: r.default_branch,
        pushedAt: r.pushed_at,
      })),
    });
  } catch (e) { fail(res, e, 400); }
});

/** The repos the user attached, in their chosen order. */
router.get("/api/github/repos", allowMcpOrUser, (_req: AuthRequest, res) => {
  const repos = readStore().map((r) => ({ ...r, ...repoStats(r.dir) }));
  res.json({ repos, dir: REPOS_DIR });
});

/** Attach a repo: record it, then clone. Responds only once the clone settles
 *  so the panel never shows a repo Claude can't actually read yet. */
router.post("/api/github/repos", requireAuth, async (req: AuthRequest, res) => {
  const body = (req.body ?? {}) as Partial<Repo>;
  const nameWithOwner = typeof body.nameWithOwner === "string" ? body.nameWithOwner.trim() : "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(nameWithOwner)) {
    res.status(400).json({ error: "Expected an owner/name repository." });
    return;
  }
  const store = readStore();
  if (store.some((r) => r.nameWithOwner === nameWithOwner)) {
    res.status(409).json({ error: "That repo is already attached." });
    return;
  }
  const { dir, error } = await cloneOrPull(nameWithOwner);
  const repo: Repo = {
    nameWithOwner,
    description: typeof body.description === "string" ? body.description : "",
    defaultBranch: typeof body.defaultBranch === "string" ? body.defaultBranch : "main",
    private: body.private === true,
    dir,
    addedAt: new Date().toISOString(),
    syncedAt: error ? "" : new Date().toISOString(),
    ...(error ? { error } : {}),
  };
  writeStore([...store, repo]);
  res.json(repo);
});

/** Re-sync one attached repo against its remote. */
router.post("/api/github/repos/sync", requireAuth, async (req: AuthRequest, res) => {
  const name = typeof req.body?.nameWithOwner === "string" ? req.body.nameWithOwner : "";
  const store = readStore();
  const i = store.findIndex((r) => r.nameWithOwner === name);
  if (i < 0) { res.status(404).json({ error: "Not attached." }); return; }
  const { dir, error } = await cloneOrPull(name);
  store[i] = { ...store[i], dir: dir || store[i].dir, syncedAt: error ? store[i].syncedAt : new Date().toISOString(), error };
  writeStore(store);
  res.json(store[i]);
});

/** Reorder — the panel sends the full list of names in the new order. Order is
 *  meaningful: it's the precedence Claude is told to read them in. */
router.put("/api/github/repos/order", requireAuth, (req: AuthRequest, res) => {
  const names = Array.isArray(req.body?.order) ? (req.body.order as unknown[]).filter((n): n is string => typeof n === "string") : null;
  if (!names) { res.status(400).json({ error: "Expected an `order` array of owner/name strings." }); return; }
  const store = readStore();
  const byName = new Map(store.map((r) => [r.nameWithOwner, r]));
  const next = names.map((n) => byName.get(n)).filter((r): r is Repo => !!r);
  // Anything the client didn't mention keeps its place at the end rather than
  // being silently dropped.
  for (const r of store) if (!names.includes(r.nameWithOwner)) next.push(r);
  writeStore(next);
  res.json({ repos: next });
});

router.delete("/api/github/repos", requireAuth, (req: AuthRequest, res) => {
  const name = typeof req.query.name === "string" ? req.query.name : "";
  const store = readStore();
  if (!store.some((r) => r.nameWithOwner === name)) { res.status(404).json({ error: "Not attached." }); return; }
  removeClone(name);
  writeStore(store.filter((r) => r.nameWithOwner !== name));
  res.json({ deleted: true });
});

export default router;
