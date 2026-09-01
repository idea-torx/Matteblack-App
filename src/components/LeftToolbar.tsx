import { useState, useEffect, useRef, type ReactNode } from "react";
import { useWorkspace } from "../contexts/WorkspaceContext";

import "./LeftToolbar.css";
import "./RightPanel.css";

export type ToolId = "make" | "create" | "upscale" | "resize" | "remove" | "avatar" | "design" | "gifmaker" | "svgmaker" | "nodes" | "cinema" | "audio" | "tts" | "music" | "voicechanger" | "sfx" | "clearcheck" | "auditlog";
export type PageMode = "tools" | "library";

type LeftToolbarProps = {
  mode: PageMode;
  selectedTool: ToolId | null;
  onToolSelect: (tool: ToolId) => void;
  onCinemaChildSelect?: (tool: ToolId) => void;
  onSettingsOpen?: (section?: string) => void;
  onLibrarySelect?: (view: string) => void;
  activeLibraryView?: string | null;
  readOnly?: boolean;
  onClose?: () => void;
};

type NavItem = { id: ToolId; label: string; icon: ReactNode };

const makeIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 9h18" /><path d="M9 3v6" />
  </svg>
);

const MAKE_CHILDREN: NavItem[] = [
  {
    id: "create",
    label: "Image & Video",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" />
      </svg>
    ),
  },
  {
    id: "upscale",
    label: "Upscale",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="15 3 21 3 21 9" />
        <polyline points="9 21 3 21 3 15" />
        <line x1="21" y1="3" x2="14" y2="10" />
        <line x1="3" y1="21" x2="10" y2="14" />
      </svg>
    ),
  },
  {
    id: "resize",
    label: "Resize",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <rect x="9" y="9" width="6" height="6" rx="1" />
      </svg>
    ),
  },
  {
    id: "remove",
    label: "Remove BG",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      </svg>
    ),
  },
  {
    id: "svgmaker",
    label: "Vector",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5" />
        <line x1="12" y1="22" x2="12" y2="15.5" />
        <polyline points="22 8.5 12 15.5 2 8.5" />
      </svg>
    ),
  },
  {
    id: "gifmaker",
    label: "GIF Maker",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="2" width="20" height="20" rx="2" />
        <path d="M10 8v8l6-4-6-4z" />
      </svg>
    ),
  },
];

const CINEMA_CHILDREN: NavItem[] = [
  {
    id: "cinema",
    label: "Cinema Frame",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="2" width="20" height="20" rx="2.18" />
        <line x1="7" y1="2" x2="7" y2="22" /><line x1="17" y1="2" x2="17" y2="22" />
        <line x1="2" y1="12" x2="22" y2="12" />
      </svg>
    ),
  },
  {
    id: "create",
    label: "Director",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" />
      </svg>
    ),
  },
  {
    id: "avatar",
    label: "Avatar",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    ),
  },
  {
    id: "upscale",
    label: "Upscale",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="15 3 21 3 21 9" />
        <polyline points="9 21 3 21 3 15" />
        <line x1="21" y1="3" x2="14" y2="10" />
        <line x1="3" y1="21" x2="10" y2="14" />
      </svg>
    ),
  },
  {
    id: "resize",
    label: "Resize",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <rect x="9" y="9" width="6" height="6" rx="1" />
      </svg>
    ),
  },
  {
    id: "tts",
    label: "Text to Speech",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" y1="19" x2="12" y2="23" />
        <line x1="8" y1="23" x2="16" y2="23" />
      </svg>
    ),
  },
  {
    id: "music",
    label: "Music",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 18V5l12-2v13" />
        <circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
      </svg>
    ),
  },
  {
    id: "voicechanger",
    label: "Voice Changer",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="8.5" cy="7" r="4" />
        <polyline points="17 11 19 13 23 9" />
      </svg>
    ),
  },
  {
    id: "sfx",
    label: "SFX",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
        <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      </svg>
    ),
  },
];

const audioIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 18V5l12-2v13" />
    <circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
  </svg>
);

