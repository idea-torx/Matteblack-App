import { useCallback, useEffect, useRef, useState } from "react";
import "./LeftToolbar.css";
import "./SkillsPanel.css";

/**
 * Skills — the user's library of reusable generation recipes, stored as plain
 * markdown under <dataDir>/skills. Claude reads them (list_skills / get_skill)
 * to follow a recipe instead of improvising, and writes them back (save_skill)
 * when a run is worth repeating, so this panel and the agent share one library.
 *
 * Full-width panel: skills read as files, so they're shown as a grid of file
 * cards. Reviewing and editing one happens in a modal over the grid, which
 * keeps the list in view and gives the markdown room to breathe.
 */
type SkillMeta = {
  slug: string; title: string; description: string; updatedAt: string; bytes: number;
  /** Section this files under — from `label:` in the frontmatter, else read off
   *  the skill's own words by the server. System skills override it. */
  label?: string;
  /** First lines of the body, shown on the card face. */
  preview?: string;
  /** Ships with the app (e.g. the operator's own system prompt). Editable like
   *  any other skill, but resettable to the shipped text. */
  system?: boolean;
};

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

/** Read the `label:` line out of the frontmatter, if there is one. */
function labelOf(body: string): string {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body);
  return fm ? (/^label:\s*(.*)$/m.exec(fm[1])?.[1] ?? "").trim().replace(/^["']|["']$/g, "") : "";
}

/** Set or clear `label:` in the frontmatter, adding a header if the file has
 *  none. The server reads the same line, so this is the whole marking. */
function withLabel(body: string, label: string): string {
  const fm = /^(---\r?\n)([\s\S]*?)(\r?\n---)/.exec(body);
  if (!fm) return label ? `---\nlabel: ${label}\n---\n\n${body}` : body;
  const lines = fm[2].split(/\r?\n/).filter((l) => !/^label:/.test(l.trim()));
  if (label) lines.push(`label: ${label}`);
  return `${fm[1]}${lines.join("\n")}${fm[3]}${body.slice(fm[0].length)}`;
}

function relativeDate(iso: string): string {
  const d = new Date(iso).getTime();
  if (!Number.isFinite(d)) return "";
  const mins = Math.round((Date.now() - d) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Sections, in the order they read. Anything the server labels with something
 *  else lands in "Creative" — the panel never hides a skill it can't place.
 *  "Your Skills" is never inferred: it is the `label:` the user sets by hand
 *  from the editor. */
const USER_LABEL = "Your Skills";
const SECTIONS = ["System", USER_LABEL, "Video", "Image", "Writing", "Creative"] as const;

const SORTS = {
  recent: { label: "Newest", cmp: (a: SkillMeta, b: SkillMeta) => b.updatedAt.localeCompare(a.updatedAt) },
  oldest: { label: "Oldest", cmp: (a: SkillMeta, b: SkillMeta) => a.updatedAt.localeCompare(b.updatedAt) },
  name: { label: "A–Z", cmp: (a: SkillMeta, b: SkillMeta) => a.title.localeCompare(b.title) },
  size: { label: "Largest", cmp: (a: SkillMeta, b: SkillMeta) => b.bytes - a.bytes },
} as const;
type SortKey = keyof typeof SORTS;

function sectionOf(s: SkillMeta): string {
  if (s.system) return "System";
  return SECTIONS.includes(s.label as (typeof SECTIONS)[number]) ? (s.label as string) : "Creative";
}

/** The file glyph on every card. Dog-eared page, ruled lines. */
function FileIcon({ system }: { system?: boolean }) {
  return (
    <svg className={`skills-file${system ? " skills-file--system" : ""}`} width="40" height="48" viewBox="0 0 40 48" fill="none" aria-hidden="true">
      <path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H25l11 11v30.5a2.5 2.5 0 0 1-2.5 2.5h-27A2.5 2.5 0 0 1 4 43.5z" fill="currentColor" fillOpacity="0.08" stroke="currentColor" strokeWidth="1.5" />
      <path d="M25 2v9a2 2 0 0 0 2 2h9" stroke="currentColor" strokeWidth="1.5" />
      <line x1="11" y1="24" x2="29" y2="24" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="11" y1="30" x2="29" y2="30" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="11" y1="36" x2="23" y2="36" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function SkillsPanel({ onClose, onUseSkill }: {
  onClose: () => void;
  /** Hand a skill to the agent panel as a ready-to-send instruction. */
  onUseSkill?: (slug: string, title: string) => void;
}) {
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Open modal: null = grid only. `slug` is empty for an unsaved new skill.
  const [editing, setEditing] = useState<{ slug: string; body: string; dirty: boolean; system?: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [sort, setSort] = useState<SortKey>("recent");
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/skills", { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { skills?: SkillMeta[] };
      setSkills(data.skills ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // The agent writes skills too (save_skill), so the list can go stale while
  // the panel is open. Refresh on focus rather than polling.
  useEffect(() => {
    const onFocus = () => { if (!editing) void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh, editing]);

  const closeModal = useCallback(() => {
    setEditing((cur) => (cur?.dirty && !window.confirm("Discard unsaved changes?") ? cur : null));
  }, []);

  // Esc closes the modal, not the panel behind it.
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); closeModal(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [editing, closeModal]);

  const open = useCallback(async (slug: string) => {
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(slug)}`, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { body?: string; system?: boolean };
      setEditing({ slug, body: data.body ?? "", dirty: false, system: data.system });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const save = useCallback(async () => {
    if (!editing) return;
    // A new skill takes its slug from its own title line, so the user never has
    // to name the file separately.
    const slug = editing.slug || slugFrom(editing.body, "untitled-skill");
    setSaving(true);
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(slug)}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: editing.body }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setEditing({ ...editing, slug, dirty: false });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [editing, refresh]);

  const reset = useCallback(async (slug: string) => {
    if (!window.confirm(`Restore "${slug}" to the version Fal Forge ships? Your edits are lost.`)) return;
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(slug)}/reset`, { method: "POST", credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { body?: string };
      setEditing({ slug, body: data.body ?? "", dirty: false, system: true });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [refresh]);

  // Import existing markdown. Anthropic-style skills are a folder holding
  // SKILL.md, so a generic filename falls back to the doc's own title.
  const importFiles = useCallback(async (files: FileList | File[]) => {
    const md = Array.from(files).filter((f) => /\.(md|markdown|txt)$/i.test(f.name));
    if (!md.length) { setError("Only .md files can be imported."); return; }
    setImporting(true);
    try {
      for (const f of md) {
        const body = await f.text();
        const base = f.name.replace(/\.[^.]+$/, "");
        const slug = slugFrom(/^(?:skill|index|readme)$/i.test(base) ? body : base, base);
        const res = await fetch(`/api/skills/${encodeURIComponent(slug)}`, {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body }),
        });
        if (!res.ok) throw new Error(`${f.name}: HTTP ${res.status}`);
      }
      setError(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }, [refresh]);

  const remove = useCallback(async (slug: string) => {
    if (!slug || !window.confirm(`Delete the "${slug}" skill? This removes the markdown file.`)) return;
    try {
      await fetch(`/api/skills/${encodeURIComponent(slug)}`, { method: "DELETE", credentials: "include" });
      setEditing(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [refresh]);

  return (
    <aside className="sidebar sidebar--wide">
      <div className="sidebar-panel-header">
        <span className="sidebar-panel-title">Skills</span>
        <div className="skills-header-actions">
          <select
            className="skills-sort"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            aria-label="Sort skills"
            title="Sort"
          >
            {(Object.keys(SORTS) as SortKey[]).map((k) => (
              <option key={k} value={k}>{SORTS[k].label}</option>
            ))}
          </select>
          <button type="button" className="skills-link" disabled={importing} onClick={() => fileInputRef.current?.click()}>
            {importing ? "Importing…" : "Import"}
          </button>
          <button type="button" className="skills-link" onClick={() => setEditing({ slug: "", body: NEW_SKILL_TEMPLATE, dirty: true })}>
            New
          </button>
          <button type="button" className="sidebar-panel-close" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      <div
        className="sidebar-scroll"
        onDragOver={(e) => { e.preventDefault(); }}
        onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files.length) void importFiles(e.dataTransfer.files); }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".md,.markdown,.txt,text/markdown"
          multiple
          hidden
          onChange={(e) => { if (e.target.files?.length) void importFiles(e.target.files); e.target.value = ""; }}
        />
        {error && <div className="skills-error">{error}</div>}
        {loading ? (
          <div className="skills-empty">Loading…</div>
        ) : skills.length === 0 ? (
          <div className="skills-empty">
            No skills yet.
            <span className="skills-empty-hint">
              Write one with New, drop in existing .md files, or tell the agent to “save that as a skill” after a run you liked.
            </span>
          </div>
        ) : (
          SECTIONS.filter((section) => skills.some((s) => sectionOf(s) === section)).map((section) => (
            <section key={section} className="skills-section">
              <h3 className="skills-section-title">
                {section}
                <span className="skills-section-count">{skills.filter((s) => sectionOf(s) === section).length}</span>
              </h3>
              <div className="skills-grid">
                {skills.filter((s) => sectionOf(s) === section).sort(SORTS[sort].cmp).map((s) => (
                  <div key={s.slug} className="skills-card">
                    <div className="skills-card-head">
                      <span className="skills-card-title" title={s.description || s.title}>{s.title}</span>
                      {sectionOf(s) === USER_LABEL && <span className="skills-card-tag">User skill</span>}
                      <span className="skills-card-date">{relativeDate(s.updatedAt)}</span>
                    </div>
                    <button
                      type="button"
                      className="skills-card-preview"
                      onClick={() => void open(s.slug)}
                      title={s.description || `Open ${s.title}`}
                    >
                      <span className="skills-card-preview-text">{s.preview || s.description}</span>
                    </button>
                    <div className="skills-card-actions">
                      <button type="button" className="skills-card-action" onClick={() => void open(s.slug)}>
                        Edit
                      </button>
                      {onUseSkill && (
                        <button
                          type="button"
                          className="skills-card-action skills-card-action--inject"
                          onClick={() => onUseSkill(s.slug, s.title)}
                          title="Hand this skill to the agent"
                        >
                          Inject
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))
        )}
      </div>

      {editing && (
        <div className="skills-modal" role="dialog" aria-modal="true" aria-label="Skill">
          <div className="skills-modal__backdrop" onClick={closeModal} />
          <div className="skills-modal__panel">
            <div className="skills-modal__header">
              <FileIcon system={editing.system} />
              <div className="skills-modal__heading">
                <span className="skills-modal__title">
                  {editing.slug || "New skill"}
                  {editing.system && <span className="skills-badge">System</span>}
                </span>
                <span className="skills-modal__sub">
                  {editing.system
                    ? "Ships with Fal Forge. Your edits apply immediately; reset restores the original."
                    : "Markdown on disk — the agent reads exactly this."}
                </span>
              </div>
              <button type="button" className="sidebar-panel-close" onClick={closeModal} aria-label="Close">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            <textarea
              className="skills-editor"
              value={editing.body}
              spellCheck={false}
              autoFocus
              onChange={(e) => setEditing({ ...editing, body: e.target.value, dirty: true })}
              placeholder="# My skill&#10;&#10;Write the recipe in markdown…"
            />

            <div className="skills-editor-footer">
              {!editing.system && (
                <label className="skills-usertag-toggle">
                  <input
                    type="checkbox"
                    checked={labelOf(editing.body) === USER_LABEL}
                    onChange={(e) => setEditing({
                      ...editing,
                      body: withLabel(editing.body, e.target.checked ? USER_LABEL : ""),
                      dirty: true,
                    })}
                  />
                  User skill
                </label>
              )}
              {editing.slug && (editing.system ? (
                <button type="button" className="skills-btn" onClick={() => void reset(editing.slug)}>
                  Reset to default
                </button>
              ) : (
                <button type="button" className="skills-btn skills-btn--danger" onClick={() => void remove(editing.slug)}>
                  Delete
                </button>
              ))}
              {editing.slug && onUseSkill && (
                <button type="button" className="skills-btn" onClick={() => { onUseSkill(editing.slug, editing.slug); setEditing(null); }}>
                  Use with agent
                </button>
              )}
              <button type="button" className="skills-btn skills-btn--primary" disabled={saving || !editing.dirty} onClick={() => void save()}>
                {saving ? "Saving…" : editing.dirty ? "Save" : "Saved"}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
