import { useEffect, useRef, useState } from "react";
import type { Project } from "./ProjectsPage";
import "./ProjectTabs.css";

/**
 * Chrome-style project tabs across the top of the canvas.
 *
 * "Open" is a client-side notion that does not exist on the server: closing a
 * tab removes it from this strip and nothing else. Projects are only ever
 * deleted from the home screen, deliberately — a close button that destroyed
 * work would be the same gesture users make hundreds of times a day in a
 * browser expecting it to be free.
 */
type Props = {
  projects: Project[];
  openIds: string[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, name: string) => void;
};

export function ProjectTabs({ projects, openIds, activeId, onSelect, onClose, onCreate, onRename }: Props) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renamingId) inputRef.current?.select();
  }, [renamingId]);

  // A tab whose project vanished (deleted from the home screen) is dropped
  // rather than rendered as a blank.
  const tabs = openIds
    .map((id) => projects.find((p) => p.id === id))
    .filter((p): p is Project => !!p);

  const commitRename = () => {
    if (!renamingId) return;
    const name = draft.trim();
    const current = tabs.find((t) => t.id === renamingId)?.name;
    if (name && name !== current) onRename(renamingId, name);
    setRenamingId(null);
  };

  return (
    <div className="project-tabs" role="tablist" aria-label="Open projects">
      <div className="project-tabs__strip">
        {tabs.map((p) => {
          const active = p.id === activeId;
          const renaming = renamingId === p.id;
          return (
            <div
              key={p.id}
              role="tab"
              aria-selected={active}
              className={`project-tab ${active ? "project-tab--active" : ""}`}
              onMouseDown={(e) => {
                // Middle-click closes, same as a browser.
                if (e.button === 1) { e.preventDefault(); onClose(p.id); }
              }}
              onClick={() => { if (!active) onSelect(p.id); }}
              title={p.name}
            >
              {renaming ? (
                <input
                  ref={inputRef}
                  className="project-tab__rename"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") setRenamingId(null);
                    e.stopPropagation();
                  }}
                />
              ) : (
                <span
                  className="project-tab__name"
                  // Click-to-rename only on the tab you're already on, so the
                  // first click on a background tab switches to it as expected.
                  onClick={(e) => {
                    if (!active) return;
                    e.stopPropagation();
                    setDraft(p.name);
                    setRenamingId(p.id);
                  }}
                >
                  {p.name}
                </span>
              )}
              <button
                type="button"
                className="project-tab__close"
                aria-label={`Close ${p.name}`}
                title="Close tab"
                onClick={(e) => { e.stopPropagation(); onClose(p.id); }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
                </svg>
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className="project-tabs__new"
          onClick={onCreate}
          aria-label="New project"
          title="New project"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M7 1.5v11M1.5 7h11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
          </svg>
        </button>
      </div>
    </div>
  );
}
