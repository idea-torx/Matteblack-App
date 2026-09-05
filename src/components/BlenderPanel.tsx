import { useCallback, useEffect, useState } from "react";
import "./LeftToolbar.css";
import "./RightPanel.css";
import "./BlenderPanel.css";

/**
 * Blender — the local install, the harness defaults, and the blockout sessions
 * the agent has left behind under <dataDir>/blender.
 *
 * The work itself still happens in the Operator: every button here either opens
 * a .blend, throws a session away, or hands the Operator a prefilled prompt.
 */
type DoctorRow = { id: string; label: string; found: boolean; path: string; install: string | null; note?: string };
type Session = { id: string; updatedAt: string; steps: number; renders: string[]; renderCount: number };
type Config = { look: "grey" | "lit"; width: number; height: number; fps: number };

const DEFAULTS: Config = { look: "grey", width: 1280, height: 720, fps: 24 };

function ago(iso: string): string {
  const mins = (Date.now() - new Date(iso).getTime()) / 60000;
  if (!Number.isFinite(mins)) return "";
  if (mins < 60) return `${Math.max(1, Math.round(mins))}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "include", headers: { "Content-Type": "application/json" }, ...init });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export function BlenderPanel({ onClose, onOperator }: {
  onClose: () => void;
  /** Open the Operator with this message prefilled. */
  onOperator: (text: string) => void;
}) {
  const [row, setRow] = useState<DoctorRow | null>(null);
  const [addon, setAddon] = useState<{ installed: boolean } | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [config, setConfig] = useState<Config>(DEFAULTS);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [d, a, s, c] = await Promise.all([
        api<{ rows: DoctorRow[] }>("/api/setup/doctor"),
        api<{ installed: boolean }>("/api/setup/blender-addon"),
        api<{ sessions: Session[] }>("/api/blender/sessions"),
        api<Config>("/api/blender/config"),
      ]);
      setRow(d.rows.find((r) => r.id === "blender") ?? null);
      setAddon(a);
      setSessions(s.sessions);
      setConfig(c);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // A step run from the Operator writes a new session behind this panel's back.
  useEffect(() => {
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  const saveConfig = useCallback(async (patch: Partial<Config>) => {
    const next = { ...config, ...patch };
    setConfig(next); // optimistic — the form is the source of truth while typing
    try { setConfig(await api<Config>("/api/blender/config", { method: "POST", body: JSON.stringify(next) })); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [config]);

  const open = useCallback(async (id: string) => {
    setBusy(id);
    try { await api(`/api/blender/sessions/${encodeURIComponent(id)}/open`, { method: "POST" }); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(""); }
  }, []);

  const restart = useCallback(async (id: string) => {
    if (!window.confirm(`Restart "${id}"?\n\nThe scene, every step and every render in it are deleted. This can't be undone.`)) return;
    setBusy(id);
    try { await api(`/api/blender/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(""); }
  }, [refresh]);

  const num = (key: "width" | "height" | "fps", label: string) => (
    <label className="blender-field">
      <span className="rpanel-setting-label">{label}</span>
      <input
        className="rpanel-url-input"
        type="number"
        min={1}
        value={config[key]}
        onChange={(e) => setConfig({ ...config, [key]: Number(e.target.value) })}
        onBlur={() => void saveConfig({})}
      />
    </label>
  );

  return (
    <aside className="sidebar">
      <div className="sidebar-panel-header">
        <span className="sidebar-panel-title">Blender</span>
        <button type="button" className="sidebar-panel-close" onClick={onClose} aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="sidebar-scroll">
        {error && <div className="rpanel-inline-error" style={{ marginBottom: 10 }}>{error}</div>}

        {row && !row.found ? (
          <div className="rpanel-empty-state">
            <span className="rpanel-empty-state-text">
              Blender isn’t installed.<br />
              {row.install ? <>Install it with <code className="blender-inline-code">{row.install}</code>, or use the Install button in Settings → Setup.</> : row.note}
            </span>
          </div>
        ) : (
          <div className="blender-status">
            {row ? `Found at ${row.path}` : "Checking…"}
            {addon && ` · add-on ${addon.installed ? "installed" : "not installed"}`}
          </div>
        )}

        <div className="blender-cards">
          <div className="rpanel-card">
            <div className="rpanel-card-title">Defaults</div>
            <div className="blender-desc">New-session defaults. The artist’s scene settings are preserved; previews can request a temporary grey or lit look.</div>
            <div className="blender-fields">
              <label className="blender-field">
                <span className="rpanel-setting-label">Look</span>
                <select
                  className="rpanel-select"
                  value={config.look}
                  onChange={(e) => void saveConfig({ look: e.target.value as Config["look"] })}
                >
                  <option value="grey">Grey</option>
                  <option value="lit">Lit</option>
                </select>
              </label>
              {num("width", "Width")}
              {num("height", "Height")}
              {num("fps", "FPS")}
            </div>
          </div>

          <div className="rpanel-card">
            <div className="rpanel-card-title">New session</div>
            <input
              className="rpanel-url-input"
              value={name}
              placeholder="product-model"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) onOperator(`Start a visible Blender modeling session "${name.trim()}": `); }}
            />
            <div className="blender-actions">
              <button
                type="button"
                className="rpanel-action-btn"
                disabled={!name.trim()}
                onClick={() => onOperator(`Start a visible Blender modeling session "${name.trim()}": `)}
              >
                Model with the Operator
              </button>
            </div>
          </div>

          {sessions.length === 0 ? (
            <div className="rpanel-empty-state">
              <span className="rpanel-empty-state-text">No sessions yet.<br />Name one above and the Operator will open Blender and model with you, step by step.</span>
            </div>
          ) : sessions.map((s) => (
            <div key={s.id} className="rpanel-card">
              <div className="rpanel-card-title">{s.id}</div>
              <div className="blender-meta">{s.steps} steps · {s.renderCount} renders · {ago(s.updatedAt)}</div>
              {s.renders.length > 0 && <div className="blender-renders">{s.renders.join(" · ")}</div>}
              <div className="blender-actions">
                <button type="button" className="rpanel-action-btn" onClick={() => onOperator(`Continue Blender session "${s.id}": `)}>Continue</button>
              </div>
              <div className="blender-actions" style={{ marginTop: 6 }}>
                <button type="button" className="rpanel-action-btn rpanel-action-btn--secondary" disabled={busy === s.id} onClick={() => void open(s.id)}>Open in Blender</button>
                <button type="button" className="rpanel-action-btn rpanel-action-btn--danger" disabled={busy === s.id} onClick={() => void restart(s.id)}>Restart</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
