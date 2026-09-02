import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorkspace } from "../contexts/WorkspaceContext";
import { ColorPickerInput } from "./design/ColorPickerInput";
import { renderMarkdown } from "../utils/markdown";
import type { ReferenceImage } from "../types/canvas";
import "./BrandIQPanel.css";

type PaletteColor = { name?: string; hex: string };
type Typography = { display?: string; body?: string; mono?: string };

type ProfileData = {
  mission?: string;
  vision?: string;
  audience?: string;
  tone?: string;
  do?: string[];
  dont?: string[];
  palette?: PaletteColor[];
  typography?: Typography;
  urls?: string[];
};

type BrandAsset = {
  id: string; // link id
  asset_id: string;
  role: "logo_light" | "logo_dark" | "graphic" | "inspiration" | "document";
  doc_role?: string | null;
  extraction_status?: string | null;
  source_mime?: string | null;
  extracted_text_preview?: string | null;
  name: string;
  type: string;
  file_url: string;
  file_type?: string | null;
};

type CrawlEvidence = {
  ok: boolean;
  url: string;
  title?: string;
  description?: string;
  error?: string;
  fetched_at?: string;
};

type BrandProfile = {
  id: string;
  workspace_id: string;
  name: string;
  slug?: string;
  is_default?: boolean;
  archived_at?: string | null;
  tags?: string[];
  avatar_color?: string;
  data?: ProfileData;
  design_md?: string;
  design_md_url?: string | null;
  crawl_evidence?: Record<string, CrawlEvidence>;
  assets?: BrandAsset[];
  created_at?: string;
  updated_at?: string;
};

type Tab = "form" | "assets" | "docs" | "links" | "brief";

type Props = {
  onClose: () => void;
  activeProjectId: string | null;
  selectedImageIds?: string[];
  selectedNodeMeta?: Map<string, ReferenceImage>;
};

type CanvasReferencePayload = {
  url?: string;
  name?: string;
  width?: number;
  height?: number;
  aspect_ratio?: string;
  kind: "image" | "text" | "frame" | "other";
  text_content?: string;
};

const DEFAULT_PALETTE: PaletteColor[] = [
  { name: "Primary", hex: "var(--accent)" },
  { name: "Secondary", hex: "#0f172a" },
  { name: "Accent", hex: "#64748b" },
  { name: "Surface", hex: "#f5f5f7" },
];

const DEFAULT_AVATAR_COLOR = "var(--accent)";

// Render a compact line-by-line diff of two markdown strings. Lines only
// in `next` show as additions (green); lines only in `base` show as
// deletions (red); unchanged lines are dimmed. This is a cheap LCS-free
// diff that's sufficient for reviewing a synthesized brief — most edits
// are append/replace by section so a per-line set diff reads cleanly.
function DesignMdDiff({ base, next }: { base: string; next: string }) {
  const baseLines = base.split("\n");
  const nextLines = next.split("\n");
  const baseSet = new Set(baseLines);
  const nextSet = new Set(nextLines);
  const removed = baseLines.filter((l) => !nextSet.has(l));
  const added = nextLines.filter((l) => !baseSet.has(l));
  if (removed.length === 0 && added.length === 0) {
    return <div style={{ opacity: 0.6 }}>No changes vs current brief.</div>;
  }
  return (
    <div style={{ maxHeight: 220, overflow: "auto", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 10, lineHeight: 1.4 }}>
      {removed.map((l, i) => (
        <div key={`r${i}`} style={{ color: "#ffb3b3", whiteSpace: "pre-wrap" }}>− {l || " "}</div>
      ))}
      {added.map((l, i) => (
        <div key={`a${i}`} style={{ color: "#9be0b8", whiteSpace: "pre-wrap" }}>+ {l || " "}</div>
      ))}
    </div>
  );
}

function paletteSwatches(p?: PaletteColor[]): string[] {
  if (!p || p.length === 0) return ["var(--accent)", "#0f172a", "#64748b", "#f5f5f7"];
  return p.slice(0, 4).map((c) => c.hex);
}

