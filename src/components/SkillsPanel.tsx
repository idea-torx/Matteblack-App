import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import "./LeftToolbar.css";
import "./SkillsPanel.css";
import { SkillEditorPanel, KINDS, type SkillKind } from "./SkillEditorPanel";

/**
 * Skills — the user's library of reusable generation recipes, stored as plain
 * markdown under <dataDir>/skills. Claude reads them (list_skills / get_skill)
 * to follow a recipe instead of improvising, and writes them back (save_skill)
 * when a run is worth repeating, so this panel and the agent share one library.
 *
 * Full-width library: script skills read as cover cards (they produce pictures),
 * everything else as dense rows. Editing happens in the right aside so the list
 * never leaves the screen.
 */
type SkillMeta = {
  slug: string; title: string; description: string; updatedAt: string; bytes: number;
  label?: string; preview?: string;
  /** Ships with the app. Editable like any other skill, but resettable. */
  system?: boolean;
  kind: SkillKind;
  tags: string[];
  cover?: string;
  examples: string[];
  version: string;
  source?: string;
  uses?: number;
  lastUsed?: string;
  pinned?: boolean;
};

type RegistryItem = {
  id: string; name: string; slug: string; description: string | null;
  thumbnail_url: string | null; preview_urls: string[]; tags: string[];
  metadata?: { kind?: string; version?: string; author?: string };
};

