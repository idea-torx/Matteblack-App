import { useEffect, useState } from "react";
import "./ShareModal.css";

type Participant = {
  user_id: string;
  display_name: string | null;
  email: string;
  avatar_url: string | null;
  role: "viewer";
  joined_at: string;
  last_seen_at: string;
};

type ShareSettings = {
  enabled: boolean;
  shareUrl: string | null;
  participants: Participant[];
};

export function ShareModal({ projectId, projectName, onClose }: {
  projectId: string;
  projectName: string;
  onClose: () => void;
}) {
  const [settings, setSettings] = useState<ShareSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState("");
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async (initial: boolean) => {
      try {
        const res = await fetch(`/api/projects/${projectId}/share`, { credentials: "include" });
        if (cancelled) return;
        if (!res.ok) {
          if (initial) {
            const body = await res.json().catch(() => ({}));
            setErrorMsg(body.error || `Failed to load (${res.status})`);
            setLoading(false);
          }
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        setSettings((prev) => prev ? { ...prev, ...data } : data);
        if (initial) setLoading(false);
      } catch (err) {
        if (cancelled || !initial) return;
        setErrorMsg(err instanceof Error ? err.message : "Network error");
        setLoading(false);
      } finally {
        if (!cancelled) {
          timer = setTimeout(() => load(false), 5000);
        }
      }
    };
    load(true);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [projectId]);

  const toggle = async (next: boolean) => {
    setSaving(true);
    setErrorMsg("");
    try {
      const res = await fetch(`/api/projects/${projectId}/share`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErrorMsg(body.error || `Failed to update (${res.status})`);
        setSaving(false);
        return;
      }
      const data = await res.json();
      setSettings((prev) => prev ? { ...prev, enabled: data.enabled, shareUrl: data.shareUrl } : prev);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Network error");
    } finally {
      setSaving(false);
    }
  };

  const copy = async () => {
    if (!settings?.shareUrl) return;
    try {
      await navigator.clipboard.writeText(settings.shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="share-modal-backdrop" onClick={onClose}>
      <div className="share-modal" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="share-modal-close"
          onClick={onClose}
          aria-label="Close"
        >×</button>
        <div className="share-modal-header">
          <div className="share-modal-title">Share project</div>
          <div className="share-modal-subtitle">{projectName}</div>
        </div>

        {loading ? (
          <div className="share-modal-loading">Loading...</div>
        ) : errorMsg ? (
          <div className="share-modal-error">{errorMsg}</div>
        ) : settings ? (
          <>
            <div className="share-modal-toggle-row">
              <div>
                <div className="share-modal-toggle-label">Anyone with the link</div>
                <div className="share-modal-toggle-desc">Signed-in users get read-only access.</div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={settings.enabled}
                aria-label="Enable share link"
                disabled={saving}
                onClick={() => toggle(!settings.enabled)}
                className={`share-modal-switch ${settings.enabled ? "share-modal-switch--on" : ""}`}
              >
                <span className="share-modal-switch-thumb" />
              </button>
            </div>

            {settings.enabled && settings.shareUrl && (
              <div className="share-modal-url-row">
                <input
                  type="text"
                  readOnly
                  value={settings.shareUrl}
                  onFocus={(e) => e.currentTarget.select()}
                  className="share-modal-url-input"
                />
                <button type="button" onClick={copy} className="share-modal-copy-btn">
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            )}

            <div>
              <div className="share-modal-participants-label">
                People with access ({settings.participants.length})
              </div>
              {settings.participants.length === 0 ? (
                <div className="share-modal-participants-empty">No one has joined yet.</div>
              ) : (
                <div className="share-modal-participants-list">
                  {settings.participants.map((p) => (
                    <div key={p.user_id} className="share-modal-participant">
                      {p.avatar_url ? (
                        <img src={p.avatar_url} alt="" className="share-modal-participant-img" />
                      ) : (
                        <div className="share-modal-participant-avatar">
                          {(p.display_name || p.email).charAt(0).toUpperCase()}
                        </div>
                      )}
                      <div className="share-modal-participant-info">
                        <div className="share-modal-participant-name">
                          {p.display_name || p.email}
                        </div>
                        <div className="share-modal-participant-email">
                          {p.email}
                        </div>
                      </div>
                      <span className="share-modal-participant-role">Viewer</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
