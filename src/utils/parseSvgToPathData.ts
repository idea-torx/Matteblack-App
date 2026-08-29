import { parseDAttribute, commandsToSubPaths } from "./svgPathModel";
import type { PathData, SubPath } from "./svgPathModel";

type Matrix = [number, number, number, number, number, number];

function identityMatrix(): Matrix {
  return [1, 0, 0, 1, 0, 0];
}

function multiplyMatrix(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function applyMatrix(m: Matrix, x: number, y: number): { x: number; y: number } {
  return {
    x: m[0] * x + m[2] * y + m[4],
    y: m[1] * x + m[3] * y + m[5],
  };
}

function parseTransform(transformStr: string): Matrix {
  let result = identityMatrix();
  const re = /(\w+)\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(transformStr)) !== null) {
    const fn = match[1];
    const args = match[2].trim().split(/[\s,]+/).map(Number);
    let m: Matrix = identityMatrix();
    if (fn === "translate") {
      const tx = args[0] ?? 0;
      const ty = args[1] ?? 0;
      m = [1, 0, 0, 1, tx, ty];
    } else if (fn === "scale") {
      const sx = args[0] ?? 1;
      const sy = args[1] ?? sx;
      m = [sx, 0, 0, sy, 0, 0];
    } else if (fn === "rotate") {
      const deg = ((args[0] ?? 0) * Math.PI) / 180;
      const cx = args[1] ?? 0;
      const cy = args[2] ?? 0;
      const cos = Math.cos(deg);
      const sin = Math.sin(deg);
      const t1: Matrix = [1, 0, 0, 1, cx, cy];
      const rot: Matrix = [cos, sin, -sin, cos, 0, 0];
      const t2: Matrix = [1, 0, 0, 1, -cx, -cy];
      m = multiplyMatrix(t1, multiplyMatrix(rot, t2));
    } else if (fn === "matrix") {
      m = [args[0] ?? 1, args[1] ?? 0, args[2] ?? 0, args[3] ?? 1, args[4] ?? 0, args[5] ?? 0];
    } else if (fn === "skewX") {
      const angle = ((args[0] ?? 0) * Math.PI) / 180;
      m = [1, 0, Math.tan(angle), 1, 0, 0];
    } else if (fn === "skewY") {
      const angle = ((args[0] ?? 0) * Math.PI) / 180;
      m = [1, Math.tan(angle), 0, 1, 0, 0];
    }
    result = multiplyMatrix(result, m);
  }
  return result;
}

function getCumulativeTransform(el: Element): Matrix {
  const matrices: Matrix[] = [];
  let current: Element | null = el;
  while (current && current.tagName !== "svg") {
    const t = current.getAttribute("transform");
    if (t) {
      matrices.unshift(parseTransform(t));
    }
    current = current.parentElement;
  }
  let result = identityMatrix();
  for (const m of matrices) {
    result = multiplyMatrix(result, m);
  }
  return result;
}

function parseStyleAttr(el: Element): Record<string, string> {
  const style = el.getAttribute("style");
  if (!style) return {};
  const result: Record<string, string> = {};
  for (const decl of style.split(";")) {
    const idx = decl.indexOf(":");
    if (idx === -1) continue;
    const prop = decl.slice(0, idx).trim();
    const val = decl.slice(idx + 1).trim();
    if (prop && val) result[prop] = val;
  }
  return result;
}

function getEffectiveAttr(el: Element, attr: string): string | null {
  const style = parseStyleAttr(el);
  if (attr in style) return style[attr];
  return el.getAttribute(attr);
}

function resolveColor(el: Element, attr: "fill" | "stroke"): string | undefined {
  let current: Element | null = el;
  while (current && current.tagName !== "svg") {
    const val = getEffectiveAttr(current, attr);
    if (val !== null && val !== "inherit") return val;
    current = current.parentElement;
  }
  if (current) {
    const val = getEffectiveAttr(current, attr);
    if (val !== null && val !== "inherit") return val;
  }
  return undefined;
}

function resolveStrokeWidth(el: Element): number | undefined {
  let current: Element | null = el;
  while (current && current.tagName !== "svg") {
    const val = getEffectiveAttr(current, "stroke-width");
    if (val !== null) return parseFloat(val);
    current = current.parentElement;
  }
  if (current) {
    const val = getEffectiveAttr(current, "stroke-width");
    if (val !== null) return parseFloat(val);
  }
  return undefined;
}

