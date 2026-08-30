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
type Repo = {
  nameWithOwner: string; description: string; private: boolean; defaultBranch: string;
  dir: string; syncedAt: string; error?: string; files?: number; bytes?: number;
};
type Available = { nameWithOwner: string; description: string; private: boolean; defaultBranch: string };

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
              <div className="skills-list">
                {repos.map((r, i) => (
                  <div key={r.nameWithOwner} className="skills-row gh-row">
                    <div className="gh-order">
                      <button type="button" onClick={() => void move(i, -1)} disabled={i === 0} aria-label="Move up">▲</button>
                      <button type="button" onClick={() => void move(i, 1)} disabled={i === repos.length - 1} aria-label="Move down">▼</button>
                    </div>
                    <div className="skills-row-main gh-row-main">
                      <span className="skills-row-title">{r.nameWithOwner}</span>
                      {r.description && <span className="skills-row-desc">{r.description}</span>}
                      <span className="skills-row-meta">
                        {r.error ? `sync failed: ${r.error}` : `${r.files ?? 0} files · ${size(r.bytes)}`}
                      </span>
                    </div>
                    <div className="gh-row-actions">
                      <button type="button" className="skills-link" disabled={busy === r.nameWithOwner} onClick={() => void sync(r.nameWithOwner)}>
                        {busy === r.nameWithOwner ? "…" : "Sync"}
                      </button>
                      <button type="button" className="skills-link gh-remove" onClick={() => void detach(r.nameWithOwner)}>Remove</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