function splitLines(s: string | undefined): string[] {
  return (s || "")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

export function BrandIQPanel({ onClose, activeProjectId, selectedImageIds, selectedNodeMeta }: Props) {
  const { activeWorkspace, workspaces, setActiveWorkspace } = useWorkspace();
  const wsId = activeWorkspace?.id || null;

  const [profiles, setProfiles] = useState<BrandProfile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  // The wide editor column is mounted only when a profile is "expanded"
  // (the user clicked its More-options chevron). Persisted in
  // sessionStorage keyed by workspace so closing/reopening the panel
  // doesn't auto-re-expand.
  const expandedStorageKey = wsId ? `brandiq.expanded.${wsId}` : null;
  const [expandedProfileId, setExpandedProfileIdState] = useState<string | null>(() => {
    if (typeof window === "undefined" || !expandedStorageKey) return null;
    try { return window.sessionStorage.getItem(expandedStorageKey) || null; } catch { return null; }
  });
  const setExpandedProfileId = useCallback((next: string | null) => {
    setExpandedProfileIdState(next);
    if (typeof window === "undefined" || !expandedStorageKey) return;
    try {
      if (next) window.sessionStorage.setItem(expandedStorageKey, next);
      else window.sessionStorage.removeItem(expandedStorageKey);
    } catch { /* ignore quota / privacy errors */ }
  }, [expandedStorageKey]);
  const [tab, setTab] = useState<Tab>("form");
  // Inline picker for "Analyze brand" — null = closed.
  const [showAnalyzePicker, setShowAnalyzePicker] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const lastChevronRef = useRef<HTMLButtonElement | null>(null);
  const [showBriefPreview, setShowBriefPreview] = useState(false);
  const [docRole, setDocRole] = useState<string>("general");
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<"updated" | "name">("updated");
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(false);
  const [proposedDesignMd, setProposedDesignMd] = useState<string | null>(null);
  const [baseDesignMd, setBaseDesignMd] = useState<string>("");
  // Pending proposal that still needs to be applied to draft.design_md.
  // Scoped to a specific profile id so cross-profile switches don't leak,
  // and consumed (set to null) on first apply so background polling
  // refreshes can't clobber subsequent user edits in the textarea.
  const pendingProposalRef = useRef<{ profileId: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);

  const [draft, setDraft] = useState<BrandProfile | null>(null);
  const [doText, setDoText] = useState("");
  const [dontText, setDontText] = useState("");
  const [projectDefaultId, setProjectDefaultId] = useState<string | null>(null);

  const logoLightInputRef = useRef<HTMLInputElement>(null);
  const logoDarkInputRef = useRef<HTMLInputElement>(null);
  const graphicInputRef = useRef<HTMLInputElement>(null);
  const docInputRef = useRef<HTMLInputElement>(null);
  const newUrlRef = useRef<HTMLInputElement>(null);

  const active = useMemo(
    () => profiles.find((p) => p.id === activeId) || null,
    [profiles, activeId],
  );

  // All tags across the loaded brands — the toolbar exposes them as
  // chips so users can narrow large lists down by tag in addition to
  // free-text search.
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const p of profiles) {
      for (const t of (p.tags || [])) {
        const v = t.trim();
        if (v) set.add(v);
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [profiles]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let out = profiles;
    if (q) {
      out = out.filter((p) =>
        p.name.toLowerCase().includes(q) ||
        (p.tags || []).some((t) => t.toLowerCase().includes(q))
      );
    }
    if (tagFilter) {
      out = out.filter((p) => (p.tags || []).includes(tagFilter));
    }
    // Sort: 'updated' uses updated_at desc (most recently edited
    // first); 'name' uses case-insensitive name asc. Default = updated
    // because spec calls out "last edited" as the primary scan order.
    const sorted = [...out];
    if (sortMode === "name") {
      sorted.sort((a, b) => a.name.localeCompare(b.name));
    } else {
      sorted.sort((a, b) => {
        const ta = a.updated_at ? Date.parse(a.updated_at) : 0;
        const tb = b.updated_at ? Date.parse(b.updated_at) : 0;
        return tb - ta;
      });
    }
    return sorted;
  }, [profiles, search, tagFilter, sortMode]);

  // Auto-clear flash messages.
  useEffect(() => {
    if (!info && !error) return;
    const t = setTimeout(() => {
      setInfo(null);
      setError(null);
    }, 4000);
    return () => clearTimeout(t);
  }, [info, error]);

  // Reload persisted expansion when the workspace changes — useState's
  // initializer only runs once, so without this the panel keeps showing
  // the previous workspace's expansion.
  useEffect(() => {
    if (typeof window === "undefined" || !expandedStorageKey) {
      setExpandedProfileIdState(null);
      return;
    }
    try {
      setExpandedProfileIdState(window.sessionStorage.getItem(expandedStorageKey) || null);
    } catch {
      setExpandedProfileIdState(null);
    }
  }, [expandedStorageKey]);

  // Esc collapses the editor first; if nothing is expanded, close the
  // panel. Also handle the analyze picker.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (showAnalyzePicker) { setShowAnalyzePicker(false); return; }
      if (expandedProfileId) {
        setExpandedProfileId(null);
        // Restore focus back to the chevron that opened the editor.
        const btn = lastChevronRef.current;
        if (btn) requestAnimationFrame(() => btn.focus());
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expandedProfileId, showAnalyzePicker, setExpandedProfileId, onClose]);

  // When the editor expands, move keyboard focus into it for a11y.
  useEffect(() => {
    if (!expandedProfileId) return;
    const node = editorRef.current;
    if (node) requestAnimationFrame(() => node.focus());
  }, [expandedProfileId]);

  // Load list on workspace change (or when the archive toggle flips).
  useEffect(() => {
    if (!wsId) {
      setProfiles([]);
      setActiveId(null);
      return;
    }
    let cancel = false;
    (async () => {
      setLoading(true);
      try {
        const qs = `workspace_id=${encodeURIComponent(wsId)}${showArchived ? "&include_archived=1" : ""}`;
        const r = await fetch(`/api/brand-iq?${qs}`, {
          credentials: "include",
        });
        if (!r.ok) {
          setError(`Failed to load brand profiles (${r.status})`);
          return;
        }
        const j = await r.json();
        if (cancel) return;
        const list: BrandProfile[] = Array.isArray(j.profiles) ? j.profiles : [];
        setProfiles(list);
        setActiveId((cur) => cur && list.some((p) => p.id === cur) ? cur : (list[0]?.id || null));
      } catch (e) {
        if (!cancel) setError(e instanceof Error ? e.message : "Network error");
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => { cancel = true; };
  }, [wsId, showArchived]);

  // Load active project's brand override.
  useEffect(() => {
    if (!activeProjectId) {
      setProjectDefaultId(null);
      return;
    }
    let cancel = false;
    (async () => {
      try {
        const r = await fetch(`/api/brand-iq/project/${encodeURIComponent(activeProjectId)}`, {
          credentials: "include",
        });
        if (!r.ok) return;
        const j = await r.json();
        if (cancel) return;
        setProjectDefaultId(j.brand_profile_id || null);
      } catch { /* ignore */ }
    })();
    return () => { cancel = true; };
  }, [activeProjectId]);

  // When active changes, reset draft and tab.
  useEffect(() => {
    if (active) {
      const data: ProfileData = active.data || {};
      const palette = (data.palette && data.palette.length > 0) ? data.palette : DEFAULT_PALETTE;
      setDraft({
        ...active,
        avatar_color: active.avatar_color || DEFAULT_AVATAR_COLOR,
        tags: active.tags || [],
        data: {
          mission: data.mission,
          vision: data.vision,
          audience: data.audience,
          tone: data.tone,
          do: data.do || [],
          dont: data.dont || [],
          palette,
          typography: data.typography || {},
          urls: data.urls || [],
        },
      });
      setDoText((data.do || []).join("\n"));
      setDontText((data.dont || []).join("\n"));
    } else {
      setDraft(null);
      setDoText("");
      setDontText("");
    }
    // Key on active?.id (not the whole `active` object) so URL-crawl
    // status polling — which updates `active.crawl_evidence` every 1.5s
    // and changes object identity — doesn't rebuild the draft and
    // silently clobber in-progress textarea edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id]);

  // After the active-change effect rebuilds draft from the persisted
  // profile (whose design_md is still empty until the user commits a
  // freshly-proposed brief), apply any pending proposal exactly once
  // so the brief tab actually shows the analysis output. Keyed on
  // `active` (object identity, not just id) so that analyzing INTO the
  // currently-active profile — where the id doesn't change but the
  // object does after refreshProfile — still triggers an apply. The
  // ref is consumed on first apply, so subsequent re-runs from URL
  // polling refreshes are harmless no-ops and never clobber user
  // edits. The profileId guard prevents cross-profile leakage.
  useEffect(() => {
    const pending = pendingProposalRef.current;
    if (!pending || !active || pending.profileId !== active.id) return;
    setDraft((prev) => prev ? { ...prev, design_md: pending.text } : prev);
    pendingProposalRef.current = null;
  }, [active]);

  const refreshProfile = async (id: string) => {
    try {
      const r = await fetch(`/api/brand-iq/${id}`, { credentials: "include" });
      if (!r.ok) return;
      const j = await r.json();
      if (j.profile) {
        setProfiles((prev) => prev.map((p) => (p.id === id ? (j.profile as BrandProfile) : p)));
      }
    } catch { /* ignore */ }
  };

  const refreshList = async () => {
    if (!wsId) return;
    try {
      const qs = `workspace_id=${encodeURIComponent(wsId)}${showArchived ? "&include_archived=1" : ""}`;
      const r = await fetch(`/api/brand-iq?${qs}`, {
        credentials: "include",
      });
      if (!r.ok) return;
      const j = await r.json();
      setProfiles(Array.isArray(j.profiles) ? j.profiles : []);
    } catch { /* ignore */ }
  };

  // Poll the active brand's crawl status while any URL is still pending,
  // so the URLs tab shows live progress without a manual refresh.
  useEffect(() => {
    if (!active) return;
    const evidence = active.crawl_evidence || {};
    const hasPending = Object.values(evidence).some((e) => (e as { state?: string }).state === "pending");
    if (!hasPending) return;
    let stopped = false;
    const tick = async () => {
      if (stopped || !active) return;
      try {
        const r = await fetch(`/api/brand-iq/${active.id}/urls/status`, { credentials: "include" });
        if (!r.ok) return;
        const j = await r.json();
        const evMap = (j.crawl_evidence || {}) as Record<string, CrawlEvidence>;
        setProfiles((prev) => prev.map((p) => p.id === active.id ? { ...p, crawl_evidence: evMap } : p));
      } catch { /* ignore */ }
    };
    const timer = window.setInterval(tick, 1500);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [active]);

  const handleCreate = async () => {
    if (!wsId) {
      setError("Pick a workspace first.");
      return;
    }
    const raw = typeof window !== "undefined"
      ? window.prompt("Name this brand", "")
      : "";
    if (raw === null) return;
    const name = raw.trim().slice(0, 120);
    if (!name) {
      setError("Brand name can't be empty.");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const r = await fetch(`/api/brand-iq`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({
          workspace_id: wsId,
          name,
          avatar_color: DEFAULT_AVATAR_COLOR,
        }),
      });
      // Defensive parse: dev-server proxy hiccups, redirected auth pages,
      // or stack-trace error pages can return HTML instead of JSON. Read
      // raw text first so we can surface a useful error either way.
      const ct = r.headers.get("content-type") || "";
      const raw = await r.text();
      let j: { profile?: { id: string }; error?: string } | null = null;
      if (ct.includes("application/json") && raw) {
        try { j = JSON.parse(raw); } catch { j = null; }
      }
      if (!r.ok) {
        // Log the raw payload so it's visible in the console for debugging
        // (the panel banner stays short and user-friendly).
        // eslint-disable-next-line no-console
        console.error("[brand-iq] create failed", { status: r.status, contentType: ct, body: raw.slice(0, 500) });
        if (j?.error) {
          setError(j.error);
        } else if (raw.trim().startsWith("<")) {
          setError(`Create failed (${r.status}). Server returned a non-JSON page — try refreshing or signing in again.`);
        } else {
          setError(`Create failed (${r.status}). ${raw.slice(0, 140) || ""}`);
        }
        return;
      }
      if (!j) {
        // 2xx but unparseable — extremely rare, but surface it instead of crashing.
        setError("Brand may have been created, but the server response could not be read. Refresh to confirm.");
        await refreshList();
        return;
      }
      await refreshList();
      if (j.profile?.id) setActiveId(j.profile.id);
      setTab("form");
      setInfo("Brand created.");
    } catch (e) {
      // Network-level failure (offline, CORS, DNS). The previous version
      // bubbled the raw "Failed to execute 'json' on 'Response'" message
      // here; that path is gone now since we always read text first.
      setError(e instanceof Error ? e.message : "Create failed");
    } finally {
      setCreating(false);
    }
  };

  const handleSave = async () => {
    if (!draft || !active) return;
    setBusy(true);
    setError(null);
    try {
      const data: ProfileData = {
        ...(draft.data || {}),
        do: splitLines(doText),
        dont: splitLines(dontText),
      };
      const r = await fetch(`/api/brand-iq/${active.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name,
          avatar_color: draft.avatar_color,
          tags: draft.tags || [],
          data,
        }),
      });
      const j = await r.json();
      if (!r.ok) {
        setError(j?.error || `Save failed (${r.status})`);
        return;
      }
      if (j.profile) {
        setProfiles((prev) => prev.map((p) => (p.id === active.id ? (j.profile as BrandProfile) : p)));
      }
      setInfo("Saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const handleSetWorkspaceDefault = async () => {
    if (!active) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/brand-iq/${active.id}/default`, {
        method: "POST",
        credentials: "include",
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j?.error || `Failed to set default (${r.status})`);
        return;
      }
      await refreshList();
      setInfo("Set as workspace default.");
    } finally {
      setBusy(false);
    }
  };

  const handleSetProjectDefault = async () => {
    if (!active || !activeProjectId) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/brand-iq/project/${encodeURIComponent(activeProjectId)}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand_profile_id: active.id }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j?.error || `Failed to pin to project (${r.status})`);
        return;
      }
      setProjectDefaultId(active.id);
      setInfo("Pinned to current project.");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!active) return;
    if (!confirm(`Archive brand "${active.name}"?`)) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/brand-iq/${active.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j?.error || `Delete failed (${r.status})`);
        return;
      }
      setActiveId(null);
      await refreshList();
      setInfo("Brand archived.");
    } finally {
      setBusy(false);
    }
  };

  // Permanent (hard) delete. Only offered when the brand is already
  // archived, since this removes the row + cascades through asset
  // links / project overrides / chat brand pointers. Two-step confirm
  // (the prompt requires re-typing the brand name) protects against
  // accidental destruction.
  const handleHardDelete = async () => {
    if (!active) return;
    const typed = prompt(
      `Permanently delete brand "${active.name}"?\n\nThis cannot be undone — assets uploaded for this brand will be removed from the library, project defaults pointing here will be cleared, and any chats pinned to it will lose their brand link.\n\nType the brand name to confirm:`
    );
    if (typed === null) return;
    if (typed.trim() !== active.name.trim()) {
      setError("Name did not match — permanent delete cancelled.");
      return;
    }
    setBusy(true);
    try {
      const r = await fetch(`/api/brand-iq/${active.id}?hard=1`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j?.error || `Delete failed (${r.status})`);
        return;
      }
      setActiveId(null);
      await refreshList();
      setInfo("Brand permanently deleted.");
    } finally {
      setBusy(false);
    }
  };

  const uploadAsset = async (file: File, role: BrandAsset["role"], docRole?: string) => {
    if (!active) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const isDoc = role === "document";
      if (!isDoc) fd.append("role", role);
      else fd.append("doc_role", (docRole || "general").slice(0, 60));
      const endpoint = isDoc ? "documents" : "assets";
      const r = await fetch(`/api/brand-iq/${active.id}/${endpoint}`, {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j?.error || `Upload failed (${r.status})`);
        return;
      }
      await refreshProfile(active.id);
      setInfo(`Uploaded ${role.replace("_", " ")}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  const detachAsset = async (linkId: string) => {
    if (!active) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/brand-iq/${active.id}/assets/${linkId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) {
        setError(`Detach failed (${r.status})`);
        return;
      }
      await refreshProfile(active.id);
    } finally {
      setBusy(false);
    }
  };

  const addUrl = async () => {
    const inp = newUrlRef.current;
    if (!inp || !active) return;
    const url = inp.value.trim();
    if (!url) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/brand-iq/${active.id}/urls`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: [url] }),
      });
      const j = await r.json();
      if (!r.ok) {
        setError(j?.error || `Crawl failed (${r.status})`);
        return;
      }
      inp.value = "";
      if (j.profile) {
        setProfiles((prev) => prev.map((p) => (p.id === active.id ? (j.profile as BrandProfile) : p)));
      }
      setInfo("Crawl started…");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Crawl failed");
    } finally {
      setBusy(false);
    }
  };

  const removeUrl = async (url: string) => {
    if (!active) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/brand-iq/${active.id}/urls`, {
        method: "DELETE",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!r.ok) {
        setError(`Remove failed (${r.status})`);
        return;
      }
      const j = await r.json();
      if (j.profile) {
        setProfiles((prev) => prev.map((p) => (p.id === active.id ? (j.profile as BrandProfile) : p)));
      }
    } finally {
      setBusy(false);
    }
  };

  const synthesize = async () => {
    if (!active) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/brand-iq/${active.id}/synthesize`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      const j = await r.json();
      if (!r.ok) {
        setError(j?.error || `Synthesize failed (${r.status})`);
        return;
      }
      // Synthesize is propose-only on the server: load the proposed text
      // into the editable draft, capture the current persisted text for
      // diff display, and let the user commit explicitly via the new
      // PUT /design-md endpoint.
      const proposed = typeof j.proposed_design_md === "string" ? j.proposed_design_md : "";
      const current = typeof j.current_design_md === "string" ? j.current_design_md : (active.design_md || "");
      setDraft((prev) => (prev ? { ...prev, design_md: proposed } : prev));
      setProposedDesignMd(proposed);
      setBaseDesignMd(current);
      setInfo("Brief proposed — review the diff and commit.");
      setTab("brief");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Synthesize failed");
    } finally {
      setBusy(false);
    }
  };

  const commitDesignMd = async () => {
    if (!active || !draft) return;
    const body = (draft.design_md || "").trim();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/brand-iq/${active.id}/design-md`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ design_md: body }),
      });
      const j = await r.json();
      if (!r.ok) {
        setError(j?.error || `Save failed (${r.status})`);
        return;
      }
      if (j.profile) {
        setProfiles((prev) => prev.map((p) => (p.id === active.id ? (j.profile as BrandProfile) : p)));
      }
      setBaseDesignMd(body);
      setProposedDesignMd(null);
      setInfo("Brief saved.");
    } finally {
      setBusy(false);
    }
  };

  const downloadBrief = () => {
    if (!active?.design_md) return;
    const blob = new Blob([active.design_md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${active.name.replace(/[^a-z0-9-_]+/gi, "_")}-brand.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const updateDraft = (patch: Partial<BrandProfile>) => {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  const updateData = (patch: Partial<ProfileData>) => {
    setDraft((prev) => (prev ? { ...prev, data: { ...(prev.data || {}), ...patch } } : prev));
  };

  const updatePaletteAt = (idx: number, patch: Partial<PaletteColor>) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const palette = [...((prev.data?.palette) || DEFAULT_PALETTE)];
      palette[idx] = { ...palette[idx], ...patch };
      return { ...prev, data: { ...(prev.data || {}), palette } };
    });
  };

  const removePaletteAt = (idx: number) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const palette = ((prev.data?.palette) || []).filter((_, i) => i !== idx);
      return { ...prev, data: { ...(prev.data || {}), palette } };
    });
  };

  const addPaletteColor = () => {
    setDraft((prev) => {
      if (!prev) return prev;
      const palette = [...((prev.data?.palette) || []), { name: "", hex: "#888888" }];
      return { ...prev, data: { ...(prev.data || {}), palette } };
    });
  };

  const updateTypography = (patch: Partial<Typography>) => {
    setDraft((prev) => (prev ? { ...prev, data: { ...(prev.data || {}), typography: { ...(prev.data?.typography || {}), ...patch } } } : prev));
  };

  const logoAssets = (active?.assets || []).filter((a) => a.role === "logo_light" || a.role === "logo_dark");
  const graphicAssets = (active?.assets || []).filter((a) => a.role === "graphic" || a.role === "inspiration");
  const docAssets = (active?.assets || []).filter((a) => a.role === "document");
  const crawlEvidence = active?.crawl_evidence || {};
  const urls = active?.data?.urls || [];

  // Build the canvas-selection payload for the analyze endpoint.
  // Image-bearing nodes contribute a vision-eligible URL when their
  // `gradient` is a real http(s) image (not a CSS gradient string).
  const canvasReferencesPayload = useMemo<CanvasReferencePayload[]>(() => {
    const ids = selectedImageIds || [];
    if (ids.length === 0) return [];
    const meta = selectedNodeMeta || new Map<string, ReferenceImage>();
    const out: CanvasReferencePayload[] = [];
    for (const id of ids) {
      const m = meta.get(id);
      if (!m) {
        out.push({ kind: "other", name: id });
        continue;
      }
      const nodeType = m.nodeType || "image";
      let kind: CanvasReferencePayload["kind"] = "other";
      if (nodeType === "image" || nodeType === "video" || nodeType === "svg") kind = "image";
      else if (nodeType === "text") kind = "text";
      else if (nodeType === "frame" || nodeType === "group") kind = "frame";
      const isHttpUrl = typeof m.gradient === "string" && /^https?:\/\//i.test(m.gradient);
      out.push({
        kind,
        name: m.label,
        url: kind === "image" && isHttpUrl ? m.gradient : undefined,
        width: m.width,
        height: m.height,
        aspect_ratio: m.aspectRatio,
        text_content: kind === "text" ? m.textContent : undefined,
      });
    }
    return out;
  }, [selectedImageIds, selectedNodeMeta]);

  const runAnalyze = useCallback(async (target: "active" | "new") => {
    if (!wsId) {
      setError("Pick a workspace first.");
      setShowAnalyzePicker(false);
      return;
    }
    const refs = canvasReferencesPayload;
    if (refs.length === 0) {
      setError("Select one or more items on the canvas to analyze.");
      setShowAnalyzePicker(false);
      return;
    }
    setAnalyzing(true);
    setError(null);
    try {
      let targetId = target === "active" && active ? active.id : null;
      let targetName = active?.name || "the brand";
      if (target === "new" || !targetId) {
        const stamp = new Date().toISOString().slice(0, 10);
        const newName = `Canvas analysis · ${stamp}`;
        const cr = await fetch(`/api/brand-iq`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspace_id: wsId,
            name: newName,
            tags: ["canvas-analysis"],
            avatar_color: DEFAULT_AVATAR_COLOR,
          }),
        });
        const cj = await cr.json().catch(() => ({} as { profile?: { id: string }; error?: string }));
        if (!cr.ok || !cj.profile?.id) {
          setError(cj?.error || `Could not create brand profile (${cr.status})`);
          return;
        }
        targetId = cj.profile.id;
        targetName = newName;
        await refreshList();
        setActiveId(targetId);
      }
      if (!targetId) { setError("No brand profile to analyze."); return; }
      const r = await fetch(`/api/brand-iq/${targetId}/analyze-from-canvas`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ references: refs }),
      });
      const text = await r.text();
      let j: { proposed_design_md?: string; current_design_md?: string; vision_count?: number; reference_count?: number; error?: string } = {};
      try { j = JSON.parse(text); }
      catch { setError(`Analyze failed (${r.status}): unexpected response`); return; }
      if (!r.ok || j.error) {
        setError(j.error || `Analyze failed (${r.status})`);
        return;
      }
      const proposed = typeof j.proposed_design_md === "string" ? j.proposed_design_md : "";
      const current = typeof j.current_design_md === "string" ? j.current_design_md : "";
      // Stash the proposal in the ref BEFORE refreshProfile/setActiveId
      // queue the active-change rebuild. The dedicated effect below
      // consumes the ref exactly once after the rebuild lands, so the
      // brief tab shows the proposed text without racing the rebuild
      // and without re-clobbering later user edits on background polls.
      pendingProposalRef.current = { profileId: targetId, text: proposed };
      await refreshProfile(targetId);
      setActiveId(targetId);
      setExpandedProfileId(targetId);
      setProposedDesignMd(proposed);
      setBaseDesignMd(current);
      setTab("brief");
      const totalN = typeof j.reference_count === "number" ? j.reference_count : refs.length;
      const visionN = typeof j.vision_count === "number" ? j.vision_count : refs.filter((x) => x.kind === "image").length;
      const visionPart = visionN > 0 && visionN !== totalN ? ` (${visionN} with vision)` : "";
      setInfo(`Analyzed ${totalN} reference${totalN === 1 ? "" : "s"}${visionPart} into ${targetName}'s brief — open More options to review.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Analyze failed");
    } finally {
      setAnalyzing(false);
      setShowAnalyzePicker(false);
    }
  }, [wsId, active, canvasReferencesPayload, setExpandedProfileId]);

  const handleClose = useCallback(() => {
    if (expandedProfileId) setExpandedProfileId(null);
    onClose();
  }, [expandedProfileId, onClose, setExpandedProfileId]);

  const isExpanded = expandedProfileId !== null && active !== null && expandedProfileId === active.id;

  return (
    <aside
      className={`brandiq-panel ${isExpanded ? "" : "brandiq-panel--collapsed"}`}
      role="dialog"
      aria-label="Brand IQ"
    >
      {/* ─── Sidebar (left column): create + search + brand list ─── */}
      <div className="brandiq-panel-sidebar">
        <header className="brandiq-panel-sidebar-header">
          <span className="brandiq-panel-sidebar-title">Brand IQ</span>
          {workspaces.length > 1 && (
            <select
              className="brandiq-panel-ws-select"
              value={wsId || ""}
              onChange={(e) => {
                const next = workspaces.find((w) => w.id === e.target.value);
                if (next) setActiveWorkspace(next);
              }}
              title="Switch workspace"
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="brandiq-panel-close"
            onClick={handleClose}
            aria-label="Close panel"
            title="Close panel"
            style={workspaces.length > 1 ? undefined : { marginLeft: "auto" }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </header>

        <div className="brandiq-create-row">
          <button
            type="button"
            className="brandiq-create-btn"
            onClick={handleCreate}
            disabled={creating || !wsId}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            {creating ? "Creating…" : "Create new brand"}
          </button>
        </div>

        {/* Panel-level status banners. Kept OUTSIDE the active-brand block so
         * that errors from "Create new brand" (and any other top-level action)
         * are visible even when no brand is selected yet — otherwise the
         * Create button can appear to do nothing on a failed request. */}
        {error && <div className="brandiq-error">{error}</div>}
        {info && <div className="brandiq-info">{info}</div>}

        <div className="brandiq-toolbar">
          <input
            className="brandiq-search"
            placeholder="Search brands or tags…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            className="brandiq-select"
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as "updated" | "name")}
            title="Sort order"
            style={{ width: 110 }}
          >
            <option value="updated">Last edited</option>
            <option value="name">Name</option>
          </select>
        </div>

        <div className="brandiq-toolbar" style={{ paddingTop: 0 }}>
          <button
            type="button"
            className={`brandiq-tag-pill ${showArchived ? "brandiq-tag-pill--active" : ""}`}
            onClick={() => setShowArchived((v) => !v)}
            title={showArchived ? "Showing archived brands" : "Hiding archived brands"}
          >
            Archived
          </button>
          {allTags.length > 0 && (
            <button
              type="button"
              className={`brandiq-tag-pill ${tagFilter === null ? "brandiq-tag-pill--active" : ""}`}
              onClick={() => setTagFilter(null)}
              title="Clear tag filter"
            >
              All
            </button>
          )}
        </div>

        {allTags.length > 0 && (
          <div className="brandiq-tags">
            {allTags.slice(0, 24).map((t) => (
              <button
                key={t}
                type="button"
                className={`brandiq-tag-pill ${tagFilter === t ? "brandiq-tag-pill--active" : ""}`}
                onClick={() => setTagFilter((cur) => (cur === t ? null : t))}
              >
                #{t}
              </button>
            ))}
          </div>
        )}

        <div className="brandiq-list">
          {loading && <div className="brandiq-empty">Loading…</div>}
          {!loading && filtered.length === 0 && (
            <div className="brandiq-empty">
              {wsId ? "No brand profiles yet. Use “Create new brand” above to add one." : "Select a workspace first."}
            </div>
          )}
          {filtered.map((p) => {
            const isOpen = expandedProfileId === p.id;
            return (
              <div key={p.id} className="brandiq-card-row">
                <button
                  type="button"
                  className={`brandiq-card ${p.id === activeId ? "brandiq-card--active" : ""}`}
                  onClick={() => {
                    setActiveId(p.id);
                    // Spec: clicking the body selects but doesn't auto-
                    // expand. If the editor is already open, swap in
                    // place.
                    if (expandedProfileId && expandedProfileId !== p.id) {
                      setExpandedProfileId(p.id);
                    }
                  }}
                >
                  <div className="brandiq-card-swatch">
                    {paletteSwatches(p.data?.palette).map((c, i) => (
                      <span key={i} style={{ background: c }} />
                    ))}
                  </div>
                  <div className="brandiq-card-meta">
                    <div className="brandiq-card-name">{p.name}</div>
                    <div className="brandiq-card-sub">
                      {p.is_default && <span className="brandiq-badge">Default</span>}
                      {projectDefaultId === p.id && <span className="brandiq-badge">Project</span>}
                      {(p.assets?.length || 0) > 0 && <span>{p.assets?.length} assets</span>}
                    </div>
                  </div>
                </button>
                <button
                  type="button"
                  className={`brandiq-card-chevron ${isOpen ? "brandiq-card-chevron--open" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    lastChevronRef.current = e.currentTarget;
                    if (isOpen) {
                      setExpandedProfileId(null);
                    } else {
                      setActiveId(p.id);
                      setExpandedProfileId(p.id);
                    }
                  }}
                  aria-label={isOpen ? "Close editor" : "More options"}
                  aria-expanded={isOpen}
                  title={isOpen ? "Close editor" : "More options"}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="9 6 15 12 9 18" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>

        {/* ─── Analyze brand footer ─── */}
        {(() => {
          const ids = selectedImageIds || [];
          const selectionCount = ids.length;
          const disabled = selectionCount === 0 || analyzing;
          return (
            <div className="brandiq-analyze-footer">
              {showAnalyzePicker ? (
                <div className="brandiq-analyze-picker">
                  <div className="brandiq-analyze-picker-title">Analyze into…</div>
                  {active && (
                    <button
                      type="button"
                      className="brandiq-analyze-picker-btn"
                      disabled={analyzing}
                      onClick={() => runAnalyze("active")}
                    >
                      {`Analyze into "${active.name}"`}
                    </button>
                  )}
                  <button
                    type="button"
                    className="brandiq-analyze-picker-btn"
                    disabled={analyzing}
                    onClick={() => runAnalyze("new")}
                  >
                    + New brand profile from selection
                  </button>
                  {!active && profiles.length === 0 && (
                    <div className="brandiq-analyze-meta" style={{ textAlign: "left" }}>
                      No brand profiles in this workspace yet — a new one will be created.
                    </div>
                  )}
                  <button
                    type="button"
                    className="brandiq-analyze-picker-cancel"
                    onClick={() => setShowAnalyzePicker(false)}
                    disabled={analyzing}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    className="brandiq-analyze-btn"
                    disabled={disabled}
                    title={selectionCount === 0 ? "Select one or more items on the canvas to analyze" : undefined}
                    onClick={() => {
                      // If only one option (no active brand), skip the picker
                      // and go straight to "new profile".
                      if (!active && profiles.length === 0) {
                        void runAnalyze("new");
                      } else {
                        setShowAnalyzePicker(true);
                      }
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                    {analyzing
                      ? "Analyzing…"
                      : selectionCount > 0
                        ? `Analyze brand · ${selectionCount} selected`
                        : "Analyze brand"}
                  </button>
                  <div className="brandiq-analyze-meta">
                    {selectionCount === 0
                      ? "Select one or more items on the canvas to analyze."
                      : "Build a per-reference style breakdown from the canvas selection."}
                  </div>
                </>
              )}
            </div>
          );
        })()}
      </div>

      {/* ─── Main column: only mounted when a profile's editor is
       *   expanded via "More options". When collapsed, the panel
       *   shrinks to just the sidebar so the canvas stays interactive. */}
      {isExpanded && (
      <div className="brandiq-panel-main" ref={editorRef} tabIndex={-1}>
        <header className="brandiq-panel-header">
          <div className="brandiq-panel-title-wrap">
            <span className="brandiq-panel-eyebrow">
              {active ? "Brand profile" : "Brand IQ"}
            </span>
            <h2 className="brandiq-panel-title">
              {active?.name || "Select or create a brand"}
            </h2>
          </div>
          <button
            type="button"
            className="brandiq-panel-close"
            onClick={() => setExpandedProfileId(null)}
            aria-label="Collapse editor"
            title="Collapse editor"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </header>

        {active && draft ? (
          <>
            <div className="brandiq-tabs">
              <button type="button" className={`brandiq-tab ${tab === "form" ? "brandiq-tab--active" : ""}`} onClick={() => setTab("form")}>Profile</button>
              <button type="button" className={`brandiq-tab ${tab === "assets" ? "brandiq-tab--active" : ""}`} onClick={() => setTab("assets")}>Assets</button>
              <button type="button" className={`brandiq-tab ${tab === "docs" ? "brandiq-tab--active" : ""}`} onClick={() => setTab("docs")}>Docs</button>
              <button type="button" className={`brandiq-tab ${tab === "links" ? "brandiq-tab--active" : ""}`} onClick={() => setTab("links")}>Links</button>
              <button type="button" className={`brandiq-tab ${tab === "brief" ? "brandiq-tab--active" : ""}`} onClick={() => setTab("brief")}>Brief</button>
            </div>

            <div className="brandiq-body">

            {tab === "form" && (
              <>
                <div className="brandiq-field">
                  <label>Name</label>
                  <input
                    className="brandiq-input"
                    value={draft.name}
                    onChange={(e) => updateDraft({ name: e.target.value })}
                  />
                </div>
                <div className="brandiq-field">
                  <label>Tags (comma separated)</label>
                  <input
                    className="brandiq-input"
                    value={(draft.tags || []).join(", ")}
                    onChange={(e) => updateDraft({ tags: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
                  />
                </div>
                <div className="brandiq-field">
                  <label>Mission</label>
                  <textarea
                    className="brandiq-textarea"
                    value={draft.data?.mission || ""}
                    onChange={(e) => updateData({ mission: e.target.value })}
                  />
                </div>
                <div className="brandiq-field">
                  <label>Vision</label>
                  <textarea
                    className="brandiq-textarea"
                    value={draft.data?.vision || ""}
                    onChange={(e) => updateData({ vision: e.target.value })}
                  />
                </div>
                <div className="brandiq-section">
                  <div className="brandiq-section-title">Palette</div>
                  <div className="brandiq-color-row">
                    {(draft.data?.palette || []).map((c, i) => (
                      <div key={i} className="brandiq-color-cell">
                        <ColorPickerInput
                          label={c.name || `Color ${i + 1}`}
                          value={c.hex}
                          onChange={(hex) => updatePaletteAt(i, { hex })}
                        />
                        <div className="brandiq-color-cell-actions">
                          <input
                            className="brandiq-input"
                            placeholder="Name"
                            value={c.name || ""}
                            onChange={(e) => updatePaletteAt(i, { name: e.target.value })}
                          />
                          <button
                            type="button"
                            className="brandiq-btn brandiq-btn--ghost brandiq-btn--sm"
                            onClick={() => removePaletteAt(i)}
                            aria-label="Remove color"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                  <button type="button" className="brandiq-btn brandiq-btn--sm" onClick={addPaletteColor}>+ Add color</button>
                </div>
                <div className="brandiq-section">
                  <div className="brandiq-section-title">Typography</div>
                  <div className="brandiq-field">
                    <label>Display family</label>
                    <input
                      className="brandiq-input"
                      placeholder="e.g. Inter, Helvetica Neue"
                      value={draft.data?.typography?.display || ""}
                      onChange={(e) => updateTypography({ display: e.target.value })}
                    />
                  </div>
                  <div className="brandiq-field">
                    <label>Body family</label>
                    <input
                      className="brandiq-input"
                      placeholder="e.g. Inter, system-ui"
                      value={draft.data?.typography?.body || ""}
                      onChange={(e) => updateTypography({ body: e.target.value })}
                    />
                  </div>
                  <div className="brandiq-field">
                    <label>Mono family</label>
                    <input
                      className="brandiq-input"
                      placeholder="e.g. JetBrains Mono"
                      value={draft.data?.typography?.mono || ""}
                      onChange={(e) => updateTypography({ mono: e.target.value })}
                    />
                  </div>
                </div>
                <div className="brandiq-section">
                  <div className="brandiq-section-title">Voice & tone</div>
                  <div className="brandiq-field">
                    <label>Audience</label>
                    <input
                      className="brandiq-input"
                      value={draft.data?.audience || ""}
                      onChange={(e) => updateData({ audience: e.target.value })}
                    />
                  </div>
                  <div className="brandiq-field">
                    <label>Tone</label>
                    <input
                      className="brandiq-input"
                      value={draft.data?.tone || ""}
                      onChange={(e) => updateData({ tone: e.target.value })}
                    />
                  </div>
                  <div className="brandiq-field">
                    <label>Do (one per line)</label>
                    <textarea
                      className="brandiq-textarea"
                      value={doText}
                      onChange={(e) => setDoText(e.target.value)}
                    />
                  </div>
                  <div className="brandiq-field">
                    <label>Don't (one per line)</label>
                    <textarea
                      className="brandiq-textarea"
                      value={dontText}
                      onChange={(e) => setDontText(e.target.value)}
                    />
                  </div>
                </div>
                <div className="brandiq-row">
                  <button type="button" className="brandiq-btn brandiq-btn--primary" onClick={handleSave} disabled={busy}>
                    Save
                  </button>
                  <button type="button" className="brandiq-btn" onClick={handleSetWorkspaceDefault} disabled={busy || !!active.is_default}>
                    {active.is_default ? "Default ✓" : "Set workspace default"}
                  </button>
                </div>
                <div className="brandiq-row">
                  <button
                    type="button"
                    className="brandiq-btn"
                    onClick={handleSetProjectDefault}
                    disabled={busy || !activeProjectId || projectDefaultId === active.id}
                  >
                    {projectDefaultId === active.id ? "Pinned to project ✓" : "Pin to current project"}
                  </button>
                  <button
                    type="button"
                    className="brandiq-btn"
                    onClick={async () => {
                      if (!active) return;
                      setBusy(true);
                      setError(null);
                      try {
                        const r = await fetch(`/api/brand-iq`, {
                          method: "POST",
                          credentials: "include",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            workspace_id: active.workspace_id,
                            name: `${active.name} (copy)`,
                            avatar_color: active.avatar_color,
                            tags: active.tags,
                            data: active.data,
                            design_md: active.design_md || undefined,
                            crawl_evidence: active.crawl_evidence,
                          }),
                        });
                        const j = await r.json();
                        if (!r.ok) {
                          setError(j?.error || `Duplicate failed (${r.status})`);
                          return;
                        }
                        await refreshList();
                        if (j.profile?.id) setActiveId(j.profile.id);
                        setInfo("Brand duplicated.");
                      } finally {
                        setBusy(false);
                      }
                    }}
                    disabled={busy}
                  >
                    Duplicate
                  </button>
                  {active.archived_at ? (
                    <>
                      <button
                        type="button"
                        className="brandiq-btn"
                        disabled={busy}
                        onClick={async () => {
                          if (!active) return;
                          setBusy(true);
                          try {
                            const r = await fetch(`/api/brand-iq/${active.id}/restore`, {
                              method: "POST",
                              credentials: "include",
                            });
                            if (!r.ok) {
                              const j = await r.json().catch(() => ({}));
                              setError(j?.error || `Restore failed (${r.status})`);
                              return;
                            }
                            await refreshList();
                            await refreshProfile(active.id);
                            setInfo("Brand restored.");
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        Restore
                      </button>
                      <button
                        type="button"
                        className="brandiq-btn brandiq-btn--danger"
                        onClick={handleHardDelete}
                        disabled={busy}
                        title="Permanently delete this archived brand"
                      >
                        Delete permanently
                      </button>
                    </>
                  ) : (
                    <button type="button" className="brandiq-btn brandiq-btn--danger" onClick={handleDelete} disabled={busy}>
                      Archive
                    </button>
                  )}
                </div>
              </>
            )}

            {tab === "assets" && (
              <>
                <div className="brandiq-section">
                  <div className="brandiq-section-title">Logos</div>
                  <div className="brandiq-row">
                    <button type="button" className="brandiq-btn" onClick={() => logoLightInputRef.current?.click()} disabled={busy}>
                      Upload light logo
                    </button>
                    <button type="button" className="brandiq-btn" onClick={() => logoDarkInputRef.current?.click()} disabled={busy}>
                      Upload dark logo
                    </button>
                  </div>
                  <input ref={logoLightInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => {
                    const f = e.target.files?.[0]; if (f) uploadAsset(f, "logo_light"); if (e.target) e.target.value = "";
                  }} />
                  <input ref={logoDarkInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => {
                    const f = e.target.files?.[0]; if (f) uploadAsset(f, "logo_dark"); if (e.target) e.target.value = "";
                  }} />
                  {logoAssets.length === 0 && <div className="brandiq-empty">No logos uploaded yet.</div>}
                  {logoAssets.map((a) => (
                    <div key={a.id} className="brandiq-asset">
                      <div className="brandiq-asset-thumb" style={{ backgroundImage: `url(${a.file_url})` }} />
                      <div className="brandiq-asset-meta">
                        <strong>{a.role === "logo_light" ? "Light logo" : "Dark logo"}</strong>
                        {a.name}
                      </div>
                      <button type="button" className="brandiq-btn brandiq-btn--ghost" onClick={() => detachAsset(a.id)}>Remove</button>
                    </div>
                  ))}
                </div>
                <div className="brandiq-section">
                  <div className="brandiq-section-title">Graphics</div>
                  <button type="button" className="brandiq-btn" onClick={() => graphicInputRef.current?.click()} disabled={busy}>
                    Upload graphic
                  </button>
                  <input ref={graphicInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => {
                    const f = e.target.files?.[0]; if (f) uploadAsset(f, "graphic"); if (e.target) e.target.value = "";
                  }} />
                  {graphicAssets.length === 0 && <div className="brandiq-empty">No graphics yet.</div>}
                  {graphicAssets.map((a) => (
                    <div key={a.id} className="brandiq-asset">
                      <div className="brandiq-asset-thumb" style={{ backgroundImage: `url(${a.file_url})` }} />
                      <div className="brandiq-asset-meta">
                        <strong>{a.role === "graphic" ? "Graphic" : "Inspiration"}</strong>
                        {a.name}
                      </div>
                      <button type="button" className="brandiq-btn brandiq-btn--ghost" onClick={() => detachAsset(a.id)}>Remove</button>
                    </div>
                  ))}
                </div>
              </>
            )}

            {tab === "docs" && (
              <div className="brandiq-section">
                <div className="brandiq-section-title">Brand documents</div>
                <div className="brandiq-row">
                  <select
                    className="brandiq-input"
                    value={docRole}
                    onChange={(e) => setDocRole(e.target.value)}
                    disabled={busy}
                    style={{ maxWidth: 200 }}
                  >
                    <option value="general">General</option>
                    <option value="brand_guidelines">Brand guidelines</option>
                    <option value="voice_tone">Voice & tone</option>
                    <option value="style_guide">Style guide</option>
                    <option value="messaging">Messaging</option>
                    <option value="product">Product overview</option>
                    <option value="positioning">Positioning</option>
                  </select>
                  <button type="button" className="brandiq-btn" onClick={() => docInputRef.current?.click()} disabled={busy}>
                    Upload as “{docRole.replace("_", " ")}”
                  </button>
                </div>
                <input
                  ref={docInputRef}
                  type="file"
                  accept=".md,.markdown,.txt,.pdf,.docx,text/markdown,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const f = e.target.files?.[0]; if (f) uploadAsset(f, "document", docRole); if (e.target) e.target.value = "";
                  }}
                />
                {docAssets.length === 0 && <div className="brandiq-empty">No documents yet.</div>}
                {docAssets.map((a) => (
                  <div key={a.id} className="brandiq-asset">
                    <div className="brandiq-asset-thumb brandiq-asset-thumb--doc" />
                    <div className="brandiq-asset-meta">
                      <strong>{a.name}</strong>
                      {a.extraction_status === "ok" || a.extraction_status === "truncated"
                        ? `${a.doc_role || "general"} · extracted`
                        : a.extraction_status?.startsWith("error")
                          ? "extraction failed"
                          : (a.doc_role || "general")}
                      {a.extracted_text_preview && (
                        <div style={{ marginTop: 4, fontSize: 10, opacity: 0.7 }}>
                          {a.extracted_text_preview}…
                        </div>
                      )}
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <a
                        href={a.file_url}
                        target="_blank"
                        rel="noreferrer"
                        className="brandiq-btn brandiq-btn--ghost"
                        style={{ padding: "2px 6px", fontSize: 10, textDecoration: "none", textAlign: "center" }}
                        title="Open original file"
                      >
                        Open
                      </a>
                      <button type="button" className="brandiq-btn brandiq-btn--ghost" onClick={() => detachAsset(a.id)}>Remove</button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {tab === "links" && (
              <div className="brandiq-section">
                <div className="brandiq-section-title">Web sources</div>
                <div className="brandiq-row">
                  <input ref={newUrlRef} className="brandiq-input" placeholder="https://your-brand.com" />
                  <button type="button" className="brandiq-btn brandiq-btn--primary" onClick={addUrl} disabled={busy}>
                    Crawl
                  </button>
                </div>
                {urls.length === 0 && <div className="brandiq-empty">No URLs crawled yet.</div>}
                {urls.map((u) => {
                  const ev = crawlEvidence[u] as (CrawlEvidence & { state?: string }) | undefined;
                  const state = ev?.state || (ev?.ok ? "ok" : ev ? "error" : "pending");
                  return (
                    <div key={u} className="brandiq-url">
                      <div className="brandiq-url-head">
                        <a href={u} target="_blank" rel="noreferrer">{u}</a>
                        <div className="brandiq-url-actions">
                          <span className={`brandiq-url-status brandiq-url-status--${state === "pending" ? "pending" : state === "ok" ? "ok" : "error"}`}>
                            {state === "pending" ? "Crawling…" : state === "ok" ? "OK" : "Error"}
                          </span>
                          <button
                            type="button"
                            className="brandiq-btn brandiq-btn--ghost brandiq-btn--sm"
                            onClick={() => removeUrl(u)}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                      {ev?.title && <div className="brandiq-url-title">{ev.title}</div>}
                      {ev?.description && <div className="brandiq-url-desc">{ev.description}</div>}
                      {ev && !ev.ok && state !== "pending" && (
                        <div className="brandiq-url-desc" style={{ color: "#f87171" }}>
                          Crawl failed{ev.error ? `: ${ev.error}` : ""}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {tab === "brief" && (
              <div className="brandiq-section">
                <div className="brandiq-row">
                  <button type="button" className="brandiq-btn brandiq-btn--primary" onClick={synthesize} disabled={busy}>
                    {active.design_md ? "Regenerate brief" : "Generate brief"}
                  </button>
                  <button type="button" className="brandiq-btn" onClick={downloadBrief} disabled={!active.design_md}>
                    Download .md
                  </button>
                </div>
                {proposedDesignMd !== null && (
                  <div className="brandiq-proposal">
                    <div className="brandiq-proposal-title">Proposed brief — review before committing</div>
                    <DesignMdDiff base={baseDesignMd} next={draft.design_md || ""} />
                    <div className="brandiq-row">
                      <button
                        type="button"
                        className="brandiq-btn brandiq-btn--ghost"
                        onClick={() => {
                          setDraft((prev) => prev ? { ...prev, design_md: baseDesignMd } : prev);
                          setProposedDesignMd(null);
                          setInfo("Discarded proposal.");
                        }}
                        disabled={busy}
                      >
                        Discard
                      </button>
                      <button
                        type="button"
                        className="brandiq-btn brandiq-btn--primary"
                        onClick={commitDesignMd}
                        disabled={busy || (draft.design_md || "") === baseDesignMd}
                      >
                        Commit brief
                      </button>
                    </div>
                  </div>
                )}
                <textarea
                  className="brandiq-textarea brandiq-md"
                  placeholder={busy ? "Working…" : "No brief generated yet. Add palette, logos, docs, or URLs and click Generate brief."}
                  value={draft.design_md || ""}
                  onChange={(e) => updateDraft({ design_md: e.target.value })}
                />
                <div className="brandiq-row">
                  <button
                    type="button"
                    className="brandiq-btn"
                    disabled={busy || !draft.design_md || draft.design_md === active.design_md}
                    onClick={commitDesignMd}
                  >
                    Save brief
                  </button>
                  <button
                    type="button"
                    className={`brandiq-btn ${showBriefPreview ? "brandiq-btn--primary" : ""}`}
                    onClick={() => setShowBriefPreview((v) => !v)}
                    disabled={!draft.design_md}
                    title="Toggle rendered markdown preview"
                  >
                    {showBriefPreview ? "Hide preview" : "Preview"}
                  </button>
                </div>
                {showBriefPreview && draft.design_md && (
                  <div
                    className="brandiq-md-preview"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(draft.design_md) }}
                  />
                )}
              </div>
            )}
            </div>
          </>
        ) : (
          <div className="brandiq-main-empty">
            <div className="brandiq-main-empty-title">
              {wsId ? "No brand selected" : "Pick a workspace"}
            </div>
            <div className="brandiq-main-empty-desc">
              {wsId
                ? "Choose a brand from the list, or click Create new brand to start one."
                : "Select a workspace to view and manage its brand profiles."}
            </div>
          </div>
        )}
      </div>
      )}
    </aside>
  );
}
