import { useCallback, useState, useEffect, useRef, memo } from "react";
import { NodeActions } from "./NodeActions";
import { createPortal } from "react-dom";
import type { CanvasNode, UndoCommand } from "../../types/canvas";
import type { ResizeHandle } from "../../hooks/useResizeHandles";
import { VideoNode } from "./VideoNode";
import { TextNodeContent } from "./TextNodeContent";
import { AudioNode } from "../../features/cinema-canvas/components/AudioNode";
import "../../features/cinema-canvas/components/AudioNode.css";
import { CinemaFrame } from "../../features/cinema-frame/components/CinemaFrame";
import type { IncomingDragPreview } from "../../features/cinema-frame/helpers/timelineState";
import "../../features/cinema-frame/components/CinemaFrame.css";
import { GeneratingNode } from "./GeneratingNode";
import { isGradientFill, parseGradientFill, gradientToCss } from "../../utils/gradientUtils";
import { getDefaultFrameFill } from "../../theme";
import { enqueueDirty } from "../../services/CanvasStore";
import { buildDWithRadius } from "../../utils/svgPathModel";
import type { PathData, SubPath } from "../../utils/svgPathModel";

// html_urls the live frame already shows (our own saves): no reload for those.
export const liveHtmlUrls = new Set<string>();
const frameKeys = new Map<string, string>();
function liveFrameKey(node: CanvasNode): string {
  const url = String(node.metadata?.html_url);
  const prev = frameKeys.get(node.id);
  if (prev && liveHtmlUrls.has(url)) return prev;
  frameKeys.set(node.id, url);
  return url;
}

export type CanvasNodeProps = {
  node: CanvasNode;
  isSelected: boolean;
  isDraggingNode: boolean;
  isPlayingVideo: boolean;
  isInViewport: boolean;
  selectionOrderIndex: number;
  isFirstFrame: boolean;
  isLastFrame: boolean;
  canvasId: string | null;
  zoom: number;
  clipRect?: { top?: number; right?: number; bottom?: number; left?: number; polygon?: string } | null;
  insideFrame?: boolean;
  hideHandles?: boolean;
  showDimensionLabel?: boolean;
  onNodePointerDown: (e: React.PointerEvent, nodeId: string) => void;
  onNodeClick: (e: React.MouseEvent, nodeId: string) => void;
  onContextMenu: (e: React.MouseEvent, nodeId: string) => void;
  onResizePointerDown: (e: React.PointerEvent, nodeId: string, handle: ResizeHandle) => void;
  onRotatePointerDown: (e: React.PointerEvent, nodeId: string) => void;
  onDownloadNode: (node: CanvasNode) => Promise<void>;
  onSaveToLibrary: (node: CanvasNode) => Promise<{ ok: boolean }>;
  onSavePrompt: (node: CanvasNode) => Promise<{ ok: boolean }>;
  onDeleteNode: (node: CanvasNode, deps: { setNodes: React.Dispatch<React.SetStateAction<CanvasNode[]>>; pushUndo: (cmd: UndoCommand) => void; canvasId: string | null }) => void;
  onOpenFullscreen: (node: CanvasNode) => void;
  onToggleVideoPlay: (id: string) => void;
  onDropPrompt?: (prompt: string, jobId?: string | null) => void;
  setNodes: React.Dispatch<React.SetStateAction<CanvasNode[]>>;
  pushUndo: (cmd: UndoCommand) => void;
  inFlightTextNodeId?: string | null;
  inFlightTextBounds?: { x: number; y: number; w: number; h: number } | null;
  onStartTextEdit?: (nodeId: string) => void;
  onDoubleClickSvg?: (nodeId: string) => void;
  isEditingPath?: boolean;
  onToggleLock?: (nodeId: string) => void;
  onRequestCinemaExport?: (nodeId: string) => void;
  incomingDragPreview?: IncomingDragPreview;
  onTargetTrackChange?: (trackId: string | null, dropTime: number | null) => void;
  onCinemaMetaUpdate?: (nodeId: string, node: CanvasNode) => void;
};

