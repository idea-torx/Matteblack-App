import { useState, useCallback, useRef, useMemo, useEffect, lazy, Suspense } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { getDefaultFrameFill, applyTheme, getStoredTheme } from "./theme";
import { useGenerationSound } from "./hooks/useGenerationSound";
import { useCreditsContext } from "./contexts/CreditsContext";
import { useWorkspace } from "./contexts/WorkspaceContext";
import { IconRail, type RailView } from "./components/IconRail";
import { QuantumThinking } from "./components/QuantumThinking";
import { QuickSettingsPanel } from "./components/QuickSettingsPanel";
import { type ProjectsHandlers } from "./components/ProjectsSidePanel";
import { useNotifications } from "./hooks/useNotifications";
import { LeftToolbar, type ToolId, type PageMode } from "./components/LeftToolbar";
import { GENERATION_LOOKUP } from "./components/demoGenerations";
import { FreeformCanvas, type ReferenceImage } from "./components/FreeformCanvas";
import { useCinemaGeneration } from "./features/cinema-canvas";
import { invalidateCanvasEntry as invalidateCanvasCache, setCanvasReadOnly } from "./services/CanvasStore";
import { useAuth } from "./contexts/AuthContext";
import { ShareModal } from "./components/ShareModal";
import { invalidate as invalidateAssetCache } from "./services/AssetCache";
import { findEmptySlots, placeholderSize } from "./utils/canvasPlacement";
import { SelectionContextPanel } from "./components/SelectionContextPanel";
import { LibraryPanel } from "./components/LibraryPanel";
import { UpscalePanel } from "./components/UpscalePanel";
import { ResizePanel } from "./components/ResizePanel";
import { RemovePanel } from "./components/RemovePanel";
import { MakePanel, type GenerationParams } from "./components/MakePanel";
import { AudioPanel, type TTSParams } from "./components/AudioPanel";
import { MusicPanel, type MusicGenerationParams } from "./components/MusicPanel";
import { VoiceChangerPanel, type VoiceChangerParams } from "./components/VoiceChangerPanel";
import { SfxPanel, type SfxParams } from "./components/SfxPanel";
import { AudioListCanvas, randomBars, type AudioClip, type AudioType, type AudioGenerationParams } from "./components/AudioListCanvas";
import { generateClipName } from "./utils/clipNameGenerator";
import { GifMakerPanel } from "./components/GifMakerPanel";
import { AvatarPanel } from "./components/AvatarPanel";
const VectorPanel = lazy(() => import("./components/VectorPanel").then(m => ({ default: m.VectorPanel })));
import { AxiomCreatorPanel } from "./components/AxiomCreatorPanel";
import { StyleCreatorPanel } from "./components/StyleCreatorPanel";
import { BucketManagerPanel } from "./components/BucketManagerPanel";
import { FolderCreatorPanel } from "./components/FolderCreatorPanel";
import { FolderManagerPanel } from "./components/FolderManagerPanel";
import { AxiomManagerPanel } from "./components/AxiomManagerPanel";
import { StyleManagerPanel } from "./components/StyleManagerPanel";
import { SettingsPage } from "./components/SettingsPage";
import { SettingsPanel } from "./components/SettingsPanel";
import { ClearcheckPanel, type AuditRecord } from "./components/ClearcheckPanel";
import { AuditLogPanel } from "./components/AuditLogPanel";
import { DesignPanel } from "./components/DesignPanel";
import { findOverlappingVideoNodes } from "./utils/frameExportHelpers";
import { LayersPanel } from "./components/LayersPanel";
import { AgentPanel, type AgentHandoff } from "./components/AgentPanel";
import { OperatorPanel } from "./components/OperatorPanel";
import { SkillsPanel } from "./components/SkillsPanel";
import { GitHubPanel } from "./components/GitHubPanel";
// Phase K: the Matte panel is now the in-app operator (drives Claude Code). The
// legacy BYOK AgentPanel is retained behind this flag for a clean revert; flip
// to true to restore it. It stays referenced so its prop wiring doesn't rot.
const SHOW_LEGACY_AGENT = false;
import { ProjectsPage, type Project, type ProjectsTab } from "./components/ProjectsPage";
import { ProjectTabs } from "./components/ProjectTabs";
import { NodeCanvas } from "./components/NodeCanvas";
import { NodesPanelDefault } from "./components/NodesPanelDefault";
import { NodeInspectorPanel } from "./components/NodeInspectorPanel";
import { DEMO_WORKFLOW, type WorkflowNode, type WorkflowEdge } from "./components/nodeTypes";
import type { CanvasApi, CanvasNode } from "./types/canvas";
import { CinemaExportPanel } from "./features/cinema-frame/components/CinemaExportPanel";
import "./App.css";

const TOOL_LABELS: Record<ToolId, string> = {
  make: "Make",
  create: "Create",
  upscale: "Upscale",
  resize: "Resize",
  remove: "Remove BG",
  avatar: "Avatar",
  design: "Design",
  gifmaker: "GIF Maker",
  svgmaker: "Vector",
  nodes: "Nodes",
  cinema: "Cinema",
  audio: "Audio",
  tts: "Text to Speech",
  music: "Music",
  voicechanger: "Voice Changer",
  sfx: "SFX",
  clearcheck: "Copyright Check",
  auditlog: "Audit Log",
};

const VALID_TOOL_IDS: ToolId[] = ["make", "create", "upscale", "resize", "remove", "avatar", "design", "gifmaker", "svgmaker", "nodes", "cinema", "audio", "tts", "music", "voicechanger", "sfx", "clearcheck", "auditlog"];
const VALID_PAGE_MODES: PageMode[] = ["tools", "library"];

function getStoredPageState(workspaceId: string | undefined): { tool: ToolId | null; page: PageMode } {
  const defaults: { tool: ToolId | null; page: PageMode } = { tool: null, page: "tools" };
  if (!workspaceId) return defaults;
  try {
    const raw = localStorage.getItem(`lastPageState:${workspaceId}`);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    const tool: ToolId | null = VALID_TOOL_IDS.includes(parsed.selectedTool) ? parsed.selectedTool : defaults.tool;
    const page = VALID_PAGE_MODES.includes(parsed.pageMode) ? parsed.pageMode : defaults.page;
    return { tool, page };
  } catch {
    return defaults;
  }
}

