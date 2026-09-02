import { useAuth } from "../contexts/AuthContext";
import "./IconRail.css";

export type RailView = "home" | "toolkit" | "library" | "quick-settings" | "layers" | "agent" | "skills" | "github" | null;

type IconRailProps = {
  activeView: RailView;
  onSelectView: (view: RailView) => void;
  unreadCount: number;
  onActivateDesign?: () => void;
  isDesignActive?: boolean;
  // Agent panel lives on the RIGHT edge while the other rail views are
  // mutually-exclusive LEFT-side panels. It's tracked independently so
  // it can stay open alongside any left view (e.g. Library + Agent).
  agentOpen: boolean;
  onToggleAgent: () => void;
  // Opens the local API-keys settings modal.
};

export function IconRail({
  activeView,
  onSelectView,
  unreadCount,
  onActivateDesign,
  agentOpen,
  onToggleAgent,
}: IconRailProps) {
  const settingsOpen = activeView === "quick-settings";
  const onSettingsToggle = () => onSelectView(settingsOpen ? null : "quick-settings");
  const { user, loading: authLoading } = useAuth();
  const userInitial = user ? (user.displayName || user.email)[0].toUpperCase() : "";

  const toggle = (view: Exclude<RailView, null>) => {
    onSelectView(activeView === view ? null : view);
  };

  return (
    <aside className="icon-rail" aria-label="Main navigation">
      <div className="icon-rail-top">
        <button
          type="button"
          className={`icon-rail-btn ${activeView === "home" ? "icon-rail-btn--active" : ""}`}
          onClick={() => toggle("home")}
          aria-label="Home"
          title="Home"
          aria-pressed={activeView === "home"}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 10.5 12 3l9 7.5" />
            <path d="M5.5 9.5V20h13V9.5" />
          </svg>
        </button>

        <button
          type="button"
          className={`icon-rail-btn ${agentOpen ? "icon-rail-btn--active" : ""}`}
          onClick={onToggleAgent}
          aria-label="Matte Agent"
          title="Matte Agent"
          aria-pressed={agentOpen}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 1.5 L13.6 9.2 L21.5 12 L13.6 14.8 L12 22.5 L10.4 14.8 L2.5 12 L10.4 9.2 Z" />
          </svg>
        </button>

        <button
          type="button"
          className={`icon-rail-btn ${activeView === "toolkit" ? "icon-rail-btn--active" : ""}`}
          onClick={() => toggle("toolkit")}
          aria-label="Toolkit"
          aria-pressed={activeView === "toolkit"}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z" />
          </svg>
        </button>

        <button
          type="button"
          className={`icon-rail-btn ${activeView === "skills" ? "icon-rail-btn--active" : ""}`}
          onClick={() => toggle("skills")}
          aria-label="Skills"
          aria-pressed={activeView === "skills"}
        >
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H19v18H6.5A2.5 2.5 0 0 0 4 22z" />
            <line x1="8" y1="7" x2="15" y2="7" />
            <line x1="8" y1="11" x2="13" y2="11" />
          </svg>
        </button>

        <button
          type="button"
          className={`icon-rail-btn ${activeView === "github" ? "icon-rail-btn--active" : ""}`}
          onClick={() => toggle("github")}
          aria-label="GitHub"
          aria-pressed={activeView === "github"}
        >
          <svg width="19" height="19" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8" />
          </svg>
        </button>

        <button
          type="button"
          className={`icon-rail-btn ${activeView === "library" ? "icon-rail-btn--active" : ""}`}
          onClick={() => toggle("library")}
          aria-label="Library"
          aria-pressed={activeView === "library"}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <rect x="3" y="3" width="8" height="8" rx="1.5" />
            <rect x="13" y="3" width="8" height="8" rx="1.5" />
            <rect x="13" y="13" width="8" height="8" rx="1.5" />
            <rect x="3" y="13" width="8" height="8" rx="1.5" />
          </svg>
        </button>

        <button
          type="button"
          className={`icon-rail-btn ${activeView === "layers" ? "icon-rail-btn--active" : ""}`}
          onClick={() => {
            toggle("layers");
            onActivateDesign?.();
          }}
          aria-label="Design"
          title="Design"
          aria-pressed={activeView === "layers"}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2 2 7l10 5 10-5-10-5Z" />
            <path d="m2 17 10 5 10-5" />
            <path d="m2 12 10 5 10-5" />
          </svg>
        </button>

      </div>

      <div className="icon-rail-bottom">
        <button
          type="button"
          className={`icon-rail-avatar ${settingsOpen ? "icon-rail-avatar--active" : ""}`}
          onClick={onSettingsToggle}
          aria-label="Account & settings"
          aria-pressed={settingsOpen}
        >
          <span className={`icon-rail-avatar-circle${!user ? " icon-rail-avatar-circle--guest" : ""}`}>
            {authLoading ? null : user?.avatarUrl ? (
              <img src={user.avatarUrl} alt="" />
            ) : user ? (
              userInitial
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
            )}
          </span>
          {unreadCount > 0 && <span className="icon-rail-avatar-dot" aria-label={`${unreadCount} unread notifications`} />}
        </button>
      </div>
    </aside>
  );
}
