import { useState, useEffect, useCallback } from "react";
import "./RightPanel.css";
import "./AxiomCreatorPanel.css";
import { useWorkspace } from "../contexts/WorkspaceContext";

interface BucketManagerPanelProps {
  onClose: () => void;
  context: "axioms" | "styles";
}

type Bucket = {
  id: string;
  name: string;
  item_count?: number;
};

export function BucketManagerPanel({ onClose, context }: BucketManagerPanelProps) {
  const bucketType = context === "axioms" ? "axiom" : "style";
  const label = context === "axioms" ? "Product" : "Style";
  const { activeWorkspace } = useWorkspace();

  const isOrg = activeWorkspace?.type === "org";
  const workspaceId = activeWorkspace?.id;

  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [saving, setSaving] = useState(false);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    buckets: true,
  });

  const fetchBuckets = useCallback(async () => {
    setLoading(true);
    try {
      let url = `/api/buckets?type=${bucketType}`;
      if (isOrg && workspaceId) {
        url += `&scope=org&workspace_id=${workspaceId}`;
      }
      const res = await fetch(url, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setBuckets(data.buckets || []);
      }
    } catch {}
    setLoading(false);
  }, [bucketType, isOrg, workspaceId]);

  useEffect(() => {
    fetchBuckets();
  }, [fetchBuckets]);

  const toggle = (key: string) =>
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));

  const startEdit = (bucket: Bucket) => {
    setEditingId(bucket.id);
    setEditName(bucket.name);
  };

  const saveEdit = async () => {
    if (!editingId || !editName.trim()) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/buckets/${editingId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: editName.trim() }),
      });
      if (res.ok) {
        const data = await res.json();
        setBuckets((prev) => prev.map((b) => b.id === editingId ? { ...b, name: data.bucket.name } : b));
        setEditingId(null);
        setEditName("");
      }
    } catch {}
    setSaving(false);
  };

  const deleteBucket = async (id: string) => {
    try {
      const res = await fetch(`/api/buckets/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.ok) {
        setBuckets((prev) => prev.filter((b) => b.id !== id));
        if (editingId === id) setEditingId(null);
      }
    } catch {}
  };

  const createBucket = async () => {
    if (!newName.trim()) return;
    setSaving(true);
    try {
      const body: Record<string, string> = { name: newName.trim(), type: bucketType };
      if (isOrg && workspaceId) {
        body.scope = "org";
        body.workspace_id = workspaceId;
      }
      const res = await fetch("/api/buckets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json();
        setBuckets((prev) => [...prev, data.bucket]);
        setNewName("");
        setCreating(false);
      }
    } catch {}
    setSaving(false);
  };

  return (
    <aside className="rpanel axiom-creator-overlay">
      <button type="button" className="gifmaker-close" onClick={onClose}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>

      <div className="rpanel-scroll">
        <div className="gifmaker-title">{label} Buckets</div>

        <div className="rpanel-card">
          <button type="button" className="rpanel-card-toggle" onClick={() => toggle("buckets")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            <span className="rpanel-card-toggle-label">All Buckets</span>
            <span className="rpanel-tag">{buckets.length}</span>
            <svg className={`rpanel-card-chevron ${openSections.buckets ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          {openSections.buckets && (
            <div className="rpanel-card-body">
              {loading ? (
                <div className="folder-empty-state"><span>Loading buckets...</span></div>
              ) : (
                <div className="bucket-list">
                  {buckets.map((b) => (
                    <div key={b.id} className="bucket-row">
                      {editingId === b.id ? (
                        <div className="bucket-edit">
                          <input
                            className="axiom-field-input"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            autoFocus
                            onKeyDown={(e) => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") setEditingId(null); }}
                          />
                          <div className="axiom-bucket-new-actions">
                            <button type="button" className="axiom-btn-ghost" onClick={() => setEditingId(null)}>Cancel</button>
                            <button type="button" className="axiom-btn-accent" disabled={saving} onClick={saveEdit}>{saving ? "Saving..." : "Save"}</button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="bucket-row-icon"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
                          <div className="bucket-row-info">
                            <span className="bucket-row-name">{b.name}</span>
                          </div>
                          <button type="button" className="bucket-row-action" onClick={() => startEdit(b)} title="Rename">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                            </svg>
                          </button>
                          <button type="button" className="bucket-row-action bucket-row-action--danger" onClick={() => deleteBucket(b.id)} title="Delete">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                            </svg>
                          </button>
                        </>
                      )}
                    </div>
                  ))}
                  {buckets.length === 0 && !loading && (
                    <div className="folder-empty-state"><span>No buckets yet</span></div>
                  )}
                </div>
              )}

              <div className="axiom-bucket-create">
                {creating ? (
                  <div className="axiom-bucket-new">
                    <input
                      className="axiom-field-input"
                      placeholder="New bucket name"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      autoFocus
                      onKeyDown={(e) => { if (e.key === "Enter") createBucket(); if (e.key === "Escape") { setCreating(false); setNewName(""); } }}
                    />
                    <div className="axiom-bucket-new-actions">
                      <button type="button" className="axiom-btn-ghost" onClick={() => { setCreating(false); setNewName(""); }}>Cancel</button>
                      <button type="button" className="axiom-btn-accent" disabled={saving} onClick={createBucket}>{saving ? "Creating..." : "Create"}</button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className="axiom-bucket-add" onClick={() => setCreating(true)}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                    Create New Bucket
                  </button>
                )}
              </div>
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
