import { useCallback, useEffect, useState } from "react";
import "./SkillEditorPanel.css";

/**
 * The skill editor — a right aside beside the library, not a modal, so the list
 * stays in view while a skill is being worked on. Details edits the frontmatter
 * through the PUT `meta` merge (no hand-written YAML), Body is the markdown the
 * agent actually reads, Publish pushes it to the shared registry.
 */
export type SkillDetail = {
  slug: string; title: string; description: string; kind: SkillKind; tags: string[];
  cover?: string; examples: string[]; version: string; author?: string; source?: string;
  visibility: "private" | "public"; body: string; system?: boolean; pinned?: boolean;
};
export type SkillKind = "system" | "general" | "script" | "workflow";

export const KINDS: Array<{ value: SkillKind; label: string }> = [
  { value: "script", label: "Script" },
  { value: "general", label: "General" },
  { value: "workflow", label: "Workflow (bot)" },
  { value: "system", label: "System" },
];

type Asset = { id: string; name: string; type: string; file_url: string };

const NEW_SKILL_TEMPLATE = `---
name: Untitled skill
description: One line on what this produces.
---

# Untitled skill

## When to use
Describe the request that should trigger this.

## Prompts
Write the exact prompt text to use, not a paraphrase.

## Settings
model / aspect / tier / duration that this recipe depends on.
`;

/** Slug from the skill's own title line, so a file is never named twice. */
function slugFrom(body: string, fallback: string): string {
  const title = /^(?:name|title):\s*(.+)$/mi.exec(body)?.[1]
    || /^#\s+(.+)$/m.exec(body)?.[1]
    || fallback;
  return title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64)
    || "untitled-skill";
}

/** One thumbnail grid over the user's canvas assets. Same fetch the library
 *  panel uses; the picked value is the asset's file_url. */
function AssetPicker({ selected, multiple, onPick }: {
  selected: string[];
  multiple?: boolean;
  onPick: (url: string) => void;
}) {
  const [assets, setAssets] = useState<Asset[] | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        const [img, vid] = await Promise.all([
          fetch("/api/assets?type=image", { credentials: "include" }).then((r) => r.json()),
          fetch("/api/assets?type=video", { credentials: "include" }).then((r) => r.json()),
        ]);
        setAssets([...(img.assets ?? []), ...(vid.assets ?? [])].slice(0, 60));
      } catch { setAssets([]); }
    })();
  }, []);
  if (!assets) return <div className="skilled-hint">Loading assets…</div>;
  if (!assets.length) return <div className="skilled-hint">No canvas assets yet.</div>;
  return (
    <div className="skilled-assets" role="listbox" aria-multiselectable={multiple}>
      {assets.map((a) => (
        <button
          key={a.id}
          type="button"
          role="option"
          aria-selected={selected.includes(a.file_url)}
          className={`skilled-asset${selected.includes(a.file_url) ? " is-picked" : ""}`}
          title={a.name}
          onClick={() => onPick(a.file_url)}
        >
          {a.type === "video"
            ? <video src={a.file_url} muted preload="metadata" />
            : <img src={a.file_url} alt="" loading="lazy" />}
        </button>
      ))}
    </div>
  );
}

