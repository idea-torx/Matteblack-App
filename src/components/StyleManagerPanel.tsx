import { useState, useCallback, useEffect, useRef } from "react";
import { useWorkspace } from "../contexts/WorkspaceContext";
import { invalidate } from "../services/AssetCache";
import "./RightPanel.css";
import "./AxiomCreatorPanel.css";

interface StyleManagerPanelProps {
  onClose: () => void;
  styleId: string;
  onDeleted?: () => void;
  onSaved?: () => void;
}

type BucketItem = { id: string; name: string };

export function StyleManagerPanel({ onClose, styleId, onDeleted, onSaved }: StyleManagerPanelProps) {
  const { activeWorkspace } = useWorkspace();
  const isOrg = activeWorkspace?.type === "org";

  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [newImageFile, setNewImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [buckets, setBuckets] = useState<BucketItem[]>([]);
  const [bucketId, setBucketId] = useState<string | null>(null);
  const [newBucket, setNewBucket] = useState("");
  const [creatingBucket, setCreatingBucket] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    image: true,
    details: true,
    bucket: true,
    danger: false,
  });
  const previewUrl = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    };
  }, []);

  useEffect(() => {
    fetch(`/api/styles/${styleId}`, { credentials: "include" })
      .then((r) => { if (!r.ok) throw new Error("Failed to fetch"); return r.json(); })
      .then((d) => {
        if (d.style) {
          setName(d.style.name || "");
          setPrompt(d.style.prompt || "");
          setImageUrl(d.style.image_url || null);
          setImagePreview(d.style.image_url || null);
          setBucketId(d.style.bucket_id || null);
        } else {
          setLoadError(true);
        }
      })
      .catch(() => { setLoadError(true); })
      .finally(() => setLoading(false));
  }, [styleId]);

  useEffect(() => {
    const params = new URLSearchParams({ type: "style" });
    if (isOrg && activeWorkspace?.id) {
      params.set("scope", "org");
      params.set("workspace_id", activeWorkspace.id);
    }
    fetch(`/api/buckets?${params}`, { credentials: "include" })
      .then((r) => r.json())
      .then((d) => setBuckets(d.buckets || []))
      .catch(() => setBuckets([]));
  }, [isOrg, activeWorkspace?.id]);

  const toggle = (key: string) =>
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));

  const handleImageUpload = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
      const preview = URL.createObjectURL(file);
      previewUrl.current = preview;
      setNewImageFile(file);
      setImagePreview(preview);
    };
    input.click();
  }, []);

  const handleClearImage = useCallback(() => {
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = null;
    setNewImageFile(null);
    setImagePreview(null);
    setImageUrl(null);
  }, []);

  const handleCreateBucket = useCallback(async () => {
    if (!newBucket.trim()) return;
    try {
      const body: any = { name: newBucket.trim(), type: "style" };
      if (isOrg && activeWorkspace?.id) {
        body.scope = "org";
        body.workspace_id = activeWorkspace.id;
      }
      const res = await fetch("/api/buckets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json();
        const created = data.bucket;
        setBuckets((prev) => [...prev, created]);
        setBucketId(created.id);
        setCreatingBucket(false);
        setNewBucket("");
        invalidate("buckets:");
      }
    } catch {}
  }, [newBucket, isOrg, activeWorkspace?.id]);

  const handleSave = useCallback(async () => {
    if (!name.trim() || !prompt.trim()) return;
    setSaving(true);
    try {
      let finalImageUrl = imageUrl;
      if (newImageFile) {
        const fd = new FormData();
        fd.append("file", newImageFile);
        const uploadRes = await fetch("/api/styles/upload-image", {
          method: "POST",
          credentials: "include",
          body: fd,
        });
        if (uploadRes.ok) {
          const uploadData = await uploadRes.json();
          finalImageUrl = uploadData.url;
        } else {
          setSaving(false);
          return;
        }
      }

      const body: any = {
        name: name.trim(),
        prompt,
        image_url: finalImageUrl,
        bucket_id: bucketId,
      };
      const res = await fetch(`/api/styles/${styleId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (res.ok) {
        invalidate("styles");
        onSaved?.();
        onClose();
      }
    } catch {}
    setSaving(false);
  }, [name, prompt, imageUrl, newImageFile, bucketId, styleId, onSaved, onClose]);

  const handleDelete = useCallback(async () => {
    try {
      const res = await fetch(`/api/styles/${styleId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.ok) {
        invalidate("styles");
        onDeleted?.();
        onClose();
      }
    } catch {}
  }, [styleId, onDeleted, onClose]);

  const canSave = name.trim().length > 0 && prompt.trim().length > 0;

  if (loading || loadError) {
    return (
      <aside className="rpanel axiom-creator-overlay">
        <button type="button" className="gifmaker-close" onClick={onClose}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
        <div className="rpanel-scroll">
          <div className="gifmaker-title">Manage Prompt</div>
          <div style={{ padding: "2rem", textAlign: "center", color: "rgba(255,255,255,0.4)" }}>
            {loadError ? "Prompt not found or access denied" : "Loading..."}
          </div>
        </div>
      </aside>
    );
  }

  return (
    <aside className="rpanel axiom-creator-overlay">
      <button type="button" className="gifmaker-close" onClick={onClose}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>

      <div className="rpanel-scroll">
        <div className="gifmaker-title">Manage Prompt</div>

        <div className="rpanel-card">
          <button type="button" className="rpanel-card-toggle" onClick={() => toggle("image")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
            <span className="rpanel-card-toggle-label">Reference Image</span>
            {!openSections.image && imagePreview && <span className="rpanel-tag">Added</span>}
            <svg className={`rpanel-card-chevron ${openSections.image ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          {openSections.image && (
            <div className="rpanel-card-body">
              <div className="style-image-slot">
                {imagePreview ? (
                  <>
                    <div className="style-image-preview" style={{ backgroundImage: `url(${imagePreview})` }} />
                    <button type="button" className="axiom-image-clear" onClick={handleClearImage}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                    </button>
                  </>
                ) : (
                  <button type="button" className="axiom-image-upload" onClick={handleImageUpload}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    <span>Upload image</span>
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="rpanel-card">
          <button type="button" className="rpanel-card-toggle" onClick={() => toggle("details")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            <span className="rpanel-card-toggle-label">Details</span>
            <svg className={`rpanel-card-chevron ${openSections.details ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          {openSections.details && (
            <div className="rpanel-card-body">
              <div className="axiom-field">
                <label className="axiom-field-label">Name</label>
                <input
                  type="text"
                  className="axiom-field-input"
                  placeholder="e.g. Neon Noir"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="axiom-field">
                <label className="axiom-field-label">Prompt</label>
                <textarea
                  className="axiom-field-textarea"
                  placeholder="The prompt text applied when dragging to canvas..."
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={4}
                />
              </div>
            </div>
          )}
        </div>

        <div className="rpanel-card">
          <button type="button" className="rpanel-card-toggle" onClick={() => toggle("bucket")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            <span className="rpanel-card-toggle-label">Bucket</span>
            {!openSections.bucket && bucketId && <span className="rpanel-tag">{buckets.find((b) => b.id === bucketId)?.name}</span>}
            <svg className={`rpanel-card-chevron ${openSections.bucket ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          {openSections.bucket && (
            <div className="rpanel-card-body">
              <div className="axiom-bucket-list">
                {buckets.map((b) => (
                  <button key={b.id} type="button" className={`axiom-bucket-btn ${bucketId === b.id && !creatingBucket ? "axiom-bucket-btn--active" : ""}`} onClick={() => { setBucketId(b.id); setCreatingBucket(false); }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
                    {b.name}
                  </button>
                ))}
                {buckets.length === 0 && !creatingBucket && (
                  <span className="axiom-bucket-empty">No buckets yet</span>
                )}
              </div>
              <div className="axiom-bucket-create">
                {creatingBucket ? (
                  <div className="axiom-bucket-new">
                    <input className="axiom-field-input" placeholder="New bucket name" value={newBucket} onChange={(e) => setNewBucket(e.target.value)} autoFocus onKeyDown={(e) => { if (e.key === "Enter") handleCreateBucket(); }} />
                    <div className="axiom-bucket-new-actions">
                      <button type="button" className="axiom-btn-ghost" onClick={() => { setCreatingBucket(false); setNewBucket(""); }}>Cancel</button>
                      <button type="button" className="axiom-btn-accent" onClick={handleCreateBucket}>Create</button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className="axiom-bucket-add" onClick={() => { setCreatingBucket(true); setBucketId(null); }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                    Create New Bucket
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="rpanel-card">
          <button type="button" className="rpanel-card-toggle" onClick={() => toggle("danger")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <span className="rpanel-card-toggle-label">Danger Zone</span>
            <svg className={`rpanel-card-chevron ${openSections.danger ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          {openSections.danger && (
            <div className="rpanel-card-body">
              <p className="folder-mgr-danger-text">Deleting this style is permanent and cannot be undone.</p>
              <button type="button" className="folder-mgr-delete-btn" onClick={handleDelete}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                Delete Style
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="rpanel-footer">
        <button type="button" className={`rpanel-action-btn ${!canSave ? "rpanel-action-btn--disabled" : ""}`} disabled={!canSave || saving} onClick={handleSave}>
          {saving ? "Saving..." : "Save Changes"}
        </button>
      </div>
    </aside>
  );
}