export const CanvasNodeComponent = memo(function CanvasNodeComponent({
  node,
  isSelected,
  isDraggingNode,
  isPlayingVideo,
  isInViewport,
  selectionOrderIndex,
  isFirstFrame,
  isLastFrame,
  canvasId,
  zoom,
  onNodePointerDown,
  onNodeClick,
  onContextMenu,
  onResizePointerDown: _onResizePointerDown,
  onRotatePointerDown: _onRotatePointerDown,
  onDownloadNode,
  onSaveToLibrary,
  onSavePrompt,
  onDeleteNode,
  onOpenFullscreen,
  onToggleVideoPlay,
  onDropPrompt,
  setNodes,
  pushUndo,
  clipRect,
  insideFrame,
  hideHandles: _hideHandles,
  showDimensionLabel = true,
  inFlightTextNodeId,
  inFlightTextBounds,
  onStartTextEdit,
  onDoubleClickSvg,
  isEditingPath,
  onToggleLock,
  onRequestCinemaExport,
  incomingDragPreview,
  onTargetTrackChange,
  onCinemaMetaUpdate,
}: CanvasNodeProps) {
  const isFrame = node.node_type === "frame";
  const isVideo = node.node_type === "video";
  const isAudio = node.node_type === "audio";
  const isSvgNode = node.node_type === "svg";
  const isShape = node.node_type === "shape";
  const isText = node.node_type === "text";
  const isCinema = node.node_type === "cinema";
  const isGenerating = node.node_type === "generating";
  const handleCinemaUpdateMetadata = useCallback((nodeId: string, metadata: Record<string, unknown>) => {
    setNodes((prev) => {
      const updated = prev.map((n) => n.id === nodeId ? { ...n, metadata } : n);
      const updatedNode = updated.find((n) => n.id === nodeId);
      if (updatedNode && onCinemaMetaUpdate) {
        onCinemaMetaUpdate(nodeId, updatedNode);
      }
      return updated;
    });
    if (canvasId) {
      enqueueDirty({
        type: "update",
        canvasId,
        nodeId,
        fields: { metadata },
        committed: true,
      });
    }
  }, [canvasId, setNodes, onCinemaMetaUpdate]);

  const customRadius = (node.metadata as Record<string, unknown>)?.borderRadius as number | undefined;
  const nodeRadius = customRadius !== undefined ? `${customRadius}px` : (insideFrame ? "0" : undefined);

  const contentClipStyle = clipRect
    ? clipRect.polygon
      ? { clipPath: `polygon(${clipRect.polygon})` }
      : (clipRect.top! > 0 || clipRect.right! > 0 || clipRect.bottom! > 0 || clipRect.left! > 0)
        ? { clipPath: `inset(${clipRect.top}px ${clipRect.right}px ${clipRect.bottom}px ${clipRect.left}px)` }
        : undefined
    : undefined;

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    onNodePointerDown(e, node.id);
  }, [onNodePointerDown, node.id]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    onNodeClick(e, node.id);
  }, [onNodeClick, node.id]);

  const handleCtxMenu = useCallback((e: React.MouseEvent) => {
    if (isText && inFlightTextNodeId === node.id) return;
    onContextMenu(e, node.id);
  }, [onContextMenu, node.id, isText, inFlightTextNodeId]);

  /* Stable callback for the cinema export button. Without this, an
   * inline arrow would be recreated on every CanvasNodeComponent
   * render (which happens on every zoom tick because `zoom` is a
   * prop), breaking CinemaFrame's `memo` and forcing the heavy
   * timeline + viewer subtree to re-render on each zoom step — which
   * shows up as a visible flash on the cinema node and bleeds through
   * the toolbar's backdrop-filter as a flash there too. */
  const handleCinemaSelectForExport = useCallback(() => {
    onNodeClick(
      { stopPropagation: () => {}, preventDefault: () => {} } as unknown as React.MouseEvent,
      node.id,
    );
    // Selecting is not enough — the export panel shares the right slot with the
    // agent panel, which wins whenever it is open. This is the explicit ask.
    onRequestCinemaExport?.(node.id);
  }, [onNodeClick, onRequestCinemaExport, node.id]);

  const [imgError, setImgError] = useState(false);
  const [recovering, setRecovering] = useState(false);

  useEffect(() => {
    setImgError(false);
  }, [node.src]);

  const handleImgError = useCallback(() => {
    if (recovering) return;
    if (node.asset_id) {
      setRecovering(true);
      fetch(`/api/assets/${node.asset_id}`, { credentials: "include" })
        .then((r) => r.ok ? r.json() : Promise.reject())
        .then((data) => {
          if (data.asset?.file_url) {
            setNodes((prev) => prev.map((n) => n.id === node.id ? { ...n, src: data.asset.file_url } : n));
            setImgError(false);
            if (canvasId) {
              enqueueDirty({
                type: "update",
                canvasId,
                nodeId: node.id,
                fields: { src: data.asset.file_url },
                committed: true,
              });
            }
          } else {
            setImgError(true);
          }
        })
        .catch(() => setImgError(true))
        .finally(() => setRecovering(false));
    } else {
      setImgError(true);
    }
  }, [node.id, node.asset_id, canvasId, recovering, setNodes]);

  const nodeRef = useRef<HTMLDivElement>(null);

  const renderedW = node.width * zoom;
  const renderedH = node.height * zoom;
  const isTinyNode = !isFrame && !isCinema && (renderedW < 32 || renderedH < 32);
  const hitAreaPad = isTinyNode ? Math.max(0, (32 - renderedW) / 2) / zoom : 0;
  const hitAreaPadV = isTinyNode ? Math.max(0, (32 - renderedH) / 2) / zoom : 0;

  const showFloatingToolbar = isSelected && !isFrame && !isShape && !isTinyNode && (node.src || node.gradient) && !node.metadata?.axiomId;

  return (
    <div
      ref={nodeRef}
      className={`freeform-canvas__node ${isSelected && !isFrame && !isEditingPath ? "freeform-canvas__node--selected" : ""} ${isSelected && isFrame ? "freeform-canvas__node--frame-selected" : ""} ${node.locked ? "freeform-canvas__node--locked" : ""} ${isDraggingNode ? "freeform-canvas__node--dragging" : ""} ${isFrame ? "freeform-canvas__node--frame" : ""} ${insideFrame && !isFrame ? "freeform-canvas__node--inside-frame" : ""} ${insideFrame && !isFrame ? "freeform-canvas__node--deep-hoverable" : ""}`}
      data-node-id={node.id}
      style={{
        left: node.x,
        top: node.y,
        width: node.width,
        height: node.height,
        zIndex: node.z_index,
        transform: node.rotation ? `rotate(${node.rotation}deg)` : undefined,
        borderRadius: nodeRadius,
        opacity: (node.metadata as Record<string, unknown>)?.opacity !== undefined ? Math.max(0, Math.min(1, ((node.metadata as Record<string, unknown>).opacity as number) / 100)) : undefined,
        "--zoom": zoom,
        pointerEvents: isFrame && !isSelected ? "none" : undefined,
        overflow: isEditingPath ? "visible" : undefined,
      } as React.CSSProperties}
      onPointerDown={isCinema ? undefined : handlePointerDown}
      onClick={isCinema ? undefined : handleClick}
      onDoubleClick={isSvgNode && onDoubleClickSvg ? (e) => { e.stopPropagation(); onDoubleClickSvg(node.id); } : undefined}
      onContextMenu={handleCtxMenu}
    >
      {isTinyNode && (
        <div
          style={{
            position: "absolute",
            top: -hitAreaPadV / zoom,
            left: -hitAreaPad / zoom,
            right: -hitAreaPad / zoom,
            bottom: -hitAreaPadV / zoom,
            pointerEvents: "auto",
            zIndex: 0,
          }}
          onPointerDown={handlePointerDown}
          onClick={(e) => { e.stopPropagation(); handleClick(e); }}
          onDoubleClick={isSvgNode && onDoubleClickSvg ? (e) => { e.stopPropagation(); onDoubleClickSvg(node.id); } : undefined}
          onContextMenu={(e) => { e.stopPropagation(); handleCtxMenu(e); }}
        />
      )}
      {isCinema ? (
        <div style={{ width: "100%", height: "100%", borderRadius: "inherit", overflow: "hidden" }}>
          <CinemaFrame node={node} canvasId={canvasId} onUpdateMetadata={handleCinemaUpdateMetadata} onToggleLock={onToggleLock} incomingDragPreview={incomingDragPreview} onTargetTrackChange={onTargetTrackChange} onNodePointerDown={handlePointerDown} onNodeClick={handleClick} onSelectForExport={handleCinemaSelectForExport} />
        </div>
      ) : isGenerating ? (
        <div style={{ width: "100%", height: "100%", borderRadius: "inherit", overflow: ((node.metadata as Record<string, unknown>)?.status === "failed") ? "hidden" : "visible", ...contentClipStyle }}>
          <GeneratingNode
            node={node}
            onDismiss={() => onDeleteNode(node, { setNodes, pushUndo, canvasId })}
          />
        </div>
      ) : isFrame ? (
        <div
          className={`freeform-canvas__node-frame-box ${!isSelected ? "freeform-canvas__node-frame-box--hoverable" : ""}`}
          style={{
            background: (() => {
              const fallback = getDefaultFrameFill();
              const fill = (node.metadata?.fill as string) || fallback;
              if (isGradientFill(fill)) {
                const gd = parseGradientFill(fill);
                return gd ? gradientToCss(gd) : fallback;
              }
              return fill;
            })(),
            boxSizing: "border-box",
            ...(() => {
              const s = node.metadata?.stroke as string | undefined;
              const sw = Number(node.metadata?.strokeWidth);
              if (!s || s === "none" || !sw) return {};
              if (isGradientFill(s)) {
                return {};
              }
              return { boxShadow: `inset 0 0 0 ${sw}px ${s}` };
            })(),
          }}
        >
          {(() => {
            const s = node.metadata?.stroke as string | undefined;
            const sw = Number(node.metadata?.strokeWidth);
            if (!s || s === "none" || !sw || !isGradientFill(s)) return null;
            const gd = parseGradientFill(s);
            if (!gd) return null;
            return (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  borderRadius: "inherit",
                  padding: sw,
                  background: gradientToCss(gd),
                  mask: "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
                  WebkitMask: "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
                  WebkitMaskComposite: "xor",
                  maskComposite: "exclude",
                  pointerEvents: "none",
                } as React.CSSProperties}
              />
            );
          })()}
        </div>
      ) : isAudio ? (
        <div style={{ width: "100%", height: "100%", borderRadius: "inherit", overflow: "hidden", ...contentClipStyle }}>
          <AudioNode node={node} />
        </div>
      ) : isVideo ? (
        <div style={{ width: "100%", height: "100%", borderRadius: "inherit", overflow: "hidden", ...contentClipStyle }}>
          <VideoNode node={node} isPlaying={isPlayingVideo} onTogglePlay={onToggleVideoPlay} isInViewport={isInViewport} zoom={zoom} />
        </div>
      ) : isShape ? (
        <svg
          width="100%"
          height="100%"
          viewBox={`0 0 ${node.width} ${node.height}`}
          preserveAspectRatio="none"
          style={{ display: "block", overflow: "visible", ...contentClipStyle }}
        >
          {(() => {
            const meta = node.metadata as Record<string, unknown>;
            const shapeKind = (meta?.shapeKind as string) || "rectangle";
            const rawFill = (meta?.fill as string) || "#5b5fc7";
            const rawStroke = (meta?.stroke as string) || "none";
            const strokeWidth = (meta?.strokeWidth as number) || 0;
            const br = (meta?.borderRadius as number) || 0;
            const gradData = isGradientFill(rawFill) ? parseGradientFill(rawFill) : null;
            const gradId = gradData ? `grad-fill-${node.id}` : null;
            const fill = gradId ? `url(#${gradId})` : rawFill;
            const strokeGradData = isGradientFill(rawStroke) ? parseGradientFill(rawStroke) : null;
            const strokeGradId = strokeGradData ? `grad-stroke-${node.id}` : null;
            const stroke = strokeGradId ? `url(#${strokeGradId})` : rawStroke;
            const gradDef = (gradData || strokeGradData) ? (
              <defs>
                {gradData && gradId && (
                  <linearGradient id={gradId} x1={`${gradData.x1 * 100}%`} y1={`${gradData.y1 * 100}%`} x2={`${gradData.x2 * 100}%`} y2={`${gradData.y2 * 100}%`}>
                    <stop offset="0%" stopColor={gradData.color1} />
                    <stop offset="100%" stopColor={gradData.color2} />
                  </linearGradient>
                )}
                {strokeGradData && strokeGradId && (
                  <linearGradient id={strokeGradId} x1={`${strokeGradData.x1 * 100}%`} y1={`${strokeGradData.y1 * 100}%`} x2={`${strokeGradData.x2 * 100}%`} y2={`${strokeGradData.y2 * 100}%`}>
                    <stop offset="0%" stopColor={strokeGradData.color1} />
                    <stop offset="100%" stopColor={strokeGradData.color2} />
                  </linearGradient>
                )}
              </defs>
            ) : null;
            if (shapeKind === "ellipse") {
              return <>{gradDef}<ellipse cx={node.width / 2} cy={node.height / 2} rx={node.width / 2} ry={node.height / 2} fill={fill} stroke={stroke} strokeWidth={strokeWidth} /></>;
            }
            if (shapeKind === "triangle") {
              const pts = `${node.width / 2},0 ${node.width},${node.height} 0,${node.height}`;
              return <>{gradDef}<polygon points={pts} fill={fill} stroke={stroke} strokeWidth={strokeWidth} /></>;
            }
            if (shapeKind === "diamond") {
              const pts = `${node.width / 2},0 ${node.width},${node.height / 2} ${node.width / 2},${node.height} 0,${node.height / 2}`;
              return <>{gradDef}<polygon points={pts} fill={fill} stroke={stroke} strokeWidth={strokeWidth} /></>;
            }
            if (shapeKind === "line") {
              const dir = (meta?.lineDirection as string) || "down";
              const lx1 = 0;
              const ly1 = dir === "down" ? 0 : node.height;
              const lx2 = node.width;
              const ly2 = dir === "down" ? node.height : 0;
              return <>{gradDef}<line x1={lx1} y1={ly1} x2={lx2} y2={ly2} stroke={stroke || "#ffffff"} strokeWidth={strokeWidth || 2} /></>;
            }
            return <>{gradDef}<rect x={0} y={0} width={node.width} height={node.height} rx={br} ry={br} fill={fill} stroke={stroke} strokeWidth={strokeWidth} /></>;
          })()}
        </svg>
      ) : isText ? (
        <TextNodeContent
          node={node}
          isHidden={
            inFlightTextNodeId === node.id ||
            (!!inFlightTextBounds && inFlightTextNodeId !== node.id &&
              node.x < inFlightTextBounds.x + inFlightTextBounds.w &&
              node.x + node.width > inFlightTextBounds.x &&
              node.y < inFlightTextBounds.y + inFlightTextBounds.h &&
              node.y + node.height > inFlightTextBounds.y)
          }
          onStartEdit={onStartTextEdit || (() => {})}
        />
      ) : isSvgNode && (node.metadata?.pathData || node.src) ? (
        (node.metadata?.pathData) ? (
          (() => {
            const pd = node.metadata.pathData as PathData;
            // A stored viewBox is the truth. The max-anchor guess below only
            // exists for pathData written before extraction recorded one, and
            // it stretches any artwork whose ink stops short of its own edge.
            const vbX = pd.viewBox?.x ?? 0;
            const vbY = pd.viewBox?.y ?? 0;
            let vbW = pd.viewBox?.width ?? 0;
            let vbH = pd.viewBox?.height ?? 0;
            if (!pd.viewBox) {
            for (const sp of pd.subPaths) {
              for (const a of sp.anchors) {
                if (a.x > vbW) vbW = a.x;
                if (a.y > vbH) vbH = a.y;
                if (a.handleIn) {
                  if (a.handleIn.x > vbW) vbW = a.handleIn.x;
                  if (a.handleIn.y > vbH) vbH = a.handleIn.y;
                }
                if (a.handleOut) {
                  if (a.handleOut.x > vbW) vbW = a.handleOut.x;
                  if (a.handleOut.y > vbH) vbH = a.handleOut.y;
                }
              }
            }
            }
            vbW = vbW || node.width;
            vbH = vbH || node.height;
            return (
              <svg
                className="freeform-canvas__node-svg"
                width={node.width}
                height={node.height}
                viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`}
                preserveAspectRatio="none"
                // Clipped unless you are editing: artwork spilling past the node
                // box keeps hit-testing out there too, and swallows the click on
                // bare canvas that was meant to deselect.
                style={{ ...contentClipStyle, width: "100%", height: "100%", display: "block", overflow: isEditingPath ? "visible" : "hidden" }}
              >
                {(() => {
                  const hasPerSubPathColors = pd.subPaths.some((sp) => sp.fill !== undefined || sp.stroke !== undefined);
                  if (hasPerSubPathColors) {
                    // SubPaths that came from one source <path> render as one
                    // <path>: split apart, an even-odd donut loses its hole and
                    // fills in solid.
                    const groups: { key: string; sps: SubPath[] }[] = [];
                    pd.subPaths.forEach((sp, i) => {
                      const key = sp.group !== undefined ? `g${sp.group}` : `i${i}`;
                      const last = groups[groups.length - 1];
                      if (last && last.key === key) last.sps.push(sp);
                      else groups.push({ key, sps: [sp] });
                    });
                    return groups.map(({ key, sps }) => {
                      const sp = sps[0];
                      const spFill = sp.fill !== undefined ? sp.fill : (pd.fill ?? "none");
                      const spStroke = sp.stroke !== undefined ? sp.stroke : (pd.stroke ?? "none");
                      const spStrokeWidth = sp.strokeWidth !== undefined ? sp.strokeWidth : (pd.strokeWidth ?? 0);
                      const spD = buildDWithRadius({ ...pd, subPaths: sps });
                      return (
                        <path
                          key={key}
                          d={spD}
                          fill={spFill !== "none" ? spFill : "none"}
                          fillOpacity={sp.fillOpacity ?? pd.fillOpacity ?? pd.opacity ?? 1}
                          fillRule={sp.fillRule ?? pd.fillRule ?? undefined}
                          stroke={spStroke !== "none" ? spStroke : "none"}
                          strokeOpacity={sp.strokeOpacity ?? pd.strokeOpacity ?? 1}
                          strokeWidth={spStrokeWidth}
                        />
                      );
                    });
                  }
                  return (
                    <path
                      d={buildDWithRadius(pd)}
                      fill={pd.fill || "none"}
                      fillOpacity={pd.fillOpacity ?? pd.opacity ?? 1}
                      fillRule={pd.fillRule || undefined}
                      stroke={pd.stroke || "none"}
                      strokeOpacity={pd.strokeOpacity ?? 1}
                      strokeWidth={pd.strokeWidth ?? 0}
                    />
                  );
                })()}
              </svg>
            );
          })()
        ) : imgError ? (
          <div className="freeform-canvas__node-missing" style={contentClipStyle}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></svg>
            <span className="freeform-canvas__node-missing-label">{node.label || "Missing image"}</span>
          </div>
        ) : (
          <img className="freeform-canvas__node-img freeform-canvas__node-svg" src={node.src} alt={node.label} decoding="async" draggable={false} style={contentClipStyle} onError={handleImgError} />
        )
      ) : node.metadata?.kind === "html" && node.metadata?.html_url ? (
        // Live document over its PNG: the picker edits this DOM directly; the PNG
        // shows through while the frame reloads (html_url changes, incl. our own saves).
        <>
        <img className="freeform-canvas__node-img" src={node.src} alt="" decoding="async" draggable={false} />
        {/* The live document only exists while the node is selected (the picker
            needs it); everywhere else the PNG stands in — N html nodes were N
            live layouts and that was the canvas crawling. */}
        {isSelected && <iframe
          key={liveFrameKey(node)}
          data-html-node={node.id}
          className="freeform-canvas__node-html"
          sandbox="allow-same-origin"
          src={`/api/canvas/html-live/${node.id}`}
          title={node.label}
          style={{
            width: (node.metadata.pixel_width as number) || node.width,
            height: (node.metadata.pixel_height as number) || node.height,
            transform: `scale(${node.width / ((node.metadata.pixel_width as number) || node.width)}, ${node.height / ((node.metadata.pixel_height as number) || node.height)})`,
          }}
        />}
        </>
      ) : node.src ? (
        imgError ? (
          <div className="freeform-canvas__node-missing" style={contentClipStyle}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></svg>
            <span className="freeform-canvas__node-missing-label">{node.label || "Missing image"}</span>
          </div>
        ) : (
          <img className="freeform-canvas__node-img" src={node.src} alt={node.label} decoding="async" draggable={false} style={contentClipStyle} onError={handleImgError} />
        )
      ) : node.gradient ? (
        <div className="freeform-canvas__node-gradient" style={{ background: node.gradient, ...contentClipStyle }} />
      ) : (
        <div className="freeform-canvas__node-gradient" style={{ background: "rgba(255,255,255,0.05)", ...contentClipStyle }} />
      )}
      {showFloatingToolbar && nodeRef.current && createPortal(
        <div className="freeform-canvas__floating-toolbar" style={{ position: "absolute", left: node.x + node.width / 2, top: node.y + node.height + 34 * Math.min(1.55 * Math.pow(1 / zoom, 0.55), 3.5), bottom: "auto", zIndex: 999999, transform: `translateX(-50%) scale(${Math.min(1.55 * Math.pow(1 / zoom, 0.55), 3.5)})`, transformOrigin: "top center" }} onPointerDown={(e) => e.stopPropagation()}>
          <div className="freeform-canvas__floating-toolbar__glass-shadow" aria-hidden="true" />
          <div className="freeform-canvas__floating-toolbar__glass-backdrop" aria-hidden="true" />
          <NodeActions
            node={node}
            onDownload={onDownloadNode}
            onSaveToLibrary={onSaveToLibrary}
            onOpenFullscreen={onOpenFullscreen}
            onSavePrompt={onSavePrompt}
            onReusePrompt={(n) => {
              navigator.clipboard.writeText(n.label).catch(() => {});
              if (onDropPrompt) onDropPrompt(n.label, n.job_id);
            }}
            onDelete={(n) => onDeleteNode(n, { setNodes, pushUndo, canvasId })}
          />
        </div>,
        nodeRef.current.parentElement || document.body
      )}
      {isSelected && selectionOrderIndex >= 0 && (
        <span className="freeform-canvas__sel-order">{selectionOrderIndex + 1}</span>
      )}
      {(isFirstFrame || isLastFrame) && !isVideo && (
        <div className="freeform-canvas__frame-pill">
          {isFirstFrame ? "First Frame" : "Last Frame"}
        </div>
      )}
      {isSelected && showDimensionLabel && (
        <div className="freeform-canvas__dimension-label">
          {Math.round(node.width)} × {Math.round(node.height)}{node.rotation ? ` · ${Math.round(node.rotation)}°` : ""}
        </div>
      )}
      
    </div>
  );
});
