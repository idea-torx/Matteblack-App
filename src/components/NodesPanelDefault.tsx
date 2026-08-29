import type { ReactNode } from "react";
import { NODE_SCHEMAS, createNode, type NodeType, type WorkflowNode } from "./nodeTypes";
import "./RightPanel.css";

const PALETTE_TYPES: { section: string; types: NodeType[] }[] = [
  { section: "Core", types: ["text", "image", "video"] },
  { section: "Image Processing", types: ["upscale", "resize", "remove"] },
  { section: "Audio", types: ["tts", "music", "voicechanger"] },
  { section: "Library", types: ["axiom", "style"] },
  { section: "Utility", types: ["gifmaker"] },
];

const TYPE_ICONS: Record<NodeType, ReactNode> = {
  text: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7V4h16v3" /><path d="M9 20h6" /><path d="M12 4v16" /></svg>,
  image: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></svg>,
  video: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" /></svg>,
  upscale: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></svg>,
  resize: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M9 9l6 6" /></svg>,
  remove: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>,
  tts: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /></svg>,
  music: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>,
  voicechanger: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="8.5" cy="7" r="4" /><polyline points="17 11 19 13 23 9" /></svg>,
  gifmaker: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="20" rx="2" /><path d="M10 8v8l6-4-6-4z" /></svg>,
  axiom: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /></svg>,
  style: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="13.5" cy="6.5" r="2.5" /><circle cx="19" cy="17" r="2.5" /><circle cx="6" cy="12" r="2.5" /><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.5-.75 1.5-1.5 0-.39-.15-.74-.39-1.02-.24-.28-.37-.62-.37-.98 0-.83.67-1.5 1.5-1.5H16c3.31 0 6-2.69 6-6 0-5.52-4.48-10-10-10z" /></svg>,
};

const LIBRARY_NODE_TYPES = new Set<NodeType>(["axiom", "style"]);
const LIBRARY_VIEW_MAP: Partial<Record<NodeType, string>> = {
  axiom: "axioms",
  style: "styles",
};

type Props = {
  onAddNode: (node: WorkflowNode) => void;
  onRun: () => void;
  onOpenLibrary?: (view: string) => void;
};

export function NodesPanelDefault({ onAddNode, onRun, onOpenLibrary }: Props) {
  const handleAdd = (type: NodeType) => {
    if (LIBRARY_NODE_TYPES.has(type) && onOpenLibrary) {
      onOpenLibrary(LIBRARY_VIEW_MAP[type]!);
      return;
    }
    const node = createNode(type, 300 + Math.random() * 100, 200 + Math.random() * 100);
    if (type === "image" || type === "video") node.config._width = 260;
    onAddNode(node);
  };

  return (
    <aside className="rpanel">
      <div className="rpanel-scroll">
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", padding: "2px 0 8px" }}>
          Nodes
        </div>

        {PALETTE_TYPES.map((section) => (
          <div key={section.section} className="rpanel-card">
            <div className="rpanel-card-title">{section.section}</div>
            <div className="rpanel-list">
              {section.types.map((type) => {
                const schema = NODE_SCHEMAS[type];
                const isLibType = LIBRARY_NODE_TYPES.has(type);
                return (
                  <button
                    key={type}
                    type="button"
                    className="rpanel-list-btn"
                    onClick={() => handleAdd(type)}
                  >
                    {TYPE_ICONS[type]}
                    <span style={{ flex: 1 }}>{schema.label}</span>
                    {isLibType && (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.4 }}>
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                        <polyline points="15 3 21 3 21 9" />
                        <line x1="10" y1="14" x2="21" y2="3" />
                      </svg>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="rpanel-footer">
        <button type="button" className="rpanel-action-btn" onClick={onRun}>
          <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
            Run Workflow
          </span>
        </button>
      </div>
    </aside>
  );
}