function App() {
  const { balance, refetch: refreshCredits, unlimited } = useCreditsContext();
  const [pageMode, setPageMode] = useState<PageMode>("tools");
  const [railView, setRailView] = useState<RailView>(null);
  // Text handed to the agent composer from another panel (Skills). The nonce
  // makes a repeat hand-off of the same skill re-seed rather than no-op.
  const [agentSeed, setAgentSeed] = useState<{ text: string; nonce: number } | null>(null);
  // Agent panel is tracked independently of railView so it can stay open
  // alongside any left-side panel (e.g. Library + Agent simultaneously).
  const [agentOpen, setAgentOpen] = useState<boolean>(true);
  // Lifted from AgentPanel so the canvas-area can paint the busy edge glow.
  // Defaults false — AgentPanel reports the real busy state on mount.
  const [agentBusy, setAgentBusy] = useState<boolean>(false);
  const [dotPulseKey, setDotPulseKey] = useState<number | null>(null);
  const prevAgentBusy = useRef(false);
  const dotPulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (agentBusy && !prevAgentBusy.current) {
      if (dotPulseTimer.current) clearTimeout(dotPulseTimer.current);
      setDotPulseKey(Date.now());
      dotPulseTimer.current = setTimeout(() => {
        setDotPulseKey(null);
        dotPulseTimer.current = null;
      }, 2100);
    }
    prevAgentBusy.current = agentBusy;
  }, [agentBusy]);
  useEffect(() => {
    return () => { if (dotPulseTimer.current) clearTimeout(dotPulseTimer.current); };
  }, []);

  // The desktop app owns its theme: re-assert the stored (dark-by-default)
  // theme on mount. This overrides any transient light state left behind if the
  // window was briefly narrow during load (MobileChatShell forces light while
  // mounted). Without this, the app could get stuck light on every launch.
  useEffect(() => {
    applyTheme(getStoredTheme());
  }, []);
  const quickSettingsOpen = railView === "quick-settings";
  const { notifications, unreadCount, markRead, markAllRead } = useNotifications();
  const [selectedTool, setSelectedTool] = useState<ToolId | null>(null);
  // Tracks whether the current audio tool selection originated from the
  // Cinema rail. When true, audio panels route generations onto the design
  // canvas (audio nodes). When false (default — Audio rail entry), audio
  // panels render the AudioListCanvas surface and append clips there.
  const [audioFromCinema, setAudioFromCinema] = useState(false);
  const [designSubTool, setDesignSubTool] = useState<"select" | "frame" | "shape" | "text" | "pen" | "draw">("select");
  const [pendingShapeKind, setPendingShapeKind] = useState<string>("rectangle");
  const [svgEditState, setSvgEditState] = useState<{
    isEditing: boolean;
    selectedPoints: { subPathIdx: number; anchorIdx: number }[];
    pathData: { subPaths: { anchors: { x: number; y: number; smooth: boolean }[] }[] } | null;
  } | null>(null);
  const [fitAllTrigger, setFitAllTrigger] = useState(0);
  const [presentMode, setPresentMode] = useState(false);
  const [rightPanelHidden, setRightPanelHidden] = useState(false);
  const [panelSwapping, setPanelSwapping] = useState(false);
  const { activeWorkspace } = useWorkspace();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsFetchError, setProjectsFetchError] = useState<string | null>(null);
  const [sharedProjects, setSharedProjects] = useState<Project[]>([]);
  const [projectsTab, setProjectsTab] = useState<ProjectsTab>("mine");
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const { features: authFeatures, user: authUser, signIn: authSignIn } = useAuth();
  const isGuest = !authUser;
  const sharingEnabled = !!authFeatures?.sharingV1;
  const [activeProjectId, _setActiveProjectId] = useState<string | null>(null);

  // Which projects have a tab. Purely client-side — the server has no notion of
  // "open", so closing a tab is free and deleting stays a home-screen action.
  const [openProjectIds, setOpenProjectIds] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("openProjects") || "[]"); } catch { return []; }
  });
  useEffect(() => {
    // The project you're looking at always has a tab, however you got to it.
    setOpenProjectIds((prev) => {
      const next = activeProjectId && !prev.includes(activeProjectId) ? [...prev, activeProjectId] : prev;
      try { localStorage.setItem("openProjects", JSON.stringify(next)); } catch {}
      return next;
    });
  }, [activeProjectId]);
  const setActiveProjectId = useCallback((id: string | null) => {
    _setActiveProjectId(id);
    if (activeWorkspace?.id && id) {
      try { localStorage.setItem(`lastProject:${activeWorkspace.id}`, id); } catch {}
    }
  }, [activeWorkspace?.id]);

  const restoredWorkspaceIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeWorkspace?.id) return;
    if (restoredWorkspaceIdRef.current === activeWorkspace.id) return;
    restoredWorkspaceIdRef.current = activeWorkspace.id;
    const stored = getStoredPageState(activeWorkspace.id);
    setSelectedTool(stored.tool);
    setPageMode(stored.page);
  }, [activeWorkspace?.id]);

  useEffect(() => {
    if (!activeWorkspace?.id) return;
    if (restoredWorkspaceIdRef.current !== activeWorkspace.id) return;
    try {
      localStorage.setItem(`lastPageState:${activeWorkspace.id}`, JSON.stringify({
        selectedTool,
        pageMode,
      }));
    } catch {}
  }, [activeWorkspace?.id, selectedTool, pageMode]);

  const fetchProjectsVersionRef = useRef(0);
  const manualProjectSelectTsRef = useRef(0);
  const lastSuccessfulProjectsWorkspaceRef = useRef<string | null>(null);
  const canvasFlushRef = useRef<(() => Promise<void>) | null>(null);
  const [audioProjects, setAudioProjects] = useState<Project[]>([]);
  const [activeAudioProjectId, setActiveAudioProjectId] = useState<string | null>(null);
  const fetchAudioProjectsVersionRef = useRef(0);
  const [audioClipsByProject, setAudioClipsByProject] = useState<Record<string, AudioClip[]>>({});
  const [canvasLoading, setCanvasLoading] = useState(true);
  const [selectedImageIds, setSelectedImageIds] = useState<string[]>([]);
  const [canvasNodes, setCanvasNodes] = useState<CanvasNode[]>([]);
  const [makeVideoMode, setMakeVideoMode] = useState(false);
  const [videoFrameIds, setVideoFrameIds] = useState<{ first: string | null; last: string | null }>({ first: null, last: null });
  const [, setGenerating] = useState(false);
  const [, setGenDone] = useState(false);
  const { playStart, playComplete, playError } = useGenerationSound();
  const [, setGenAspectRatio] = useState("1:1");
  const [gifMakerOpen, setGifMakerOpen] = useState(false);
  const [svgMakerOpen, setSvgMakerOpen] = useState(false);
  const [axiomCreatorOpen, setAxiomCreatorOpen] = useState(false);
  const [styleCreatorOpen, setStyleCreatorOpen] = useState(false);
  const [bucketManagerOpen, setBucketManagerOpen] = useState<"axioms" | "styles" | null>(null);
  const [folderCreatorOpen, setFolderCreatorOpen] = useState(false);
  const [folderManagerOpen, setFolderManagerOpen] = useState<{ id: string; name: string } | null>(null);
  const [axiomManagerOpen, setAxiomManagerOpen] = useState<string | null>(null);
  const [styleManagerOpen, setStyleManagerOpen] = useState<string | null>(null);
  const [folderSelectedItems, setFolderSelectedItems] = useState<Map<string, { name: string; thumb: string }>>(new Map());
  const [folderRefreshKey, setFolderRefreshKey] = useState(0);
  const [axiomRefreshKey, setAxiomRefreshKey] = useState(0);
  const [styleRefreshKey, setStyleRefreshKey] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState("account");
  // Local API-keys modal (fal.ai + Anthropic) for the desktop build.
  const [apiKeysOpen, setApiKeysOpen] = useState(false);
  const [wfNodes, setWfNodes] = useState<WorkflowNode[]>(DEMO_WORKFLOW.nodes);
  const [wfEdges, setWfEdges] = useState<WorkflowEdge[]>(DEMO_WORKFLOW.edges);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [auditRefreshKey, setAuditRefreshKey] = useState(0);
  const canvasIdRef = useRef<string | null>(null);
  const isCanvasMountedRef = useRef<boolean>(false);
  const isFreeformCanvasViewRef = useRef<boolean>(false);
  const pendingCinemaInsertRef = useRef<boolean>(false);
  const canvasApiRef = useRef<CanvasApi | null>(null);
  const tryInsertCinemaFrame = useCallback(() => {
    const api = canvasApiRef.current;
    if (!api || !isCanvasMountedRef.current) return false;
    const vp = api.getViewport?.();
    // Matches the dropdown preset and the agent's ensureCinemaNode: 1080 of
    // picture plus the ~620px the toolbar and timeline rows take at 2.2x chrome zoom.
    const w = 1920;
    const h = 1700;
    const cx = vp ? vp.cx - w / 2 : 0;
    const cy = vp ? vp.cy - h / 2 : 0;
    api.addNode?.(cx, cy, {
      node_type: "cinema",
      width: w,
      height: h,
      label: "Cinema Frame",
      locked: true,
      metadata: {
        timelineState: {
          tracks: [
            { id: crypto.randomUUID(), type: "video", clips: [] },
            { id: crypto.randomUUID(), type: "audio", clips: [] },
          ],
          playheadPosition: 0,
          zoomLevel: 0.15,
        },
      },
    });
    pendingCinemaInsertRef.current = false;
    return true;
  }, []);
  // Last placeholder rect dropped by `startGeneration` (right panel) or by
  // the agent. Both flows read/write this anchor so successive generations
  // chain into a continuous row regardless of which surface initiated them.
  // Scoped by canvasId so a turn that finishes after the user switches
  // canvases can't poison the new canvas's anchor.
  // Stable proxy passed to children (e.g. AgentPanel) that need the canvas
  // api. Each method delegates to the *current* canvasApiRef on every call,
  // so it never goes stale when the underlying api object identity changes
  // (canvas remount, project switch, useFrameApi closure regen). `isLive()`
  // tells consumers whether the underlying canvas is mounted right now —
  // they should fall back to a server POST when it returns false.
  const canvasApiProxyRef = useRef<CanvasApi | null>(null);
  if (!canvasApiProxyRef.current) {
    const refLive = () => !!canvasApiRef.current && isCanvasMountedRef.current;
    canvasApiProxyRef.current = {
      isLive: refLive,
      addNode: (x, y, props) => canvasApiRef.current?.addNode?.(x, y, props),
      updateNode: (id, fields) => canvasApiRef.current?.updateNode?.(id, fields),
      getViewport: () => canvasApiRef.current?.getViewport?.()
        ?? { cx: 0, cy: 0, w: 800, h: 600, panX: 0, panY: 0, zoom: 1 },
      centerOnNode: (id, opts) => canvasApiRef.current?.centerOnNode?.(id, opts),
      getNodes: () => canvasApiRef.current?.getNodes?.() ?? [],
    } as CanvasApi;
  }
  const canvasApiProxy = canvasApiProxyRef.current;

  const startGeneration = useCallback(async (arOrParams: string | GenerationParams = "1:1", jobType?: string): Promise<string | null> => {
    if (!canvasIdRef.current || !isCanvasMountedRef.current) {
      console.warn("[startGeneration] Refused: no canvas mounted (canvasId=%s, mounted=%s)", canvasIdRef.current, isCanvasMountedRef.current);
      alert("Open a canvas to start a generation.");
      return null;
    }
    let ar: string;
    let body: Record<string, unknown>;
    let promptText: string | undefined;
    let resolution: string | undefined;

    if (typeof arOrParams === "object" && arOrParams !== null) {
      const params = arOrParams as GenerationParams;
      ar = params.aspectRatio || "1:1";
      promptText = params.prompt;
      resolution = params.resolution;
      body = {
        type: params.jobType,
        model: params.model,
        prompt: params.prompt,
        aspect_ratio: ar,
        resolution: params.resolution,
        imageNumber: params.imageNumber,
        referenceImageUrls: params.referenceImageUrls,
        duration: params.duration,
        generateAudio: params.generateAudio,
        firstFrameUrl: params.firstFrameUrl,
        lastFrameUrl: params.lastFrameUrl,
        upscale_factor: params.upscaleFactor,
        target_fps: params.targetFps,
        image_url: params.imageUrl,
        video_url: params.videoUrl,
        ref_video_duration: params.refVideoDuration,
        character_orientation: params.characterOrientation,
        keep_original_sound: params.keepOriginalSound,
        style: params.style,
        image_size: params.imageSize,
        colors: params.colors,
        lyrics: params.lyrics,
        is_instrumental: params.is_instrumental,
        text: params.text,
        voice: params.voice,
        speed: params.speed,
        stability: params.stability,
        similarity_boost: params.similarityBoost,
        emotion: params.emotion,
        duration_seconds: params.durationSeconds,
        prompt_influence: params.promptInfluence,
        audio_url: params.audioUrl,
        characters: params.characters,
        quality: params.quality,
      };
      jobType = params.jobType;
    } else {
      ar = arOrParams;
      body = { type: jobType, params: { aspect_ratio: ar } };
    }

    if (canvasIdRef.current) {
      body.canvas_id = canvasIdRef.current;
    }
    if (activeWorkspace?.type === "org") {
      body.workspace_id = activeWorkspace.id;
    }

    if (jobType === "image_to_image" || jobType === "remove_bg" || jobType === "resize" || jobType === "upscale" || jobType === "image_to_vector") {
      // Video-targeted upscale (Topaz) consumes `video_url` instead of an
      // image reference array — skip the image-ref validation in that case
      // and rely on the server's per-model buildInput to validate the URL.
      const isVideoUpscale = jobType === "upscale" && typeof body.video_url === "string" && (body.video_url as string).length > 0;
      if (!isVideoUpscale) {
        const refs = (body.referenceImageUrls as string[]) || [];
        const validRefs = refs.filter((url) => {
          if (!url || typeof url !== "string") return false;
          const trimmed = url.trim();
          if (!trimmed) return false;
          if (trimmed.startsWith("data:image/")) return true;
          try {
            const parsed = new URL(trimmed, window.location.origin);
            if (parsed.pathname === "/" || parsed.pathname === "") return false;
            return true;
          } catch {
            return false;
          }
        });
        if (validRefs.length === 0) {
          console.error("No valid reference images for edit generation");
          alert("No valid reference images selected. Please select an image on the canvas before generating an edit.");
          return null;
        }
        body.referenceImageUrls = validRefs;
      }
    }

    if (!jobType) return null;

    setGenAspectRatio(ar);
    setGenerating(true);
    setGenDone(false);
    playStart();

    // Drop a `generating` placeholder on the canvas for each unit of work,
    // mirroring the agent's on-canvas flow. Polling later upgrades each
    // placeholder to image/video/svg/audio (or a failed state) in place.
    const kind: "image" | "video" | "svg" | "audio" =
      jobType === "video_gen" || jobType === "avatar"
        ? "video"
        : (jobType === "upscale" && typeof body.video_url === "string" && body.video_url)
          ? "video"
          : (jobType === "audio_tts" || jobType === "audio_music" || jobType === "audio_sfx" || jobType === "audio_voice_changer")
            ? "audio"
            : (jobType === "text_to_vector" || jobType === "image_to_vector")
              ? "svg"
              : "image";

    const count = (jobType === "text_to_image" || jobType === "image_to_image") ? Math.max(1, (body.imageNumber as number) || 1) : 1;
    const singleBody = { ...body, imageNumber: 1 };

    // Hoisted out of the live-canvas branch below: the per-request
    // callbacks (lines ~540-570) need `meta` regardless of which placement
    // branch fired, and a block-scoped `const meta` inside the `if` made
    // those callbacks throw `ReferenceError: meta is not defined`. The
    // job still completed on fal.ai, but the client crashed before
    // flipping the placeholder node to its result, so it stayed stuck
    // on "generating" forever.
    const audioSubtype = kind === "audio"
      ? (jobType === "audio_tts" ? "tts"
        : jobType === "audio_music" ? "music"
        : jobType === "audio_sfx" ? "sfx"
        : jobType === "audio_voice_changer" ? "voice"
        : undefined)
      : undefined;
    const meta = {
      source: "panel",
      status: "pending",
      kind,
      prompt: promptText,
      aspectRatio: ar,
      jobType,
      ...(audioSubtype
        ? {
            audioSubtype,
            cinemaNodeType: "audio" as const,
            ...(typeof body.duration_seconds === "number"
              ? { duration: body.duration_seconds as number }
              : {}),
          }
        : {}),
    };

    let placedNodeIds: string[] = [];
    const api = canvasApiProxy;
    if (api?.isLive?.() && api.addNode && api.getNodes && api.getViewport) {
      const sizeKind: "image" | "video" = kind === "video" ? "video" : "image";
      const baseSize = kind === "audio"
        ? { w: 384, h: 90 }
        : kind === "svg"
          ? { w: 384, h: 384 }
          : placeholderSize("quality", ar, sizeKind, resolution);
      const sizes = new Array(count).fill(baseSize);
      const viewport = api.getViewport();
      // Placement reads its anchor off the canvas (rightmost node), so there is
      // nothing to remember between calls and nothing to lose on reload or a
      // canvas switch — see src/utils/canvasPlacement.ts.
      const slots = findEmptySlots(viewport, sizes, api.getNodes());
      placedNodeIds = slots.map((slot) => {
        const node = api.addNode!(slot.x, slot.y, {
          node_type: "generating",
          width: slot.w,
          height: slot.h,
          metadata: meta,
        });
        return node?.id || "";
      }).filter(Boolean);
    }

    // Issue one POST per placeholder. On success attach the job_id to the
    // node so the polling effect can poll it. On failure flip the node's
    // metadata so GeneratingNode shows the dismiss-able failure state.
    const requests = placedNodeIds.length > 0
      ? placedNodeIds.map(async (nodeId) => {
          try {
            const res = await fetch("/api/generate", {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(singleBody),
            });
            if (!res.ok) {
              const data = await res.json().catch(() => ({}));
              const errorMsg = data.error || "Generation failed. Please try again.";
              if (res.status === 402) {
                console.warn("Insufficient credits:", data);
              } else if (res.status === 429) {
                alert(errorMsg);
              } else {
                console.error("Generation failed:", data);
              }
              playError();
              api?.updateNode?.(nodeId, {
                metadata: {
                  ...meta,
                  status: "failed",
                  errorMsg,
                },
              });
              return null;
            }
            const genData = await res.json().catch(() => ({}));
            if (genData.job_id) {
              api?.updateNode?.(nodeId, {
                job_id: genData.job_id,
                metadata: {
                  ...meta,
                  status: "generating",
                  jobId: genData.job_id,
                },
              });
            }
            return genData.job_id || null;
          } catch (err) {
            console.error("Generation request error:", err);
            playError();
            api?.updateNode?.(nodeId, {
              metadata: {
                ...meta,
                status: "failed",
                errorMsg: "Network error",
              },
            });
            return null;
          }
        })
      : // Fallback (no live canvas): just POST without placeholders.
        new Array(count).fill(0).map(async () => {
          try {
            const res = await fetch("/api/generate", {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(singleBody),
            });
            if (!res.ok) { playError(); return null; }
            const j = await res.json().catch(() => ({}));
            return j.job_id || null;
          } catch { playError(); return null; }
        });

    const results = await Promise.all(requests);
    refreshCredits();
    return results.find((id) => id !== null) || null;
  }, [refreshCredits, playStart, playError, canvasApiProxy, activeWorkspace?.id, activeWorkspace?.type]);

  const startAudioGeneration = useCallback(async (params: GenerationParams): Promise<string | null> => {
    playStart();
    const body: Record<string, unknown> = {
      type: params.jobType,
      model: params.model,
      prompt: params.prompt,
      aspect_ratio: params.aspectRatio || "1:1",
      lyrics: params.lyrics,
      is_instrumental: params.is_instrumental,
      text: params.text,
      voice: params.voice,
      speed: params.speed,
      stability: params.stability,
      similarity_boost: params.similarityBoost,
      emotion: params.emotion,
      duration_seconds: params.durationSeconds,
      prompt_influence: params.promptInfluence,
      audio_url: params.audioUrl,
    };
    if (activeWorkspace?.type === "org") {
      body.workspace_id = activeWorkspace.id;
    }
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status !== 402) {
          const errorMsg = data.error || "Generation failed. Please try again.";
          alert(errorMsg);
        }
        playError();
        return null;
      }
      const genData = await res.json().catch(() => ({}));
      refreshCredits();
      return genData.job_id || null;
    } catch (err) {
      console.error("Audio generation request error:", err);
      playError();
      return null;
    }
  }, [refreshCredits, playStart, playError]);

  // Cinema-style audio routing: in design context, dispatch audio panel
  // generations onto the freeform canvas via startGeneration (which drops a
  // placeholder + polls into an `audio` node). The list-based fallback
  // remains available via dispatchAudioGenerationToList for audio-only
  // project surfaces.
  const cinemaGen = useCinemaGeneration({
    startGeneration: (params) => startGeneration(params),
    startAudioGeneration,
  });

  const isMakeTool = useCallback((t: ToolId | null) => {
    return t === "make" || t === "create" || t === "upscale" || t === "resize" || t === "remove" || t === "avatar";
  }, []);

  const [libraryView, setLibraryView] = useState<string | null>(null);
  const [libraryInitialFolderId, setLibraryInitialFolderId] = useState<string | null>(null);
  const [assetRefreshKey, setAssetRefreshKey] = useState(0);

  const handleLibrarySaved = useCallback(() => {
    setAssetRefreshKey((k) => k + 1);
  }, []);

  const closeAllLibraryPanels = useCallback(() => {
    setAxiomCreatorOpen(false);
    setStyleCreatorOpen(false);
    setBucketManagerOpen(null);
    setFolderCreatorOpen(false);
    setFolderManagerOpen(null);
    setAxiomManagerOpen(null);
    setStyleManagerOpen(null);
    setFolderSelectedItems(new Map());
    if (folderManagerOpen) {
      setFolderRefreshKey((k) => k + 1);
    }
  }, [folderManagerOpen]);

  const handleLibrarySelect = useCallback((view: string) => {
    closeAllLibraryPanels();
    setLibraryInitialFolderId(null);
    setRailView("library");
    setPageMode("library");
    setLibraryView((prev) => prev === view ? null : view);
  }, [closeAllLibraryPanels]);

  const handleLibraryClose = useCallback(() => {
    setLibraryView(null);
    setLibraryInitialFolderId(null);
    setLibraryHighlightAssetId(null);
  }, []);

  const [libraryHighlightAssetId, setLibraryHighlightAssetId] = useState<string | null>(null);
  const handleOpenLibraryFromCanvas = useCallback((view: string, folderId?: string, assetId?: string) => {
    setLibraryInitialFolderId(null);
    setLibraryHighlightAssetId(null);
    setRailView("library");
    setPageMode("library");
    setLibraryView(view);
    requestAnimationFrame(() => {
      setLibraryInitialFolderId(folderId ?? null);
      setLibraryHighlightAssetId(assetId ?? null);
    });
  }, []);

  const handleToolSelect = useCallback((id: ToolId | null) => {
    setRailView("toolkit");
    setLibraryView(null);
    setLibraryInitialFolderId(null);
    setLibraryHighlightAssetId(null);
    if (pageMode === "library") setPageMode("tools");
    // Audio-tool selections that come through the regular handler (Audio
    // rail, programmatic switches, reuse-clip flow) reset the cinema-entry
    // flag so AudioListCanvas remains the surface for that flow.
    if (id === "tts" || id === "music" || id === "voicechanger" || id === "sfx" || id === "audio") {
      setAudioFromCinema(false);
    }
    if (id === "create" && selectedTool === "create" && !svgMakerOpen && !gifMakerOpen) {
      setFitAllTrigger((c) => c + 1);
      return;
    }
    if (id === "cinema") {
      pendingCinemaInsertRef.current = true;
      if (!isFreeformCanvasViewRef.current) {
        setSelectedTool("create");
      } else {
        tryInsertCinemaFrame();
      }
      return;
    }
    if (id === "gifmaker") {
      if (!selectedTool || selectedTool === "audio" || selectedTool === "tts" || selectedTool === "music" || selectedTool === "voicechanger" || selectedTool === "sfx") {
        setSelectedTool("create");
      }
      setSvgMakerOpen(false);
      setGifMakerOpen(true);
    } else if (id === "svgmaker") {
      setSelectedTool("svgmaker");
      setGifMakerOpen(false);
      setSvgMakerOpen(true);
    } else {
      setGifMakerOpen(false);
      setSvgMakerOpen(false);
      setSelectedTool(id);
    }
  }, [selectedTool, isMakeTool, svgMakerOpen, gifMakerOpen, pageMode]);

  // Cinema-rail child selections always take the canvas path. For audio
  // tools this means the next AudioPanel mount routes generations onto the
  // freeform canvas as `audio` nodes (not into AudioListCanvas).
  const handleCinemaChildSelect = useCallback((id: ToolId | null) => {
    const isAudio = id === "tts" || id === "music" || id === "voicechanger" || id === "sfx";
    // Order matters: handleToolSelect always clears `audioFromCinema` for
    // audio ids, so we set the cinema-entry flag *after* delegating. React
    // batches both setters in the same event so the final value wins.
    handleToolSelect(id);
    if (isAudio) setAudioFromCinema(true);
  }, [handleToolSelect]);

  const handleAddNode = useCallback((node: WorkflowNode) => {
    setWfNodes((prev) => [...prev, node]);
    setSelectedNodeId(node.id);
  }, []);

  const handleNodeConfigChange = useCallback((nodeId: string, config: Record<string, unknown>) => {
    setWfNodes((prev) => prev.map((n) => n.id === nodeId ? { ...n, config } : n));
  }, []);

  const handleAddAudit = useCallback((_audit: AuditRecord) => {
    setAuditRefreshKey((k) => k + 1);
  }, []);

  const handleDeleteNode = useCallback((nodeId: string) => {
    setWfNodes((prev) => prev.filter((n) => n.id !== nodeId));
    setWfEdges((prev) => prev.filter((e) => e.sourceNode !== nodeId && e.targetNode !== nodeId));
    setSelectedNodeId(null);
  }, []);

  const fetchProjects = useCallback(async (autoSelectId?: string | null) => {
    if (!activeWorkspace?.id) { setProjects([]); setActiveProjectId(null); return; }
    const version = ++fetchProjectsVersionRef.current;
    const fetchStartTs = Date.now();
    const fetchingWorkspaceId = activeWorkspace.id;
    try {
      const r = await fetch(`/api/projects/${fetchingWorkspaceId}`, { credentials: "include" });
      if (fetchProjectsVersionRef.current !== version) return;
      if (!r.ok) throw new Error(`fetchProjects HTTP ${r.status}`);
      const data = await r.json();
      if (fetchProjectsVersionRef.current !== version) return;
      const list: Project[] = data.projects || [];
      lastSuccessfulProjectsWorkspaceRef.current = fetchingWorkspaceId;
      setProjectsFetchError(null);
      setProjects(list);
      if (manualProjectSelectTsRef.current > fetchStartTs) return;
      if (list.length > 0) {
        if (autoSelectId && list.some((p) => p.id === autoSelectId)) {
          setActiveProjectId(autoSelectId);
        } else {
          let stored: string | null = null;
          try { stored = localStorage.getItem(`lastProject:${fetchingWorkspaceId}`); } catch {}
          if (stored && list.some((p) => p.id === stored)) {
            setActiveProjectId(stored);
          } else {
            setActiveProjectId(list[0].id);
          }
        }
      } else {
        setActiveProjectId(null);
      }
    } catch (err) {
      if (fetchProjectsVersionRef.current !== version) return;
      // If the failure happened while fetching a *different* workspace than the
      // last successful one, the visible list belongs to the old workspace —
      // clear it so the user isn't misled by stale data.  When the workspace
      // hasn't changed (e.g. a transient error right after a create), preserve
      // the list so the newly-created project doesn't visually disappear.
      if (lastSuccessfulProjectsWorkspaceRef.current !== fetchingWorkspaceId) {
        setProjects([]);
        setActiveProjectId(null);
        setProjectsFetchError("Couldn't load projects. Try switching workspaces again.");
      }
      console.error('[fetchProjects] failed', err);
    }
  }, [activeWorkspace?.id]);

  useEffect(() => {
    let title = "Fal Forge";
    if (pageMode === "library") {
      title = "Library — Fal Forge";
    } else if (selectedTool) {
      const label = TOOL_LABELS[selectedTool];
      if (label) title = `${label} — Fal Forge`;
    }
    document.title = title;
  }, [pageMode, selectedTool]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setSettingsSection(detail?.section || "subscription");
      setSettingsOpen(true);
    };
    window.addEventListener("open-settings", handler);
    return () => window.removeEventListener("open-settings", handler);
  }, []);

  // The Settings panel is a floating ~380px surface that sits to the
  // right of the QuickSettingsPanel (the account menu). When it opens
  // we snap the layout into a known state so the panel always has a
  // visible parent menu and the canvas reads as a focused fullscreen
  // backdrop:
  //   - railView is forced to "quick-settings" so the account menu is
  //     visible immediately to the left of the Settings panel,
  //   - rightPanelHidden is forced true so the right-side rpanel/agent
  //     surfaces are hidden and the canvas card stretches across the
  //     remaining viewport (with the standard 20px floating-arrow gap).
  // The previous values are stashed in refs so closing the panel
  // restores the user's prior layout exactly.
  // Captured prior layout state. `captured: false` is the unset
  // sentinel — we cannot use `null` for that because `null` is a
  // legitimate value of `railView` (rail closed). Only the open-edge
  // effect ever sets `captured: true`; only the close-edge effect ever
  // clears it. We restore on close only the parts of the layout that
  // we actually forced — if the user has already changed railView or
  // rightPanelHidden, we leave their choice intact.
  const prevLayoutRef = useRef<{
    captured: boolean;
    railView: RailView | null;
    rightPanelHidden: boolean;
  }>({ captured: false, railView: null, rightPanelHidden: false });
  // `settingsAnchoredRef` flips true only AFTER the rail-sync effect
  // has observed railView === "quick-settings" (i.e. the open-edge
  // setRailView call has actually committed). The "close Settings
  // when rail moves away" effect gates on this so it cannot race the
  // open-edge effect and immediately cancel a freshly-opened panel
  // (which can be triggered from any of: QuickSettingsPanel,
  // LeftToolbar, ProjectsSidePanel, AgentPanel, or the global
  // `open-settings` CustomEvent — most of these open Settings while
  // railView is something other than "quick-settings").
  const settingsAnchoredRef = useRef(false);
  useEffect(() => {
    if (settingsOpen) {
      if (!prevLayoutRef.current.captured) {
        prevLayoutRef.current = {
          captured: true,
          railView,
          rightPanelHidden,
        };
        if (railView !== "quick-settings") setRailView("quick-settings");
        if (!rightPanelHidden) setRightPanelHidden(true);
      }
    } else if (prevLayoutRef.current.captured) {
      // Close-edge restore. Only restore values that are still what we
      // forced — if the user has moved railView or shown the right
      // panel since, leave their selection intact.
      const prev = prevLayoutRef.current;
      prevLayoutRef.current = { captured: false, railView: null, rightPanelHidden: false };
      settingsAnchoredRef.current = false;
      if (railView === "quick-settings" && prev.railView !== "quick-settings") {
        setRailView(prev.railView);
      }
      if (rightPanelHidden && !prev.rightPanelHidden) {
        setRightPanelHidden(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen]);

  // Drive the anchored flag and the auto-close behavior off observed
  // railView changes. We flip `settingsAnchoredRef` only once we've
  // actually seen railView === "quick-settings" while settingsOpen,
  // so any earlier render where railView hasn't yet committed cannot
  // cancel the freshly-opened panel. After anchoring, any change away
  // from "quick-settings" (user clicks another rail icon, closes the
  // rail, etc.) closes Settings — they belong together.
  useEffect(() => {
    if (!settingsOpen) return;
    if (railView === "quick-settings") {
      settingsAnchoredRef.current = true;
    } else if (settingsAnchoredRef.current) {
      setSettingsOpen(false);
    }
  }, [railView, settingsOpen]);

  // Esc closes the floating Settings panel. Only attached while open
  // so other Esc handlers (modals, popovers) keep working normally.
  useEffect(() => {
    if (!settingsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setSettingsOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [settingsOpen]);

  // Click-outside dismissal for the account-menu / Settings pair.
  // While the QuickSettingsPanel (account menu) is open, a mousedown
  // on the canvas (anywhere outside the IconRail, the qs-panel, the
  // floating Settings panel, and any inbox popover) closes both
  // surfaces. This matches the spec's "click out to close" behavior.
  useEffect(() => {
    if (railView !== "quick-settings") return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      const insideAny = (sel: string) => {
        const els = document.querySelectorAll(sel);
        for (const el of Array.from(els)) {
          if (el.contains(target)) return true;
        }
        return false;
      };
      if (insideAny(".qs-panel")) return;
      if (insideAny(".settings-panel")) return;
      if (insideAny(".qs-inbox-popover")) return;
      if (insideAny(".icon-rail")) return;
      // Click landed on the canvas / chrome outside the menu pair.
      setRailView(null);
      setSettingsOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [railView]);

  useEffect(() => {
    // Bump manualProjectSelectTsRef so this workspace switch's fetchProjects
    // can't be raced/clobbered by an older in-flight fetch from the previous
    // workspace, and so a create flow's setActiveProjectId can't be undone by
    // a slightly later workspace-switch effect (its setActiveProjectId(null)
    // runs synchronously, but the bumped ref keeps fetchProjects's autoSelect
    // logic from re-clearing things).
    manualProjectSelectTsRef.current = Date.now();
    setActiveProjectId(null);
    fetchProjects();
  }, [fetchProjects]);

  const fetchSharedProjects = useCallback(async () => {
    if (!sharingEnabled || !activeWorkspace?.id) { setSharedProjects([]); return; }
    try {
      const r = await fetch(`/api/projects/${activeWorkspace.id}?scope=shared`, { credentials: "include" });
      if (!r.ok) { setSharedProjects([]); return; }
      const data = await r.json();
      setSharedProjects(data.projects || []);
    } catch { setSharedProjects([]); }
  }, [sharingEnabled, activeWorkspace?.id]);

  useEffect(() => { fetchSharedProjects(); }, [fetchSharedProjects]);

  // Deep-link share open: SharePage redirects to /?p=<projectId> after redeeming a
  // share link. We capture the param once (it survives effect re-runs and any
  // sessionStorage quirks), then apply it as a one-shot after the workspace is
  // ready. manualProjectSelectTsRef is bumped so any in-flight fetchProjects can't
  // clobber our selection. We also clear stale sessionStorage from older builds.
  const pendingDeepLinkProjectIdRef = useRef<string | null>(null);
  if (pendingDeepLinkProjectIdRef.current === null) {
    try {
      const params = new URLSearchParams(window.location.search);
      const p = params.get("p");
      if (p && /^[0-9a-f-]{36}$/i.test(p)) pendingDeepLinkProjectIdRef.current = p;
    } catch {}
    try { sessionStorage.removeItem("pending_open_project"); } catch {}
  }
  const pendingOpenAttemptRef = useRef(false);
  useEffect(() => {
    if (pendingOpenAttemptRef.current) return;
    if (!activeWorkspace?.id) return;
    const pending = pendingDeepLinkProjectIdRef.current;
    pendingOpenAttemptRef.current = true;
    // Strip the param from the URL regardless so a refresh doesn't reopen.
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has("p")) {
        url.searchParams.delete("p");
        window.history.replaceState({}, "", url.pathname + (url.search ? url.search : "") + url.hash);
      }
    } catch {}
    if (!pending) return;
    manualProjectSelectTsRef.current = Date.now();
    setActiveProjectId(pending);
  }, [activeWorkspace?.id, setActiveProjectId]);

  // Authoritative access state for the active project, fetched from the
  // server. The server is the single source of truth: client never infers
  // viewer-mode from local lists. Falls back to local hint while loading.
  const [activeAccess, setActiveAccess] = useState<{ projectId: string; role: "owner" | "viewer" | "none"; ownerDisplayName: string | null; ownerEmail: string | null } | null>(null);
  useEffect(() => {
    if (!activeProjectId) { setActiveAccess(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/projects/${activeProjectId}/access`, { credentials: "include" });
        if (cancelled) return;
        if (!r.ok) { setActiveAccess({ projectId: activeProjectId, role: "none", ownerDisplayName: null, ownerEmail: null }); return; }
        const data = await r.json();
        setActiveAccess({
          projectId: activeProjectId,
          role: data.role || "none",
          ownerDisplayName: data.ownerDisplayName || null,
          ownerEmail: data.ownerEmail || null,
        });
      } catch {
        if (!cancelled) setActiveAccess({ projectId: activeProjectId, role: "none", ownerDisplayName: null, ownerEmail: null });
      }
    })();
    return () => { cancelled = true; };
  }, [activeProjectId]);

  const isActiveProjectViewer = !!activeProjectId
    && activeAccess?.projectId === activeProjectId
    && activeAccess.role === "viewer";
  const activeOwnerLabel = isActiveProjectViewer
    ? (activeAccess?.ownerDisplayName || activeAccess?.ownerEmail || null)
    : null;

  useEffect(() => {
    if (!activeProjectId) return;
    setCanvasReadOnly(activeProjectId, isActiveProjectViewer);
    return () => { setCanvasReadOnly(activeProjectId, false); };
  }, [activeProjectId, isActiveProjectViewer]);

  // Viewer mode: force-close mutation panels and keep the user on the neutral
  // "create" tool so no editing right-side panel renders.
  useEffect(() => {
    if (!isActiveProjectViewer) return;
    setGifMakerOpen(false);
    setSvgMakerOpen(false);
    setAxiomCreatorOpen(false);
    setStyleCreatorOpen(false);
    setBucketManagerOpen(null);
    setFolderCreatorOpen(false);
    setFolderManagerOpen(null);
    setAxiomManagerOpen(null);
    setStyleManagerOpen(null);
  }, [isActiveProjectViewer]);

  // Viewer mode: swallow destructive keyboard shortcuts (delete/backspace) so
  // the canvas can't be mutated even via keyboard.
  useEffect(() => {
    if (!isActiveProjectViewer) return;
    const handler = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      const tag = (tgt?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tgt?.isContentEditable) return;
      if (e.key === "Delete" || e.key === "Backspace" || (e.key === "x" && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [isActiveProjectViewer]);

  // Viewer-cap state: surfaced when SSE returns 429 for a viewer canvas.
  const [viewerCapReached, setViewerCapReached] = useState(false);
  useEffect(() => { setViewerCapReached(false); }, [activeProjectId]);
  useEffect(() => {
    const onCap = () => setViewerCapReached(true);
    window.addEventListener("canvas-viewer-cap", onCap);
    return () => window.removeEventListener("canvas-viewer-cap", onCap);
  }, []);

  useEffect(() => {
    if (railView === "home") {
      fetchProjects(activeProjectId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [railView]);

  const activeAudioProjectIdRef = useRef(activeAudioProjectId);
  activeAudioProjectIdRef.current = activeAudioProjectId;

  const fetchAudioProjects = useCallback(async (autoSelectId?: string | null) => {
    if (!activeWorkspace?.id) { setAudioProjects([]); setActiveAudioProjectId(null); return; }
    const version = ++fetchAudioProjectsVersionRef.current;
    try {
      const r = await fetch(`/api/audio-projects/${activeWorkspace.id}`, { credentials: "include" });
      if (fetchAudioProjectsVersionRef.current !== version) return;
      if (!r.ok) throw new Error("Failed");
      const data = await r.json();
      if (fetchAudioProjectsVersionRef.current !== version) return;
      const list: Project[] = data.projects || [];
      setAudioProjects(list);
      if (list.length > 0) {
        if (autoSelectId && list.some((p) => p.id === autoSelectId)) {
          setActiveAudioProjectId(autoSelectId);
        } else if (!activeAudioProjectIdRef.current || !list.some((p) => p.id === activeAudioProjectIdRef.current)) {
          setActiveAudioProjectId(list[0].id);
        }
      } else {
        setActiveAudioProjectId(null);
      }
    } catch {
      if (fetchAudioProjectsVersionRef.current !== version) return;
      setAudioProjects([]);
      setActiveAudioProjectId(null);
    }
  }, [activeWorkspace?.id]);

  useEffect(() => {
    fetchAudioProjects();
  }, [fetchAudioProjects]);

  const activeProjectObj = projects.find((p) => p.id === activeProjectId) || null;
  const activeAudioProjectObj = audioProjects.find((p) => p.id === activeAudioProjectId) || null;
  const isAudioChildTool = selectedTool === "audio" || selectedTool === "tts" || selectedTool === "music" || selectedTool === "voicechanger" || selectedTool === "sfx";
  const isAudioTool = isAudioChildTool;
  const projectName = isAudioTool
    ? (activeAudioProjectObj?.name || "")
    : (activeProjectObj?.name || "");

  const lastCanvasProjectRef = useRef<string | null>(activeProjectId);
  const lastWorkspaceIdRef = useRef(activeWorkspace?.id);
  if (lastWorkspaceIdRef.current !== activeWorkspace?.id) {
    lastCanvasProjectRef.current = null;
    lastWorkspaceIdRef.current = activeWorkspace?.id;
  }
  if (activeProjectId !== null) {
    lastCanvasProjectRef.current = activeProjectId;
  }
  const effectiveCanvasProjectId = activeProjectId ?? lastCanvasProjectRef.current;

  useEffect(() => {
    if (!activeAudioProjectId) return;
    if (audioClipsByProject[activeAudioProjectId]) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/audio-projects/${activeAudioProjectId}/clips`, { credentials: "include" });
        if (cancelled || !r.ok) return;
        const rows = await r.json();
        if (cancelled) return;
        const clips: AudioClip[] = rows.map((row: any) => {
          const t = row.type as AudioType;
          let generationParams: AudioClip["generationParams"] | undefined;
          if (t === "tts" && row.prompt) {
            generationParams = { tts: { text: row.prompt, voice: row.voice || "Friendly_Person", speed: 1, emotion: "neutral", outputFormat: "mp3" } };
          } else if (t === "music" && row.prompt) {
            generationParams = { music: { prompt: row.prompt, lyrics: "", isInstrumental: false } };
          } else if (t === "sfx" && row.prompt) {
            generationParams = { sfx: { prompt: row.prompt, durationSeconds: 5, promptInfluence: 0.3 } };
          } else if (t === "voicechanger" && row.voice) {
            generationParams = { voicechanger: { voice: row.voice, stability: "0.5", similarity: "0.75", outputFormat: "mp3_44100_128" } };
          }
          return {
            id: row.id,
            type: t,
            prompt: row.prompt,
            duration: row.duration,
            bars: randomBars(80),
            voice: row.voice || undefined,
            style: row.style || undefined,
            audioUrl: row.audio_url || undefined,
            jobId: row.job_id || undefined,
            loading: !!(row.job_id && !row.audio_url),
            savedAssetId: row.saved_asset_id || undefined,
            generationParams,
            name: row.name || undefined,
            createdAt: row.created_at || undefined,
          };
        });
        setAudioClipsByProject((prev) => ({ ...prev, [activeAudioProjectId!]: clips }));
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [activeAudioProjectId]);

  const activeAudioClips = useMemo(() => {
    if (!activeAudioProjectId) return [];
    return audioClipsByProject[activeAudioProjectId] || [];
  }, [activeAudioProjectId, audioClipsByProject]);

  const addAudioClip = useCallback((clip: AudioClip) => {
    if (!activeAudioProjectId) return;
    setAudioClipsByProject((prev) => ({
      ...prev,
      [activeAudioProjectId]: [clip, ...(prev[activeAudioProjectId] || [])],
    }));
    fetch(`/api/audio-projects/${activeAudioProjectId}/clips`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ id: clip.id, type: clip.type, prompt: clip.prompt, duration: clip.duration, voice: clip.voice, style: clip.style, audio_url: clip.audioUrl, job_id: clip.jobId, name: clip.name }),
    }).catch(() => {});
  }, [activeAudioProjectId]);

  const removeAudioClip = useCallback((clipId: string) => {
    setAudioClipsByProject((prev) => {
      const next = { ...prev };
      for (const projId of Object.keys(next)) {
        const clips = next[projId];
        const idx = clips.findIndex((c) => c.id === clipId);
        if (idx !== -1) {
          next[projId] = clips.filter((c) => c.id !== clipId);
          break;
        }
      }
      return next;
    });
    fetch(`/api/audio-clips/${clipId}`, { method: "DELETE", credentials: "include" }).catch(() => {});
  }, []);

  const saveAudioClipToLibrary = useCallback(async (clipId: string) => {
    try {
      const res = await fetch(`/api/audio-clips/${clipId}/save-to-library`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.ok && data.asset) {
        setAudioClipsByProject((prev) => {
          const next = { ...prev };
          for (const projId of Object.keys(next)) {
            const clips = next[projId];
            const idx = clips.findIndex((c) => c.id === clipId);
            if (idx !== -1) {
              next[projId] = clips.map((c) =>
                c.id === clipId ? { ...c, savedAssetId: data.asset.id } : c
              );
              break;
            }
          }
          return next;
        });
        invalidateAssetCache("audio:");
        setAssetRefreshKey((k) => k + 1);
      }
    } catch (err) {
      console.error("Save to library error:", err);
    }
  }, []);

  const updateAudioClip = useCallback((clipId: string, updates: Partial<AudioClip>) => {
    setAudioClipsByProject((prev) => {
      const next = { ...prev };
      for (const projId of Object.keys(next)) {
        const clips = next[projId];
        const idx = clips.findIndex((c) => c.id === clipId);
        if (idx !== -1) {
          next[projId] = [...clips];
          next[projId][idx] = { ...clips[idx], ...updates };
          break;
        }
      }
      return next;
    });
    const dbUpdates: Record<string, unknown> = {};
    if (updates.audioUrl !== undefined) dbUpdates.audio_url = updates.audioUrl;
    if (updates.duration !== undefined) dbUpdates.duration = updates.duration;
    if (updates.jobId !== undefined) dbUpdates.job_id = updates.jobId;
    if (updates.name !== undefined) dbUpdates.name = updates.name;
    if (Object.keys(dbUpdates).length > 0) {
      fetch(`/api/audio-clips/${clipId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(dbUpdates),
      }).catch(() => {});
    }
  }, []);

  const audioPollMetaRef = useRef<Record<string, { failures: number; startedAt: number }>>({});

  useEffect(() => {
    const allClips = Object.values(audioClipsByProject).flat();
    const loadingClips = allClips.filter((c) => c.loading && c.jobId && !c.audioUrl);
    if (loadingClips.length === 0) return;

    const MAX_CONSECUTIVE_FAILURES = 5;
    const MAX_LOADING_MS = 5 * 60 * 1000;
    const ACTIVE_STATUSES = new Set(["queued", "pending", "processing", "in_progress", "generating"]);
    const now = Date.now();
    const meta = audioPollMetaRef.current;
    for (const clip of loadingClips) {
      if (!meta[clip.id]) {
        const jobStarted = clip.createdAt ? new Date(clip.createdAt).getTime() : now;
        meta[clip.id] = { failures: 0, startedAt: isNaN(jobStarted) ? now : jobStarted };
      }
    }

    const activeIds = new Set(loadingClips.map((c) => c.id));
    for (const id of Object.keys(meta)) {
      if (!activeIds.has(id)) delete meta[id];
    }

    const interval = setInterval(async () => {
      for (const clip of loadingClips) {
        const m = meta[clip.id];
        if (!m) continue;

        if (m.failures >= MAX_CONSECUTIVE_FAILURES) {
          updateAudioClip(clip.id, { loading: false, failed: true });
          delete meta[clip.id];
          continue;
        }

        const isTimedOut = (Date.now() - m.startedAt) >= MAX_LOADING_MS;

        try {
          const res = await fetch(`/api/job/${clip.jobId}`, { credentials: "include" });
          if (!res.ok) {
            m.failures += 1;
            if (m.failures >= MAX_CONSECUTIVE_FAILURES) {
              updateAudioClip(clip.id, { loading: false, failed: true });
              delete meta[clip.id];
            }
            continue;
          }
          const data = await res.json();
          m.failures = 0;
          if (data.status === "complete" || data.status === "completed") {
            updateAudioClip(clip.id, { audioUrl: data.result_url || undefined, loading: false });
            delete meta[clip.id];
          } else if (data.status === "failed" || data.status === "cancelled") {
            updateAudioClip(clip.id, { loading: false, failed: true });
            delete meta[clip.id];
          } else if (isTimedOut && !ACTIVE_STATUSES.has(data.status)) {
            updateAudioClip(clip.id, { loading: false, failed: true });
            delete meta[clip.id];
          }
        } catch {
          m.failures += 1;
          if (m.failures >= MAX_CONSECUTIVE_FAILURES) {
            updateAudioClip(clip.id, { loading: false, failed: true });
            delete meta[clip.id];
          }
        }
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [audioClipsByProject, updateAudioClip]);

  const handleCanvasSelectImage = useCallback((id: string, mode: "exclusive" | "toggle" = "exclusive") => {
    setDroppedImage(null);
    setSelectedImageIds((prev) => {
      if (mode === "toggle") {
        const idx = prev.indexOf(id);
        if (idx !== -1) return prev.filter((_, i) => i !== idx);
        return [...prev, id];
      }
      if (prev.length === 1 && prev[0] === id) return prev;
      return [id];
    });
  }, []);

  const handleCanvasSelectMultiple = useCallback((ids: string[], mode: "exclusive" | "add" = "exclusive") => {
    setSelectedImageIds((prev) => {
      if (mode === "add") {
        const existing = new Set(prev);
        const newIds = ids.filter((id) => !existing.has(id));
        return newIds.length === 0 ? prev : [...prev, ...newIds];
      }
      if (prev.length === ids.length && prev.every((id, i) => id === ids[i])) return prev;
      return ids;
    });
  }, []);


  const [droppedImage, setDroppedImage] = useState<ReferenceImage | null>(null);
  const [externalPrompt, setExternalPrompt] = useState<string | null>(null);
  const [recycledReferenceImages, setRecycledReferenceImages] = useState<ReferenceImage[]>([]);
  const [recycleNotice, setRecycleNotice] = useState<string | null>(null);
  const recycleNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recycleRequestSeqRef = useRef(0);
  const showRecycleNotice = useCallback((msg: string) => {
    setRecycleNotice(msg);
    if (recycleNoticeTimerRef.current) clearTimeout(recycleNoticeTimerRef.current);
    recycleNoticeTimerRef.current = setTimeout(() => setRecycleNotice(null), 5000);
  }, []);
  const handleRecyclePrompt = useCallback((prompt: string, jobId?: string | null) => {
    setExternalPrompt(prompt);
    setSelectedImageIds([]);
    setSelectedNodeMeta(new Map());
    setDroppedImage(null);
    const seq = ++recycleRequestSeqRef.current;
    setRecycledReferenceImages([]);
    if (!jobId) return;
    (async () => {
      try {
        const res = await fetch(`/api/job/${encodeURIComponent(jobId)}/recycle`, { credentials: "include" });
        if (!res.ok) return;
        if (seq !== recycleRequestSeqRef.current) return;
        const data = await res.json();
        const urls: string[] = Array.isArray(data?.referenceImageUrls) ? data.referenceImageUrls : [];
        if (urls.length === 0) return;
        const probes = await Promise.all(urls.map((url) => new Promise<{ url: string; ok: boolean }>((resolve) => {
          if (url.startsWith("data:")) { resolve({ url, ok: true }); return; }
          const img = new Image();
          let settled = false;
          const finish = (ok: boolean) => {
            if (settled) return;
            settled = true;
            resolve({ url, ok });
          };
          img.onload = () => finish(true);
          img.onerror = () => finish(false);
          setTimeout(() => finish(false), 8000);
          img.src = url;
        })));
        if (seq !== recycleRequestSeqRef.current) return;
        const reachable = probes.filter((p) => p.ok).map((p) => p.url);
        const dropped = probes.length - reachable.length;
        const refs: ReferenceImage[] = reachable.map((url, i) => ({
          id: `recycled-${jobId}-${i}`,
          label: "Reused input",
          gradient: `url(${url})`,
          nodeType: "image" as const,
        }));
        setRecycledReferenceImages(refs);
        if (dropped > 0) {
          showRecycleNotice(`${dropped} reused input image${dropped > 1 ? "s were" : " was"} no longer available.`);
        }
      } catch {
        /* ignore */
      }
    })();
  }, [showRecycleNotice]);
  const [reuseParams, setReuseParams] = useState<AudioGenerationParams | null>(null);
  const [reuseVersion, setReuseVersion] = useState(0);
  const [selectedNodeMeta, setSelectedNodeMeta] = useState<Map<string, ReferenceImage>>(new Map());
  canvasIdRef.current = effectiveCanvasProjectId;

  const referenceImage = useMemo<ReferenceImage | null>(() => {
    if (droppedImage) return droppedImage;
    if (selectedImageIds.length === 0) return null;
    for (const id of selectedImageIds) {
      const gen = GENERATION_LOOKUP.get(id);
      if (gen) {
        if (gen.type === "video") continue;
        return { id: gen.id, label: gen.label, gradient: gen.gradient, nodeType: "image" as const };
      }
      const nodeMeta = selectedNodeMeta.get(id);
      if (nodeMeta) {
        if (nodeMeta.nodeType === "video" || nodeMeta.nodeType === "svg" || nodeMeta.nodeType === "group" || nodeMeta.nodeType === "frame" || nodeMeta.nodeType === "text") continue;
        // Skip nodes whose underlying image isn't reachable yet — empty src,
        // unresolved blob: URLs, or anything that's not an http(s) / data URL.
        // Without this guard, a half-loaded selection would flow into the
        // generator as an empty reference and trip a base64 decode error
        // server-side; treat it as "no reference" instead.
        const grad = nodeMeta.gradient || "";
        if (!grad) continue;
        if (grad.startsWith("blob:")) continue;
        return nodeMeta;
      }
    }
    return null;
  }, [droppedImage, selectedImageIds, selectedNodeMeta]);

  const referenceVideo = useMemo<ReferenceImage | null>(() => {
    if (selectedImageIds.length === 0) return null;
    for (const id of selectedImageIds) {
      const gen = GENERATION_LOOKUP.get(id);
      if (gen) {
        if (gen.type === "video") return { id: gen.id, label: gen.label, gradient: gen.gradient, nodeType: "video" as const };
        continue;
      }
      const nodeMeta = selectedNodeMeta.get(id);
      if (nodeMeta) {
        if (nodeMeta.nodeType === "video") return nodeMeta;
      }
    }
    return null;
  }, [selectedImageIds, selectedNodeMeta]);

  const canvasReferenceImages = useMemo<ReferenceImage[]>(() => {
    const refs: ReferenceImage[] = [];
    for (const id of selectedImageIds) {
      const gen = GENERATION_LOOKUP.get(id);
      if (gen) {
        if (gen.type === "video") continue;
        refs.push({ id: gen.id, label: gen.label, gradient: gen.gradient, nodeType: "image" as const });
        continue;
      }
      const nodeMeta = selectedNodeMeta.get(id);
      if (nodeMeta) {
        if (nodeMeta.nodeType === "video" || nodeMeta.nodeType === "svg" || nodeMeta.nodeType === "group" || nodeMeta.nodeType === "frame" || nodeMeta.nodeType === "text") continue;
        if (nodeMeta.axiomImages && nodeMeta.axiomImages.length > 0) {
          for (let i = 0; i < nodeMeta.axiomImages.length; i++) {
            refs.push({ id: `${id}-axiom-${i}`, label: nodeMeta.label, gradient: nodeMeta.axiomImages[i], aspectRatio: nodeMeta.aspectRatio, axiomName: nodeMeta.axiomName, axiomDescription: nodeMeta.axiomDescription, nodeType: "image" as const });
          }
        } else {
          // Same eligibility check as `referenceImage` — drop nodes whose image
          // isn't actually fetchable so the generator never receives an empty
          // or `blob:` URL that fal.ai would later reject.
          const grad = nodeMeta.gradient || "";
          if (!grad || grad.startsWith("blob:")) continue;
          refs.push(nodeMeta);
        }
        continue;
      }
    }
    for (const r of recycledReferenceImages) refs.push(r);
    return refs;
  }, [selectedImageIds, selectedNodeMeta, recycledReferenceImages]);


  const handleDeselectAll = useCallback(() => {
    setSelectedImageIds([]);
    setSelectedNodeMeta(new Map());
  }, []);

  const selectionContext = useMemo(() => {
    if (selectedImageIds.length === 0) return { type: "none" as const, count: 0 };
    if (selectedImageIds.length > 1) return { type: "multi" as const, count: selectedImageIds.length };
    const activeId = selectedImageIds[0];
    const gen = GENERATION_LOOKUP.get(activeId);
    if (gen) {
      if (gen.type === "video") return { type: "video" as const, count: 1 };
      return { type: "image" as const, count: 1 };
    }
    const nodeMeta = selectedNodeMeta.get(activeId);
    if (nodeMeta) {
      if (nodeMeta.nodeType === "video") return { type: "video" as const, count: 1 };
      if (nodeMeta.nodeType === "svg") return { type: "svg" as const, count: 1 };
      if (nodeMeta.nodeType === "group") return { type: "none" as const, count: 0 };
      if (nodeMeta.nodeType === "frame") return { type: "none" as const, count: 0 };
      if (nodeMeta.nodeType === "cinema") return { type: "cinema" as const, count: 1 };
      if (nodeMeta.nodeType === "shape") return { type: "shape" as const, count: 1 };
      if (nodeMeta.nodeType === "text") return { type: "text" as const, count: 1 };
      return { type: "image" as const, count: 1 };
    }
    if (activeId.startsWith("local-")) return { type: "none" as const, count: 0 };
    return { type: "image" as const, count: 1 };
  }, [selectedImageIds, selectedNodeMeta]);

  const selectedVideoInfo = useMemo<{ src: string; duration: number } | null>(() => {
    if (selectedImageIds.length !== 1) return null;
    const activeId = selectedImageIds[0];
    const gen = GENERATION_LOOKUP.get(activeId);
    if (gen && gen.type === "video") {
      const url = gen.gradient || "";
      const dur = gen.duration ? parseFloat(gen.duration) : 0;
      return { src: url, duration: dur };
    }
    const nodeMeta = selectedNodeMeta.get(activeId);
    if (nodeMeta && nodeMeta.nodeType === "video") {
      const url = nodeMeta.gradient || "";
      const dur = typeof nodeMeta.duration === "number" && Number.isFinite(nodeMeta.duration) ? nodeMeta.duration : 0;
      return { src: url, duration: dur };
    }
    return null;
  }, [selectedImageIds, selectedNodeMeta]);

  const handleClearReference = useCallback(() => {
    setSelectedImageIds([]);
    setDroppedImage(null);
    setSelectedNodeMeta(new Map());
    setRecycledReferenceImages([]);
  }, []);

  const handleFrameChange = useCallback((first: string | null, last: string | null) => {
    setVideoFrameIds((prev) => {
      if (prev.first === first && prev.last === last) return prev;
      return { first, last };
    });
  }, []);

  const handleDropReference = useCallback((ref: ReferenceImage) => {
    setDroppedImage(ref);
    setSelectedImageIds([]);
  }, []);

  const handleToggleFolderItem = useCallback((id: string, meta?: { name: string; thumb: string }) => {
    setFolderSelectedItems((prev) => {
      const next = new Map(prev);
      if (next.has(id)) { next.delete(id); } else { next.set(id, meta || { name: id, thumb: "" }); }
      return next;
    });
  }, []);

  const handleAddFolderItem = useCallback((item: { id: string; label: string; gradient: string }) => {
    setFolderSelectedItems((prev) => {
      const next = new Map(prev);
      next.set(item.id, { name: item.label, thumb: item.gradient });
      return next;
    });
  }, []);

  const handleClearPendingItem = useCallback((id: string) => {
    setFolderSelectedItems((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const togglePresentMode = useCallback(() => {
    setPresentMode((prev) => !prev);
  }, []);

  const exitPresentMode = useCallback(() => {
    setPresentMode(false);
  }, []);

  // Poll any `generating` placeholder nodes that have a job_id attached and
  // upgrade them in place once the job completes (or flip them to a failed
  // state so GeneratingNode shows the dismiss-able error overlay). This is
  // the canvas-side counterpart to the AgentPanel's per-job polling and
  // covers every right-panel generation routed through `startGeneration`.
  useEffect(() => {
    const pendingNodes = canvasNodes.filter((n) => {
      if (n.node_type !== "generating" || !n.job_id) return false;
      const meta = (n.metadata as Record<string, unknown> | null | undefined) || {};
      if (meta.status === "failed") return false;
      // Phase K: the OperatorPanel does NOT resolve its own canvas placeholders
      // (generations are driven server-side via Claude Code + MCP), so the canvas
      // poller owns resolution for agent-sourced nodes too. (The legacy AgentPanel,
      // which did its own polling, is disabled behind SHOW_LEGACY_AGENT.)
      return true;
    });
    if (pendingNodes.length === 0) return;
    const seenStatus = new Map<string, string>();
    let cancelled = false;
    const tick = async () => {
      // Use the stable proxy (not canvasApiRef) so we get `isLive` and the
      // pass-through to the live `updateNode` even across canvas remounts.
      // The underlying ref doesn't expose `isLive`, so checking it there
      // silently early-returned every tick and the placeholder never resolved.
      const api = canvasApiProxy;
      if (!api?.isLive?.() || !api.updateNode) return;
      // Re-read live nodes each tick so we don't operate on stale ids.
      let live: CanvasNode[] = [];
      try { live = api.getNodes?.() || []; } catch { return; }
      const liveById = new Map(live.map((n) => [n.id, n] as const));
      for (const n of pendingNodes) {
        if (cancelled) return;
        const current = liveById.get(n.id);
        if (!current || current.node_type !== "generating" || !current.job_id) continue;
        try {
          const r = await fetch(`/api/job/${current.job_id}`, { credentials: "include" });
          if (!r.ok) continue;
          const job = await r.json();
          const status = job.status as string | undefined;
          const prev = seenStatus.get(current.id);
          seenStatus.set(current.id, status || "");
          if (status === "complete" && job.result_url) {
            const meta = (current.metadata as Record<string, unknown>) || {};
            const kind = (meta.kind as string) || (job.type === "video_gen" || job.type === "avatar" ? "video" : job.type === "audio_music" ? "music" : "image");
            const nodeType: string =
              kind === "video" ? "video"
              : kind === "audio" || kind === "music" ? "audio"
              : kind === "svg" ? "svg"
              : "image";
            const jobMeta = (job.metadata as Record<string, unknown> | null) || {};
            const svgContent = (jobMeta.svg_content as string | undefined) || undefined;
            api.updateNode(current.id, {
              node_type: nodeType,
              src: job.result_url as string,
              label: (meta.prompt as string) || nodeType,
              metadata: {
                ...meta,
                status: "ready",
                jobId: current.job_id,
                ...(svgContent ? { svg_content: svgContent } : {}),
              },
            });
            if (prev !== "complete") playComplete();
          } else if (status === "failed" || status === "cancelled") {
            const meta = (current.metadata as Record<string, unknown>) || {};
            api.updateNode(current.id, {
              metadata: {
                ...meta,
                status: "failed",
                errorMsg: (job.error as string) || (status === "cancelled" ? "Cancelled" : "Generation failed"),
                jobId: current.job_id,
              },
            });
            if (prev !== "failed" && prev !== "cancelled") playError();
          }
        } catch { /* network blip — try again next tick */ }
      }
    };
    void tick();
    const id = setInterval(tick, 2000);
    return () => { cancelled = true; clearInterval(id); };
    // Re-bind only when the *set* of pending node+job pairs changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasNodes.filter((n) => {
    if (n.node_type !== "generating" || !n.job_id) return false;
    const meta = (n.metadata as Record<string, unknown> | null | undefined) || {};
    if (meta.status === "failed") return false;
    return true;
  }).map((n) => `${n.id}:${n.job_id}`).join(",")]);

  useEffect(() => {
    const handleGlobalKeys = (e: KeyboardEvent) => {
      if (e.key === "\\" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        togglePresentMode();
      }
      if (e.key === "Escape" && presentMode) {
        exitPresentMode();
      }
      if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
        if (e.target instanceof HTMLElement && e.target.isContentEditable) return;
        const btn = document.querySelector<HTMLButtonElement>("button[data-generate-btn]");
        if (btn && !btn.disabled) {
          e.preventDefault();
          btn.click();
        }
      }
    };
    window.addEventListener("keydown", handleGlobalKeys);
    return () => window.removeEventListener("keydown", handleGlobalKeys);
  }, [togglePresentMode, exitPresentMode, presentMode]);

  const selectedFrameInfo = useMemo(() => {
    if (selectedImageIds.length === 0) return null;
    const frameIds: string[] = [];
    for (const id of selectedImageIds) {
      const meta = selectedNodeMeta.get(id);
      if (meta?.nodeType === "frame") frameIds.push(id);
    }
    if (frameIds.length === 0) return null;
    if (frameIds.length === 1) return { id: frameIds[0], ids: frameIds, multi: false };
    return { id: frameIds[0], ids: frameIds, multi: true };
  }, [selectedImageIds, selectedNodeMeta]);

  const selectedFrameHasVideo = useMemo(() => {
    if (!selectedFrameInfo || selectedFrameInfo.multi) return false;
    const frame = canvasNodes.find((n) => n.id === selectedFrameInfo.id && n.node_type === "frame");
    if (!frame) return false;
    return findOverlappingVideoNodes(frame, canvasNodes).length > 0;
  }, [selectedFrameInfo, canvasNodes]);

  const [videoExportState, setVideoExportState] = useState<{
    isExporting: boolean;
    stage: string;
    progress: number;
    error: string | null;
  }>({ isExporting: false, stage: "idle", progress: 0, error: null });

  const handleStartVideoFrameExport = useCallback((resolution: "match" | "1080p" | "720p", includeAudio: boolean) => {
    if (!selectedFrameInfo) return;
    canvasApiRef.current?.videoExport?.start(selectedFrameInfo.id, resolution, includeAudio);
  }, [selectedFrameInfo]);

  const handleCancelVideoFrameExport = useCallback(() => {
    canvasApiRef.current?.videoExport?.cancel();
  }, []);

  const handleCanvasApi = useCallback((api: CanvasApi) => {
    canvasApiRef.current = api;
    if (pendingCinemaInsertRef.current) {
      setTimeout(() => { tryInsertCinemaFrame(); }, 0);
    }
    // Children consume the canvas api via the stable `canvasApiProxy`
    // (built once around `canvasApiRef`); every method delegates to the
    // current ref so we don't need to mirror api identity into state.
    // `isLive()` on the proxy reflects the live mount state at call time.
    const ve = api.videoExport;
    if (!ve) return;
    setVideoExportState((prev) => {
      if (
        prev.isExporting === ve.isExporting &&
        prev.stage === ve.stage &&
        prev.progress === ve.progress &&
        prev.error === ve.error
      ) return prev;
      return {
        isExporting: ve.isExporting,
        stage: ve.stage,
        progress: ve.progress,
        error: ve.error,
      };
    });
  }, []);

  const handleResetVideoFrameExport = useCallback(() => {
    canvasApiRef.current?.videoExport?.reset();
  }, []);

  const selectedShapeInfo = useMemo(() => {
    if (selectedImageIds.length !== 1) return null;
    const meta = selectedNodeMeta.get(selectedImageIds[0]);
    if (meta?.nodeType === "shape") return { id: selectedImageIds[0] };
    return null;
  }, [selectedImageIds, selectedNodeMeta]);

  const selectedCinemaTimelineState = useMemo(() => {
    if (selectionContext.type !== "cinema" || selectedImageIds.length !== 1) return null;
    const meta = selectedNodeMeta.get(selectedImageIds[0]);
    return meta?.timelineState ?? null;
  }, [selectionContext.type, selectedImageIds, selectedNodeMeta]);

  const multiHasShapeOrFrame = useMemo(() => {
    if (selectedImageIds.length < 2) return false;
    for (const id of selectedImageIds) {
      const meta = selectedNodeMeta.get(id);
      if (meta?.nodeType === "shape" || meta?.nodeType === "frame" || meta?.nodeType === "text" || meta?.nodeType === "svg") return true;
    }
    return false;
  }, [selectedImageIds, selectedNodeMeta]);

  useEffect(() => {
    // Selecting frames, shapes, text, or SVGs is a "design intent" — flip
    // the right panel to the Design tool AND open the Layers rail panel
    // on the left so the user sees both sides of the design surface at
    // the same time. Other selections (image / video / multi-mixed) leave
    // the rail untouched.
    const isDesignSelection =
      !!selectedFrameInfo ||
      !!selectedShapeInfo ||
      multiHasShapeOrFrame ||
      selectionContext.type === "shape" ||
      selectionContext.type === "text" ||
      selectionContext.type === "svg";
    if (isDesignSelection) {
      setSelectedTool("design");
      setRailView("layers");
    } else if (selectionContext.type !== "none") {
      setSelectedTool((prev) => prev === "design" ? "create" : prev);
    }
  }, [selectedFrameInfo, selectedShapeInfo, selectionContext.type, multiHasShapeOrFrame]);

  const hasSelectedImage = selectedImageIds.length > 0;
  // AudioListCanvas only takes over when the audio tool was selected via
  // the Audio rail. Cinema-rail audio selections keep FreeformCanvas
  // mounted so generations land as `audio` nodes on the design canvas.
  const isAudioListView = isAudioTool && !audioFromCinema;
  const isFreeformCanvasView = selectedTool !== "nodes" && selectedTool !== "auditlog" && !isAudioListView;
  const isCanvasMounted = isFreeformCanvasView && !!effectiveCanvasProjectId;
  isCanvasMountedRef.current = isCanvasMounted;
  isFreeformCanvasViewRef.current = isFreeformCanvasView;
  const showLoadingOverlay = isFreeformCanvasView && canvasLoading;
  const rightPanelOpen = !rightPanelHidden && !(selectedTool === "auditlog") && !agentOpen && (
    selectedTool === "nodes" || selectedTool === "sfx" || selectedTool === "voicechanger" ||
    selectedTool === "music" || selectedTool === "audio" || selectedTool === "tts" ||
    selectedTool === "make" || selectedTool === "create" || selectedTool === "upscale" ||
    selectedTool === "resize" || selectedTool === "remove" || selectedTool === "avatar" ||
    selectedTool === "design" || selectedTool === "clearcheck" || selectionContext.type !== "none" ||
    gifMakerOpen || svgMakerOpen
  );

  // The agent panel and the rpanel share the right edge — they can't
  // both be visible there. When the user picks a tool from the toolkit
  // (or opens the GIF/SVG maker), close the agent so the matching
  // right-side panel can take over. Library/Projects/Layers etc. live
  // on the LEFT and are NOT included here, so e.g. opening Library
  // while the agent is up keeps both visible (Library on the left,
  // Agent on the right).
  useEffect(() => {
    if (selectedTool || gifMakerOpen || svgMakerOpen) {
      setAgentOpen(false);
    }
  }, [selectedTool, gifMakerOpen, svgMakerOpen]);

  // Brief swap animation when the active right-side surface changes
  // (rpanel-tool ↔ rpanel-tool, or rpanel ↔ agent). The canvas card
  // slides right to cover the panel area (down to 20px from the
  // viewport edge), masking the unmount/mount of the underlying panel,
  // then slides back to its target inset as the new panel takes over.
  // Skip first paint, present mode, and pure open/close transitions
  // (those are handled by each panel's own enter/exit animation).
  const effectiveTool = gifMakerOpen ? "gifmaker" : svgMakerOpen ? "svgmaker" : selectedTool;
  const rightSurfaceKey: string = agentOpen
    ? "agent"
    : rightPanelOpen
      ? `rpanel:${effectiveTool ?? "none"}`
      : "none";
  const prevRightSurfaceKeyRef = useRef<string>(rightSurfaceKey);
  // Tracks the surface we were on when the current swap started, so a
  // mid-flight flip back to the original key (rapid hover/toggle) can
  // cancel the swap instead of re-triggering it and visually hiding
  // the right panel.
  const swapBaseRef = useRef<string | null>(null);
  // Helper: any branch that aborts an in-flight swap must also clear
  // the swap class so .app-body--swap / .canvas-area--swap cannot get
  // stuck and keep the right panel hidden.
  const cancelSwap = useCallback(() => {
    swapBaseRef.current = null;
    setPanelSwapping((on) => (on ? false : on));
  }, []);
  useEffect(() => {
    const prev = prevRightSurfaceKeyRef.current;
    prevRightSurfaceKeyRef.current = rightSurfaceKey;
    if (prev === rightSurfaceKey) return;
    if (presentMode) {
      cancelSwap();
      return;
    }
    // Only run the cover-slide on surface-to-surface swaps. Opening
    // from "none" or closing to "none" uses the panel's own
    // enter/exit motion (e.g. .agent-panel slide-in keyframe).
    if (prev === "none" || rightSurfaceKey === "none") {
      cancelSwap();
      return;
    }
    // Skip the swap when only the inner tool changes within the same
    // right-panel surface (e.g. rpanel:create → rpanel:upscale). Both
    // surfaces share the same chrome, so animating margin-right just
    // resizes the canvas and makes nodes visibly flash on every tool
    // switch. The swap only matters for true surface flips
    // (agent ↔ rpanel).
    const prevKind = prev.split(":")[0];
    const nextKind = rightSurfaceKey.split(":")[0];
    if (prevKind === nextKind) {
      cancelSwap();
      return;
    }
    // If the user just flipped back to the surface we were leaving,
    // cancel the in-flight swap rather than starting a fresh one.
    if (swapBaseRef.current === rightSurfaceKey) {
      cancelSwap();
      return;
    }
    swapBaseRef.current = prev;
    setPanelSwapping(true);
    const t = window.setTimeout(() => {
      setPanelSwapping(false);
      swapBaseRef.current = null;
    }, 240);
    return () => window.clearTimeout(t);
  }, [rightSurfaceKey, presentMode, cancelSwap]);
  // Safety net: if panelSwapping is somehow stuck on for longer than the
  // 240ms swap window (e.g. a transition was interrupted by a remount or
  // an unexpected branch), force-reset it so the right-side chrome can't
  // be left invisible.
  useEffect(() => {
    if (!panelSwapping) return;
    const t = window.setTimeout(() => {
      setPanelSwapping(false);
      swapBaseRef.current = null;
    }, 600);
    return () => window.clearTimeout(t);
  }, [panelSwapping]);

  const canShareProject = sharingEnabled && !isAudioTool && !!activeProjectId && !isActiveProjectViewer && activeAccess?.role === "owner";
  // Fullscreen ("hide right panel") also hides the agent panel so the
  // canvas can stretch to a true fullscreen layout from any state.
  // Toggling fullscreen back off restores whichever side was open before.
  const showAgentPanel = agentOpen && !rightPanelHidden;
  const showGenDesignTabs = !presentMode && !isActiveProjectViewer && !showAgentPanel && (
    gifMakerOpen || svgMakerOpen ||
    selectedTool === "make" || selectedTool === "create" || selectedTool === "upscale" ||
    selectedTool === "resize" || selectedTool === "remove" || selectedTool === "avatar" ||
    selectedTool === "design"
  );
  const showLeftToolbar = railView === "toolkit" || railView === "library";
  const showLayersPanel = railView === "layers";
  const leftToolbarMode: PageMode = railView === "library" ? "library" : "tools";

  const handleAgentHandoff = useCallback((handoff: AgentHandoff) => {
    setGifMakerOpen(false);
    setSvgMakerOpen(false);
    if (handoff.musicMode) {
      setSelectedTool("music");
      setExternalPrompt(handoff.prompt);
    } else {
      setMakeVideoMode(handoff.videoMode);
      setSelectedTool("create");
      setExternalPrompt(handoff.prompt);
      setSelectedImageIds([]);
      setSelectedNodeMeta(new Map());
      setDroppedImage(null);
      setRecycledReferenceImages(handoff.references);
    }
    setAgentOpen(false);
  }, []);

  // One handler set, three consumers: the side panel, the top tab strip and
  // the home screen. Hoisted rather than duplicated so "create a project"
  // means the same thing everywhere it can be triggered from.
  const openWithAgent = () => {
    setRailView(null);
    setAgentOpen(true);
  };

  const projectHandlers: ProjectsHandlers = {
          projects: projects.map((p) => ({
            id: p.id, name: p.name,
            date: p.date || new Date(p.updated_at || p.created_at || Date.now()).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
            items: p.node_count ?? p.items ?? 0,
            thumbnails: p.thumbnails || [],
          })),
          sharingEnabled,
          sharedProjects: sharedProjects.map((p) => ({
            id: p.id, name: p.name,
            date: p.date || new Date(p.updated_at || p.created_at || Date.now()).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
            items: p.node_count ?? p.items ?? 0,
            thumbnails: p.thumbnails || [],
            viewer_role: "viewer" as const,
            owner_display_name: p.owner_display_name,
            owner_email: p.owner_email,
          })),
          activeTab: projectsTab,
          onTabChange: (t: ProjectsTab) => setProjectsTab(t),
          currentProject: activeProjectId || "",
          onSelect: async (id: string) => {
            // Opening a project lands you in the agent, not the toolkit — the
            // first thing you do in a project is ask for something.
            if (id === activeProjectId) { openWithAgent(); return; }
            manualProjectSelectTsRef.current = Date.now();
            await canvasFlushRef.current?.();
            setSelectedTool("create");
            setActiveProjectId(id);
            openWithAgent();
          },
          onCreate: async (name: string) => {
            const wsId = activeWorkspace?.id;
            if (!wsId) {
              console.warn("[create-project] aborted: no active workspace");
              return;
            }
            try {
              const r = await fetch(`/api/projects/${wsId}`, {
                method: "POST", credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name }),
              });
              if (!r.ok) {
                let detail = "";
                try { detail = JSON.stringify(await r.json()); } catch {}
                console.error(`[create-project] POST /api/projects/${wsId} failed: ${r.status} ${detail}`);
                return;
              }
              const data = await r.json();
              const newProject = data?.project;
              if (!newProject?.id) {
                console.error("[create-project] response missing project.id", data);
                return;
              }
              manualProjectSelectTsRef.current = Date.now();
              await canvasFlushRef.current?.();
              setSelectedTool("create");
              setProjects((prev) => prev.some((p) => p.id === newProject.id) ? prev : [newProject, ...prev]);
              setActiveProjectId(newProject.id);
              openWithAgent();
              fetchProjects(newProject.id);
            } catch (err) {
              console.error("[create-project] unexpected error", err);
            }
          },
          onDelete: (id: string) => {
            fetch(`/api/projects/${id}`, { method: "DELETE", credentials: "include" })
              .then((r) => { if (r.ok) return r.json(); throw new Error("Failed"); })
              .then(() => {
                if (activeWorkspace?.id) invalidateCanvasCache(`ws:${activeWorkspace.id}:project:${id}`);
                fetchProjects(activeProjectId === id ? null : activeProjectId);
              })
              .catch(() => {});
          },
          onRename: (id: string, newName: string) => {
            fetch(`/api/projects/${id}/rename`, {
              method: "PUT", credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: newName }),
            })
              .then((r) => { if (r.ok) return r.json(); throw new Error("Failed"); })
              .then(() => fetchProjects(activeProjectId))
              .catch(() => {});
          },
          defaultName: "Untitled Project",
  };

  return (
    <div className="app">
      {/* Frameless-window drag strip, confined to the right panel area so the
        * canvas and rail reach the top of the window. The native min/max/close
        * overlay is drawn by the OS at its right end (see titleBarOverlay in
        * electron/main.cjs); this only supplies the draggable region. Width
        * tracks the open panel so it never eats clicks over the canvas — with a
        * floor wide enough to still grab when both panels are closed (a
        * frameless window has no other drag handle). Hidden on the web build. */}
      <div
        className="app-titlebar"
        aria-hidden="true"
        style={{ ["--titlebar-w" as string]: showAgentPanel ? "360px" : rightPanelOpen ? "300px" : "184px" }}
      />
      {shareModalOpen && activeProjectId && (
        <ShareModal
          projectId={activeProjectId}
          projectName={projectName || "Untitled Project"}
          onClose={() => setShareModalOpen(false)}
        />
      )}
      {recycleNotice && (
        <div style={{
          position: "fixed", bottom: 16, left: "50%", transform: "translateX(-50%)",
          background: "#1a1a1a", color: "#fff", padding: "10px 16px", borderRadius: 8,
          border: "1px solid #333", zIndex: 1001, fontSize: 13, maxWidth: 420, textAlign: "center",
          boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
        }}>
          {recycleNotice}
        </div>
      )}
      {viewerCapReached && isActiveProjectViewer && (
        <div style={{
          position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)",
          background: "#1a1a1a", color: "#fff", padding: "12px 18px", borderRadius: 8,
          border: "1px solid #333", zIndex: 1000, fontSize: 13, maxWidth: 420, textAlign: "center",
          boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
        }}>
          This project is full. The owner has reached the maximum number of concurrent viewers — try again in a few minutes.
        </div>
      )}
      <div className={`app-body${rightPanelOpen && !presentMode ? " app-body--with-panel" : ""}${panelSwapping ? " app-body--swap" : ""}${settingsOpen ? " app-body--settings-open" : ""}`} style={{ ["--rpanel-top-pad" as string]: (rightPanelOpen && showGenDesignTabs) ? "56px" : "10px" }}>
        {showLoadingOverlay && (
          <div className="app-loading-overlay">
            <QuantumThinking
              size={120}
              color="var(--accent)"
              ariaLabel="Loading workspace"
            />
          </div>
        )}
        <IconRail
          activeView={railView}
          onSelectView={(v) => {
            setRailView(v);
            // Toolkit and Agent share the right work area, so opening the
            // Toolkit closes the Agent (and vice versa, below). Other rail
            // views (Library, Projects, Design) are unaffected.
            if (v === "toolkit") setAgentOpen(false);
            if (v === "library") {
              setPageMode("library");
              if (!libraryView) handleLibrarySelect("images");
            } else {
              closeAllLibraryPanels();
              setLibraryView(null);
              setLibraryInitialFolderId(null);
              setLibraryHighlightAssetId(null);
              if (v === "toolkit") setPageMode("tools");
            }
          }}
          unreadCount={unreadCount}
          onActivateDesign={() => { setGifMakerOpen(false); setSvgMakerOpen(false); setSelectedTool("design"); }}
          isDesignActive={selectedTool === "design"}
          agentOpen={agentOpen}
          onToggleAgent={() => {
            setAgentOpen((v) => {
              const willOpen = !v;
              // Opening the Agent closes the Toolkit so the two never
              // share the right work area at the same time.
              if (willOpen && railView === "toolkit") setRailView(null);
              return willOpen;
            });
          }}
          onOpenApiKeys={() => setApiKeysOpen(true)}
        />
        {quickSettingsOpen && (
          <QuickSettingsPanel
            onClose={() => { setRailView(null); setSettingsOpen(false); }}
            onSettingsOpen={(section?: string) => { setSettingsSection(section || "account"); setSettingsOpen(true); }}
            notifications={notifications}
            unreadCount={unreadCount}
            onMarkRead={markRead}
            onMarkAllRead={markAllRead}
          />
        )}
        {railView === "skills" && (
          <SkillsPanel
            onClose={() => setRailView(null)}
            onUseSkill={(slug, title) => {
              setAgentOpen(true);
              setAgentSeed({ text: `Use my "${title}" skill (slug: ${slug}) — read it with get_skill first, then follow it.`, nonce: Date.now() });
            }}
          />
        )}
        {railView === "github" && <GitHubPanel onClose={() => setRailView(null)} />}
        {showLeftToolbar && (
          <LeftToolbar
            mode={leftToolbarMode}
            selectedTool={gifMakerOpen ? "gifmaker" : svgMakerOpen ? "svgmaker" : selectedTool}
            onToolSelect={handleToolSelect}
            onCinemaChildSelect={handleCinemaChildSelect}
            onSettingsOpen={(section?: string) => { setSettingsSection(section || "account"); setSettingsOpen(true); }}
            onLibrarySelect={handleLibrarySelect}
            activeLibraryView={libraryView}
            readOnly={isActiveProjectViewer}
            onClose={() => setRailView(null)}
          />
        )}
        {showLayersPanel && (
          <LayersPanel
            nodes={canvasNodes}
            selectedIds={selectedImageIds}
            onSelectNode={(id) => handleCanvasSelectImage(id, "exclusive")}
            onClose={() => setRailView(null)}
          />
        )}
        {showAgentPanel && (
          <OperatorPanel
            onClose={() => setAgentOpen(false)}
            onBusyChange={setAgentBusy}
            getCanvasContext={() => {
              // Snapshot the open canvas + viewport so operator generations land
              // where the user is looking (first gen) and cascade from there.
              let viewport: { cx: number; cy: number; w: number; h: number } | undefined;
              try {
                const vp = canvasApiProxy?.getViewport?.();
                if (vp && Number.isFinite(vp.cx)) viewport = { cx: vp.cx, cy: vp.cy, w: vp.w, h: vp.h };
              } catch { /* canvas not live yet */ }
              return { canvasId: canvasIdRef.current || undefined, viewport };
            }}
            canvasReferenceImages={canvasReferenceImages}
            seedPrompt={agentSeed}
          />
        )}
        {SHOW_LEGACY_AGENT && showAgentPanel && (
          <AgentPanel
            workspaceId={activeWorkspace?.id || null}
            canvasId={effectiveCanvasProjectId || null}
            canvasReferenceImages={canvasReferenceImages}
            isGuest={isGuest}
            canvasApi={canvasApiProxy}
            onBusyChange={setAgentBusy}
            onClose={() => setAgentOpen(false)}
            onFullCanvas={() => { setRightPanelHidden(true); }}
            onSignInRequest={authSignIn}
            onSettingsOpen={(section?: string) => { setSettingsSection(section || "account"); setSettingsOpen(true); }}
            onHandoffToMake={handleAgentHandoff}
            onMusicGenerationStarted={(clip) => {
              if (!activeAudioProjectId) return;
              const audioClip: AudioClip = {
                id: clip.id,
                type: "music" as AudioType,
                prompt: clip.prompt || "Music generation",
                duration: "0:00",
                bars: randomBars(80),
                style: clip.prompt?.slice(0, 30) || "Music",
                loading: true,
                jobId: clip.jobId,
                name: generateClipName(clip.id),
              };
              setAudioClipsByProject((prev) => {
                const projClips = prev[activeAudioProjectId] || [];
                if (projClips.some((c) => c.id === clip.id || (c.jobId && c.jobId === clip.jobId))) return prev;
                return { ...prev, [activeAudioProjectId]: [audioClip, ...projClips] };
              });
            }}
            onSaveToLibrary={async ({ url, kind, prompt }) => {
              try {
                await fetch("/api/assets/save-from-canvas", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  credentials: "include",
                  body: JSON.stringify({
                    name: prompt || "Agent generation",
                    file_url: url,
                    type: kind === "video" ? "video" : kind === "music" ? "audio" : "image",
                    metadata: { source: "agent", prompt },
                    default_folder: "Generations",
                  }),
                });
              } catch {
                /* surfaced via library refresh */
              }
            }}
          />
        )}
        {railView === "library" && libraryView && (
          <LibraryPanel
            view={libraryView}
            onClose={handleLibraryClose}
            onDragAsset={(data) => {
              handleDropReference({ id: data.id, label: data.label, gradient: data.gradient });
            }}
            onDragStyle={(p) => setExternalPrompt(p)}
            onOpenAxiomCreator={() => { closeAllLibraryPanels(); setAgentOpen(false); setGifMakerOpen(false); setSvgMakerOpen(false); setSelectedTool("create"); setAxiomCreatorOpen(true); }}
            onOpenStyleCreator={() => { closeAllLibraryPanels(); setAgentOpen(false); setGifMakerOpen(false); setSvgMakerOpen(false); setSelectedTool("create"); setStyleCreatorOpen(true); }}
            onOpenBucketManager={(ctx) => { closeAllLibraryPanels(); setAgentOpen(false); setGifMakerOpen(false); setSvgMakerOpen(false); setSelectedTool("create"); setBucketManagerOpen(ctx); }}
            onOpenFolderCreator={() => { closeAllLibraryPanels(); setAgentOpen(false); setGifMakerOpen(false); setSvgMakerOpen(false); setSelectedTool("create"); setFolderCreatorOpen(true); }}
            onOpenFolderManager={(folder) => { closeAllLibraryPanels(); setAgentOpen(false); setGifMakerOpen(false); setSvgMakerOpen(false); setSelectedTool("create"); setFolderManagerOpen(typeof folder === "string" ? { id: "", name: folder } : folder); }}
            onOpenAxiomManager={(id) => { closeAllLibraryPanels(); setAgentOpen(false); setGifMakerOpen(false); setSvgMakerOpen(false); setSelectedTool("create"); setAxiomManagerOpen(id); }}
            onOpenStyleManager={(id) => { closeAllLibraryPanels(); setAgentOpen(false); setGifMakerOpen(false); setSvgMakerOpen(false); setSelectedTool("create"); setStyleManagerOpen(id); }}
            folderSelectMode={folderCreatorOpen || !!folderManagerOpen}
            folderSelectedIds={folderSelectedItems}
            onToggleFolderItem={handleToggleFolderItem}
            folderRefreshKey={folderRefreshKey}
            axiomRefreshKey={axiomRefreshKey}
            styleRefreshKey={styleRefreshKey}
            assetRefreshKey={assetRefreshKey}
            initialFolderId={libraryInitialFolderId}
            highlightAssetId={libraryHighlightAssetId}
          />
        )}
        <div
          className={`canvas-area${presentMode ? " canvas-area--present" : ""}${(rightPanelOpen || showAgentPanel || (rightPanelHidden && !presentMode)) && !presentMode ? " canvas-area--card" : ""}${showAgentPanel && agentBusy && !presentMode ? " canvas-area--agent-busy" : ""}${panelSwapping ? " canvas-area--swap" : ""}`}
          style={{
            ["--canvas-left-inset" as string]:
              // QuickSettings and Settings panels honor the responsive
              // --qs-panel-width / --qs-settings-gap CSS vars so the
              // canvas card edge tracks them when they shrink at
              // narrower viewports. Other left-rail panels (toolkit,
              // projects, layers, library) still use fixed widths and
              // keep their original insets.
              // Each arm is (left stack width) + (open panel width) +
              // --canvas-inset-pad, rather than a baked-in pixel total: the
              // rail width and the trailing pad both change when the stack
              // docks (html.is-mac), and a hardcoded total leaves the canvas —
              // and the zoom pill anchored to it — floating off the rail edge.
              settingsOpen ? "calc(var(--panel-float-gap) + var(--icon-rail-width) + var(--qs-panel-width) + var(--qs-settings-gap) + 4px)" :
              railView === "library" ? "calc(var(--panel-float-gap) + var(--icon-rail-width) + 672px + var(--canvas-inset-pad))" :
              railView === "quick-settings" ? "calc(var(--panel-float-gap) + var(--icon-rail-width) + var(--qs-panel-width) + var(--canvas-inset-pad))" :
              railView === "skills" ? "calc(var(--panel-float-gap) + var(--icon-rail-width) + var(--skills-panel-width) + var(--canvas-inset-pad))" :
              railView === "toolkit" || railView === "layers" || railView === "github" ? "calc(var(--panel-float-gap) + var(--icon-rail-width) + 300px + var(--canvas-inset-pad))" :
              "calc(var(--panel-float-gap) + var(--icon-rail-width) + var(--canvas-inset-pad))",
            // Right inset: when the agent is open the right reserved
            // area is 360px — that's a 16px breathing gap + 320px
            // panel + 12px wing + 12px wing (the panel sits at right:
            // 12 inside the 344px backdrop area, and we add 16px more
            // on top so the canvas card pulls back just enough from
            // the chat surface for its blue glow to breathe without
            // feeling lopsided). Other right-side tools (rpanel) still
            // hug the viewport edge with the original 300px inset.
            // Fullscreen mode (rightPanelHidden, no panel/agent open):
            // keep a 20px breathing gap on the right so the canvas card
            // never reaches the viewport edge — paired with a floating
            // arrow that brings the panels back.
            ["--canvas-right-inset" as string]:
              settingsOpen ? "0px" :
              showAgentPanel ? "360px" :
              rightPanelOpen ? "300px" :
              (rightPanelHidden && !presentMode) ? "20px" : "0px",
          }}
        >
          {!presentMode && (
            <ProjectTabs
              projects={projects}
              openIds={openProjectIds}
              activeId={activeProjectId || ""}
              onSelect={(id) => projectHandlers.onSelect(id)}
              onClose={(id) => setOpenProjectIds((prev) => {
                const next = prev.filter((x) => x !== id);
                try { localStorage.setItem("openProjects", JSON.stringify(next)); } catch {}
                // Closing the tab you're on falls back to the neighbour, or home.
                if (id === activeProjectId) {
                  if (next.length) setActiveProjectId(next[next.length - 1]);
                  else setRailView("home");
                }
                return next;
              })}
              onCreate={() => projectHandlers.onCreate(projectHandlers.defaultName || "Untitled Project")}
              onRename={(id, name) => projectHandlers.onRename?.(id, name)}
            />
          )}
          {railView === "home" && (
            <div
              // Covers the canvas only; the tab strip is a flow sibling above it,
              // so switching stays one click away from the home screen.
              style={{
                position: "absolute",
                inset: "var(--project-tabs-h, 0px) 0 0 0",
                display: "flex",
                flexDirection: "column",
                zIndex: 10,
                background: "var(--app-bg, #0e0e12)",
                borderRadius: "inherit",
              }}
            >
              {projectsFetchError && (
                <div style={{ padding: "10px 40px", color: "#f0a0a0", fontSize: 12 }}>{projectsFetchError}</div>
              )}
              <ProjectsPage
                category="make"
                projects={projectHandlers.projects}
                currentProject={projectHandlers.currentProject}
                onSelect={projectHandlers.onSelect}
                onCreate={projectHandlers.onCreate}
                onDelete={projectHandlers.onDelete}
                onRename={projectHandlers.onRename}
                sharingEnabled={projectHandlers.sharingEnabled}
                sharedProjects={projectHandlers.sharedProjects}
                activeTab={projectHandlers.activeTab}
                onTabChange={projectHandlers.onTabChange}
              />
            </div>
          )}
          <div className="canvas-glow canvas-glow--sharp" aria-hidden="true" />
          <div className="canvas-glow-blur" aria-hidden="true">
            <div className="canvas-glow canvas-glow--soft" />
          </div>
          {isActiveProjectViewer && activeOwnerLabel && (
            <div
              style={{
                position: "absolute",
                left: 16,
                bottom: 16,
                padding: "6px 10px",
                background: "rgba(0,0,0,0.55)",
                backdropFilter: "blur(6px)",
                WebkitBackdropFilter: "blur(6px)",
                color: "#e6e9ee",
                fontSize: 11,
                fontWeight: 500,
                letterSpacing: 0.2,
                borderRadius: 6,
                border: "1px solid rgba(255,255,255,0.08)",
                pointerEvents: "none",
                zIndex: 5,
              }}
            >
              Viewing — owned by {activeOwnerLabel}
            </div>
          )}
          {selectedTool === "nodes" ? (
            <NodeCanvas
              nodes={wfNodes}
              edges={wfEdges}
              selectedNodeId={selectedNodeId}
              onSelectNode={setSelectedNodeId}
              onNodesChange={setWfNodes}
              onEdgesChange={setWfEdges}
            />
          ) : selectedTool === "auditlog" ? (
            <AuditLogPanel onClose={() => setSelectedTool("create")} refreshKey={auditRefreshKey} />
          ) : isAudioListView ? (
            <AudioListCanvas
              clips={activeAudioClips}
              onCancelClip={(clipId) => {
                const clip = activeAudioClips.find((c) => c.id === clipId);
                if (clip?.jobId) {
                  fetch(`/api/job/${clip.jobId}/cancel`, { method: "POST", credentials: "include" }).catch(() => {});
                }
                removeAudioClip(clipId);
              }}
              onDeleteClip={(clipId) => {
                removeAudioClip(clipId);
              }}
              onSaveClip={(clipId) => {
                saveAudioClipToLibrary(clipId);
              }}
              onReuseClip={(clipId) => {
                const clip = activeAudioClips.find((c) => c.id === clipId);
                if (!clip?.generationParams) return;
                const toolMap: Record<AudioType, string> = { tts: "tts", music: "music", sfx: "sfx", voicechanger: "voicechanger" };
                setSelectedTool(toolMap[clip.type] as ToolId);
                setReuseParams({ ...clip.generationParams });
                setReuseVersion((v) => v + 1);
              }}
              onRenameClip={(clipId, name) => {
                updateAudioClip(clipId, { name });
              }}
            />
          ) : (
            <ErrorBoundary what="The canvas">
            <FreeformCanvas
                selectedImageIds={selectedImageIds}
                onSelectImage={handleCanvasSelectImage}
                onSelectMultiple={handleCanvasSelectMultiple}
                onDeselectAll={handleDeselectAll}
                onNodeMeta={(id, meta) => setSelectedNodeMeta((prev) => { const next = new Map(prev); next.set(id, meta); return next; })}
                gifMakerMode={gifMakerOpen}
                onDropReference={handleDropReference}
                onDropPrompt={handleRecyclePrompt}
                libraryOpen={!!libraryView}
                onCanvasReady={() => {}}
                projectCanvasId={effectiveCanvasProjectId}
                canvasFlushRef={canvasFlushRef}
                onToolSelect={(id) => handleToolSelect(id as ToolId)}
                onLoadingChange={setCanvasLoading}
                fitAllTrigger={fitAllTrigger}
                firstFrameId={makeVideoMode ? videoFrameIds.first : null}
                lastFrameId={makeVideoMode ? videoFrameIds.last : null}
                onLibrarySaved={handleLibrarySaved}
                onOpenLibrary={handleOpenLibraryFromCanvas}
                presentMode={presentMode}
                onTogglePresentMode={togglePresentMode}
                rightPanelHidden={rightPanelHidden}
                onToggleRightPanelHidden={() => setRightPanelHidden((v) => !v)}
                activeTool={selectedTool || undefined}
                designSubTool={designSubTool}
                onDesignSubToolChange={setDesignSubTool}
                onActivateDesignTool={() => { setSelectedTool("design"); }}
                onCreateFrame={(w, h) => canvasApiRef.current?.addFrame(w, h)}
                pendingShapeKind={pendingShapeKind}
                onPendingShapeKindChange={setPendingShapeKind}
                onQuickRemoveBg={(imageUrl) => {
                  startGeneration({
                    model: "remove_bg",
                    prompt: "",
                    referenceImageUrls: [imageUrl],
                    jobType: "remove_bg",
                  });
                }}
                onSvgEditStateChange={setSvgEditState}
                projectName={projectName || undefined}
                onNodesChange={setCanvasNodes}
                dotPulseKey={dotPulseKey}
                onCanvasApi={handleCanvasApi}
              />
            </ErrorBoundary>
          )}
        </div>
        {rightPanelHidden && !presentMode && !settingsOpen && (
          <button
            type="button"
            className="canvas-area__restore-arrow"
            onClick={() => setRightPanelHidden(false)}
            title="Show panels"
            aria-label="Exit fullscreen — show panels"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
        )}
        {rightPanelOpen && showGenDesignTabs && !presentMode && (
          <div
            className="rpanel-top-tabs"
            role="tablist"
            aria-label="Right panel sections"
          >
            <button
              type="button"
              role="tab"
              aria-selected={selectedTool !== "design"}
              className={`rpanel-top-tabs__btn ${selectedTool !== "design" ? "rpanel-top-tabs__btn--active" : ""}`}
              onClick={() => { setGifMakerOpen(false); setSvgMakerOpen(false); setSelectedTool("make"); }}
            >Generation</button>
            <button
              type="button"
              role="tab"
              aria-selected={selectedTool === "design"}
              className={`rpanel-top-tabs__btn ${selectedTool === "design" ? "rpanel-top-tabs__btn--active" : ""}`}
              onClick={() => { setGifMakerOpen(false); setSvgMakerOpen(false); if (selectedTool !== "design") setSelectedTool("design"); }}
            >Design</button>
            <button
              type="button"
              className="rpanel-top-tabs__share"
              onClick={() => setShareModalOpen(true)}
              disabled={isGuest || !canShareProject}
              aria-label="Share project"
              title={isGuest ? "Sign in to share" : !canShareProject ? "Sharing unavailable for this view" : "Share project"}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
                <path d="M21.426 2.574a1 1 0 0 0-1.064-.226L2.74 9.36a1 1 0 0 0 .066 1.882l7.27 2.683 2.683 7.27a1 1 0 0 0 1.882.066l7.011-17.622a1 1 0 0 0-.226-1.064Z" />
              </svg>
            </button>
          </div>
        )}
        {rightPanelOpen && showGenDesignTabs && !presentMode && <div className="rpanel-top-tabs__divider" aria-hidden="true" />}
        {presentMode || rightPanelHidden || selectedTool === "auditlog" || isActiveProjectViewer || showAgentPanel ? null : selectedTool === "nodes" ? (
          selectedNodeId && wfNodes.find((n) => n.id === selectedNodeId) ? (
            <NodeInspectorPanel
              node={wfNodes.find((n) => n.id === selectedNodeId)!}
              nodes={wfNodes}
              edges={wfEdges}
              onClose={() => setSelectedNodeId(null)}
              onConfigChange={handleNodeConfigChange}
              onDeleteNode={handleDeleteNode}
            />
          ) : (
            <NodesPanelDefault
              onAddNode={handleAddNode}
              onRun={() => {}}
              onOpenLibrary={(view) => { setRailView("library"); setPageMode("library"); setLibraryView(view); }}
            />
          )
        ) : selectedTool === "sfx" ? (
          <SfxPanel onGenerate={(sfxParams: SfxParams) => {
            setReuseParams(null);
            const params: GenerationParams = {
              jobType: "audio_sfx",
              model: "elevenlabs-sfx",
              prompt: sfxParams.prompt,
              aspectRatio: "21:9",
              durationSeconds: sfxParams.durationSeconds || undefined,
              promptInfluence: sfxParams.promptInfluence,
            };
            if (canvasApiProxy.isLive?.()) { cinemaGen.dispatchAudioGeneration(params); return; }
            const clipId = crypto.randomUUID();
            const clip: AudioClip = { id: clipId, type: "sfx" as AudioType, prompt: sfxParams.prompt || "Sound effect generation", duration: "0:00", bars: randomBars(80), loading: true, generationParams: { sfx: sfxParams }, name: generateClipName(clipId) };
            addAudioClip(clip);
            startAudioGeneration(params).then((jobId) => {
              if (jobId) updateAudioClip(clipId, { jobId });
              else updateAudioClip(clipId, { loading: false, failed: true });
            });
          }} userBalance={balance} unlimited={unlimited} initialValues={reuseParams?.sfx ?? null} reuseVersion={reuseVersion} />
        ) : selectedTool === "voicechanger" ? (
          <VoiceChangerPanel onGenerate={(vcParams: VoiceChangerParams) => {
            setReuseParams(null);
            const params: GenerationParams = {
              jobType: "audio_voice_changer",
              prompt: "Voice changer generation",
              model: "elevenlabs-voice-changer",
              voice: vcParams.voice,
              stability: vcParams.stability,
              similarityBoost: vcParams.similarity,
              outputFormat: vcParams.outputFormat,
              audioUrl: vcParams.audioDataUrl,
            };
            if (canvasApiProxy.isLive?.()) { cinemaGen.dispatchAudioGeneration(params); return; }
            const clipId = crypto.randomUUID();
            const clip: AudioClip = { id: clipId, type: "voicechanger" as AudioType, prompt: "Voice changer generation", duration: "0:00", bars: randomBars(80), voice: vcParams.voice, loading: true, generationParams: { voicechanger: vcParams }, name: generateClipName(clipId) };
            addAudioClip(clip);
            startAudioGeneration(params).then((jobId) => {
              if (jobId) updateAudioClip(clipId, { jobId });
              else updateAudioClip(clipId, { loading: false, failed: true });
            });
          }} userBalance={balance} unlimited={unlimited} initialValues={reuseParams?.voicechanger ? { ...reuseParams.voicechanger, audioDataUrl: "" } : null} reuseVersion={reuseVersion} />
        ) : selectedTool === "music" ? (
          <MusicPanel onGenerate={(musicParams: MusicGenerationParams) => {
            setReuseParams(null);
            const params: GenerationParams = {
              jobType: "audio_music",
              model: "minimax-music",
              prompt: musicParams.prompt,
              aspectRatio: "21:9",
              lyrics: musicParams.lyrics,
              is_instrumental: musicParams.isInstrumental,
            };
            if (canvasApiProxy.isLive?.()) { cinemaGen.dispatchAudioGeneration(params); return; }
            const clipId = crypto.randomUUID();
            const clip: AudioClip = { id: clipId, type: "music" as AudioType, prompt: musicParams.prompt || "Music generation", duration: "0:00", bars: randomBars(80), style: musicParams.prompt.slice(0, 30) || "Music", loading: true, generationParams: { music: musicParams }, name: generateClipName(clipId) };
            addAudioClip(clip);
            startAudioGeneration(params).then((jobId) => {
              if (jobId) updateAudioClip(clipId, { jobId });
              else updateAudioClip(clipId, { loading: false, failed: true });
            });
          }} userBalance={balance} unlimited={unlimited} externalPrompt={externalPrompt} onClearExternalPrompt={() => setExternalPrompt(null)} initialValues={reuseParams?.music ?? null} reuseVersion={reuseVersion} />
        ) : selectedTool === "audio" || selectedTool === "tts" ? (
          <AudioPanel onGenerate={(ttsParams: TTSParams) => {
            setReuseParams(null);
            const promptText = ttsParams.text || "Text to speech generation";
            const params: GenerationParams = {
              jobType: "audio_tts",
              model: "minimax-tts",
              prompt: promptText,
              text: ttsParams.text,
              voice: ttsParams.voice,
              speed: ttsParams.speed,
              emotion: ttsParams.emotion,
              outputFormat: ttsParams.outputFormat,
            };
            if (canvasApiProxy.isLive?.()) { cinemaGen.dispatchAudioGeneration(params); return; }
            const clipId = crypto.randomUUID();
            const clip: AudioClip = { id: clipId, type: "tts" as AudioType, prompt: promptText, duration: "0:00", bars: randomBars(80), voice: ttsParams.voice, loading: true, generationParams: { tts: ttsParams }, name: generateClipName(clipId) };
            addAudioClip(clip);
            startAudioGeneration(params).then((jobId) => {
              if (jobId) updateAudioClip(clipId, { jobId });
              else updateAudioClip(clipId, { loading: false, failed: true });
            });
          }} userBalance={balance} unlimited={unlimited} initialValues={reuseParams?.tts ?? null} reuseVersion={reuseVersion} />
        ) : selectionContext.type === "cinema" ? (
          <CinemaExportPanel timelineStateRaw={selectedCinemaTimelineState} />
        ) : (!isCanvasMounted && !isGuest) ? null : selectedTool === "make" || selectedTool === "create" ? (
          <MakePanel
            videoMode={makeVideoMode}
            onVideoModeChange={setMakeVideoMode}
            selectedImageIds={selectedImageIds}
            canvasReferenceImages={canvasReferenceImages}
            onGenerate={startGeneration}
            userBalance={balance}
            unlimited={unlimited}
            referenceImage={referenceImage}
            onClearReference={handleClearReference}
            externalPrompt={externalPrompt}
            onClearExternalPrompt={() => setExternalPrompt(null)}
            onFrameChange={handleFrameChange}
          />
        ) : selectedTool === "upscale" ? (
          <UpscalePanel onUpscaleImage={startGeneration} userBalance={balance} unlimited={unlimited} referenceImage={referenceImage} referenceVideo={referenceVideo} videoDuration={selectedVideoInfo?.duration} onClearReference={handleClearReference} />
        ) : selectedTool === "resize" ? (
          <ResizePanel onResizeImage={startGeneration} userBalance={balance} unlimited={unlimited} referenceImage={referenceImage} onClearReference={handleClearReference} externalPrompt={externalPrompt} onClearExternalPrompt={() => setExternalPrompt(null)} />
        ) : selectedTool === "remove" ? (
          <RemovePanel onRemoveBackground={startGeneration} userBalance={balance} unlimited={unlimited} referenceImage={referenceImage} onClearReference={handleClearReference} />
        ) : selectedTool === "avatar" ? (
          <AvatarPanel onGenerate={startGeneration} userBalance={balance} unlimited={unlimited} referenceImage={referenceImage} referenceVideo={referenceVideo} onClearReference={handleClearReference} externalPrompt={externalPrompt} onClearExternalPrompt={() => setExternalPrompt(null)} />
        ) : selectedTool === "design" ? (
          <DesignPanel
            onCreateFrame={(w, h) => canvasApiRef.current?.addFrame(w, h)}
            hasSelectedFrame={!!selectedFrameInfo}
            selectedFrameColor={selectedFrameInfo ? (selectedNodeMeta.get(selectedFrameInfo.id)?.fill || getDefaultFrameFill()) : null}
            onFrameColorChange={(color) => {
              if (selectedFrameInfo) {
                canvasApiRef.current?.updateFrameColor(selectedFrameInfo.id, color);
                setSelectedNodeMeta((prev) => {
                  const next = new Map(prev);
                  const existing = next.get(selectedFrameInfo.id);
                  if (existing) next.set(selectedFrameInfo.id, { ...existing, fill: color });
                  return next;
                });
              }
            }}
            selectedFrameIds={selectedFrameInfo?.ids}
            onExportFrames={(format) => {
              if (selectedFrameInfo) canvasApiRef.current?.exportFrames(selectedFrameInfo.ids, format);
            }}
            selectedFrameHasVideo={selectedFrameHasVideo}
            videoExport={{
              isExporting: videoExportState.isExporting,
              stage: videoExportState.stage,
              progress: videoExportState.progress,
              error: videoExportState.error,
              start: handleStartVideoFrameExport,
              cancel: handleCancelVideoFrameExport,
              reset: handleResetVideoFrameExport,
            }}
            activeSubTool={designSubTool}
            onSubToolChange={setDesignSubTool}
            pendingShapeKind={pendingShapeKind}
            onPendingShapeKindChange={setPendingShapeKind}
            selectedNodeMeta={selectedNodeMeta}
            selectedImageIds={selectedImageIds}
            onUpdateNodeTransform={(nodeId, props) => {
              canvasApiRef.current?.updateNodeTransform(nodeId, props);
              setSelectedNodeMeta((prev) => {
                const next = new Map(prev);
                const existing = next.get(nodeId);
                if (existing) {
                  next.set(nodeId, {
                    ...existing,
                    ...(props.x !== undefined ? { x: props.x } : {}),
                    ...(props.y !== undefined ? { y: props.y } : {}),
                    ...(props.width !== undefined ? { width: props.width } : {}),
                    ...(props.height !== undefined ? { height: props.height } : {}),
                    ...(props.rotation !== undefined ? { rotation: props.rotation } : {}),
                  });
                }
                return next;
              });
            }}
            onUpdateNodeMetadata={(nodeId, meta) => {
              canvasApiRef.current?.updateNodeMetadata(nodeId, meta);
              setSelectedNodeMeta((prev) => {
                const next = new Map(prev);
                const existing = next.get(nodeId);
                if (existing) {
                  next.set(nodeId, {
                    ...existing,
                    ...(meta.borderRadius !== undefined ? { borderRadius: meta.borderRadius as number } : {}),
                    ...(meta.shapeKind !== undefined ? { shapeKind: meta.shapeKind as string } : {}),
                    ...(meta.fill !== undefined ? { fill: meta.fill as string } : {}),
                    ...(meta.stroke !== undefined ? { stroke: meta.stroke as string } : {}),
                    ...(meta.strokeWidth !== undefined ? { strokeWidth: meta.strokeWidth as number } : {}),
                    ...(meta.fontFamily !== undefined ? { fontFamily: meta.fontFamily as string } : {}),
                    ...(meta.fontWeight !== undefined ? { fontWeight: meta.fontWeight as number } : {}),
                    ...(meta.fontSize !== undefined ? { fontSize: meta.fontSize as number } : {}),
                    ...(meta.color !== undefined ? { color: meta.color as string } : {}),
                    ...(meta.textAlign !== undefined ? { textAlign: meta.textAlign as string } : {}),
                    ...(meta.textContent !== undefined ? { textContent: meta.textContent as string } : {}),
                    ...(meta.letterSpacing !== undefined ? { letterSpacing: meta.letterSpacing as number } : {}),
                    ...(meta.lineHeight !== undefined ? { lineHeight: meta.lineHeight as number } : {}),
                    ...(meta.opacity !== undefined ? { opacity: meta.opacity as number } : {}),
                    ...(meta.pathData !== undefined ? { pathData: meta.pathData } : {}),
                  });
                }
                return next;
              });
            }}
            onAlignNodes={(axis) => canvasApiRef.current?.alignNodes(axis)}
            onCanvasAlign={(dir) => canvasApiRef.current?.canvasAlign?.(dir)}
            onCanvasDistribute={(dir) => canvasApiRef.current?.canvasDistribute?.(dir)}
            onCanvasLayout={(type) => canvasApiRef.current?.canvasLayout?.(type)}
            selectionContext={selectionContext}
            selectedShapeMeta={(() => {
              if (selectedImageIds.length !== 1) return null;
              const meta = selectedNodeMeta.get(selectedImageIds[0]);
              if (meta?.nodeType !== "shape") return null;
              return {
                shapeKind: meta.shapeKind || "rectangle",
                fill: meta.fill || "#5b5fc7",
                stroke: meta.stroke || "none",
                strokeWidth: meta.strokeWidth ?? 0,
              };
            })()}
            onSelectionAction={(action, ar, jobType) => {
              if (action === "video_to_gif") {
                setSvgMakerOpen(false);
                setGifMakerOpen(true);
                return;
              }
              if (ar && jobType) {
                startGeneration(ar, jobType);
              }
            }}
            onClearSelection={handleClearReference}
            svgEditState={svgEditState}
            onSvgPointUpdate={(nodeId, subPathIdx, anchorIdx, x, y) => {
              canvasApiRef.current?.updateSvgPoint?.(nodeId, subPathIdx, anchorIdx, x, y);
            }}
            onSvgToggleSmooth={(nodeId, subPathIdx, anchorIdx) => {
              canvasApiRef.current?.toggleSvgSmooth?.(nodeId, subPathIdx, anchorIdx);
            }}
            onSvgPointRadius={(nodeId, subPathIdx, anchorIdx, radius) => {
              canvasApiRef.current?.updateSvgPointRadius?.(nodeId, subPathIdx, anchorIdx, radius);
            }}
            pushUndo={(cmd) => canvasApiRef.current?.pushUndo?.(cmd)}
            onSvgBooleanOp={(op, nodeIds) => canvasApiRef.current?.svgBooleanOp?.(op, nodeIds)}
          />
        ) : selectedTool === "clearcheck" ? (
          <ClearcheckPanel
            hasSelectedImage={hasSelectedImage}
            onAddAudit={handleAddAudit}
            userBalance={balance}
            unlimited={unlimited}
            onOpenClearcheckPolicy={() => { setSettingsSection("clearcheck-policy"); setSettingsOpen(true); }}
            referenceImage={referenceImage}
            onClearReference={handleClearReference}
            onClose={() => setSelectedTool("create")}
          />
        ) : selectionContext.type !== "none" ? (
          <SelectionContextPanel
            selectionType={selectionContext.type}
            count={selectionContext.count}
            onAction={(action, ar, jobType) => {
              if (action === "video_to_gif") {
                setSvgMakerOpen(false);
                setGifMakerOpen(true);
                return;
              }
              if (action === "upscale_video") {
                // Open the Upscale tool with the current video selection so
                // the panel branches into its video-aware (Topaz) UI.
                setSelectedTool("upscale");
                return;
              }
              if (action === "cleanup_vector") {
                if (selectedImageIds.length > 0) {
                  const nodeId = selectedImageIds[0];
                  const meta = selectedNodeMeta.get(nodeId);
                  if (meta) {
                    const oldMeta = { ...(meta as Record<string, unknown>) };
                    const pd = oldMeta.pathData as import("./utils/svgPathModel").PathData | undefined;
                    if (pd) {
                      import("./utils/svgPathModel").then(({ simplifyPathData }) => {
                        const simplified = simplifyPathData(pd);
                        canvasApiRef.current?.updateNodeMetadata(nodeId, { ...oldMeta, pathData: simplified });
                        canvasApiRef.current?.pushUndo?.({
                          type: "resize",
                          undo: () => canvasApiRef.current?.updateNodeMetadata(nodeId, { ...oldMeta, pathData: pd }),
                          redo: () => canvasApiRef.current?.updateNodeMetadata(nodeId, { ...oldMeta, pathData: simplified }),
                        });
                      });
                    }
                  }
                }
                return;
              }
              if (ar && jobType) {
                startGeneration(ar, jobType);
              }
            }}
            userBalance={balance}
            onClearSelection={handleClearReference}
          />
        ) : null}
        {gifMakerOpen && (
          <GifMakerPanel
            onClose={() => setGifMakerOpen(false)}
            hasSelectedVideo={selectionContext.type === "video"}
            videoSrc={selectedVideoInfo?.src}
            videoDuration={selectedVideoInfo?.duration}
            onSendToTray={async (blob: Blob) => {
              if (!activeProjectId) return;
              try {
                const formData = new FormData();
                formData.append("file", new File([blob], `gif-${Date.now()}.gif`, { type: "image/gif" }));
                formData.append("canvas_id", activeProjectId);
                const res = await fetch("/api/gif-maker/create", { method: "POST", credentials: "include", body: formData });
                if (!res.ok) {
                  const errData = await res.json().catch(() => ({ error: "GIF creation failed" }));
                  if (res.status === 402) {
                    alert("Insufficient credits for GIF conversion");
                    return;
                  }
                  if (res.status === 429) {
                    alert(errData.error || "Rate limit exceeded. Please try again later.");
                    return;
                  }
                  throw new Error(errData.error || "GIF creation failed");
                }
                const data = await res.json().catch(() => ({}));
                const url = data?.url as string | undefined;
                const api = canvasApiProxy;
                if (url && api?.isLive?.() && api.addNode && api.getNodes && api.getViewport) {
                  const baseSize = placeholderSize("quality", "1:1", "image");
                  const viewport = api.getViewport();
                  const slot = findEmptySlots(viewport, [baseSize], api.getNodes())[0];
                  if (slot) {
                    api.addNode(slot.x, slot.y, {
                      node_type: "image",
                      width: slot.w,
                      height: slot.h,
                      src: url,
                      label: "GIF",
                      metadata: { source: "gif_maker" },
                    });
                  }
                }
                refreshCredits();
              } catch (err) {
                console.error("Failed to drop GIF on canvas:", err);
              }
            }}
          />
        )}
        {svgMakerOpen && (
          <Suspense fallback={null}>
            <VectorPanel onClose={() => setSvgMakerOpen(false)} onGenerate={startGeneration} userBalance={balance} unlimited={unlimited} canvasReferenceImages={canvasReferenceImages.slice(0, 1)} onClearReference={handleClearReference} />
          </Suspense>
        )}
        {axiomCreatorOpen && (
          <AxiomCreatorPanel onClose={() => setAxiomCreatorOpen(false)} onCreated={() => setAxiomRefreshKey((k) => k + 1)} />
        )}
        {styleCreatorOpen && (
          <StyleCreatorPanel onClose={() => setStyleCreatorOpen(false)} onCreated={() => setStyleRefreshKey((k) => k + 1)} />
        )}
        {bucketManagerOpen && (
          <BucketManagerPanel onClose={() => setBucketManagerOpen(null)} context={bucketManagerOpen} />
        )}
        {folderCreatorOpen && (
          <FolderCreatorPanel
            onClose={() => { setFolderCreatorOpen(false); setFolderSelectedItems(new Map()); }}
            selectedItems={folderSelectedItems}
            onToggleItem={handleToggleFolderItem}
            onAddItem={handleAddFolderItem}
            folderType={libraryView === "music" ? "music" : libraryView === "voices" ? "voice" : libraryView === "sfx" ? "sound_effect" : "media"}
            onCreated={() => setFolderRefreshKey((k) => k + 1)}
          />
        )}
        {folderManagerOpen && (
          <FolderManagerPanel onClose={() => { setFolderManagerOpen(null); setFolderSelectedItems(new Map()); setFolderRefreshKey((k) => k + 1); }} folderName={folderManagerOpen.name} folderId={folderManagerOpen.id || undefined} folderType={libraryView === "music" ? "music" : libraryView === "voices" ? "voice" : libraryView === "sfx" ? "sound_effect" : "media"} mediaContext={libraryView === "videos" ? "video" : libraryView === "music" || libraryView === "voices" || libraryView === "sfx" ? undefined : "image"} pendingItems={folderSelectedItems} onClearPendingItem={handleClearPendingItem} />
        )}
        {axiomManagerOpen && (
          <AxiomManagerPanel onClose={() => setAxiomManagerOpen(null)} axiomId={axiomManagerOpen} onUpdated={() => setAxiomRefreshKey((k) => k + 1)} />
        )}
        {styleManagerOpen && (
          <StyleManagerPanel onClose={() => setStyleManagerOpen(null)} styleId={styleManagerOpen} onDeleted={() => setStyleRefreshKey((k) => k + 1)} onSaved={() => setStyleRefreshKey((k) => k + 1)} />
        )}
        {settingsOpen && (
          <SettingsPage
            onClose={() => setSettingsOpen(false)}
            initialSection={settingsSection}
            onSignIn={() => { setSettingsOpen(false); setSelectedTool("make"); }}
          />
        )}
        {apiKeysOpen && (
          <SettingsPanel onClose={() => setApiKeysOpen(false)} />
        )}
      </div>

    </div>
  );
}

export default App;
