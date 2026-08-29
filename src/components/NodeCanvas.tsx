import { useRef, useState, useCallback, useEffect, type MouseEvent as RME } from "react";
import { PORT_COLORS, NODE_SCHEMAS, createNode, type WorkflowNode, type WorkflowEdge, type NodeType, type PortType } from "./nodeTypes";
import "./NodeCanvas.css";

function getConnectedValue(nodeId: string, portId: string, nodes: WorkflowNode[], edges: WorkflowEdge[]): string | null {
  const edge = edges.find((e) => e.targetNode === nodeId && e.targetPort === portId);
  if (!edge) return null;
  const src = nodes.find((n) => n.id === edge.sourceNode);
  if (!src) return null;
  if (src.type === "text") return (src.config.value as string) || "";
  if (src.type === "style") return (src.config.stylePrompt as string) || "";
  return null;
}

type Props = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  onNodesChange: (nodes: WorkflowNode[]) => void;
  onEdgesChange: (edges: WorkflowEdge[]) => void;
};

const NODE_TYPE_ICONS: Record<NodeType, string> = {
  text: "T",
  image: "I",
  video: "V",
  upscale: "U",
  resize: "R",
  remove: "X",
  tts: "S",
  music: "♪",
  voicechanger: "V",
  gifmaker: "G",
  axiom: "A",
  style: "S",
};

const CONTEXT_NODE_TYPES: NodeType[] = [
  "text", "image", "video", "upscale", "resize", "remove",
  "tts", "music", "voicechanger", "gifmaker", "axiom", "style",
];

function getNodeWidth(node: WorkflowNode): number {
  return (node.config._width as number) || 220;
}

const PREVIEW_H = 140;
const PROMPT_H = 72;

function getBodyHeight(node: WorkflowNode): number {
  if (node.type === "image") {
    const hasCustomH = node.config._height as number | undefined;
    return hasCustomH ? hasCustomH - 34 - node.inputs.length * 24 - node.outputs.length * 24 : PREVIEW_H + PROMPT_H;
  }
  if (node.type === "video") return PREVIEW_H + PROMPT_H;
  if (node.type === "text") return 72;
  return 0;
}

function getPortPos(
  node: WorkflowNode,
  portId: string,
  side: "input" | "output",
): { x: number; y: number } {
  const ports = side === "input" ? node.inputs : node.outputs;
  const idx = ports.findIndex((p) => p.id === portId);
  const nodeW = getNodeWidth(node);
  const headerH = 34;
  const portH = 24;
  const bodyH = getBodyHeight(node);

  const inputSectionH = node.inputs.length * portH;
  const x = side === "input" ? node.position.x : node.position.x + nodeW;
  let y: number;
  if (side === "input") {
    y = node.position.y + headerH + bodyH + idx * portH + portH / 2;
  } else {
    y = node.position.y + headerH + bodyH + inputSectionH + idx * portH + portH / 2;
  }
  return { x, y };
}

function bezierPath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.abs(x2 - x1) * 0.5;
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}

