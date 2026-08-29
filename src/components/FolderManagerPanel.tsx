import { useState, useCallback, useEffect, useRef } from "react";
import "./RightPanel.css";
import "./AxiomCreatorPanel.css";

interface FolderManagerPanelProps {
  onClose: () => void;
  folderName: string;
  folderId?: string;
  folderType?: string;
  mediaContext?: string;
  pendingItems?: Map<string, { name: string; thumb: string }>;
  onClearPendingItem?: (id: string) => void;
}

type FolderItem = {
  id: string;
  name: string;
  file_url?: string;
  type: string;
};

function isMediaUrl(s?: string) {
  return s && (s.startsWith("http") || s.startsWith("/") || s.startsWith("data:"));
}

function isVideoUrl(s?: string) {
  return s ? /\.(mp4|webm|mov|ogg)(\?|$)/i.test(s) : false;
}

export function FolderManagerPanel({ onClose, folderName, folderId, folderType = "image", mediaContext, pendingItems, onClearPendingItem }: FolderManagerPanelProps) {
  const isAudio = ["music", "voice", "sound_effect"].includes(folderType);
  const [name, setName] = useState(folderName);
  const [items, setItems] = useState<FolderItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [dropOver, setDropOver] = useState(false);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    details: true,
    items: true,
    danger: false,
  });

  useEffect(() => {
    if (!folderId) return;
    setLoading(true);
    let endpoint: string;
    let itemsKey: string;
    if (isAudio) {
      endpoint = `/api/audio?folder_id=${folderId}`;
      itemsKey = "audio";
    } else {
      const typeFilter = mediaContext ? `&type=${mediaContext}` : "";
      endpoint = `/api/assets?folder_id=${folderId}${typeFilter}`;
      itemsKey = "assets";
    }
    fetch(endpoint, { credentials: "include" })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error("Failed")))
      .then((data) => setItems(data[itemsKey] || []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [folderId, isAudio, mediaContext]);

  const toggle = (key: string) =>
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));

  const handleRename = useCallback(async () => {
    if (!folderId || !name.trim()) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/folders/${folderId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: name.trim() }),
      });
      if (res.ok) {
        setIsRenaming(false);
      }
    } catch {}
    setSaving(false);
  }, [folderId, name]);

  const handleDelete = useCallback(async () => {
    if (!folderId) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/folders/${folderId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.ok) {
        onClose();
      }
    } catch {}
    setDeleting(false);
  }, [folderId, onClose]);

  const removeItem = useCallback(async (id: string) => {
    try {
      const endpoint = isAudio ? `/api/audio/${id}/folder` : `/api/assets/${id}/folder`;
      const res = await fetch(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ folder_id: null }),
      });
      if (res.ok) {
        setItems((prev) => prev.filter((i) => i.id !== id));
      }
    } catch {}
  }, [isAudio]);

  const addItemToFolder = useCallback(async (itemId: string, itemName: string, fileUrl?: string) => {
    if (!folderId) return;
    try {
      const endpoint = isAudio ? `/api/audio/${itemId}/folder` : `/api/assets/${itemId}/folder`;
      const res = await fetch(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ folder_id: folderId }),
      });
      if (res.ok) {
        setItems((prev) => {
          if (prev.some((i) => i.id === itemId)) return prev;
          return [...prev, { id: itemId, name: itemName, file_url: fileUrl, type: folderType }];
        });
      }
    } catch {}
  }, [folderId, isAudio, folderType]);

  const processedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!pendingItems || !folderId) return;
    pendingItems.forEach((meta, id) => {
      if (processedRef.current.has(id) || items.some((i) => i.id === id)) {
        onClearPendingItem?.(id);
        return;
      }
      processedRef.current.add(id);
      addItemToFolder(id, meta.name, meta.thumb).then(() => {
        onClearPendingItem?.(id);
      });
    });
  }, [pendingItems, folderId, items, addItemToFolder, onClearPendingItem]);

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
        addItemToFolder(data.id, data.label, data.gradient);
      } catch {}
      return;
    }

    const libData = e.dataTransfer.getData("application/x-library-asset");
    if (libData) {
      try {
        const data = JSON.parse(libData);
        addItemToFolder(data.id, data.label, data.gradient);
      } catch {}
    }
  }, [addItemToFolder]);

  return (
    <aside className="rpanel axiom-creator-overlay">
      <button type="button" className="gifmaker-close" onClick={onClose}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>

      <div className="rpanel-scroll">
        <div className="gifmaker-title">Manage Folder</div>

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
              {isRenaming ? (
                <div className="axiom-field">
                  <label className="axiom-field-label">Name</label>
                  <input
                    type="text"
                    className="axiom-field-input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoFocus
                    onKeyDown={(e) => { if (e.key === "Enter") handleRename(); if (e.key === "Escape") { setName(folderName); setIsRenaming(false); } }}
                  />
                  <div className="axiom-bucket-new-actions" style={{ marginTop: 6 }}>
                    <button type="button" className="axiom-btn-ghost" onClick={() => { setName(folderName); setIsRenaming(false); }}>Cancel</button>
                    <button type="button" className="axiom-btn-accent" disabled={saving} onClick={handleRename}>{saving ? "Saving..." : "Save"}</button>
                  </div>
                </div>
              ) : (
                <div className="folder-mgr-detail-row">
                  <div className="folder-mgr-detail-info">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
                    <div>
                      <div className="folder-mgr-name">{name}</div>
                      <div className="folder-mgr-meta">{items.length} {items.length === 1 ? "item" : "items"}</div>
                    </div>
                  </div>
                  <button type="button" className="folder-mgr-rename-btn" onClick={() => setIsRenaming(true)}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                    Rename
                  </button>
                </div>
              )}
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
            <span className="rpanel-card-toggle-label">Items</span>
            <span className="rpanel-tag">{items.length}</span>
            <svg className={`rpanel-card-chevron ${openSections.items ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          {openSections.items && (
            <div
              className={`rpanel-card-body folder-drop-zone ${dropOver ? "folder-drop-zone--active" : ""}`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              {loading ? (
                <div className="folder-empty-state">
                  <span>Loading items...</span>
                </div>
              ) : items.length > 0 ? (
                <div className="folder-asset-list">
                  {items.map((item) => (
                    <div key={item.id} className="folder-asset-row folder-asset-row--removable">
                      {isMediaUrl(item.file_url) && isVideoUrl(item.file_url) ? (
                        <div className="folder-asset-thumb folder-asset-thumb--video">
                          <video src={item.file_url} muted preload="metadata" />
                          <svg className="folder-asset-thumb-play" width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="8,5 20,12 8,19" /></svg>
                        </div>
                      ) : isMediaUrl(item.file_url) ? (
                        <img className="folder-asset-thumb" src={item.file_url} alt={item.name} style={{ objectFit: "cover" }} />
                      ) : (
                        <div className="folder-asset-thumb" style={{ background: "linear-gradient(135deg, #444, #666)" }} />
                      )}
                      <span className="folder-asset-name">{item.name}</span>
                      <span className="folder-asset-type">{item.type}</span>
                      <button type="button" className="folder-asset-remove" style={{ opacity: 1 }} onClick={() => removeItem(item.id)} title="Remove from folder">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="folder-empty-state" style={{ marginTop: items.length > 0 ? 8 : 0 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                <span>{items.length > 0 ? "Drag more items here to add" : "Drag items from the library here to add them"}</span>
              </div>
            </div>
          )}
        </div>

        <div className="rpanel-card">
          <button type="button" className="rpanel-card-toggle" onClick={() => toggle("danger")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <span className="rpanel-card-toggle-label">Danger Zone</span>
            <svg className={`rpanel-card-chevron ${openSections.danger ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          {openSections.danger && (
            <div className="rpanel-card-body">
              <p className="folder-mgr-danger-text">Deleting this folder will move all items back to Unfiled. This action cannot be undone.</p>
              <button type="button" className="folder-mgr-delete-btn" disabled={deleting} onClick={handleDelete}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
                {deleting ? "Deleting..." : "Delete Folder"}
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="rpanel-footer">
        <button type="button" className="rpanel-action-btn" onClick={onClose}>
          Done
        </button>
      </div>
    </aside>
  );
}
