import { useState, useEffect, useRef, useCallback } from "react";
import { authFetch } from "../contexts/AuthContext";
import { isDesktopApp, desktopBridge } from "../desktop";
import "./SettingsPanel.css";

type KeyStatus = { set: boolean; masked: string | null };
type KeyId = "falKey" | "anthropicKey";
type SettingsResponse = Record<KeyId, KeyStatus>;

function normalizeKeyStatus(v: unknown): KeyStatus {
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return {
      set: o.set === true,
      masked: typeof o.masked === "string" ? o.masked : null,
    };
  }
  return { set: false, masked: null };
}

function normalizeSettings(v: unknown): SettingsResponse {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    falKey: normalizeKeyStatus(o.falKey),
    anthropicKey: normalizeKeyStatus(o.anthropicKey),
  };
}

type KeyFieldConfig = {
  id: KeyId;
  label: string;
  helper: string;
  linkLabel: string;
  linkHref: string;
  placeholder: string;
};

const FIELDS: KeyFieldConfig[] = [
  {
    id: "falKey",
    label: "fal.ai API key",
    helper: "Used to run image, video, and audio generation.",
    linkLabel: "Get a key at fal.ai",
    linkHref: "https://fal.ai/dashboard/keys",
    placeholder: "Paste your fal.ai key",
  },
  {
    id: "anthropicKey",
    label: "Anthropic API key",
    helper: "Optional — legacy per-token agent / Brand IQ. Leave blank if you don't use it.",
    linkLabel: "Get a key at console.anthropic.com",
    linkHref: "https://console.anthropic.com/settings/keys",
    placeholder: "Paste your Anthropic key",
  },
];