function rectToD(el: Element): string {
  const x = parseFloat(el.getAttribute("x") || "0");
  const y = parseFloat(el.getAttribute("y") || "0");
  const w = parseFloat(el.getAttribute("width") || "0");
  const h = parseFloat(el.getAttribute("height") || "0");
  const rx = parseFloat(el.getAttribute("rx") || el.getAttribute("ry") || "0");
  const ry = parseFloat(el.getAttribute("ry") || el.getAttribute("rx") || "0");
  if (rx === 0 && ry === 0) {
    return `M${x},${y} L${x + w},${y} L${x + w},${y + h} L${x},${y + h} Z`;
  }
  const rx2 = Math.min(rx, w / 2);
  const ry2 = Math.min(ry, h / 2);
  return (
    `M${x + rx2},${y}` +
    ` L${x + w - rx2},${y}` +
    ` Q${x + w},${y} ${x + w},${y + ry2}` +
    ` L${x + w},${y + h - ry2}` +
    ` Q${x + w},${y + h} ${x + w - rx2},${y + h}` +
    ` L${x + rx2},${y + h}` +
    ` Q${x},${y + h} ${x},${y + h - ry2}` +
    ` L${x},${y + ry2}` +
    ` Q${x},${y} ${x + rx2},${y}` +
    ` Z`
  );
}

function circleToD(el: Element): string {
  const cx = parseFloat(el.getAttribute("cx") || "0");
  const cy = parseFloat(el.getAttribute("cy") || "0");
  const r = parseFloat(el.getAttribute("r") || "0");
  const k = 0.5522847498;
  return (
    `M${cx},${cy - r}` +
    ` C${cx + k * r},${cy - r} ${cx + r},${cy - k * r} ${cx + r},${cy}` +
    ` C${cx + r},${cy + k * r} ${cx + k * r},${cy + r} ${cx},${cy + r}` +
    ` C${cx - k * r},${cy + r} ${cx - r},${cy + k * r} ${cx - r},${cy}` +
    ` C${cx - r},${cy - k * r} ${cx - k * r},${cy - r} ${cx},${cy - r}` +
    ` Z`
  );
}

function ellipseToD(el: Element): string {
  const cx = parseFloat(el.getAttribute("cx") || "0");
  const cy = parseFloat(el.getAttribute("cy") || "0");
  const rx = parseFloat(el.getAttribute("rx") || "0");
  const ry = parseFloat(el.getAttribute("ry") || "0");
  const k = 0.5522847498;
  return (
    `M${cx},${cy - ry}` +
    ` C${cx + k * rx},${cy - ry} ${cx + rx},${cy - k * ry} ${cx + rx},${cy}` +
    ` C${cx + rx},${cy + k * ry} ${cx + k * rx},${cy + ry} ${cx},${cy + ry}` +
    ` C${cx - k * rx},${cy + ry} ${cx - rx},${cy + k * ry} ${cx - rx},${cy}` +
    ` C${cx - rx},${cy - k * ry} ${cx - k * rx},${cy - ry} ${cx},${cy - ry}` +
    ` Z`
  );
}

function polygonToD(el: Element, close: boolean): string {
  const pts = (el.getAttribute("points") || "").trim();
  if (!pts) return "";
  const nums = pts.split(/[\s,]+/).map(Number);
  const parts: string[] = [];
  for (let i = 0; i < nums.length - 1; i += 2) {
    parts.push(`${i === 0 ? "M" : "L"}${nums[i]},${nums[i + 1]}`);
  }
  if (close) parts.push("Z");
  return parts.join(" ");
}

function lineToD(el: Element): string {
  const x1 = el.getAttribute("x1") || "0";
  const y1 = el.getAttribute("y1") || "0";
  const x2 = el.getAttribute("x2") || "0";
  const y2 = el.getAttribute("y2") || "0";
  return `M${x1},${y1} L${x2},${y2}`;
}

const DRAWABLE_TAGS = new Set(["path", "rect", "circle", "ellipse", "polygon", "polyline", "line"]);

