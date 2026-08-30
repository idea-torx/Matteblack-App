import { useState } from "react";
import { useWorkspace } from "../contexts/WorkspaceContext";
import "./ProjectsPage.css";

export type ProjectCategory = "make" | "nodes" | "audio" | "cinema";

export type Project = {
  id: string;
  name: string;
  date?: string;
  items?: number;
  gradient?: string;
  node_count?: number;
  updated_at?: string;
  created_at?: string;
  thumbnail_url?: string;
  thumbnails?: string[];
  viewer_role?: "owner" | "viewer";
  owner_display_name?: string;
  owner_email?: string;
};

export type ProjectsTab = "mine" | "shared";

type SortKey = "recent" | "name" | "owner";

const SORT_LABELS: Record<SortKey, string> = {
  recent: "Recently updated",
  name: "Name",
  owner: "Workspace",
};

/** "Workspace" order = your own workspace's projects first, then each person
 *  who shared with you, grouped. `projects` only ever holds the active
 *  workspace, so owner is the only workspace-ish key a row actually carries. */
function compareProjects(a: Project, b: Project, key: SortKey): number {
  if (key === "name") return a.name.localeCompare(b.name);
  if (key === "owner") {
    const owner = (p: Project) =>
      p.viewer_role === "viewer" ? (p.owner_display_name || p.owner_email || "~") : "";
    const d = owner(a).localeCompare(owner(b));
    if (d) return d;
    return a.name.localeCompare(b.name);
  }
  return (b.updated_at || b.created_at || "").localeCompare(a.updated_at || a.created_at || "");
}

const CATEGORY_LABELS: Record<ProjectCategory, string> = {
  make: "Make Projects",
  nodes: "Node Workflows",
  audio: "Audio Projects",
  cinema: "Cinema Projects",
};

type Props = {
  category: ProjectCategory;
  projects: Project[];
  currentProject: string;
  onSelect: (id: string) => void;
  onCreate: (name: string) => void;
  onDelete: (id: string) => void;
  onRename?: (id: string, name: string) => void;
  sharingEnabled?: boolean;
  sharedProjects?: Project[];
  activeTab?: ProjectsTab;
  onTabChange?: (tab: ProjectsTab) => void;
  onInviteTeammates?: () => void;
};

function SettingsPanel({ project, onClose, onDelete, onRename }: {
  project: Project;
  onClose: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
}) {
  const [name, setName] = useState(project.name);

  return (
    <div className="proj-settings-overlay">
      <div className="proj-settings-backdrop" onClick={onClose} />
      <div className="proj-settings-panel">
        <div className="proj-settings-header">
          <span className="proj-settings-title">Project Settings</span>
          <button type="button" className="proj-settings-close" onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="proj-settings-body">
          <div className="proj-settings-section">
            <span className="proj-settings-label">Name</span>
            <input
              type="text"
              className="proj-settings-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => { if (name.trim() && name !== project.name) onRename(project.id, name.trim()); }}
              onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
            />
          </div>

          <div className="proj-settings-section">
            <span className="proj-settings-label">Details</span>
            <div className="proj-settings-row">
              <span>Created</span>
              <span className="proj-settings-value">{project.date}</span>
            </div>
            <div className="proj-settings-row">
              <span>Items</span>
              <span className="proj-settings-value">{project.items}</span>
            </div>
            <div className="proj-settings-row">
              <span>ID</span>
              <span className="proj-settings-value">{project.id}</span>
            </div>
          </div>

          <div className="proj-settings-section">
            <span className="proj-settings-label">Files</span>
            <button type="button" className="proj-settings-btn">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Download All Files
            </button>
            <button type="button" className="proj-settings-btn">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              Duplicate Project
            </button>
            <button type="button" className="proj-settings-btn">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
                <polyline points="16 6 12 2 8 6" />
                <line x1="12" y1="2" x2="12" y2="15" />
              </svg>
              Export as ZIP
            </button>
          </div>
        </div>

        <div className="proj-settings-footer">
          <button type="button" className="proj-settings-delete" onClick={() => { onDelete(project.id); onClose(); }}>
            Delete Project
          </button>
        </div>
      </div>
    </div>
  );
}

