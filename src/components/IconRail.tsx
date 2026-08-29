import { useAuth } from "../contexts/AuthContext";
import "./IconRail.css";
import logoImg from "@assets/Logo-medium_1776028819541.png";
import logoImgLight from "@assets/Logo-black_1777692939445.png";

export type RailView = "toolkit" | "library" | "projects" | "quick-settings" | "layers" | "agent" | "brandiq" | null;

type IconRailProps = {
  activeView: RailView;
  onSelectView: (view: RailView) => void;
  unreadCount: number;
  onHomeClick: () => void;
  onActivateDesign?: () => void;
  isDesignActive?: boolean;
  // Agent panel lives on the RIGHT edge while the other rail views are
  // mutually-exclusive LEFT-side panels. It's tracked independently so
  // it can stay open alongside any left view (e.g. Library + Agent).
  agentOpen: boolean;
  onToggleAgent: () => void;
  // Opens the local API-keys settings modal.
  onOpenApiKeys?: () => void;
};

export function IconRail({
  activeView,
  onSelectView,
  unreadCount,
  onHomeClick,
  onActivateDesign,
  agentOpen,
  onToggleAgent,
  onOpenApiKeys,
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
          className="icon-rail-logo"
          onClick={onHomeClick}
          aria-label="Home"
        >
          <img src={logoImg} alt="" className="icon-rail-logo-img icon-rail-logo-img--dark" />
          <img src={logoImgLight} alt="" className="icon-rail-logo-img icon-rail-logo-img--light" />
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
          className={`icon-rail-btn ${activeView === "projects" ? "icon-rail-btn--active" : ""}`}
          onClick={() => toggle("projects")}
          aria-label="Projects"
          aria-pressed={activeView === "projects"}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M3 5a2 2 0 0 1 2-2h4.5l2 3H19a2 2 0 0 1 2 2v1H3V5zm0 5h18v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9z" />
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
          aria-pressed={activeView === "layers"}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="3" y1="9" x2="21" y2="9" />
            <line x1="9" y1="21" x2="9" y2="9" />
          </svg>
        </button>

        <button
          type="button"
          className={`icon-rail-btn icon-rail-btn--grouped ${activeView === "brandiq" ? "icon-rail-btn--active" : ""}`}
          onClick={() => toggle("brandiq")}
          aria-label="Brand IQ"
          title="Brand IQ"
          aria-pressed={activeView === "brandiq"}
        >
          {/* Atom: nucleus with three crossed orbital ellipses (0/60/120°),
            * evoking the "intelligence" half of Brand IQ. */}
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
            <ellipse cx="12" cy="12" rx="9" ry="3.6" />
            <ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(60 12 12)" />
            <ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(120 12 12)" />
          </svg>
        </button>
      </div>

      <div className="icon-rail-bottom">
        {onOpenApiKeys && (
          <button
            type="button"
            className="icon-rail-btn"
            onClick={onOpenApiKeys}
            aria-label="API keys"
            title="API keys"
          >
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="7.5" cy="15.5" r="4.5" />
              <path d="m10.7 12.3 8.3-8.3" />
              <path d="m16 6 2 2" />
              <path d="m19 3 2 2" />
            </svg>
          </button>
        )}
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
