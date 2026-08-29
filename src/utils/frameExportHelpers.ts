import type { CanvasNode } from "../types/canvas";
import { isGradientFill, parseGradientFill } from "./gradientUtils";
import { buildDWithRadius } from "./svgPathModel";
import type { PathData } from "./svgPathModel";

export function isImageDrawable(img: HTMLImageElement): boolean {
  try {
    const probe = document.createElement("canvas");
    probe.width = 1;
    probe.height = 1;
    const ctx = probe.getContext("2d");
    if (!ctx) return false;
    ctx.drawImage(img, 0, 0, 1, 1);
    ctx.getImageData(0, 0, 1, 1);
    return true;
  } catch {
    return false;
  }
}

export function toProxiedUrl(src: string): string {
  if (src.startsWith("http://") || src.startsWith("https://")) {
    return `/api/media-proxy?url=${encodeURIComponent(src)}`;
  }
  return src;
}

export async function loadImageSrc(src: string, label?: string): Promise<CanvasImageSource | null> {
  const fetchSrc = toProxiedUrl(src);
  try {
    const response = await fetch(fetchSrc, { mode: "cors", credentials: "omit" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const img = await new Promise<HTMLImageElement | null>((resolve) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        resolve(null);
      };
      el.src = objectUrl;
    });
    if (img) {
      URL.revokeObjectURL(objectUrl);
      return img;
    }
  } catch {
    console.warn(`[frameExport] Failed to load image via fetch (will try fallback): ${label ?? src}`);
  }

  return new Promise<CanvasImageSource | null>((resolve) => {
    const img = new Image();
    img.onload = () => {
      if (isImageDrawable(img)) {
        resolve(img);
      } else {
        console.warn(`[frameExport] Image is cross-origin tainted, skipping node: ${label ?? src}`);
        resolve(null);
      }
    };
    img.onerror = () => {
      console.warn(`[frameExport] Could not load image, skipping node: ${label ?? src}`);
      resolve(null);
    };
    img.src = fetchSrc;
  });
}

export function findOverlappingNodes(frameNode: CanvasNode, allNodes: CanvasNode[]): CanvasNode[] {
  return allNodes.filter((n) => {
    if (n.id === frameNode.id || n.node_type === "group" || n.node_type === "frame" || n.visible === false) return false;
    return (
      n.x < frameNode.x + frameNode.width &&
      n.x + n.width > frameNode.x &&
      n.y < frameNode.y + frameNode.height &&
      n.y + n.height > frameNode.y
    );
  }).sort((a, b) => a.z_index - b.z_index);
}

export function findOverlappingVideoNodes(frameNode: CanvasNode, allNodes: CanvasNode[]): CanvasNode[] {
  return findOverlappingNodes(frameNode, allNodes).filter((n) => n.node_type === "video" && !!n.src);
}

export function setupFrameCanvas(frameNode: CanvasNode, allNodes: CanvasNode[]): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  overlapping: CanvasNode[];
} | null {
  const nativeW = Math.max(1, Math.round(frameNode.width));
  const nativeH = Math.max(1, Math.round(frameNode.height));
  const rawFill = (frameNode.metadata?.fill as string) || "#333333";
  const canvas = document.createElement("canvas");
  canvas.width = nativeW;
  canvas.height = nativeH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  if (isGradientFill(rawFill)) {
    const gd = parseGradientFill(rawFill);
    if (gd) {
      const grad = ctx.createLinearGradient(gd.x1 * nativeW, gd.y1 * nativeH, gd.x2 * nativeW, gd.y2 * nativeH);
      grad.addColorStop(0, gd.color1);
      grad.addColorStop(1, gd.color2);
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = "#333333";
    }
  } else {
    ctx.fillStyle = rawFill;
  }
  ctx.fillRect(0, 0, nativeW, nativeH);

  return { canvas, ctx, overlapping: findOverlappingNodes(frameNode, allNodes) };
}

