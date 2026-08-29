import { useState, useCallback, useEffect, useRef } from "react";
import { useWorkspace } from "../contexts/WorkspaceContext";
import { invalidate } from "../services/AssetCache";
import "./RightPanel.css";
import "./AxiomCreatorPanel.css";

interface StyleCreatorPanelProps {
  onClose: () => void;
  onCreated?: () => void;
}

type BucketItem = { id: string; name: string };

export function StyleCreatorPanel({ onClose, onCreated }: StyleCreatorPanelProps) {
  const { activeWorkspace } = useWorkspace();
  const isOrg = activeWorkspace?.type === "org";

  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [buckets, setBuckets] = useState<BucketItem[]>([]);
  const [bucketId, setBucketId] = useState<string | null>(null);
  const [newBucket, setNewBucket] = useState("");
  const [creatingBucket, setCreatingBucket] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    image: true,
    details: true,
    bucket: true,
  });
  const previewUrl = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    };
  }, []);

  useEffect(() => {
    const params = new URLSearchParams({ type: "style" });
    if (isOrg && activeWorkspace?.id) {
      params.set("scope", "org");
      params.set("workspace_id", activeWorkspace.id);
    }
    fetch(`/api/buckets?${params}`, { credentials: "include" })
      .then((r) => r.json())
      .then((d) => {
        const list = d.buckets || [];
        setBuckets(list);
        if (list.length > 0) setBucketId(list[0].id);
      })
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
      setImageFile(file);
      setImagePreview(preview);
    };
    input.click();
  }, []);

  const handleClearImage = useCallback(() => {
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = null;
    setImageFile(null);
    setImagePreview(null);
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
    setError(null);
    try {
      let uploadedUrl: string | null = null;
      if (imageFile) {
        const fd = new FormData();
        fd.append("file", imageFile);
        const uploadRes = await fetch("/api/styles/upload-image", {
          method: "POST",
          credentials: "include",
          body: fd,
        });
        if (uploadRes.ok) {
          const uploadData = await uploadRes.json();
          uploadedUrl = uploadData.url;
        } else {
          const errData = await uploadRes.json().catch(() => null);
          setError(errData?.error?.message || "Failed to upload image");
          setSaving(false);
          return;
        }
      }

      const body: any = {
        name: name.trim(),
        prompt: prompt.trim(),
        image_url: uploadedUrl,
        bucket_id: bucketId,
      };
      if (isOrg && activeWorkspace?.id) {
        body.scope = "org";
        body.workspace_id = activeWorkspace.id;
      }
      const res = await fetch("/api/styles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (res.ok) {
        invalidate("styles");
        onCreated?.();
        onClose();
      } else {
        const errData = await res.json().catch(() => null);
        setError(errData?.error?.message || "Failed to save style");
      }
    } catch (e: any) {
      setError(e?.message || "Network error");
    }
    setSaving(false);
  }, [name, prompt, imageFile, bucketId, isOrg, activeWorkspace?.id, onCreated, onClose]);

  const canSave = name.trim().length > 0 && prompt.trim().length > 0;

  return (
    <aside className="rpanel axiom-creator-overlay">
      <button type="button" className="gifmaker-close" onClick={onClose}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>

      <div className="rpanel-scroll">
        <div className="gifmaker-title">New Style</div>

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
                  placeholder="Style prompt that will be applied when dragging to canvas..."
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
      </div>

      <div className="rpanel-footer">
        {error && <div style={{ color: "#ff6b6b", fontSize: 13, marginBottom: 8, textAlign: "center" }}>{error}</div>}
        <button type="button" className={`rpanel-action-btn ${!canSave ? "rpanel-action-btn--disabled" : ""}`} disabled={!canSave || saving} onClick={handleSave}>
          {saving ? "Saving..." : "Save Style"}
        </button>
      </div>
    </aside>
  );
}
