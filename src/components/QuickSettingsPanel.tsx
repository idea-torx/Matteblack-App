import { useEffect, useRef, useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { useCreditsContext } from "../contexts/CreditsContext";
import { useTheme } from "../theme";
import { useSubscription } from "../hooks/useSubscription";
import type { Notification } from "../hooks/useNotifications";
import "./QuickSettingsPanel.css";

type QuickSettingsPanelProps = {
  onClose: () => void;
  onSettingsOpen: (section?: string) => void;
  notifications: Notification[];
  unreadCount: number;
  onMarkRead: (id: string) => void;
  onMarkAllRead: () => void;
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  return `${days}d ago`;
}

function severityIcon(severity: string) {
  switch (severity) {
    case "error":
      return (
        <svg className="qs-notif-icon qs-notif-icon--error" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
        </svg>
      );
    case "warning":
      return (
        <svg className="qs-notif-icon qs-notif-icon--warning" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      );
    case "success":
      return (
        <svg className="qs-notif-icon qs-notif-icon--success" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
        </svg>
      );
    default:
      return (
        <svg className="qs-notif-icon qs-notif-icon--info" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
      );
  }
}

function formatRefillDate(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function QuickSettingsPanel({
  onClose,
  onSettingsOpen,
  notifications,
  unreadCount,
  onMarkRead,
  onMarkAllRead,
}: QuickSettingsPanelProps) {
  const { user, loading: authLoading, logout, signIn, isLocal } = useAuth();
  const { balance, totalReceived, periodAllotment, bonusCredits, loading: creditsLoading, unlimited, isWorkspacePool } = useCreditsContext();
  const { theme, toggleTheme } = useTheme();
  const { subscription } = useSubscription();
  const [inboxOpen, setInboxOpen] = useState(false);
  const inboxAnchorRef = useRef<HTMLButtonElement | null>(null);
  const inboxPopRef = useRef<HTMLDivElement | null>(null);

  // Close the inbox popover on outside click / Esc.
  useEffect(() => {
    if (!inboxOpen) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (inboxPopRef.current?.contains(target)) return;
      if (inboxAnchorRef.current?.contains(target)) return;
      setInboxOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setInboxOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [inboxOpen]);

  const userInitial = user ? (user.displayName || user.email)[0].toUpperCase() : "";
  const userName = user ? (user.displayName || user.email.split("@")[0]) : "Guest";
  const isAdmin = user?.role === "superadmin";
  const planLabel = (() => {
    if (isAdmin) return "ADMIN";
    if (unlimited) return "UNLIMITED";
    const tier = subscription?.planTier;
    if (!tier || tier.toLowerCase() === "free") return "FREE";
    return tier.toUpperCase();
  })();
  const formattedBalance = unlimited ? "Unlimited" : balance.toLocaleString();
  // The "out of" reference is the user's plan allotment for the current
  // billing period (server-derived, see /api/credits → periodAllotment).
  // We never use lifetime SUM(positive ledger entries) because refunds
  // and grants would inflate it past the actual plan cap (task #465).
  // Fallback chain: server periodAllotment → subscription.creditsPerPeriod
  // → totalReceived → balance. The first two cover users with an active
  // subscription; the latter two cover free / one-time-grant users.
  const periodTotal =
    periodAllotment || subscription?.creditsPerPeriod || totalReceived || balance || 0;
  // Use max(periodTotal, balance) for the bar so a top-up that pushes
  // balance above the period allotment doesn't overflow the bar visually.
  const barDenominator = Math.max(periodTotal, balance);
  const fillPct = balance > 0 && barDenominator > 0
    ? Math.min(100, Math.max(3, Math.round((balance / barDenominator) * 100)))
    : balance > 0 ? 100 : 0;
  const refillDate = formatRefillDate(subscription?.currentPeriodEnd);

  const recentNotifs = notifications;

  return (
    <aside className="qs-panel" role="dialog" aria-label="Account">
      <div className="qs-header">
        <span className="qs-title">Account</span>
        <button type="button" className="qs-close" onClick={onClose} aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="qs-body">
        {user ? (
          <div className="qs-account-card">
            <div className="qs-account-card-row">
              <span className="qs-avatar qs-avatar--lg">
                {user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : userInitial}
              </span>
              <div className="qs-account-info">
                <div className="qs-account-name-row">
                  <span className="qs-account-name">{userName}</span>
                  {isAdmin && (
                    <span className="qs-role-pill qs-role-pill--admin">
                      {planLabel}
                    </span>
                  )}
                </div>
                <span className="qs-account-email">{user.email}</span>
              </div>
            </div>
          </div>
        ) : !authLoading ? (
          <div className="qs-guest">
            <button
              type="button"
              className="qs-guest-btn"
              onClick={() => signIn()}
            >
              Sign Up / Log In
            </button>
          </div>
        ) : null}

        {user && (
          <div className="qs-credits-card">
            <div className="qs-credits-card-header">
              <span className="qs-credits-label">CREDITS</span>
              {refillDate && !unlimited && (
                <span className="qs-refill-date">Refills {refillDate}</span>
              )}
            </div>
            <div className="qs-credits-card-top">
              <div className="qs-credits-amount-block">
                <span className="qs-credits-amount-lg">
                  {creditsLoading ? "…" : formattedBalance}
                </span>
                {!unlimited && (
                  <span className="qs-credits-sub">
                    credits{isWorkspacePool ? " (workspace)" : ""}
                    {bonusCredits > 0 ? ` · +${bonusCredits.toLocaleString()} bonus` : ""}
                  </span>
                )}
              </div>
            </div>
            {!unlimited && (
              <div className="qs-credits-bar">
                <div className="qs-credits-fill" style={{ width: `${fillPct}%` }} />
              </div>
            )}
            {!isLocal && (
              <button
                type="button"
                className="qs-buy-btn"
                onClick={() => { onSettingsOpen("subscription"); }}
              >
                {unlimited ? "Manage plan" : "Upgrade plan"}
              </button>
            )}
          </div>
        )}

        {user && (
          <div className="qs-grid">
            {!isLocal && (
              <button type="button" className="qs-grid-card" onClick={() => onSettingsOpen("subscription")}>
                <span className="qs-grid-icon">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="1" y="4" width="22" height="16" rx="2" />
                    <line x1="1" y1="10" x2="23" y2="10" />
                  </svg>
                </span>
                <span className="qs-grid-label">Plan</span>
                <span className="qs-grid-sub">Manage subscription</span>
                <span className="qs-grid-tier-pill">{planLabel}</span>
                <svg className="qs-grid-corner" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="7 17 17 7" />
                  <polyline points="9 7 17 7 17 15" />
                </svg>
              </button>
            )}
            <button type="button" className="qs-grid-card" onClick={() => onSettingsOpen("profile")}>
              <span className="qs-grid-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
              </span>
              <span className="qs-grid-label">Account</span>
              <span className="qs-grid-sub">Profile and security</span>
              <svg className="qs-grid-corner" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="7 17 17 7" />
                <polyline points="9 7 17 7 17 15" />
              </svg>
            </button>
            <button type="button" className="qs-grid-card" onClick={() => onSettingsOpen("general")}>
              <span className="qs-grid-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 21h18" />
                  <path d="M5 21V7l8-4v18" />
                  <path d="M19 21V11l-6-4" />
                </svg>
              </span>
              <span className="qs-grid-label">Workspaces</span>
              <span className="qs-grid-sub">Teams and projects</span>
              <svg className="qs-grid-corner" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="7 17 17 7" />
                <polyline points="9 7 17 7 17 15" />
              </svg>
            </button>
            <button type="button" className="qs-grid-card" onClick={() => onSettingsOpen("invitations")}>
              <span className="qs-grid-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <line x1="19" y1="8" x2="19" y2="14" />
                  <line x1="22" y1="11" x2="16" y2="11" />
                </svg>
              </span>
              <span className="qs-grid-label">Invite</span>
              <span className="qs-grid-sub">Add collaborators</span>
              <svg className="qs-grid-corner qs-grid-corner--plus" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </div>
        )}

        <div className="qs-utility-row">
          {user && (
            <button
              ref={inboxAnchorRef}
              type="button"
              className={`qs-utility-btn ${inboxOpen ? "qs-utility-btn--active" : ""}`}
              onClick={() => setInboxOpen((v) => !v)}
              aria-expanded={inboxOpen}
              aria-haspopup="dialog"
            >
              <span className="qs-utility-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 12h-6l-2 3h-4l-2-3H2" />
                  <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
                </svg>
              </span>
              <span className="qs-utility-label">Inbox</span>
              {unreadCount > 0 && <span className="qs-row-badge">{unreadCount}</span>}
            </button>
          )}
          {user && (
          <button
            type="button"
            className="qs-utility-btn"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          >
            <span className="qs-utility-icon">
              {theme === "dark" ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
                </svg>
              )}
            </span>
            <span className="qs-utility-label">{theme === "dark" ? "Dark" : "Light"}</span>
            <span className={`qs-toggle ${theme === "dark" ? "qs-toggle--on" : "qs-toggle--off"}`} aria-hidden="true">
              <span className="qs-toggle-knob" />
            </span>
          </button>
          )}
        </div>

        {user && (
          <button
            type="button"
            className="qs-open-all-btn"
            onClick={() => onSettingsOpen()}
          >
            <span>Open all settings</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="13 6 19 12 13 18" />
            </svg>
          </button>
        )}


        <div className="qs-spacer" />

        {user && (
          <div className="qs-signout-card">
            <button
              type="button"
              className="qs-row qs-row--signout"
              onClick={() => { logout(); onClose(); }}
            >
              <span className="qs-row-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
              </span>
              <span className="qs-row-label">Sign Out</span>
            </button>
          </div>
        )}
      </div>

      {inboxOpen && (
        <div className="qs-inbox-popover" ref={inboxPopRef} role="dialog" aria-label="Inbox">
          <div className="qs-inbox-header">
            <span className="qs-inbox-title">Inbox</span>
            {unreadCount > 0 && (
              <button type="button" className="qs-mark-all" onClick={onMarkAllRead}>
                Mark all read
              </button>
            )}
          </div>
          <ul className="qs-notif-list">
            {recentNotifs.length === 0 ? (
              <li className="qs-notif-empty">No notifications yet</li>
            ) : (
              recentNotifs.map((n) => (
                <li
                  key={n.id}
                  className={`qs-notif-item ${!n.read ? "qs-notif-item--unread" : ""}`}
                  onClick={() => !n.read && onMarkRead(n.id)}
                >
                  <div className="qs-notif-icon-wrap">{severityIcon(n.severity)}</div>
                  <div className="qs-notif-content">
                    <strong className="qs-notif-title">{n.title}</strong>
                    <p className="qs-notif-msg">{n.message}</p>
                    <span className="qs-notif-time">{timeAgo(n.created_at)}</span>
                  </div>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </aside>
  );
}