/** Chosen media as tiles; the asset grid only appears when adding. */
function MediaField({ label, values, multiple, onChange }: {
  label: string;
  values: string[];
  multiple?: boolean;
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const isVideo = (u: string) => /\.(mp4|webm|mov)(\?|$)/i.test(u);
  return (
    <div className="skilled-field">
      <span>{label}</span>
      <div className="skilled-tiles">
        {values.map((u) => (
          <div key={u} className="skilled-tile">
            {isVideo(u) ? <video src={u} muted preload="metadata" /> : <img src={u} alt="" loading="lazy" />}
            <button type="button" className="skilled-tile-x" aria-label="Remove" onClick={() => onChange(values.filter((x) => x !== u))}>×</button>
          </div>
        ))}
        {(multiple || !values.length) && (
          <button type="button" className={`skilled-tile skilled-tile--add${open ? " is-open" : ""}`} onClick={() => setOpen(!open)}>
            {open ? "Done" : multiple ? "+ Add" : "+ Choose"}
          </button>
        )}
      </div>
      {open && (
        <AssetPicker
          multiple={multiple}
          selected={values}
          onPick={(url) => {
            if (!multiple) { onChange([url]); setOpen(false); return; }
            onChange(values.includes(url) ? values.filter((x) => x !== url) : [...values, url]);
          }}
        />
      )}
    </div>
  );
}

export function SkillEditorPanel({ slug, onClose, onSaved, onDeleted, onUseSkill }: {
  /** "" opens a blank new skill. */
  slug: string;
  onClose: () => void;
  onSaved: (slug: string) => void;
  onDeleted: () => void;
  onUseSkill?: (slug: string, title: string) => void;
}) {
  const [tab, setTab] = useState<"details" | "body" | "publish">("details");
  const [skill, setSkill] = useState<SkillDetail | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [tagDraft, setTagDraft] = useState("");
  const [versions, setVersions] = useState<string[]>([]);

  const patch = useCallback((p: Partial<SkillDetail>) => {
    setSkill((cur) => (cur ? { ...cur, ...p } : cur));
    setDirty(true);
  }, []);

  useEffect(() => {
    setTab("details"); setError(""); setNote(""); setDirty(false);
    if (!slug) {
      setSkill({
        slug: "", title: "Untitled skill", description: "", kind: "general", tags: [],
        examples: [], version: "1", visibility: "private", body: NEW_SKILL_TEMPLATE,
      });
      setDirty(true);
      setVersions([]);
      return;
    }
    void (async () => {
      try {
        const res = await fetch(`/api/skills/${encodeURIComponent(slug)}`, { credentials: "include" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setSkill((await res.json()) as SkillDetail);
        const h = await fetch(`/api/skills/${encodeURIComponent(slug)}/history`, { credentials: "include" });
        setVersions(h.ok ? ((await h.json()) as { versions?: string[] }).versions ?? [] : []);
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    })();
  }, [slug]);

  const close = useCallback(() => {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    onClose();
  }, [dirty, onClose]);

  const save = useCallback(async () => {
    if (!skill) return;
    const target = skill.slug || slugFrom(skill.body, "untitled-skill");
    setBusy(true); setError("");
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(target)}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: skill.body,
          meta: {
            name: skill.title, description: skill.description, kind: skill.kind, tags: skill.tags,
            cover: skill.cover ?? "", examples: skill.examples, version: skill.version,
            author: skill.author ?? "", visibility: skill.visibility,
          },
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSkill({ ...skill, slug: target });
      setDirty(false);
      onSaved(target);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }, [skill, onSaved]);

  const act = useCallback(async (path: string, body?: unknown) => {
    setBusy(true); setError("");
    try {
      const res = await fetch(path, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as Record<string, unknown>;
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); return null; }
    finally { setBusy(false); }
  }, []);

  if (!skill) {
    return (
      <div className="skilled">
        <div className="skilled-head"><span className="skilled-title">Skill</span></div>
        <div className="skilled-hint">{error || "Loading…"}</div>
      </div>
    );
  }

  const s = skill;
  const addTag = (raw: string) => {
    const t = raw.trim().replace(/,+$/, "");
    if (t && !s.tags.includes(t)) patch({ tags: [...s.tags, t] });
    setTagDraft("");
  };

  return (
    <div className="skilled" aria-label="Skill editor">
      <div className="skilled-head">
        <span className="skilled-title" title={s.slug}>{s.slug || "New skill"}</span>
        {s.system && <span className="skilled-badge">System</span>}
        {s.source && <span className="skilled-badge">Installed</span>}
        <button type="button" className="sidebar-panel-close" onClick={close} aria-label="Close editor">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="skilled-tabs">
        {(["details", "body", "publish"] as const).map((t) => (
          <button key={t} type="button" className={`skilled-tab${tab === t ? " is-active" : ""}`} onClick={() => setTab(t)}>
            {t === "details" ? "Details" : t === "body" ? "Body" : "Publish"}
          </button>
        ))}
      </div>

      {error && <div className="skills-error">{error}</div>}
      {note && <div className="skilled-note">{note}</div>}

      <div className="skilled-scroll">
        {tab === "details" && (
          <>
            <label className="skilled-field">
              <span>Title</span>
              <input value={s.title} onChange={(e) => patch({ title: e.target.value })} />
            </label>
            <label className="skilled-field">
              <span>Description</span>
              <textarea rows={3} value={s.description} onChange={(e) => patch({ description: e.target.value })} />
            </label>
            <label className="skilled-field">
              <span>Kind</span>
              <select value={s.kind} onChange={(e) => patch({ kind: e.target.value as SkillKind })}>
                {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
              </select>
            </label>
            <div className="skilled-field">
              <span>Tags</span>
              <div className="skilled-tagbox">
                {s.tags.map((t) => (
                  <button key={t} type="button" className="skilled-tag" onClick={() => patch({ tags: s.tags.filter((x) => x !== t) })} title="Remove">
                    {t} ×
                  </button>
                ))}
                <input
                  value={tagDraft}
                  placeholder="Add tag"
                  onChange={(e) => (e.target.value.includes(",") ? addTag(e.target.value) : setTagDraft(e.target.value))}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(tagDraft); } }}
                  onBlur={() => addTag(tagDraft)}
                />
              </div>
            </div>
            <MediaField label="Cover" values={s.cover ? [s.cover] : []} onChange={(v) => patch({ cover: v[0] ?? "" })} />
            <MediaField label="Examples" multiple values={s.examples} onChange={(v) => patch({ examples: v })} />
          </>
        )}

        {tab === "body" && (
          <>
            <textarea
              className="skilled-body"
              spellCheck={false}
              value={s.body}
              onChange={(e) => { setSkill({ ...s, body: e.target.value }); setDirty(true); }}
              placeholder="# My skill&#10;&#10;Write the recipe in markdown…"
            />
            <div className="skilled-row">
              {s.slug && (
                <button
                  type="button"
                  className="skills-btn"
                  disabled={busy}
                  onClick={async () => {
                    const r = await act(`/api/skills/${encodeURIComponent(s.slug)}/pin`, { pinned: !s.pinned });
                    if (r) { setSkill({ ...s, pinned: r.pinned === true }); setNote(r.pinned ? "Pinned — rides along with every run." : "Unpinned."); }
                  }}
                >
                  {s.pinned ? "Unpin" : "Pin"}
                </button>
              )}
              {s.system && (
                <button
                  type="button"
                  className="skills-btn"
                  disabled={busy}
                  onClick={async () => {
                    if (!window.confirm(`Restore "${s.slug}" to the version Fal Forge ships? Your edits are lost.`)) return;
                    const r = await act(`/api/skills/${encodeURIComponent(s.slug)}/reset`);
                    if (r) { setSkill({ ...s, body: String(r.body ?? "") }); setDirty(false); onSaved(s.slug); }
                  }}
                >
                  Reset to default
                </button>
              )}
            </div>
            {versions.length > 0 && (
              <div className="skilled-field">
                <span>History</span>
                <select
                  value=""
                  onChange={async (e) => {
                    const v = e.target.value;
                    if (!v || !window.confirm("Restore this version? The current text is versioned first.")) return;
                    const r = await act(`/api/skills/${encodeURIComponent(s.slug)}/restore`, { version: v });
                    if (r) { setSkill({ ...s, body: String(r.body ?? "") }); setDirty(false); onSaved(s.slug); }
                  }}
                >
                  <option value="">Restore a previous version…</option>
                  {versions.map((v) => <option key={v} value={v}>{v.replace(/T/, " ").slice(0, 19)}</option>)}
                </select>
              </div>
            )}
          </>
        )}

        {tab === "publish" && (
          <>
            <label className="skilled-field">
              <span>Version</span>
              <input value={s.version} onChange={(e) => patch({ version: e.target.value })} />
            </label>
            <label className="skilled-field">
              <span>Author</span>
              <input value={s.author ?? ""} onChange={(e) => patch({ author: e.target.value })} />
            </label>
            <label className="skilled-check">
              <input
                type="checkbox"
                checked={s.visibility === "public"}
                onChange={(e) => patch({ visibility: e.target.checked ? "public" : "private" })}
              />
              Public — listed in the shared registry for anyone to install
            </label>
            <div className="skilled-row">
              <button
                type="button"
                className="skills-btn"
                disabled={busy || !s.slug || dirty}
                title={dirty ? "Save first" : "Push this skill to the registry"}
                onClick={async () => {
                  const r = await act(`/api/skills/${encodeURIComponent(s.slug)}/publish`);
                  if (r) setNote(r.published ? `Published v${s.version} to the registry.` : `Saved to the registry as private (v${s.version}).`);
                }}
              >
                Publish
              </button>
              <button
                type="button"
                className="skills-btn"
                onClick={() => {
                  const url = URL.createObjectURL(new Blob([s.body], { type: "text/markdown" }));
                  const a = document.createElement("a");
                  a.href = url; a.download = `${s.slug || "skill"}.md`; a.click();
                  URL.revokeObjectURL(url);
                }}
              >
                Export .md
              </button>
            </div>
            <div className="skilled-hint">Skills are free to install. Nothing here charges anyone.</div>
          </>
        )}
      </div>

      <div className="skilled-foot">
        {!s.system && s.slug && (
          <button
            type="button"
            className="skills-btn skills-btn--danger"
            disabled={busy}
            style={{ marginRight: "auto" }}
            onClick={async () => {
              if (!window.confirm(`Delete the "${s.slug}" skill? This removes the markdown file.`)) return;
              await fetch(`/api/skills/${encodeURIComponent(s.slug)}`, { method: "DELETE", credentials: "include" });
              onDeleted();
            }}
          >
            Delete
          </button>
        )}
        {s.slug && onUseSkill && (
          <button type="button" className="skills-btn" onClick={() => onUseSkill(s.slug, s.title)}>Use skill</button>
        )}
        <button type="button" className="skills-btn skills-btn--primary" disabled={busy || !dirty} onClick={() => void save()}>
          {busy ? "Saving…" : dirty ? "Save" : "Saved"}
        </button>
      </div>
    </div>
  );
}
