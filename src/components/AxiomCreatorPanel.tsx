import { useState, useCallback, useEffect, useRef } from "react";
import { useWorkspace } from "../contexts/WorkspaceContext";
import { invalidate } from "../services/AssetCache";
import "./RightPanel.css";
import "./AxiomCreatorPanel.css";

interface AxiomCreatorPanelProps {
  onClose: () => void;
  onCreated?: () => void;
}

type BucketItem = { id: string; name: string };
type ImageSlot = { file: File; preview: string } | null;

export function AxiomCreatorPanel({ onClose, onCreated }: AxiomCreatorPanelProps) {
  const { activeWorkspace } = useWorkspace();
  const isOrg = activeWorkspace?.type === "org";

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [buckets, setBuckets] = useState<BucketItem[]>([]);
  const [bucketId, setBucketId] = useState<string | null>(null);
  const [newBucket, setNewBucket] = useState("");
  const [creatingBucket, setCreatingBucket] = useState(false);
  const [images, setImages] = useState<ImageSlot[]>([null, null, null, null]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    images: true,
    details: true,
    bucket: true,
  });
  const previewUrls = useRef<string[]>([]);

  useEffect(() => {
    return () => {
      previewUrls.current.forEach((u) => URL.revokeObjectURL(u));
    };
  }, []);

  useEffect(() => {
    const params = new URLSearchParams({ type: "axiom" });
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

  const handleImageUpload = useCallback((index: number) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const preview = URL.createObjectURL(file);
      previewUrls.current.push(preview);
      setImages((prev) => {
        const next = [...prev];
        next[index] = { file, preview };
        return next;
      });
    };
    input.click();
  }, []);

  const handleClearImage = useCallback((index: number) => {
    setImages((prev) => {
      const next = [...prev];
      const slot = next[index];
      if (slot) URL.revokeObjectURL(slot.preview);
      next[index] = null;
      return next;
    });
  }, []);

  const handleCreateBucket = useCallback(async () => {
    if (!newBucket.trim()) return;
    try {
      const body: any = { name: newBucket.trim(), type: "axiom" };
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

  const extractError = async (res: Response, fallback: string): Promise<string> => {
    try {
      const data = await res.json();
      const msg = data?.error?.message || data?.error || data?.message;
      if (typeof msg === "string" && msg.trim()) return msg;
    } catch {}
    return fallback;
  };

  const uploadImage = async (file: File): Promise<{ url: string | null; error?: string }> => {
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await fetch("/api/axioms/upload-image", {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      if (res.ok) {
        const data = await res.json();
        return { url: data.url };
      }
      return { url: null, error: await extractError(res, "Image upload failed") };
    } catch {
      return { url: null, error: "Network error while uploading image" };
    }
  };

  const handleSave = useCallback(async () => {
    const filledSlots = images.filter(Boolean) as { file: File; preview: string }[];
    if (!name.trim() || filledSlots.length !== 4) return;
    setSaving(true);
    setSaveError(null);
    try {
      const uploaded = await Promise.all(filledSlots.map((s) => uploadImage(s.file)));
      const failed = uploaded.find((u) => !u.url);
      if (failed) {
        setSaveError(failed.error || "Failed to upload one or more images");
        setSaving(false);
        return;
      }
      const urls = uploaded.map((u) => u.url!);

      const body: any = {
        name: name.trim(),
        description,
        images: urls,
        bucket_id: bucketId,
      };
      if (isOrg && activeWorkspace?.id) {
        body.scope = "org";
        body.workspace_id = activeWorkspace.id;
      }
      const res = await fetch("/api/axioms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (res.ok) {
        invalidate("axioms");
        onCreated?.();
        onClose();
        return;
      }
      const fallback =
        res.status === 403
          ? "You don't have permission to create products in this workspace."
          : res.status === 400
          ? "Couldn't save product. Please check the bucket and try again."
          : "Failed to save product. Please try again.";
      setSaveError(await extractError(res, fallback));
    } catch {
      setSaveError("Network error. Please check your connection and try again.");
    }
    setSaving(false);
  }, [name, description, images, bucketId, isOrg, activeWorkspace?.id, onCreated, onClose]);

  const filledCount = images.filter(Boolean).length;
  const canSave = name.trim().length > 0 && filledCount === 4;

  return (
    <aside className="rpanel axiom-creator-overlay">
      <button type="button" className="gifmaker-close" onClick={onClose}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>

      <div className="rpanel-scroll">
        <div className="gifmaker-title">New Product</div>

        <div className="rpanel-card">
          <button type="button" className="rpanel-card-toggle" onClick={() => toggle("images")}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
            <span className="rpanel-card-toggle-label">Images</span>
            {!openSections.images && <span className="rpanel-tag">{filledCount}/4</span>}
            <svg className={`rpanel-card-chevron ${openSections.images ? "rpanel-card-chevron--open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          {openSections.images && (
            <div className="rpanel-card-body">
              <div className="axiom-image-grid">
                {images.map((slot, i) => (
                  <div key={i} className="axiom-image-slot">
                    {slot ? (
                      <>
                        <div className="axiom-image-preview" style={{ backgroundImage: `url(${slot.preview})` }} />
                        <button type="button" className="axiom-image-clear" onClick={() => handleClearImage(i)}>
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                        </button>
                      </>
                    ) : (
                      <button type="button" className="axiom-image-upload" onClick={() => handleImageUpload(i)}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="12" y1="5" x2="12" y2="19" />
                          <line x1="5" y1="12" x2="19" y2="12" />
                        </svg>
                        <span>Image {i + 1}</span>
                      </button>
                    )}
                  </div>
                ))}
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
                <input type="text" className="axiom-field-input" placeholder="e.g. Warrior Set" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="axiom-field">
                <label className="axiom-field-label">Description</label>
                <textarea className="axiom-field-textarea" placeholder="Describe this product..." value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
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
        {saveError && (
          <div className="axiom-save-error" role="alert" style={{ color: "#f87171", fontSize: "12px", marginBottom: "8px", lineHeight: 1.4 }}>
            {saveError}
          </div>
        )}
        <button type="button" className={`rpanel-action-btn ${!canSave ? "rpanel-action-btn--disabled" : ""}`} disabled={!canSave || saving} onClick={handleSave}>
          {saving ? "Uploading..." : "Save Product"}
        </button>
      </div>
    </aside>
  );
}