export function createDrawNode(frameNode: CanvasNode, canvas: HTMLCanvasElement) {
  const nativeW = canvas.width;
  const nativeH = canvas.height;
  const scaleX = nativeW / frameNode.width;
  const scaleY = nativeH / frameNode.height;

  const drawText = (ct: CanvasRenderingContext2D, nd: CanvasNode, ox: number, oy: number, w: number, h: number) => {
    const meta = nd.metadata as Record<string, unknown>;
    const fontFamily = (meta?.fontFamily as string) || "Inter, sans-serif";
    const fontWeight = (meta?.fontWeight as number) || 400;
    const rawFontSize = (meta?.fontSize as number) || 24;
    const fontSize = rawFontSize * scaleX;
    const color = (meta?.color as string) || "#ffffff";
    const textAlign = (meta?.textAlign as string) || "left";
    const textContent = (meta?.textContent as string) || "";
    const padding = 4 * scaleX;
    const lineHeight = fontSize * 1.3;

    ct.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
    ct.fillStyle = color;
    ct.textBaseline = "top";
    ct.textAlign = textAlign as CanvasTextAlign;

    const maxW = w - padding * 2;
    const paragraphs = textContent.split("\n");
    const lines: string[] = [];
    for (const para of paragraphs) {
      if (para.length === 0) { lines.push(""); continue; }
      const words = para.split(/(\s+)/);
      let currentLine = "";
      for (const word of words) {
        const testLine = currentLine + word;
        if (ct.measureText(testLine).width > maxW && currentLine.length > 0) {
          lines.push(currentLine);
          currentLine = word.trimStart();
        } else {
          currentLine = testLine;
        }
      }
      if (currentLine.length > 0) {
        let remaining = currentLine;
        while (ct.measureText(remaining).width > maxW && remaining.length > 1) {
          let breakAt = remaining.length;
          for (let ci = 1; ci < remaining.length; ci++) {
            if (ct.measureText(remaining.slice(0, ci + 1)).width > maxW) { breakAt = ci; break; }
          }
          lines.push(remaining.slice(0, breakAt));
          remaining = remaining.slice(breakAt);
        }
        lines.push(remaining);
      }
    }

    let alignX = ox + padding;
    if (textAlign === "center") alignX = ox + w / 2;
    else if (textAlign === "right") alignX = ox + w - padding;

    for (let i = 0; i < lines.length; i++) {
      const ly = oy + padding + i * lineHeight;
      if (ly >= oy + h) break;
      ct.fillText(lines[i], alignX, ly, maxW);
    }
  };

  const drawShape = (ct: CanvasRenderingContext2D, nd: CanvasNode, ox: number, oy: number, w: number, h: number) => {
    const meta = nd.metadata as Record<string, unknown>;
    const shapeKind = (meta?.shapeKind as string) || "rectangle";
    const rawShapeFill = (meta?.fill as string) || "#5b5fc7";
    const stroke = (meta?.stroke as string) || "none";
    const strokeWidth = ((meta?.strokeWidth as number) || 0) * scaleX;
    const br = ((meta?.borderRadius as number) || 0) * scaleX;

    if (isGradientFill(rawShapeFill)) {
      const gd = parseGradientFill(rawShapeFill);
      if (gd) {
        const grad = ct.createLinearGradient(ox + gd.x1 * w, oy + gd.y1 * h, ox + gd.x2 * w, oy + gd.y2 * h);
        grad.addColorStop(0, gd.color1);
        grad.addColorStop(1, gd.color2);
        ct.fillStyle = grad;
      } else {
        ct.fillStyle = rawShapeFill;
      }
    } else {
      ct.fillStyle = rawShapeFill;
    }
    if (stroke && stroke !== "none") {
      if (isGradientFill(stroke)) {
        const sgd = parseGradientFill(stroke);
        if (sgd) {
          const sGrad = ct.createLinearGradient(ox + sgd.x1 * w, oy + sgd.y1 * h, ox + sgd.x2 * w, oy + sgd.y2 * h);
          sGrad.addColorStop(0, sgd.color1);
          sGrad.addColorStop(1, sgd.color2);
          ct.strokeStyle = sGrad;
        } else {
          ct.strokeStyle = stroke;
        }
      } else {
        ct.strokeStyle = stroke;
      }
      ct.lineWidth = strokeWidth;
    }

    if (shapeKind === "ellipse") {
      ct.beginPath();
      ct.ellipse(ox + w / 2, oy + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      ct.fill();
      if (stroke && stroke !== "none" && strokeWidth > 0) ct.stroke();
    } else if (shapeKind === "triangle") {
      ct.beginPath(); ct.moveTo(ox + w / 2, oy); ct.lineTo(ox + w, oy + h); ct.lineTo(ox, oy + h); ct.closePath(); ct.fill();
      if (stroke && stroke !== "none" && strokeWidth > 0) ct.stroke();
    } else if (shapeKind === "diamond") {
      ct.beginPath(); ct.moveTo(ox + w / 2, oy); ct.lineTo(ox + w, oy + h / 2); ct.lineTo(ox + w / 2, oy + h); ct.lineTo(ox, oy + h / 2); ct.closePath(); ct.fill();
      if (stroke && stroke !== "none" && strokeWidth > 0) ct.stroke();
    } else if (shapeKind === "line") {
      const dir = (meta?.lineDirection as string) || "down";
      const lineStroke = stroke && stroke !== "none" ? stroke : "#ffffff";
      const lineSW = strokeWidth > 0 ? strokeWidth : 2 * scaleX;
      if (isGradientFill(lineStroke)) {
        const lsgd = parseGradientFill(lineStroke);
        if (lsgd) {
          const lsGrad = ct.createLinearGradient(ox + lsgd.x1 * w, oy + lsgd.y1 * h, ox + lsgd.x2 * w, oy + lsgd.y2 * h);
          lsGrad.addColorStop(0, lsgd.color1);
          lsGrad.addColorStop(1, lsgd.color2);
          ct.strokeStyle = lsGrad;
        } else {
          ct.strokeStyle = lineStroke;
        }
      } else {
        ct.strokeStyle = lineStroke;
      }
      ct.lineWidth = lineSW;
      ct.beginPath(); ct.moveTo(ox, dir === "down" ? oy : oy + h); ct.lineTo(ox + w, dir === "down" ? oy + h : oy); ct.stroke();
    } else {
      if (br > 0) {
        ct.beginPath(); ct.moveTo(ox + br, oy); ct.lineTo(ox + w - br, oy);
        ct.quadraticCurveTo(ox + w, oy, ox + w, oy + br); ct.lineTo(ox + w, oy + h - br);
        ct.quadraticCurveTo(ox + w, oy + h, ox + w - br, oy + h); ct.lineTo(ox + br, oy + h);
        ct.quadraticCurveTo(ox, oy + h, ox, oy + h - br); ct.lineTo(ox, oy + br);
        ct.quadraticCurveTo(ox, oy, ox + br, oy); ct.closePath(); ct.fill();
        if (stroke && stroke !== "none" && strokeWidth > 0) ct.stroke();
      } else {
        ct.fillRect(ox, oy, w, h);
        if (stroke && stroke !== "none" && strokeWidth > 0) ct.strokeRect(ox, oy, w, h);
      }
    }
  };

  const drawSvgPath = (ct: CanvasRenderingContext2D, nd: CanvasNode, ox: number, oy: number, w: number, h: number) => {
    const pd = nd.metadata?.pathData as PathData | undefined;
    if (!pd) return;

    let vbW = 0;
    let vbH = 0;
    for (const sp of pd.subPaths) {
      for (const a of sp.anchors) {
        if (a.x > vbW) vbW = a.x;
        if (a.y > vbH) vbH = a.y;
        if (a.handleIn) { if (a.handleIn.x > vbW) vbW = a.handleIn.x; if (a.handleIn.y > vbH) vbH = a.handleIn.y; }
        if (a.handleOut) { if (a.handleOut.x > vbW) vbW = a.handleOut.x; if (a.handleOut.y > vbH) vbH = a.handleOut.y; }
      }
    }
    vbW = vbW || nd.width;
    vbH = vbH || nd.height;

    const pathScaleX = w / vbW;
    const pathScaleY = h / vbH;

    ct.save();
    ct.translate(ox, oy);
    ct.scale(pathScaleX, pathScaleY);

    const dStr = buildDWithRadius(pd);
    const path2d = new Path2D(dStr);

    const fill = pd.fill;
    const stroke = pd.stroke;
    const strokeWidth = pd.strokeWidth ?? 0;
    const fillOpacity = pd.fillOpacity ?? pd.opacity ?? 1;
    const strokeOpacity = pd.strokeOpacity ?? 1;
    const fillRule = pd.fillRule || "nonzero";

    if (fill && fill !== "none") {
      ct.globalAlpha = fillOpacity;
      ct.fillStyle = fill;
      ct.fill(path2d, fillRule);
    }
    if (stroke && stroke !== "none" && strokeWidth > 0) {
      ct.globalAlpha = strokeOpacity;
      ct.strokeStyle = stroke;
      ct.lineWidth = strokeWidth;
      ct.stroke(path2d);
    }

    ct.restore();
  };

  const drawImageCover = (ct: CanvasRenderingContext2D, img: CanvasImageSource, ox: number, oy: number, dw: number, dh: number) => {
    let imgW = 0; let imgH = 0;
    if (img instanceof HTMLImageElement) { imgW = img.naturalWidth; imgH = img.naturalHeight; }
    else if (img instanceof HTMLVideoElement) { imgW = img.videoWidth; imgH = img.videoHeight; }
    if (imgW > 0 && imgH > 0) {
      const imgAspect = imgW / imgH; const destAspect = dw / dh;
      let sx = 0, sy = 0, sw = imgW, sh = imgH;
      if (imgAspect > destAspect) { sw = imgH * destAspect; sx = (imgW - sw) / 2; }
      else { sh = imgW / destAspect; sy = (imgH - sh) / 2; }
      ct.drawImage(img, sx, sy, sw, sh, ox, oy, dw, dh);
    } else { ct.drawImage(img, ox, oy, dw, dh); }
  };

  return (ct: CanvasRenderingContext2D, nd: CanvasNode, drawable: CanvasImageSource | null) => {
    const dx = (nd.x - frameNode.x) * scaleX;
    const dy = (nd.y - frameNode.y) * scaleY;
    const dw = nd.width * scaleX;
    const dh = nd.height * scaleY;
    ct.save();
    const nodeOpacity = Math.max(0, Math.min(1, ((nd.metadata as Record<string, unknown>)?.opacity as number ?? 100) / 100));
    if (nodeOpacity < 1) ct.globalAlpha = nodeOpacity;
    if (nd.rotation) {
      ct.translate(dx + dw / 2, dy + dh / 2);
      ct.rotate((nd.rotation * Math.PI) / 180);
      const ox = -dw / 2; const oy = -dh / 2;
      if (drawable) drawImageCover(ct, drawable, ox, oy, dw, dh);
      else if (nd.node_type === "svg" && nd.metadata?.pathData) drawSvgPath(ct, nd, ox, oy, dw, dh);
      else if (nd.node_type === "text") drawText(ct, nd, ox, oy, dw, dh);
      else if (nd.node_type === "shape") drawShape(ct, nd, ox, oy, dw, dh);
      else if (nd.gradient) { ct.fillStyle = nd.gradient; ct.fillRect(ox, oy, dw, dh); }
    } else {
      if (drawable) drawImageCover(ct, drawable, dx, dy, dw, dh);
      else if (nd.node_type === "svg" && nd.metadata?.pathData) drawSvgPath(ct, nd, dx, dy, dw, dh);
      else if (nd.node_type === "text") drawText(ct, nd, dx, dy, dw, dh);
      else if (nd.node_type === "shape") drawShape(ct, nd, dx, dy, dw, dh);
      else if (nd.gradient) { ct.fillStyle = nd.gradient; ct.fillRect(dx, dy, dw, dh); }
    }
    ct.restore();
  };
}

async function preloadFonts(textNodes: CanvasNode[]): Promise<void> {
  const fontLoadPromises: Promise<FontFace[]>[] = [];
  const seen = new Set<string>();
  for (const n of textNodes) {
    const meta = n.metadata as Record<string, unknown> | undefined;
    const fontFamily = (meta?.fontFamily as string) || "Inter, sans-serif";
    const fontWeight = (meta?.fontWeight as number) || 400;
    const fontSize = (meta?.fontSize as number) || 24;
    const key = `${fontWeight} ${fontSize}px ${fontFamily}`;
    if (!seen.has(key)) {
      seen.add(key);
      fontLoadPromises.push(document.fonts.load(key));
    }
  }
  await Promise.all(fontLoadPromises);
  await document.fonts.ready;
}

async function loadDrawables(
  nodes: CanvasNode[]
): Promise<Map<string, CanvasImageSource>> {
  const drawableMap = new Map<string, CanvasImageSource>();
  const nodesWithSrc = nodes.filter((n) => {
    if (n.node_type === "svg" && (n.metadata?.pathData)) return false;
    return !!n.src;
  });
  if (nodesWithSrc.length === 0) return drawableMap;

  await new Promise<void>((resolve) => {
    let loaded = 0;
    const done = () => {
      loaded++;
      if (loaded === nodesWithSrc.length) resolve();
    };
    nodesWithSrc.forEach((n) => {
      if (n.node_type === "video") {
        const video = document.createElement("video");
        video.crossOrigin = "anonymous";
        video.muted = true;
        video.preload = "auto";
        video.onloadeddata = () => { video.currentTime = 0; };
        video.onseeked = () => {
          drawableMap.set(n.id, video);
          done();
        };
        video.onerror = () => {
          console.warn(`[frameExport] Could not load video node: ${n.label ?? n.id}`);
          done();
        };
        video.src = n.src;
      } else {
        loadImageSrc(n.src, n.label ?? n.id).then((img) => {
          if (img) drawableMap.set(n.id, img);
          done();
        });
      }
    });
  });

  return drawableMap;
}

export async function renderFrameCanvas(
  frameNode: CanvasNode,
  allNodes: CanvasNode[]
): Promise<HTMLCanvasElement | null> {
  const result = setupFrameCanvas(frameNode, allNodes);
  if (!result) return null;
  const { canvas, ctx, overlapping } = result;

  await preloadFonts(overlapping.filter((n) => n.node_type === "text"));

  if (overlapping.length === 0) return canvas;

  const drawNode = createDrawNode(frameNode, canvas);
  const drawableMap = await loadDrawables(overlapping);
  overlapping.forEach((nd) => drawNode(ctx, nd, drawableMap.get(nd.id) || null));
  return canvas;
}

export async function renderOverlayCanvas(
  frameNode: CanvasNode,
  allNodes: CanvasNode[],
  outputW: number,
  outputH: number
): Promise<HTMLCanvasElement | null> {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(outputW));
  canvas.height = Math.max(1, Math.round(outputH));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const overlapping = findOverlappingNodes(frameNode, allNodes).filter((n) => n.node_type !== "video");

  await preloadFonts(overlapping.filter((n) => n.node_type === "text"));

  if (overlapping.length === 0) return canvas;

  const drawNode = createDrawNode(frameNode, canvas);
  const drawableMap = await loadDrawables(overlapping);
  overlapping.forEach((nd) => drawNode(ctx, nd, drawableMap.get(nd.id) || null));
  return canvas;
}
