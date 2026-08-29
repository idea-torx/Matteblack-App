import { useState, useCallback } from "react";
import "./RightPanel.css";
import "./AxiomCreatorPanel.css";

export interface FolderCreatorPanelProps {
  onClose: () => void;
  selectedItems: Map<string, { name: string; thumb: string }>;
  onToggleItem: (id: string, meta?: { name: string; thumb: string }) => void;
  onAddItem: (item: { id: string; label: string; gradient: string }) => void;
  folderType?: string;
  onCreated?: () => void;
}

function isMediaUrl(s: string) {
  return s && !s.startsWith("linear-gradient") && (s.startsWith("http") || s.startsWith("/") || s.startsWith("data:"));
}

function isVideoUrl(s: string) {
  return /\.(mp4|webm|mov|ogg)(\?|$)/i.test(s);
}

export function FolderCreatorPanel({ onClose, selectedItems, onToggleItem, onAddItem, folderType = "image", onCreated }: FolderCreatorPanelProps) {
  const [name, setName] = useState("");
  const [dropOver, setDropOver] = useState(false);
  const [saving, setSaving] = useState(false);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    details: true,
    items: true,
  });

  const toggle = (key: string) =>
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));

  const canSave = name.trim().length > 0;
  const isAudioType = ["music", "voice", "sound_effect"].includes(folderType);

  const handleCreate = useCallback(async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("/api/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: name.trim(), type: folderType }),
      });
      if (res.ok) {
        const data = await res.json();
        const folderId = data.folder?.id;
        if (folderId && selectedItems.size > 0) {
          const endpoint = isAudioType ? "/api/audio" : "/api/assets";
          await Promise.all(
            [...selectedItems.keys()].map((id) =>
              fetch(`${endpoint}/${id}/folder`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ folder_id: folderId }),
              })
            )
          );
        }
        onCreated?.();
        onClose();
      }
    } catch {}
    setSaving(false);
  }, [name, folderType, selectedItems, isAudioType, onClose, onCreated]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    const hasCanvasItem = e.dataTransfer.types.includes("application/x-canvas-gen");
    const hasLibItem = e.dataTransfer.types.includes("application/x-library-asset");
    if (hasCanvasItem || hasLibItem) {
      e.preventDefault();
      setDropOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) {
      setDropOver(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDropOver(false);

    const canvasData = e.dataTransfer.getData("application/x-canvas-gen");
    if (canvasData) {
      try {
        const data = JSON.parse(canvasData);
        onAddItem({ id: data.id, label: data.label, gradient: data.gradient });
      } catch {}
      return;
    }

    const libData = e.dataTransfer.getData("application/x-library-asset");
    if (libData) {
      try {
        const data = JSON.parse(libData);
        onAddItem({ id: data.id, label: data.label, gradient: data.gradient });
      } catch {}
    }
  }, [onAddItem]);

  const entries = [...selectedItems.entries()];

  return (
    <aside className="rpanel axiom-creator-overlay">
      <button type="button" className="gifmaker-close" onClick={onClose}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>

      <div className="rpanel-scroll">
        <div className="gifmaker-title">New Folder</div>

        <div className="rpanel-card">
          <button type="button" className="rpanel-card-toggle" onClick={() => toggle("details")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            <span className="rpanel-card-toggle-label">Folder Details</span>
            <svg className={`rpanel-card-chevron ${openSections.details ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          {openSections.details && (
            <div className="rpanel-card-body">
              <div className="axiom-field">
                <label className="axiom-field-label">Name</label>
                <input
                  type="text"
                  className="axiom-field-input"
                  placeholder="e.g. Marketing Assets"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
            </div>
          )}
        </div>

        <div className="rpanel-card">
          <button type="button" className="rpanel-card-toggle" onClick={() => toggle("items")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
            <span className="rpanel-card-toggle-label">Selected Items</span>
            {selectedItems.size > 0 && <span className="rpanel-tag">{selectedItems.size}</span>}
            <svg className={`rpanel-card-chevron ${openSections.items ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          {openSections.items && (
            <div
              className={`rpanel-card-body folder-drop-zone ${dropOver ? "folder-drop-zone--active" : ""}`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              {entries.length > 0 ? (
                <div className="folder-asset-list">
                  {entries.map(([id, meta]) => (
                    <div key={id} className="folder-asset-row folder-asset-row--removable" onClick={() => onToggleItem(id)}>
                      {isMediaUrl(meta.thumb) && isVideoUrl(meta.thumb) ? (
                        <div className="folder-asset-thumb folder-asset-thumb--video">
                          <video src={meta.thumb} muted preload="metadata" />
                          <svg className="folder-asset-thumb-play" width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="8,5 20,12 8,19" /></svg>
                        </div>
                      ) : isMediaUrl(meta.thumb) ? (
                        <img className="folder-asset-thumb" src={meta.thumb} alt={meta.name} style={{ objectFit: "cover" }} />
                      ) : (
                        <div className="folder-asset-thumb" style={{ background: meta.thumb || "linear-gradient(135deg, #333, #555)" }} />
                      )}
                      <span className="folder-asset-name">{meta.name}</span>
                      <button type="button" className="folder-asset-remove" onClick={(e) => { e.stopPropagation(); onToggleItem(id); }}>
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="folder-empty-state">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <polyline points="21 15 16 10 5 21" />
                  </svg>
                  <span>Click items in the library to select them, or drag images from the canvas here</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="rpanel-footer">
        <button
          type="button"
          className={`rpanel-action-btn ${!canSave ? "rpanel-action-btn--disabled" : ""}`}
          disabled={!canSave || saving}
          onClick={handleCreate}
        >
          {saving ? "Creating..." : "Create Folder"}
        </button>
      </div>
    </aside>
  );
}