function getDrawableElements(root: Element): Element[] {
  const result: Element[] = [];
  function walk(el: Element) {
    const tag = el.tagName.toLowerCase();
    if (DRAWABLE_TAGS.has(tag)) {
      result.push(el);
    } else {
      for (const child of Array.from(el.children)) {
        walk(child);
      }
    }
  }
  for (const child of Array.from(root.children)) {
    walk(child);
  }
  return result;
}

function elementToD(el: Element): string | null {
  const tag = el.tagName.toLowerCase();
  if (tag === "path") {
    return el.getAttribute("d");
  } else if (tag === "rect") {
    return rectToD(el);
  } else if (tag === "circle") {
    return circleToD(el);
  } else if (tag === "ellipse") {
    return ellipseToD(el);
  } else if (tag === "polygon") {
    return polygonToD(el, true);
  } else if (tag === "polyline") {
    return polygonToD(el, false);
  } else if (tag === "line") {
    return lineToD(el);
  }
  return null;
}

export function parseSvgToPathData(
  svgContent: string,
  nodeWidth: number,
  nodeHeight: number
): PathData | null {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgContent, "image/svg+xml");
    const svgEl = doc.querySelector("svg");
    if (!svgEl) return null;

    let vbX = 0, vbY = 0, vbW = nodeWidth, vbH = nodeHeight;
    const viewBox = svgEl.getAttribute("viewBox");
    if (viewBox) {
      const parts = viewBox.split(/[\s,]+/).map(Number);
      if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
        [vbX, vbY, vbW, vbH] = parts;
      }
    }
    const scaleX = nodeWidth / (vbW || nodeWidth);
    const scaleY = nodeHeight / (vbH || nodeHeight);

    const drawables = getDrawableElements(svgEl);
    if (drawables.length === 0) return null;

    const allSubPaths: SubPath[] = [];

    for (const el of drawables) {
      const d = elementToD(el);
      if (!d) continue;

      const commands = parseDAttribute(d);
      if (commands.length === 0) continue;

      const rawSubPaths = commandsToSubPaths(commands);
      if (rawSubPaths.length === 0) continue;

      const transform = getCumulativeTransform(el);
      const fill = resolveColor(el, "fill");
      const stroke = resolveColor(el, "stroke");
      const strokeWidth = resolveStrokeWidth(el);

      for (const sp of rawSubPaths) {
        for (const a of sp.anchors) {
          const tp = applyMatrix(transform, a.x, a.y);
          a.x = (tp.x - vbX) * scaleX;
          a.y = (tp.y - vbY) * scaleY;
          if (a.handleIn) {
            const th = applyMatrix(transform, a.handleIn.x, a.handleIn.y);
            a.handleIn.x = (th.x - vbX) * scaleX;
            a.handleIn.y = (th.y - vbY) * scaleY;
          }
          if (a.handleOut) {
            const th = applyMatrix(transform, a.handleOut.x, a.handleOut.y);
            a.handleOut.x = (th.x - vbX) * scaleX;
            a.handleOut.y = (th.y - vbY) * scaleY;
          }
        }
        const enrichedSp: SubPath = { ...sp };
        if (fill !== undefined) enrichedSp.fill = fill;
        if (stroke !== undefined) enrichedSp.stroke = stroke;
        if (strokeWidth !== undefined) enrichedSp.strokeWidth = strokeWidth;
        allSubPaths.push(enrichedSp);
      }
    }

    if (allSubPaths.length === 0) return null;

    const svgFill = svgEl.getAttribute("fill") || undefined;
    const svgStroke = svgEl.getAttribute("stroke") || undefined;
    const svgSw = svgEl.getAttribute("stroke-width") || undefined;
    const svgOp = svgEl.getAttribute("opacity") || undefined;

    return {
      subPaths: allSubPaths,
      fill: svgFill && svgFill !== "none" ? svgFill : undefined,
      stroke: svgStroke && svgStroke !== "none" ? svgStroke : undefined,
      strokeWidth: svgSw ? parseFloat(svgSw) : undefined,
      opacity: svgOp ? parseFloat(svgOp) : undefined,
      viewBox: { x: vbX, y: vbY, width: vbW, height: vbH },
    };
  } catch {
    return null;
  }
}
