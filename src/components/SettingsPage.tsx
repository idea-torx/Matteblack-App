import { useState, useEffect, useRef, useCallback, type ReactNode } from "react";
import NumericInput from "./NumericInput";
import { useAuth } from "../contexts/AuthContext";
import { useWorkspace } from "../contexts/WorkspaceContext";
import { getSoundEnabled, setSoundEnabled } from "../hooks/useGenerationSound";
import { getShowGenerateCost, setShowGenerateCost } from "../hooks/useShowGenerateCost";
import { useUsage, type UsageByModelGroup, type UsageRecentItem } from "../hooks/useUsage";
import { getModelDisplayName, getVariationLabel, formatRelativeTime } from "../utils/modelLabels";
import { useSubscription } from "../hooks/useSubscription";
import { useCreditsContext } from "../contexts/CreditsContext";
import { getWorkspace, updateWorkspace, getMembers, getInvitations, sendInvitation, resendInvitation, revokeInvitation, changeRole, removeMember, type Workspace, type Member, type Invitation } from "../api/workspace";
import { StyleGuidePage } from "./StyleGuidePage";
import "./SettingsPage.css";

type SettingsPageProps = {
  onClose: () => void;
  initialSection?: string;
  onSignIn?: () => void;
};

type Section = {
  id: string;
  label: string;
  icon: ReactNode;
};

const ACCOUNT_SUB_SECTIONS: Section[] = [
  {
    id: "profile",
    label: "Profile",
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>,
  },
  {
    id: "security",
    label: "Security",
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>,
  },
];


const BILLING_SECTIONS: Section[] = [
  {
    id: "subscription",
    label: "Subscription",
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="4" width="22" height="16" rx="2" /><line x1="1" y1="10" x2="23" y2="10" /></svg>,
  },
  {
    id: "usage",
    label: "Usage",
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20V10" /><path d="M18 20V4" /><path d="M6 20v-4" /></svg>,
  },
];

const PREFERENCES_SECTIONS: Section[] = [
  {
    id: "providers",
    label: "Providers",
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="8" rx="2" /><rect x="2" y="14" width="20" height="8" rx="2" /><line x1="6" y1="6" x2="6.01" y2="6" /><line x1="6" y1="18" x2="6.01" y2="18" /></svg>,
  },
  {
    id: "connectors",
    label: "Connectors",
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>,
  },
  {
    id: "scheduled-runs",
    label: "Scheduled runs",
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>,
  },
  {
    id: "notifications",
    label: "Notifications",
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></svg>,
  },
];

const WORKSPACE_SECTIONS: Section[] = [
  {
    id: "general",
    label: "General",
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>,
  },
  {
    id: "members",
    label: "Members",
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>,
  },
  {
    id: "invitations",
    label: "Invitations",
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" /><polyline points="22,6 12,13 2,6" /></svg>,
  },
];

const LEGAL_SECTIONS: Section[] = [
  {
    id: "privacy-policy",
    label: "Privacy Policy",
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><line x1="10" y1="9" x2="8" y2="9" /></svg>,
  },
  {
    id: "terms-of-service",
    label: "Terms of Service",
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><line x1="10" y1="9" x2="8" y2="9" /></svg>,
  },
  {
    id: "clearcheck-policy",
    label: "Clearcheck Policy",
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><polyline points="9 12 11 14 15 10" /></svg>,
  },
];

type SectionGroup = { label: string; sections: Section[] };

const SECTION_LABELS: Record<string, string> = {
  auth: "Sign In",
  profile: "Profile",
  security: "Security",
  subscription: "Subscription",
  usage: "Usage",
  providers: "Providers",
  connectors: "Connectors",
  notifications: "Notifications",
  "scheduled-runs": "Scheduled runs",
  general: "Workspace",
  members: "Members",
  invitations: "Invitations",
  "privacy-policy": "Privacy Policy",
  "terms-of-service": "Terms of Service",
  "clearcheck-policy": "Clearcheck Policy",
  "credit-config": "Credit Config",
  "style-guide": "Style Guide",
};

export function SettingsPage({ onClose, initialSection = "subscription", onSignIn: onSignInCallback }: SettingsPageProps) {
  const { user, isLocal } = useAuth();
  // Map legacy / shorthand section ids that callers may still pass
  // (e.g. AgentPanel's insufficient-credits CTA opens "billing", the
  // grid's "Account" tile opens "account") onto concrete rendered
  // section ids so every existing entry point lands on a real view.
  const SECTION_ALIASES: Record<string, string> = {
    account: "profile",
    billing: "subscription",
    plan: "subscription",
    workspace: "general",
    workspaces: "general",
    members: "members",
    invite: "invitations",
    invites: "invitations",
  };
  const resolvedInitial = SECTION_ALIASES[initialSection] ?? initialSection;
  // In local mode the billing sections don't exist — send any billing-targeted
  // entry point (default "subscription", or an insufficient-credits CTA) to a
  // real section instead of a blank pane.
  const localSafeInitial = isLocal && BILLING_SECTIONS.some((s) => s.id === resolvedInitial)
    ? "profile"
    : resolvedInitial;
  const effectiveInitial = !user && localSafeInitial !== "auth" ? "auth" : localSafeInitial;
  const [activeSection, setActiveSection] = useState(effectiveInitial);
  useEffect(() => {
    setActiveSection(effectiveInitial);
  }, [effectiveInitial]);
  const isLoggedIn = !!user;
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!user && activeSection !== "auth") {
      setActiveSection("auth");
    }
  }, [user, activeSection]);

  // Reset scroll position whenever the active section changes so users
  // always land at the top of the new section, mirroring how a native
  // settings panel feels when navigating between rows.
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [activeSection]);

  const handleSignIn = () => {
    if (onSignInCallback) {
      onSignInCallback();
    } else {
      setActiveSection("profile");
    }
  };

  const handleSelectSection = (id: string) => {
    setActiveSection(id);
  };

  const groups: SectionGroup[] = isLoggedIn
    ? [
        { label: "Account", sections: ACCOUNT_SUB_SECTIONS },
        // Billing is meaningless in the login-less local/desktop build (no
        // Stripe, unlimited local generation), so hide the whole group.
        ...(isLocal ? [] : [{ label: "Billing", sections: BILLING_SECTIONS }]),
        { label: "Team", sections: WORKSPACE_SECTIONS },
        { label: "Preferences", sections: PREFERENCES_SECTIONS },
        ...(user?.role === "superadmin"
          ? [{
              label: "Admin",
              sections: [{
                id: "credit-config",
                label: "Credit Config",
                icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>,
              }, {
                id: "style-guide",
                label: "Style Guide",
                icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" /></svg>,
              }],
            }]
          : []),
        { label: "Legal", sections: LEGAL_SECTIONS },
      ]
    : [{ label: "Legal", sections: LEGAL_SECTIONS }];

  const currentTitle = SECTION_LABELS[activeSection] || "Settings";

  return (
    <aside className="settings-panel" role="dialog" aria-label="Settings">
      <div className="settings-panel-sidebar">
        <header className="settings-panel-sidebar-header">
          <span className="settings-panel-sidebar-title">Settings</span>
        </header>
        <div className="settings-panel-nav">
          {groups.map((g) => (
            <div key={g.label} className="settings-panel-nav-group">
              <span className="settings-panel-nav-label">{g.label}</span>
              {g.sections.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={`settings-panel-nav-btn ${activeSection === s.id ? "settings-panel-nav-btn--active" : ""}`}
                  onClick={() => handleSelectSection(s.id)}
                >
                  <span className="settings-panel-nav-icon">{s.icon}</span>
                  <span className="settings-panel-nav-text">{s.label}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="settings-panel-main">
        <header className="settings-panel-header">
          <div className="settings-panel-title-wrap">
            <h2 className="settings-panel-title">{currentTitle}</h2>
          </div>
          <button
            type="button"
            className="settings-panel-icon-btn"
            onClick={onClose}
            aria-label="Close settings"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>
        <div className="settings-panel-body" ref={bodyRef}>
          <div className="settings-content-inner settings-content-inner--panel">
            {activeSection === "auth" && <AuthSection onSignIn={handleSignIn} />}
            {activeSection === "usage" && <UsageSection />}
            {activeSection === "profile" && <ProfileSection />}
            {activeSection === "security" && <SecuritySection onDeleted={() => setActiveSection("auth")} />}
            {activeSection === "subscription" && <SubscriptionSection />}
            {activeSection === "providers" && <><SetupSection /><ProvidersSection /></>}
            {activeSection === "connectors" && <ConnectorsSection />}
            {activeSection === "scheduled-runs" && <ScheduledRunsSection />}
            {activeSection === "notifications" && <NotificationsSection />}
            {activeSection === "general" && <GeneralSection />}
            {activeSection === "members" && <MembersSection />}
            {activeSection === "invitations" && <InvitationsSection />}
            {activeSection === "privacy-policy" && <PrivacyPolicySection />}
            {activeSection === "terms-of-service" && <TermsOfServiceSection />}
            {activeSection === "clearcheck-policy" && <ClearcheckPolicySection />}
            {activeSection === "credit-config" && <CreditConfigSection />}
            {activeSection === "style-guide" && <StyleGuidePage />}
          </div>
        </div>
      </div>
    </aside>
  );
}

/* ─── Section Components ─── */

function AuthSection({ onSignIn: _onSignIn }: { onSignIn: () => void }) {
  const { signIn } = useAuth();

  return (
    <>
      <h2 className="settings-section-title">Sign In</h2>
      <div className="settings-auth-card">
        <div className="settings-auth-header">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="settings-auth-logo">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
          </svg>
          <p className="settings-auth-subtitle">
            Sign in to access your account. Supports email, magic link, Google, and GitHub.
          </p>
        </div>

        <button type="button" className="settings-google-btn" onClick={signIn}>
          <svg width="18" height="18" viewBox="0 0 48 48">
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
            <path fill="#FBBC05" d="M10.53 28.59a14.5 14.5 0 0 1 0-9.18l-7.98-6.19a24.04 24.04 0 0 0 0 21.56l7.98-6.19z" />
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
          </svg>
          Continue with Google
        </button>

        <div className="settings-auth-divider">
          <span>or</span>
        </div>

        <button type="button" className="settings-btn-primary settings-auth-submit" onClick={signIn}>
          Sign In with Email
        </button>
      </div>
    </>
  );
}

function resizeImageToDataUrl(file: File, maxPx = 256): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(maxPx / img.width, maxPx / img.height, 1);
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) { reject(new Error("canvas")); return; }
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("load")); };
    img.src = url;
  });
}

type DisplayModelGroup = {
  displayName: string;
  totalCredits: number;
  totalCount: number;
  variations: { key: string; label: string; credits: number; count: number }[];
};

function mergeByDisplayName(groups: UsageByModelGroup[]): DisplayModelGroup[] {
  const map = new Map<string, DisplayModelGroup>();
  for (const g of groups) {
    const displayName = getModelDisplayName(g.model);
    let merged = map.get(displayName);
    if (!merged) {
      merged = { displayName, totalCredits: 0, totalCount: 0, variations: [] };
      map.set(displayName, merged);
    }
    merged.totalCredits += g.totalCredits;
    merged.totalCount += g.totalCount;
    for (const v of g.variations) {
      const label = getVariationLabel(g.model, v.type);
      const existing = merged.variations.find((x) => x.label === label);
      if (existing) {
        existing.credits += v.credits;
        existing.count += v.count;
      } else {
        merged.variations.push({
          key: `${g.model}::${v.type}`,
          label,
          credits: v.credits,
          count: v.count,
        });
      }
    }
  }
  const result = Array.from(map.values());
  result.sort((a, b) => b.totalCredits - a.totalCredits || b.totalCount - a.totalCount);
  for (const g of result) {
    g.variations.sort((a, b) => b.credits - a.credits || b.count - a.count);
  }
  return result;
}

