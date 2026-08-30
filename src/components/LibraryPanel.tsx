import { useState, useCallback, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import WaveSurfer from "wavesurfer.js";
import "./LibraryPanel.css";
import { PlatformLibraryService } from "../services/PlatformLibraryService";
import { PlatformBadge } from "./library/PlatformBadge";
import { PlatformLockOverlay } from "./library/PlatformLockOverlay";
import { PlatformPurchasePanel } from "./library/PlatformPurchasePanel";
import type { PlatformItem, PlatformItemType } from "../types/platformLibrary";
import { useWorkspace } from "../contexts/WorkspaceContext";
import { getCached, setCached, invalidate as invalidateCache } from "../services/AssetCache";

type LibAudioType = "tts" | "music" | "voicechanger" | "sfx";

const LIB_TYPE_CONFIG: Record<LibAudioType, { label: string; className: string; waveColor: string; progressColor: string }> = {
  tts: { label: "TTS", className: "lib-type--tts", waveColor: "rgba(96, 165, 250, 0.35)", progressColor: "#60a5fa" },
  music: { label: "Music", className: "lib-type--music", waveColor: "rgba(192, 132, 252, 0.35)", progressColor: "#c084fc" },
  voicechanger: { label: "Voice Changer", className: "lib-type--vc", waveColor: "rgba(52, 211, 153, 0.35)", progressColor: "#34d399" },
  sfx: { label: "SFX", className: "lib-type--sfx", waveColor: "rgba(251, 191, 36, 0.35)", progressColor: "#fbbf24" },
};

type LibraryPanelProps = {
  view: string;
  onClose: () => void;
  onDragAsset: (data: { id: string; label: string; gradient: string }) => void;
  onDragStyle: (prompt: string) => void;
  onOpenAxiomCreator?: () => void;
  onOpenStyleCreator?: () => void;
  onOpenBucketManager?: (context: "axioms" | "styles") => void;
  onOpenFolderCreator?: () => void;
  onOpenFolderManager?: (folder: { id: string; name: string } | string) => void;
  onOpenAxiomManager?: (axiomId: string) => void;
  onOpenStyleManager?: (styleId: string) => void;
  folderSelectMode?: boolean;
  folderSelectedIds?: Map<string, { name: string; thumb: string }>;
  onToggleFolderItem?: (id: string, meta?: { name: string; thumb: string }) => void;
  folderRefreshKey?: number;
  axiomRefreshKey?: number;
  styleRefreshKey?: number;
  assetRefreshKey?: number;
  initialFolderId?: string | null;
  highlightAssetId?: string | null;
};

/* ─── Types ─── */

type AssetItem = {
  id: string;
  name: string;
  type: string;
  file_url: string;
  file_type: string | null;
  folder_id: string | null;
  source?: string;
  metadata: any;
  created_at: string;
};

type AudioItem = {
  id: string;
  name: string;
  audio_class: string;
  file_url: string;
  file_type: string | null;
  folder_id: string | null;
  source?: string;
  duration_seconds: number | null;
  metadata: any;
  created_at: string;
};

type FolderItem = {
  id: string;
  name: string;
  type: string;
};

type BucketItem = {
  id: string;
  name: string;
  type: string;
};

/* ─── Helpers ─── */

const VIEW_TITLES: Record<string, string> = {
  images: "Images",
  videos: "Videos",
  axioms: "Products",
  styles: "Prompts",
  music: "Music",
  voices: "Voices",
  sfx: "Sound Effects",
  trash: "Trash",
};

function isAssetView(view: string) {
  return ["images", "videos"].includes(view);
}

function isAudioView(view: string) {
  return ["music", "voices", "sfx"].includes(view);
}

function viewToAssetType(view: string): string {
  return view === "videos" ? "video" : "image";
}

function viewToAudioClass(view: string): string {
  switch (view) {
    case "voices": return "voice";
    case "sfx": return "sound_effect";
    default: return "music";
  }
}

function viewToFolderType(view: string): string {
  switch (view) {
    case "videos": return "video";
    case "music": return "music";
    case "voices": return "voice";
    case "sfx": return "sound_effect";
    default: return "image";
  }
}

function isMediaView(view: string): boolean {
  const folderType = viewToFolderType(view);
  return folderType === "image" || folderType === "video";
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function isVideoItem(item: AssetItem): boolean {
  return item.type === "video" || (item.file_type != null && item.file_type.startsWith("video/"));
}

function thumbStyle(item: AssetItem): React.CSSProperties {
  if (item.file_url && !isVideoItem(item)) {
    return { backgroundImage: `url(${item.file_url})`, backgroundSize: "contain", backgroundRepeat: "no-repeat", backgroundPosition: "center" };
  }
  if (isVideoItem(item)) {
    return { background: "rgba(0,0,0,0.6)" };
  }
  const h = Math.abs(hashCode(item.id)) % 360;
  return { background: `linear-gradient(135deg, hsl(${h}, 40%, 20%), hsl(${(h + 60) % 360}, 50%, 35%))` };
}

type SourceTab = "mine" | "platform";

function SourceTabs({ active, onChange }: { active: SourceTab; onChange: (t: SourceTab) => void }) {
  return (
    <div className="lib-source-tabs">
      <button
        type="button"
        className={`lib-source-tab ${active === "mine" ? "lib-source-tab--active" : ""}`}
        onClick={() => onChange("mine")}
      >
        My Library
      </button>
      <button
        type="button"
        className={`lib-source-tab ${active === "platform" ? "lib-source-tab--active" : ""}`}
        onClick={() => onChange("platform")}
      >
        Platform
      </button>
    </div>
  );
}

function usePlatformItems(type: PlatformItemType | undefined) {
  const [items, setItems] = useState<PlatformItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    if (!type) return;
    setLoading(true);
    setError(null);
    PlatformLibraryService.getItems({ type })
      .then((result) => setItems(result))
      .catch((err) => setError(err.message || "Failed to load"))
      .finally(() => setLoading(false));
  }, [type]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { items, loading, error, refetch };
}

function SaveToSpaceMenu({ contentId, onDone }: { contentId: string; onDone: () => void }) {
  const [saving, setSaving] = useState(false);

  const handleSave = async (destination: "personal" | "org") => {
    setSaving(true);
    try {
      await PlatformLibraryService.saveToSpace(contentId, destination);
      onDone();
    } catch {
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="platform-save-menu" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="platform-save-option"
        disabled={saving}
        onClick={() => handleSave("personal")}
      >
        Save to My Space
      </button>
      <button
        type="button"
        className="platform-save-option"
        disabled={saving}
        onClick={() => handleSave("org")}
      >
        Save to Org
      </button>
    </div>
  );
}

function PlatformGrid({
  items,
  loading,
  error,
  onRetry,
  onSelectItem,
  viewLayout = "grid",
}: {
  items: PlatformItem[];
  loading: boolean;
  error?: string | null;
  onRetry?: () => void;
  onSelectItem: (item: PlatformItem) => void;
  viewLayout?: "grid" | "list";
}) {
  const [saveMenuId, setSaveMenuId] = useState<string | null>(null);

  if (loading) {
    return (
      <div className="platform-empty">
        <span className="platform-empty-text">Loading platform items...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="platform-empty">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="12" cy="12" r="10" />
          <line x1="15" y1="9" x2="9" y2="15" />
          <line x1="9" y1="9" x2="15" y2="15" />
        </svg>
        <span className="platform-empty-text">{error}</span>
        {onRetry && (
          <button type="button" className="lib-btn-secondary" onClick={onRetry}>Retry</button>
        )}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="platform-empty">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6z" />
        </svg>
        <span className="platform-empty-text">No platform items available yet.</span>
      </div>
    );
  }

  return (
    <div className={`lib-grid${viewLayout === "list" ? " lib-grid--list" : ""}`}>
      {items.map((item) => {
        const hasAccess = item.is_free || item.user_has_access;
        const gradient = item.thumbnail_url
          ? undefined
          : `linear-gradient(135deg, hsl(${hashCode(item.id) % 360}, 50%, 25%), hsl(${(hashCode(item.id) + 60) % 360}, 60%, 45%))`;

        return (
          <div
            key={item.id}
            className="lib-card lib-card--platform lib-card--has-cog"
            onClick={() => !hasAccess ? onSelectItem(item) : undefined}
          >
            <div
              className="lib-card-thumb"
              style={
                item.thumbnail_url
                  ? { backgroundImage: `url(${item.thumbnail_url})`, backgroundSize: "contain", backgroundRepeat: "no-repeat", backgroundPosition: "center" }
                  : { background: gradient }
              }
            />
            <PlatformBadge />
            {!hasAccess && (
              <PlatformLockOverlay
                priceCents={item.price_cents}
                onClick={() => onSelectItem(item)}
              />
            )}
            {hasAccess && (
              <div className="lib-card-body">
                <span className="lib-card-name">{item.name}</span>
                <button
                  type="button"
                  className="platform-save-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSaveMenuId(saveMenuId === item.id ? null : item.id);
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                    <polyline points="17 21 17 13 7 13 7 21" />
                    <polyline points="7 3 7 8 15 8" />
                  </svg>
                </button>
              </div>
            )}
            {saveMenuId === item.id && (
              <SaveToSpaceMenu contentId={item.id} onDone={() => setSaveMenuId(null)} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function useCanEditAxiomsStyles() {
  const { activeWorkspace } = useWorkspace();
  return !!activeWorkspace;
}

/* ─── Data hooks ─── */

function useAssets(view: string, refreshKey: number) {
  const assetType = viewToAssetType(view);
  const cacheKey = `assets:${assetType}`;
  const cached = getCached<AssetItem[]>(cacheKey);
  const [items, setItems] = useState<AssetItem[]>(cached?.data ?? []);
  const [loading, setLoading] = useState(!cached);
  const prevRefreshKey = useRef(refreshKey);

  const refetch = useCallback((force = false) => {
    const entry = getCached<AssetItem[]>(cacheKey);
    if (entry) { setItems(entry.data); setLoading(false); }
    if (!force && entry && !entry.stale) return;
    if (!entry) setLoading(true);
    fetch(`/api/assets?type=${assetType}`, { credentials: "include" })
      .then((r) => r.json())
      .then((d) => {
        const serverList: AssetItem[] = d.assets || [];
        const current = getCached<AssetItem[]>(cacheKey);
        const optimistic = current?.data.filter((item) => item.id.startsWith("temp-")) ?? [];
        const merged = optimistic.length > 0 ? [...optimistic, ...serverList] : serverList;
        setCached(cacheKey, merged);
        setItems(merged);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [assetType, cacheKey]);

  useEffect(() => {
    const forced = prevRefreshKey.current !== refreshKey;
    prevRefreshKey.current = refreshKey;
    refetch(forced);
  }, [refetch, refreshKey]);

  return { items, loading, setItems, refetch: () => refetch(true) };
}

function useAudioAssets(view: string, refreshKey: number) {
  const audioClass = viewToAudioClass(view);
  const cacheKey = `audio:${audioClass}`;
  const cached = getCached<AudioItem[]>(cacheKey);
  const [items, setItems] = useState<AudioItem[]>(cached?.data ?? []);
  const [loading, setLoading] = useState(!cached);
  const prevRefreshKey = useRef(refreshKey);

  const refetch = useCallback((force = false) => {
    const entry = getCached<AudioItem[]>(cacheKey);
    if (!force && entry && !entry.stale) { setItems(entry.data); setLoading(false); return; }
    if (!entry) setLoading(true);
    fetch(`/api/audio?class=${audioClass}`, { credentials: "include" })
      .then((r) => r.json())
      .then((d) => { const list = d.audio_assets || []; setCached(cacheKey, list); setItems(list); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [audioClass, cacheKey]);

  useEffect(() => {
    const forced = prevRefreshKey.current !== refreshKey;
    prevRefreshKey.current = refreshKey;
    refetch(forced);
  }, [refetch, refreshKey]);

  return { items, loading, setItems, refetch: () => refetch(true) };
}

function useFolders(view: string, refreshKey = 0) {
  const folderType = viewToFolderType(view);
  const mediaView = isMediaView(view);
  const cacheKey = mediaView ? "folders:media" : `folders:${folderType}`;
  const cached = getCached<FolderItem[]>(cacheKey);
  const [folders, setFolders] = useState<FolderItem[]>(cached?.data ?? []);
  const prevRefreshKey = useRef(refreshKey);

  useEffect(() => {
    const forced = prevRefreshKey.current !== refreshKey;
    prevRefreshKey.current = refreshKey;
    const entry = getCached<FolderItem[]>(cacheKey);
    if (!forced && entry && !entry.stale) { setFolders(entry.data); return; }
    fetch(`/api/folders?type=${folderType}`, { credentials: "include" })
      .then((r) => r.json())
      .then((d) => { const list = d.folders || []; setCached(cacheKey, list); setFolders(list); })
      .catch(() => {});
  }, [folderType, cacheKey, refreshKey]);

  return folders;
}

function useBuckets(type: "axioms" | "styles") {
  const { activeWorkspace } = useWorkspace();
  const apiType = type === "axioms" ? "axiom" : "style";
  const wsKey = activeWorkspace?.type === "org" && activeWorkspace?.id ? `org:${activeWorkspace.id}` : "personal";
  const cacheKey = `buckets:${apiType}:${wsKey}`;
  const cached = getCached<BucketItem[]>(cacheKey);
  const [buckets, setBuckets] = useState<BucketItem[]>(cached?.data ?? []);

  useEffect(() => {
    const entry = getCached<BucketItem[]>(cacheKey);
    if (entry && !entry.stale) { setBuckets(entry.data); return; }
    const params = new URLSearchParams({ type: apiType });
    if (activeWorkspace?.type === "org" && activeWorkspace.id) {
      params.set("scope", "org");
      params.set("workspace_id", activeWorkspace.id);
    }
    fetch(`/api/buckets?${params}`, { credentials: "include" })
      .then((r) => r.json())
      .then((d) => { const list = d.buckets || []; setCached(cacheKey, list); setBuckets(list); })
      .catch(() => {});
  }, [apiType, cacheKey, activeWorkspace?.id, activeWorkspace?.type]);

  return buckets;
}

/* ─── Fullscreen overlay ─── */

function FullscreenOverlay({ item, onClose }: { item: AssetItem; onClose: () => void }) {
  const isVideo = item.type === "video" || (item.file_type && item.file_type.startsWith("video/"));

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return createPortal(
    <div className="lib-fullscreen-overlay" onClick={onClose}>
      <div className="lib-fullscreen-content" onClick={(e) => e.stopPropagation()}>
        {isVideo ? (
          <video src={item.file_url} controls autoPlay className="lib-fullscreen-media" />
        ) : (
          <img src={item.file_url} alt={item.name} className="lib-fullscreen-media" />
        )}
        <div className="lib-fullscreen-info">
          <span className="lib-fullscreen-name">{item.name}</span>
        </div>
        <button type="button" className="lib-fullscreen-close" onClick={onClose}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
        </button>
      </div>
    </div>,
    document.body
  );
}

/* ─── Empty state ─── */

function EmptyState({ message, subtext }: { message: string; subtext?: string }) {
  return (
    <div className="platform-empty">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <line x1="12" y1="8" x2="12" y2="16" />
        <line x1="8" y1="12" x2="16" y2="12" />
      </svg>
      <span className="platform-empty-text">{message}</span>
      {subtext && <span className="platform-empty-text" style={{ fontSize: "10px", opacity: 0.5 }}>{subtext}</span>}
    </div>
  );
}

/* ─── Sub-views ─── */

function AssetCard({
  item,
  manageMode,
  folderSelectMode,
  isFolderSelected,
  isSelected,
  onDragStart,
  onToggleSelect,
  onDelete,
  onFullscreen,
  onClick,
  onContextMenu,
}: {
  item: AssetItem;
  manageMode?: boolean;
  folderSelectMode?: boolean;
  isFolderSelected?: boolean;
  isSelected?: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onToggleSelect?: () => void;
  onDelete: () => void;
  onFullscreen: () => void;
  onClick?: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const isVideo = isVideoItem(item);
  return (
    <div
      className={`lib-card ${isFolderSelected ? "lib-card--folder-selected" : ""} ${isSelected ? "lib-card--ctx-selected" : ""} ${manageMode ? "lib-card--shaking" : ""}`}
      data-asset-id={item.id}
      draggable={!folderSelectMode && !manageMode}
      onDragStart={folderSelectMode || manageMode ? undefined : onDragStart}
      onClick={folderSelectMode ? onToggleSelect : onClick}
      onContextMenu={onContextMenu}
    >
      <div className="lib-card-thumb" style={thumbStyle(item)}>
        {isVideo && item.file_url && (
          <video src={item.file_url} className="lib-card-video-poster" muted preload="metadata" />
        )}
        {isVideo && (
          <button type="button" className="lib-card-play-icon" onClick={(e) => { e.stopPropagation(); onFullscreen(); }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="8,5 20,12 8,19" /></svg>
          </button>
        )}
      </div>
      {!isVideo && !manageMode && !folderSelectMode && item.file_url && (
        <button type="button" className="lib-card-fullscreen" onClick={(e) => { e.stopPropagation(); onFullscreen(); }} title="View fullscreen">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 3 21 3 21 9" />
            <polyline points="9 21 3 21 3 15" />
            <line x1="21" y1="3" x2="14" y2="10" />
            <line x1="3" y1="21" x2="10" y2="14" />
          </svg>
        </button>
      )}
      {manageMode && (
        <button type="button" className="lib-card-delete-badge" onClick={(e) => { e.stopPropagation(); onDelete(); }} title="Move to trash">
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
        </button>
      )}
      {isSelected && (
        <div className="lib-card-select-check">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
        </div>
      )}
      <div className="lib-card-body">
        <span className="lib-card-name">{item.name}</span>
      </div>
    </div>
  );
}

type ContextMenuState = {
  x: number;
  y: number;
  showFolderSub: boolean;
  confirmDelete: boolean;
};

function LibAssetContextMenu({
  menu,
  selectedIds,
  items,
  folders,
  onDragAsset,
  onClose,
  setItems,
  setMenu,
}: {
  menu: ContextMenuState;
  selectedIds: Set<string>;
  items: AssetItem[];
  folders: FolderItem[];
  onDragAsset: LibraryPanelProps["onDragAsset"];
  onClose: () => void;
  setItems: React.Dispatch<React.SetStateAction<AssetItem[]>>;
  setMenu: React.Dispatch<React.SetStateAction<ContextMenuState | null>>;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const count = selectedIds.size;

  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = menu.x;
    let y = menu.y;
    if (x + rect.width > vw) x = vw - rect.width - 4;
    if (y + rect.height > vh) y = vh - rect.height - 4;
    if (x < 0) x = 4;
    if (y < 0) y = 4;
    if (x !== menu.x || y !== menu.y) {
      setMenu((p) => p ? { ...p, x, y } : p);
    }
  }, [menu.x, menu.y, setMenu]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  const selectedItems = items.filter((i) => selectedIds.has(i.id));

  const handleAddToCanvas = () => {
    for (const item of selectedItems) {
      const gradient = item.file_url || `linear-gradient(135deg, hsl(${hashCode(item.id) % 360}, 40%, 25%), hsl(${(hashCode(item.id) + 60) % 360}, 50%, 35%))`;
      onDragAsset({ id: item.id, label: item.name, gradient });
    }
    onClose();
  };

  const handleMoveToFolder = async (folderId: string) => {
    const ids = [...selectedIds];
    const results = await Promise.all(
      ids.map((id) =>
        fetch(`/api/assets/${id}/folder`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ folder_id: folderId }),
        })
      )
    );
    const movedIds = new Set(ids.filter((_, i) => results[i].ok));
    if (movedIds.size > 0) {
      setItems((prev) =>
        prev.map((i) => (movedIds.has(i.id) ? { ...i, folder_id: folderId } : i))
      );
      invalidateCache("assets:");
    }
    onClose();
  };

  const handleDownload = () => {
    for (let i = 0; i < selectedItems.length; i++) {
      const item = selectedItems[i];
      if (item.file_url) {
        const typeLabel = item.type === "video" ? "VIDEO" : "IMAGE";
        let ext = item.type === "video" ? ".mp4" : ".png";
        if (item.file_type) {
          if (item.file_type.includes("jpeg") || item.file_type.includes("jpg")) ext = ".jpg";
          else if (item.file_type.includes("webp")) ext = ".webp";
          else if (item.file_type.includes("gif")) ext = ".gif";
          else if (item.file_type.includes("svg")) ext = ".svg";
          else if (item.file_type.includes("webm")) ext = ".webm";
          else if (item.file_type.includes("quicktime") || item.file_type.includes("mov")) ext = ".mov";
        }
        const filename = `Asset_${typeLabel}_${String(i + 1).padStart(3, "0")}${ext}`;
        const a = document.createElement("a");
        a.href = item.file_url;
        a.download = filename;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
    }
    onClose();
  };

  const handleDelete = async () => {
    const ids = [...selectedIds];
    const results = await Promise.all(
      ids.map((id) =>
        fetch(`/api/assets/${id}`, { method: "DELETE", credentials: "include" })
      )
    );
    if (results.some((r) => r.ok)) {
      const deletedIds = new Set(ids.filter((_, i) => results[i].ok));
      setItems((prev) => prev.filter((i) => !deletedIds.has(i.id)));
      invalidateCache("assets:");
    }
    onClose();
  };

  return createPortal(
    <div
      ref={menuRef}
      className="lib-ctx-menu"
      style={{ left: menu.x, top: menu.y }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="lib-ctx-item"
        onClick={handleAddToCanvas}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="12" y1="8" x2="12" y2="16" /><line x1="8" y1="12" x2="16" y2="12" /></svg>
        Add to Canvas{count > 1 ? ` (${count})` : ""}
      </button>

      <div
        className="lib-ctx-item lib-ctx-item--has-sub"
        onMouseEnter={() => setMenu((p) => p ? { ...p, showFolderSub: true } : p)}
        onMouseLeave={() => setMenu((p) => p ? { ...p, showFolderSub: false } : p)}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
        Move to Folder
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginLeft: "auto" }}><polyline points="9 18 15 12 9 6" /></svg>
        {menu.showFolderSub && (
          <div className="lib-ctx-submenu">
            {folders.length === 0 ? (
              <div className="lib-ctx-item lib-ctx-item--disabled">No folders</div>
            ) : (
              folders.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className="lib-ctx-item"
                  onClick={() => handleMoveToFolder(f.id)}
                >
                  {f.name}
                </button>
              ))
            )}
          </div>
        )}
      </div>

      <button
        type="button"
        className="lib-ctx-item"
        onClick={handleDownload}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
        Download{count > 1 ? ` (${count})` : ""}
      </button>

      <div className="lib-ctx-divider" />

      {!menu.confirmDelete ? (
        <button
          type="button"
          className="lib-ctx-item lib-ctx-item--danger"
          onClick={() => setMenu((p) => p ? { ...p, confirmDelete: true } : p)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
          Delete{count > 1 ? ` ${count} items` : ""}
        </button>
      ) : (
        <button
          type="button"
          className="lib-ctx-item lib-ctx-item--danger-confirm"
          onClick={handleDelete}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
          {count > 1 ? `Confirm delete ${count} items?` : "Confirm delete?"}
        </button>
      )}
    </div>,
    document.body
  );
}

function AssetsGrid({
  view,
  onDragAsset,
  folderSelectMode,
  folderSelectedIds,
  onToggleFolderItem,
  onOpenFolderManager,
  manageMode,
  refreshKey,
  onFullscreen,
  initialFolderId,
  highlightAssetId,
  viewLayout = "grid",
}: {
  view: string;
  onDragAsset: LibraryPanelProps["onDragAsset"];
  folderSelectMode?: boolean;
  folderSelectedIds?: Map<string, { name: string; thumb: string }>;
  onToggleFolderItem?: (id: string, meta?: { name: string; thumb: string }) => void;
  onOpenFolderManager?: (folder: { id: string; name: string } | string) => void;
  manageMode?: boolean;
  refreshKey: number;
  onFullscreen: (item: AssetItem) => void;
  initialFolderId?: string | null;
  highlightAssetId?: string | null;
  viewLayout?: "grid" | "list";
}) {
  const { items: rawItems, loading, setItems, refetch } = useAssets(view, refreshKey);
  const folders = useFolders(view, refreshKey);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() =>
    initialFolderId ? new Set([initialFolderId]) : new Set()
  );
  useEffect(() => {
    if (initialFolderId) {
      setShowMode("folders");
      setExpandedFolders((prev) => {
        const next = new Set(prev);
        next.add(initialFolderId);
        return next;
      });
    }
  }, [initialFolderId]);
  useEffect(() => {
    if (!highlightAssetId) return;
    const timeout = setTimeout(() => {
      const el = document.querySelector(`[data-asset-id="${highlightAssetId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("lib-card--highlight");
        setTimeout(() => el.classList.remove("lib-card--highlight"), 2000);
      }
    }, 150);
    return () => clearTimeout(timeout);
  }, [highlightAssetId]);
  const [showMode, setShowMode] = useState<"all" | "folders">(initialFolderId ? "folders" : "all");
  const [dropOverFolder, setDropOverFolder] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const lastClickedId = useRef<string | null>(null);
  const [folderUploading, setFolderUploading] = useState<string | null>(null);
  const folderUploadRef = useRef<HTMLInputElement>(null);
  const folderUploadTargetRef = useRef<string | null>(null);

  const items = rawItems;

  const [marquee, setMarquee] = useState<{ startX: number; startY: number; curX: number; curY: number; active: boolean; containerEl: HTMLElement | null; additive: boolean } | null>(null);
  const marqueeRef = useRef(marquee);
  marqueeRef.current = marquee;
  const preMarqueeSelection = useRef<Set<string>>(new Set());

  const computeMarqueeRect = useCallback((m: NonNullable<typeof marquee>) => {
    const containerRect = m.containerEl!.getBoundingClientRect();
    return {
      left: Math.min(m.startX, m.curX) - containerRect.left,
      top: Math.min(m.startY, m.curY) - containerRect.top,
      width: Math.abs(m.curX - m.startX),
      height: Math.abs(m.curY - m.startY),
    };
  }, []);

  const updateMarqueeSelection = useCallback((m: NonNullable<typeof marquee>) => {
    if (!m.containerEl) return;
    const mLeft = Math.min(m.startX, m.curX);
    const mTop = Math.min(m.startY, m.curY);
    const mRight = Math.max(m.startX, m.curX);
    const mBottom = Math.max(m.startY, m.curY);
    const cards = m.containerEl.querySelectorAll<HTMLElement>("[data-asset-id]");
    const newIds = new Set<string>(m.additive ? preMarqueeSelection.current : []);
    cards.forEach((card) => {
      const r = card.getBoundingClientRect();
      if (r.right > mLeft && r.left < mRight && r.bottom > mTop && r.top < mBottom) {
        const id = card.getAttribute("data-asset-id");
        if (id) newIds.add(id);
      }
    });
    setSelectedIds(newIds);
  }, []);

  const handleMarqueeMouseDown = useCallback((e: React.MouseEvent) => {
    if (manageMode || folderSelectMode) return;
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest(".lib-card, .lib-folder-row, .lib-folder-cog, button")) return;
    const grid = target.closest<HTMLElement>(".lib-grid");
    if (!grid) return;
    e.preventDefault();
    const additive = e.metaKey || e.ctrlKey;
    preMarqueeSelection.current = additive ? new Set(selectedIds) : new Set();
    setMarquee({ startX: e.clientX, startY: e.clientY, curX: e.clientX, curY: e.clientY, active: false, containerEl: grid, additive });
  }, [manageMode, folderSelectMode, selectedIds]);

  useEffect(() => {
    if (!marquee) return;
    const handleMouseMove = (e: MouseEvent) => {
      e.preventDefault();
      const m = marqueeRef.current;
      if (!m) return;
      const dx = Math.abs(e.clientX - m.startX);
      const dy = Math.abs(e.clientY - m.startY);
      const isActive = m.active || dx > 4 || dy > 4;
      if (!isActive) return;
      const next = { ...m, curX: e.clientX, curY: e.clientY, active: true };
      setMarquee(next);
      updateMarqueeSelection(next);
    };
    const handleMouseUp = () => {
      setMarquee(null);
    };
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [marquee !== null, updateMarqueeSelection]);

  useEffect(() => {
    setSelectedIds(new Set());
    setCtxMenu(null);
  }, [view, refreshKey]);

  const handleCardClick = useCallback((e: React.MouseEvent, item: AssetItem, visibleItems: AssetItem[]) => {
    if (manageMode || folderSelectMode) return;
    const isMeta = e.metaKey || e.ctrlKey;
    const isShift = e.shiftKey;

    if (isMeta) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
        return next;
      });
      lastClickedId.current = item.id;
    } else if (isShift && lastClickedId.current) {
      const lastIdx = visibleItems.findIndex((i) => i.id === lastClickedId.current);
      const curIdx = visibleItems.findIndex((i) => i.id === item.id);
      if (lastIdx !== -1 && curIdx !== -1) {
        const start = Math.min(lastIdx, curIdx);
        const end = Math.max(lastIdx, curIdx);
        setSelectedIds((prev) => {
          const next = new Set(prev);
          for (let i = start; i <= end; i++) next.add(visibleItems[i].id);
          return next;
        });
      }
    } else {
      setSelectedIds(new Set([item.id]));
      lastClickedId.current = item.id;
    }
  }, [manageMode, folderSelectMode]);

  const handleContextMenu = useCallback((e: React.MouseEvent, item: AssetItem) => {
    if (manageMode || folderSelectMode) return;
    e.preventDefault();
    e.stopPropagation();
    setSelectedIds((prev) => {
      if (prev.has(item.id)) return prev;
      return new Set([item.id]);
    });
    lastClickedId.current = item.id;
    setCtxMenu({ x: e.clientX, y: e.clientY, showFolderSub: false, confirmDelete: false });
  }, [manageMode, folderSelectMode]);

  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);

  const marqueeWasActive = useRef(false);
  useEffect(() => {
    if (marquee?.active) marqueeWasActive.current = true;
    if (!marquee && marqueeWasActive.current) {
      const timer = setTimeout(() => { marqueeWasActive.current = false; }, 0);
      return () => clearTimeout(timer);
    }
  }, [marquee]);

  const handleBackgroundClick = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(".lib-card")) return;
    if (marqueeWasActive.current) return;
    setSelectedIds(new Set());
    setCtxMenu(null);
  }, []);

  const toggleFolder = useCallback((id: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const handleDragStart = useCallback((e: React.DragEvent, item: AssetItem) => {
    const makePayload = (a: AssetItem) => {
      const gradient = a.file_url || `linear-gradient(135deg, hsl(${hashCode(a.id) % 360}, 40%, 25%), hsl(${(hashCode(a.id) + 60) % 360}, 50%, 35%))`;
      return { id: a.id, label: a.name, gradient, type: a.type, url: a.file_url || "" };
    };
    const primary = makePayload(item);
    if (selectedIds.has(item.id) && selectedIds.size > 1) {
      const allPayloads = items
        .filter((a) => selectedIds.has(a.id))
        .map(makePayload);
      e.dataTransfer.setData("application/x-library-asset", JSON.stringify(primary));
      e.dataTransfer.setData("application/x-library-assets", JSON.stringify(allPayloads));
    } else {
      e.dataTransfer.setData("application/x-library-asset", JSON.stringify(primary));
    }
    e.dataTransfer.effectAllowed = "copy";

    if (item.file_url && !isVideoItem(item)) {
      const ghost = document.createElement("div");
      ghost.style.cssText = "width:48px;height:48px;border-radius:6px;overflow:hidden;position:absolute;top:-9999px;left:-9999px;box-shadow:0 2px 8px rgba(0,0,0,0.3);pointer-events:none;";
      const img = document.createElement("img");
      img.src = item.file_url;
      img.style.cssText = "width:100%;height:100%;object-fit:cover;";
      ghost.appendChild(img);
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 24, 24);
      setTimeout(() => { if (ghost.parentNode) document.body.removeChild(ghost); }, 0);
    }

    onDragAsset({ id: item.id, label: item.name, gradient: primary.gradient });
  }, [onDragAsset, selectedIds, items]);

  const handleDropToFolder = useCallback(async (e: React.DragEvent, folderId: string) => {
    e.preventDefault();
    setDropOverFolder(null);
    const libDataPlural = e.dataTransfer.getData("application/x-library-assets");
    const libData = e.dataTransfer.getData("application/x-library-asset");
    try {
      let idsToMove: string[] = [];
      if (libDataPlural) {
        const allPayloads: { id: string }[] = JSON.parse(libDataPlural);
        idsToMove = allPayloads.map((p) => p.id);
      } else if (libData) {
        const data = JSON.parse(libData);
        idsToMove = [data.id];
      }
      if (idsToMove.length === 0) return;
      const results = await Promise.all(
        idsToMove.map((id) =>
          fetch(`/api/assets/${id}/folder`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ folder_id: folderId }),
          })
        )
      );
      const movedIds = new Set(idsToMove.filter((_, i) => results[i].ok));
      if (movedIds.size > 0) {
        setItems((prev) => prev.map((i) => movedIds.has(i.id) ? { ...i, folder_id: folderId } : i));
        invalidateCache("assets:");
      }
    } catch {}
  }, [setItems]);

  const handleFolderUploadClick = useCallback((folderId: string) => {
    folderUploadTargetRef.current = folderId;
    folderUploadRef.current?.click();
  }, []);

  const handleFolderFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    const folderId = folderUploadTargetRef.current;
    if (!files || files.length === 0 || !folderId) return;
    setFolderUploading(folderId);
    try {
      const uploads = Array.from(files).map(async (file) => {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("name", file.name.replace(/\.[^.]+$/, ""));
        formData.append("type", viewToAssetType(view));
        formData.append("source", "upload");
        formData.append("folder_id", folderId);
        return fetch("/api/assets", { method: "POST", credentials: "include", body: formData });
      });
      const results = await Promise.all(uploads);
      if (results.some((r) => r.ok)) {
        invalidateCache("assets:");
        refetch();
        setExpandedFolders((prev) => { const next = new Set(prev); next.add(folderId); return next; });
      }
    } catch (err) {
      console.error("Folder upload failed:", err);
    } finally {
      setFolderUploading(null);
      folderUploadTargetRef.current = null;
      if (folderUploadRef.current) folderUploadRef.current.value = "";
    }
  }, [view, refetch, setExpandedFolders]);

  const handleDelete = useCallback(async (id: string) => {
    const res = await fetch(`/api/assets/${id}`, { method: "DELETE", credentials: "include" });
    if (res.ok) { setItems((prev) => prev.filter((i) => i.id !== id)); invalidateCache("assets:"); }
  }, [setItems]);

  if (loading) {
    return <div className="platform-empty"><span className="platform-empty-text">Loading...</span></div>;
  }

  if (items.length === 0) {
    return <EmptyState message={`No ${view} yet`} subtext="Upload files to get started" />;
  }

  const activeFolders = folders;
  const unfiledItems = items.filter((a) => !a.folder_id);

  const renderCard = (item: AssetItem, visibleItems: AssetItem[]) => (
    <AssetCard
      key={item.id}
      item={item}
      manageMode={manageMode}
      folderSelectMode={folderSelectMode}
      isFolderSelected={folderSelectMode && folderSelectedIds?.has(item.id)}
      isSelected={selectedIds.has(item.id)}
      onDragStart={(e) => handleDragStart(e, item)}
      onToggleSelect={() => onToggleFolderItem?.(item.id, { name: item.name, thumb: item.file_url || "" })}
      onDelete={() => handleDelete(item.id)}
      onFullscreen={() => onFullscreen(item)}
      onClick={(e) => handleCardClick(e, item, visibleItems)}
      onContextMenu={(e) => handleContextMenu(e, item)}
    />
  );

  return (
    <>
      <input
        ref={folderUploadRef}
        type="file"
        multiple
        accept={view === "videos" ? "video/*" : "image/*"}
        style={{ display: "none" }}
        onChange={handleFolderFileUpload}
      />
      <div className="lib-folders">
        <button type="button" className={`lib-folder-chip ${showMode === "all" ? "lib-folder-chip--active" : ""}`} onClick={() => setShowMode("all")}>All</button>
        <button type="button" className={`lib-folder-chip ${showMode === "folders" ? "lib-folder-chip--active" : ""}`} onClick={() => setShowMode("folders")}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
          Folders
        </button>
      </div>

      {showMode === "folders" ? (
        <div className="lib-folder-list" onClick={handleBackgroundClick} onMouseDown={handleMarqueeMouseDown} style={{ position: "relative" }}>
          {activeFolders.map((folder) => {
            const folderItems = items.filter((a) => a.folder_id === folder.id);
            const open = expandedFolders.has(folder.id);
            const isDragTarget = dropOverFolder === folder.id;
            return (
              <div
                key={folder.id}
                data-folder-id={folder.id}
                className={`lib-folder-group ${isDragTarget ? "lib-folder-group--drag-over" : ""}`}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes("application/x-canvas-gen") || e.dataTransfer.types.includes("application/x-library-asset") || e.dataTransfer.types.includes("application/x-library-assets")) {
                    e.preventDefault();
                    setDropOverFolder(folder.id);
                  }
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropOverFolder(null);
                }}
                onDrop={(e) => handleDropToFolder(e, folder.id)}
              >
                <div className="lib-folder-row" onClick={() => toggleFolder(folder.id)}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={`lib-folder-chevron ${open ? "lib-folder-chevron--open" : ""}`}><polyline points="6 9 12 15 18 9" /></svg>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
                  <span className="lib-folder-row-name">{folder.name}</span>
                  <span className="lib-folder-row-count">{folderItems.length}</span>
                  {folderUploading === folder.id && <span className="lib-folder-uploading-indicator" />}
                  <button
                    type="button"
                    className="lib-folder-upload-btn"
                    onClick={(e) => { e.stopPropagation(); handleFolderUploadClick(folder.id); }}
                    title="Upload to this folder"
                    disabled={folderUploading === folder.id}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 16 12 12 8 16" /><line x1="12" y1="12" x2="12" y2="21" /><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" /></svg>
                  </button>
                  <button
                    type="button"
                    className="lib-folder-cog"
                    onClick={(e) => { e.stopPropagation(); onOpenFolderManager?.({ id: folder.id, name: folder.name }); }}
                    title="Manage folder"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
                  </button>
                </div>
                {open && folderItems.length > 0 && (
                  <div className={`lib-grid lib-grid--nested${viewLayout === "list" ? " lib-grid--list" : ""}`}>
                    {folderItems.map((item) => renderCard(item, folderItems))}
                  </div>
                )}
                {open && folderItems.length === 0 && (
                  <div className="lib-folder-drop-hint">
                    <span>Empty folder — drag items here</span>
                  </div>
                )}
                {!open && (
                  <div className="lib-folder-drop-hint">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                    <span>Drop here to add</span>
                  </div>
                )}
              </div>
            );
          })}
          {unfiledItems.length > 0 && (
            <div className="lib-folder-group">
              <div className="lib-folder-row lib-folder-row--unfiled">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></svg>
                <span className="lib-folder-row-name">Unfiled</span>
                <span className="lib-folder-row-count">{unfiledItems.length}</span>
              </div>
              <div className={`lib-grid lib-grid--nested${viewLayout === "list" ? " lib-grid--list" : ""}`}>
                {unfiledItems.map((item) => renderCard(item, unfiledItems))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className={`lib-grid${viewLayout === "list" ? " lib-grid--list" : ""}`} onClick={handleBackgroundClick} onMouseDown={handleMarqueeMouseDown} style={{ position: "relative" }}>
          {items.map((item) => renderCard(item, items))}
        </div>
      )}

      {marquee?.active && marquee.containerEl && (() => {
        const rect = computeMarqueeRect(marquee);
        const containerRect = marquee.containerEl.getBoundingClientRect();
        return createPortal(
          <div
            className="lib-marquee-overlay"
            style={{
              position: "fixed",
              left: containerRect.left + rect.left,
              top: containerRect.top + rect.top,
              width: rect.width,
              height: rect.height,
            }}
          />,
          document.body,
        );
      })()}

      {ctxMenu && selectedIds.size > 0 && (
        <LibAssetContextMenu
          menu={ctxMenu}
          selectedIds={selectedIds}
          items={items}
          folders={folders}
          onDragAsset={onDragAsset}
          onClose={closeCtxMenu}
          setItems={setItems}
          setMenu={setCtxMenu}
        />
      )}
    </>
  );
}

type AxiomItem = {
  id: string;
  name: string;
  description: string;
  images: string[];
  bucket_id: string | null;
};

function useAxioms(refreshKey: number) {
  const { activeWorkspace } = useWorkspace();
  const wsKey = activeWorkspace?.type === "org" && activeWorkspace?.id ? `org:${activeWorkspace.id}` : "personal";
  const cacheKey = `axioms:${wsKey}`;
  const cached = getCached<AxiomItem[]>(cacheKey);
  const [axioms, setAxioms] = useState<AxiomItem[]>(cached?.data ?? []);
  const [loading, setLoading] = useState(!cached);
  const prevRefreshKey = useRef(refreshKey);

  useEffect(() => {
    const forced = prevRefreshKey.current !== refreshKey;
    prevRefreshKey.current = refreshKey;
    const entry = getCached<AxiomItem[]>(cacheKey);
    if (!forced && entry && !entry.stale) { setAxioms(entry.data); setLoading(false); return; }
    if (!entry) setLoading(true);
    const params = new URLSearchParams();
    if (activeWorkspace?.type === "org" && activeWorkspace.id) {
      params.set("scope", "org");
      params.set("workspace_id", activeWorkspace.id);
    }
    fetch(`/api/axioms?${params}`, { credentials: "include" })
      .then((r) => r.json())
      .then((d) => { const list = d.axioms || []; setCached(cacheKey, list); setAxioms(list); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [activeWorkspace?.id, activeWorkspace?.type, cacheKey, refreshKey]);

  return { axioms, loading };
}

function AxiomsGrid({ source, onDragAsset, onOpenAxiomManager, refreshKey = 0, viewLayout = "grid" }: { source: SourceTab; onDragAsset: LibraryPanelProps["onDragAsset"]; onOpenAxiomManager?: (id: string) => void; refreshKey?: number; viewLayout?: "grid" | "list" }) {
  const buckets = useBuckets("axioms");
  const { axioms, loading } = useAxioms(refreshKey);
  const bucketNames = ["All", ...buckets.map((b) => b.name)];
  const bucketMap = Object.fromEntries(buckets.map((b) => [b.id, b.name]));
  const [activeBucket, setActiveBucket] = useState("All");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedPlatformItem, setSelectedPlatformItem] = useState<PlatformItem | null>(null);
  const { items: platformItems, loading: platformLoading, error: platformError, refetch: platformRefetch } = usePlatformItems(source === "platform" ? "axiom_template" : undefined);

  const bucketFiltered = activeBucket === "All"
    ? axioms
    : axioms.filter((a) => a.bucket_id && bucketMap[a.bucket_id] === activeBucket);
  const q = searchQuery.trim().toLowerCase();
  const searchMatches = q
    ? bucketFiltered.filter((a) => (a.name || "").toLowerCase().includes(q) || (a.description || "").toLowerCase().includes(q))
    : null;
  const noSearchResults = q !== "" && searchMatches !== null && searchMatches.length === 0;
  const filteredAxioms = searchMatches && searchMatches.length > 0 ? searchMatches : bucketFiltered;

  if (selectedPlatformItem) {
    return (
      <PlatformPurchasePanel
        item={selectedPlatformItem}
        onClose={() => setSelectedPlatformItem(null)}
        onPurchaseComplete={() => setSelectedPlatformItem(null)}
      />
    );
  }

  if (source === "platform") {
    return <PlatformGrid items={platformItems} loading={platformLoading} error={platformError} onRetry={platformRefetch} onSelectItem={setSelectedPlatformItem} viewLayout={viewLayout} />;
  }

  const handleDragStart = (e: React.DragEvent, axiom: AxiomItem) => {
    const thumb = axiom.images?.[0] || "";
    e.dataTransfer.setData("application/x-axiom", JSON.stringify({ axiomId: axiom.id, axiomName: axiom.name, axiomDescription: axiom.description, axiomThumb: thumb, axiomImages: axiom.images || [] }));
    onDragAsset?.({ id: axiom.id, label: axiom.name, gradient: thumb });
  };

  return (
    <>
      <div className="lib-search">
        <svg className="lib-search-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="text"
          className="lib-search-input"
          placeholder="Search products"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        {searchQuery && (
          <button type="button" className="lib-search-clear" aria-label="Clear search" onClick={() => setSearchQuery("")}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      {bucketNames.length > 1 && (
        <div className="lib-folders">
          {bucketNames.map((b) => (
            <button key={b} type="button" className={`lib-folder-chip ${activeBucket === b ? "lib-folder-chip--active" : ""}`} onClick={() => setActiveBucket(b)}>{b}</button>
          ))}
        </div>
      )}

      {noSearchResults && (
        <div className="lib-search-hint">No matches for "{searchQuery}" — showing all</div>
      )}

      {loading ? (
        <EmptyState message="Loading..." />
      ) : filteredAxioms.length > 0 ? (
        <div className={`lib-grid${viewLayout === "list" ? " lib-grid--list" : ""}`}>
          {filteredAxioms.map((axiom) => {
            const thumb = Array.isArray(axiom.images) && axiom.images.length > 0 ? axiom.images[0] : "";
            return (
              <div
                key={axiom.id}
                className="lib-card lib-card--has-cog"
                draggable
                onDragStart={(e) => handleDragStart(e, axiom)}
              >
                <div className="lib-card-thumb" style={thumb ? { backgroundImage: `url(${thumb})`, backgroundSize: "contain", backgroundRepeat: "no-repeat", backgroundPosition: "center" } : { background: `linear-gradient(135deg, hsl(${Math.abs(hashCode(axiom.id)) % 360}, 40%, 20%), hsl(${(Math.abs(hashCode(axiom.id)) + 60) % 360}, 50%, 35%))` }} />
                {onOpenAxiomManager && (
                  <button type="button" className="lib-card-cog" onClick={() => onOpenAxiomManager(axiom.id)}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                    </svg>
                  </button>
                )}
                <div className="lib-card-body">
                  <span className="lib-card-name">{axiom.name}</span>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyState message="No products yet" subtext="Create products to build your visual language" />
      )}
    </>
  );
}

type StyleItem = {
  id: string;
  name: string;
  prompt: string;
  image_url: string | null;
  bucket_id: string | null;
};

function useStyles(refreshKey: number) {
  const { activeWorkspace } = useWorkspace();
  const wsKey = activeWorkspace?.type === "org" && activeWorkspace?.id ? `org:${activeWorkspace.id}` : "personal";
  const cacheKey = `styles:${wsKey}`;
  const cached = getCached<StyleItem[]>(cacheKey);
  const [styles, setStyles] = useState<StyleItem[]>(cached?.data ?? []);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState(false);
  const prevRefreshKey = useRef(refreshKey);

  useEffect(() => {
    const forced = prevRefreshKey.current !== refreshKey;
    prevRefreshKey.current = refreshKey;
    const entry = getCached<StyleItem[]>(cacheKey);
    if (!forced && entry && !entry.stale) { setStyles(entry.data); setLoading(false); setError(false); return; }
    if (!entry) setLoading(true);
    setError(false);
    const params = new URLSearchParams();
    if (activeWorkspace?.type === "org" && activeWorkspace.id) {
      params.set("scope", "org");
      params.set("workspace_id", activeWorkspace.id);
    }
    fetch(`/api/styles?${params}`, { credentials: "include" })
      .then((r) => { if (!r.ok) throw new Error("Failed to fetch"); return r.json(); })
      .then((d) => { const list = d.styles || []; setCached(cacheKey, list); setStyles(list); })
      .catch(() => { setError(true); })
      .finally(() => setLoading(false));
  }, [activeWorkspace?.id, activeWorkspace?.type, cacheKey, refreshKey]);

  return { styles, loading, error };
}

function StylesGrid({ source, onDragStyle, onOpenStyleManager, refreshKey = 0, viewLayout = "grid" }: { source: SourceTab; onDragStyle: LibraryPanelProps["onDragStyle"]; onOpenStyleManager?: (id: string) => void; refreshKey?: number; viewLayout?: "grid" | "list" }) {
  const buckets = useBuckets("styles");
  const { styles, loading, error } = useStyles(refreshKey);
  const bucketNames = ["All", ...buckets.map((b) => b.name)];
  const bucketMap = Object.fromEntries(buckets.map((b) => [b.id, b.name]));
  const [activeBucket, setActiveBucket] = useState("All");
  const [selectedPlatformItem, setSelectedPlatformItem] = useState<PlatformItem | null>(null);
  const { items: platformItems, loading: platformLoading, error: platformError, refetch: platformRefetch } = usePlatformItems(source === "platform" ? "style_pack" : undefined);

  const filteredStyles = activeBucket === "All"
    ? styles
    : styles.filter((s) => s.bucket_id && bucketMap[s.bucket_id] === activeBucket);

  if (selectedPlatformItem) {
    return (
      <PlatformPurchasePanel
        item={selectedPlatformItem}
        onClose={() => setSelectedPlatformItem(null)}
        onPurchaseComplete={() => setSelectedPlatformItem(null)}
      />
    );
  }

  if (source === "platform") {
    return <PlatformGrid items={platformItems} loading={platformLoading} error={platformError} onRetry={platformRefetch} onSelectItem={setSelectedPlatformItem} viewLayout={viewLayout} />;
  }

  const handleDragStart = (e: React.DragEvent, style: StyleItem) => {
    e.dataTransfer.setData("application/x-style", JSON.stringify({ styleId: style.id, styleName: style.name, stylePrompt: style.prompt }));
    e.dataTransfer.setData("application/x-style-prompt", style.prompt);
    onDragStyle?.(style.prompt);
  };

  return (
    <>
      {bucketNames.length > 1 && (
        <div className="lib-folders">
          {bucketNames.map((b) => (
            <button key={b} type="button" className={`lib-folder-chip ${activeBucket === b ? "lib-folder-chip--active" : ""}`} onClick={() => setActiveBucket(b)}>{b}</button>
          ))}
        </div>
      )}

      {loading ? (
        <EmptyState message="Loading..." />
      ) : error ? (
        <EmptyState message="Failed to load prompts" subtext="Please try again later" />
      ) : filteredStyles.length > 0 ? (
        <div className={`lib-grid${viewLayout === "list" ? " lib-grid--list" : ""}`}>
          {filteredStyles.map((style) => {
            const thumb = style.image_url || "";
            return (
              <div
                key={style.id}
                className="lib-card lib-card--has-cog"
                draggable
                onDragStart={(e) => handleDragStart(e, style)}
                onClick={() => onOpenStyleManager?.(style.id)}
                style={{ cursor: "pointer" }}
              >
                <div className="lib-card-thumb" style={thumb ? { backgroundImage: `url(${thumb})`, backgroundSize: "cover", backgroundPosition: "center" } : { background: `linear-gradient(135deg, hsl(${hashCode(style.id) % 360}, 40%, 20%), hsl(${(hashCode(style.id) + 60) % 360}, 50%, 35%))` }} />
                {onOpenStyleManager && (
                  <button type="button" className="lib-card-cog" onClick={(e) => { e.stopPropagation(); onOpenStyleManager(style.id); }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                    </svg>
                  </button>
                )}
                <div className="lib-card-body">
                  <span className="lib-card-name">{style.name}</span>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyState message="No prompts yet" subtext="Save a cut, or create one, to build your library" />
      )}
    </>
  );
}

function resolveLibAudioType(meta: any): LibAudioType | null {
  const raw = meta?.type || meta?.clip_type || null;
  if (!raw) return null;
  if (raw in LIB_TYPE_CONFIG) return raw as LibAudioType;
  const MAP: Record<string, LibAudioType> = { voice: "tts", sound_effect: "sfx" };
  return MAP[raw] || null;
}

function LibAudioWaveRow({ item, playingId, onPlay, onStop, onDelete, manageMode, activeWsRef, onDragAsset }: {
  item: AudioItem;
  playingId: string | null;
  onPlay: (item: AudioItem, ws: WaveSurfer) => void;
  onStop: () => void;
  onDelete: (id: string) => void;
  manageMode?: boolean;
  activeWsRef: React.MutableRefObject<WaveSurfer | null>;
  onDragAsset?: (info: { id: string; label: string; gradient: string }) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [totalDuration, setTotalDuration] = useState(item.duration_seconds || 0);

  const meta = item.metadata || {};
  const audioType = resolveLibAudioType(meta);
  const typeConfig = audioType ? LIB_TYPE_CONFIG[audioType] : null;
  const style = meta.style || null;

  useEffect(() => {
    if (!containerRef.current || !item.file_url) return;

    const waveColor = typeConfig?.waveColor || "rgba(255, 255, 255, 0.2)";
    const progressColor = typeConfig?.progressColor || "var(--accent)";

    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor,
      progressColor,
      cursorColor: progressColor,
      cursorWidth: 2,
      barWidth: 2,
      barGap: 1.5,
      barRadius: 2,
      height: 36,
      normalize: true,
      backend: "WebAudio",
      url: item.file_url,
    });

    ws.on("ready", () => {
      setTotalDuration(ws.getDuration());
      setReady(true);
    });

    ws.on("timeupdate", (time: number) => {
      setCurrentTime(time);
    });

    ws.on("play", () => setPlaying(true));
    ws.on("pause", () => setPlaying(false));
    ws.on("finish", () => {
      setPlaying(false);
      onStop();
    });

    wsRef.current = ws;

    return () => {
      if (activeWsRef.current === ws) {
        activeWsRef.current = null;
      }
      ws.destroy();
      wsRef.current = null;
      setReady(false);
    };
  }, [item.file_url]);

  useEffect(() => {
    if (playingId !== item.id && wsRef.current) {
      wsRef.current.pause();
    }
  }, [playingId, item.id]);

  const togglePlay = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || !ready) return;

    if (playing) {
      ws.pause();
      onStop();
    } else {
      if (activeWsRef.current && activeWsRef.current !== ws) {
        activeWsRef.current.pause();
      }
      onPlay(item, ws);
      ws.play();
    }
  }, [playing, ready, item, onPlay, onStop, activeWsRef]);

  const isPlaying = playingId === item.id && playing;

  const handleAudioDragStart = useCallback((e: React.DragEvent) => {
    const audioClass = item.audio_class;
    const typeMap: Record<string, string> = { music: "music", voice: "tts", sound_effect: "sfx" };
    const payload = {
      id: item.id,
      label: item.name,
      gradient: item.file_url,
      type: typeMap[audioClass] || "music",
      duration: totalDuration || item.duration_seconds || 5,
    };
    e.dataTransfer.setData("application/x-library-asset", JSON.stringify(payload));
    e.dataTransfer.effectAllowed = "copy";
    if (onDragAsset) onDragAsset({ id: item.id, label: item.name, gradient: item.file_url });
  }, [item, totalDuration, onDragAsset]);

  return (
    <div
      className={`lib-audio-row lib-audio-row--card ${isPlaying ? "lib-audio-row--playing" : ""} ${manageMode ? "lib-audio-row--shaking" : ""}`}
      draggable
      onDragStart={handleAudioDragStart}
    >
      <div className="lib-audio-row-top">
        <div className="lib-audio-play" onClick={(e) => { e.stopPropagation(); togglePlay(); }}>
          {isPlaying ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
          )}
        </div>
        <div className="lib-audio-meta">
          <span className="lib-audio-name">{item.name}</span>
          <div className="lib-audio-tags">
            {typeConfig && (
              <span className={`lib-type-badge ${typeConfig.className}`}>{typeConfig.label}</span>
            )}
            {style && (
              <span className="lib-style-tag">{style}</span>
            )}
          </div>
        </div>
        <span className="lib-audio-time">
          {formatDuration(currentTime)} / {formatDuration(totalDuration)}
        </span>
        {manageMode && (
          <button type="button" className="lib-card-delete-badge lib-card-delete-badge--inline" onClick={() => onDelete(item.id)} title="Move to trash">
            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        )}
      </div>
      <div ref={containerRef} className="lib-wavesurfer-container" />
    </div>
  );
}

function AudioGrid({ view, onOpenFolderManager, manageMode, refreshKey, onDragAsset }: { view: string; onOpenFolderManager?: (folder: { id: string; name: string } | string) => void; manageMode?: boolean; refreshKey: number; onDragAsset?: (info: { id: string; label: string; gradient: string }) => void }) {
  const { items: rawItems, loading, setItems, refetch } = useAudioAssets(view, refreshKey);
  const folders = useFolders(view, refreshKey);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [showMode, setShowMode] = useState<"all" | "folders">("all");
  const [folderUploading, setFolderUploading] = useState<string | null>(null);
  const folderUploadRef = useRef<HTMLInputElement>(null);
  const folderUploadTargetRef = useRef<string | null>(null);

  const items = rawItems;
  const [playingId, setPlayingId] = useState<string | null>(null);
  const activeWsRef = useRef<WaveSurfer | null>(null);

  const handlePlay = useCallback((_item: AudioItem, ws: WaveSurfer) => {
    if (activeWsRef.current && activeWsRef.current !== ws) {
      activeWsRef.current.pause();
    }
    activeWsRef.current = ws;
    setPlayingId(_item.id);
  }, []);

  const handleStop = useCallback(() => {
    activeWsRef.current = null;
    setPlayingId(null);
  }, []);

  const toggleFolder = useCallback((id: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const handleAudioFolderUploadClick = useCallback((folderId: string) => {
    folderUploadTargetRef.current = folderId;
    folderUploadRef.current?.click();
  }, []);

  const handleAudioFolderFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    const folderId = folderUploadTargetRef.current;
    if (!files || files.length === 0 || !folderId) return;
    setFolderUploading(folderId);
    try {
      const uploads = Array.from(files).map(async (file) => {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("name", file.name.replace(/\.[^.]+$/, ""));
        formData.append("audio_class", viewToAudioClass(view));
        formData.append("folder_id", folderId);
        return fetch("/api/audio", { method: "POST", credentials: "include", body: formData });
      });
      const results = await Promise.all(uploads);
      if (results.some((r) => r.ok)) {
        invalidateCache("audio:");
        refetch();
        setExpandedFolders((prev) => { const next = new Set(prev); next.add(folderId); return next; });
      }
    } catch (err) {
      console.error("Audio folder upload failed:", err);
    } finally {
      setFolderUploading(null);
      folderUploadTargetRef.current = null;
      if (folderUploadRef.current) folderUploadRef.current.value = "";
    }
  }, [view, refetch, setExpandedFolders]);

  const handleDelete = useCallback(async (id: string) => {
    if (playingId === id) {
      if (activeWsRef.current) {
        activeWsRef.current.pause();
        activeWsRef.current = null;
      }
      setPlayingId(null);
    }
    const res = await fetch(`/api/audio/${id}`, { method: "DELETE", credentials: "include" });
    if (res.ok) { setItems((prev) => prev.filter((i) => i.id !== id)); invalidateCache("audio:"); }
  }, [setItems, playingId]);

  if (loading) {
    return <div className="platform-empty"><span className="platform-empty-text">Loading...</span></div>;
  }

  if (items.length === 0) {
    const label = view === "music" ? "music" : view === "voices" ? "voices" : "sound effects";
    return <EmptyState message={`No ${label} yet`} subtext="Upload audio files to get started" />;
  }

  const unfiledItems = items.filter((a) => !a.folder_id);

  const renderAudioRow = (item: AudioItem) => (
    <LibAudioWaveRow
      key={item.id}
      item={item}
      playingId={playingId}
      onPlay={handlePlay}
      onStop={handleStop}
      onDelete={handleDelete}
      manageMode={manageMode}
      activeWsRef={activeWsRef}
      onDragAsset={onDragAsset}
    />
  );

  return (
    <>
      <input
        ref={folderUploadRef}
        type="file"
        multiple
        accept="audio/*"
        style={{ display: "none" }}
        onChange={handleAudioFolderFileUpload}
      />
      <div className="lib-folders">
        <button type="button" className={`lib-folder-chip ${showMode === "all" ? "lib-folder-chip--active" : ""}`} onClick={() => setShowMode("all")}>All</button>
        <button type="button" className={`lib-folder-chip ${showMode === "folders" ? "lib-folder-chip--active" : ""}`} onClick={() => setShowMode("folders")}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
          Folders
        </button>
      </div>

      {showMode === "folders" ? (
        <div className="lib-folder-list">
          {folders.map((folder) => {
            const folderItems = items.filter((a) => a.folder_id === folder.id);
            const open = expandedFolders.has(folder.id);
            return (
              <div key={folder.id} className="lib-folder-group">
                <div className="lib-folder-row" onClick={() => toggleFolder(folder.id)}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={`lib-folder-chevron ${open ? "lib-folder-chevron--open" : ""}`}><polyline points="6 9 12 15 18 9" /></svg>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
                  <span className="lib-folder-row-name">{folder.name}</span>
                  <span className="lib-folder-row-count">{folderItems.length}</span>
                  {folderUploading === folder.id && <span className="lib-folder-uploading-indicator" />}
                  <button
                    type="button"
                    className="lib-folder-upload-btn"
                    onClick={(e) => { e.stopPropagation(); handleAudioFolderUploadClick(folder.id); }}
                    title="Upload to this folder"
                    disabled={folderUploading === folder.id}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 16 12 12 8 16" /><line x1="12" y1="12" x2="12" y2="21" /><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" /></svg>
                  </button>
                  <button
                    type="button"
                    className="lib-folder-cog"
                    onClick={(e) => { e.stopPropagation(); onOpenFolderManager?.({ id: folder.id, name: folder.name }); }}
                    title="Manage folder"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
                  </button>
                </div>
                {open && folderItems.length > 0 && (
                  <div className="lib-audio-list lib-audio-list--nested">
                    {folderItems.map(renderAudioRow)}
                  </div>
                )}
                {open && folderItems.length === 0 && (
                  <div className="lib-folder-drop-hint">
                    <span>Empty folder</span>
                  </div>
                )}
              </div>
            );
          })}
          {unfiledItems.length > 0 && (
            <div className="lib-folder-group">
              <div className="lib-folder-row lib-folder-row--unfiled">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
                </svg>
                <span className="lib-folder-row-name">Unfiled</span>
                <span className="lib-folder-row-count">{unfiledItems.length}</span>
              </div>
              <div className="lib-audio-list lib-audio-list--nested">
                {unfiledItems.map(renderAudioRow)}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="lib-audio-list">
          {items.map((item) => renderAudioRow(item))}
        </div>
      )}
    </>
  );
}

type TrashItem = {
  id: string;
  name: string;
  trash_type: "asset" | "audio";
  type?: string;
  audio_class?: string;
  file_url?: string;
  deleted_at: string;
  metadata?: any;
};

function formatTimeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / 86400000);
  if (days < 1) return "today";
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  return "30+ days ago";
}

function TrashGrid() {
  const [items, setItems] = useState<TrashItem[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchTrash = useCallback(() => {
    setLoading(true);
    fetch("/api/trash", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => setItems(d.items || []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchTrash(); }, [fetchTrash]);

  const handleRestore = useCallback(async (item: TrashItem) => {
    const res = await fetch(`/api/trash/restore/${item.trash_type}/${item.id}`, { method: "PUT", credentials: "include" });
    if (res.ok) { setItems((prev) => prev.filter((i) => i.id !== item.id)); invalidateCache("assets:"); invalidateCache("audio:"); }
  }, []);

  const handleDelete = useCallback(async (item: TrashItem) => {
    const res = await fetch(`/api/trash/${item.trash_type}/${item.id}`, { method: "DELETE", credentials: "include" });
    if (res.ok) setItems((prev) => prev.filter((i) => i.id !== item.id));
  }, []);

  const handleEmptyTrash = useCallback(async () => {
    const res = await fetch("/api/trash/empty", { method: "DELETE", credentials: "include" });
    if (res.ok) setItems([]);
  }, []);

  if (loading) {
    return <div className="platform-empty"><span className="platform-empty-text">Loading trash...</span></div>;
  }

  if (items.length === 0) {
    return (
      <div className="platform-empty">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
        <span className="platform-empty-text">Trash is empty</span>
        <span className="platform-empty-text" style={{ fontSize: "10px", opacity: 0.5 }}>Deleted items appear here for 30 days</span>
      </div>
    );
  }

  return (
    <>
      <div className="trash-header-bar">
        <span className="trash-count">{items.length} item{items.length !== 1 ? "s" : ""}</span>
        <button type="button" className="lib-header-btn lib-header-btn--danger" onClick={handleEmptyTrash}>
          Empty Trash
        </button>
      </div>
      <div className="trash-list">
        {items.map((item) => (
          <div key={item.id} className="trash-row">
            <div className="trash-row-icon">
              {item.trash_type === "audio" ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></svg>
              )}
            </div>
            <div className="trash-row-info">
              <span className="trash-row-name">{item.name}</span>
              <span className="trash-row-meta">{item.trash_type === "audio" ? item.audio_class : item.type} · deleted {formatTimeAgo(item.deleted_at)}</span>
            </div>
            <div className="trash-row-actions">
              <button type="button" className="trash-action-btn" onClick={() => handleRestore(item)} title="Restore">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /></svg>
              </button>
              <button type="button" className="trash-action-btn trash-action-btn--danger" onClick={() => handleDelete(item)} title="Delete permanently">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/* ─── Main panel ─── */

export function LibraryPanel({ view, onClose, onDragAsset, onDragStyle, onOpenAxiomCreator, onOpenStyleCreator, onOpenBucketManager, onOpenFolderCreator, onOpenFolderManager, onOpenAxiomManager, onOpenStyleManager, folderSelectMode, folderSelectedIds, onToggleFolderItem, folderRefreshKey = 0, axiomRefreshKey = 0, styleRefreshKey = 0, assetRefreshKey = 0, initialFolderId, highlightAssetId }: LibraryPanelProps) {
  const title = VIEW_TITLES[view] || view;
  const asset = isAssetView(view);
  const audio = isAudioView(view);
  const isAxioms = view === "axioms";
  const isStyles = view === "styles";
  const isTrash = view === "trash";
  const showSourceTabs = false;

  const [source, setSource] = useState<SourceTab>("mine");
  const isPlatform = source === "platform";
  const canEdit = useCanEditAxiomsStyles();

  const [manageMode, setManageMode] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [fullscreenItem, setFullscreenItem] = useState<AssetItem | null>(null);
  const [viewLayout, setViewLayout] = useState<"grid" | "list">("grid");

  useEffect(() => {
    if (!showSourceTabs) setSource("mine");
  }, [showSourceTabs]);

  useEffect(() => {
    setManageMode(false);
  }, [view]);

  const uploadRef = useRef<HTMLInputElement>(null);
  const handleUploadClick = () => uploadRef.current?.click();

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);

    let successCount = 0;
    try {
      for (const file of Array.from(files)) {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("name", file.name.replace(/\.[^.]+$/, ""));

        let res: Response;
        if (audio) {
          formData.append("audio_class", viewToAudioClass(view));
          res = await fetch("/api/audio", {
            method: "POST",
            credentials: "include",
            body: formData,
          });
        } else {
          formData.append("type", viewToAssetType(view));
          formData.append("source", "upload");
          res = await fetch("/api/assets", {
            method: "POST",
            credentials: "include",
            body: formData,
          });
        }
        if (res.ok) {
          successCount++;
        } else {
          console.error("Upload failed for", file.name, await res.text());
        }
      }
      if (successCount > 0) setRefreshKey((k) => k + 1);
    } catch (err) {
      console.error("Upload failed:", err);
      if (successCount > 0) setRefreshKey((k) => k + 1);
    } finally {
      setUploading(false);
      if (uploadRef.current) uploadRef.current.value = "";
    }
  }, [audio, view]);

  const showManageGear = (asset || audio) && !isTrash;

  return (
    <div className={`lib-panel ${manageMode ? "lib-panel--manage" : ""}`}>
      <input
        ref={uploadRef}
        type="file"
        multiple
        accept={audio ? "audio/*" : "image/*,video/*"}
        style={{ display: "none" }}
        onChange={handleFileUpload}
      />
      <div className="lib-header">
        <h2 className="lib-title">{title}</h2>
        <div className="lib-header-actions">
          {showManageGear && !manageMode && (
            <button
              type="button"
              className="lib-header-btn lib-header-btn--manage"
              onClick={() => setManageMode(true)}
              title="Manage items"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
            </button>
          )}
          {asset && !manageMode && (
            <>
              <button type="button" className="lib-header-btn" onClick={onOpenFolderCreator}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
                New Folder
              </button>
              <button type="button" className="lib-header-btn" onClick={handleUploadClick} disabled={uploading}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 16 12 12 8 16" /><line x1="12" y1="12" x2="12" y2="21" /><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" /></svg>
                {uploading ? "Uploading..." : "Upload"}
              </button>
            </>
          )}
          {isAxioms && !isPlatform && canEdit && (
            <>
              <button type="button" className="lib-header-btn" onClick={onOpenAxiomCreator}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                New Product
              </button>
              <button type="button" className="lib-header-btn" onClick={() => onOpenBucketManager?.("axioms")}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
                Buckets
              </button>
            </>
          )}
          {isStyles && !isPlatform && canEdit && (
            <>
              <button type="button" className="lib-header-btn" onClick={onOpenStyleCreator}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                New Style
              </button>
              <button type="button" className="lib-header-btn" onClick={() => onOpenBucketManager?.("styles")}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
                Buckets
              </button>
            </>
          )}
          {audio && !manageMode && (
            <>
              <button type="button" className="lib-header-btn" onClick={onOpenFolderCreator}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
                New Folder
              </button>
              <button type="button" className="lib-header-btn" onClick={handleUploadClick} disabled={uploading}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 16 12 12 8 16" /><line x1="12" y1="12" x2="12" y2="21" /><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" /></svg>
                {uploading ? "Uploading..." : "Upload"}
              </button>
            </>
          )}
          {manageMode && (
            <>
              <button type="button" className="lib-header-btn lib-header-btn--delete" onClick={() => setManageMode(true)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                Delete
              </button>
              <button type="button" className="lib-header-btn lib-header-btn--done" onClick={() => setManageMode(false)}>
                Done
              </button>
            </>
          )}
          {!isTrash && !audio && (
            <button
              type="button"
              className="lib-view-toggle"
              onClick={() => setViewLayout((v) => v === "grid" ? "list" : "grid")}
              title={viewLayout === "grid" ? "Switch to list view" : "Switch to grid view"}
            >
              {viewLayout === "grid" ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></svg>
              )}
            </button>
          )}
          <button type="button" className="lib-close" onClick={onClose}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
      </div>

      {showSourceTabs && <SourceTabs active={source} onChange={setSource} />}

      <div className="lib-body">
        {asset && <AssetsGrid view={view} onDragAsset={onDragAsset} folderSelectMode={folderSelectMode} folderSelectedIds={folderSelectedIds} onToggleFolderItem={onToggleFolderItem} onOpenFolderManager={onOpenFolderManager} manageMode={manageMode} refreshKey={refreshKey + folderRefreshKey + assetRefreshKey} onFullscreen={setFullscreenItem} initialFolderId={initialFolderId} highlightAssetId={highlightAssetId} viewLayout={viewLayout} />}
        {isAxioms && <AxiomsGrid source={source} onDragAsset={onDragAsset} onOpenAxiomManager={onOpenAxiomManager} refreshKey={axiomRefreshKey} viewLayout={viewLayout} />}
        {isStyles && <StylesGrid source={source} onDragStyle={onDragStyle} onOpenStyleManager={onOpenStyleManager} refreshKey={styleRefreshKey} viewLayout={viewLayout} />}
        {audio && <AudioGrid view={view} onOpenFolderManager={onOpenFolderManager} manageMode={manageMode} refreshKey={refreshKey + folderRefreshKey + assetRefreshKey} onDragAsset={onDragAsset} />}
        {isTrash && <TrashGrid />}
      </div>

      {fullscreenItem && <FullscreenOverlay item={fullscreenItem} onClose={() => setFullscreenItem(null)} />}
    </div>
  );
}