const EMPTY_INPUTS = Object.fromEntries(FIELDS.map((f) => [f.id, ""])) as Record<KeyId, string>;
const EMPTY_REVEALED = Object.fromEntries(FIELDS.map((f) => [f.id, false])) as Record<KeyId, boolean>;
const CLEAR_LABELS: Record<KeyId, string> = {
  falKey: "fal.ai key cleared",
  anthropicKey: "Anthropic key cleared",
};

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<SettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [inputs, setInputs] = useState<Record<KeyId, string>>({ ...EMPTY_INPUTS });
  const [revealed, setRevealed] = useState<Record<KeyId, boolean>>({ ...EMPTY_REVEALED });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  const previouslyFocused = useRef<Element | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  // Initial load of current key status.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch("/api/settings");
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(`Couldn't load settings (${res.status})`);
          setLoading(false);
          return;
        }
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        setStatus(normalizeSettings(data));
        setLoading(false);
      } catch {
        if (cancelled) return;
        setLoadError("Network error while loading settings");
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Focus management: remember prior focus, move focus into the modal,
  // restore focus on unmount.
  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    const t = window.setTimeout(() => {
      (firstFieldRef.current || panelRef.current)?.focus();
    }, 0);
    return () => {
      window.clearTimeout(t);
      if (toastTimer.current) clearTimeout(toastTimer.current);
      const prev = previouslyFocused.current;
      if (prev instanceof HTMLElement) prev.focus();
    };
  }, []);

  // Esc to dismiss + a simple focus trap within the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "Tab" && panelRef.current) {
        const focusables = panelRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const postSettings = useCallback(async (body: Partial<Record<KeyId, string>>): Promise<boolean> => {
    setSaveError(null);
    try {
      const res = await authFetch("/api/settings", {
        method: "POST",
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSaveError(
          (data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
            ? (data as { error: string }).error
            : null) || `Save failed (${res.status})`
        );
        return false;
      }
      setStatus(normalizeSettings(data));
      return true;
    } catch {
      setSaveError("Network error while saving");
      return false;
    }
  }, []);

  const hasPendingInput = FIELDS.some((f) => inputs[f.id].trim().length > 0);

  const handleSave = useCallback(async () => {
    if (saving) return;
    const body: Partial<Record<KeyId, string>> = {};
    for (const f of FIELDS) {
      const v = inputs[f.id].trim();
      if (v.length > 0) body[f.id] = v;
    }
    if (Object.keys(body).length === 0) return;
    setSaving(true);
    const ok = await postSettings(body);
    setSaving(false);
    if (ok) {
      setInputs({ ...EMPTY_INPUTS });
      setRevealed({ ...EMPTY_REVEALED });
      showToast("Keys saved");
    }
  }, [saving, inputs, postSettings, showToast]);

  const handleClear = useCallback(async (id: KeyId) => {
    if (saving) return;
    setSaving(true);
    const ok = await postSettings({ [id]: "" } as Partial<Record<KeyId, string>>);
    setSaving(false);
    if (ok) {
      setInputs((prev) => ({ ...prev, [id]: "" }));
      showToast(CLEAR_LABELS[id]);
    }
  }, [saving, postSettings, showToast]);

  return (
    <div className="apikeys-backdrop" onMouseDown={onClose}>
      <div
        className="apikeys-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="apikeys-title"
        ref={panelRef}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button type="button" className="apikeys-close" onClick={onClose} aria-label="Close settings">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        <div className="apikeys-header">
          <h2 className="apikeys-title" id="apikeys-title">API keys</h2>
          <p className="apikeys-note">
            Your keys are stored locally on this device and used only to call these providers directly.
          </p>
        </div>

        {loading ? (
          <div className="apikeys-loading">Loading…</div>
        ) : loadError ? (
          <div className="apikeys-error" role="alert">{loadError}</div>
        ) : (
          <div className="apikeys-fields">
            {FIELDS.map((field, idx) => {
              const keyStatus = status ? status[field.id] : { set: false, masked: null };
              const isSet = keyStatus.set;
              const placeholder = isSet && keyStatus.masked ? `Saved key ${keyStatus.masked}` : field.placeholder;
              return (
                <div className="apikeys-field" key={field.id}>
                  <div className="apikeys-field-labelrow">
                    <label className="apikeys-label" htmlFor={`apikeys-input-${field.id}`}>{field.label}</label>
                    {isSet && (
                      <span className="apikeys-saved-badge">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                        Saved
                      </span>
                    )}
                  </div>
                  <p className="apikeys-helper">
                    {field.helper}{" "}
                    <a href={field.linkHref} target="_blank" rel="noopener noreferrer" className="apikeys-link">
                      {field.linkLabel}
                    </a>
                  </p>
                  <div className="apikeys-input-row">
                    <input
                      id={`apikeys-input-${field.id}`}
                      ref={idx === 0 ? firstFieldRef : undefined}
                      className="apikeys-input"
                      type={revealed[field.id] ? "text" : "password"}
                      value={inputs[field.id]}
                      placeholder={placeholder}
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      onChange={(e) => setInputs((prev) => ({ ...prev, [field.id]: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
                    />
                    <button
                      type="button"
                      className="apikeys-reveal"
                      onClick={() => setRevealed((prev) => ({ ...prev, [field.id]: !prev[field.id] }))}
                      aria-label={revealed[field.id] ? `Hide ${field.label}` : `Show ${field.label}`}
                      aria-pressed={revealed[field.id]}
                      tabIndex={-1}
                    >
                      {revealed[field.id] ? (
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                          <line x1="1" y1="1" x2="23" y2="23" />
                        </svg>
                      ) : (
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
                        </svg>
                      )}
                    </button>
                  </div>
                  {isSet && (
                    <button
                      type="button"
                      className="apikeys-clear"
                      onClick={() => handleClear(field.id)}
                      disabled={saving}
                    >
                      Clear saved key
                    </button>
                  )}
                </div>
              );
            })}

            {saveError && <div className="apikeys-error" role="alert">{saveError}</div>}

            {/* Desktop actions. These used to live in the native File menu,
              * which the frameless window no longer has — Settings is now their
              * home so the MCP bridge and updater stay reachable. */}
            {isDesktopApp() && (
              <div className="apikeys-desktop">
                <div className="apikeys-desktop__label">Desktop</div>
                <div className="apikeys-desktop__actions">
                  <button type="button" className="apikeys-desktop__btn" onClick={() => { void desktopBridge()?.connectToClaude?.(); }}>
                    Connect to Claude…
                  </button>
                  <button type="button" className="apikeys-desktop__btn" onClick={() => { void desktopBridge()?.openDataFolder?.(); }}>
                    Open data folder
                  </button>
                  <button type="button" className="apikeys-desktop__btn" onClick={() => { void desktopBridge()?.checkForUpdates?.(); }}>
                    Check for updates…
                  </button>
                </div>
              </div>
            )}

            <div className="apikeys-footer">
              <span className="apikeys-toast" role="status" aria-live="polite">
                {toast && (
                  <>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    {toast}
                  </>
                )}
              </span>
              <button
                type="button"
                className="apikeys-save"
                onClick={handleSave}
                disabled={saving || !hasPendingInput}
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
