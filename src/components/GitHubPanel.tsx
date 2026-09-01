import { useCallback, useEffect, useState } from "react";
import "./LeftToolbar.css";
import "./SkillsPanel.css";
import "./GitHubPanel.css";

/**
 * GitHub — attach repositories so Claude can read them as real context.
 *
 * Auth is brokered by the user's own `gh` CLI (device-code login, token in the
 * OS keyring) so nothing here ever holds or asks for a token. Attached repos
 * are shallow-cloned locally; order is precedence, and the operator is told to
 * read them highest-first.
 */
type Status = { installed: boolean; authenticated: boolean; login: string };
type Git = {
  branch: string; sha: string; subject: string; author: string; committedAt: string;
  dirty: number; ahead: number; behind: number; shallow: boolean;
};
type Repo = {
  nameWithOwner: string; description: string; private: boolean; defaultBranch: string;
  dir: string; syncedAt: string; error?: string; files?: number; bytes?: number;
  writable?: boolean; git?: Git | null;
};
type Available = { nameWithOwner: string; description: string; private: boolean; defaultBranch: string };

/** "3d ago" — enough to know whether a clone is stale, in the width a tile has. */
function ago(iso?: string): string {
  if (!iso) return "";
  const mins = (Date.now() - new Date(iso).getTime()) / 60000;
  if (!Number.isFinite(mins)) return "";
  if (mins < 60) return `${Math.max(1, Math.round(mins))}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

function size(bytes?: number): string {
  if (!bytes) return "";
  const mb = bytes / 1e6;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "include", headers: { "Content-Type": "application/json" }, ...init });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export function GitHubPanel({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [available, setAvailable] = useState<Available[] | null>(null);
  const [query, setQuery] = useState("");
  const [device, setDevice] = useState<{ code: string; url: string } | null>(null);
  const [busy, setBusy] = useState("");
  /** Branch pickers, opened per repo — fetched lazily, since it's a network
   *  call per repo and most sessions never switch branch. */
  const [branches, setBranches] = useState<Record<string, string[]>>({});
  const [picking, setPicking] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([
        api<Status>("/api/github/status"),
        api<{ repos: Repo[] }>("/api/github/repos"),
      ]);
      setStatus(s);
      setRepos(r.repos);
      setError(null);
      return s;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // While the device-code login is open, poll until gh writes the token.
  useEffect(() => {
    if (!device) return;
    const t = setInterval(() => {
      void refresh().then((s) => { if (s?.authenticated) { setDevice(null); } });
    }, 3000);
    return () => clearInterval(t);
  }, [device, refresh]);

  const connect = useCallback(async () => {
    setBusy("connect");
    try { setDevice(await api<{ code: string; url: string }>("/api/github/login", { method: "POST" })); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(""); }
  }, []);

  const browse = useCallback(async (q: string) => {
    setBusy("browse");
    try { setAvailable((await api<{ repos: Available[] }>(`/api/github/available?q=${encodeURIComponent(q)}`)).repos); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(""); }
  }, []);

  const attach = useCallback(async (r: Available) => {
    setBusy(r.nameWithOwner);
    try { await api("/api/github/repos", { method: "POST", body: JSON.stringify(r) }); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(""); }
  }, [refresh]);

  const sync = useCallback(async (name: string) => {
    setBusy(name);
    try { await api("/api/github/repos/sync", { method: "POST", body: JSON.stringify({ nameWithOwner: name }) }); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(""); }
  }, [refresh]);

  const openBranches = useCallback(async (name: string) => {
    if (picking === name) { setPicking(""); return; }
    setPicking(name);
    if (branches[name]) return;
    try { setBranches((b) => ({ ...b, [name]: [] })); const r = await api<{ branches: string[] }>(`/api/github/repos/branches?name=${encodeURIComponent(name)}`); setBranches((b) => ({ ...b, [name]: r.branches })); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setPicking(""); }
  }, [picking, branches]);

  const checkout = useCallback(async (name: string, branch: string) => {
    setBusy(name);
    setPicking("");
    try { await api("/api/github/repos/branch", { method: "POST", body: JSON.stringify({ nameWithOwner: name, branch }) }); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(""); }
  }, [refresh]);

  const setWritable = useCallback(async (r: Repo) => {
    const on = !r.writable;
    if (on && !window.confirm(
      `Let the agent author in ${r.nameWithOwner}?\n\nIt can edit files and commit to a working branch, opening a pull request. It cannot merge, cannot commit to ${r.defaultBranch}, and has no shell — nothing installs or runs.`,
    )) return;
    setBusy(r.nameWithOwner);
    try { await api("/api/github/repos/write", { method: "POST", body: JSON.stringify({ nameWithOwner: r.nameWithOwner, writable: on }) }); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(""); }
  }, [refresh]);

  const detach = useCallback(async (name: string) => {
    if (!window.confirm(`Remove ${name}? The local clone is deleted; the repo on GitHub is untouched.`)) return;
    setBusy(name);
    try { await api(`/api/github/repos?name=${encodeURIComponent(name)}`, { method: "DELETE" }); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(""); }
  }, [refresh]);

  const move = useCallback(async (index: number, delta: number) => {
    const next = [...repos];
    const to = index + delta;
    if (to < 0 || to >= next.length) return;
    [next[index], next[to]] = [next[to], next[index]];
    setRepos(next); // optimistic — order is cosmetic until the PUT lands
    try { await api("/api/github/repos/order", { method: "PUT", body: JSON.stringify({ order: next.map((r) => r.nameWithOwner) }) }); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); void refresh(); }
  }, [repos, refresh]);

  const attached = new Set(repos.map((r) => r.nameWithOwner));

  return (
    <aside className="sidebar">
      <div className="sidebar-panel-header">
        <span className="sidebar-panel-title">GitHub</span>
        <div className="skills-header-actions">
          {status?.authenticated && (
            <button type="button" className="skills-link" onClick={() => {
              if (available) { setAvailable(null); return; }
              void browse("");
            }}>
              {available ? "Done" : "Add"}
            </button>
          )}
          <button type="button" className="sidebar-panel-close" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      <div className="sidebar-scroll">
        {error && <div className="skills-error">{error}</div>}

        {status && !status.installed && (
          <div className="skills-empty">
            The GitHub CLI isn’t installed.
            <span className="skills-empty-hint">
              Install it with <code>brew install gh</code>, then reopen this panel. Fal Forge uses it so your
              GitHub token stays in your keychain — no access tokens to paste here.
            </span>
          </div>
        )}

        {status?.installed && !status.authenticated && (
          <div className="skills-empty">
            {device ? (
              <>
                Enter this code at <a className="gh-link" href={device.url} target="_blank" rel="noreferrer">{device.url}</a>
                <span className="gh-code">{device.code}</span>
                <span className="skills-empty-hint">Waiting for you to finish in the browser…</span>
              </>
            ) : (
              <>
                Not connected.
                <button type="button" className="skills-btn skills-btn--primary" disabled={busy === "connect"} onClick={() => void connect()}>
                  {busy === "connect" ? "Starting…" : "Connect GitHub"}
                </button>
                <span className="skills-empty-hint">Signs in through GitHub in your browser. No token to paste.</span>
              </>
            )}
          </div>
        )}

        {status?.authenticated && (
          <>
            <div className="gh-account">Connected as {status.login}</div>

            {available ? (
              <>
                <input
                  className="gh-search"
                  value={query}
                  placeholder="Search your repos…"
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void browse(query); }}
                />
                {busy === "browse" ? (
                  <div className="skills-empty">Loading…</div>
                ) : (
                  <div className="skills-list">
                    {available.filter((a) => !attached.has(a.nameWithOwner)).map((a) => (
                      <div key={a.nameWithOwner} className="skills-row">
                        <button type="button" className="skills-row-main" disabled={busy === a.nameWithOwner} onClick={() => void attach(a)}>
                          <span className="skills-row-title">{a.nameWithOwner}{a.private ? " · private" : ""}</span>
                          {a.description && <span className="skills-row-desc">{a.description}</span>}
                          <span className="skills-row-meta">{busy === a.nameWithOwner ? "Cloning…" : "Click to attach"}</span>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : repos.length === 0 ? (
              <div className="skills-empty">
                No repos attached.
                <span className="skills-empty-hint">Add one and Claude can read it for context — brand docs, copy, code — alongside a skill.</span>
              </div>
            ) : (
              <div className="gh-tiles">
                {repos.map((r, i) => (
                  <div key={r.nameWithOwner} className={`gh-tile${r.writable ? " gh-tile--writable" : ""}`}>
                    <div className="gh-tile-head">
                      <span className="gh-tile-name">{r.nameWithOwner}</span>
                      <span className={`gh-mode${r.writable ? " gh-mode--write" : ""}`}>{r.writable ? "Author" : "Read only"}</span>
                      <div className="gh-order">
                        <button type="button" onClick={() => void move(i, -1)} disabled={i === 0} aria-label="Move up">▲</button>
                        <button type="button" onClick={() => void move(i, 1)} disabled={i === repos.length - 1} aria-label="Move down">▼</button>
                      </div>
                    </div>

                    {r.description && <div className="gh-tile-desc">{r.description}</div>}

                    {/* The branch is a control, not a label: this is how the user
                        hands the agent a specific branch to work from. */}
                    <button type="button" className="gh-branch" disabled={busy === r.nameWithOwner} onClick={() => void openBranches(r.nameWithOwner)}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" />
                      </svg>
                      {busy === r.nameWithOwner ? "working…" : r.git?.branch || r.defaultBranch}
                      {r.git?.branch && r.git.branch !== r.defaultBranch && <span className="gh-branch-off">off {r.defaultBranch}</span>}
                    </button>

                    {picking === r.nameWithOwner && (
                      <div className="gh-branch-list">
                        {(branches[r.nameWithOwner] ?? []).length === 0 ? (
                          <div className="gh-branch-empty">Loading branches…</div>
                        ) : (
                          branches[r.nameWithOwner].map((b) => (
                            <button key={b} type="button" className={b === r.git?.branch ? "gh-branch-item gh-branch-item--on" : "gh-branch-item"} onClick={() => void checkout(r.nameWithOwner, b)}>
                              {b}
                            </button>
                          ))
                        )}
                      </div>
                    )}

                    {r.git && (
                      <div className="gh-commit">
                        <code>{r.git.sha}</code> {r.git.subject}
                        <span className="gh-commit-by">{r.git.author} · {ago(r.git.committedAt)}</span>
                      </div>
                    )}

                    <div className="gh-stats">
                      <span className={r.git?.dirty ? "gh-stat gh-stat--warn" : "gh-stat"}>{r.git ? (r.git.dirty ? `${r.git.dirty} uncommitted` : "clean") : "no checkout"}</span>
                      {!!r.git?.ahead && <span className="gh-stat">↑{r.git.ahead}</span>}
                      {!!r.git?.behind && <span className="gh-stat">↓{r.git.behind}</span>}
                      <span className="gh-stat">{r.files ?? 0} files · {size(r.bytes)}</span>
                      {r.git?.shallow && <span className="gh-stat">shallow</span>}
                    </div>

                    {r.error && <div className="gh-tile-error">sync failed: {r.error}</div>}

                    <div className="gh-tile-actions">
                      <button type="button" className="skills-link" disabled={busy === r.nameWithOwner} onClick={() => void setWritable(r)}>
                        {r.writable ? "Revoke authoring" : "Enable authoring"}
                      </button>
                      <button type="button" className="skills-link" disabled={busy === r.nameWithOwner} onClick={() => void sync(r.nameWithOwner)}>Sync</button>
                      <button type="button" className="skills-link gh-remove" onClick={() => void detach(r.nameWithOwner)}>Remove</button>
                    </div>
                  </div>
                ))}
                <div className="gh-rule">
                  Authoring lets the agent commit to a branch and open a PR. Merging is never possible, and nothing
                  installs or runs from here.
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