export function NodeCanvas({
  nodes,
  edges,
  selectedNodeId,
  onSelectNode,
  onNodesChange,
  onEdgesChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const spaceDown = useRef(false);
  const [marquee, setMarquee] = useState<{ startX: number; startY: number; currentX: number; currentY: number } | null>(null);
  const marqueeMousePos = useRef({ x: 0, y: 0 });
  const edgePanFrame = useRef<number | null>(null);
  const didMarquee = useRef(false);

  const [draggingNode, setDraggingNode] = useState<string | null>(null);
  const dragOffset = useRef({ x: 0, y: 0 });

  const [drawingEdge, setDrawingEdge] = useState<{
    sourceNode: string;
    sourcePort: string;
    sourceType: PortType;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  } | null>(null);

  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; worldX: number; worldY: number } | null>(null);

  const [resizing, setResizing] = useState<{ nodeId: string; corner: string } | null>(null);
  const resizeStart = useRef({ mx: 0, my: 0, w: 0, h: 0, nx: 0, ny: 0 });

  const [fileDragOver, setFileDragOver] = useState(false);

  const screenToWorld = useCallback(
    (sx: number, sy: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return { x: sx, y: sy };
      return {
        x: (sx - rect.left - pan.x) / zoom,
        y: (sy - rect.top - pan.y) / zoom,
      };
    },
    [pan, zoom],
  );

  /* --- Drag-and-drop onto canvas --- */
  const handleDragOver = useCallback((e: React.DragEvent) => {
    const t = e.dataTransfer.types;
    if (t.includes("Files") || t.includes("application/x-axiom") || t.includes("application/x-style")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setFileDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget === e.target || !containerRef.current?.contains(e.relatedTarget as Node)) {
      setFileDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setFileDragOver(false);
      const world = screenToWorld(e.clientX, e.clientY);

      const axiomRaw = e.dataTransfer.getData("application/x-axiom");
      if (axiomRaw) {
        try {
          const data = JSON.parse(axiomRaw);
          const node = createNode("axiom", world.x, world.y);
          node.label = data.name || "Product";
          node.config.axiomId = data.id;
          node.config.axiomName = data.name;
          node.config.axiomBucket = data.bucket;
          node.config.axiomThumb = data.thumb;
          node.config._width = 240;
          onNodesChange([...nodes, node]);
          onSelectNode(node.id);
        } catch { /* ignore */ }
        return;
      }

      const styleRaw = e.dataTransfer.getData("application/x-style");
      if (styleRaw) {
        try {
          const data = JSON.parse(styleRaw);
          const node = createNode("style", world.x, world.y);
          node.label = data.name || "Style";
          node.config.styleId = data.id;
          node.config.styleName = data.name;
          node.config.stylePrompt = data.prompt;
          node.config.styleBucket = data.bucket;
          node.config.styleImage = data.image;
          node.config._width = 240;
          onNodesChange([...nodes, node]);
          onSelectNode(node.id);
        } catch { /* ignore */ }
        return;
      }

      const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
      if (files.length === 0) return;

      files.forEach((file, i) => {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          const img = new Image();
          img.onload = () => {
            const maxW = 260;
            const scale = Math.min(1, maxW / img.width);
            const w = Math.round(img.width * scale);
            const node = createNode("image", world.x + i * 40, world.y + i * 40);
            node.config.imageUrl = dataUrl;
            node.config._width = w;
            onNodesChange([...nodes, node]);
            onSelectNode(node.id);
          };
          img.src = dataUrl;
        };
        reader.readAsDataURL(file);
      });
    },
    [screenToWorld, nodes, onNodesChange, onSelectNode],
  );

  const handleMouseDown = useCallback(
    (e: RME) => {
      const target = e.target as HTMLElement;
      const isBackground = target === containerRef.current || target.classList.contains("nc-world") || (target.closest(".nc") === containerRef.current && !target.closest(".nc-node, .nc-ctx, .nc-port, .nc-resize, .nc-edge-group"));
      if (e.button === 1 || (e.button === 0 && isBackground && spaceDown.current)) {
        setIsPanning(true);
        panStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
        e.preventDefault();
      } else if (e.button === 0 && isBackground) {
        const rect = containerRef.current!.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        setMarquee({ startX: sx, startY: sy, currentX: sx, currentY: sy });
        onSelectNode(null);
        e.preventDefault();
      }
    },
    [pan, onSelectNode],
  );

  const handleMouseMove = useCallback(
    (e: RME) => {
      if (isPanning) {
        setPan({
          x: panStart.current.panX + (e.clientX - panStart.current.x),
          y: panStart.current.panY + (e.clientY - panStart.current.y),
        });
      } else if (marquee) {
        const rect = containerRef.current!.getBoundingClientRect();
        marqueeMousePos.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        setMarquee((prev) => prev ? { ...prev, currentX: e.clientX - rect.left, currentY: e.clientY - rect.top } : null);
      } else if (resizing) {
        const dx = (e.clientX - resizeStart.current.mx) / zoom;
        const dy = (e.clientY - resizeStart.current.my) / zoom;
        const corner = resizing.corner;
        let newW = resizeStart.current.w;
        let newH = resizeStart.current.h;
        let newX = resizeStart.current.nx;
        let newY = resizeStart.current.ny;

        if (corner.includes("e")) newW = Math.max(120, resizeStart.current.w + dx);
        if (corner.includes("w")) { newW = Math.max(120, resizeStart.current.w - dx); newX = resizeStart.current.nx + (resizeStart.current.w - newW); }
        if (corner.includes("s")) newH = Math.max(100, resizeStart.current.h + dy);
        if (corner.includes("n")) { newH = Math.max(100, resizeStart.current.h - dy); newY = resizeStart.current.ny + (resizeStart.current.h - newH); }

        onNodesChange(
          nodes.map((n) =>
            n.id === resizing.nodeId
              ? { ...n, position: { x: newX, y: newY }, config: { ...n.config, _width: newW, _height: newH } }
              : n,
          ),
        );
      } else if (draggingNode) {
        const world = screenToWorld(e.clientX, e.clientY);
        onNodesChange(
          nodes.map((n) =>
            n.id === draggingNode
              ? { ...n, position: { x: world.x - dragOffset.current.x, y: world.y - dragOffset.current.y } }
              : n,
          ),
        );
      } else if (drawingEdge) {
        const world = screenToWorld(e.clientX, e.clientY);
        setDrawingEdge((prev) => prev ? { ...prev, x2: world.x, y2: world.y } : null);
      }
    },
    [isPanning, marquee, resizing, draggingNode, drawingEdge, nodes, onNodesChange, screenToWorld, zoom],
  );

  const handleMouseUp = useCallback(() => {
    if (marquee) {
      const left = Math.min(marquee.startX, marquee.currentX);
      const top = Math.min(marquee.startY, marquee.currentY);
      const right = Math.max(marquee.startX, marquee.currentX);
      const bottom = Math.max(marquee.startY, marquee.currentY);
      const w = right - left;
      const h = bottom - top;

      if (w > 3 || h > 3) {
        const worldLeft = (left - pan.x) / zoom;
        const worldTop = (top - pan.y) / zoom;
        const worldRight = (right - pan.x) / zoom;
        const worldBottom = (bottom - pan.y) / zoom;

        const hit = nodes.find((n) => {
          const nw = getNodeWidth(n);
          const nh = (n.config._height as number) || 160;
          return n.position.x < worldRight && n.position.x + nw > worldLeft && n.position.y < worldBottom && n.position.y + nh > worldTop;
        });
        if (hit) onSelectNode(hit.id);
        didMarquee.current = true;
      }
      setMarquee(null);
    }
    setIsPanning(false);
    setDraggingNode(null);
    setResizing(null);
    if (drawingEdge) setDrawingEdge(null);
  }, [drawingEdge, marquee, pan, zoom, nodes, onSelectNode]);

  const EDGE_PAN_ZONE = 40;
  const EDGE_PAN_MAX_SPEED = 16;

  useEffect(() => {
    if (!marquee) {
      if (edgePanFrame.current !== null) {
        cancelAnimationFrame(edgePanFrame.current);
        edgePanFrame.current = null;
      }
      return;
    }
    const getOverlayInsets = (canvasRect: DOMRect) => {
      let rightInset = 0;
      let bottomInset = 0;
      let leftInset = 0;
      let topInset = 0;
      document.querySelectorAll(".rpanel, .gen-tray, .node-inspector").forEach((panel) => {
        const pr = (panel as HTMLElement).getBoundingClientRect();
        if (pr.width === 0 || pr.height === 0) return;
        if (pr.left < canvasRect.right && pr.right > canvasRect.left && pr.top < canvasRect.bottom && pr.bottom > canvasRect.top) {
          if (pr.right >= canvasRect.right - 1) rightInset = Math.max(rightInset, canvasRect.right - pr.left);
          if (pr.left <= canvasRect.left + 1) leftInset = Math.max(leftInset, pr.right - canvasRect.left);
          if (pr.bottom >= canvasRect.bottom - 1) bottomInset = Math.max(bottomInset, canvasRect.bottom - pr.top);
          if (pr.top <= canvasRect.top + 1) topInset = Math.max(topInset, pr.bottom - canvasRect.top);
        }
      });
      return { leftInset, rightInset, topInset, bottomInset };
    };
    const tick = () => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const { leftInset, rightInset, topInset, bottomInset } = getOverlayInsets(rect);
      const mx = marqueeMousePos.current.x;
      const my = marqueeMousePos.current.y;
      const effectiveLeft = leftInset;
      const effectiveRight = rect.width - rightInset;
      const effectiveTop = topInset;
      const effectiveBottom = rect.height - bottomInset;

      let dx = 0;
      let dy = 0;
      if (mx < effectiveLeft + EDGE_PAN_ZONE && mx > effectiveLeft) dx = EDGE_PAN_MAX_SPEED * ((effectiveLeft + EDGE_PAN_ZONE - mx) / EDGE_PAN_ZONE);
      else if (mx > effectiveRight - EDGE_PAN_ZONE && mx < effectiveRight) dx = -EDGE_PAN_MAX_SPEED * ((mx - (effectiveRight - EDGE_PAN_ZONE)) / EDGE_PAN_ZONE);
      if (my < effectiveTop + EDGE_PAN_ZONE && my > effectiveTop) dy = EDGE_PAN_MAX_SPEED * ((effectiveTop + EDGE_PAN_ZONE - my) / EDGE_PAN_ZONE);
      else if (my > effectiveBottom - EDGE_PAN_ZONE && my < effectiveBottom) dy = -EDGE_PAN_MAX_SPEED * ((my - (effectiveBottom - EDGE_PAN_ZONE)) / EDGE_PAN_ZONE);

      if (dx !== 0 || dy !== 0) {
        setPan((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
        setMarquee((prev) => prev ? { ...prev, startX: prev.startX + dx, startY: prev.startY + dy } : null);
      }
      edgePanFrame.current = requestAnimationFrame(tick);
    };
    edgePanFrame.current = requestAnimationFrame(tick);
    return () => {
      if (edgePanFrame.current !== null) {
        cancelAnimationFrame(edgePanFrame.current);
        edgePanFrame.current = null;
      }
    };
  }, [marquee !== null]);

  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  const handleWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      const isZoomGesture = e.ctrlKey || e.metaKey;
      if (isZoomGesture && e.deltaY !== 0) {
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const currentZoom = zoomRef.current;
        const delta = -e.deltaY * 0.008;
        const newZoom = Math.min(3, Math.max(0.15, currentZoom * (1 + delta)));
        const scale = newZoom / currentZoom;
        setPan((prev) => ({
          x: mx - (mx - prev.x) * scale,
          y: my - (my - prev.y) * scale,
        }));
        setZoom(newZoom);
      } else {
        setPan((prev) => ({
          x: prev.x - e.deltaX,
          y: prev.y - e.deltaY,
        }));
      }
    },
    [],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [handleWheel]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === " " || e.code === "Space") {
        if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target instanceof HTMLElement && e.target.isContentEditable))) {
          e.preventDefault();
          spaceDown.current = true;
        }
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === " " || e.code === "Space") {
        spaceDown.current = false;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

  const startNodeDrag = useCallback(
    (nodeId: string, e: RME) => {
      e.stopPropagation();
      const node = nodes.find((n) => n.id === nodeId);
      if (!node) return;
      const world = screenToWorld(e.clientX, e.clientY);
      dragOffset.current = { x: world.x - node.position.x, y: world.y - node.position.y };
      setDraggingNode(nodeId);
      onSelectNode(nodeId);
      setCtxMenu(null);
    },
    [nodes, onSelectNode, screenToWorld],
  );

  const startEdgeDraw = useCallback(
    (nodeId: string, portId: string, portType: PortType, e: RME) => {
      e.stopPropagation();
      const node = nodes.find((n) => n.id === nodeId);
      if (!node) return;
      const pos = getPortPos(node, portId, "output");
      setDrawingEdge({
        sourceNode: nodeId,
        sourcePort: portId,
        sourceType: portType,
        x1: pos.x,
        y1: pos.y,
        x2: pos.x,
        y2: pos.y,
      });
    },
    [nodes],
  );

  const handlePortDrop = useCallback(
    (targetNodeId: string, targetPortId: string, targetType: PortType) => {
      if (!drawingEdge) return;
      if (drawingEdge.sourceNode === targetNodeId) return;
      if (drawingEdge.sourceType !== targetType) return;

      const exists = edges.some(
        (e) => e.targetNode === targetNodeId && e.targetPort === targetPortId,
      );
      if (exists) return;

      const newEdge: WorkflowEdge = {
        id: `e-${Date.now()}`,
        sourceNode: drawingEdge.sourceNode,
        sourcePort: drawingEdge.sourcePort,
        targetNode: targetNodeId,
        targetPort: targetPortId,
      };
      onEdgesChange([...edges, newEdge]);
      setDrawingEdge(null);
    },
    [drawingEdge, edges, onEdgesChange],
  );

  const handleContextMenu = useCallback(
    (e: RME) => {
      e.preventDefault();
      const world = screenToWorld(e.clientX, e.clientY);
      setCtxMenu({ x: e.clientX, y: e.clientY, worldX: world.x, worldY: world.y });
    },
    [screenToWorld],
  );

  const addNodeFromCtx = useCallback(
    (type: NodeType) => {
      if (!ctxMenu) return;
      const node = createNode(type, ctxMenu.worldX, ctxMenu.worldY);
      if (type === "image" || type === "video") node.config._width = 260;
      onNodesChange([...nodes, node]);
      onSelectNode(node.id);
      setCtxMenu(null);
    },
    [ctxMenu, nodes, onNodesChange, onSelectNode],
  );

  const startResize = useCallback(
    (nodeId: string, corner: string, e: RME) => {
      e.stopPropagation();
      e.preventDefault();
      const node = nodes.find((n) => n.id === nodeId);
      if (!node) return;
      resizeStart.current = {
        mx: e.clientX,
        my: e.clientY,
        w: (node.config._width as number) || 220,
        h: (node.config._height as number) || 160,
        nx: node.position.x,
        ny: node.position.y,
      };
      setResizing({ nodeId, corner });
    },
    [nodes],
  );

  const triggerImageUpload = useCallback(
    (nodeId: string) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          onNodesChange(
            nodes.map((n) =>
              n.id === nodeId
                ? { ...n, config: { ...n.config, imageUrl: dataUrl } }
                : n,
            ),
          );
        };
        reader.readAsDataURL(file);
      };
      input.click();
    },
    [nodes, onNodesChange],
  );

  const handleCanvasClick = useCallback(
    (e: RME) => {
      if (didMarquee.current) {
        didMarquee.current = false;
        return;
      }
      const target = e.target as HTMLElement;
      const isBackground = target === e.currentTarget || target.classList.contains("nc-world") || (target.closest(".nc") === containerRef.current && !target.closest(".nc-node, .nc-ctx, .nc-port, .nc-resize, .nc-edge-group"));
      if (isBackground) {
        onSelectNode(null);
        setCtxMenu(null);
      }
    },
    [onSelectNode],
  );

  const handleEdgeClick = useCallback(
    (edgeId: string, e: RME) => {
      e.stopPropagation();
      onEdgesChange(edges.filter((ed) => ed.id !== edgeId));
    },
    [edges, onEdgesChange],
  );

  const updateNodeConfig = useCallback(
    (nodeId: string, patch: Record<string, unknown>) => {
      onNodesChange(nodes.map((n) => n.id === nodeId ? { ...n, config: { ...n.config, ...patch } } : n));
    },
    [nodes, onNodesChange],
  );

  return (
    <div
      ref={containerRef}
      className={`nc${isPanning ? " nc--panning" : ""}${marquee ? " nc--selecting" : ""}${fileDragOver ? " nc--drag-over" : ""}`}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onContextMenu={handleContextMenu}
      onClick={handleCanvasClick}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {marquee && (() => {
        const left = Math.min(marquee.startX, marquee.currentX);
        const top = Math.min(marquee.startY, marquee.currentY);
        const w = Math.abs(marquee.currentX - marquee.startX);
        const h = Math.abs(marquee.currentY - marquee.startY);
        return (
          <div className="nc__marquee" style={{ left, top, width: w, height: h }} />
        );
      })()}
      <div
        className="nc-world"
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: "0 0",
        }}
      >
        <svg className="nc-edges">
          {edges.map((edge) => {
            const srcNode = nodes.find((n) => n.id === edge.sourceNode);
            const tgtNode = nodes.find((n) => n.id === edge.targetNode);
            if (!srcNode || !tgtNode) return null;
            const src = getPortPos(srcNode, edge.sourcePort, "output");
            const tgt = getPortPos(tgtNode, edge.targetPort, "input");
            const srcPort = srcNode.outputs.find((p) => p.id === edge.sourcePort);
            const color = srcPort ? PORT_COLORS[srcPort.type] : "#555";
            return (
              <g key={edge.id} onClick={(e) => handleEdgeClick(edge.id, e)} className="nc-edge-group">
                <path d={bezierPath(src.x, src.y, tgt.x, tgt.y)} className="nc-edge-hit" />
                <path d={bezierPath(src.x, src.y, tgt.x, tgt.y)} className="nc-edge" stroke={color} />
              </g>
            );
          })}
          {drawingEdge && (
            <path
              d={bezierPath(drawingEdge.x1, drawingEdge.y1, drawingEdge.x2, drawingEdge.y2)}
              className="nc-edge nc-edge--drawing"
              stroke={PORT_COLORS[drawingEdge.sourceType]}
            />
          )}
        </svg>

        {/* Nodes */}
        {nodes.map((node) => {
          const isSelected = node.id === selectedNodeId;
          const isImage = node.type === "image";
          const isVideo = node.type === "video";
          const isText = node.type === "text";
          const isAxiom = node.type === "axiom";
          const isStyle = node.type === "style";
          const nodeW = getNodeWidth(node);
          const imageUrl = node.config.imageUrl as string | undefined;

          const hasPromptInput = isImage || isVideo;
          const connectedPrompt = hasPromptInput ? getConnectedValue(node.id, "prompt", nodes, edges) : null;
          const promptConnected = connectedPrompt !== null;
          const displayPrompt = promptConnected ? connectedPrompt : (node.config.prompt as string) || "";

          return (
            <div
              key={node.id}
              className={`nc-node ${isSelected ? "nc-node--selected" : ""}${isImage ? " nc-node--image" : ""}${isVideo ? " nc-node--video" : ""}${isText ? " nc-node--text" : ""}${isAxiom ? " nc-node--axiom" : ""}${isStyle ? " nc-node--style" : ""}`}
              style={{ left: node.position.x, top: node.position.y, width: nodeW }}
              onMouseDown={(e) => startNodeDrag(node.id, e)}
            >
              <div className="nc-node-header">
                <span className="nc-node-icon">{NODE_TYPE_ICONS[node.type]}</span>
                <span className="nc-node-label">{node.label}</span>
              </div>

              {/* --- Text node body --- */}
              {isText && (
                <div className="nc-text-body" onMouseDown={(e) => e.stopPropagation()}>
                  <textarea
                    className="nc-text-input"
                    placeholder="Enter text..."
                    value={(node.config.value as string) || ""}
                    onChange={(e) => updateNodeConfig(node.id, { value: e.target.value })}
                  />
                </div>
              )}

              {/* --- Image node body --- */}
              {isImage && (
                <div className="nc-media-body">
                  <div
                    className="nc-media-preview"
                    onClick={(e) => { e.stopPropagation(); if (!imageUrl) triggerImageUpload(node.id); }}
                  >
                    {imageUrl ? (
                      <img src={imageUrl} alt="" className="nc-media-img" draggable={false} />
                    ) : (
                      <div className="nc-media-placeholder">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></svg>
                        <span>Drop or click to upload</span>
                      </div>
                    )}
                  </div>
                  <div className="nc-media-prompt" onMouseDown={(e) => e.stopPropagation()}>
                    <textarea
                      className="nc-media-prompt-input"
                      placeholder={promptConnected ? "Inherited from connected node" : "Enter prompt..."}
                      value={displayPrompt}
                      readOnly={promptConnected}
                      onChange={(e) => updateNodeConfig(node.id, { prompt: e.target.value })}
                    />
                    {promptConnected && <div className="nc-media-prompt-hint">Connected</div>}
                  </div>
                </div>
              )}

              {/* --- Video node body --- */}
              {isVideo && (
                <div className="nc-media-body">
                  <div className="nc-media-preview nc-media-preview--video">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" /></svg>
                    <span>Video output</span>
                  </div>
                  <div className="nc-media-prompt" onMouseDown={(e) => e.stopPropagation()}>
                    <textarea
                      className="nc-media-prompt-input"
                      placeholder={promptConnected ? "Inherited from connected node" : "Enter prompt..."}
                      value={displayPrompt}
                      readOnly={promptConnected}
                      onChange={(e) => updateNodeConfig(node.id, { prompt: e.target.value })}
                    />
                    {promptConnected && <div className="nc-media-prompt-hint">Connected</div>}
                  </div>
                </div>
              )}

              {/* --- Axiom body --- */}
              {isAxiom && (
                <div className="nc-axiom-body">
                  <div className="nc-axiom-grid">
                    {[0, 1, 2, 3].map((i) => (
                      <div key={i} className="nc-axiom-cell" style={{ background: (node.config.axiomThumb as string) || "#1a1a2e" }} />
                    ))}
                  </div>
                  {typeof node.config.axiomBucket === "string" && node.config.axiomBucket && (
                    <div className="nc-axiom-meta">{node.config.axiomBucket}</div>
                  )}
                </div>
              )}

              {/* --- Style body --- */}
              {isStyle && (
                <div className="nc-style-body">
                  {typeof node.config.styleImage === "string" && node.config.styleImage && (
                    <div className="nc-style-preview" style={{ background: node.config.styleImage }} />
                  )}
                  <div className="nc-style-prompt">{(node.config.stylePrompt as string) || "No prompt"}</div>
                  {typeof node.config.styleBucket === "string" && node.config.styleBucket && (
                    <div className="nc-axiom-meta">{node.config.styleBucket}</div>
                  )}
                </div>
              )}

              {/* Ports */}
              {node.inputs.length > 0 && (
                <div className="nc-node-ports nc-node-ports--in">
                  {node.inputs.map((port) => (
                    <div
                      key={port.id}
                      className="nc-port nc-port--in"
                      onMouseUp={() => handlePortDrop(node.id, port.id, port.type)}
                    >
                      <span className="nc-port-dot" style={{ background: PORT_COLORS[port.type] }} />
                      <span className="nc-port-label">{port.label}</span>
                    </div>
                  ))}
                </div>
              )}
              {node.outputs.length > 0 && (
                <div className="nc-node-ports nc-node-ports--out">
                  {node.outputs.map((port) => (
                    <div
                      key={port.id}
                      className="nc-port nc-port--out"
                      onMouseDown={(e) => { e.stopPropagation(); startEdgeDraw(node.id, port.id, port.type, e); }}
                    >
                      <span className="nc-port-label">{port.label}</span>
                      <span className="nc-port-dot" style={{ background: PORT_COLORS[port.type] }} />
                    </div>
                  ))}
                </div>
              )}

              {/* Resize handles for image/video nodes */}
              {(isImage || isVideo) && isSelected && (
                <>
                  <div className="nc-resize nc-resize--se" onMouseDown={(e) => startResize(node.id, "se", e)} />
                  <div className="nc-resize nc-resize--sw" onMouseDown={(e) => startResize(node.id, "sw", e)} />
                  <div className="nc-resize nc-resize--ne" onMouseDown={(e) => startResize(node.id, "ne", e)} />
                  <div className="nc-resize nc-resize--nw" onMouseDown={(e) => startResize(node.id, "nw", e)} />
                </>
              )}
            </div>
          );
        })}
      </div>

      <div className="nc-zoom">{Math.round(zoom * 100)}%</div>

      {ctxMenu && (
        <div
          className="nc-ctx"
          style={{ left: ctxMenu.x, top: ctxMenu.y, position: "fixed" }}
        >
          <div className="nc-ctx-title">Add Node</div>
          {CONTEXT_NODE_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              className="nc-ctx-item"
              onClick={() => addNodeFromCtx(type)}
            >
              <span className="nc-ctx-icon">{NODE_TYPE_ICONS[type]}</span>
              {NODE_SCHEMAS[type].label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
