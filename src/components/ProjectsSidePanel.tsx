import { useEffect, useRef, useState } from "react";
import type { Project, ProjectsTab } from "./ProjectsPage";
import { useWorkspace } from "../contexts/WorkspaceContext";
import "./ProjectsSidePanel.css";

export type ProjectsHandlers = {
  projects: Project[];
  currentProject: string;
  onSelect: (id: string) => void;
  onCreate: (name: string) => void;
  onDelete: (id: string) => void;
  onRename?: (id: string, name: string) => void;
  defaultName?: string;
  sharingEnabled?: boolean;
  sharedProjects?: Project[];
  activeTab?: ProjectsTab;
  onTabChange?: (tab: ProjectsTab) => void;
};

type Props = {
  handlers: ProjectsHandlers;
  onClose: () => void;
  onSettingsOpen?: (section?: string) => void;
  fetchError?: string | null;
};

export function ProjectsSidePanel({ handlers, onClose, onSettingsOpen, fetchError }: Props) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [orgExpanded, setOrgExpanded] = useState(false);
  const [viewingShared, setViewingShared] = useState(false);
  const orgRef = useRef<HTMLDivElement>(null);
  const { workspaces, activeWorkspace, setActiveWorkspace } = useWorkspace();

  useEffect(() => { setViewingShared(false); }, [activeWorkspace?.id]);

  const sharedAvailable = !!handlers.sharingEnabled;
  const sharedList: Project[] = sharedAvailable ? (handlers.sharedProjects || []) : [];

  useEffect(() => {
    if (!orgExpanded) return;
    const onDoc = (e: MouseEvent) => {
      if (orgRef.current && !orgRef.current.contains(e.target as Node)) setOrgExpanded(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [orgExpanded]);

  const visibleProjects: Project[] = viewingShared ? sharedList : handlers.projects;
  const scopeLabel = viewingShared ? "Shared with me" : (activeWorkspace?.name ?? "Team");
  const defaultName = handlers.defaultName || "Untitled Project";

  const handleCreate = () => {
    handlers.onCreate(newName.trim() || defaultName);
    setNewName("");
    setCreating(false);
  };

  return (
    <aside className="proj-side-panel">
      <div className="proj-side-header">
        <span className="proj-side-title">Projects</span>
        <button type="button" className="proj-side-close" onClick={onClose} aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
        </button>
      </div>

      <div className="proj-side-org-wrap" ref={orgRef}>
        <button
          type="button"
          className={`nav-row nav-row--org ${orgExpanded ? "nav-row--org-open" : ""}`}
          onClick={() => setOrgExpanded((v) => !v)}
        >
          <span className="nav-row-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </span>
          <span className="nav-row-label">{scopeLabel}</span>
          <svg className={`nav-row-chevron ${orgExpanded ? "nav-row-chevron--open" : ""}`} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
        </button>

        {orgExpanded && (
          <div className="org-dropdown">
            {workspaces.map((ws) => {
              const isActiveReal = !viewingShared && activeWorkspace?.id === ws.id;
              return (
                <button
                  key={ws.id}
                  type="button"
                  className={`org-dropdown-item ${isActiveReal ? "org-dropdown-item--active" : ""}`}
                  onClick={() => {
                    setViewingShared(false);
                    if (activeWorkspace?.id !== ws.id) setActiveWorkspace(ws);
                    setOrgExpanded(false);
                  }}
                >
                  <span className="org-dropdown-avatar">{ws.name[0]}</span>
                  <span className="org-dropdown-name">{ws.name}</span>
                  {isActiveReal && (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                  )}
                </button>
              );
            })}
            {sharedAvailable && (
              <button
                type="button"
                className={`org-dropdown-item ${viewingShared ? "org-dropdown-item--active" : ""}`}
                onClick={() => { setViewingShared(true); setOrgExpanded(false); }}
              >
                <span className="org-dropdown-avatar" aria-hidden="true">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" /></svg>
                </span>
                <span className="org-dropdown-name">Shared with me</span>
                {viewingShared && (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                )}
              </button>
            )}
            <div className="org-dropdown-sep" />
            <button
              type="button"
              className="org-dropdown-item org-dropdown-item--create"
              onClick={() => { setOrgExpanded(false); onSettingsOpen?.("general"); }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
              <span className="org-dropdown-name">New Team</span>
            </button>
            <button
              type="button"
              className="org-dropdown-item org-dropdown-item--manage"
              onClick={() => { setOrgExpanded(false); onSettingsOpen?.("general"); }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
              <span className="org-dropdown-name">Manage Team</span>
            </button>
          </div>
        )}
      </div>

      <div className="proj-side-create-row" style={viewingShared ? { display: "none" } : undefined}>
        {creating ? (
          <div className="proj-side-create-form">
            <input
              type="text"
              className="proj-side-input"
              placeholder={defaultName}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
                if (e.key === "Escape") { setCreating(false); setNewName(""); }
              }}
              autoFocus
            />
            <button type="button" className="proj-side-create-btn" onClick={handleCreate}>Add</button>
            <button type="button" className="proj-side-cancel-btn" onClick={() => { setCreating(false); setNewName(""); }}>×</button>
          </div>
        ) : (
          <button type="button" className="proj-side-new" onClick={() => setCreating(true)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span>New Project</span>
          </button>
        )}
      </div>

      <div className="proj-side-list">
        {visibleProjects.length === 0 && (
          <div className="proj-side-empty">
            {!viewingShared && fetchError
              ? fetchError
              : viewingShared ? "Nothing shared with you yet." : "No projects yet."}
          </div>
        )}

        {visibleProjects.map((p, idx) => {
          const isActive = p.id === handlers.currentProject;
          const isViewer = p.viewer_role === "viewer";
          const isRenaming = renamingId === p.id;
          return (
            <div
              key={p.id}
              className={`proj-side-item ${isActive ? "proj-side-item--active" : ""}`}
              style={{ animationDelay: `${Math.min(idx, 20) * 35}ms` }}
              onClick={() => !isRenaming && handlers.onSelect(p.id)}
            >
              <div className="proj-side-thumb">
                {p.thumbnails && p.thumbnails.length > 0 ? (
                  <img src={p.thumbnails[0]} alt="" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                ) : null}
              </div>
              <div className="proj-side-info">
                {isRenaming ? (
                  <input
                    type="text"
                    className="proj-side-rename-input"
                    value={renameValue}
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => {
                      if (renameValue.trim() && renameValue !== p.name) handlers.onRename?.(p.id, renameValue.trim());
                      setRenamingId(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") { setRenamingId(null); }
                    }}
                  />
                ) : (
                  <span className="proj-side-name" title={p.name}>
                    {p.name}
                    {isViewer && (
                      <span style={{
                        marginLeft: 6, padding: "1px 5px", fontSize: 9, fontWeight: 600,
                        letterSpacing: 0.4, borderRadius: 3, textTransform: "uppercase",
                        background: "rgba(255,255,255,0.12)", color: "#cfd6e0", verticalAlign: "middle",
                      }}>Shared</span>
                    )}
                  </span>
                )}
                <div className="proj-side-meta">
                  {isViewer ? (
                    <span title={p.owner_email}>by {p.owner_display_name || p.owner_email || "shared"}</span>
                  ) : (
                    <span>{p.date}</span>
                  )}
                  <span>·</span>
                  <span>{p.items ?? p.node_count ?? 0}</span>
                </div>
              </div>
              {!isViewer && (
                <div className="proj-side-actions">
                  <button
                    type="button"
                    className="proj-side-action"
                    aria-label="Rename"
                    onClick={(e) => { e.stopPropagation(); setRenameValue(p.name); setRenamingId(p.id); }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" /></svg>
                  </button>
                  <button
                    type="button"
                    className="proj-side-action proj-side-action--del"
                    aria-label="Delete"
                    onClick={(e) => { e.stopPropagation(); if (confirm(`Delete "${p.name}"?`)) handlers.onDelete(p.id); }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
