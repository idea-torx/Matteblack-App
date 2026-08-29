import { useAuth } from "../contexts/AuthContext";
import "./UserSettingsPanel.css";

type UserSettingsPanelProps = {
  isOpen: boolean;
  onClose: () => void;
  toolbarCollapsed?: boolean;
};

export function UserSettingsPanel({ isOpen, onClose, toolbarCollapsed }: UserSettingsPanelProps) {
  const { user } = useAuth();

  if (!isOpen) return null;

  const initial = user ? (user.displayName || user.email)[0].toUpperCase() : "?";
  const displayName = user ? (user.displayName || user.email.split("@")[0]) : "Guest";
  const email = user?.email || "";

  return (
    <div className="user-panel-wrap">
      <div className="user-panel-backdrop" onClick={onClose} aria-hidden />
      <aside
        className={`user-panel ${toolbarCollapsed ? "user-panel--collapsed" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label="User settings"
      >
        <div className="user-panel-header">
          <h2 className="user-panel-title">{displayName}</h2>
          <button type="button" className="user-panel-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="user-panel-body">
          <section className="user-panel-section">
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
              <div style={{ width: 36, height: 36, borderRadius: "50%", background: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 600, fontSize: 16, color: "#fff" }}>
                {initial}
              </div>
              <div>
                <div style={{ fontWeight: 500, fontSize: 14 }}>{displayName}</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{email}</div>
              </div>
            </div>
          </section>
          <section className="user-panel-section">
            <h3 className="user-panel-section-title">Credits</h3>
            <p className="user-panel-value">—</p>
          </section>
          <section className="user-panel-section">
            <h3 className="user-panel-section-title">Settings</h3>
            <p className="user-panel-placeholder">App settings will appear here.</p>
          </section>
          <section className="user-panel-section">
            <h3 className="user-panel-section-title">Usage</h3>
            <p className="user-panel-placeholder">Usage and limits will appear here.</p>
          </section>
        </div>
      </aside>
    </div>
  );
}