const AUDIO_CHILDREN: NavItem[] = [
  {
    id: "tts",
    label: "Text to Speech",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" y1="19" x2="12" y2="23" />
        <line x1="8" y1="23" x2="16" y2="23" />
      </svg>
    ),
  },
  {
    id: "music",
    label: "Music",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 18V5l12-2v13" />
        <circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
      </svg>
    ),
  },
  {
    id: "voicechanger",
    label: "Voice Changer",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="8.5" cy="7" r="4" />
        <polyline points="17 11 19 13 23 9" />
      </svg>
    ),
  },
  {
    id: "sfx",
    label: "SFX",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
        <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      </svg>
    ),
  },
];


const cinemaIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="2" width="20" height="20" rx="2.18" />
    <line x1="7" y1="2" x2="7" y2="22" /><line x1="17" y1="2" x2="17" y2="22" />
    <line x1="2" y1="12" x2="22" y2="12" />
  </svg>
);


const clearcheckIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    <polyline points="9 12 11 14 15 10" />
  </svg>
);

const CLEARCHECK_CHILDREN: NavItem[] = [
  {
    id: "clearcheck",
    label: "Copyright Check",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
        <path d="M8 11h6" /><path d="M11 8v6" />
      </svg>
    ),
  },
  {
    id: "auditlog",
    label: "Audit Log",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
        <rect x="8" y="2" width="8" height="4" rx="1" />
        <line x1="8" y1="10" x2="16" y2="10" />
        <line x1="8" y1="14" x2="16" y2="14" />
        <line x1="8" y1="18" x2="12" y2="18" />
      </svg>
    ),
  },
];


function isMakeChild(t: ToolId | null) { return t === "create" || t === "upscale" || t === "resize" || t === "remove" || t === "svgmaker" || t === "gifmaker"; }
// Highlight: only items unique to the Cinema rail. For ids that also appear
// in the Make rail (create / upscale / resize), the Make rail wins per task spec.
function isCinemaChild(t: ToolId | null) { return t === "cinema" || t === "avatar"; }
// Expand on re-entry: only auto-expand for tools unique to the Cinema rail.
// Shared ids (create / upscale / resize) belong to Make first; explicit user
// clicks on Cinema children below pin `cinemaExpanded` for the session.
function isCinemaTool(t: ToolId | null) { return t === "cinema" || t === "avatar"; }
function isAudioChild(t: ToolId | null) { return t === "tts" || t === "music" || t === "voicechanger" || t === "sfx"; }
function isClearcheckChild(t: ToolId | null) { return t === "clearcheck" || t === "auditlog"; }

