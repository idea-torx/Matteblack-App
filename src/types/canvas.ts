export type ReferenceImage = {
  id: string;
  label: string;
  gradient: string;
  aspectRatio?: string;
  axiomImages?: string[];
  axiomName?: string;
  axiomDescription?: string;
  nodeType?: "image" | "video" | "svg" | "group" | "frame" | "shape" | "text" | "cinema";
  timelineState?: unknown;
  fontFamily?: string;
  fontWeight?: number;
  fontSize?: number;
  color?: string;
  textAlign?: string;
  textContent?: string;
  letterSpacing?: number;
  lineHeight?: number;
  fill?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
  borderRadius?: number;
  shapeKind?: string;
  stroke?: string;
  strokeWidth?: number;
  opacity?: number;
  duration?: number;
};

export type CanvasNode = {
  id: string;
  canvas_id: string;
  node_type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  z_index: number;
  locked: boolean;
  visible: boolean;
  label: string;
  src: string;
  gradient: string;
  asset_id: string | null;
  job_id: string | null;
  metadata: Record<string, unknown>;
};

export type ContextMenu = {
  x: number;
  y: number;
  nodeId?: string;
  canvasX?: number;
  canvasY?: number;
};

export type UndoCommand = {
  type: "move" | "resize" | "create" | "delete" | "lock" | "group" | "ungroup" | "layer";
  undo: () => void;
  redo: () => void;
};

export type PendingPlacement = {
  url: string;
  isVideo: boolean;
  isAudio?: boolean;
  isSvg?: boolean;
  svgContent?: string | null;
  label: string;
  jobId: string | null;
  trayItem: unknown;
};

export type FreeformCanvasProps = {
  selectedImageIds: string[];
  onSelectImage: (id: string, mode?: "exclusive" | "toggle") => void;
  onSelectMultiple?: (ids: string[], mode?: "exclusive" | "add") => void;
  onDeselectAll?: () => void;
  onNodeMeta?: (id: string, meta: ReferenceImage) => void;
  gifMakerMode?: boolean;
  onDropReference?: (ref: ReferenceImage) => void;
  onDropPrompt?: (prompt: string, jobId?: string | null) => void;
  libraryOpen?: boolean;
  onDropTrayItem?: (item: unknown) => void;
  onCanvasReady?: (canvasId: string) => void;
  projectCanvasId?: string | null;
  canvasFlushRef?: React.MutableRefObject<(() => Promise<void>) | null>;
  onToolSelect?: (toolId: string) => void;
  onLoadingChange?: (loading: boolean) => void;
  fitAllTrigger?: number;
  firstFrameId?: string | null;
  lastFrameId?: string | null;
  pendingPlacement?: PendingPlacement | null;
  onClearPendingPlacement?: () => void;
  onConfirmPlacement?: (placement: PendingPlacement) => void;
  onLibrarySaved?: () => void;
  presentMode?: boolean;
  onTogglePresentMode?: () => void;
  rightPanelHidden?: boolean;
  onToggleRightPanelHidden?: () => void;
  onCanvasApi?: (api: CanvasApi) => void;
  activeTool?: string;
  designSubTool?: "select" | "frame" | "shape" | "text" | "pen" | "draw";
  onDesignSubToolChange?: (subTool: "select" | "frame" | "shape" | "text" | "pen" | "draw") => void;
  onActivateDesignTool?: () => void;
  onCreateFrame?: (width: number, height: number) => void;
  pendingShapeKind?: string;
  onPendingShapeKindChange?: (kind: string) => void;
  onQuickRemoveBg?: (imageUrl: string) => void;
  onSvgEditStateChange?: (state: { isEditing: boolean; selectedPoints: { subPathIdx: number; anchorIdx: number }[]; pathData: { subPaths: { anchors: { x: number; y: number; smooth: boolean }[] }[] } | null } | null) => void;
  onSyncStatusChange?: (status: "synced" | "syncing" | "confirming" | "failed", failedSeconds: number, retry: () => void) => void;
  onOpenLibrary?: (view: string, folderId?: string, assetId?: string) => void;
  projectName?: string;
  onNodesChange?: (nodes: CanvasNode[]) => void;
  dotPulseKey?: number | null;
};

export type CanvasApi = {
  addFrame: (width: number, height: number) => void;
  addFrameAtPosition: (x: number, y: number, width: number, height: number) => void;
  updateFrameColor: (nodeId: string, color: string) => void;
  exportFrame: (nodeId: string) => void;
  exportFrames: (nodeIds: string[], format: "png" | "pdf") => void;
  videoExport?: {
    isExporting: boolean;
    stage: string;
    progress: number;
    error: string | null;
    start: (frameId: string, resolution: "match" | "1080p" | "720p", includeAudio: boolean) => void;
    cancel: () => void;
    reset: () => void;
  };
  updateNodeTransform: (nodeId: string, props: { x?: number; y?: number; width?: number; height?: number; rotation?: number }) => void;
  updateNodeMetadata: (nodeId: string, meta: Record<string, unknown>) => void;
  alignNodes: (axis: "left" | "centerH" | "right" | "top" | "centerV" | "bottom" | "distributeH" | "distributeV") => void;
  addShape: (shapeKind: string, width: number, height: number) => void;
  addShapeAtPosition: (x: number, y: number, width: number, height: number, shapeKind?: string, extraMeta?: Record<string, unknown>) => void;
  addText: (width: number, height: number) => CanvasNode | undefined;
  addTextAtPosition: (x: number, y: number, width: number, height: number) => CanvasNode | undefined;
  canvasAlign?: (dir: string) => void;
  canvasDistribute?: (dir: string) => void;
  canvasLayout?: (type: "tidy" | "masonry-h" | "masonry-v") => void;
  updateSvgPoint?: (nodeId: string, subPathIdx: number, anchorIdx: number, x: number, y: number) => void;
  toggleSvgSmooth?: (nodeId: string, subPathIdx: number, anchorIdx: number) => void;
  updateSvgPointRadius?: (nodeId: string, subPathIdx: number, anchorIdx: number, radius: number) => void;
  pushUndo?: (cmd: UndoCommand) => void;
  svgBooleanOp?: (op: "union" | "subtract" | "intersect" | "exclude" | "flatten", nodeIds: string[]) => void;
  addNode?: (x: number, y: number, props: Partial<CanvasNode>) => CanvasNode | undefined;
  updateNode?: (nodeId: string, fields: Partial<CanvasNode>) => void;
  getViewport?: () => { cx: number; cy: number; w: number; h: number; panX: number; panY: number; zoom: number };
  centerOnNode?: (nodeId: string, opts?: { zoom?: number; animate?: boolean }) => void;
  getNodes?: () => CanvasNode[];
  // Returns true when the underlying live canvas is mounted/active. Stable
  // proxies (built around a ref) expose this so consumers can decide
  // whether to take the in-memory live path or fall back to a server POST.
  isLive?: () => boolean;
};

export const ZOOM_BASELINE = 0.25;
export const MIN_ZOOM = ZOOM_BASELINE * 0.1;
export const MAX_ZOOM = ZOOM_BASELINE * 25;
export const ZOOM_STEP = ZOOM_BASELINE * 0.1;
export const DEBOUNCE_MS = 500;
export const MIN_NODE_SIZE = 3;
export const DEFAULT_GRID_SIZE = 20;
export const VIEWPORT_BUFFER = 200;
