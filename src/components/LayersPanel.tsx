import type { CanvasNode } from "../types/canvas";
import "./LeftToolbar.css";
import "./LayersPanel.css";

type LayersPanelProps = {
  nodes: CanvasNode[];
  selectedIds: string[];
  onSelectNode: (id: string) => void;
  onClose: () => void;
};

function getTypeIcon(nodeType: string) {
  switch (nodeType) {
    case "image":
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <polyline points="21 15 16 10 5 21" />
        </svg>
      );
    case "video":
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="23 7 16 12 23 17 23 7" />
          <rect x="1" y="5" width="15" height="14" rx="2" />
        </svg>
      );
    case "svg":
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5" />
        </svg>
      );
    case "shape":
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" />
        </svg>
      );
    case "text":
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="4 7 4 4 20 4 20 7" />
          <line x1="9" y1="20" x2="15" y2="20" />
          <line x1="12" y1="4" x2="12" y2="20" />
        </svg>
      );
    case "group":
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="7" width="6" height="6" rx="1" />
          <rect x="16" y="7" width="6" height="6" rx="1" />
          <rect x="9" y="11" width="6" height="6" rx="1" />
          <line x1="5" y1="7" x2="5" y2="4" />
          <line x1="19" y1="7" x2="19" y2="4" />
          <line x1="12" y1="11" x2="12" y2="4" />
          <line x1="5" y1="4" x2="19" y2="4" />
        </svg>
      );
    case "frame":
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="3" y1="9" x2="21" y2="9" />
          <line x1="9" y1="21" x2="9" y2="9" />
        </svg>
      );
    case "cinema":
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="2" width="20" height="20" rx="2.18" />
          <line x1="7" y1="2" x2="7" y2="22" />
          <line x1="17" y1="2" x2="17" y2="22" />
          <line x1="2" y1="12" x2="22" y2="12" />
        </svg>
      );
    default:
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" />
        </svg>
      );
  }
}

function getNodeLabel(node: CanvasNode): string {
  if (node.label && node.label.trim()) return node.label.trim();
  const shortId = node.id.slice(-4);
  return `${node.node_type} ${shortId}`;
}

function computeTopLevelNodes(nodes: CanvasNode[]): CanvasNode[] {
  const visibleFrames = nodes.filter(
    (n) => n.node_type === "frame" && n.visible !== false
  );

  const groupMemberIds = new Set<string>();
  for (const n of nodes) {
    if (n.node_type === "group" && Array.isArray(n.metadata?.members)) {
      for (const memberId of n.metadata.members as string[]) {
        groupMemberIds.add(memberId);
      }
    }
  }

  return nodes
    .filter((node) => {
      if (node.node_type === "frame" || node.node_type === "group" || node.node_type === "cinema") {
        return true;
      }
      if (groupMemberIds.has(node.id)) {
        return false;
      }
      if (visibleFrames.length > 0) {
        const centerX = node.x + node.width / 2;
        const centerY = node.y + node.height / 2;
        for (const frame of visibleFrames) {
          if (
            centerX >= frame.x && centerX <= frame.x + frame.width &&
            centerY >= frame.y && centerY <= frame.y + frame.height
          ) {
            return false;
          }
        }
      }
      return true;
    })
    .sort((a, b) => b.z_index - a.z_index);
}

export function LayersPanel({ nodes, selectedIds, onSelectNode, onClose }: LayersPanelProps) {
  const topLevelNodes = computeTopLevelNodes(nodes);
  const selectedSet = new Set(selectedIds);

  return (
    <aside className="sidebar">
      <div className="sidebar-panel-header">
        <span className="sidebar-panel-title">Layers</span>
        <button type="button" className="sidebar-panel-close" onClick={onClose} aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <div className="sidebar-scroll">
        {topLevelNodes.length === 0 ? (
          <div className="layers-panel-empty">No layers yet</div>
        ) : (
          <div className="layers-list">
            {topLevelNodes.map((node) => (
              <button
                key={node.id}
                type="button"
                className={`layers-row${selectedSet.has(node.id) ? " layers-row--selected" : ""}`}
                onClick={() => onSelectNode(node.id)}
              >
                <span className="layers-row-icon">{getTypeIcon(node.node_type)}</span>
                <span className="layers-row-label">{getNodeLabel(node)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