export function ProjectsPage({ category, projects, currentProject, onSelect, onCreate, onDelete, onRename, sharingEnabled, sharedProjects, activeTab, onTabChange, onInviteTeammates }: Props) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [settingsProject, setSettingsProject] = useState<Project | null>(null);
  const [wsMenuOpen, setWsMenuOpen] = useState(false);
  // Sticky because the list is the first thing you look at every session and
  // re-picking the order every time is the annoying part.
  const [sortBy, setSortBy] = useState<SortKey>(() => {
    const v = localStorage.getItem("projectsSort");
    return v === "name" || v === "owner" ? v : "recent";
  });
  const { workspaces, activeWorkspace, setActiveWorkspace } = useWorkspace();

  const defaultName = category === "audio" ? "Untitled Audio Project" : category === "cinema" ? "Untitled Cinema Project" : "Untitled Project";

  const handleCreate = () => {
    onCreate(newName.trim() || defaultName);
    setNewName("");
    setCreating(false);
  };

  void activeTab;
  void onTabChange;
  // Merge shared projects into the same list so visited shares are reachable
  // alongside the user's own projects. They're tagged with a "Shared" badge.
  const sharedList = sharingEnabled ? (sharedProjects || []) : [];
  const ownedIds = new Set(projects.map((p) => p.id));
  const dedupedShared = sharedList.filter((p) => !ownedIds.has(p.id));
  const visibleProjects: Project[] = [...projects, ...dedupedShared].sort((a, b) => compareProjects(a, b, sortBy));
  const isTeamWorkspace = activeWorkspace?.type === "org";

  return (
    <div className="proj-page">
      <div className="proj-page-content">
        <div className="proj-page-header">
          <h1 className="proj-page-title">{CATEGORY_LABELS[category]}</h1>
          <div className="proj-ws-controls">
            <div className="proj-ws-switcher">
              <button
                type="button"
                className="proj-ws-trigger"
                onClick={() => setWsMenuOpen((v) => !v)}
                aria-haspopup="listbox"
                aria-expanded={wsMenuOpen}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  {isTeamWorkspace ? (
                    <>
                      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                      <circle cx="9" cy="7" r="4" />
                      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                    </>
                  ) : (
                    <>
                      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                      <circle cx="12" cy="7" r="4" />
                    </>
                  )}
                </svg>
                <span className="proj-ws-name">{activeWorkspace?.name ?? "Workspace"}</span>
                {isTeamWorkspace && <span className="proj-ws-badge">Team</span>}
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
              </button>
              {wsMenuOpen && (
                <>
                  <div className="proj-ws-backdrop" onClick={() => setWsMenuOpen(false)} />
                  <div className="proj-ws-menu" role="listbox">
                    {workspaces.map((ws) => {
                      const isOrg = ws.type === "org";
                      const isActive = ws.id === activeWorkspace?.id;
                      return (
                        <button
                          key={ws.id}
                          type="button"
                          role="option"
                          aria-selected={isActive}
                          className={`proj-ws-menu-item ${isActive ? "proj-ws-menu-item--active" : ""}`}
                          onClick={() => { setActiveWorkspace(ws); setWsMenuOpen(false); }}
                        >
                          <span className="proj-ws-menu-avatar">{ws.name[0]?.toUpperCase() ?? "?"}</span>
                          <span className="proj-ws-menu-name">{ws.name}</span>
                          {isOrg && <span className="proj-ws-badge proj-ws-badge--small">Team</span>}
                          {isActive && (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
            <select
              className="proj-sort"
              value={sortBy}
              onChange={(e) => { const v = e.target.value as SortKey; setSortBy(v); localStorage.setItem("projectsSort", v); }}
              aria-label="Sort projects"
            >
              {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
                <option key={k} value={k}>{`Sort: ${SORT_LABELS[k]}`}</option>
              ))}
            </select>
            {isTeamWorkspace && onInviteTeammates && (
              <button type="button" className="proj-invite-btn" onClick={onInviteTeammates}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="8.5" cy="7" r="4" />
                  <line x1="20" y1="8" x2="20" y2="14" />
                  <line x1="23" y1="11" x2="17" y2="11" />
                </svg>
                Invite teammates
              </button>
            )}
          </div>
        </div>
        <div className="proj-page-grid">
          {/* New project card */}
          {(
          <button
            type="button"
            className="proj-card proj-card--new"
            onClick={() => setCreating(true)}
          >
            {creating ? (
              <div className="proj-card-create" onClick={(e) => e.stopPropagation()}>
                <input
                  type="text"
                  className="proj-card-input"
                  placeholder={defaultName}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); if (e.key === "Escape") { setCreating(false); setNewName(""); } }}
                  autoFocus
                />
                <div className="proj-card-create-actions">
                  <button type="button" className="proj-card-create-btn" onClick={handleCreate}>Create</button>
                  <button type="button" className="proj-card-create-cancel" onClick={() => { setCreating(false); setNewName(""); }}>Cancel</button>
                </div>
              </div>
            ) : (
              <>
                <div className="proj-card-new-icon">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </div>
                <span className="proj-card-new-label">New Project</span>
              </>
            )}
          </button>
          )}

          {/* Existing project cards */}
          {visibleProjects.map((project) => {
            const isActive = project.id === currentProject;
            const isViewer = project.viewer_role === "viewer";
            return (
              <button
                key={project.id}
                type="button"
                className={`proj-card ${isActive ? "proj-card--active" : ""}`}
                onClick={() => onSelect(project.id)}
              >
                <div className="proj-card-thumb-wrap">
                  {(project.thumbnails && project.thumbnails.length > 0) ? (
                    <div className={`proj-card-thumb proj-card-bento proj-card-bento--${Math.min(project.thumbnails.length, 3)}`}>
                      {project.thumbnails.slice(0, 3).map((url, i) => (
                        <img key={i} className="proj-card-bento-img" src={url} alt="" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                      ))}
                      <div className="proj-card-thumb-overlay" />
                    </div>
                  ) : (
                    <div className="proj-card-thumb" />
                  )}
                  {!isViewer && (
                  <div className="proj-card-actions">
                    <span
                      className="proj-card-action"
                      role="button"
                      tabIndex={0}
                      onClick={(e) => { e.stopPropagation(); setSettingsProject(project); }}
                      aria-label="Settings"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="3" />
                        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                      </svg>
                    </span>
                    <span
                      className="proj-card-action proj-card-action--delete"
                      role="button"
                      tabIndex={0}
                      onClick={(e) => { e.stopPropagation(); onDelete(project.id); }}
                      aria-label="Delete"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </span>
                  </div>
                  )}
                  {isViewer && (
                    <div style={{
                      position: "absolute", top: 8, left: 8, padding: "2px 8px",
                      background: "rgba(0,0,0,0.55)", color: "#fff", fontSize: 10,
                      fontWeight: 600, letterSpacing: 0.5, borderRadius: 4, textTransform: "uppercase",
                    }}>Shared</div>
                  )}
                  {!isViewer && isTeamWorkspace && (
                    <div className="proj-card-team-badge">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                        <circle cx="9" cy="7" r="4" />
                        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                      </svg>
                      Team
                    </div>
                  )}
                </div>
                <div className="proj-card-info">
                  <span className="proj-card-name">{project.name}</span>
                  <div className="proj-card-meta">
                    {isViewer && project.owner_display_name ? (
                      <span>Shared by {project.owner_display_name}</span>
                    ) : (
                      <span>{project.date}</span>
                    )}
                    <span>{project.items ?? project.node_count ?? 0} items</span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {settingsProject && (
        <SettingsPanel
          project={settingsProject}
          onClose={() => setSettingsProject(null)}
          onDelete={onDelete}
          onRename={onRename || (() => {})}
        />
      )}
    </div>
  );
}