function MostRecentCard({ items }: { items: UsageRecentItem[] }) {
  return (
    <div className="settings-card" style={{ marginTop: 20 }}>
      <h3 className="settings-card-title">Most Recent</h3>
      {items.length === 0 ? (
        <div className="settings-empty" style={{ padding: "18px 0 8px" }}>
          No generations yet
        </div>
      ) : (
        <div className="settings-usage-list">
          {items.map((item) => (
            <div key={item.id} className="settings-recent-row">
              <div className="settings-recent-row-main">
                <span className="settings-recent-row-model">
                  {getModelDisplayName(item.model)}
                </span>
                <span className="settings-recent-row-variation">
                  {getVariationLabel(item.model, item.type)}
                </span>
              </div>
              <span className="settings-recent-row-time">
                {formatRelativeTime(item.createdAt)}
              </span>
              <span className="settings-recent-row-credits">
                {item.creditsCharged} cr
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ModelBreakdownCard({ groups }: { groups: DisplayModelGroup[] }) {
  return (
    <div className="settings-card" style={{ marginTop: 20 }}>
      <h3 className="settings-card-title">Breakdown by Model</h3>
      <div className="settings-model-breakdown">
        {groups.map((group) => (
          <div key={group.displayName} className="settings-model-group">
            <div className="settings-model-group-header">
              <span className="settings-model-group-name">{group.displayName}</span>
              <span className="settings-model-group-count">
                {group.totalCount} {group.totalCount === 1 ? "job" : "jobs"}
              </span>
              <span className="settings-model-group-credits">
                {group.totalCredits} cr
              </span>
            </div>
            <div className="settings-model-group-variations">
              {group.variations.map((v) => (
                <div key={v.key} className="settings-model-variation-row">
                  <span className="settings-model-variation-label">{v.label}</span>
                  <span className="settings-model-variation-count">{v.count}</span>
                  <span className="settings-model-variation-credits">{v.credits} cr</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function UsageSection() {
  const { data, loading, error } = useUsage();
  const [showCost, setShowCost] = useState(getShowGenerateCost);
  const handleShowCostToggle = () => {
    const next = !showCost;
    setShowCost(next);
    setShowGenerateCost(next);
  };
  const totalJobs = data?.totalJobs ?? 0;
  const modelGroups = mergeByDisplayName(data?.byModel ?? []);
  // The headline "Credits Used" tile shows net (gross − refunds) so it
  // reconciles with the Account panel's "balance of allotment" arithmetic.
  // We still surface the gross + refund totals just below so the user can
  // see exactly how the headline was derived (task #465).
  const grossCharged = data?.grossCharged ?? data?.totalCredits ?? 0;
  const refunds = data?.refunds ?? 0;
  const netUsed = data?.netUsed ?? grossCharged;
  const hasPeriod = (data?.periodAllotment ?? 0) > 0;

  return (
    <>
      <h2 className="settings-section-title">Usage</h2>
      {loading ? (
        <div className="settings-empty">Loading usage data…</div>
      ) : error ? (
        <div className="settings-empty" style={{ color: "#f87171" }}>{error}</div>
      ) : (
        <>
          <div className="settings-usage-summary">
            <div className="settings-usage-summary-stat">
              <span className="settings-usage-summary-value">{totalJobs}</span>
              <span className="settings-usage-summary-label">Total Creations</span>
            </div>
            <div className="settings-usage-summary-stat">
              <span className="settings-usage-summary-value">{netUsed.toLocaleString()}</span>
              <span className="settings-usage-summary-label">
                Net Credits Used{hasPeriod ? " (this period)" : ""}
              </span>
            </div>
          </div>

          {(grossCharged > 0 || refunds > 0) && (
            <div className="settings-card" style={{ marginTop: 16 }}>
              <div className="settings-usage-breakdown">
                <div className="settings-usage-breakdown-row">
                  <span className="settings-usage-breakdown-label">Credits charged (gross)</span>
                  <span className="settings-usage-breakdown-value">
                    {grossCharged.toLocaleString()}
                  </span>
                </div>
                <div className="settings-usage-breakdown-row">
                  <span className="settings-usage-breakdown-label">Refunds &amp; adjustments</span>
                  <span className="settings-usage-breakdown-value">
                    {refunds > 0 ? `−${refunds.toLocaleString()}` : "0"}
                  </span>
                </div>
                <div className="settings-usage-breakdown-row settings-usage-breakdown-row--net">
                  <span className="settings-usage-breakdown-label">Net credits used</span>
                  <span className="settings-usage-breakdown-value">
                    {netUsed.toLocaleString()}
                  </span>
                </div>
              </div>
            </div>
          )}

          {totalJobs === 0 ? (
            <div className="settings-empty" style={{ marginTop: 20, padding: "24px 0" }}>
              No generations yet
            </div>
          ) : (
            <>
              <MostRecentCard items={data?.recent ?? []} />
              <ModelBreakdownCard groups={modelGroups} />
            </>
          )}

          <h3 className="settings-section-title" style={{ marginTop: 28, fontSize: 14 }}>Advanced</h3>
          <div className="settings-card settings-card--full">
            <div className="settings-toggle-row">
              <div className="settings-toggle-info">
                <span className="settings-toggle-label">Show generation cost on buttons</span>
                <span className="settings-toggle-desc">Display the estimated credit cost inside each Generate button. For power users.</span>
              </div>
              <button
                type="button"
                className={`rpanel-toggle ${showCost ? "rpanel-toggle--on" : ""}`}
                onClick={handleShowCostToggle}
                aria-pressed={showCost}
              >
                <span className="rpanel-toggle-knob" />
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}

function ProfileSection() {
  const { user, updateProfile } = useAuth();
  const [displayName, setDisplayName] = useState(user?.displayName || "");
  const [avatarPreview, setAvatarPreview] = useState<string | null>(user?.avatarUrl || null);
  const [avatarError, setAvatarError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    if (user) {
      setDisplayName(user.displayName);
      setAvatarPreview(user.avatarUrl || null);
    }
  }, [user]);

  const handleAvatarChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await resizeImageToDataUrl(file, 256);
      setAvatarPreview(dataUrl);
      await updateProfile({ avatarUrl: dataUrl });
    } catch {
      setAvatarError("Could not process image. Please try another file.");
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [updateProfile]);

  const handleRemoveAvatar = async () => {
    setAvatarPreview(null);
    await updateProfile({ avatarUrl: null });
  };

  const handleSave = async () => {
    setSaveError("");
    setSaving(true);
    setSaved(false);
    const result = await updateProfile({ displayName });
    setSaving(false);
    if (result.error) setSaveError(result.error);
    else setSaved(true);
  };

  const letterInitial = (user?.displayName || user?.email || "U")[0].toUpperCase();

  return (
    <>
      <h2 className="settings-section-title">Profile</h2>
      <div className="settings-card">
        <div className="settings-field">
          <label className="settings-label">Avatar</label>
          <div className="settings-avatar">
            <button
              type="button"
              className="settings-avatar-upload-btn"
              onClick={() => fileInputRef.current?.click()}
              title="Click to upload photo"
            >
              {avatarPreview
                ? <img src={avatarPreview} alt="Avatar" className="settings-avatar-img" />
                : <span className="settings-avatar-letter">{letterInitial}</span>
              }
              <span className="settings-avatar-overlay">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                Upload
              </span>
            </button>
            <div className="settings-avatar-actions">
              <span className="settings-avatar-hint">JPG, PNG or GIF · max 5 MB</span>
              {avatarPreview && (
                <button type="button" className="settings-btn-sm settings-btn-sm--danger" onClick={handleRemoveAvatar}>
                  Remove photo
                </button>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={handleAvatarChange}
            />
          </div>
        </div>
        {avatarError && <div className="settings-auth-error">{avatarError}</div>}
        <div className="settings-field">
          <label className="settings-label">Display Name</label>
          <input type="text" className="settings-input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </div>
        <div className="settings-account-actions">
          {saveError && <div className="settings-auth-error settings-account-error">{saveError}</div>}
          {saved && <div className="settings-account-saved">Changes saved</div>}
          <div className="settings-account-btns">
            <button type="button" className="settings-btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? "Saving..." : "Save Changes"}
            </button>
            <button type="button" className="settings-btn-secondary" onClick={() => { setDisplayName(user?.displayName || ""); setSaved(false); setSaveError(""); }} disabled={saving}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function SecuritySection({ onDeleted }: { onDeleted: () => void }) {
  const { user, updateProfile, deleteAccount } = useAuth();
  const [email, setEmail] = useState(user?.email || "");
  const [emailSaving, setEmailSaving] = useState(false);
  const [emailSaved, setEmailSaved] = useState(false);
  const [emailError, setEmailError] = useState("");

  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleteText, setDeleteText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  useEffect(() => {
    if (user) setEmail(user.email);
  }, [user]);

  const [emailVerificationPending, setEmailVerificationPending] = useState(false);

  const handleEmailSave = async () => {
    setEmailError("");
    setEmailSaving(true);
    setEmailSaved(false);
    setEmailVerificationPending(false);
    const result = await updateProfile({ email });
    setEmailSaving(false);
    if (result.error) {
      setEmailError(result.error);
    } else if (result.emailChangeRequested) {
      setEmailVerificationPending(true);
    } else {
      setEmailSaved(true);
    }
  };

  const handleDeleteAccount = async () => {
    setDeleteError("");
    setDeleting(true);
    const result = await deleteAccount();
    setDeleting(false);
    if (result.error) setDeleteError(result.error);
    else onDeleted();
  };

  return (
    <>
      <h2 className="settings-section-title">Security</h2>

      <div className="settings-card">
        <h3 className="settings-card-title">Login & Email</h3>
        <div className="settings-field">
          <label className="settings-label">Authentication Method</label>
          <div className="settings-card-desc" style={{ padding: "8px 12px", background: "rgba(255,255,255,0.04)", borderRadius: 6, fontSize: 14 }}>
            {user?.authMethod || "AuthKit"}
          </div>
        </div>
        <p className="settings-card-desc" style={{ marginTop: 8 }}>Your account is managed through AuthKit. Passwords and login methods are handled securely by the auth provider.</p>
        <div className="settings-field">
          <label className="settings-label">Email Address</label>
          <input type="email" className="settings-input" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        {emailError && <div className="settings-auth-error">{emailError}</div>}
        {emailSaved && <div className="settings-account-saved">Email updated</div>}
        {emailVerificationPending && <div className="settings-account-saved">Verification email sent to {email}. Please check your inbox to confirm the change.</div>}
        <p className="settings-card-desc">A verification email will be sent to your new address. The change takes effect after you confirm it.</p>
        <div className="settings-card-footer">
          <button type="button" className="settings-btn-primary" onClick={handleEmailSave} disabled={emailSaving || email === user?.email}>
            {emailSaving ? "Saving..." : "Update Email"}
          </button>
        </div>
      </div>

      <div className="settings-card" style={{ marginTop: 16 }}>
        <h3 className="settings-card-title">Active Sessions</h3>
        <p className="settings-card-desc">Session management coming soon.</p>
      </div>

      <div className="settings-card settings-card--danger" style={{ marginTop: 16 }}>
        <h3 className="settings-card-title settings-card-title--danger">Danger Zone</h3>
        <p className="settings-card-desc">Permanently delete your account and all associated data. This action cannot be undone.</p>
        {deleteConfirm ? (
          <>
            <div className="settings-field">
              <label className="settings-label">Type DELETE to confirm</label>
              <input type="text" className="settings-input" placeholder="DELETE" value={deleteText} onChange={(e) => setDeleteText(e.target.value)} />
            </div>
            {deleteError && <div className="settings-auth-error">{deleteError}</div>}
            <div className="settings-card-footer">
              <button type="button" className="settings-btn-danger" onClick={handleDeleteAccount} disabled={deleteText !== "DELETE" || deleting}>
                {deleting ? "Deleting..." : "Permanently Delete Account"}
              </button>
              <button type="button" className="settings-btn-secondary" onClick={() => { setDeleteConfirm(false); setDeleteText(""); setDeleteError(""); }}>Cancel</button>
            </div>
          </>
        ) : (
          <div className="settings-card-footer">
            <button type="button" className="settings-btn-danger" onClick={() => setDeleteConfirm(true)}>Delete Account</button>
          </div>
        )}
      </div>
    </>
  );
}

type PlanData = {
  name: string;
  tagline: string;
  price: string;
  billing: string;
  discount: string | null;
  credits: string;
  creditEq: string;
  bonus: string | null;
  features: string[];
  enduring: { name: string; status: string | null }[];
  more: { name: string; included: boolean; status?: string }[];
  tag: string;
  highlighted?: boolean;
  badge?: string;
  borderTrace?: boolean;
};

const PLANS: PlanData[] = [
  {
    name: "Starter",
    tagline: "For individuals exploring AI",
    price: "$29",
    billing: "Billed monthly",
    discount: null,
    credits: "3,050",
    creditEq: "~190 Nano Banana Pro Generations",
    bonus: "+5% bonus",
    features: ["Flex AI Canvas", "Vibe Cinema Studio", "Node Canvas", "Motion Control Studio", "Eleven Labs, Music, Voice & SFX"],
    enduring: [
      { name: "Kling O3 Pro", status: null },
      { name: "Kling O3 4K", status: null },
      { name: "Nano Banana Pro", status: null },
      { name: "Seedance 2.0", status: null },
      { name: "Elevenlabs", status: "Soon" },
    ],
    more: [
      { name: "Image Upscaler", included: true },
      { name: "Nano — Social Kit", included: true },
      { name: "AI Academy", included: false, status: "Soon" },
      { name: "Art Directed Prompts", included: false, status: "Soon" },
    ],
    tag: "starter",
  },
  {
    name: "Pro",
    tagline: "For professional creatives",
    price: "$59",
    billing: "Billed monthly",
    discount: null,
    credits: "6,500",
    creditEq: "~406 Nano Banana Pro Generations",
    bonus: "+10% bonus",
    features: ["Flex AI Canvas", "Vibe Cinema Studio", "Node Canvas", "Motion Control Studio", "Eleven Labs, Music, Voice & SFX"],
    enduring: [
      { name: "Kling O3 Pro", status: null },
      { name: "Kling O3 4K", status: null },
      { name: "Nano Banana Pro", status: null },
      { name: "Seedance 2.0", status: null },
      { name: "Elevenlabs", status: "Soon" },
    ],
    more: [
      { name: "Image Upscaler", included: true },
      { name: "Nano — Social Kit", included: true },
      { name: "AI Academy", included: true, status: "Soon" },
      { name: "Art Directed Prompts", included: true, status: "Soon" },
    ],
    tag: "pro",
    highlighted: true,
    badge: "Most Popular",
    borderTrace: true,
  },
  {
    name: "Power",
    tagline: "For creatives who need volume",
    price: "$119",
    billing: "Billed monthly",
    discount: null,
    credits: "13,700",
    creditEq: "~856 Nano Banana Pro Generations",
    bonus: "+15% bonus",
    features: ["Flex AI Canvas", "Vibe Cinema Studio", "Node Canvas", "Motion Control Studio", "Eleven Labs, Music, Voice & SFX"],
    enduring: [
      { name: "Kling O3 Pro", status: null },
      { name: "Kling O3 4K", status: null },
      { name: "Nano Banana Pro", status: null },
      { name: "Seedance 2.0", status: null },
      { name: "Elevenlabs", status: "Soon" },
    ],
    more: [
      { name: "Image Upscaler", included: true },
      { name: "Nano — Social Kit", included: true },
      { name: "AI Academy", included: true, status: "Soon" },
      { name: "Art Directed Prompts", included: true, status: "Soon" },
    ],
    tag: "power",
    highlighted: true,
  },
];

const PLAN_TIER_ORDER: Record<string, number> = { starter: 1, pro: 2, power: 3 };

function PlanCard({ plan, isActive, onSelect, loading, activePlanTag }: { plan: PlanData; isActive: boolean; onSelect: (tag: string) => void; loading: boolean; activePlanTag: string | null }) {
  const isUpgrade = activePlanTag ? (PLAN_TIER_ORDER[plan.tag] || 0) > (PLAN_TIER_ORDER[activePlanTag] || 0) : false;
  const isDowngrade = activePlanTag ? (PLAN_TIER_ORDER[plan.tag] || 0) < (PLAN_TIER_ORDER[activePlanTag] || 0) : false;
  const credits = parseInt(plan.credits.replace(/,/g, ""), 10) || 0;
  const priceNum = parseInt(plan.price.replace(/[^0-9]/g, ""), 10) || 0;
  const generations = Math.round(credits / 2);
  const perGen = generations > 0 ? `$${(priceNum / generations).toFixed(3)}` : "$0.000";
  const isPro = plan.tag === "pro";
  const ctaLabel = isActive
    ? "Current Plan"
    : loading
      ? "Processing..."
      : isUpgrade
        ? `Upgrade to ${plan.name}`
        : isDowngrade
          ? `Downgrade to ${plan.name}`
          : `Select ${plan.name}`;
  return (
    <div className={`sub2-plan ${isPro ? "sub2-plan--featured" : ""}`}>
      {plan.badge && <span className="sub2-plan__badge">{plan.badge}</span>}
      <div className="sub2-plan__head">
        <span className="sub2-plan__name">{plan.name}</span>
        <span className="sub2-plan__tagline">{plan.tagline}</span>
      </div>
      <div className="sub2-plan__price-row">
        <span className="sub2-plan__price">{plan.price}</span>
        <span className="sub2-plan__period">/month</span>
      </div>
      <span className="sub2-plan__billing">Billed monthly · Cancel anytime</span>

      <div className="sub2-plan__divider" />

      <div className="sub2-plan__gens">
        <span className="sub2-thin sub2-plan__gens-num">~{generations.toLocaleString()}</span>
        <span className="sub2-plan__gens-label">GPT Image 2 generations / month</span>
      </div>

      <div className="sub2-plan__stats">
        <div className="sub2-plan__stat">
          <span className="sub2-plan__stat-label">CREDITS / MO</span>
          <span className="sub2-plan__stat-val">
            {credits.toLocaleString()}
            {plan.bonus && <span className="sub2-plan__bonus">{plan.bonus.replace(" bonus", "")}</span>}
          </span>
        </div>
        <div className="sub2-plan__stat">
          <span className="sub2-plan__stat-label">PER GENERATION</span>
          <span className="sub2-plan__stat-val">
            {perGen}
            <span className="sub2-plan__stat-unit"> /gen</span>
          </span>
        </div>
      </div>

      <button
        type="button"
        className={`sub2-plan__cta ${isPro ? "sub2-plan__cta--accent" : ""} ${isActive ? "sub2-plan__cta--current" : ""}`}
        onClick={() => !isActive && onSelect(plan.tag)}
        disabled={isActive || loading}
      >
        {ctaLabel}
      </button>
      <span className="sub2-plan__footnote">Switch or cancel anytime</span>
    </div>
  );
}

const ONE_TIME_PRESETS = [10, 25, 50, 100];

function BuyCreditsCard() {
  const { activeWorkspace } = useWorkspace();
  const [creditsPerDollar, setCreditsPerDollar] = useState(100);
  const [dollarAmount, setDollarAmount] = useState(25);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isOrgWorkspace = activeWorkspace?.type === "org";
  const isWorkspaceAdmin = isOrgWorkspace && (activeWorkspace?.role === "owner" || activeWorkspace?.role === "admin");

  useEffect(() => {
    fetch("/api/payments/config")
      .then((r) => r.json())
      .then((data) => {
        if (data.creditsPerDollar) setCreditsPerDollar(data.creditsPerDollar);
      })
      .catch(() => {});
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value.replace(/[^0-9]/g, "");
    const val = Math.min(Number(raw) || 0, 500);
    setDollarAmount(val);
    setError(null);
  };

  const credits = dollarAmount > 0 ? dollarAmount * creditsPerDollar : 0;
  const equivGens = Math.floor(credits / 2);

  const handleBuy = async () => {
    if (dollarAmount < 1) {
      setError("Minimum purchase is $1");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/payments/checkout/credits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          amount: dollarAmount * 100,
          ...(isWorkspaceAdmin && activeWorkspace ? { workspace_id: activeWorkspace.id } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to start checkout");
        return;
      }
      if (data.url) {
        window.location.href = data.url;
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="sub2-onetime">
      <span className="sub2-onetime__eyebrow">ONE-TIME PURCHASE</span>
      <h3 className="sub2-onetime__title">Buy credits, no subscription</h3>
      <p className="sub2-onetime__sub">Pay once. Use them whenever. Credits never expire.</p>

      <div className="sub2-onetime__highlight">
        <span className="sub2-thin sub2-onetime__highlight-price">$0.01</span>
        <span className="sub2-onetime__highlight-text">per credit · {creditsPerDollar} credits per dollar</span>
      </div>

      <div className="sub2-onetime__presets">
        {ONE_TIME_PRESETS.map((d) => {
          const c = d * creditsPerDollar;
          const g = Math.floor(c / 2);
          const active = dollarAmount === d;
          return (
            <button
              key={d}
              type="button"
              className={`sub2-onetime__preset ${active ? "sub2-onetime__preset--active" : ""}`}
              onClick={() => { setDollarAmount(d); setError(null); }}
            >
              <span className="sub2-onetime__preset-price">${d}</span>
              <span className="sub2-onetime__preset-meta">{c.toLocaleString()} credits · ~{g.toLocaleString()} generations</span>
            </button>
          );
        })}
      </div>

      <div className="sub2-onetime__custom">
        <div className="sub2-onetime__custom-col">
          <span className="sub2-onetime__custom-label">CUSTOM AMOUNT</span>
          <div className="sub2-onetime__input-wrap">
            <span className="sub2-onetime__input-dollar">$</span>
            <input
              type="text"
              className="sub2-onetime__input"
              value={dollarAmount}
              onChange={handleChange}
              inputMode="numeric"
            />
          </div>
          <span className="sub2-onetime__custom-hint">$1 minimum · $500 maximum</span>
        </div>
        <span className="sub2-onetime__arrow" aria-hidden="true">→</span>
        <div className="sub2-onetime__custom-col">
          <span className="sub2-onetime__custom-label">YOU'LL RECEIVE</span>
          <span className="sub2-onetime__receive">
            <span className="sub2-thin sub2-onetime__receive-num">{credits.toLocaleString()}</span>
            <span className="sub2-onetime__receive-unit"> credits</span>
          </span>
          <span className="sub2-onetime__custom-hint">≈ {equivGens.toLocaleString()} GPT Image 2 generations</span>
        </div>
      </div>

      <div className="sub2-onetime__footer">
        <span className="sub2-onetime__secure">Secure checkout via Stripe · No subscription, charged once</span>
        <button
          type="button"
          className="sub2-onetime__cta"
          onClick={handleBuy}
          disabled={loading || dollarAmount < 1}
        >
          {loading ? "Redirecting..." : `Buy ${credits.toLocaleString()} credits`}
        </button>
      </div>

      {error && <div className="sub2-onetime__error">{error}</div>}
    </div>
  );
}

function WorkspaceTabPlaceholder() {
  return (
    <div className="sub2-placeholder">
      <span className="sub2-placeholder__eyebrow">WORKSPACE</span>
      <h3 className="sub2-placeholder__title">Team subscriptions, coming soon</h3>
      <p className="sub2-placeholder__sub">
        Manage workspace seats, shared credit pools, and admin controls. Workspace subscription instructions to follow.
      </p>
    </div>
  );
}

type SubTab = "subs" | "credits" | "workspace";

function SubscriptionSection() {
  const { activeWorkspace } = useWorkspace();
  const { subscription } = useSubscription();
  const { balance, bonusCredits, unlimited } = useCreditsContext();
  const [selectingPlan, setSelectingPlan] = useState<string | null>(null);
  const [tab, setTab] = useState<SubTab>("subs");
  const [planError, setPlanError] = useState<string | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);
  const isOrgWorkspace = activeWorkspace?.type === "org";
  const isWorkspaceAdmin = isOrgWorkspace && (activeWorkspace?.role === "owner" || activeWorkspace?.role === "admin");

  const activePlan = subscription?.planTier || null;
  const planLabel = activePlan
    ? `${activePlan.charAt(0).toUpperCase()}${activePlan.slice(1)} Plan`
    : "Free Plan";
  const handleSelectPlan = async (plan: string) => {
    setSelectingPlan(plan);
    setPlanError(null);
    try {
      const res = await fetch("/api/payments/checkout/subscription", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          plan,
          ...(isWorkspaceAdmin && activeWorkspace ? { workspace_id: activeWorkspace.id } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setPlanError(data.error || "Something went wrong. Please try again.");
        return;
      }
      if (data.upgraded) { window.location.reload(); return; }
      if (data.url) { window.location.href = data.url; return; }
      setPlanError("Unexpected response from server. Please refresh and try again.");
    } catch {
      setPlanError("Network error. Please check your connection and try again.");
    } finally {
      setSelectingPlan(null);
    }
  };

  const handleManageBilling = async () => {
    setPortalLoading(true);
    setPlanError(null);
    try {
      const res = await fetch("/api/payments/portal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) {
        setPlanError(data.error || "Could not open billing portal. Please try again.");
        return;
      }
      if (data.url) window.location.href = data.url;
    } catch {
      setPlanError("Network error. Please check your connection and try again.");
    } finally {
      setPortalLoading(false);
    }
  };

  return (
    <div className="sub2-root">
      <header className="sub2-header">
        <div className="sub2-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "subs"}
            className={`sub2-tab ${tab === "subs" ? "sub2-tab--active" : ""}`}
            onClick={() => setTab("subs")}
          >Subscriptions</button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "credits"}
            className={`sub2-tab ${tab === "credits" ? "sub2-tab--active" : ""}`}
            onClick={() => setTab("credits")}
          >One-time Credits</button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "workspace"}
            className={`sub2-tab ${tab === "workspace" ? "sub2-tab--active" : ""}`}
            onClick={() => setTab("workspace")}
          >Workspace</button>
        </div>
        <div className="sub2-header__top-right">
          <div className="sub2-header__pill">
            <span className="sub2-header__pill-dot" aria-hidden="true" />
            <span className="sub2-header__pill-name">{planLabel}</span>
            <span className="sub2-header__pill-divider">|</span>
            <span className="sub2-header__pill-credits">
              {unlimited
                ? "Unlimited credits"
                : `${balance.toLocaleString()} credits${
                    bonusCredits > 0 ? ` · +${bonusCredits.toLocaleString()} bonus` : ""
                  }`}
            </span>
          </div>
          {(subscription || unlimited) && (
            <button
              type="button"
              className="sub2-header__gear"
              onClick={handleManageBilling}
              disabled={portalLoading}
              aria-label="Manage subscription"
              title="Manage subscription"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          )}
        </div>
      </header>

      {planError && <div className="sub2-error">{planError}</div>}

      {tab === "subs" && (
        <div className="sub2-panel" key="subs">
          <div className="sub2-plan-grid">
            {PLANS.map((p) => (
              <PlanCard
                key={p.tag}
                plan={p}
                isActive={activePlan === p.tag}
                onSelect={handleSelectPlan}
                loading={selectingPlan === p.tag}
                activePlanTag={activePlan}
              />
            ))}
          </div>
          <ul className="sub2-trustline" aria-label="Plan guarantees">
            <li className="sub2-trustline__item">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
              Secure payment via Stripe
            </li>
            <li className="sub2-trustline__item">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              No setup fees
            </li>
            <li className="sub2-trustline__item">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 12a9 9 0 0 1 15.5-6.3L21 8" />
                <polyline points="21 3 21 8 16 8" />
                <path d="M21 12a9 9 0 0 1-15.5 6.3L3 16" />
                <polyline points="3 21 3 16 8 16" />
              </svg>
              Switch plans whenever
            </li>
          </ul>
        </div>
      )}

      {tab === "credits" && (
        <div className="sub2-panel" key="credits">
          <BuyCreditsCard />
        </div>
      )}

      {tab === "workspace" && (
        <div className="sub2-panel" key="workspace">
          <WorkspaceTabPlaceholder />
        </div>
      )}
    </div>
  );
}

/** Setup — probe the local components the app shells out to, and install the
 *  missing ones in a real Terminal window. */
/* ─── Service logos ───────────────────────────────────────────────────────
 * A row reads far faster with the vendor's own mark in front of it. We pull
 * the favicon straight from the vendor's domain — no third-party icon proxy,
 * so the only host contacted is the one whose logo is shown — and fall back
 * to a monogram tile when it 404s or the row has no domain at all (local
 * binaries like Git and FFmpeg mostly do have one). */
const LOGO_DOMAIN: Record<string, string> = {
  homebrew: "brew.sh",
  git: "git-scm.com",
  ffmpeg: "ffmpeg.org",
  "claude code": "claude.ai",
  "claude code cli": "claude.ai",
  "openai codex": "openai.com",
  "openai codex cli": "openai.com",
  higgsfield: "higgsfield.ai",
  "higgsfield cli": "higgsfield.ai",
  github: "github.com",
  atlassian: "atlassian.com",
  canva: "canva.com",
  notion: "notion.so",
  figma: "figma.com",
  "monday.com": "monday.com",
  cloudflare: "cloudflare.com",
  lovable: "lovable.dev",
  kit: "kit.com",
  n8n: "n8n.io",
  clockwise: "getclockwise.com",
  linear: "linear.app",
  slack: "slack.com",
  dropbox: "dropbox.com",
  gmail: "google.com",
  "google drive": "google.com",
  "google calendar": "google.com",
};

function logoDomain(name: string, url?: string): string | undefined {
  const key = name.toLowerCase().replace(/^claude\.ai /, "").trim();
  if (LOGO_DOMAIN[key]) return LOGO_DOMAIN[key];
  if (!url) return undefined;
  try {
    // MCP endpoints live on a subdomain of the vendor's own site
    // (mcp.figma.com, drivemcp.googleapis.com) — the apex serves the logo.
    const host = new URL(url).hostname;
    const parts = host.split(".");
    return parts.length > 2 ? parts.slice(-2).join(".") : host;
  } catch { return undefined; }
}

/** Vendors whose apex /favicon.ico 404s — checked by hand, so a broken one
 *  here means they moved it, not that the fallback is wrong. */
const LOGO_URL: Record<string, string> = {
  "figma.com": "https://static.figma.com/app/icon/1/favicon.svg",
  "notion.so": "https://www.notion.so/front-static/favicon.ico",
  "brew.sh": "https://brew.sh/assets/img/homebrew.svg",
};

/** Vendors whose own favicon we don't want to depend on: claude.ai and
 *  openai.com both serve one that a plain <img> can't reliably fetch, which
 *  left the two most important rows on the page showing a grey "C". Official
 *  marks, inlined so they never miss and never hit the network. */
const BRAND_PATH: Record<string, string> = {
  "claude.ai": "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
  "openai.com": "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
};

function ServiceLogo({ name, url }: { name: string; url?: string }) {
  const [failed, setFailed] = useState(false);
  const domain = logoDomain(name, url);
  const brand = domain ? BRAND_PATH[domain] : undefined;
  const src = domain ? LOGO_URL[domain] || `https://${domain}/favicon.ico` : undefined;
  const letter = (name.replace(/^claude\.ai /i, "").trim()[0] || "?").toUpperCase();
  if (brand) {
    return (
      <span className="settings-logo settings-logo--brand" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d={brand} /></svg>
      </span>
    );
  }
  return (
    <span className="settings-logo" aria-hidden="true">
      {src && !failed
        ? <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} />
        : letter}
    </span>
  );
}

function SetupSection() {
  type SetupRow = { id: string; label: string; found: boolean; path: string; install: string | null; note?: string };
  const [rows, setRows] = useState<SetupRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/setup/doctor", { credentials: "include" });
      if (res.ok) setRows((await res.json()).rows || []);
    } catch { /* offline */ }
  }, []);
  useEffect(() => {
    void load();
    // Installs happen in Terminal, so coming back to the app is the cue to re-probe.
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);

  const install = async (id: string) => {
    setBusy(id);
    try {
      await fetch("/api/setup/install", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }),
      });
    } catch { /* the Terminal window is the feedback */ }
    await load();
    setBusy(null);
  };

  return (
    <div className="settings-notifications-wrap">
      <h2 className="settings-section-title">Setup</h2>
      <div className="settings-card settings-card--full">
        {rows.map((r) => (
          <div className="settings-toggle-row" key={r.id}>
            <ServiceLogo name={r.label} />
            <div className="settings-toggle-info">
              <span className="settings-toggle-label">{r.label}</span>
              <span className="settings-toggle-desc">
                {r.found ? `Found at ${r.path}` : "Not installed"}
                {!r.found && r.note ? ` — ${r.note}` : ""}
              </span>
            </div>
            {!r.found && (
              <button
                type="button"
                className="settings-btn-primary"
                disabled={!r.install || busy !== null}
                title={r.install ? undefined : r.note}
                onClick={() => void install(r.id)}
              >
                {busy === r.id ? "Installing in Terminal…" : "Install"}
              </button>
            )}
          </div>
        ))}
        <div className="settings-card-note">
          Install opens a Terminal window so you can watch it and answer any password prompt.
        </div>
      </div>
    </div>
  );
}

/** Which agent CLI drives the in-app operator. Driven entirely by the runner
 *  list GET /api/operator/status returns, so a third runner needs no UI work. */
function ProvidersSection() {
  type RunnerRow = { id: string; label: string; binaryFound: boolean; binaryPath: string; models?: { id: string; label: string }[]; catalog?: { id: string; label: string }[] };
  const [runners, setRunners] = useState<RunnerRow[]>([]);
  const [active, setActive] = useState<string>("claude");
  const [error, setError] = useState<string | null>(null);
  const [auth, setAuth] = useState<Record<string, boolean>>({});
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const loadAuth = useCallback(async () => {
    try {
      const res = await fetch("/api/operator/auth", { credentials: "include" });
      if (res.ok) setAuth(await res.json());
    } catch { /* offline */ }
  }, []);
  useEffect(() => { void loadAuth(); }, [loadAuth]);
  const signIn = async (id: string) => {
    setSigningIn(id);
    try {
      await fetch("/api/operator/login", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runner: id }),
      });
    } catch { /* reported by loadAuth */ }
    await loadAuth();
    setSigningIn(null);
  };

  const load = useCallback(async (url = "/api/operator/status", init?: RequestInit) => {
    try {
      const res = await fetch(url, { credentials: "include", ...init });
      if (!res.ok) { setError(`Couldn't load providers (${res.status})`); return; }
      const data = await res.json();
      setRunners(Array.isArray(data.runners) ? data.runners : []);
      if (typeof data.runner === "string") setActive(data.runner);
      setError(null);
    } catch { setError("Network error"); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const choose = (id: string) => {
    setActive(id); // optimistic: the radio must not lag the click
    load("/api/operator/runner", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runner: id }),
    });
  };

  return (
    <div className="settings-notifications-wrap">
      <h2 className="settings-section-title">Providers</h2>
      <div className="settings-card settings-card--full">
        {error && <div className="settings-toggle-desc" role="alert">{error}</div>}
        {runners.map((r) => (
          <label className="settings-toggle-row" key={r.id} style={{ cursor: "pointer" }}>
            <ServiceLogo name={r.label} />
            <div className="settings-toggle-info">
              <span className="settings-toggle-label">{r.label}</span>
              <span className="settings-toggle-desc">
                {r.binaryFound ? `Found at ${r.binaryPath}` : `Not installed (looked for "${r.binaryPath}")`}
                {r.binaryFound && (auth[r.id] ? " · Signed in" : " · Not signed in")}
              </span>
              {!r.binaryFound && <span className="settings-toggle-desc">Install it from Setup above</span>}
            </div>
            {r.binaryFound && !auth[r.id] && (
              <button
                type="button"
                className="settings-btn-primary"
                disabled={signingIn !== null}
                onClick={(e) => { e.preventDefault(); void signIn(r.id); }}
              >
                {signingIn === r.id ? "Finish sign-in in your browser…" : "Sign in"}
              </button>
            )}
            <input
              type="radio"
              name="operator-runner"
              checked={active === r.id}
              onChange={() => choose(r.id)}
            />
          </label>
        ))}
        {/* Model picks, for runners with a catalog worth pruning. Ticked = in the
            panel dropdown; nothing ticked = whole catalog. */}
        {runners.filter((r) => r.binaryFound && (r.catalog?.length ?? 0) > 6).map((r) => {
          const picks = new Set(r.models?.length === r.catalog?.length ? [] : (r.models ?? []).map((m) => m.id));
          const save = (ids: string[]) => load("/api/operator/models", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runner: r.id, ids }),
          });
          return (
            <div key={`models-${r.id}`} className="settings-toggle-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
              <span className="settings-toggle-label">{r.label} models in the dropdown</span>
              <span className="settings-toggle-desc">Tick the ones you use. None ticked shows all {r.catalog?.length}.</span>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "2px 12px" }}>
                {(r.catalog ?? []).map((m) => (
                  <label key={m.id} style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={picks.has(m.id)}
                      onChange={(e) => save(e.target.checked ? [...picks, m.id] : [...picks].filter((id) => id !== m.id))}
                    />
                    <span className="settings-toggle-desc">{m.label}</span>
                  </label>
                ))}
              </div>
            </div>
          );
        })}
        <div className="settings-card-note">
          Switching provider starts a fresh operator conversation — sessions can't move between CLIs.
        </div>
      </div>
    </div>
  );
}

type ConnectorRow = { runner: "claude" | "codex" | "opencode"; name: string; url?: string; command?: string; status: "connected" | "needs_auth" | "unknown"; enabled: boolean };
type CatalogRow = { id: string; label: string; url: string; blurb: string };
type HiggsfieldStatus = { installed: boolean; loggedIn: boolean; account: string; skills: number };

/** The user's external MCP servers, and a catalog to add popular ones. Nothing
 *  here handles a credential: adding registers a URL with the CLI, and signing
 *  in is the CLI's own browser flow. */
function ConnectorsSection() {
  const [rows, setRows] = useState<ConnectorRow[]>([]);
  const [catalog, setCatalog] = useState<CatalogRow[]>([]);
  const [hf, setHf] = useState<HiggsfieldStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/connectors", { credentials: "include" });
      if (res.ok) { const d = await res.json(); setRows(d.connectors || []); setCatalog(d.catalog || []); setHf(d.higgsfield ?? null); }
    } catch { /* offline */ }
    setLoading(false);
  }, []);
  useEffect(() => {
    void load();
    // Adding and signing in both finish outside the app — a browser tab or a
    // Terminal window — so coming back is the cue to re-probe.
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);

  const post = async (path: string, body: unknown, key: string) => {
    setBusy(key);
    try {
      await fetch(`/api/connectors/${path}`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
    } catch { /* load() reports the real state */ }
    await load();
    setBusy(null);
  };

  // A claude.ai connector is listed as "claude.ai Figma", not "figma", so match
  // on the normalised tail rather than the raw name — otherwise the catalog
  // offers to add what the user already has.
  const norm = (v: string) => v.toLowerCase().replace(/^claude\.ai /, "").replace(/[^a-z0-9]/g, "");
  const present = new Set(rows.map((r) => norm(r.name)));

  return (
    <div className="settings-notifications-wrap">
      <h2 className="settings-section-title">Connectors</h2>
      <div className="settings-card settings-card--full">
        {loading && <div className="settings-toggle-desc">Checking your MCP servers…</div>}
        {!loading && !rows.length && <div className="settings-toggle-desc">No MCP servers configured yet — add one from the catalog below.</div>}
        {rows.map((r) => (
          <label className="settings-toggle-row" key={`${r.runner}:${r.name}`} style={{ cursor: "pointer" }}>
            <ServiceLogo name={r.name} url={r.url} />
            <div className="settings-toggle-info">
              <span className="settings-toggle-label">{r.name}</span>
              <span className="settings-toggle-desc">
                {r.runner === "claude" ? "Claude Code" : r.runner === "opencode" ? "OpenCode" : "Codex"} · {r.status === "connected" ? "Connected" : r.status === "needs_auth" ? "Needs sign-in" : "Unknown"}
                {r.url || r.command ? ` · ${r.url || r.command}` : ""}
              </span>
            </div>
            {r.status === "needs_auth" && (
              <button
                type="button"
                className="settings-btn-primary"
                disabled={busy !== null}
                onClick={(e) => { e.preventDefault(); void post("login", { runner: r.runner, name: r.name }, `login:${r.name}`); }}
              >
                {busy === `login:${r.name}` ? "Finish sign-in…" : "Sign in"}
              </button>
            )}
            <input
              type="checkbox"
              checked={r.enabled}
              disabled={busy !== null}
              onChange={(e) => void post("enable", { runner: r.runner, name: r.name, enabled: e.target.checked }, `en:${r.name}`)}
            />
          </label>
        ))}
        <div className="settings-card-note">
          Switched-on servers become tools the operator can call. Anything you connect at claude.ai → Settings
          → Connectors shows up here automatically.
        </div>
      </div>

      <h2 className="settings-section-title">Higgsfield</h2>
      <div className="settings-card settings-card--full">
        <div className="settings-toggle-row">
          <ServiceLogo name="Higgsfield CLI" />
          <div className="settings-toggle-info">
            <span className="settings-toggle-label">Higgsfield CLI</span>
            <span className="settings-toggle-desc">
              {!hf ? "Checking…" : !hf.installed ? "Not installed" : !hf.loggedIn ? "Needs sign-in" : hf.account || "Signed in"}
              {hf ? ` · ${hf.skills} of 6 skills mirrored` : ""}
            </span>
          </div>
          <button
            type="button"
            className="settings-btn-primary"
            disabled={busy !== null || !hf}
            onClick={() => void post("higgsfield/setup", {}, "hf")}
          >
            {busy === "hf" ? "Working…" : !hf?.installed ? "Install" : !hf?.loggedIn ? "Sign in" : "Update skills"}
          </button>
        </div>
        <div className="settings-card-note">
          A second generation route on your Higgsfield plan (Seedance, Kling, Veo, Soul, GPT Image…). Sign-in is the
          CLI's own browser login; the official Higgsfield skills are mirrored into your skill library.
        </div>
      </div>

      <h2 className="settings-section-title">Catalog</h2>
      <div className="settings-card settings-card--full">
        {catalog.filter((c) => !present.has(norm(c.id)) && !present.has(norm(c.label))).map((c) => (
          <div className="settings-toggle-row" key={c.id}>
            <ServiceLogo name={c.label} url={c.url} />
            <div className="settings-toggle-info">
              <span className="settings-toggle-label">{c.label}</span>
              <span className="settings-toggle-desc">{c.blurb}</span>
            </div>
            <button
              type="button"
              className="settings-btn-primary"
              disabled={busy !== null}
              onClick={() => void post("add", { id: c.id }, `add:${c.id}`)}
            >
              {busy === `add:${c.id}` ? "Adding…" : "Add"}
            </button>
          </div>
        ))}
        <div className="settings-card-note">
          Adding registers the server with your CLIs. Most then need one sign-in, in your browser.
        </div>
      </div>
    </div>
  );
}

type OperatorJob = {
  id: string; name: string; prompt: string; cron: string; enabled: boolean;
  last_run_at: string | null; next_run_at: string | null;
  last_result: string | null; last_error: string | null; fails: number;
};

const CRON_PRESETS: { label: string; cron: string }[] = [
  { label: "Hourly", cron: "0 * * * *" },
  { label: "Daily 9am", cron: "0 9 * * *" },
  { label: "Weekdays 9am", cron: "0 9 * * 1-5" },
  { label: "Mondays 9am", cron: "0 9 * * 1" },
];

function fmtWhen(v: string | null): string {
  if (!v) return "\u2014";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "\u2014" : d.toLocaleString();
}

function ScheduledRunsSection() {
  const [jobs, setJobs] = useState<OperatorJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [cron, setCron] = useState("0 9 * * 1");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/operator/jobs", { credentials: "include" });
      if (!res.ok) { setError(`Couldn't load scheduled runs (${res.status})`); return; }
      const data = await res.json();
      setJobs(Array.isArray(data.jobs) ? data.jobs : []);
      setError(null);
    } catch { setError("Network error"); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const send = async (url: string, init: RequestInit) => {
    setBusy(true);
    try {
      const res = await fetch(url, { credentials: "include", headers: { "Content-Type": "application/json" }, ...init });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || `Request failed (${res.status})`);
        return false;
      }
      setError(null);
      return true;
    } catch { setError("Network error"); return false; }
    finally { setBusy(false); }
  };

  const create = async () => {
    if (!name.trim() || !prompt.trim() || !cron.trim()) { setError("Name, prompt and schedule are all required"); return; }
    const okd = await send("/api/operator/jobs", { method: "POST", body: JSON.stringify({ name, prompt, cron }) });
    if (okd) { setName(""); setPrompt(""); await load(); }
  };

  const patch = async (id: string, body: Record<string, unknown>) => {
    if (await send(`/api/operator/jobs/${id}`, { method: "PATCH", body: JSON.stringify(body) })) await load();
  };
  const remove = async (id: string) => {
    if (await send(`/api/operator/jobs/${id}`, { method: "DELETE" })) await load();
  };
  const runNow = async (id: string) => {
    if (await send(`/api/operator/jobs/${id}/run`, { method: "POST" })) await load();
  };

  return (
    <div className="settings-notifications-wrap">
      <h2 className="settings-section-title">Scheduled runs</h2>
      {error && <div className="settings-toggle-desc" role="alert">{error}</div>}

      <div className="settings-card settings-card--full">
        {jobs.length === 0 && <div className="settings-toggle-desc">No scheduled runs yet.</div>}
        {jobs.map((j) => (
          <div className="settings-toggle-row" key={j.id}>
            <div className="settings-toggle-info">
              <span className="settings-toggle-label">{j.name}</span>
              <span className="settings-toggle-desc">
                <code>{j.cron}</code> · next {fmtWhen(j.next_run_at)} · last {fmtWhen(j.last_run_at)}
              </span>
              {j.last_error
                ? <span className="settings-toggle-desc" style={{ color: "var(--danger, #d66)" }}>
                    {j.fails >= 3 ? "Paused after 3 failures: " : ""}{j.last_error.slice(0, 200)}
                  </span>
                : j.last_result && <span className="settings-toggle-desc">{j.last_result.slice(0, 200)}</span>}
            </div>
            <button type="button" className="settings-btn-primary" disabled={busy} onClick={() => void runNow(j.id)}>Run now</button>
            <button type="button" className="settings-btn-primary" disabled={busy} onClick={() => void remove(j.id)}>Delete</button>
            <button
              type="button"
              className={`rpanel-toggle ${j.enabled ? "rpanel-toggle--on" : ""}`}
              aria-pressed={j.enabled}
              aria-label={j.enabled ? "Disable" : "Enable"}
              disabled={busy}
              onClick={() => void patch(j.id, { enabled: !j.enabled })}
            >
              <span className="rpanel-toggle-knob" />
            </button>
          </div>
        ))}
      </div>

      <div className="settings-card settings-card--full">
        <div className="settings-toggle-info" style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%" }}>
          <span className="settings-toggle-label">New scheduled run</span>
          <input
            type="text" placeholder="Name (e.g. Hero shot variants)"
            value={name} onChange={(e) => setName(e.target.value)}
          />
          <textarea
            rows={4} placeholder="What should the operator do? Write it as a complete standalone instruction."
            value={prompt} onChange={(e) => setPrompt(e.target.value)}
          />
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {CRON_PRESETS.map((p) => (
              <button key={p.cron} type="button" className="settings-btn-primary" onClick={() => setCron(p.cron)}>{p.label}</button>
            ))}
          </div>
          <input type="text" placeholder="0 9 * * 1" value={cron} onChange={(e) => setCron(e.target.value)} />
          <span className="settings-toggle-desc">
            Five-field cron, in this machine's local time zone: minute hour day-of-month month day-of-week.
          </span>
          <div>
            <button type="button" className="settings-btn-primary" disabled={busy} onClick={() => void create()}>Add scheduled run</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function NotificationsSection() {
  const [soundOn, setSoundOn] = useState(getSoundEnabled);

  const handleSoundToggle = () => {
    const next = !soundOn;
    setSoundOn(next);
    setSoundEnabled(next);
  };

  return (
    <div className="settings-notifications-wrap">
      <h2 className="settings-section-title">Notifications</h2>
      <div className="settings-card settings-card--full">
        <div className="settings-toggle-row">
          <div className="settings-toggle-info">
            <span className="settings-toggle-label">Sound Notifications</span>
            <span className="settings-toggle-desc">Play sounds when generations start, complete, or fail</span>
          </div>
          <button
            type="button"
            className={`rpanel-toggle ${soundOn ? "rpanel-toggle--on" : ""}`}
            onClick={handleSoundToggle}
            aria-pressed={soundOn}
          >
            <span className="rpanel-toggle-knob" />
          </button>
        </div>
        <ToggleRow label="Email Notifications" description="Receive updates about your generations via email (coming soon)" defaultOn />
        <ToggleRow label="Push Notifications" description="Browser push notifications for completed tasks (coming soon)" defaultOn />
        <ToggleRow label="Weekly Digest" description="Summary of your weekly activity (coming soon)" defaultOn />
      </div>
    </div>
  );
}

function GeneralSection() {
  const { activeWorkspace, workspaces, setActiveWorkspace, refreshWorkspaces, createWorkspace, deleteWorkspace } = useWorkspace();
  const [workspace, setWorkspaceData] = useState<Workspace | null>(null);
  const [wsName, setWsName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");
  const myRole = activeWorkspace?.role ?? "member";
  const canEdit = myRole === "owner" || myRole === "admin";
  const isDirty = workspace ? wsName !== workspace.name : false;

  const [newWsName, setNewWsName] = useState("");
  const [creatingWs, setCreatingWs] = useState(false);
  const [createWsError, setCreateWsError] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(false);

  const [confirmDeleteName, setConfirmDeleteName] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  useEffect(() => {
    if (!activeWorkspace) return;
    getWorkspace(activeWorkspace.id).then((res) => {
      if (res.workspace) {
        setWorkspaceData(res.workspace);
        setWsName(res.workspace.name);
      }
    });
    setShowDeleteConfirm(false);
    setConfirmDeleteName("");
    setDeleteError("");
  }, [activeWorkspace]);

  const handleSave = async () => {
    if (!activeWorkspace) return;
    setSaving(true);
    setSaved(false);
    setSaveError("");
    const res = await updateWorkspace(wsName, activeWorkspace.id);
    setSaving(false);
    if (res.error) {
      setSaveError(res.error);
    } else if (res.workspace) {
      setWorkspaceData(res.workspace);
      setSaved(true);
      refreshWorkspaces();
    }
  };

  const handleCreateWorkspace = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newWsName.trim() || creatingWs) return;
    setCreatingWs(true);
    setCreateWsError("");
    const result = await createWorkspace(newWsName.trim());
    setCreatingWs(false);
    if (result.error) {
      setCreateWsError(result.error);
    } else {
      setNewWsName("");
      setShowCreateForm(false);
    }
  };

  const handleDelete = async () => {
    if (!activeWorkspace || !workspace) return;
    setDeleting(true);
    setDeleteError("");
    const result = await deleteWorkspace(activeWorkspace.id);
    setDeleting(false);
    if (result.error) {
      setDeleteError(result.error);
    }
  };

  const isPersonal = activeWorkspace?.type === "personal";
  const isOwner = myRole === "owner";

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 0 }}>
        <h2 className="settings-section-title" style={{ marginBottom: 0 }}>General</h2>
        <button
          type="button"
          className="settings-btn-primary"
          style={{ fontSize: 13, padding: "6px 14px", whiteSpace: "nowrap" }}
          onClick={() => { setShowCreateForm((v) => { if (v) setNewWsName(""); return !v; }); setCreateWsError(""); }}
        >
          {showCreateForm ? "Cancel" : "+ New"}
        </button>
      </div>
      {showCreateForm && (
        <div className="settings-card" style={{ marginTop: 16, marginBottom: 8 }}>
          <form onSubmit={handleCreateWorkspace} style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
            <div className="settings-field" style={{ flex: 1, marginBottom: 0 }}>
              <label className="settings-label">Team Name</label>
              <input
                type="text"
                className="settings-input"
                value={newWsName}
                onChange={(e) => setNewWsName(e.target.value)}
                placeholder="My Team"
                maxLength={100}
                autoFocus
              />
            </div>
            <button type="submit" className="settings-btn-primary" disabled={!newWsName.trim() || creatingWs} style={{ marginBottom: 0, whiteSpace: "nowrap" }}>
              {creatingWs ? "Creating..." : "Create"}
            </button>
          </form>
          {createWsError && <div className="settings-auth-error" style={{ marginTop: 8 }}>{createWsError}</div>}
        </div>
      )}
      <div className="settings-field" style={{ marginBottom: 20, marginTop: showCreateForm ? 8 : 20 }}>
        <label className="settings-label">Team</label>
        <select
          className="settings-input"
          value={activeWorkspace?.id ?? ""}
          onChange={(e) => {
            const ws = workspaces.find((w) => w.id === e.target.value);
            if (ws) setActiveWorkspace(ws);
          }}
        >
          {workspaces.map((ws) => (
            <option key={ws.id} value={ws.id}>{ws.name}</option>
          ))}
        </select>
      </div>
      <div className="settings-card">
        <div className="settings-field">
          <label className="settings-label">Team Name</label>
          <input type="text" className="settings-input" value={wsName} onChange={(e) => setWsName(e.target.value)} disabled={!canEdit} />
        </div>
        <div className="settings-field">
          <label className="settings-label">Team ID</label>
          <span className="settings-value settings-value--mono">{workspace ? workspace.id : "—"}</span>
        </div>
        <div className="settings-field">
          <label className="settings-label">Team Type</label>
          <span className="settings-value">{workspace?.type ? workspace.type.charAt(0).toUpperCase() + workspace.type.slice(1) : "—"}</span>
        </div>
        <div className="settings-field">
          <label className="settings-label">Your Role</label>
          <span className="settings-value">{myRole.charAt(0).toUpperCase() + myRole.slice(1)}</span>
        </div>
        {saveError && <div className="settings-auth-error" style={{ marginTop: 8 }}>{saveError}</div>}
        {saved && <div style={{ color: "var(--accent)", fontSize: 13, marginTop: 8 }}>Changes saved</div>}
      </div>
      {canEdit && isDirty && (
        <div className="settings-card-footer">
          <button type="button" className="settings-btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save Changes"}
          </button>
        </div>
      )}

      {isPersonal && (
        <>
          <h3 className="settings-subsection-title" style={{ marginTop: 32 }}>Danger Zone</h3>
          <div className="settings-card settings-card--danger">
            <p className="settings-card-desc" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
              Your personal team cannot be deleted.
            </p>
          </div>
        </>
      )}
      {!isPersonal && isOwner && (
        <>
          <h3 className="settings-subsection-title" style={{ marginTop: 32 }}>Danger Zone</h3>
          <div className="settings-card settings-card--danger">
            <h4 className="settings-card-title settings-card-title--danger">Delete Team</h4>
            <p className="settings-card-desc">This action is permanent and cannot be undone. All team data, members, and invitations will be removed.</p>
            {!showDeleteConfirm ? (
              <button type="button" className="settings-btn-danger" onClick={() => setShowDeleteConfirm(true)}>Delete Team</button>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div className="settings-field">
                  <label className="settings-label">Type "{workspace?.name}" to confirm</label>
                  <input
                    type="text"
                    className="settings-input"
                    value={confirmDeleteName}
                    onChange={(e) => setConfirmDeleteName(e.target.value)}
                    placeholder={workspace?.name}
                    autoFocus
                  />
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" className="settings-btn-secondary" onClick={() => { setShowDeleteConfirm(false); setConfirmDeleteName(""); setDeleteError(""); }}>Cancel</button>
                  <button type="button" className="settings-btn-danger" disabled={confirmDeleteName !== workspace?.name || deleting} onClick={handleDelete}>
                    {deleting ? "Deleting..." : "Permanently Delete"}
                  </button>
                </div>
                {deleteError && <div className="settings-auth-error">{deleteError}</div>}
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}

function MembersSection() {
  const [members, setMembers] = useState<Member[]>([]);
  const [actionError, setActionError] = useState("");
  const { user } = useAuth();
  const { activeWorkspace } = useWorkspace();
  const myRole = activeWorkspace?.role ?? "member";
  const canManage = myRole === "owner" || myRole === "admin";

  useEffect(() => {
    if (!activeWorkspace) return;
    getMembers(activeWorkspace.id).then((res) => setMembers(res.members));
  }, [activeWorkspace]);

  const handleRoleChange = async (memberId: string, newRole: string) => {
    if (!activeWorkspace) return;
    setActionError("");
    const res = await changeRole(memberId, newRole, activeWorkspace.id);
    if (res.error) {
      setActionError(res.error);
    } else {
      setMembers((prev) => prev.map((m) => m.id === memberId ? { ...m, role: newRole } : m));
    }
  };

  const handleRemove = async (memberId: string) => {
    if (!activeWorkspace) return;
    setActionError("");
    const res = await removeMember(memberId, activeWorkspace.id);
    if (res.error) {
      setActionError(res.error);
    } else {
      setMembers((prev) => prev.filter((m) => m.id !== memberId));
    }
  };

  return (
    <>
      <h2 className="settings-section-title">Members</h2>
      {actionError && <div className="settings-auth-error" style={{ marginBottom: 12 }}>{actionError}</div>}
      <div className="settings-card">
        {members.length === 0 ? (
          <span className="settings-empty">Loading members...</span>
        ) : (
          members.map((m) => {
            const isMe = m.id === user?.id;
            const isOwner = m.role === "owner";
            const canChangeRole = canManage && !isMe && !isOwner;
            const canRemoveThis = canManage && !isMe && !isOwner;
            return (
              <div key={m.id} className="settings-member-row">
                <div className="settings-member-avatar" style={!m.avatarUrl ? { background: `hsl(${Math.abs([...m.email].reduce((h, c) => c.charCodeAt(0) + ((h << 5) - h), 0)) % 360}, 55%, 45%)`, color: '#fff' } : undefined}>
                  {m.avatarUrl
                    ? <img src={m.avatarUrl} alt="" className="settings-member-avatar-img" />
                    : (m.displayName || m.email)[0].toUpperCase()
                  }
                </div>
                <div className="settings-member-info">
                  <span className="settings-member-name">
                    {isMe ? "You" : m.displayName || m.email.split("@")[0]}
                  </span>
                  <span className="settings-member-email">{m.email}</span>
                </div>
                {canChangeRole ? (
                  <select
                    className="settings-role-select"
                    value={m.role}
                    onChange={(e) => handleRoleChange(m.id, e.target.value)}
                  >
                    {myRole === "owner" && <option value="admin">Admin</option>}
                    <option value="member">Member</option>
                  </select>
                ) : (
                  <span className="settings-member-role">{m.role.charAt(0).toUpperCase() + m.role.slice(1)}</span>
                )}
                {canRemoveThis && (
                  <button type="button" className="settings-btn-sm settings-btn-sm--danger" onClick={() => handleRemove(m.id)}>
                    Remove
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

function InvitationsSection() {
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState<string>("member");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const { activeWorkspace } = useWorkspace();
  const myRole = activeWorkspace?.role ?? "member";
  const canManage = myRole === "owner" || myRole === "admin";

  useEffect(() => {
    if (!activeWorkspace) return;
    getInvitations(activeWorkspace.id).then((res) => setInvitations(res.invitations));
  }, [activeWorkspace]);

  const handleSend = async () => {
    if (!newEmail.trim() || !activeWorkspace) return;
    setError("");
    setSending(true);
    const res = await sendInvitation(newEmail.trim(), newRole, activeWorkspace.id);
    setSending(false);
    if (res.error) {
      setError(res.error);
    } else if (res.invitation) {
      setInvitations((prev) => [res.invitation!, ...prev]);
      setNewEmail("");
      setNewRole("member");
    }
  };

  const handleResend = async (id: string) => {
    if (!activeWorkspace) return;
    await resendInvitation(id, activeWorkspace.id);
  };

  const handleRevoke = async (id: string) => {
    if (!activeWorkspace) return;
    const res = await revokeInvitation(id, activeWorkspace.id);
    if (!res.error) {
      setInvitations((prev) => prev.filter((inv) => inv.id !== id));
    }
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };

  if (!canManage) {
    return (
      <>
        <h2 className="settings-section-title">Invitations</h2>
        <div className="settings-card">
          <span className="settings-empty">Only owners and admins can manage invitations.</span>
        </div>
      </>
    );
  }

  return (
    <>
      <h2 className="settings-section-title">Invitations</h2>
      <div className="settings-card">
        {invitations.length === 0 ? (
          <span className="settings-empty">No pending invitations</span>
        ) : (
          invitations.map((inv) => (
            <div key={inv.id} className="settings-invite-row">
              <div className="settings-invite-info">
                <span className="settings-invite-email">{inv.email}</span>
                <span className="settings-invite-date">Sent {formatDate(inv.sentAt)} · {inv.role.charAt(0).toUpperCase() + inv.role.slice(1)}</span>
              </div>
              <span className="settings-invite-status">{inv.status.charAt(0).toUpperCase() + inv.status.slice(1)}</span>
              <div className="settings-invite-actions">
                <button type="button" className="settings-btn-sm" onClick={() => handleResend(inv.id)}>Resend</button>
                <button type="button" className="settings-btn-sm settings-btn-sm--danger" onClick={() => handleRevoke(inv.id)}>Revoke</button>
              </div>
            </div>
          ))
        )}
      </div>
      <div className="settings-card-footer settings-invite-form">
        <input
          type="email"
          className="settings-input settings-invite-form__email"
          placeholder="Email address"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleSend(); }}
        />
        <select
          className="settings-role-select settings-invite-form__role"
          value={newRole}
          onChange={(e) => setNewRole(e.target.value)}
        >
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
        <button
          type="button"
          className="settings-btn-primary settings-invite-form__submit"
          onClick={handleSend}
          disabled={sending}
        >
          {sending ? "Sending..." : "Send Invitation"}
        </button>
      </div>
      {error && <div className="settings-auth-error" style={{ marginTop: 8 }}>{error}</div>}
    </>
  );
}

function PrivacyPolicySection() {
  return (
    <>
      <h2 className="settings-section-title">Privacy Policy</h2>
      <div className="settings-card">
        <div className="settings-field">
          <p className="settings-policy-text">
            Last updated: April 1, 2026. This Privacy Policy describes how Matte Black AI Inc collects, uses, discloses, and otherwise processes personal information about you when you access or use teseract.studio.
          </p>
        </div>
        <div className="settings-field">
          <label className="settings-label">Full document</label>
          <div className="settings-policy-scroll">
            <h3>TESERACT.STUDIO — PRIVACY POLICY</h3>
            <p><em>Last Updated: April 1, 2026</em></p>
            <p>This Privacy Policy describes how Matte Black AI Inc ("Company," "we," "us," or "our") collects, uses, discloses, and otherwise processes personal information about you when you access or use our website teseract.studio and our AI-powered generative media platform (collectively, our "Services"), and when you otherwise interact with us such as through our customer support channels.</p>
            <p>Teseract.studio is an AI-native platform that uses artificial intelligence to generate creative content. This Privacy Policy is designed to help you understand how we handle your personal information and, critically, how we handle the content you create using our AI features.</p>
            <p>If you are an enterprise user of the Services and your use is governed by an enterprise contract, we may handle your personal information as a service provider (sometimes called a "processor") on behalf of the enterprise customer. Personal information processed on behalf of our enterprise customers under such contracts is governed by those contracts and not this Privacy Policy. If you are an enterprise user, please contact the enterprise customer who has provided you with access to our Services.</p>
            <p>We may update this Privacy Policy from time to time. If we make changes, we will notify you by revising the date at the top of this policy. If we make material changes, we will provide you with additional notice (such as by adding a statement to the Services or sending you a notification). We encourage you to review this Privacy Policy regularly to stay informed about our information practices and the choices available to you.</p>

            <h4>1. Information We Collect</h4>
            <p>The information we collect about you depends on how you use our Services and interact with us. We collect information in the following categories:</p>

            <p><strong>1.1 Information You Provide Directly</strong></p>
            <p>We collect information you provide to us directly, including when you:</p>
            <ul>
              <li>Create an account (name, email address, password)</li>
              <li>Make a purchase (billing information, which is processed by our third-party payment processor)</li>
              <li>Contact customer support (your communications, support tickets, and any information you provide)</li>
              <li>Complete surveys or provide feedback</li>
              <li>Communicate with us through email, social media, or other channels</li>
            </ul>

            <p><strong>1.2 Customer Input and Output Content</strong></p>
            <p>When you use our AI Features, we collect:</p>
            <ul>
              <li><strong>Customer Input:</strong> The prompts, text, images, media, files, and other content you submit to our AI Features for processing</li>
              <li><strong>Output Content:</strong> The AI-generated content our Services create in response to your Customer Input</li>
            </ul>
            <p>See Section 3 below for critical information about how we use (and DON'T use) this content.</p>

            <p><strong>1.3 Information We Collect Automatically</strong></p>
            <p>We automatically collect certain information when you use our Services, including:</p>
            <ul>
              <li><strong>Device and Usage Information:</strong> Device type, operating system, browser type, IP address, unique device identifiers, pages viewed, features used, time spent on pages, access times and dates, and referring URLs</li>
              <li><strong>Transaction Information:</strong> Details about your purchases, including credits purchased, features used, and usage metrics</li>
              <li><strong>Log Data:</strong> Server logs, error messages, system activity, and diagnostic information</li>
              <li><strong>Cookies and Similar Technologies:</strong> Information collected through cookies, pixels, web beacons, and similar tracking technologies (see Section 9 for details)</li>
            </ul>

            <p><strong>1.4 Information from Third-Party Sources</strong></p>
            <p>We may collect information from third-party sources, including:</p>
            <ul>
              <li><strong>Payment Processors:</strong> Payment card information (last 4 digits), billing address, transaction details</li>
              <li><strong>Authentication Providers:</strong> If you create an account or log in using a third-party service (such as Google or GitHub), we receive information from that service such as your name, email address, and profile information, in accordance with that service's authorization procedures</li>
              <li><strong>Analytics Providers:</strong> Usage statistics and demographic information to help us understand how our Services are used</li>
            </ul>

            <p><strong>1.5 Information We Derive</strong></p>
            <p>We may derive or infer information about you based on the information we collect. For example, we may infer your approximate location based on your IP address, or infer preferences based on your usage patterns.</p>

            <h4>2. How We Use Your Information</h4>
            <p>We use the personal information we collect for the following purposes:</p>

            <p><strong>2.1 To Provide and Improve the Services</strong></p>
            <ul>
              <li>Operate, maintain, and deliver the Services to you</li>
              <li>Process your requests and generate AI-powered content</li>
              <li>Personalize your experience and improve service quality</li>
              <li>Develop new features and capabilities</li>
              <li>Monitor usage patterns and system performance</li>
            </ul>

            <p><strong>2.2 For Business Operations</strong></p>
            <ul>
              <li>Process payments and manage your account</li>
              <li>Send transactional communications (account notifications, service updates, security alerts)</li>
              <li>Provide customer support and respond to inquiries</li>
              <li>Conduct analytics and research to understand user behavior and preferences</li>
            </ul>

            <p><strong>2.3 For Marketing and Communications</strong></p>
            <ul>
              <li>Send you marketing communications, newsletters, and promotional materials (you can opt out at any time)</li>
              <li>Conduct surveys and collect feedback</li>
              <li>Display targeted advertisements on third-party platforms (see Section 9)</li>
            </ul>

            <p><strong>2.4 For Security and Legal Compliance</strong></p>
            <ul>
              <li>Detect, investigate, and prevent fraud, security incidents, and abuse of the Services</li>
              <li>Enforce our Terms of Service and other policies</li>
              <li>Comply with legal obligations, including responding to legal requests and court orders</li>
              <li>Protect the rights, property, and safety of Matte Black AI, our users, and the public</li>
            </ul>

            <h4>3. AI Content and Data Training (Critical Transparency)</h4>
            <p>This section explains how we handle your Customer Input and Output Content, and whether we use your data to train AI models. This is critical for agencies and professional users.</p>

            <p><strong>3.1 What We DO NOT Do With Your Content</strong></p>
            <p><strong>WE DO NOT USE YOUR CUSTOMER INPUT OR OUTPUT CONTENT TO TRAIN OUR AI MODELS OR THIRD-PARTY AI MODELS WITHOUT YOUR EXPLICIT CONSENT.</strong></p>
            <p>Specifically:</p>
            <ul>
              <li>Your prompts, inputs, and creative content are NOT used to improve AI models</li>
              <li>Your AI-generated outputs are NOT used to train AI systems</li>
              <li>We do NOT share your content with third parties for their model training purposes</li>
              <li>Your client work and creative projects remain confidential to you</li>
            </ul>

            <p><strong>3.2 What We DO With Your Content</strong></p>
            <p>We use your Customer Input and Output Content only as necessary to provide the Services:</p>
            <ul>
              <li><strong>Process your requests:</strong> We transmit your Customer Input to our AI systems (including Third-Party AI Providers) to generate Output Content for you</li>
              <li><strong>Store temporarily:</strong> We store your Customer Input and Output Content to deliver it to you and provide account features (such as project history)</li>
              <li><strong>Provide support:</strong> Customer support staff may access your content when necessary to resolve technical issues or respond to support requests</li>
              <li><strong>Safety monitoring:</strong> We may review content to detect violations of our Acceptable Use Policy or illegal activity</li>
            </ul>

            <p><strong>3.3 Usage Data (Anonymized Analytics)</strong></p>
            <p>We DO collect and use anonymized "Usage Data" to improve our Services. Usage Data does NOT include the specific content of your Customer Input or Output Content.</p>
            <p>Usage Data includes:</p>
            <ul>
              <li>Feature usage patterns (which features are used, how often)</li>
              <li>System performance metrics (processing time, error rates)</li>
              <li>Aggregated and anonymized usage statistics</li>
              <li>Technical logs (timestamps, API calls, system events)</li>
            </ul>
            <p>We use Usage Data to: monitor service health, identify bugs, improve performance, understand user needs, develop new features, and optimize our infrastructure.</p>

            <p><strong>3.4 Future Changes to Data Training Policy</strong></p>
            <p>If we ever decide to use customer content for model training or improvement purposes in the future, we will:</p>
            <ul>
              <li>Provide clear advance notice to all users</li>
              <li>Obtain your explicit opt-in consent before using your content</li>
              <li>Provide a simple way to opt out at any time</li>
              <li>Allow you to delete your content if you do not consent</li>
            </ul>

            <h4>4. How We Share Your Information</h4>
            <p>We share personal information in the following circumstances:</p>

            <p><strong>4.1 Service Providers and Vendors</strong></p>
            <p>We share information with third-party service providers who perform services on our behalf, including:</p>
            <ul>
              <li>Cloud hosting and infrastructure providers</li>
              <li>Payment processors</li>
              <li>Customer support platforms</li>
              <li>Email and communication services</li>
              <li>Analytics and monitoring services</li>
              <li>Security and fraud prevention services</li>
            </ul>
            <p>These service providers are contractually obligated to protect your information and use it only for the purposes we specify.</p>

            <p><strong>4.2 Third-Party AI Providers</strong></p>
            <p>See Section 5 below for detailed information about how we share information with Third-Party AI Providers.</p>

            <p><strong>4.3 Team Members and Collaborators</strong></p>
            <p>If you are part of a team or organization account, other members of that account may be able to view certain information associated with the account, including billing information, API usage, and content created through the account.</p>

            <p><strong>4.4 Legal and Safety Purposes</strong></p>
            <p>We may disclose personal information if we believe disclosure is necessary or appropriate to:</p>
            <ul>
              <li>Comply with applicable laws, regulations, legal processes, or governmental requests</li>
              <li>Enforce our Terms of Service or other agreements</li>
              <li>Detect, prevent, or address fraud, security, or technical issues</li>
              <li>Protect the rights, property, or safety of Matte Black AI, our users, or the public</li>
            </ul>

            <p><strong>4.5 Business Transfers</strong></p>
            <p>We may share or transfer personal information in connection with, or during negotiations of, any merger, sale of company assets, financing, or acquisition of all or a portion of our business by another company.</p>

            <p><strong>4.6 With Your Consent</strong></p>
            <p>We may share personal information for other purposes with your consent or at your direction.</p>

            <p><strong>4.7 Aggregated and De-Identified Information</strong></p>
            <p>We may share aggregated or de-identified information that cannot reasonably be used to identify you. We maintain and use this information only in a de-identified fashion and will not attempt to re-identify such information, except as permitted by law.</p>

            <h4>5. Third-Party AI Providers</h4>
            <p>Our Services use Third-Party AI Providers (such as OpenAI, Anthropic, Google, or other AI service providers) to generate Output Content. This section explains how your information is shared with these providers.</p>

            <p><strong>5.1 What Information Is Shared</strong></p>
            <p>When you use AI Features, your Customer Input is transmitted to Third-Party AI Providers for processing. This is necessary to generate Output Content for you.</p>

            <p><strong>5.2 Third-Party Provider Policies</strong></p>
            <p>We select Third-Party AI Providers that represent they do not use customer data for model training without consent. However, each provider has its own privacy policy and terms of service that govern how they handle data. We cannot control or guarantee third-party providers' data practices.</p>
            <p>We periodically review our Third-Party AI Providers' policies and practices, but you acknowledge that third-party data handling is governed by their own policies, not this Privacy Policy.</p>

            <p><strong>5.3 Changes to Third-Party Providers</strong></p>
            <p>We may change, add, or remove Third-Party AI Providers as needed to maintain and improve our Services. We will use commercially reasonable efforts to notify you of material changes that may affect how your data is processed.</p>

            <h4>6. Data Retention</h4>
            <p>We retain personal information for as long as necessary to provide the Services, comply with legal obligations, resolve disputes, and enforce our agreements.</p>

            <p><strong>6.1 Customer Input and Output Content</strong></p>
            <p>Customer Input and Output Content are retained for 60 days after generation unless you delete them earlier through your account settings. You may request deletion at any time by contacting support@teseract.studio.</p>
            <p>Some content may be retained longer for:</p>
            <ul>
              <li>Legal compliance and regulatory requirements</li>
              <li>Security incident investigation and fraud prevention</li>
              <li>Backup and disaster recovery purposes (backups are deleted according to our retention schedule)</li>
              <li>Resolving disputes or enforcing our Terms of Service</li>
            </ul>

            <p><strong>6.2 Account Information</strong></p>
            <p>Account information (name, email, transaction history) is retained for as long as your account is active and for a reasonable period thereafter as needed for business, legal, or regulatory purposes.</p>

            <p><strong>6.3 Usage Data and Analytics</strong></p>
            <p>Anonymized Usage Data may be retained indefinitely for analytics, service improvement, and business intelligence purposes.</p>

            <h4>7. Data Security</h4>
            <p>We implement reasonable technical and organizational measures designed to protect personal information from unauthorized access, disclosure, alteration, and destruction. These measures include:</p>
            <ul>
              <li>Encryption of data in transit and at rest</li>
              <li>Regular security assessments and testing</li>
              <li>Access controls and authentication mechanisms</li>
              <li>Employee training on data protection</li>
              <li>Monitoring for security incidents</li>
            </ul>
            <p>However, no system is completely secure. We cannot guarantee that unauthorized access, hacking, data loss, or other breaches will never occur. You transmit data to and from our Services at your own risk.</p>
            <p>You are responsible for maintaining the security of your account credentials. If you believe your account has been compromised, please contact us immediately at security@teseract.studio.</p>

            <h4>8. Your Privacy Rights and Choices</h4>
            <p>Depending on your location, you may have certain rights regarding your personal information:</p>

            <p><strong>8.1 Access and Portability</strong></p>
            <p>You can access and export your personal information and content through your account dashboard. You may also request a copy of your personal information by contacting us at privacy@teseract.studio.</p>

            <p><strong>8.2 Correction and Update</strong></p>
            <p>You can update your account information at any time through your account settings. If you need assistance, contact support@teseract.studio.</p>

            <p><strong>8.3 Deletion</strong></p>
            <p>You can delete your Customer Input and Output Content through your account settings. To request deletion of your account and associated personal information, contact privacy@teseract.studio. Note that we may retain certain information as required by law or for legitimate business purposes.</p>

            <p><strong>8.4 Marketing Communications</strong></p>
            <p>You can opt out of marketing emails by clicking the "unsubscribe" link in any marketing email or by updating your communication preferences in your account settings. Note that even if you opt out of marketing emails, we will still send you transactional and account-related communications.</p>

            <p><strong>8.5 Additional Rights for European Users</strong></p>
            <p>If you are located in the European Economic Area, United Kingdom, or Switzerland, you have additional rights under the GDPR and UK GDPR, including:</p>
            <ul>
              <li>Right to object to certain processing</li>
              <li>Right to request restriction of processing</li>
              <li>Right to withdraw consent where processing is based on consent</li>
              <li>Right to lodge a complaint with your local data protection authority</li>
            </ul>
            <p>To exercise these rights, contact privacy@teseract.studio.</p>

            <h4>9. Cookies and Tracking Technologies</h4>
            <p>We use cookies, pixels, web beacons, and similar tracking technologies to collect information about your interactions with our Services.</p>

            <p><strong>9.1 Types of Cookies We Use</strong></p>
            <ul>
              <li><strong>Essential Cookies:</strong> Required for the Services to function (e.g., authentication, security)</li>
              <li><strong>Analytics Cookies:</strong> Help us understand how users interact with our Services</li>
              <li><strong>Advertising Cookies:</strong> Used to deliver targeted advertisements and measure campaign effectiveness</li>
              <li><strong>Preference Cookies:</strong> Remember your settings and preferences</li>
            </ul>

            <p><strong>9.2 Your Cookie Choices</strong></p>
            <p>Most web browsers automatically accept cookies, but you can modify your browser settings to decline cookies if you prefer. Note that disabling cookies may affect the functionality of our Services. You can also opt out of interest-based advertising through the Digital Advertising Alliance at www.aboutads.info/choices.</p>

            <h4>10. International Data Transfers</h4>
            <p>Matte Black AI is based in the United States. If you are accessing our Services from outside the United States, please be aware that your information may be transferred to, stored, and processed in the United States and other countries where we or our service providers operate.</p>
            <p>When we transfer personal information from the European Economic Area, United Kingdom, or Switzerland to other countries, we implement appropriate safeguards such as Standard Contractual Clauses approved by the European Commission or other legally recognized transfer mechanisms.</p>

            <h4>11. Children's Privacy</h4>
            <p>Our Services are not intended for individuals under the age of 18. We do not knowingly collect personal information from children under 18. If you are a parent or guardian and believe your child has provided us with personal information, please contact us at privacy@teseract.studio and we will delete such information.</p>

            <h4>12. Contact Us</h4>
            <p>If you have questions, concerns, or requests regarding this Privacy Policy or our data practices, please contact us:</p>
            <p>Email: contact@matteblack.io</p>
            <p>© 2026 Matte Black AI Inc. All rights reserved.</p>
          </div>
        </div>
      </div>
    </>
  );
}

function TermsOfServiceSection() {
  return (
    <>
      <h2 className="settings-section-title">Terms of Service</h2>
      <div className="settings-card">
        <div className="settings-field">
          <p className="settings-policy-text">
            Last updated: April 1, 2026. These Terms of Service govern your access to, and use of, the websites and generative AI platform provided by Matte Black AI Inc at teseract.studio.
          </p>
        </div>
        <div className="settings-field">
          <label className="settings-label">Full document</label>
          <div className="settings-policy-scroll">
            <h3>TESERACT.STUDIO — TERMS OF SERVICE</h3>
            <p><em>Last Updated: April 1, 2026</em></p>
            <p>These Terms of Service ("Terms") apply to your access to, and use of, the websites and generative artificial intelligence ("AI") platform provided by Matte Black AI Inc ("Company," "we," "us," or "our") available at teseract.studio. By accessing or using the Services, you agree to these Terms.</p>
            <p>These Terms form a binding legal contract between Company and you ("Customer," "you," or "your") governing your use of (i) teseract.studio and related websites ("Sites"), and (ii) the Teseract AI-native generative media platform (collectively, the "Services").</p>
            <p><strong>TESERACT.STUDIO IS AN AI-NATIVE PLATFORM. THE SERVICES GENERATE CONTENT USING ARTIFICIAL INTELLIGENCE, WHICH IS PROBABILISTIC AND NOT DETERMINISTIC. OUTPUTS MAY BE INACCURATE, INCOMPLETE, BIASED, OR NON-UNIQUE. YOU ARE SOLELY RESPONSIBLE FOR REVIEWING, VALIDATING, AND APPROVING ALL GENERATED CONTENT BEFORE USE.</strong></p>
            <p><strong>BY AGREEING TO THESE TERMS, YOU AND COMPANY AGREE TO RESOLVE DISPUTES ON AN INDIVIDUAL BASIS THROUGH BINDING ARBITRATION, NOT CLASS ACTION OR JURY TRIAL. YOU MAY OPT OUT WITHIN 30 DAYS AS DESCRIBED IN SECTION 20. IF YOU DO NOT AGREE TO THESE TERMS, DO NOT USE OUR SERVICES.</strong></p>
            <p>We may update these Terms from time to time. The "Last Updated" date above indicates when these Terms were last changed. Continued use of our Services after changes constitutes acceptance of the amended Terms. If you do not agree to amended Terms, you must stop using our Services.</p>

            <h4>1. Definitions</h4>
            <p>(a) "AI Features" means the artificial intelligence and machine learning capabilities of the Services that process Customer Input to generate Output Content.</p>
            <p>(b) "Customer Input" means all information, data, text, queries, prompts, media, files, and other content you submit to or upload into the Services.</p>
            <p>(c) "Output Content" means all content, media, data, text, images, video, audio, or other materials generated by the AI Features in response to Customer Input.</p>
            <p>(d) "Usage Data" means anonymized, aggregated data about how the Services are used, including technical logs, performance metrics, and usage patterns (but excluding the specific content of Customer Input or Output Content).</p>
            <p>(e) "Third-Party AI Providers" means external artificial intelligence service providers (such as OpenAI, Anthropic, or others) whose models or services Company may use to provide the Services.</p>

            <h4>2. Eligibility and Account Requirements</h4>
            <p>You must be at least 18 years old (or the age of legal majority in your jurisdiction) to use our Services. By using the Services, you represent and warrant that you meet this eligibility requirement. If you are using the Services on behalf of an organization, you represent that you have authority to bind that organization to these Terms.</p>
            <p>You must create an account to use the Services. You are responsible for maintaining the confidentiality of your account credentials and for all activities under your account. You must immediately notify us of any unauthorized access to your account. You may not share your account credentials or allow others to use your account.</p>

            <h4>3. Nature of AI-Generated Content (Critical Understanding)</h4>
            <p><strong>3.1 AI Output Characteristics</strong></p>
            <p>The Services use artificial intelligence to generate Output Content. You acknowledge and agree that:</p>
            <p>(a) Output Content is GENERATED, NOT RETRIEVED. AI models create new content based on patterns learned from training data, not by retrieving stored information.</p>
            <p>(b) Output Content is PROBABILISTIC, NOT DETERMINISTIC. The same Customer Input may produce different outputs at different times or for different users.</p>
            <p>(c) Output Content may be INACCURATE, INCOMPLETE, OR FABRICATED. AI models may generate content that appears authoritative but contains factual errors, outdated information, or entirely fabricated details (often called "hallucinations").</p>
            <p>(d) Output Content may contain BIASES. AI models may reflect biases present in their training data.</p>
            <p>(e) Output Content is NOT GUARANTEED TO BE UNIQUE. Similar or identical outputs may be generated for other users providing similar inputs.</p>
            <p>(f) Output Content may INADVERTENTLY RESEMBLE existing copyrighted works. AI models trained on large datasets may generate content similar to materials in their training data.</p>

            <p><strong>3.2 No Guarantees of Quality or Fitness</strong></p>
            <p>We make NO WARRANTIES OR GUARANTEES about:</p>
            <ul>
              <li>The accuracy, completeness, or reliability of Output Content</li>
              <li>The suitability of Output Content for any particular purpose</li>
              <li>The achievement of any business outcomes or results from using Output Content</li>
              <li>That Output Content will meet your requirements or your clients' requirements</li>
              <li>That Output Content will be free from errors, inaccuracies, or biases</li>
            </ul>

            <p><strong>3.3 No Professional Advice</strong></p>
            <p><strong>THE SERVICES DO NOT PROVIDE LEGAL, MEDICAL, FINANCIAL, TAX, ACCOUNTING, INVESTMENT, OR OTHER PROFESSIONAL ADVICE.</strong> Output Content should not be relied upon as a substitute for consultation with qualified professionals. Any Output Content related to professional matters is for informational and creative purposes only. You are solely responsible for consulting with appropriate licensed professionals before making decisions based on Output Content.</p>
            <p>If you use Output Content in connection with professional services you provide to clients, you remain solely responsible for ensuring the accuracy, completeness, and appropriateness of any professional advice or deliverables you provide.</p>

            <h4>4. Your Responsibility: Human Review Required</h4>
            <p><strong>YOU ARE SOLELY RESPONSIBLE FOR:</strong></p>
            <p>(a) REVIEWING all Output Content for accuracy, completeness, appropriateness, and compliance with applicable laws before any use;</p>
            <p>(b) EDITING, MODIFYING, OR CORRECTING Output Content as necessary;</p>
            <p>(c) VERIFYING factual claims, data, statistics, or other information in Output Content;</p>
            <p>(d) ENSURING Output Content does not infringe third-party intellectual property rights;</p>
            <p>(e) DETERMINING whether Output Content is suitable for your intended use, including commercial use or delivery to clients;</p>
            <p>(f) ALL CONSEQUENCES of using, publishing, distributing, or relying on Output Content.</p>
            <p><strong>The Services are tools that assist your creative and business processes. They do not replace human judgment, expertise, or responsibility. Do not use Output Content without thorough human review and validation.</strong></p>

            <h4>5. Intellectual Property and Ownership</h4>
            <p><strong>5.1 Your Ownership of Customer Input</strong></p>
            <p>You retain all ownership rights in your Customer Input. By submitting Customer Input to the Services, you grant us a limited, non-exclusive, royalty-free license to use, process, store, and display your Customer Input solely to provide the Services to you and as described in these Terms.</p>

            <p><strong>5.2 Your Rights in Output Content</strong></p>
            <p>Subject to the limitations described in this Section 5, you own the Output Content generated from your Customer Input, and you may use it for any lawful purpose, including commercial purposes.</p>
            <p><strong>HOWEVER, you acknowledge and agree that:</strong></p>
            <p>(a) Output Content is NOT EXCLUSIVE to you. Similar or identical content may be generated for other users.</p>
            <p>(b) We make NO GUARANTEE that Output Content is free from third-party intellectual property rights. You bear all risk if Output Content infringes third-party rights.</p>
            <p>(c) Output Content may be similar to content in AI training datasets or content generated for others.</p>
            <p>(d) We do NOT grant you any rights in the underlying AI models, algorithms, or methodologies used to generate Output Content.</p>

            <p><strong>5.3 Company's Intellectual Property</strong></p>
            <p>Company exclusively owns all right, title, and interest in and to: (i) the Services, including all software, AI models, algorithms, workflows, user interfaces, and underlying technology; (ii) the Teseract brand, trademarks, and trade dress; (iii) all improvements, modifications, and derivatives of the Services; and (iv) all intellectual property rights in the foregoing. No rights are granted to you except as expressly stated in these Terms.</p>

            <p><strong>5.4 Commercial Use Rights for Agencies</strong></p>
            <p>If you are an agency, consultant, or service provider using the Services to create deliverables for clients, you may:</p>
            <ul>
              <li>Use Output Content in client deliverables</li>
              <li>Transfer Output Content to clients as part of your services</li>
              <li>Charge clients for services that incorporate Output Content</li>
            </ul>
            <p>PROVIDED THAT you: (i) comply with all Terms; (ii) review and validate all Output Content before delivery to clients; (iii) do not misrepresent Output Content as solely human-created if you have not substantially modified it; and (iv) accept full responsibility for any claims arising from your use or your client's use of Output Content.</p>

            <h4>6. Data Usage, Storage, and Privacy</h4>
            <p><strong>6.1 How We Handle Your Data (Critical Transparency)</strong></p>
            <p>We are committed to transparency about how we handle your data:</p>
            <p><strong>CUSTOMER INPUT:</strong></p>
            <ul>
              <li>We store Customer Input temporarily to process your requests and provide the Services</li>
              <li>We DO NOT use your Customer Input to train our AI models or improve our Services without your explicit consent</li>
              <li>Customer Input may be transmitted to Third-Party AI Providers as necessary to generate Output Content (see Section 7)</li>
            </ul>
            <p><strong>OUTPUT CONTENT:</strong></p>
            <ul>
              <li>We store Output Content temporarily to deliver it to you and provide account features (such as history or project management)</li>
              <li>We DO NOT use your Output Content to train our AI models without your explicit consent</li>
              <li>You may delete Output Content from your account at any time</li>
            </ul>
            <p><strong>USAGE DATA:</strong></p>
            <ul>
              <li>We collect and use anonymized Usage Data (as defined in Section 1) to: monitor, maintain, and improve the Services; analyze usage patterns and system performance; develop new features and capabilities</li>
              <li>Usage Data does NOT include the specific content of your Customer Input or Output Content</li>
            </ul>

            <p><strong>6.2 Data Retention</strong></p>
            <p>Customer Input and Output Content are retained for 60 days after generation unless you delete them earlier. You may request deletion of your data by contacting support@teseract.studio. Some data may be retained longer for legal, security, compliance, or operational reasons as described in our Privacy Policy.</p>

            <p><strong>6.3 Your Data Rights</strong></p>
            <p>You have the right to access, export, and delete your Customer Input and Output Content. For detailed information about our data practices and your privacy rights, see our Privacy Policy at teseract.studio/privacy.</p>

            <h4>7. Third-Party AI Providers and Dependencies</h4>
            <p><strong>7.1 Use of Third-Party AI Services</strong></p>
            <p>The Services rely in part on Third-Party AI Providers (such as OpenAI, Anthropic, Google, or other AI service providers) to generate Output Content. You acknowledge and agree that:</p>
            <p>(a) Your Customer Input may be transmitted to Third-Party AI Providers for processing</p>
            <p>(b) Third-Party AI Providers have their own terms of service and privacy policies</p>
            <p>(c) We select Third-Party AI Providers that represent they do not use customer data for model training without consent, though we cannot guarantee their compliance with such representations</p>
            <p>(d) We cannot guarantee Third-Party AI Providers' compliance with their own policies</p>

            <p><strong>7.2 No Liability for Third-Party Provider Issues</strong></p>
            <p>We are not responsible or liable for:</p>
            <ul>
              <li>Service outages, interruptions, or degraded performance caused by Third-Party AI Providers</li>
              <li>Changes to Third-Party AI Provider capabilities, features, or pricing</li>
              <li>Quality, accuracy, or characteristics of Output Content generated by Third-Party AI Providers</li>
              <li>Third-Party AI Provider data handling, privacy, or security practices</li>
              <li>Termination or suspension of Third-Party AI Provider services</li>
            </ul>

            <p><strong>7.3 Changes to Third-Party Providers</strong></p>
            <p>We reserve the right to change, add, or remove Third-Party AI Providers at any time as needed to maintain and improve the Services. We will use commercially reasonable efforts to notify you of material changes that may affect Output Content quality or capabilities.</p>

            <h4>8. Pricing, Credits, and Usage Limits</h4>
            <p><strong>8.1 Usage-Based Pricing</strong></p>
            <p>The Services operate on a usage-based pricing model. Pricing is based on compute resources consumed, which may vary depending on factors including:</p>
            <ul>
              <li>Type and complexity of AI models used</li>
              <li>Length and complexity of Customer Input</li>
              <li>Size and format of Output Content requested</li>
              <li>Processing time and computational resources required</li>
            </ul>
            <p>Current pricing is available at teseract.studio/pricing and may be updated from time to time as described in Section 8.4.</p>

            <p><strong>8.2 Credits System</strong></p>
            <p>To use the Services, you must purchase credits in advance. Credits are deducted from your account balance each time you use the Services. You are solely responsible for maintaining a sufficient credit balance. If your credit balance is insufficient, you will not be able to use the Services until you purchase additional credits.</p>
            <p>Credits expire 365 days from the date of purchase unless otherwise specified. Promotional or free credits may have different expiration periods as specified when granted. Credits are non-refundable except as required by law or as expressly stated in these Terms, non-transferable, and may not be exchanged for cash.</p>

            <p><strong>8.3 Usage Limits and Rate Limiting</strong></p>
            <p>We reserve the right to impose usage limits, rate limits, or other restrictions to:</p>
            <ul>
              <li>Ensure fair access to the Services for all users</li>
              <li>Prevent abuse or excessive usage that impacts system performance</li>
              <li>Manage computational costs and infrastructure capacity</li>
              <li>Comply with limitations imposed by Third-Party AI Providers</li>
            </ul>
            <p>If you require higher usage limits, please contact sales@teseract.studio to discuss enterprise plans.</p>

            <p><strong>8.4 Price Changes</strong></p>
            <p>We may change our pricing at any time. Price changes will be posted at teseract.studio/pricing. For purchased credits, price changes will not affect credits already in your account. New credit purchases after a price change will be at the new pricing. We will use commercially reasonable efforts to provide advance notice of material price increases.</p>

            <p><strong>8.5 Taxes</strong></p>
            <p>You are responsible for all taxes, duties, and charges imposed on your use of the Services, excluding taxes based on Company's net income. All prices are stated exclusive of applicable taxes unless otherwise noted.</p>

            <h4>9. Acceptable Use Policy</h4>
            <p><strong>9.1 Prohibited Uses</strong></p>
            <p>You may not use the Services to create, upload, transmit, distribute, or store Customer Input or Output Content that:</p>
            <p>(a) Is illegal, fraudulent, defamatory, obscene, pornographic, or otherwise objectionable</p>
            <p>(b) Infringes or violates intellectual property rights, privacy rights, or other rights of any third party</p>
            <p>(c) Contains or promotes hate speech, violence, discrimination, or harassment based on race, ethnicity, religion, gender, sexual orientation, disability, or other protected characteristics</p>
            <p>(d) Exploits, harms, or attempts to exploit or harm minors in any way, including child sexual abuse material</p>
            <p>(e) Promotes or facilitates self-harm, suicide, eating disorders, or dangerous activities</p>
            <p>(f) Contains malware, viruses, or other malicious code</p>
            <p>(g) Violates any applicable law or regulation</p>

            <p><strong>9.2 AI-Specific Prohibited Uses</strong></p>
            <p>You may not use the Services to:</p>
            <p>(a) Create DEEPFAKES or synthetic media that: impersonate real individuals without their consent; are intended to deceive or mislead; could cause harm to individuals or organizations</p>
            <p>(b) Generate content that MISREPRESENTS its origin or nature, including: representing AI-generated content as human-created in contexts where such representation would be deceptive or misleading under applicable law (including FTC regulations); creating fake reviews, testimonials, endorsements, or social proof; generating academic papers or assignments for submission as original student work</p>
            <p>(c) Use the Services for HIGH-RISK APPLICATIONS without appropriate human oversight, including: medical diagnosis or treatment recommendations; legal advice or legal document preparation without attorney review; financial advice or investment recommendations; safety-critical systems or life-or-death decision-making; automated decision-making that materially affects individuals' rights without human review</p>
            <p>(d) Generate SPAM, unsolicited communications, or deceptive marketing materials</p>
            <p>(e) Create content for DISINFORMATION campaigns, political manipulation, or election interference</p>
            <p>(f) Generate content that VIOLATES PLATFORM POLICIES of third-party services where you intend to publish the content</p>
            <p>(g) Attempt to REVERSE ENGINEER, extract, or replicate our AI models or underlying technology</p>
            <p>(h) Use Output Content to TRAIN COMPETING AI MODELS or services</p>
            <p>(i) Systematically extract data from the Services through SCRAPING, automation, or bulk downloading</p>
            <p>(j) Circumvent usage limits, security measures, or access controls</p>

            <p><strong>9.3 Required Disclosures</strong></p>
            <p>When using Output Content in contexts where disclosure is legally required or where failure to disclose could be deceptive or misleading, you must appropriately disclose that the content was AI-generated. This may include contexts such as political advertising, synthetic media, or other uses governed by applicable disclosure laws.</p>

            <p><strong>9.4 Enforcement</strong></p>
            <p>We reserve the right to investigate suspected violations of this Acceptable Use Policy. If we determine you have violated this Policy, we may suspend or terminate your access to the Services, remove content, and/or report violations to law enforcement. We are not obligated to monitor all use of the Services but may do so to enforce this Policy.</p>

            <h4>10. Beta Services and Availability</h4>
            <p>Teseract.studio is currently in BETA. Beta features and services are experimental, provided "as is," and may contain bugs, errors, or limitations. We may change, suspend, or discontinue beta features at any time without notice. We do not guarantee any particular level of uptime or availability for beta services.</p>
            <p>Even after the Services exit beta, availability may be affected by factors including Third-Party AI Provider outages, maintenance, infrastructure issues, or force majeure events. We will use commercially reasonable efforts to provide reliable service but cannot guarantee uninterrupted access.</p>

            <p><strong>10.5 Service Level and Uptime</strong></p>
            <p>We do not guarantee any specific service level agreement (SLA), uptime percentage, or availability metrics unless separately agreed to in writing in an enterprise agreement. The Services are provided on a best-efforts basis.</p>

            <p><strong>10.6 Data Security</strong></p>
            <p>We implement commercially reasonable technical and organizational measures to protect your data. However, NO SYSTEM IS COMPLETELY SECURE. We cannot guarantee that unauthorized access, hacking, data loss, or other breaches will never occur. You are responsible for properly configuring your use of the Services and taking appropriate steps to secure your account credentials and data.</p>
            <p>You acknowledge that you transmit data to and from the Services at your own risk. We recommend that you do not include highly sensitive information (such as government-issued identification numbers, financial account credentials, or health information) in Customer Input unless necessary for your intended use and permitted under applicable law.</p>

            <h4>11. Term and Termination</h4>
            <p>These Terms remain in effect while you have an active account. Either party may terminate these Terms at any time. You may terminate by closing your account through your account settings or by contacting support@teseract.studio. We may terminate or suspend your access immediately if you violate these Terms or for any other reason at our discretion.</p>
            <p>Upon termination: (a) your right to use the Services immediately ceases; (b) you remain responsible for any outstanding fees; (c) you may download your Customer Input and Output Content within 30 days if technically feasible; and (d) we may delete your data in accordance with our retention policies. Sections 3, 4, 5, 9, 12-22 survive termination.</p>

            <h4>12. Indemnification</h4>
            <p>You agree to indemnify, defend, and hold harmless Company, its affiliates, and their respective officers, directors, employees, and agents from and against any claims, liabilities, damages, losses, costs, or expenses (including reasonable attorneys' fees) arising from or related to:</p>
            <p>(a) Your use of the Services or Output Content</p>
            <p>(b) Your Customer Input</p>
            <p>(c) Your violation of these Terms</p>
            <p>(d) Your violation of any rights of third parties</p>
            <p>(e) Any use of Output Content by you or your clients</p>

            <h4>13. Disclaimers and No Warranties</h4>
            <p><strong>THE SERVICES, INCLUDING ALL AI FEATURES, OUTPUT CONTENT, AND RELATED MATERIALS, ARE PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT ANY WARRANTIES OF ANY KIND, EXPRESS, IMPLIED, OR STATUTORY.</strong></p>
            <p>TO THE MAXIMUM EXTENT PERMITTED BY LAW, COMPANY DISCLAIMS ALL WARRANTIES, INCLUDING:</p>
            <ul>
              <li>WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, AND NON-INFRINGEMENT</li>
              <li>That the Services will be uninterrupted, timely, secure, or error-free</li>
              <li>That defects will be corrected</li>
              <li>That the Services are free from viruses or harmful components</li>
              <li>That Output Content will be accurate, reliable, complete, or suitable for your purposes</li>
            </ul>
            <p><strong>SPECIFICALLY FOR AI-GENERATED CONTENT:</strong></p>
            <ul>
              <li>NO WARRANTY OF ACCURACY: We do not warrant that Output Content is factually accurate, up-to-date, or complete</li>
              <li>NO WARRANTY OF ORIGINALITY: We do not warrant that Output Content is original or does not infringe third-party rights</li>
              <li>NO WARRANTY OF BUSINESS RESULTS: We do not warrant that Output Content will achieve any particular business outcome, satisfy your clients, or generate revenue</li>
              <li>NO WARRANTY OF CONSISTENCY: We do not warrant that similar Customer Input will produce consistent Output Content</li>
              <li>NO WARRANTY OF COMPLIANCE: We do not warrant that Output Content complies with any particular industry standards, regulations, or client requirements</li>
            </ul>
            <p>Some jurisdictions do not allow exclusion of implied warranties, so some of the above exclusions may not apply to you. You may have other rights that vary by jurisdiction.</p>

            <h4>14. Limitation of Liability</h4>
            <p><strong>TO THE MAXIMUM EXTENT PERMITTED BY LAW:</strong></p>
            <p>COMPANY WILL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, PUNITIVE, OR EXEMPLARY DAMAGES, INCLUDING DAMAGES FOR LOST PROFITS, LOST REVENUE, LOST SAVINGS, LOSS OF DATA, LOSS OF GOODWILL, OR OTHER INTANGIBLE LOSSES, EVEN IF COMPANY HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.</p>
            <p>THIS LIMITATION APPLIES TO DAMAGES ARISING FROM:</p>
            <ul>
              <li>Use or inability to use the Services</li>
              <li>Inaccuracy, errors, or defects in Output Content</li>
              <li>Unauthorized access to your account or data</li>
              <li>Third-Party AI Provider failures or service interruptions</li>
              <li>Intellectual property infringement claims related to Output Content</li>
              <li>Any claims by your clients related to deliverables that include Output Content</li>
              <li>Any other matter relating to the Services</li>
            </ul>
            <p><strong>COMPANY'S TOTAL LIABILITY TO YOU FOR ALL CLAIMS ARISING FROM OR RELATED TO THE SERVICES WILL NOT EXCEED THE GREATER OF: (A) $100, OR (B) THE AMOUNT YOU PAID TO COMPANY IN THE 12 MONTHS IMMEDIATELY PRECEDING THE EVENT GIVING RISE TO LIABILITY.</strong></p>
            <p>These limitations apply regardless of the legal theory (contract, tort, negligence, strict liability, or otherwise) and even if Company has been advised of the possibility of such damages. Some jurisdictions do not allow limitation of liability for certain types of damages, so these limitations may not fully apply to you.</p>

            <h4>15. Feedback and Suggestions</h4>
            <p>If you provide us with feedback, suggestions, or ideas about the Services ("Feedback"), you grant us an unrestricted, perpetual, irrevocable, royalty-free license to use, modify, and incorporate such Feedback into our Services without compensation or attribution to you.</p>

            <h4>16. Export Control and Sanctions</h4>
            <p>You agree to comply with all applicable export control laws and regulations. You represent that you are not located in, under the control of, or a national or resident of any country subject to U.S. embargo or sanctions, and that you are not on any U.S. government list of prohibited or restricted parties.</p>

            <h4>17. Modifications to the Services</h4>
            <p>We reserve the right to modify, suspend, or discontinue any aspect of the Services at any time, including features, functionality, or availability of specific AI models or capabilities. We will use commercially reasonable efforts to notify you of material changes but are not obligated to do so.</p>

            <h4>18. Third-Party Services and Content</h4>
            <p>The Services may integrate with or contain links to third-party services, websites, or content. We do not endorse, control, or assume responsibility for any third-party services or content. Your use of third-party services is governed by their own terms and privacy policies.</p>

            <h4>19. Confidentiality</h4>
            <p>Each party agrees to maintain the confidentiality of the other party's confidential information and use it only as necessary to perform under these Terms. This obligation survives termination for 5 years, except that obligations with respect to information constituting trade secrets will continue indefinitely or until such information no longer qualifies as a trade secret under applicable law.</p>

            <h4>20. Dispute Resolution and Arbitration</h4>
            <p><strong>PLEASE READ THIS SECTION CAREFULLY. IT AFFECTS YOUR LEGAL RIGHTS, INCLUDING YOUR RIGHT TO FILE A LAWSUIT IN COURT.</strong></p>

            <p><strong>20.1 Informal Resolution</strong></p>
            <p>Before filing any formal dispute, you agree to first contact us at legal@teseract.studio to attempt to resolve the matter informally. We will attempt to resolve disputes through good-faith negotiation for at least 30 days.</p>

            <p><strong>20.2 Binding Arbitration</strong></p>
            <p>If informal resolution fails, any dispute arising from these Terms or the Services will be resolved through binding arbitration administered by the American Arbitration Association ("AAA") under its Commercial Arbitration Rules. The arbitration will be conducted by a single arbitrator in the English language. Judgment on the arbitration award may be entered in any court having jurisdiction.</p>
            <p><strong>YOU AND COMPANY AGREE THAT ARBITRATION WILL BE CONDUCTED ON AN INDIVIDUAL BASIS ONLY. CLASS ARBITRATIONS, CLASS ACTIONS, AND REPRESENTATIVE OR CONSOLIDATED ACTIONS ARE NOT PERMITTED. YOU AND COMPANY EACH WAIVE THE RIGHT TO A JURY TRIAL.</strong></p>

            <p><strong>20.3 Exceptions</strong></p>
            <p>Either party may bring an action in court for: (a) intellectual property infringement claims, or (b) claims that may be brought in small claims court.</p>

            <p><strong>20.4 Opt-Out Right</strong></p>
            <p>You may opt out of this arbitration agreement by sending written notice to legal@teseract.studio within 30 days of first accepting these Terms. Your notice must include your name, email address, and a clear statement that you wish to opt out of the arbitration agreement.</p>

            <h4>21. Governing Law and Venue</h4>
            <p>These Terms are governed by the laws of the applicable State without regard to conflict of law principles. Any disputes not subject to arbitration will be brought exclusively in the state or federal courts located in the applicable jurisdiction, and you consent to the personal jurisdiction of such courts.</p>

            <h4>22. General Provisions</h4>
            <p><strong>Entire Agreement.</strong> These Terms, together with our Privacy Policy, constitute the entire agreement between you and Company regarding the Services.</p>
            <p><strong>Assignment.</strong> You may not assign these Terms without our prior written consent. We may assign these Terms without restriction.</p>
            <p><strong>Severability.</strong> If any provision of these Terms is found invalid or unenforceable, that provision will be limited or eliminated to the minimum extent necessary, and the remaining provisions will remain in full force.</p>
            <p><strong>Waiver.</strong> No waiver of any term of these Terms will be deemed a further or continuing waiver of such term or any other term.</p>
            <p><strong>Force Majeure.</strong> We are not liable for any failure or delay in performance due to circumstances beyond our reasonable control.</p>
            <p><strong>Contact.</strong> For questions about these Terms, contact us at legal@teseract.studio.</p>
            <p>© 2026 Matte Black AI Inc. All rights reserved.</p>
          </div>
        </div>
      </div>
    </>
  );
}

function ClearcheckPolicySection() {
  return (
    <>
      <h2 className="settings-section-title">Clearcheck Policy</h2>
      <div className="settings-card">
        <div className="settings-field">
          <p className="settings-policy-text">
            Last updated: March 2026. The Clearcheck service provides copyright and content analysis. Results are limited in accuracy and do not indemnify any art created on the platform.
          </p>
        </div>
        <div className="settings-field">
          <label className="settings-label">Full document</label>
          <div className="settings-policy-placeholder">
            <span className="settings-empty">Clearcheck Policy content will be displayed here.</span>
          </div>
        </div>
      </div>
    </>
  );
}

/* ─── Credit Config Section (Superadmin) ─── */

type RateLimitEntry = {
  id: string;
  generation_type: string;
  max_requests: number;
  window_seconds: number;
  updated_at: string;
};

type LedgerEntry = {
  id: string;
  user_id: string;
  user_email: string;
  user_name: string;
  amount: number;
  balance_after: number;
  reason: string;
  reference_id: string | null;
  created_at: string;
};

type ModelPricingEntry = {
  id: string;
  model_key: string;
  base_cost: number;
  resolution_multipliers: Record<string, number> | null;
  duration_multipliers: Record<string, number> | null;
  feature_surcharges: Record<string, number> | null;
  input_token_net_cost_per_million: number | string | null;
  output_token_net_cost_per_million: number | string | null;
  is_active: boolean;
  updated_at: string;
};

function CreditConfigSection() {
  const [activeTab, setActiveTab] = useState<"model-pricing" | "rate-limits" | "grant" | "ledger" | "settings">("model-pricing");
  const [rateLimits, setRateLimits] = useState<RateLimitEntry[]>([]);
  const [modelPricing, setModelPricing] = useState<ModelPricingEntry[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [ledgerTotal, setLedgerTotal] = useState(0);
  const [ledgerPage, setLedgerPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [grantUserId, setGrantUserId] = useState("");
  const [grantAmount, setGrantAmount] = useState("");
  const [grantReason, setGrantReason] = useState("");
  const [grantMsg, setGrantMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [userSearch, setUserSearch] = useState("");
  const [userResults, setUserResults] = useState<{ id: string; email: string; display_name: string }[]>([]);
  const [thresholds, setThresholds] = useState("50, 20, 10");
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [editingModel, setEditingModel] = useState<string | null>(null);
  const [editFields, setEditFields] = useState<{
    resolution_multipliers: string;
    duration_multipliers: string;
    feature_surcharges: string;
  }>({ resolution_multipliers: "", duration_multipliers: "", feature_surcharges: "" });

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const [rlRes, mpRes] = await Promise.all([
        fetch("/api/admin/credits/rate-limits", { credentials: "include" }),
        fetch("/api/admin/credits/model-pricing", { credentials: "include" }),
      ]);
      if (rlRes.ok) {
        const data = await rlRes.json();
        setRateLimits(data.rateLimits);
      }
      if (mpRes.ok) {
        const data = await mpRes.json();
        setModelPricing(data.modelPricing);
      }
    } catch {}
    setLoading(false);
  }, []);

  const fetchLedger = useCallback(async (page: number) => {
    try {
      const res = await fetch(`/api/admin/credits/ledger?limit=25&offset=${page * 25}`, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setLedger(data.ledger);
        setLedgerTotal(data.total);
      }
    } catch {}
  }, []);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/credits/settings", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        if (data.settings.low_balance_thresholds) {
          setThresholds(data.settings.low_balance_thresholds.replace(/[\[\]]/g, ""));
        }
      }
    } catch {}
  }, []);

  useEffect(() => {
    fetchConfig();
    fetchSettings();
  }, [fetchConfig, fetchSettings]);

  useEffect(() => {
    if (activeTab === "ledger") fetchLedger(ledgerPage);
  }, [activeTab, ledgerPage, fetchLedger]);

  const updateRateLimit = async (id: string, field: string, value: number) => {
    setSaving(id);
    try {
      const res = await fetch(`/api/admin/credits/rate-limits/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ [field]: value }),
      });
      if (res.ok) {
        const data = await res.json();
        setRateLimits((prev) => prev.map((r) => (r.id === id ? data.rateLimit : r)));
      }
    } catch {}
    setSaving(null);
  };

  const searchUsers = async (q: string) => {
    setUserSearch(q);
    if (q.length < 2) { setUserResults([]); return; }
    try {
      const res = await fetch(`/api/admin/credits/users?search=${encodeURIComponent(q)}`, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setUserResults(data.users);
      }
    } catch {}
  };

  const handleGrant = async () => {
    setGrantMsg(null);
    if (!grantUserId || !grantAmount) {
      setGrantMsg({ type: "error", text: "Select a user and enter an amount" });
      return;
    }
    try {
      const res = await fetch("/api/admin/credits/grant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ user_id: grantUserId, amount: parseInt(grantAmount), reason: grantReason }),
      });
      if (res.ok) {
        const data = await res.json();
        setGrantMsg({ type: "success", text: `Granted ${data.granted} credits. New balance: ${data.new_balance}` });
        setGrantAmount("");
        setGrantReason("");
      } else {
        const err = await res.json();
        setGrantMsg({ type: "error", text: err.error || "Failed to grant credits" });
      }
    } catch {
      setGrantMsg({ type: "error", text: "Failed to grant credits" });
    }
  };

  const saveThresholds = async () => {
    try {
      const arr = thresholds.split(",").map((s) => parseInt(s.trim())).filter((n) => !isNaN(n));
      const res = await fetch("/api/admin/credits/settings/low_balance_thresholds", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ value: JSON.stringify(arr) }),
      });
      if (res.ok) {
        setSettingsSaved(true);
        setTimeout(() => setSettingsSaved(false), 2000);
      }
    } catch {}
  };

  const typeLabel = (t: string) => t.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  if (loading) return <p style={{ color: "#888", padding: "20px" }}>Loading...</p>;

  return (
    <>
      <h2 className="settings-section-title">Credit Configuration</h2>

      <div style={{ display: "flex", gap: "4px", marginBottom: "16px", flexWrap: "wrap" }}>
        {(["model-pricing", "rate-limits", "grant", "ledger", "settings"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            style={{
              padding: "6px 14px",
              borderRadius: "6px",
              border: "1px solid",
              borderColor: activeTab === tab ? "#fff" : "#333",
              background: activeTab === tab ? "#fff" : "transparent",
              color: activeTab === tab ? "#000" : "#aaa",
              fontSize: "13px",
              cursor: "pointer",
              textTransform: "capitalize",
            }}
          >
            {tab === "rate-limits" ? "Rate Limits" : tab === "model-pricing" ? "Model Pricing" : tab === "grant" ? "Grant" : tab === "ledger" ? "Ledger" : "Settings"}
          </button>
        ))}
      </div>

      {activeTab === "model-pricing" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <p style={{ color: "#888", fontSize: "12px", margin: "0 0 8px 0" }}>
            Each model has its own base cost, resolution multipliers, duration multipliers, and feature surcharges.
          </p>
          <p style={{ color: "#888", fontSize: "12px", margin: "0 0 8px 0", padding: "8px 10px", background: "#111", border: "1px solid #222", borderRadius: "6px" }}>
            Token rates (input / output, in USD per 1M tokens) are entered as
            net Anthropic cost. The platform adds a 25% margin automatically
            at billing time. Leave at 0 to keep the model on character-based
            pricing.
          </p>
          {modelPricing.map((mp) => (
            <div key={mp.id} style={{ padding: "12px", background: "#111", borderRadius: "8px", border: "1px solid #222" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: editingModel === mp.id ? "10px" : 0 }}>
                <span style={{ flex: 1, color: "#ddd", fontSize: "13px", fontFamily: "Geist Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace" }}>{mp.model_key}</span>
                <span style={{ color: "#888", fontSize: "11px" }}>Base:</span>
                <NumericInput
                  min="0"
                  defaultValue={mp.base_cost}
                  onBlur={(e) => {
                    const val = parseInt(e.target.value);
                    if (!isNaN(val) && val !== mp.base_cost) {
                      setSaving(mp.id);
                      fetch(`/api/admin/credits/model-pricing/${mp.id}`, {
                        method: "PUT",
                        headers: { "Content-Type": "application/json" },
                        credentials: "include",
                        body: JSON.stringify({ base_cost: val }),
                      }).then(async (res) => {
                        if (res.ok) {
                          const data = await res.json();
                          setModelPricing((prev) => prev.map((m) => (m.id === mp.id ? data.modelPricing : m)));
                        }
                        setSaving(null);
                      }).catch(() => setSaving(null));
                    }
                  }}
                  style={{ width: "60px", padding: "4px 8px", background: "#1a1a1a", border: "1px solid #333", borderRadius: "4px", color: "#fff", fontSize: "13px", textAlign: "right" }}
                />
                <span style={{ color: "#666", fontSize: "12px", width: "45px" }}>credits</span>
                <button
                  type="button"
                  onClick={() => {
                    setSaving(mp.id);
                    fetch(`/api/admin/credits/model-pricing/${mp.id}`, {
                      method: "PUT",
                      headers: { "Content-Type": "application/json" },
                      credentials: "include",
                      body: JSON.stringify({ is_active: !mp.is_active }),
                    }).then(async (res) => {
                      if (res.ok) {
                        const data = await res.json();
                        setModelPricing((prev) => prev.map((m) => (m.id === mp.id ? data.modelPricing : m)));
                      }
                      setSaving(null);
                    }).catch(() => setSaving(null));
                  }}
                  disabled={saving === mp.id}
                  style={{
                    padding: "4px 10px",
                    borderRadius: "4px",
                    border: "none",
                    background: mp.is_active ? "#1a3a1a" : "#3a1a1a",
                    color: mp.is_active ? "#4ade80" : "#f87171",
                    fontSize: "11px",
                    cursor: "pointer",
                  }}
                >
                  {mp.is_active ? "Active" : "Inactive"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (editingModel === mp.id) {
                      setEditingModel(null);
                    } else {
                      setEditingModel(mp.id);
                      setEditFields({
                        resolution_multipliers: mp.resolution_multipliers ? JSON.stringify(mp.resolution_multipliers) : "",
                        duration_multipliers: mp.duration_multipliers ? JSON.stringify(mp.duration_multipliers) : "",
                        feature_surcharges: mp.feature_surcharges ? JSON.stringify(mp.feature_surcharges) : "",
                      });
                    }
                  }}
                  style={{ padding: "4px 10px", borderRadius: "4px", border: "1px solid #333", background: "transparent", color: "#aaa", fontSize: "11px", cursor: "pointer" }}
                >
                  {editingModel === mp.id ? "Close" : "Edit"}
                </button>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "12px", marginTop: "8px", paddingTop: "8px", borderTop: "1px solid #1f1f1f" }}>
                <span style={{ color: "#888", fontSize: "11px", width: "120px" }}>Tokens (USD / 1M):</span>
                <span style={{ color: "#666", fontSize: "11px" }}>in</span>
                <NumericInput
                  min="0"
                  step="0.01"
                  defaultValue={Number(mp.input_token_net_cost_per_million ?? 0)}
                  onBlur={(e) => {
                    const val = Number(e.target.value);
                    const current = Number(mp.input_token_net_cost_per_million ?? 0);
                    if (!Number.isNaN(val) && val !== current) {
                      setSaving(mp.id);
                      fetch(`/api/admin/credits/model-pricing/${mp.id}`, {
                        method: "PUT",
                        headers: { "Content-Type": "application/json" },
                        credentials: "include",
                        body: JSON.stringify({ input_token_net_cost_per_million: val }),
                      }).then(async (res) => {
                        if (res.ok) {
                          const data = await res.json();
                          setModelPricing((prev) => prev.map((m) => (m.id === mp.id ? data.modelPricing : m)));
                        }
                        setSaving(null);
                      }).catch(() => setSaving(null));
                    }
                  }}
                  style={{ width: "70px", padding: "4px 8px", background: "#1a1a1a", border: "1px solid #333", borderRadius: "4px", color: "#fff", fontSize: "13px", textAlign: "right" }}
                />
                <span style={{ color: "#666", fontSize: "11px" }}>out</span>
                <NumericInput
                  min="0"
                  step="0.01"
                  defaultValue={Number(mp.output_token_net_cost_per_million ?? 0)}
                  onBlur={(e) => {
                    const val = Number(e.target.value);
                    const current = Number(mp.output_token_net_cost_per_million ?? 0);
                    if (!Number.isNaN(val) && val !== current) {
                      setSaving(mp.id);
                      fetch(`/api/admin/credits/model-pricing/${mp.id}`, {
                        method: "PUT",
                        headers: { "Content-Type": "application/json" },
                        credentials: "include",
                        body: JSON.stringify({ output_token_net_cost_per_million: val }),
                      }).then(async (res) => {
                        if (res.ok) {
                          const data = await res.json();
                          setModelPricing((prev) => prev.map((m) => (m.id === mp.id ? data.modelPricing : m)));
                        }
                        setSaving(null);
                      }).catch(() => setSaving(null));
                    }
                  }}
                  style={{ width: "70px", padding: "4px 8px", background: "#1a1a1a", border: "1px solid #333", borderRadius: "4px", color: "#fff", fontSize: "13px", textAlign: "right" }}
                />
                <span style={{ color: "#555", fontSize: "11px" }}>net (×1.25 margin applied)</span>
              </div>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginTop: editingModel === mp.id ? 0 : "6px" }}>
                {mp.resolution_multipliers && (
                  <span style={{ fontSize: "11px", color: "#666", background: "#1a1a1a", padding: "2px 6px", borderRadius: "3px" }}>
                    Res: {Object.entries(mp.resolution_multipliers).map(([k, v]) => `${k}=${v}x`).join(", ")}
                  </span>
                )}
                {mp.duration_multipliers && (
                  <span style={{ fontSize: "11px", color: "#666", background: "#1a1a1a", padding: "2px 6px", borderRadius: "3px" }}>
                    Dur: {Object.entries(mp.duration_multipliers).map(([k, v]) => `${k}=${v}x`).join(", ")}
                  </span>
                )}
                {mp.feature_surcharges && (
                  <span style={{ fontSize: "11px", color: "#666", background: "#1a1a1a", padding: "2px 6px", borderRadius: "3px" }}>
                    Feat: {Object.entries(mp.feature_surcharges).map(([k, v]) => `${k}=+${v}`).join(", ")}
                  </span>
                )}
              </div>
              {editingModel === mp.id && (
                <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "10px", paddingTop: "10px", borderTop: "1px solid #222" }}>
                  <div>
                    <label style={{ color: "#888", fontSize: "11px", display: "block", marginBottom: "4px" }}>Resolution Multipliers (JSON)</label>
                    <input
                      type="text"
                      value={editFields.resolution_multipliers}
                      onChange={(e) => setEditFields((f) => ({ ...f, resolution_multipliers: e.target.value }))}
                      placeholder='{"0.5k": 0.75, "1k": 1.0, "2k": 1.5, "4k": 2.0}'
                      style={{ width: "100%", padding: "6px 8px", background: "#1a1a1a", border: "1px solid #333", borderRadius: "4px", color: "#fff", fontSize: "12px", fontFamily: "Geist Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace" }}
                    />
                  </div>
                  <div>
                    <label style={{ color: "#888", fontSize: "11px", display: "block", marginBottom: "4px" }}>Duration Multipliers (JSON)</label>
                    <input
                      type="text"
                      value={editFields.duration_multipliers}
                      onChange={(e) => setEditFields((f) => ({ ...f, duration_multipliers: e.target.value }))}
                      placeholder='{"5": 1.0, "10": 2.0} or {"per_second": 0.5} or {"per_minute": 1}'
                      style={{ width: "100%", padding: "6px 8px", background: "#1a1a1a", border: "1px solid #333", borderRadius: "4px", color: "#fff", fontSize: "12px", fontFamily: "Geist Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace" }}
                    />
                  </div>
                  <div>
                    <label style={{ color: "#888", fontSize: "11px", display: "block", marginBottom: "4px" }}>Feature Surcharges (JSON)</label>
                    <input
                      type="text"
                      value={editFields.feature_surcharges}
                      onChange={(e) => setEditFields((f) => ({ ...f, feature_surcharges: e.target.value }))}
                      placeholder='{"web_search": 2, "high_thinking": 1}'
                      style={{ width: "100%", padding: "6px 8px", background: "#1a1a1a", border: "1px solid #333", borderRadius: "4px", color: "#fff", fontSize: "12px", fontFamily: "Geist Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace" }}
                    />
                  </div>
                  <button
                    type="button"
                    disabled={saving === mp.id}
                    onClick={() => {
                      let resM = null, durM = null, featS = null;
                      const errors: string[] = [];
                      try { if (editFields.resolution_multipliers.trim()) resM = JSON.parse(editFields.resolution_multipliers); } catch { errors.push("Resolution multipliers"); }
                      try { if (editFields.duration_multipliers.trim()) durM = JSON.parse(editFields.duration_multipliers); } catch { errors.push("Duration multipliers"); }
                      try { if (editFields.feature_surcharges.trim()) featS = JSON.parse(editFields.feature_surcharges); } catch { errors.push("Feature surcharges"); }
                      if (errors.length > 0) {
                        alert(`Invalid JSON in: ${errors.join(", ")}. Please fix before saving.`);
                        return;
                      }
                      setSaving(mp.id);
                      fetch(`/api/admin/credits/model-pricing/${mp.id}`, {
                        method: "PUT",
                        headers: { "Content-Type": "application/json" },
                        credentials: "include",
                        body: JSON.stringify({
                          resolution_multipliers: resM,
                          duration_multipliers: durM,
                          feature_surcharges: featS,
                        }),
                      }).then(async (res) => {
                        if (res.ok) {
                          const data = await res.json();
                          setModelPricing((prev) => prev.map((m) => (m.id === mp.id ? data.modelPricing : m)));
                          setEditingModel(null);
                        }
                        setSaving(null);
                      }).catch(() => setSaving(null));
                    }}
                    style={{ padding: "8px 16px", background: "#fff", color: "#000", border: "none", borderRadius: "6px", fontWeight: 600, cursor: "pointer", fontSize: "12px", width: "fit-content" }}
                  >
                    Save Multipliers
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {activeTab === "rate-limits" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {rateLimits.map((r) => (
            <div key={r.id} style={{ display: "flex", alignItems: "center", gap: "12px", padding: "10px 12px", background: "#111", borderRadius: "8px", border: "1px solid #222" }}>
              <span style={{ flex: 1, color: "#ddd", fontSize: "13px" }}>{typeLabel(r.generation_type)}</span>
              <NumericInput
                min="1"
                defaultValue={r.max_requests}
                onBlur={(e) => {
                  const val = parseInt(e.target.value);
                  if (!isNaN(val) && val !== r.max_requests) updateRateLimit(r.id, "max_requests", val);
                }}
                style={{ width: "60px", padding: "4px 8px", background: "#1a1a1a", border: "1px solid #333", borderRadius: "4px", color: "#fff", fontSize: "13px", textAlign: "right" }}
              />
              <span style={{ color: "#666", fontSize: "12px" }}>req /</span>
              <NumericInput
                min="1"
                defaultValue={r.window_seconds}
                onBlur={(e) => {
                  const val = parseInt(e.target.value);
                  if (!isNaN(val) && val !== r.window_seconds) updateRateLimit(r.id, "window_seconds", val);
                }}
                style={{ width: "60px", padding: "4px 8px", background: "#1a1a1a", border: "1px solid #333", borderRadius: "4px", color: "#fff", fontSize: "13px", textAlign: "right" }}
              />
              <span style={{ color: "#666", fontSize: "12px" }}>sec</span>
            </div>
          ))}
        </div>
      )}

      {activeTab === "grant" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px", maxWidth: "400px" }}>
          <div className="settings-field">
            <label className="settings-label">Search User</label>
            <input
              type="text"
              className="settings-input"
              placeholder="Search by email or name..."
              value={userSearch}
              onChange={(e) => searchUsers(e.target.value)}
            />
            {userResults.length > 0 && (
              <div style={{ marginTop: "4px", background: "#111", border: "1px solid #333", borderRadius: "6px", maxHeight: "150px", overflow: "auto" }}>
                {userResults.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => {
                      setGrantUserId(u.id);
                      setUserSearch(u.email);
                      setUserResults([]);
                    }}
                    style={{ display: "block", width: "100%", padding: "8px 12px", background: grantUserId === u.id ? "#1a1a2e" : "transparent", border: "none", color: "#ddd", fontSize: "13px", cursor: "pointer", textAlign: "left" }}
                  >
                    {u.display_name || u.email} <span style={{ color: "#666" }}>({u.email})</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="settings-field">
            <label className="settings-label">Amount</label>
            <NumericInput
              className="settings-input"
              placeholder="Credits to grant"
              min="1"
              value={grantAmount}
              onChange={(e) => setGrantAmount(e.target.value)}
            />
          </div>
          <div className="settings-field">
            <label className="settings-label">Reason (optional)</label>
            <input
              type="text"
              className="settings-input"
              placeholder="e.g. promotional bonus"
              value={grantReason}
              onChange={(e) => setGrantReason(e.target.value)}
            />
          </div>
          <button
            type="button"
            onClick={handleGrant}
            style={{ padding: "10px 20px", background: "#fff", color: "#000", border: "none", borderRadius: "6px", fontWeight: 600, cursor: "pointer", fontSize: "13px" }}
          >
            Grant Credits
          </button>
          {grantMsg && (
            <p style={{ color: grantMsg.type === "success" ? "#4ade80" : "#f87171", fontSize: "13px" }}>
              {grantMsg.text}
            </p>
          )}
        </div>
      )}

      {activeTab === "ledger" && (
        <div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #333" }}>
                  <th style={{ padding: "8px", color: "#888", textAlign: "left", fontWeight: 500 }}>User</th>
                  <th style={{ padding: "8px", color: "#888", textAlign: "right", fontWeight: 500 }}>Amount</th>
                  <th style={{ padding: "8px", color: "#888", textAlign: "right", fontWeight: 500 }}>Balance</th>
                  <th style={{ padding: "8px", color: "#888", textAlign: "left", fontWeight: 500 }}>Reason</th>
                  <th style={{ padding: "8px", color: "#888", textAlign: "left", fontWeight: 500 }}>Date</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((l) => (
                  <tr key={l.id} style={{ borderBottom: "1px solid #1a1a1a" }}>
                    <td style={{ padding: "8px", color: "#ddd" }}>{l.user_email || l.user_id.slice(0, 8)}</td>
                    <td style={{ padding: "8px", textAlign: "right", color: l.amount > 0 ? "#4ade80" : "#f87171", fontFamily: "Geist Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace" }}>
                      {l.amount > 0 ? "+" : ""}{l.amount}
                    </td>
                    <td style={{ padding: "8px", textAlign: "right", color: "#aaa", fontFamily: "Geist Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace" }}>{l.balance_after}</td>
                    <td style={{ padding: "8px", color: "#888" }}>{l.reason}</td>
                    <td style={{ padding: "8px", color: "#666" }}>{new Date(l.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: "flex", gap: "8px", justifyContent: "center", marginTop: "12px" }}>
            <button
              type="button"
              disabled={ledgerPage === 0}
              onClick={() => setLedgerPage((p) => p - 1)}
              style={{ padding: "6px 14px", background: "#222", color: "#aaa", border: "1px solid #333", borderRadius: "4px", cursor: "pointer", fontSize: "12px" }}
            >
              Prev
            </button>
            <span style={{ color: "#666", fontSize: "12px", padding: "6px 0" }}>
              {ledgerPage * 25 + 1}-{Math.min((ledgerPage + 1) * 25, ledgerTotal)} of {ledgerTotal}
            </span>
            <button
              type="button"
              disabled={(ledgerPage + 1) * 25 >= ledgerTotal}
              onClick={() => setLedgerPage((p) => p + 1)}
              style={{ padding: "6px 14px", background: "#222", color: "#aaa", border: "1px solid #333", borderRadius: "4px", cursor: "pointer", fontSize: "12px" }}
            >
              Next
            </button>
          </div>
        </div>
      )}

      {activeTab === "settings" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px", maxWidth: "400px" }}>
          <div className="settings-field">
            <label className="settings-label">Low Balance Alert Thresholds</label>
            <input
              type="text"
              className="settings-input"
              placeholder="e.g. 50, 20, 10"
              value={thresholds}
              onChange={(e) => setThresholds(e.target.value)}
            />
            <span style={{ color: "#666", fontSize: "12px" }}>Comma-separated credit amounts that trigger alerts</span>
          </div>
          <button
            type="button"
            onClick={saveThresholds}
            style={{ padding: "10px 20px", background: "#fff", color: "#000", border: "none", borderRadius: "6px", fontWeight: 600, cursor: "pointer", fontSize: "13px", width: "fit-content" }}
          >
            {settingsSaved ? "Saved!" : "Save Settings"}
          </button>
        </div>
      )}
    </>
  );
}

/* ─── Shared Toggle Row ─── */

function ToggleRow({ label, description, defaultOn = false }: { label: string; description: string; defaultOn?: boolean }) {
  const [on, setOn] = useState(defaultOn);
  return (
    <div className="settings-toggle-row">
      <div className="settings-toggle-info">
        <span className="settings-toggle-label">{label}</span>
        <span className="settings-toggle-desc">{description}</span>
      </div>
      <button
        type="button"
        className={`rpanel-toggle ${on ? "rpanel-toggle--on" : ""}`}
        onClick={() => setOn((v) => !v)}
        aria-pressed={on}
      >
        <span className="rpanel-toggle-knob" />
      </button>
    </div>
  );
}