function relativeDate(iso: string): string {
  const d = new Date(iso).getTime();
  if (!Number.isFinite(d)) return "";
  const mins = Math.round((Date.now() - d) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const SORTS = {
  recent: { label: "Recent", cmp: (a: SkillMeta, b: SkillMeta) => b.updatedAt.localeCompare(a.updatedAt) },
  used: { label: "Most used", cmp: (a: SkillMeta, b: SkillMeta) => (b.uses ?? 0) - (a.uses ?? 0) },
  name: { label: "Name", cmp: (a: SkillMeta, b: SkillMeta) => a.title.localeCompare(b.title) },
} as const;
type SortKey = keyof typeof SORTS;

/** Slug from the skill's own title line, so an import never names a file twice. */
function slugFrom(body: string, fallback: string): string {
  const title = /^(?:name|title):\s*(.+)$/mi.exec(body)?.[1]
    || /^#\s+(.+)$/m.exec(body)?.[1]
    || fallback;
  return title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64)
    || "untitled-skill";
}

const KIND_LABEL: Record<SkillKind, string> = {
  system: "System", general: "General", script: "Script", workflow: "Workflow",
};

const KIND_ICON: Record<SkillKind, JSX.Element> = {
  // script: clapperboard · general: book · workflow: repeat arrows · system: gear
  script: <><path d="M4 8h16v12H4z" /><path d="M4 8l2-4h12l2 4" /><path d="M8 4l2 4M14 4l2 4" /></>,
  general: <><path d="M4 4h12a3 3 0 0 1 3 3v13H7a3 3 0 0 1-3-3z" /><path d="M4 17a3 3 0 0 1 3-3h12" /></>,
  workflow: <><path d="M17 2l4 4-4 4" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><path d="M7 22l-4-4 4-4" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></>,
  system: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
};
const kindIcon = (k: SkillKind, size = 14) => (
  <svg className={`skills-kind-icon skills-card--${k}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {KIND_ICON[k]}
  </svg>
);

export function SkillsPanel({ onClose, onUseSkill }: {
  onClose: () => void;
  /** Hand a skill to the agent panel as a ready-to-send instruction. */
  onUseSkill?: (slug: string, title: string) => void;
}) {
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [registry, setRegistry] = useState<RegistryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<"mine" | "installed" | "registry">("mine");
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<SkillKind | "">("");
  const [tagFilter, setTagFilter] = useState("");
  const [sort, setSort] = useState<SortKey>("recent");
  const [importing, setImporting] = useState(false);
  /** null = library only; "" = a new unsaved skill. */
  const [editing, setEditing] = useState<string | null>(null);
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
    const onFocus = () => { if (editing === null) void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh, editing]);

  // The registry is a server search, so it re-runs on the query.
  useEffect(() => {
    if (scope !== "registry") return;
    void (async () => {
      try {
        const res = await fetch(`/api/platform-library?type=skill&search=${encodeURIComponent(query)}`, { credentials: "include" });
        const data = (await res.json()) as { items?: RegistryItem[] };
        setRegistry(data.items ?? []);
      } catch { setRegistry([]); }
    })();
  }, [scope, query]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return skills
      .filter((s) => (scope === "installed" ? !!s.source : true))
      .filter((s) => (kindFilter ? s.kind === kindFilter : true))
      .filter((s) => (tagFilter ? s.tags.includes(tagFilter) : true))
      .filter((s) => !q || `${s.title} ${s.description} ${s.tags.join(" ")}`.toLowerCase().includes(q))
      .sort(SORTS[sort].cmp);
  }, [skills, scope, kindFilter, tagFilter, query, sort]);

  const tags = useMemo(() => [...new Set(skills.flatMap((s) => s.tags))].sort(), [skills]);
  const installedSlugs = useMemo(() => new Map(skills.map((s) => [s.slug, s])), [skills]);

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

  const install = useCallback(async (item: RegistryItem) => {
    try {
      const res = await fetch("/api/skills/install", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: item.id }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [refresh]);

  const useBtn = (s: SkillMeta) => onUseSkill && (
    <button
      type="button"
      className="skills-card-action skills-card-action--inject"
      onClick={(e) => { e.stopPropagation(); onUseSkill(s.slug, s.title); }}
      title="Hand this skill to the agent"
    >
      Use skill
    </button>
  );

  const togglePin = async (s: SkillMeta) => {
    await fetch(`/api/skills/${encodeURIComponent(s.slug)}/pin`, {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pinned: !s.pinned }),
    });
    await refresh();
  };

  const card = (s: SkillMeta) => {
    const media = s.cover || s.examples[0];
    return (
      <div key={s.slug} className={`skills-card skills-card--${s.kind}`} onClick={() => setEditing(s.slug)} role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter") setEditing(s.slug); }}>
        {media && (
          <div className="skills-cover">
            {/\.(mp4|webm|mov)(\?|$)/i.test(media)
              ? <video src={media} muted preload="metadata" />
              : <img src={media} alt="" loading="lazy" />}
          </div>
        )}
        <div className="skills-card-head">
          {kindIcon(s.kind, 16)}
          <span className="skills-card-title">{s.title}</span>
          {s.system ? <span className="skills-badge">Built-in</span>
            : s.source ? <span className="skills-badge">Installed</span> : null}
          <button
            type="button"
            className={`skills-pin${s.pinned ? " is-pinned" : ""}`}
            title={s.pinned ? "Unpin" : "Pin — rides along with every run"}
            aria-pressed={!!s.pinned}
            onClick={(e) => { e.stopPropagation(); void togglePin(s); }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill={s.pinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 17v5" /><path d="M9 3h6l-1 7 3 3H7l3-3z" />
            </svg>
          </button>
        </div>
        <div className="skills-card-desc">{s.description}</div>
        <div className="skills-card-meta">
          <span className="skills-tag skills-tag--kind">{KIND_LABEL[s.kind]}</span>
          {s.tags.map((t) => <span key={t} className="skills-tag">{t}</span>)}
          <span className="skills-card-date">{s.uses ?? 0} uses · {relativeDate(s.updatedAt)}</span>
          {useBtn(s)}
        </div>
      </div>
    );
  };

  return (
    <aside className="sidebar sidebar--wide skills-library">
      <div className="sidebar-panel-header">
        <span className="sidebar-panel-title">Skills</span>
        <input
          className="skills-search"
          value={query}
          placeholder="Search skills…"
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search skills"
        />
        <div className="skills-scopes" role="tablist">
          {(["mine", "installed", "registry"] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={scope === v}
              className={`skills-scope${scope === v ? " is-active" : ""}`}
              onClick={() => setScope(v)}
            >
              {v === "mine" ? "Mine" : v === "installed" ? "Installed" : "Registry"}
            </button>
          ))}
        </div>
        <div className="skills-header-actions">
          {scope !== "registry" && (
            <select className="skills-sort" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort skills">
              {(Object.keys(SORTS) as SortKey[]).map((k) => <option key={k} value={k}>{SORTS[k].label}</option>)}
            </select>
          )}
          <button type="button" className="skills-link" disabled={importing} onClick={() => fileInputRef.current?.click()}>
            {importing ? "Importing…" : "Import"}
          </button>
          <button type="button" className="skills-link" onClick={() => setEditing("")}>New skill</button>
          <button type="button" className="sidebar-panel-close" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      <div className="skills-body">
        <div className="skills-filters">
          <div className="skills-filter-title">Kind</div>
          <button type="button" className={`skills-filter${kindFilter === "" ? " is-active" : ""}`} onClick={() => setKindFilter("")}>All</button>
          {KINDS.map((k) => (
            <button
              key={k.value}
              type="button"
              className={`skills-filter${kindFilter === k.value ? " is-active" : ""}`}
              onClick={() => setKindFilter(kindFilter === k.value ? "" : k.value)}
            >
              <span className="skills-filter-label">{kindIcon(k.value)}{KIND_LABEL[k.value]}</span>
              <span className="skills-filter-count">{skills.filter((s) => s.kind === k.value).length}</span>
            </button>
          ))}
          {tags.length > 0 && <div className="skills-filter-title">Tags</div>}
          <div className="skills-chips">
            {tags.map((t) => (
              <button
                key={t}
                type="button"
                className={`skills-chip${tagFilter === t ? " is-active" : ""}`}
                onClick={() => setTagFilter(tagFilter === t ? "" : t)}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        <div
          className="sidebar-scroll skills-main"
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

          {scope === "registry" ? (
            registry.length === 0 ? (
              <div className="skills-empty">
                Nothing published yet.
                <span className="skills-empty-hint">
                  The registry lists skills people have published. Publish one of yours from a skill’s Publish tab.
                </span>
              </div>
            ) : (
              <div className="skills-grid">
                {registry.map((item) => {
                  const local = installedSlugs.get(item.slug);
                  const state = !local ? "Install"
                    : local.version === String(item.metadata?.version ?? "1") ? "Installed" : "Update";
                  return (
                    <div key={item.id} className="skills-card">
                      <div className="skills-cover">
                        {item.thumbnail_url
                          ? <img src={item.thumbnail_url} alt="" loading="lazy" />
                          : <span className="skills-cover-placeholder">{item.name}</span>}
                      </div>
                      <div className="skills-card-title">{item.name}</div>
                      <div className="skills-card-desc">{item.description}</div>
                      <div className="skills-card-actions">
                        <button
                          type="button"
                          className="skills-card-action"
                          disabled={state === "Installed"}
                          onClick={() => void install(item)}
                        >
                          {state}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )
          ) : loading ? (
            <div className="skills-empty">Loading…</div>
          ) : visible.length === 0 ? (
            <div className="skills-empty">
              {scope === "installed" ? "No installed skills." : "No skills here."}
              <span className="skills-empty-hint">
                Write one with New skill, drop in existing .md files, or tell the agent to “save that as a skill” after a run you liked.
              </span>
            </div>
          ) : (
            [{ key: "pinned", label: "Pinned", items: visible.filter((s) => s.pinned) },
              ...KINDS.map((k) => ({ key: k.value, label: KIND_LABEL[k.value], items: visible.filter((s) => s.kind === k.value) }))]
              .filter((sec) => sec.items.length).map((sec) => (
              <section key={sec.key} className="skills-section">
                <h3 className="skills-section-title">{sec.label}</h3>
                <div className="skills-grid">{sec.items.map(card)}</div>
              </section>
            ))
          )}
        </div>

        {editing !== null && (
          <SkillEditorPanel
            slug={editing}
            onClose={() => setEditing(null)}
            onSaved={(slug) => { setEditing(slug); void refresh(); }}
            onDeleted={() => { setEditing(null); void refresh(); }}
            onUseSkill={onUseSkill}
          />
        )}
      </div>
    </aside>
  );
}
