import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import type { ReferenceImage } from "../types/canvas";
import { getDefaultFrameFill } from "../theme";
import { TextProperties } from "./design/TextProperties";
import { PanelSection } from "./design/PanelSection";
import ColorPicker from "./design/ColorPicker";
import NumericInput from "./NumericInput";
import { simplifyPathData, type PathData } from "../utils/svgPathModel";
import "./RightPanel.css";

function NumInput({ value, onChange, label, min, max, step = 1 }: { value: number; onChange: (v: number) => void; label: string; min?: number; max?: number; step?: number }) {
  const [text, setText] = useState(String(Math.round(value)));
  const [focused, setFocused] = useState(false);
  const prevValue = useRef(value);

  useEffect(() => {
    if (!focused && value !== prevValue.current) {
      setText(String(Math.round(value)));
    }
    prevValue.current = value;
  }, [value, focused]);

  const clamp = (v: number) => {
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    return v;
  };

  const commit = () => {
    const parsed = parseFloat(text);
    if (!isNaN(parsed)) {
      onChange(clamp(Math.round(parsed)));
    } else {
      setText(String(Math.round(value)));
    }
  };

  return (
    <div style={{ flex: 1 }}>
      <span className="rpanel-setting-label">{label}</span>
      <NumericInput
        className="rpanel-url-input"
        step={step}
        min={min}
        max={max}
        value={text}
        onChange={(e) => {
          const raw = e.target.value;
          setText(raw);
          const parsed = parseFloat(raw);
          if (!isNaN(parsed)) onChange(clamp(Math.round(parsed)));
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); commit(); }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") { commit(); (e.target as HTMLInputElement).blur(); }
        }}
      />
    </div>
  );
}

function InlineNumInput({ value, onChange, min, max, step = 1, placeholder }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; placeholder?: string }) {
  const [text, setText] = useState(String(Math.round(value)));
  const [focused, setFocused] = useState(false);
  const prevValue = useRef(value);

  useEffect(() => {
    if (!focused && value !== prevValue.current) {
      setText(String(Math.round(value)));
    }
    prevValue.current = value;
  }, [value, focused]);

  const clamp = (v: number) => {
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    return v;
  };

  const commit = () => {
    const parsed = parseFloat(text);
    if (!isNaN(parsed)) {
      onChange(clamp(Math.round(parsed)));
    } else {
      setText(String(Math.round(value)));
    }
  };

  return (
    <NumericInput
      className="rpanel-url-input"
      step={step}
      min={min}
      max={max}
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        const parsed = parseFloat(raw);
        if (!isNaN(parsed)) onChange(clamp(Math.round(parsed)));
      }}
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); commit(); }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") { commit(); (e.target as HTMLInputElement).blur(); }
      }}
    />
  );
}

type FramePreset = {
  label: string;
  width: number;
  height: number;
};

const FRAME_PRESETS: FramePreset[] = [
  { label: "HD", width: 1920, height: 1080 },
  { label: "Instagram Post", width: 1080, height: 1080 },
  { label: "Story", width: 1080, height: 1920 },
  { label: "4K", width: 3840, height: 2160 },
];

function FrameIcon({ w, h }: { w: number; h: number }) {
  const maxDim = 14;
  const aspect = w / h;
  let rw: number, rh: number;
  if (aspect >= 1) {
    rw = maxDim;
    rh = Math.max(4, Math.round(maxDim / aspect));
  } else {
    rh = maxDim;
    rw = Math.max(4, Math.round(maxDim * aspect));
  }
  const x = (16 - rw) / 2;
  const y = (16 - rh) / 2;
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x={x} y={y} width={rw} height={rh} rx="1.5" />
    </svg>
  );
}

type DesignSubTool = "select" | "frame" | "shape" | "text" | "pen" | "draw";

const SHAPE_KINDS = [
  { value: "rectangle", label: "Rectangle" },
  { value: "ellipse", label: "Ellipse" },
  { value: "triangle", label: "Triangle" },
  { value: "diamond", label: "Diamond" },
  { value: "line", label: "Line" },
] as const;

type DesignPanelProps = {
  onCreateFrame: (width: number, height: number) => void;
  selectedFrameColor?: string | null;
  onFrameColorChange?: (color: string) => void;
  hasSelectedFrame?: boolean;
  selectedFrameIds?: string[];
  onExportFrames?: (format: "png" | "pdf") => void;
  selectedFrameHasVideo?: boolean;
  videoExport?: {
    isExporting: boolean;
    stage: string;
    progress: number;
    error: string | null;
    start: (resolution: "match" | "1080p" | "720p", includeAudio: boolean) => void;
    cancel: () => void;
    reset: () => void;
  };
  activeSubTool?: DesignSubTool;
  onSubToolChange?: (tool: DesignSubTool) => void;
  selectedNodeMeta?: Map<string, ReferenceImage>;
  selectedImageIds?: string[];
  onUpdateNodeTransform?: (nodeId: string, props: { x?: number; y?: number; width?: number; height?: number; rotation?: number }) => void;
  onAlignNodes?: (axis: "left" | "centerH" | "right" | "top" | "centerV" | "bottom" | "distributeH" | "distributeV") => void;
  onCanvasAlign?: (dir: string) => void;
  onCanvasDistribute?: (dir: string) => void;
  onCanvasLayout?: (type: "tidy" | "masonry-h" | "masonry-v") => void;
  onUpdateNodeMetadata?: (nodeId: string, meta: Record<string, unknown>) => void;
  selectionContext?: { type: "image" | "video" | "svg" | "multi" | "none" | "shape" | "text"; count: number };
  onSelectionAction?: (action: string, ar?: string, jobType?: string) => void;
  onClearSelection?: () => void;
  selectedShapeMeta?: { shapeKind?: string; fill?: string; stroke?: string; strokeWidth?: number } | null;
  pendingShapeKind?: string;
  onPendingShapeKindChange?: (kind: string) => void;
  svgEditState?: {
    isEditing: boolean;
    selectedPoints: { subPathIdx: number; anchorIdx: number }[];
    pathData: { subPaths: { anchors: { x: number; y: number; smooth: boolean; cornerRadius?: number }[] }[] } | null;
  } | null;
  onSvgPointUpdate?: (nodeId: string, subPathIdx: number, anchorIdx: number, x: number, y: number) => void;
  onSvgToggleSmooth?: (nodeId: string, subPathIdx: number, anchorIdx: number) => void;
  onSvgPointRadius?: (nodeId: string, subPathIdx: number, anchorIdx: number, radius: number) => void;
  pushUndo?: (cmd: { type: "move" | "resize" | "create" | "delete" | "lock" | "group" | "ungroup" | "layer"; undo: () => void; redo: () => void }) => void;
  onSvgBooleanOp?: (op: "union" | "subtract" | "intersect" | "exclude" | "flatten", nodeIds: string[]) => void;
};