export function LeftToolbar({
  mode,
  selectedTool,
  onToolSelect: rawOnToolSelect,
  onCinemaChildSelect,
  onSettingsOpen,
  onLibrarySelect,
  activeLibraryView,
  readOnly = false,
  onClose,
}: LeftToolbarProps) {
  const onToolSelect = (tool: ToolId) => {
    if (readOnly) return;
    rawOnToolSelect(tool);
  };
  const cinemaUnlocked = true;

  const [makeExpanded, setMakeExpanded] = useState(isMakeChild(selectedTool) || selectedTool === "make");
  const [cinemaExpanded, setCinemaExpanded] = useState(isCinemaTool(selectedTool));
  const [audioExpanded, setAudioExpanded] = useState(isAudioChild(selectedTool) || selectedTool === "audio");
  const [clearcheckExpanded, setClearcheckExpanded] = useState(isClearcheckChild(selectedTool));
  const [orgExpanded, setOrgExpanded] = useState(false);
  const { workspaces, activeWorkspace, setActiveWorkspace } = useWorkspace();
  const [libSections, setLibSections] = useState<Set<string>>(new Set(["assets"]));
  const toggleLibSection = (key: string) =>
    setLibSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  // Local "closing" flag so the X button can play a soft slide-out +
  // fade exit animation before the parent unmounts the panel. The
  // delay must stay in sync with the .sidebar--closing transition in
  // LeftToolbar.css (opacity 320ms / transform 380ms) — undershooting
  // it would cut the slide-out short.
  const [closing, setClosing] = useState(false);
  const closingTimerRef = useRef<number | null>(null);
  // Reset on mount and clear any pending close timer on unmount so that
  // a parent remount during the 380ms close animation can't strand the
  // panel in a `pointer-events: none` (.sidebar--closing) state.
  useEffect(() => {
    setClosing(false);
    return () => {
      if (closingTimerRef.current !== null) {
        window.clearTimeout(closingTimerRef.current);
        closingTimerRef.current = null;
      }
    };
  }, []);
  const handleClose = () => {
    if (closing || !onClose) return;
    setClosing(true);
    if (closingTimerRef.current !== null) {
      window.clearTimeout(closingTimerRef.current);
    }
    closingTimerRef.current = window.setTimeout(() => {
      closingTimerRef.current = null;
      onClose();
    }, 380);
  };

  return (
    <aside className={`sidebar ${closing ? "sidebar--closing" : ""}`}>
      <div className="sidebar-panel-header">
        <span className="sidebar-panel-title">{mode === "library" ? "Library" : "Toolkit"}</span>
        {onClose && (
          <button type="button" className="sidebar-panel-close" onClick={handleClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        )}
      </div>
      <div className="sidebar-scroll">
        {mode === "tools" && (
          <nav className="sidebar-nav">
            {/* Make parent */}
            <button
              type="button"
              className={`nav-row nav-row--parent ${selectedTool === "make" || isMakeChild(selectedTool) ? "nav-row--active" : ""}`}
              onClick={() => {
                setMakeExpanded(true);
                onToolSelect("create");
              }}
            >
              <span className="nav-row-icon">{makeIcon}</span>
              <span className="nav-row-label">Generative Tools</span>
              <svg className={`nav-row-chevron ${makeExpanded ? "nav-row-chevron--open" : ""}`} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" onClick={(e) => { e.stopPropagation(); setMakeExpanded((v) => !v); }}><polyline points="6 9 12 15 18 9" /></svg>
            </button>

            {/* Child tools */}
            <div
              className={`nav-children ${makeExpanded ? "nav-children--open" : ""}`}
              aria-hidden={!makeExpanded}
            >
              {MAKE_CHILDREN.map(({ id, label, icon }) => (
                <button
                  key={id}
                  type="button"
                  tabIndex={makeExpanded ? 0 : -1}
                  className={`nav-row nav-row--child ${selectedTool === id ? "nav-row--active" : ""}`}
                  onClick={() => onToolSelect(id)}
                >
                  <span className="nav-row-icon">{icon}</span>
                  <span className="nav-row-label">{label}</span>
                </button>
              ))}
            </div>

            {/* Cinema parent — category that nests cinema tools (acts on current canvas) */}
            <button
              type="button"
              className={`nav-row nav-row--parent ${isCinemaChild(selectedTool) ? "nav-row--active" : ""}`}
              onClick={() => {
                setCinemaExpanded((v) => !v);
              }}
            >
              <span className="nav-row-icon">{cinemaIcon}</span>
              <span className="nav-row-label">Cinema</span>
              <span className="nav-row-beta-tag">Beta</span>
              <svg className={`nav-row-chevron ${cinemaExpanded ? "nav-row-chevron--open" : ""}`} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" onClick={(e) => { e.stopPropagation(); setCinemaExpanded((v) => !v); }}><polyline points="6 9 12 15 18 9" /></svg>
            </button>

            {/* Cinema child tools — clicking acts on current canvas, never switches projects */}
            <div
              className={`nav-children ${cinemaExpanded && cinemaUnlocked ? "nav-children--open" : ""}`}
              aria-hidden={!(cinemaExpanded && cinemaUnlocked)}
            >
              {CINEMA_CHILDREN.map(({ id, label, icon }) => (
                <button
                  key={id}
                  type="button"
                  tabIndex={cinemaExpanded && cinemaUnlocked ? 0 : -1}
                  className={`nav-row nav-row--child ${selectedTool === id ? "nav-row--active" : ""}`}
                  onClick={() => {
                    if (readOnly) return;
                    setCinemaExpanded(true);
                    if (onCinemaChildSelect) onCinemaChildSelect(id);
                    else onToolSelect(id);
                  }}
                >
                  <span className="nav-row-icon">{icon}</span>
                  <span className="nav-row-label">{label}</span>
                </button>
              ))}
            </div>

            {/* Audio parent */}
            <button
              type="button"
              className={`nav-row nav-row--parent ${selectedTool === "audio" || isAudioChild(selectedTool) ? "nav-row--active" : ""}`}
              onClick={() => {
                setAudioExpanded(true);
                onToolSelect("audio");
              }}
            >
              <span className="nav-row-icon">{audioIcon}</span>
              <span className="nav-row-label">Audio</span>
              <svg className={`nav-row-chevron ${audioExpanded ? "nav-row-chevron--open" : ""}`} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" onClick={(e) => { e.stopPropagation(); setAudioExpanded((v) => !v); }}><polyline points="6 9 12 15 18 9" /></svg>
            </button>

            {/* Audio child tools */}
            <div
              className={`nav-children ${audioExpanded ? "nav-children--open" : ""}`}
              aria-hidden={!audioExpanded}
            >
              {AUDIO_CHILDREN.map(({ id, label, icon }) => (
                <button
                  key={id}
                  type="button"
                  tabIndex={audioExpanded ? 0 : -1}
                  className={`nav-row nav-row--child ${selectedTool === id ? "nav-row--active" : ""}`}
                  onClick={() => onToolSelect(id)}
                >
                  <span className="nav-row-icon">{icon}</span>
                  <span className="nav-row-label">{label}</span>
                </button>
              ))}
            </div>

            {/* Clearcheck parent */}
            <button
              type="button"
              className={`nav-row nav-row--parent ${isClearcheckChild(selectedTool) ? "nav-row--active" : ""}`}
              onClick={() => {
                setClearcheckExpanded(true);
                onToolSelect("clearcheck");
              }}
            >
              <span className="nav-row-icon">{clearcheckIcon}</span>
              <span className="nav-row-label">Clearcheck</span>
              <svg className={`nav-row-chevron ${clearcheckExpanded ? "nav-row-chevron--open" : ""}`} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" onClick={(e) => { e.stopPropagation(); setClearcheckExpanded((v) => !v); }}><polyline points="6 9 12 15 18 9" /></svg>
            </button>

            <div
              className={`nav-children ${clearcheckExpanded ? "nav-children--open" : ""}`}
              aria-hidden={!clearcheckExpanded}
            >
              {CLEARCHECK_CHILDREN.map(({ id, label, icon }) => (
                <button
                  key={id}
                  type="button"
                  tabIndex={clearcheckExpanded ? 0 : -1}
                  className={`nav-row nav-row--child ${selectedTool === id ? "nav-row--active" : ""}`}
                  onClick={() => onToolSelect(id)}
                >
                  <span className="nav-row-icon">{icon}</span>
                  <span className="nav-row-label">{label}</span>
                </button>
              ))}
            </div>

          </nav>
        )}

        {mode === "library" && (
          <nav className="sidebar-nav">
            {/* Org switcher */}
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
              <span className="nav-row-label">{activeWorkspace?.name ?? "Team"}</span>
              <svg className={`nav-row-chevron ${orgExpanded ? "nav-row-chevron--open" : ""}`} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
            </button>

            {orgExpanded && (
              <div className="org-dropdown">
                {workspaces.map((ws) => (
                  <button
                    key={ws.id}
                    type="button"
                    className={`org-dropdown-item ${activeWorkspace?.id === ws.id ? "org-dropdown-item--active" : ""}`}
                    onClick={() => { setActiveWorkspace(ws); setOrgExpanded(false); }}
                  >
                    <span className="org-dropdown-avatar">{ws.name[0]}</span>
                    <span className="org-dropdown-name">{ws.name}</span>
                    {activeWorkspace?.id === ws.id && (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                    )}
                  </button>
                ))}
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

            <div className="sidebar-nav-sep" />

            {/* Assets */}
            <button
              type="button"
              className={`nav-row nav-row--parent ${libSections.has("assets") ? "nav-row--active" : ""}`}
              onClick={() => { setLibSections((prev) => new Set(prev).add("assets")); onLibrarySelect?.("images"); }}
            >
              <span className="nav-row-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
              </span>
              <span className="nav-row-label">Assets</span>
              <svg className={`nav-row-chevron ${libSections.has("assets") ? "nav-row-chevron--open" : ""}`} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" onClick={(e) => { e.stopPropagation(); toggleLibSection("assets"); }}><polyline points="6 9 12 15 18 9" /></svg>
            </button>
            <div
              className={`nav-children ${libSections.has("assets") ? "nav-children--open" : ""}`}
              aria-hidden={!libSections.has("assets")}
            >
              <button type="button" tabIndex={libSections.has("assets") ? 0 : -1} className={`nav-row nav-row--child ${activeLibraryView === "images" ? "nav-row--active" : ""}`} onClick={() => onLibrarySelect?.("images")}><span className="nav-row-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></svg></span><span className="nav-row-label">Images</span></button>
              <button type="button" tabIndex={libSections.has("assets") ? 0 : -1} className={`nav-row nav-row--child ${activeLibraryView === "videos" ? "nav-row--active" : ""}`} onClick={() => onLibrarySelect?.("videos")}><span className="nav-row-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" /></svg></span><span className="nav-row-label">Videos</span></button>
            </div>

            {/* Axioms */}
            <button
              type="button"
              className={`nav-row ${activeLibraryView === "axioms" ? "nav-row--active" : ""}`}
              onClick={() => onLibrarySelect?.("axioms")}
            >
              <span className="nav-row-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26" />
                </svg>
              </span>
              <span className="nav-row-label">Products</span>
              {activeWorkspace?.role === "member" && (
                <svg className="nav-row-lock" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
              )}
            </button>

            {/* Styles */}
            <button
              type="button"
              className={`nav-row ${activeLibraryView === "styles" ? "nav-row--active" : ""}`}
              onClick={() => onLibrarySelect?.("styles")}
            >
              <span className="nav-row-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="13.5" cy="6.5" r="2.5" />
                  <circle cx="19" cy="17" r="2.5" />
                  <circle cx="6" cy="12" r="2.5" />
                  <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.5-.75 1.5-1.5 0-.39-.15-.74-.39-1.02-.24-.28-.37-.62-.37-.98 0-.83.67-1.5 1.5-1.5H16c3.31 0 6-2.69 6-6 0-5.52-4.48-10-10-10z" />
                </svg>
              </span>
              <span className="nav-row-label">Prompts</span>
              {activeWorkspace?.role === "member" && (
                <svg className="nav-row-lock" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
              )}
            </button>

            {/* Audio */}
            <button
              type="button"
              className={`nav-row nav-row--parent ${libSections.has("audio") ? "nav-row--active" : ""}`}
              onClick={() => { setLibSections((prev) => new Set(prev).add("audio")); onLibrarySelect?.("music"); }}
            >
              <span className="nav-row-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 18V5l12-2v13" />
                  <circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
                </svg>
              </span>
              <span className="nav-row-label">Audio</span>
              <svg className={`nav-row-chevron ${libSections.has("audio") ? "nav-row-chevron--open" : ""}`} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" onClick={(e) => { e.stopPropagation(); toggleLibSection("audio"); }}><polyline points="6 9 12 15 18 9" /></svg>
            </button>
            <div
              className={`nav-children ${libSections.has("audio") ? "nav-children--open" : ""}`}
              aria-hidden={!libSections.has("audio")}
            >
              <button type="button" tabIndex={libSections.has("audio") ? 0 : -1} className={`nav-row nav-row--child ${activeLibraryView === "music" ? "nav-row--active" : ""}`} onClick={() => onLibrarySelect?.("music")}><span className="nav-row-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg></span><span className="nav-row-label">Music</span></button>
              <button type="button" tabIndex={libSections.has("audio") ? 0 : -1} className={`nav-row nav-row--child ${activeLibraryView === "voices" ? "nav-row--active" : ""}`} onClick={() => onLibrarySelect?.("voices")}><span className="nav-row-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" /></svg></span><span className="nav-row-label">Voices</span></button>
              <button type="button" tabIndex={libSections.has("audio") ? 0 : -1} className={`nav-row nav-row--child ${activeLibraryView === "sfx" ? "nav-row--active" : ""}`} onClick={() => onLibrarySelect?.("sfx")}><span className="nav-row-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14" /><path d="M15.54 8.46a5 5 0 0 1 0 7.07" /></svg></span><span className="nav-row-label">Sound Effects</span></button>
            </div>

            <div className="nav-separator" />

            <button
              type="button"
              className={`nav-row ${activeLibraryView === "trash" ? "nav-row--active" : ""}`}
              onClick={() => onLibrarySelect?.("trash")}
            >
              <span className="nav-row-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </span>
              <span className="nav-row-label">Trash</span>
            </button>
          </nav>
        )}
      </div>

    </aside>
  );
}