export function DesignPanel({
  onCreateFrame,
  selectedFrameColor,
  onFrameColorChange,
  hasSelectedFrame = false,
  selectedFrameIds,
  onExportFrames,
  selectedFrameHasVideo = false,
  videoExport,
  activeSubTool: _activeSubTool = "select",
  onSubToolChange,
  selectedNodeMeta,
  selectedImageIds = [],
  onUpdateNodeTransform,
  onCanvasAlign,
  onCanvasDistribute,
  onCanvasLayout,
  onUpdateNodeMetadata,
  selectionContext,
  onSelectionAction,
  onClearSelection,
  selectedShapeMeta,
  pendingShapeKind = "rectangle",
  onPendingShapeKindChange,
  svgEditState,
  onSvgPointUpdate,
  onSvgToggleSmooth,
  onSvgPointRadius,
  pushUndo,
  onSvgBooleanOp,
}: DesignPanelProps) {
  const [customWidth, setCustomWidth] = useState("1920");
  const [customHeight, setCustomHeight] = useState("1080");
  const hasSelection = selectedImageIds.length > 0;
  const [videoExportDialogOpen, setVideoExportDialogOpen] = useState(false);

  useEffect(() => {
    if (!selectedFrameHasVideo) setVideoExportDialogOpen(false);
  }, [selectedFrameHasVideo]);
  const [moreAlignOpen, setMoreAlignOpen] = useState(false);

  const canvasColors = useMemo(() => {
    if (!selectedNodeMeta || selectedNodeMeta.size === 0) return [];
    const colorSet = new Set<string>();
    selectedNodeMeta.forEach((meta) => {
      if (typeof meta.color === "string" && meta.color !== "none" && !meta.color.startsWith("gradient:")) colorSet.add(meta.color.toLowerCase());
      if (typeof meta.fill === "string" && meta.fill !== "none" && !meta.fill.startsWith("gradient:")) colorSet.add(meta.fill.toLowerCase());
      if (typeof meta.stroke === "string" && meta.stroke !== "none" && !meta.stroke.startsWith("gradient:")) colorSet.add(meta.stroke.toLowerCase());
    });
    return Array.from(colorSet).slice(0, 16);
  }, [selectedNodeMeta]);

  const handleCustomCreate = useCallback(() => {
    const w = Math.max(32, parseInt(customWidth) || 1920);
    const h = Math.max(32, parseInt(customHeight) || 1080);
    onCreateFrame(w, h);
  }, [customWidth, customHeight, onCreateFrame]);

  const singleSelectedMeta = selectedImageIds.length === 1 && selectedNodeMeta
    ? selectedNodeMeta.get(selectedImageIds[0])
    : null;
  const hasMulti = selectedImageIds.length > 1;
  const selType = selectionContext?.type || "none";

  const multiShapeIds = hasMulti && selectedNodeMeta
    ? selectedImageIds.filter((id) => {
        const m = selectedNodeMeta.get(id);
        return m && m.nodeType === "shape";
      })
    : [];
  const multiShapeMetas = multiShapeIds.map((id) => {
    const m = selectedNodeMeta!.get(id)!;
    return {
      id,
      fill: m.fill ?? "#5b5fc7",
      stroke: m.stroke ?? "none",
      strokeWidth: m.strokeWidth ?? 0,
      shapeKind: m.shapeKind ?? "rectangle",
    };
  });
  const multiTextIds = hasMulti && selectedNodeMeta
    ? selectedImageIds.filter((id) => {
        const m = selectedNodeMeta.get(id);
        return m && m.nodeType === "text";
      })
    : [];
  const hasMultiTexts = multiTextIds.length > 0;

  const multiSvgIds = hasMulti && selectedNodeMeta
    ? selectedImageIds.filter((id) => {
        const m = selectedNodeMeta.get(id);
        return m && m.nodeType === "svg";
      })
    : [];
  const hasMultiSvgs = multiSvgIds.length >= 2;

  const hasMultiShapes = multiShapeIds.length > 0;
  const multiFillMixed = hasMultiShapes && new Set(multiShapeMetas.map((s) => s.fill)).size > 1;
  const multiStrokeMixed = hasMultiShapes && new Set(multiShapeMetas.map((s) => s.stroke)).size > 1;
  const multiFirstFill = hasMultiShapes ? multiShapeMetas[0].fill : "#5b5fc7";
  const multiFirstStroke = hasMultiShapes ? multiShapeMetas[0].stroke : "none";
  const multiFirstStrokeWeight = hasMultiShapes ? multiShapeMetas[0].strokeWidth : 0;
  const multiHasNonLineShapes = multiShapeMetas.some((s) => s.shapeKind !== "line");

  const multiDisabled = selectedImageIds.length < 2;
  const distDisabled = selectedImageIds.length < 3;

  const showPosition = hasSelection;
  const showLayout = hasSelection;
  const showAppearance = hasSelection && selType !== "text" && selType !== "video";
  const showTextProps = (selType === "text" && selectedImageIds.length > 0) || (hasMultiTexts && selType === "multi");
  const showShapeAppearance = hasMultiShapes;
  const showImageActions = !hasMulti && selType === "image" && !!onSelectionAction;
  const showVideoActions = !hasMulti && selType === "video" && !!onSelectionAction;
  const showSvgActions = !hasMulti && selType === "svg" && !!onSelectionAction;
  const showSvgProperties = !hasMulti && selType === "svg" && hasSelection;
  const showBatchActions = hasMulti && selType === "multi" && !!onSelectionAction;
  const showFrameProperties = hasSelectedFrame;
  const showShapes = (hasSelection && selType === "shape") || hasMultiShapes;

  return (
    <aside className="rpanel rpanel--design">
      <div className="rpanel-scroll">

        <PanelSection title="Align" defaultOpen={true}>
          <div className="rpanel-setting-group">
            <div className="rpanel-align-row">
              <button type="button" className="rpanel-align-btn" title="Align Left" disabled={multiDisabled} onClick={() => onCanvasAlign?.("left")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="4" y1="2" x2="4" y2="22" /><rect x="8" y="4" width="12" height="6" rx="1" /><rect x="8" y="14" width="8" height="6" rx="1" /></svg>
              </button>
              <button type="button" className="rpanel-align-btn" title="Align Center H" disabled={multiDisabled} onClick={() => onCanvasAlign?.("center")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="2" x2="12" y2="22" /><rect x="4" y="4" width="16" height="6" rx="1" /><rect x="6" y="14" width="12" height="6" rx="1" /></svg>
              </button>
              <button type="button" className="rpanel-align-btn" title="Align Right" disabled={multiDisabled} onClick={() => onCanvasAlign?.("right")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="20" y1="2" x2="20" y2="22" /><rect x="4" y="4" width="12" height="6" rx="1" /><rect x="8" y="14" width="8" height="6" rx="1" /></svg>
              </button>
              <button type="button" className="rpanel-align-btn" title="Align Top" disabled={multiDisabled} onClick={() => onCanvasAlign?.("top")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="2" y1="4" x2="22" y2="4" /><rect x="4" y="8" width="6" height="12" rx="1" /><rect x="14" y="8" width="6" height="8" rx="1" /></svg>
              </button>
              <button type="button" className="rpanel-align-btn" title="Align Middle V" disabled={multiDisabled} onClick={() => onCanvasAlign?.("middle")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="2" y1="12" x2="22" y2="12" /><rect x="4" y="4" width="6" height="16" rx="1" /><rect x="14" y="6" width="6" height="12" rx="1" /></svg>
              </button>
              <button type="button" className="rpanel-align-btn" title="Align Bottom" disabled={multiDisabled} onClick={() => onCanvasAlign?.("bottom")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="2" y1="20" x2="22" y2="20" /><rect x="4" y="4" width="6" height="12" rx="1" /><rect x="14" y="8" width="6" height="8" rx="1" /></svg>
              </button>
              <button
                type="button"
                className={`rpanel-align-btn ${moreAlignOpen ? "rpanel-list-btn--active" : ""}`}
                title="More alignment options"
                onClick={() => setMoreAlignOpen((v) => !v)}
              >
                {moreAlignOpen ? "−" : "+"}
              </button>
            </div>
            {moreAlignOpen && (
              <>
                <div className="rpanel-align-row" style={{ marginTop: 4 }}>
                  <button type="button" className="rpanel-align-btn" title="Distribute Horizontally" disabled={distDisabled} onClick={() => onCanvasDistribute?.("horizontal")}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="6" width="4" height="12" rx="1" /><rect x="10" y="6" width="4" height="12" rx="1" /><rect x="18" y="6" width="4" height="12" rx="1" /></svg>
                  </button>
                  <button type="button" className="rpanel-align-btn" title="Distribute Vertically" disabled={distDisabled} onClick={() => onCanvasDistribute?.("vertical")}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="6" y="2" width="12" height="4" rx="1" /><rect x="6" y="10" width="12" height="4" rx="1" /><rect x="6" y="18" width="12" height="4" rx="1" /></svg>
                  </button>
                  <button type="button" className="rpanel-align-btn" title="Tidy Grid" disabled={multiDisabled} onClick={() => onCanvasLayout?.("tidy")}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>
                  </button>
                  <button type="button" className="rpanel-align-btn" title="Masonry Horizontal" disabled={multiDisabled} onClick={() => onCanvasLayout?.("masonry-h")}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="6" height="8" rx="1" /><rect x="10" y="3" width="6" height="5" rx="1" /><rect x="18" y="3" width="4" height="7" rx="1" /><rect x="2" y="13" width="6" height="5" rx="1" /><rect x="10" y="10" width="6" height="8" rx="1" /><rect x="18" y="12" width="4" height="6" rx="1" /></svg>
                  </button>
                  <button type="button" className="rpanel-align-btn" title="Masonry Vertical" disabled={multiDisabled} onClick={() => onCanvasLayout?.("masonry-v")}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="2" width="8" height="6" rx="1" /><rect x="3" y="10" width="8" height="4" rx="1" /><rect x="3" y="16" width="8" height="6" rx="1" /><rect x="13" y="2" width="8" height="4" rx="1" /><rect x="13" y="8" width="8" height="7" rx="1" /><rect x="13" y="17" width="8" height="5" rx="1" /></svg>
                  </button>
                </div>
              </>
            )}
          </div>
        </PanelSection>

        {showPosition && (
          <PanelSection title="Position" defaultOpen={true}>
            <div className="rpanel-setting-group">
              <div className="rpanel-btn-row">
                {singleSelectedMeta ? (
                  <>
                    <NumInput label="X" value={singleSelectedMeta.x ?? 0} onChange={(v) => onUpdateNodeTransform?.(singleSelectedMeta.id, { x: v })} />
                    <NumInput label="Y" value={singleSelectedMeta.y ?? 0} onChange={(v) => onUpdateNodeTransform?.(singleSelectedMeta.id, { y: v })} />
                  </>
                ) : (
                  <>
                    <div style={{ flex: 1 }}>
                      <span className="rpanel-setting-label">X</span>
                      <input type="text" className="rpanel-url-input" value="" disabled placeholder="—" />
                    </div>
                    <div style={{ flex: 1 }}>
                      <span className="rpanel-setting-label">Y</span>
                      <input type="text" className="rpanel-url-input" value="" disabled placeholder="—" />
                    </div>
                  </>
                )}
              </div>
              <div className="rpanel-btn-row" style={{ marginTop: 6 }}>
                {singleSelectedMeta ? (
                  <NumInput
                    label="Rotation °"
                    value={singleSelectedMeta.rotation ?? 0}
                    onChange={(v) => {
                      const wrapped = ((v % 360) + 360) % 360;
                      onUpdateNodeTransform?.(singleSelectedMeta.id, { rotation: wrapped });
                    }}
                  />
                ) : (
                  <div style={{ flex: 1 }}>
                    <span className="rpanel-setting-label">Rotation °</span>
                    <input type="text" className="rpanel-url-input" value="" disabled placeholder="—" />
                  </div>
                )}
              </div>
            </div>
          </PanelSection>
        )}

        {showLayout && (
          <PanelSection title="Size" defaultOpen={true}>
            <div className="rpanel-setting-group">
              <div className="rpanel-btn-row">
                {singleSelectedMeta ? (
                  <>
                    <NumInput label="W" min={1} value={singleSelectedMeta.width ?? 256} onChange={(v) => onUpdateNodeTransform?.(singleSelectedMeta.id, { width: v })} />
                    <span className="rpanel-setting-label" style={{ alignSelf: "flex-end", padding: "8px 0" }}>×</span>
                    <NumInput label="H" min={1} value={singleSelectedMeta.height ?? 256} onChange={(v) => onUpdateNodeTransform?.(singleSelectedMeta.id, { height: v })} />
                  </>
                ) : (
                  <>
                    <div style={{ flex: 1 }}>
                      <span className="rpanel-setting-label">W</span>
                      <input type="text" className="rpanel-url-input" value="" disabled placeholder="—" />
                    </div>
                    <span className="rpanel-setting-label" style={{ alignSelf: "flex-end", padding: "8px 0" }}>×</span>
                    <div style={{ flex: 1 }}>
                      <span className="rpanel-setting-label">H</span>
                      <input type="text" className="rpanel-url-input" value="" disabled placeholder="—" />
                    </div>
                  </>
                )}
              </div>
            </div>
          </PanelSection>
        )}

        {showAppearance && (
          <PanelSection title="Appearance" defaultOpen={true}>
            <div className="rpanel-setting-group">
              {showSvgProperties && singleSelectedMeta && (() => {
                const nodeId = selectedImageIds[0];
                const meta = selectedNodeMeta?.get(nodeId);
                const pathData = meta && (meta as Record<string, unknown>).pathData as { fill?: string; stroke?: string; strokeWidth?: number; opacity?: number; fillOpacity?: number; strokeOpacity?: number; cornerRadius?: number } | undefined;
                if (!pathData && !meta) return null;
                const effectiveFill = (() => {
                  if (!pathData) return (meta?.fill as string) || "none";
                  const pd2 = pathData as { fill?: string; subPaths?: Array<{ fill?: string }> };
                  if (pd2.subPaths?.some((sp) => sp.fill !== undefined)) {
                    const firstSpFill = pd2.subPaths.find((sp) => sp.fill !== undefined)?.fill;
                    return firstSpFill || pd2.fill || "none";
                  }
                  return pd2.fill || "none";
                })();
                const svgFill = effectiveFill;
                const rawMetaOpacity = (meta?.opacity as number | undefined);
                const metaOpacity01 = rawMetaOpacity !== undefined ? (rawMetaOpacity > 1 ? rawMetaOpacity / 100 : rawMetaOpacity) : undefined;
                const svgFillOpacity = (pathData?.fillOpacity as number) ?? (pathData?.opacity as number) ?? metaOpacity01 ?? 1;
                const svgCornerRadius = (pathData?.cornerRadius as number) ?? 0;
                const svgFillHex = svgFill === "none" ? "#5b5fc7" : svgFill;
                const isFillNone = svgFill === "none";

                const updateSvgAppearanceProp = (prop: string, value: unknown) => {
                  if (!onUpdateNodeMetadata || !nodeId) return;
                  const existing = meta || {};
                  const oldMeta = { ...existing as Record<string, unknown> };
                  const pd = oldMeta.pathData as Record<string, unknown> | undefined;
                  if (pd) {
                    const newPd = { ...pd, [prop]: value };
                    if ((prop === "fill" || prop === "stroke") && Array.isArray(newPd.subPaths)) {
                      newPd.subPaths = (newPd.subPaths as Record<string, unknown>[]).map((sp) => {
                        if (sp[prop] !== undefined) return { ...sp, [prop]: value };
                        return sp;
                      });
                    }
                    const prevPd = { ...pd };
                    if ((prop === "fill" || prop === "stroke") && Array.isArray(pd.subPaths)) {
                      prevPd.subPaths = [...(pd.subPaths as Record<string, unknown>[])];
                    }
                    onUpdateNodeMetadata(nodeId, { ...oldMeta, pathData: newPd });
                    if (pushUndo) {
                      pushUndo({
                        type: "resize",
                        undo: () => onUpdateNodeMetadata(nodeId, { ...oldMeta, pathData: prevPd }),
                        redo: () => onUpdateNodeMetadata(nodeId, { ...oldMeta, pathData: newPd }),
                      });
                    }
                  } else {
                    const rootValue = prop === "opacity" ? Math.round((value as number) * 100) : value;
                    const prevVal = (oldMeta as Record<string, unknown>)[prop];
                    const newMeta = { ...oldMeta, [prop]: rootValue };
                    onUpdateNodeMetadata(nodeId, newMeta);
                    if (pushUndo) {
                      pushUndo({
                        type: "resize",
                        undo: () => onUpdateNodeMetadata(nodeId, { ...oldMeta, [prop]: prevVal }),
                        redo: () => onUpdateNodeMetadata(nodeId, newMeta),
                      });
                    }
                  }
                };

                return (
                  <>
                    <div className="rpanel-appearance-row">
                      <span className="rpanel-appearance-row-label">Fill</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <ColorPicker
                          value={svgFillHex}
                          onChange={(c) => updateSvgAppearanceProp("fill", c)}
                          showNone
                          isNone={isFillNone}
                          onNoneToggle={() => updateSvgAppearanceProp("fill", isFillNone ? "#5b5fc7" : "none")}
                          canvasColors={canvasColors}
                        />
                      </div>
                    </div>
                    <div className="rpanel-appearance-row">
                      <span className="rpanel-appearance-row-label">Fill Opacity</span>
                      <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1 }}>
                        <input
                          type="range"
                          className="rpanel-range"
                          min={0}
                          max={1}
                          step={0.01}
                          value={svgFillOpacity}
                          onChange={(e) => updateSvgAppearanceProp("fillOpacity", parseFloat(e.target.value))}
                          style={{ flex: 1, minWidth: 0 }}
                        />
                        <span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", whiteSpace: "nowrap", minWidth: 28, textAlign: "right" }}>{Math.round(svgFillOpacity * 100)}%</span>
                      </div>
                    </div>
                    <div className="rpanel-appearance-row">
                      <span className="rpanel-appearance-row-label">Radius</span>
                      <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1 }}>
                        <InlineNumInput
                          min={0}
                          value={svgCornerRadius}
                          onChange={(v) => updateSvgAppearanceProp("cornerRadius", v > 0 ? v : undefined)}
                        />
                        <span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)" }}>px</span>
                      </div>
                    </div>
                  </>
                );
              })()}
              {selType === "shape" && singleSelectedMeta && selectedShapeMeta && selectedShapeMeta.shapeKind !== "line" ? (
                <>
                  <div className="rpanel-appearance-row">
                    <span className="rpanel-appearance-row-label">Fill</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <ColorPicker
                        value={selectedShapeMeta.fill === "none" ? "#5b5fc7" : (selectedShapeMeta.fill || "#5b5fc7")}
                        onChange={(c) => onUpdateNodeMetadata?.(singleSelectedMeta.id, { fill: c })}
                        showNone
                        isNone={selectedShapeMeta.fill === "none"}
                        onNoneToggle={() => onUpdateNodeMetadata?.(singleSelectedMeta.id, { fill: selectedShapeMeta.fill === "none" ? "#5b5fc7" : "none" })}
                        canvasColors={canvasColors}
                      />
                    </div>
                  </div>
                  <div className="rpanel-appearance-row">
                    <span className="rpanel-appearance-row-label">Opacity</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1 }}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" opacity="0.5" />
                        <path d="M12 2a10 10 0 0 1 0 20" fill="rgba(255,255,255,0.25)" stroke="none" />
                      </svg>
                      <InlineNumInput
                        min={0}
                        max={100}
                        value={Math.round(singleSelectedMeta.opacity ?? 100)}
                        onChange={(v) => onUpdateNodeMetadata?.(singleSelectedMeta.id, { opacity: v })}
                      />
                      <span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)" }}>%</span>
                    </div>
                  </div>
                  <div className="rpanel-appearance-row">
                    <span className="rpanel-appearance-row-label">Radius</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1 }}>
                      <InlineNumInput
                        min={0}
                        value={singleSelectedMeta.borderRadius ?? 0}
                        onChange={(v) => onUpdateNodeMetadata?.(singleSelectedMeta.id, { borderRadius: v })}
                      />
                    </div>
                  </div>
                </>
              ) : !showSvgProperties ? (
                <>
                  {singleSelectedMeta && selectedShapeMeta?.shapeKind !== "line" && (
                    <div className="rpanel-appearance-row">
                      <span className="rpanel-appearance-row-label">Opacity</span>
                      <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1 }}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="12" r="10" opacity="0.5" />
                          <path d="M12 2a10 10 0 0 1 0 20" fill="rgba(255,255,255,0.25)" stroke="none" />
                        </svg>
                        <InlineNumInput
                          min={0}
                          max={100}
                          value={Math.round(singleSelectedMeta.opacity ?? 100)}
                          onChange={(v) => onUpdateNodeMetadata?.(singleSelectedMeta.id, { opacity: v })}
                        />
                        <span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)" }}>%</span>
                      </div>
                    </div>
                  )}
                  <div className="rpanel-appearance-row">
                    <span className="rpanel-appearance-row-label">Radius</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1 }}>
                      {singleSelectedMeta ? (
                        <InlineNumInput
                          min={0}
                          value={singleSelectedMeta.borderRadius ?? 0}
                          onChange={(v) => onUpdateNodeMetadata?.(singleSelectedMeta.id, { borderRadius: v })}
                        />
                      ) : (
                        <input type="text" className="rpanel-url-input" value="" disabled placeholder="—" style={{ width: "100%" }} />
                      )}
                    </div>
                  </div>
                </>
              ) : null}

              {selType === "shape" && singleSelectedMeta && selectedShapeMeta && selectedShapeMeta.shapeKind === "line" && (
                <div className="rpanel-appearance-row">
                  <span className="rpanel-appearance-row-label">Opacity</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1 }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" opacity="0.5" />
                      <path d="M12 2a10 10 0 0 1 0 20" fill="rgba(255,255,255,0.25)" stroke="none" />
                    </svg>
                    <InlineNumInput
                      min={0}
                      max={100}
                      value={Math.round(singleSelectedMeta.opacity ?? 100)}
                      onChange={(v) => onUpdateNodeMetadata?.(singleSelectedMeta.id, { opacity: v })}
                    />
                    <span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)" }}>%</span>
                  </div>
                </div>
              )}
            </div>
          </PanelSection>
        )}

        {showAppearance && singleSelectedMeta && (
          <PanelSection title="Stroke" defaultOpen={false}>
            <div className="rpanel-setting-group">
              {(() => {
                const nodeId = selectedImageIds[0];
                const meta = selectedNodeMeta?.get(nodeId);
                const isSvg = selType === "svg";
                const pd = isSvg && meta ? (meta as Record<string, unknown>).pathData as Record<string, unknown> | undefined : undefined;
                const strokeVal = isSvg
                  ? (() => {
                      if (pd) {
                        const sps = pd.subPaths as Array<{ stroke?: string }> | undefined;
                        if (sps?.some((sp) => sp.stroke !== undefined)) {
                          const firstSpStroke = sps.find((sp) => sp.stroke !== undefined)?.stroke;
                          return firstSpStroke || (pd.stroke as string) || "none";
                        }
                      }
                      return (pd?.stroke as string) || (meta?.stroke as string) || "none";
                    })()
                  : (selectedShapeMeta?.stroke ?? singleSelectedMeta.stroke ?? "none");
                const strokeHex = (!strokeVal || strokeVal === "none") ? "#ffffff" : strokeVal;
                const isStrokeNone = !strokeVal || strokeVal === "none";
                const strokeWeightVal = isSvg
                  ? ((pd?.strokeWidth as number) ?? (meta?.strokeWidth as number) ?? 0)
                  : (selectedShapeMeta?.strokeWidth ?? singleSelectedMeta.strokeWidth ?? 0);
                const strokeOpacityVal = isSvg
                  ? ((pd?.strokeOpacity as number) ?? 1)
                  : 1;

                const handleStrokeChange = (prop: string, value: unknown) => {
                  if (!onUpdateNodeMetadata || !nodeId) return;
                  if (isSvg && meta) {
                    const existing = { ...meta as Record<string, unknown> };
                    const existingPd = existing.pathData as Record<string, unknown> | undefined;
                    if (existingPd) {
                      const newPd = { ...existingPd, [prop]: value };
                      if ((prop === "stroke") && Array.isArray(newPd.subPaths)) {
                        newPd.subPaths = (newPd.subPaths as Record<string, unknown>[]).map((sp) => {
                          if (sp[prop] !== undefined) return { ...sp, [prop]: value };
                          return sp;
                        });
                      }
                      const prevPd = { ...existingPd };
                      if ((prop === "stroke") && Array.isArray(existingPd.subPaths)) {
                        prevPd.subPaths = [...(existingPd.subPaths as Record<string, unknown>[])];
                      }
                      onUpdateNodeMetadata(nodeId, { ...existing, pathData: newPd });
                      if (pushUndo) {
                        pushUndo({
                          type: "resize",
                          undo: () => onUpdateNodeMetadata(nodeId, { ...existing, pathData: prevPd }),
                          redo: () => onUpdateNodeMetadata(nodeId, { ...existing, pathData: newPd }),
                        });
                      }
                    } else {
                      const prevVal = (existing as Record<string, unknown>)[prop];
                      const newMeta = { ...existing, [prop]: value };
                      onUpdateNodeMetadata(nodeId, newMeta);
                      if (pushUndo) {
                        pushUndo({
                          type: "resize",
                          undo: () => onUpdateNodeMetadata(nodeId, { ...existing, [prop]: prevVal }),
                          redo: () => onUpdateNodeMetadata(nodeId, newMeta),
                        });
                      }
                    }
                  } else {
                    onUpdateNodeMetadata(singleSelectedMeta.id, { [prop]: value });
                  }
                };

                return (
                  <>
                    <div className="rpanel-appearance-row">
                      <span className="rpanel-appearance-row-label">Color</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <ColorPicker
                          value={strokeHex}
                          onChange={(c) => handleStrokeChange("stroke", c)}
                          showNone
                          isNone={isStrokeNone}
                          onNoneToggle={() => handleStrokeChange("stroke", isStrokeNone ? "#ffffff" : "none")}
                          canvasColors={canvasColors}
                        />
                      </div>
                    </div>
                    <div className="rpanel-appearance-row">
                      <span className="rpanel-appearance-row-label">Weight</span>
                      <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1 }}>
                        <InlineNumInput
                          min={0}
                          value={strokeWeightVal}
                          onChange={(v) => handleStrokeChange("strokeWidth", v)}
                        />
                        <span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)" }}>px</span>
                      </div>
                    </div>
                    {isSvg && (
                      <div className="rpanel-appearance-row">
                        <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1 }}>
                          <input
                            type="range"
                            className="rpanel-range"
                            min={0}
                            max={1}
                            step={0.01}
                            value={strokeOpacityVal}
                            onChange={(e) => handleStrokeChange("strokeOpacity", parseFloat(e.target.value))}
                            style={{ flex: 1, minWidth: 0 }}
                          />
                          <span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", whiteSpace: "nowrap", minWidth: 28, textAlign: "right" }}>{Math.round(strokeOpacityVal * 100)}%</span>
                        </div>
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          </PanelSection>
        )}

        {showSvgProperties && singleSelectedMeta && svgEditState?.isEditing && svgEditState.selectedPoints.length === 1 && svgEditState.pathData && (() => {
          const nodeId = selectedImageIds[0];
          const pt = svgEditState.selectedPoints[0];
          const anchor = svgEditState.pathData.subPaths[pt.subPathIdx]?.anchors[pt.anchorIdx];
          if (!anchor) return null;
          return (
            <PanelSection title="Selected Point" defaultOpen={true}>
              <div className="rpanel-setting-group">
                <div className="rpanel-btn-row" style={{ gap: 6, marginBottom: 6 }}>
                  <div style={{ flex: 1 }}>
                    <span className="rpanel-setting-label">X</span>
                    <NumericInput
                      className="rpanel-url-input"
                      step={1}
                      value={String(Math.round(anchor.x * 10) / 10)}
                      onChange={(e) => {
                        const parsed = parseFloat(e.target.value);
                        if (!isNaN(parsed)) {
                          onSvgPointUpdate?.(nodeId, pt.subPathIdx, pt.anchorIdx, parsed, anchor.y);
                        }
                      }}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      }}
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <span className="rpanel-setting-label">Y</span>
                    <NumericInput
                      className="rpanel-url-input"
                      step={1}
                      value={String(Math.round(anchor.y * 10) / 10)}
                      onChange={(e) => {
                        const parsed = parseFloat(e.target.value);
                        if (!isNaN(parsed)) {
                          onSvgPointUpdate?.(nodeId, pt.subPathIdx, pt.anchorIdx, anchor.x, parsed);
                        }
                      }}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      }}
                    />
                  </div>
                </div>
                <div className="rpanel-appearance-row">
                  <span className="rpanel-appearance-row-label" style={{ fontSize: 11 }}>Type</span>
                  <button
                    type="button"
                    className={`rpanel-btn-row-item ${anchor.smooth ? "rpanel-btn-row-item--active" : ""}`}
                    style={{ fontSize: 11, padding: "2px 8px", height: 24 }}
                    onClick={() => onSvgToggleSmooth?.(nodeId, pt.subPathIdx, pt.anchorIdx)}
                    title={anchor.smooth ? "Switch to Corner" : "Switch to Smooth"}
                  >
                    {anchor.smooth ? "Smooth" : "Corner"}
                  </button>
                </div>
                {!anchor.smooth && (
                  <div className="rpanel-appearance-row">
                    <span className="rpanel-appearance-row-label" style={{ fontSize: 11 }}>Radius</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1 }}>
                      <InlineNumInput
                        min={0}
                        value={anchor.cornerRadius ?? 0}
                        onChange={(v) => onSvgPointRadius?.(nodeId, pt.subPathIdx, pt.anchorIdx, v)}
                      />
                      <span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)" }}>px</span>
                    </div>
                  </div>
                )}
              </div>
            </PanelSection>
          );
        })()}

        {showTextProps && (
          <PanelSection title="Text Properties" defaultOpen={true}>
            <TextProperties
              nodeIds={selType === "text" ? selectedImageIds : multiTextIds}
              selectedNodeMeta={selectedNodeMeta}
              onUpdateNodeMetadata={onUpdateNodeMetadata}
            />
          </PanelSection>
        )}

        {showTextProps && (() => {
          const textNodeIds = selType === "text" ? selectedImageIds : multiTextIds;
          const firstTextMeta = selectedNodeMeta?.get(textNodeIds[0]);
          const textColor = (firstTextMeta as Record<string, unknown> | undefined)?.color as string || "#ffffff";
          const textOpacity = firstTextMeta?.opacity ?? 100;
          return (
            <PanelSection title="Fill" defaultOpen={true}>
              <div className="rpanel-setting-group">
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <ColorPicker
                      value={textColor}
                      onChange={(c) => {
                        textNodeIds.forEach((id) => onUpdateNodeMetadata?.(id, { color: c }));
                      }}
                      canvasColors={canvasColors}
                    />
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" opacity="0.5" />
                      <path d="M12 2a10 10 0 0 1 0 20" fill="rgba(255,255,255,0.25)" stroke="none" />
                    </svg>
                    <InlineNumInput
                      min={0}
                      max={100}
                      value={Math.round(textOpacity)}
                      onChange={(v) => textNodeIds.forEach((id) => onUpdateNodeMetadata?.(id, { opacity: v }))}
                    />
                    <span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)" }}>%</span>
                  </div>
                </div>
              </div>
            </PanelSection>
          );
        })()}

        {showBatchActions && (
          <PanelSection
            title="Batch Selection"
            defaultOpen={true}
            badge={<span className="rpanel-tag">{selectionContext?.count ?? 0} items</span>}
          >
            <div className="rpanel-list">
              <button type="button" className="rpanel-list-btn" onClick={() => onSelectionAction!("export")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                Export All
              </button>
              <button type="button" className="rpanel-list-btn" onClick={() => onSelectionAction!("group")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="1" y="1" width="10" height="10" rx="2" />
                  <rect x="13" y="13" width="10" height="10" rx="2" />
                  <path d="M13 1h8a2 2 0 0 1 2 2v8" />
                  <path d="M1 13v8a2 2 0 0 0 2 2h8" />
                </svg>
                Group
              </button>
              <button type="button" className="rpanel-list-btn rpanel-list-btn--danger" onClick={() => onSelectionAction!("delete")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
                Delete Selected
              </button>
            </div>
          </PanelSection>
        )}

        {hasMultiSvgs && onSvgBooleanOp && (
          <PanelSection
            title="Boolean Operations"
            defaultOpen={true}
            badge={<span className="rpanel-tag">{multiSvgIds.length} vectors</span>}
          >
            <div className="rpanel-list">
              <button type="button" className="rpanel-list-btn" onClick={() => onSvgBooleanOp("union", multiSvgIds)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="2" y="2" width="13" height="13" rx="2" />
                  <rect x="9" y="9" width="13" height="13" rx="2" />
                </svg>
                Union
              </button>
              <button type="button" className="rpanel-list-btn" onClick={() => onSvgBooleanOp("subtract", multiSvgIds)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="2" y="2" width="13" height="13" rx="2" />
                  <rect x="9" y="9" width="13" height="13" rx="2" fill="currentColor" fillOpacity="0.3" />
                </svg>
                Subtract
              </button>
              <button type="button" className="rpanel-list-btn" onClick={() => onSvgBooleanOp("intersect", multiSvgIds)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="2" y="2" width="13" height="13" rx="2" />
                  <rect x="9" y="9" width="13" height="13" rx="2" />
                  <rect x="9" y="9" width="6" height="6" fill="currentColor" fillOpacity="0.3" stroke="none" />
                </svg>
                Intersect
              </button>
              <button type="button" className="rpanel-list-btn" onClick={() => onSvgBooleanOp("exclude", multiSvgIds)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="2" y="2" width="13" height="13" rx="2" />
                  <rect x="9" y="9" width="13" height="13" rx="2" />
                  <rect x="9" y="9" width="6" height="6" fill="var(--bg-primary, #1a1a2e)" stroke="none" />
                </svg>
                Exclude
              </button>
              <button type="button" className="rpanel-list-btn" onClick={() => onSvgBooleanOp("flatten", multiSvgIds)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 5v14M5 12h14" />
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                </svg>
                Flatten
              </button>
            </div>
          </PanelSection>
        )}

        {showShapeAppearance && (
          <PanelSection
            title="Shape Appearance"
            defaultOpen={true}
            badge={<span className="rpanel-tag">{multiShapeIds.length} shape{multiShapeIds.length !== 1 ? "s" : ""}</span>}
          >
            <div className="rpanel-setting-group">
              {multiHasNonLineShapes && (
                <div style={{ marginTop: 4 }}>
                  <ColorPicker
                    label={`Fill${multiFillMixed ? " (mixed)" : ""}`}
                    value={multiFirstFill === "none" ? "#5b5fc7" : multiFirstFill}
                    onChange={(c) => {
                      for (const sid of multiShapeIds) {
                        const sm = multiShapeMetas.find((s) => s.id === sid);
                        if (sm && sm.shapeKind !== "line") {
                          onUpdateNodeMetadata?.(sid, { fill: c });
                        }
                      }
                    }}
                    canvasColors={canvasColors}
                  />
                </div>
              )}

              <div className="rpanel-stroke-row" style={{ marginTop: 4 }}>
                <span className="rpanel-inline-prop-icon" title="Stroke Color">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="3" />
                    <rect x="7" y="7" width="10" height="10" rx="1" fill="currentColor" opacity="0.15" />
                  </svg>
                </span>
                <div className="rpanel-stroke-row-color">
                  <ColorPicker
                    label={multiStrokeMixed ? "(mixed)" : undefined}
                    value={(!multiFirstStroke || multiFirstStroke === "none") ? "#ffffff" : multiFirstStroke}
                    onChange={(c) => {
                      for (const sid of multiShapeIds) {
                        onUpdateNodeMetadata?.(sid, { stroke: c });
                      }
                    }}
                    canvasColors={canvasColors}
                  />
                </div>
                <div className="rpanel-stroke-row-weight" title="Stroke Weight">
                  <InlineNumInput
                    min={0}
                    value={multiFirstStrokeWeight}
                    onChange={(v) => {
                      for (const sid of multiShapeIds) {
                        onUpdateNodeMetadata?.(sid, { strokeWidth: v });
                      }
                    }}
                  />
                </div>
              </div>
            </div>
          </PanelSection>
        )}

        {(showImageActions || showVideoActions) && singleSelectedMeta && (
          <PanelSection title="Opacity" defaultOpen={true}>
            <div className="rpanel-setting-group">
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" opacity="0.5" />
                  <path d="M12 2a10 10 0 0 1 0 20" fill="rgba(255,255,255,0.25)" stroke="none" />
                </svg>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(singleSelectedMeta.opacity ?? 100)}
                  onChange={(e) => onUpdateNodeMetadata?.(singleSelectedMeta.id, { opacity: Number(e.target.value) })}
                  style={{ flex: 1, accentColor: "#5b5fc7", height: 4, cursor: "pointer" }}
                />
                <InlineNumInput
                  min={0}
                  max={100}
                  value={Math.round(singleSelectedMeta.opacity ?? 100)}
                  onChange={(v) => onUpdateNodeMetadata?.(singleSelectedMeta.id, { opacity: v })}
                />
                <span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)" }}>%</span>
              </div>
            </div>
          </PanelSection>
        )}

        {showImageActions && (
          <PanelSection title="Image Actions" defaultOpen={true}>
            <div className="rpanel-list">
              <button type="button" className="rpanel-list-btn" onClick={() => onSelectionAction!("img2video", "16:9", "video_gen")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="23 7 16 12 23 17 23 7" />
                  <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                </svg>
                Image to Video
              </button>
              <button type="button" className="rpanel-list-btn" onClick={() => onSelectionAction!("upscale", "1:1", "upscale")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 3 21 3 21 9" />
                  <polyline points="9 21 3 21 3 15" />
                  <line x1="21" y1="3" x2="14" y2="10" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </svg>
                Upscale
              </button>
              <button type="button" className="rpanel-list-btn" onClick={() => onSelectionAction!("expand", "16:9", "resize")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <line x1="9" y1="3" x2="9" y2="21" />
                  <line x1="15" y1="3" x2="15" y2="21" />
                </svg>
                Expand / Resize
              </button>
              <button type="button" className="rpanel-list-btn" onClick={() => onSelectionAction!("variations", "1:1", "image_to_image")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="6" width="16" height="12" rx="2" />
                  <path d="M22 8.5V17a2 2 0 0 1-2 2" />
                </svg>
                Variations
              </button>
              <button type="button" className="rpanel-list-btn" onClick={() => onSelectionAction!("remove_bg", "1:1", "remove_bg")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 5.5A3.5 3.5 0 0 1 8.5 2H12v7H8.5A3.5 3.5 0 0 1 5 5.5z" />
                  <path d="M12 2h3.5a3.5 3.5 0 1 1 0 7H12V2z" />
                  <path d="M12 12.5a3.5 3.5 0 1 1 7 0 3.5 3.5 0 1 1-7 0z" />
                </svg>
                Remove Background
              </button>
            </div>
          </PanelSection>
        )}

        {showVideoActions && (
          <PanelSection title="Video Actions" defaultOpen={true}>
            <div className="rpanel-list">
              <button type="button" className="rpanel-list-btn" onClick={() => onSelectionAction!("extend_video")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 3 21 3 21 9" />
                  <polyline points="9 21 3 21 3 15" />
                  <line x1="21" y1="3" x2="14" y2="10" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </svg>
                Extend Video
              </button>
              <button type="button" className="rpanel-list-btn" onClick={() => onSelectionAction!("video_to_gif")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
                  <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
                </svg>
                Convert to GIF
              </button>
              <button type="button" className="rpanel-list-btn" onClick={() => onSelectionAction!("download")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                Download
              </button>
            </div>
          </PanelSection>
        )}

        {showSvgActions && (
          <PanelSection title="Vector Actions" defaultOpen={true}>
            <div className="rpanel-list">
              <button type="button" className="rpanel-list-btn" onClick={() => onSelectionAction!("download")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                Download SVG
              </button>
              <button
                type="button"
                className="rpanel-list-btn"
                onClick={() => {
                  if (!onUpdateNodeMetadata || !selectedImageIds?.length) return;
                  const nodeId = selectedImageIds[0];
                  const meta = selectedNodeMeta?.get(nodeId);
                  if (!meta) return;
                  const pd = (meta as Record<string, unknown>).pathData as PathData | undefined;
                  if (!pd) return;
                  const oldMeta = { ...(meta as Record<string, unknown>) };
                  const simplified = simplifyPathData(pd);
                  onUpdateNodeMetadata(nodeId, { ...oldMeta, pathData: simplified });
                  if (pushUndo) {
                    pushUndo({
                      type: "resize",
                      undo: () => onUpdateNodeMetadata(nodeId, { ...oldMeta, pathData: pd }),
                      redo: () => onUpdateNodeMetadata(nodeId, { ...oldMeta, pathData: simplified }),
                    });
                  }
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <polyline points="22 4 12 14.01 9 11.01" />
                </svg>
                Cleanup Vector
              </button>
            </div>
          </PanelSection>
        )}

        {showFrameProperties && (
          <PanelSection title="Frame Properties" defaultOpen={true}>
            <div className="rpanel-setting-group">
              <ColorPicker
                label="Background Color"
                value={selectedFrameColor || getDefaultFrameFill()}
                onChange={(c) => onFrameColorChange?.(c)}
                canvasColors={canvasColors}
              />
            </div>
          </PanelSection>
        )}

        {showShapes && (
          <PanelSection title="Shapes" defaultOpen={true}>
            <div className="rpanel-list">
              {SHAPE_KINDS.map((sk) => {
                const isActive = pendingShapeKind === sk.value;
                return (
                  <button
                    key={sk.value}
                    type="button"
                    className={`rpanel-list-btn ${isActive ? "rpanel-list-btn--active" : ""}`}
                    onClick={() => {
                      onPendingShapeKindChange?.(sk.value);
                      onSubToolChange?.("shape");
                    }}
                  >
                    {sk.value === "rectangle" && (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="3" width="18" height="18" rx="2" />
                      </svg>
                    )}
                    {sk.value === "ellipse" && (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <ellipse cx="12" cy="12" rx="10" ry="8" />
                      </svg>
                    )}
                    {sk.value === "triangle" && (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polygon points="12,2 22,22 2,22" />
                      </svg>
                    )}
                    {sk.value === "diamond" && (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polygon points="12,2 22,12 12,22 2,12" />
                      </svg>
                    )}
                    {sk.value === "line" && (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="2" y1="12" x2="22" y2="12" />
                      </svg>
                    )}
                    {sk.label}
                  </button>
                );
              })}
              <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6, lineHeight: 1.4 }}>
                Click or drag on the canvas to place a {pendingShapeKind}
              </p>
            </div>
          </PanelSection>
        )}

        <PanelSection title="Drawing" defaultOpen={true}>
          <div className="rpanel-list">
            <button
              type="button"
              className={`rpanel-list-btn ${_activeSubTool === "pen" ? "rpanel-list-btn--active" : ""}`}
              onClick={() => onSubToolChange?.("pen")}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19l7-7 3 3-7 7-3-3z" />
                <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
                <path d="M2 2l7.586 7.586" />
                <circle cx="11" cy="11" r="2" />
              </svg>
              Pen
            </button>
            <button
              type="button"
              className={`rpanel-list-btn ${_activeSubTool === "draw" ? "rpanel-list-btn--active" : ""}`}
              onClick={() => onSubToolChange?.("draw")}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
              </svg>
              Draw
            </button>
            <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6, lineHeight: 1.4 }}>
              {_activeSubTool === "pen" ? "Click to place points. Drag for curves. Click first point to close. Escape/Enter to finish." : _activeSubTool === "draw" ? "Click and drag to sketch freely. Release to auto-smooth." : "Select Pen or Draw to create paths on the canvas."}
            </p>
          </div>
        </PanelSection>

        <PanelSection title="Frames" defaultOpen={!hasSelection}>
          <div className="rpanel-setting-group" style={{ marginBottom: 10 }}>
            <div className="rpanel-btn-row">
              <div style={{ flex: 1 }}>
                <span className="rpanel-setting-label">W</span>
                <NumericInput
                  className="rpanel-url-input"
                  value={customWidth}
                  onChange={(e) => setCustomWidth(e.target.value)}
                  min={32}
                  onKeyDown={(e) => { if (e.key === "Enter") handleCustomCreate(); e.stopPropagation(); }}
                />
              </div>
              <span className="rpanel-setting-label" style={{ alignSelf: "flex-end", padding: "8px 0" }}>×</span>
              <div style={{ flex: 1 }}>
                <span className="rpanel-setting-label">H</span>
                <NumericInput
                  className="rpanel-url-input"
                  value={customHeight}
                  onChange={(e) => setCustomHeight(e.target.value)}
                  min={32}
                  onKeyDown={(e) => { if (e.key === "Enter") handleCustomCreate(); e.stopPropagation(); }}
                />
              </div>
              <button
                type="button"
                className="rpanel-btn-row-item rpanel-btn-row-item--active"
                style={{ flex: "none", padding: "0 14px", height: 32, alignSelf: "flex-end" }}
                onClick={handleCustomCreate}
              >
                Add
              </button>
            </div>
          </div>
          <div className="rpanel-list">
            {FRAME_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className="rpanel-list-btn"
                onClick={() => onCreateFrame(preset.width, preset.height)}
              >
                <FrameIcon w={preset.width} h={preset.height} />
                <span className="rpanel-card-toggle-label">{preset.label}</span>
                <span className="rpanel-tag">{preset.width}×{preset.height}</span>
              </button>
            ))}
          </div>
        </PanelSection>

      </div>

      {hasSelectedFrame && onExportFrames && (
        <div className="rpanel-footer">
          <button type="button" className="rpanel-action-btn" onClick={() => onExportFrames("png")}>
            Export as PNG{selectedFrameIds && selectedFrameIds.length > 1 ? ` (${selectedFrameIds.length})` : ""}
          </button>
          <button type="button" className="rpanel-action-btn rpanel-action-btn--secondary" onClick={() => onExportFrames("pdf")} style={{ marginTop: 6 }}>
            Export as PDF{selectedFrameIds && selectedFrameIds.length > 1 ? ` (${selectedFrameIds.length})` : ""}
          </button>
          {selectedFrameHasVideo && videoExport && selectedFrameIds && selectedFrameIds.length === 1 && !videoExportDialogOpen && (
            <button
              type="button"
              className="rpanel-action-btn rpanel-action-btn--secondary"
              onClick={() => setVideoExportDialogOpen(true)}
              style={{ marginTop: 6 }}
            >
              Export as MP4
            </button>
          )}
          {selectedFrameHasVideo && videoExport && selectedFrameIds && selectedFrameIds.length === 1 && videoExportDialogOpen && (
            <VideoExportInline
              videoExport={videoExport}
              onClose={() => {
                setVideoExportDialogOpen(false);
                videoExport.reset();
              }}
            />
          )}
        </div>
      )}

      {hasSelection && !hasSelectedFrame && onClearSelection && (
        <div className="rpanel-footer">
          <button type="button" className="rpanel-action-btn rpanel-action-btn--secondary" onClick={onClearSelection}>
            Deselect
          </button>
        </div>
      )}

    </aside>
  );
}

const VIDEO_STAGE_LABELS: Record<string, string> = {
  idle: "",
  preparing: "Preparing overlay...",
  "loading-ffmpeg": "Loading encoder...",
  "fetching-media": "Fetching video...",
  encoding: "Encoding video...",
  finalizing: "Finalizing...",
  done: "Export complete!",
  error: "Export failed",
  cancelled: "Export cancelled",
};

type VideoExportInlineProps = {
  videoExport: NonNullable<DesignPanelProps["videoExport"]>;
  onClose: () => void;
};

function VideoExportInline({ videoExport, onClose }: VideoExportInlineProps) {
  const [resolution, setResolution] = useState<"match" | "1080p" | "720p">("match");
  const [includeAudio, setIncludeAudio] = useState(true);
  const { isExporting, stage, progress, error, start, cancel } = videoExport;

  const handleStart = () => start(resolution, includeAudio);

  const inProgress = isExporting && stage !== "done" && stage !== "error" && stage !== "cancelled";
  const showResult = stage === "done" || stage === "error" || stage === "cancelled";

  return (
    <div
      style={{
        marginTop: 8,
        padding: 12,
        background: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 8,
        color: "var(--text-primary, #fff)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>Export as MP4</span>
        {!inProgress && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close MP4 export"
            style={{
              background: "transparent",
              border: "none",
              color: "rgba(255,255,255,0.5)",
              fontSize: 16,
              lineHeight: 1,
              cursor: "pointer",
              padding: 0,
            }}
          >×</button>
        )}
      </div>

      {!inProgress && !showResult && (
          <>
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: "block", fontSize: 11, color: "rgba(255,255,255,0.5)", marginBottom: 4 }}>
                Resolution
              </label>
              <select
                value={resolution}
                onChange={(e) => setResolution(e.target.value as "match" | "1080p" | "720p")}
                style={{
                  width: "100%",
                  padding: "6px 8px",
                  fontSize: 12,
                  color: "var(--text-primary, #fff)",
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  borderRadius: 6,
                  outline: "none",
                }}
              >
                <option value="match">Match frame size</option>
                <option value="1080p">1080p</option>
                <option value="720p">720p</option>
              </select>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
              <input
                type="checkbox"
                id="video-export-audio"
                checked={includeAudio}
                onChange={(e) => setIncludeAudio(e.target.checked)}
                style={{ accentColor: "var(--accent, #3b82f6)" }}
              />
              <label htmlFor="video-export-audio" style={{ fontSize: 12, color: "rgba(255,255,255,0.7)", cursor: "pointer" }}>
                Include audio
              </label>
            </div>

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                type="button"
                className="rpanel-action-btn rpanel-action-btn--secondary"
                onClick={onClose}
                style={{ flex: 1 }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rpanel-action-btn"
                onClick={handleStart}
                style={{ flex: 1 }}
              >
                Export
              </button>
            </div>
          </>
        )}

        {inProgress && (
          <>
            <div style={{ marginBottom: 12 }}>
              <div
                style={{
                  width: "100%",
                  height: 6,
                  background: "rgba(255,255,255,0.06)",
                  borderRadius: 3,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${Math.round(progress * 100)}%`,
                    height: "100%",
                    background: "var(--accent, #3b82f6)",
                    borderRadius: 3,
                    transition: "width 0.3s ease",
                  }}
                />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
                <span style={{ fontSize: 11, color: "rgba(255,255,255,0.6)" }}>
                  {VIDEO_STAGE_LABELS[stage] || ""}
                </span>
                <span style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>
                  {Math.round(progress * 100)}%
                </span>
              </div>
            </div>
            <button
              type="button"
              className="rpanel-action-btn rpanel-action-btn--secondary"
              onClick={cancel}
              style={{ width: "100%" }}
            >
              Cancel
            </button>
          </>
        )}

        {showResult && (
          <>
            {stage === "done" && (
              <div style={{ fontSize: 12, color: "#4ade80", marginBottom: 14 }}>
                Export complete. File downloaded.
              </div>
            )}
            {stage === "cancelled" && (
              <div style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", marginBottom: 14 }}>
                Export cancelled.
              </div>
            )}
            {stage === "error" && (
              <div style={{ fontSize: 12, color: "#f87171", marginBottom: 14, wordBreak: "break-word" }}>
                {error || "Export failed."}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              {stage === "error" && (
                <button
                  type="button"
                  className="rpanel-action-btn"
                  onClick={handleStart}
                  style={{ flex: 1 }}
                >
                  Retry
                </button>
              )}
              <button
                type="button"
                className="rpanel-action-btn rpanel-action-btn--secondary"
                onClick={onClose}
                style={{ flex: 1 }}
              >
                Close
              </button>
            </div>
          </>
        )}
    </div>
  );
}
