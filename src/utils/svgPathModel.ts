import paper from "paper";

export type PathCommandType = "M" | "L" | "C" | "Q" | "Z";

export type MoveCommand = { type: "M"; x: number; y: number };
export type LineCommand = { type: "L"; x: number; y: number };
export type CubicCommand = { type: "C"; cp1x: number; cp1y: number; cp2x: number; cp2y: number; x: number; y: number };
export type QuadCommand = { type: "Q"; cpx: number; cpy: number; x: number; y: number };
export type CloseCommand = { type: "Z" };

export type PathCommand = MoveCommand | LineCommand | CubicCommand | QuadCommand | CloseCommand;

export type AnchorPoint = {
  x: number;
  y: number;
  handleIn?: { x: number; y: number };
  handleOut?: { x: number; y: number };
  smooth: boolean;
  cornerRadius?: number;
};

export type SubPath = {
  anchors: AnchorPoint[];
  closed: boolean;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  /** SubPaths sharing a group came from one <path> element and must render as
   *  one, or the holes in a donut fill in solid. */
  group?: number;
  fillRule?: "nonzero" | "evenodd";
  fillOpacity?: number;
  strokeOpacity?: number;
};

export type PathData = {
  subPaths: SubPath[];
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  opacity?: number;
  fillOpacity?: number;
  strokeOpacity?: number;
  cornerRadius?: number;
  viewBox?: { x: number; y: number; width: number; height: number };
  fillRule?: "nonzero" | "evenodd";
};

export function parseDAttribute(d: string): PathCommand[] {
  const commands: PathCommand[] = [];
  const re = /([MLCQZHVSATmlcqzhvsat])\s*([-\d.,eE\s]*)/g;
  let match: RegExpExecArray | null;
  let curX = 0, curY = 0;
  let startX = 0, startY = 0;

  while ((match = re.exec(d)) !== null) {
    const cmd = match[1];
    const rawArgs = match[2].trim();
    const nums = rawArgs.length > 0
      ? rawArgs.split(/[\s,]+/).map(Number).filter((n) => !isNaN(n))
      : [];

    switch (cmd) {
      case "M":
        for (let i = 0; i < nums.length; i += 2) {
          curX = nums[i]; curY = nums[i + 1];
          if (i === 0) { startX = curX; startY = curY; }
          commands.push({ type: i === 0 ? "M" : "L", x: curX, y: curY });
        }
        break;
      case "m":
        for (let i = 0; i < nums.length; i += 2) {
          curX += nums[i]; curY += nums[i + 1];
          if (i === 0) { startX = curX; startY = curY; }
          commands.push({ type: i === 0 ? "M" : "L", x: curX, y: curY });
        }
        break;
      case "L":
        for (let i = 0; i < nums.length; i += 2) {
          curX = nums[i]; curY = nums[i + 1];
          commands.push({ type: "L", x: curX, y: curY });
        }
        break;
      case "l":
        for (let i = 0; i < nums.length; i += 2) {
          curX += nums[i]; curY += nums[i + 1];
          commands.push({ type: "L", x: curX, y: curY });
        }
        break;
      case "H":
        for (const n of nums) { curX = n; commands.push({ type: "L", x: curX, y: curY }); }
        break;
      case "h":
        for (const n of nums) { curX += n; commands.push({ type: "L", x: curX, y: curY }); }
        break;
      case "V":
        for (const n of nums) { curY = n; commands.push({ type: "L", x: curX, y: curY }); }
        break;
      case "v":
        for (const n of nums) { curY += n; commands.push({ type: "L", x: curX, y: curY }); }
        break;
      case "C":
        for (let i = 0; i + 5 < nums.length; i += 6) {
          commands.push({ type: "C", cp1x: nums[i], cp1y: nums[i + 1], cp2x: nums[i + 2], cp2y: nums[i + 3], x: nums[i + 4], y: nums[i + 5] });
          curX = nums[i + 4]; curY = nums[i + 5];
        }
        break;
      case "c":
        for (let i = 0; i + 5 < nums.length; i += 6) {
          const cx1 = curX + nums[i], cy1 = curY + nums[i + 1];
          const cx2 = curX + nums[i + 2], cy2 = curY + nums[i + 3];
          const ex = curX + nums[i + 4], ey = curY + nums[i + 5];
          commands.push({ type: "C", cp1x: cx1, cp1y: cy1, cp2x: cx2, cp2y: cy2, x: ex, y: ey });
          curX = ex; curY = ey;
        }
        break;
      case "S":
      case "s": {
        for (let i = 0; i + 3 <= nums.length; i += 4) {
          const prev = commands[commands.length - 1];
          let rx = curX, ry = curY;
          if (prev && prev.type === "C") { rx = 2 * curX - prev.cp2x; ry = 2 * curY - prev.cp2y; }
          const abs = cmd === "S";
          const cx2 = abs ? nums[i] : curX + nums[i];
          const cy2 = abs ? nums[i + 1] : curY + nums[i + 1];
          const ex = abs ? nums[i + 2] : curX + nums[i + 2];
          const ey = abs ? nums[i + 3] : curY + nums[i + 3];
          commands.push({ type: "C", cp1x: rx, cp1y: ry, cp2x: cx2, cp2y: cy2, x: ex, y: ey });
          curX = ex; curY = ey;
        }
        break;
      }
      case "Q":
        for (let i = 0; i + 3 <= nums.length; i += 4) {
          commands.push({ type: "Q", cpx: nums[i], cpy: nums[i + 1], x: nums[i + 2], y: nums[i + 3] });
          curX = nums[i + 2]; curY = nums[i + 3];
        }
        break;
      case "q":
        for (let i = 0; i + 3 <= nums.length; i += 4) {
          const cx = curX + nums[i], cy = curY + nums[i + 1];
          const ex = curX + nums[i + 2], ey = curY + nums[i + 3];
          commands.push({ type: "Q", cpx: cx, cpy: cy, x: ex, y: ey });
          curX = ex; curY = ey;
        }
        break;
      case "T":
      case "t": {
        for (let i = 0; i + 1 <= nums.length; i += 2) {
          const prev = commands[commands.length - 1];
          let cpx = curX, cpy = curY;
          if (prev && prev.type === "Q") { cpx = 2 * curX - prev.cpx; cpy = 2 * curY - prev.cpy; }
          const abs = cmd === "T";
          const ex = abs ? nums[i] : curX + nums[i];
          const ey = abs ? nums[i + 1] : curY + nums[i + 1];
          commands.push({ type: "Q", cpx, cpy, x: ex, y: ey });
          curX = ex; curY = ey;
        }
        break;
      }
      case "A":
      case "a": {
        const abs = cmd === "A";
        for (let i = 0; i + 6 <= nums.length; i += 7) {
          const ex = abs ? nums[i + 5] : curX + nums[i + 5];
          const ey = abs ? nums[i + 6] : curY + nums[i + 6];
          commands.push({ type: "L", x: ex, y: ey });
          curX = ex; curY = ey;
        }
        break;
      }
      case "Z":
      case "z":
        commands.push({ type: "Z" });
        curX = startX; curY = startY;
        break;
    }
  }
  return commands;
}

export function serializePath(commands: PathCommand[]): string {
  return commands.map((c) => {
    switch (c.type) {
      case "M": return `M${r(c.x)} ${r(c.y)}`;
      case "L": return `L${r(c.x)} ${r(c.y)}`;
      case "C": return `C${r(c.cp1x)} ${r(c.cp1y)} ${r(c.cp2x)} ${r(c.cp2y)} ${r(c.x)} ${r(c.y)}`;
      case "Q": return `Q${r(c.cpx)} ${r(c.cpy)} ${r(c.x)} ${r(c.y)}`;
      case "Z": return "Z";
    }
  }).join(" ");
}

function r(n: number): string {
  return Math.round(n * 100) / 100 + "";
}

export function commandsToSubPaths(commands: PathCommand[]): SubPath[] {
  const subPaths: SubPath[] = [];
  let current: AnchorPoint[] = [];

  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i];
    switch (cmd.type) {
      case "M":
        if (current.length > 0) {
          subPaths.push({ anchors: current, closed: false });
        }
        current = [{ x: cmd.x, y: cmd.y, smooth: false }];
        break;
      case "L":
        current.push({ x: cmd.x, y: cmd.y, smooth: false });
        break;
      case "C": {
        const prev = current[current.length - 1];
        if (prev && !prev.handleOut) {
          prev.handleOut = { x: cmd.cp1x, y: cmd.cp1y };
        }
        current.push({
          x: cmd.x, y: cmd.y,
          handleIn: { x: cmd.cp2x, y: cmd.cp2y },
          smooth: true,
        });
        break;
      }
      case "Q": {
        const prev = current[current.length - 1];
        if (prev && !prev.handleOut) {
          prev.handleOut = { x: cmd.cpx, y: cmd.cpy };
        }
        current.push({
          x: cmd.x, y: cmd.y,
          handleIn: { x: cmd.cpx, y: cmd.cpy },
          smooth: true,
        });
        break;
      }
      case "Z":
        if (current.length > 0) {
          subPaths.push({ anchors: current, closed: true });
          current = [];
        }
        break;
    }
  }
  if (current.length > 0) {
    subPaths.push({ anchors: current, closed: false });
  }
  return subPaths;
}

export function subPathsToCommands(subPaths: SubPath[]): PathCommand[] {
  const commands: PathCommand[] = [];
  for (const sp of subPaths) {
    if (sp.anchors.length === 0) continue;
    commands.push({ type: "M", x: sp.anchors[0].x, y: sp.anchors[0].y });
    for (let i = 1; i < sp.anchors.length; i++) {
      const prev = sp.anchors[i - 1];
      const cur = sp.anchors[i];
      if (prev.handleOut || cur.handleIn) {
        const cp1x = prev.handleOut?.x ?? prev.x;
        const cp1y = prev.handleOut?.y ?? prev.y;
        const cp2x = cur.handleIn?.x ?? cur.x;
        const cp2y = cur.handleIn?.y ?? cur.y;
        commands.push({ type: "C", cp1x, cp1y, cp2x, cp2y, x: cur.x, y: cur.y });
      } else {
        commands.push({ type: "L", x: cur.x, y: cur.y });
      }
    }
    if (sp.closed) {
      const last = sp.anchors[sp.anchors.length - 1];
      const first = sp.anchors[0];
      if (last.handleOut || first.handleIn) {
        const cp1x = last.handleOut?.x ?? last.x;
        const cp1y = last.handleOut?.y ?? last.y;
        const cp2x = first.handleIn?.x ?? first.x;
        const cp2y = first.handleIn?.y ?? first.y;
        commands.push({ type: "C", cp1x, cp1y, cp2x, cp2y, x: first.x, y: first.y });
      }
      commands.push({ type: "Z" });
    }
  }
  return commands;
}

export function pathDataToD(pathData: PathData): string {
  return serializePath(subPathsToCommands(pathData.subPaths));
}

export function getAnchorPositions(pathData: PathData): { x: number; y: number; subPathIdx: number; anchorIdx: number }[] {
  const result: { x: number; y: number; subPathIdx: number; anchorIdx: number }[] = [];
  pathData.subPaths.forEach((sp, si) => {
    sp.anchors.forEach((a, ai) => {
      result.push({ x: a.x, y: a.y, subPathIdx: si, anchorIdx: ai });
    });
  });
  return result;
}

/** 2D affine transform, in SVG's own [a b c d e f] order. */
type Mat = [number, number, number, number, number, number];
const IDENT: Mat = [1, 0, 0, 1, 0, 0];

function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function parseTransform(s: string): Mat {
  let m = IDENT;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  const rad = (d: number) => (d * Math.PI) / 180;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(s)) !== null) {
    const n = hit[2].split(/[\s,]+/).filter(Boolean).map(Number);
    if (n.some(Number.isNaN)) continue;
    switch (hit[1]) {
      case "matrix": if (n.length === 6) m = mul(m, n as Mat); break;
      case "translate": m = mul(m, [1, 0, 0, 1, n[0] || 0, n[1] || 0]); break;
      case "scale": m = mul(m, [n[0] ?? 1, 0, 0, n[1] ?? n[0] ?? 1, 0, 0]); break;
      case "rotate": {
        const c = Math.cos(rad(n[0])), s2 = Math.sin(rad(n[0]));
        const r: Mat = [c, s2, -s2, c, 0, 0];
        m = n.length >= 3
          ? mul(mul(mul(m, [1, 0, 0, 1, n[1], n[2]]), r), [1, 0, 0, 1, -n[1], -n[2]])
          : mul(m, r);
        break;
      }
      case "skewX": m = mul(m, [1, 0, Math.tan(rad(n[0])), 1, 0, 0]); break;
      case "skewY": m = mul(m, [1, Math.tan(rad(n[0])), 0, 1, 0, 0]); break;
    }
  }
  return m;
}

function xf(m: Mat, p: { x: number; y: number }): { x: number; y: number } {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

/** Presentation attributes we care about, attribute or inline style. */
function paintOf(el: Element, name: string): string | null {
  const style = el.getAttribute("style");
  if (style) {
    const hit = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`).exec(style);
    if (hit) return hit[1].trim();
  }
  // xmldom hands back "" for an absent attribute where a browser hands back
  // null, and "" must not shadow an inherited value.
  return el.getAttribute(name) || null;
}

/**
 * A gradient whose stops are all effectively the same colour is a solid the
 * vectoriser happened to emit as a ramp. Resolve those to their first stop;
 * anything with a real colour range stays a refusal, because flattening it
 * would repaint the artwork.
 */
const FLAT_STOP_DISTANCE = 12; // per-channel RGB, ~5% of the range

function parseRgb(c: string): [number, number, number] | null {
  const fn = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(c);
  if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3])];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
  if (!hex) return null;
  const h = hex[1].length === 3 ? hex[1].replace(/./g, (d) => d + d) : hex[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function gradientSolid(doc: Document, ref: string): { color: string; flat: boolean } | null {
  const id = /url\(\s*#([^)\s]+)\s*\)/.exec(ref)?.[1];
  if (!id) return null;
  let def: Element | null = null;
  for (const tag of ["linearGradient", "radialGradient"]) {
    const list = doc.getElementsByTagName(tag);
    for (let i = 0; i < list.length; i++) {
      if (list[i].getAttribute("id") === id) { def = list[i] as Element; break; }
    }
    if (def) break;
  }
  if (!def) return null;
  const stops = def.getElementsByTagName("stop");
  const colors: [number, number, number][] = [];
  for (let i = 0; i < stops.length; i++) {
    const c = parseRgb(paintOf(stops[i] as Element, "stop-color") || "");
    if (!c) return null;
    colors.push(c);
  }
  if (colors.length === 0) return null;
  const spread = (ch: 0 | 1 | 2) =>
    Math.max(...colors.map((c) => c[ch])) - Math.min(...colors.map((c) => c[ch]));
  const flat = spread(0) <= FLAT_STOP_DISTANCE && spread(1) <= FLAT_STOP_DISTANCE && spread(2) <= FLAT_STOP_DISTANCE;
  const at = (ch: 0 | 1 | 2) => (flat ? colors[0][ch] : Math.round(colors.reduce((t, c) => t + c[ch], 0) / colors.length));
  return { color: `rgb(${at(0)},${at(1)},${at(2)})`, flat };
}

/**
 * A real ramp covering this little of the artwork is a vectoriser speck, not
 * shading: standing it in with its average stop is invisible, and refusing over
 * it would cost the whole file its editability.
 */
const NEGLIGIBLE_AREA = 0.001; // fraction of the node's area

function coversMoreThanNegligible(sps: SubPath[], nodeArea: number): boolean {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const sp of sps) for (const a of sp.anchors) {
    x0 = Math.min(x0, a.x); y0 = Math.min(y0, a.y);
    x1 = Math.max(x1, a.x); y1 = Math.max(y1, a.y);
  }
  return !(x1 > x0) || (x1 - x0) * (y1 - y0) > NEGLIGIBLE_AREA * nodeArea;
}

const K = 0.5522847498;
function ellipseD(cx: number, cy: number, rx: number, ry: number): string {
  return `M${cx - rx} ${cy}` +
    `C${cx - rx} ${cy - ry * K} ${cx - rx * K} ${cy - ry} ${cx} ${cy - ry}` +
    `C${cx + rx * K} ${cy - ry} ${cx + rx} ${cy - ry * K} ${cx + rx} ${cy}` +
    `C${cx + rx} ${cy + ry * K} ${cx + rx * K} ${cy + ry} ${cx} ${cy + ry}` +
    `C${cx - rx * K} ${cy + ry} ${cx - rx} ${cy + ry * K} ${cx - rx} ${cy}Z`;
}

/** Every shape SVG can fill, as a `d`. Generated art leans on rect/circle for
 *  backgrounds and dots; refusing those refused the whole artwork. */
function shapeToD(el: Element, tag: string): string | null {
  const num = (n: string, dflt = 0) => {
    const v = parseFloat(el.getAttribute(n) || "");
    return Number.isNaN(v) ? dflt : v;
  };
  const pts = () => (el.getAttribute("points") || "").split(/[\s,]+/).filter(Boolean).map(Number);
  switch (tag) {
    case "path": return el.getAttribute("d") || null;
    case "line": return `M${num("x1")} ${num("y1")}L${num("x2")} ${num("y2")}`;
    case "circle": {
      const r = num("r");
      return r > 0 ? ellipseD(num("cx"), num("cy"), r, r) : null;
    }
    case "ellipse": {
      const rx = num("rx"), ry = num("ry");
      return rx > 0 && ry > 0 ? ellipseD(num("cx"), num("cy"), rx, ry) : null;
    }
    case "polygon":
    case "polyline": {
      const p = pts();
      if (p.length < 4 || p.some(Number.isNaN)) return null;
      let d = `M${p[0]} ${p[1]}`;
      for (let i = 2; i + 1 < p.length; i += 2) d += `L${p[i]} ${p[i + 1]}`;
      return tag === "polygon" ? d + "Z" : d;
    }
    case "rect": {
      const x = num("x"), y = num("y"), w = num("width"), h = num("height");
      if (w <= 0 || h <= 0) return null;
      let rx = num("rx", NaN), ry = num("ry", NaN);
      if (Number.isNaN(rx) && Number.isNaN(ry)) return `M${x} ${y}L${x + w} ${y}L${x + w} ${y + h}L${x} ${y + h}Z`;
      rx = Math.min(Number.isNaN(rx) ? ry : rx, w / 2);
      ry = Math.min(Number.isNaN(ry) ? rx : ry, h / 2);
      const kx = rx * K, ky = ry * K;
      return `M${x + rx} ${y}L${x + w - rx} ${y}` +
        `C${x + w - rx + kx} ${y} ${x + w} ${y + ry - ky} ${x + w} ${y + ry}` +
        `L${x + w} ${y + h - ry}` +
        `C${x + w} ${y + h - ry + ky} ${x + w - rx + kx} ${y + h} ${x + w - rx} ${y + h}` +
        `L${x + rx} ${y + h}` +
        `C${x + rx - kx} ${y + h} ${x} ${y + h - ry + ky} ${x} ${y + h - ry}` +
        `L${x} ${y + ry}` +
        `C${x} ${y + ry - ky} ${x + rx - kx} ${y} ${x + rx} ${y}Z`;
    }
  }
  return null;
}

/** Anything whose look we cannot reproduce as flat filled paths. Rendering
 *  pathData REPLACES the source SVG on canvas, so a partial parse is not a
 *  degraded render — it is a destroyed asset. Refuse and keep the image. */
const REFUSE = new Set([
  "text", "tspan", "textpath", "image", "use", "foreignobject",
  "clippath", "mask", "filter", "pattern", "marker", "symbol", "switch", "style", "animate",
]);
const SKIP = new Set(["defs", "title", "desc", "metadata"]);

/** Where the point-edit overlay stops being usable. Art above this is refitted
 *  through fewer anchors rather than refused — a traced Recraft vector carries
 *  hundreds of near-collinear points per shape that no one would edit by hand.
 *  ponytail: raise it if the overlay gets virtualised. */
const MAX_ANCHORS = 4000;
/** Refit tolerance in node pixels. */
export const DEFAULT_SIMPLIFY_TOLERANCE = 4;
/** Past this, even fitting is not worth the wait. */
const HARD_ANCHOR_CEILING = 60000;

function tagOf(el: Element): string {
  const t = (el.tagName || "").toLowerCase();
  const i = t.indexOf(":");
  return i === -1 ? t : t.slice(i + 1);
}

type Inherited = {
  fill?: string; stroke?: string; strokeWidth?: string; fillRule?: string;
  fillOpacity: number; strokeOpacity: number;
};

function opacityOf(el: Element, name: string): number {
  const v = parseFloat(paintOf(el, name) || "");
  return Number.isNaN(v) ? 1 : Math.max(0, Math.min(1, v));
}

export function countAnchors(pathData: PathData): number {
  return pathData.subPaths.reduce((n, sp) => n + sp.anchors.length, 0);
}

export function extractPathDataFromSvg(svgContent: string, nodeWidth: number, nodeHeight: number): PathData | null {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgContent, "image/svg+xml");
    const svgEl = doc.getElementsByTagName("svg")[0];
    if (!svgEl) return null;

    let vbX = 0, vbY = 0, vbW = nodeWidth, vbH = nodeHeight;
    const viewBox = svgEl.getAttribute("viewBox");
    if (viewBox) {
      const parts = viewBox.split(/[\s,]+/).filter(Boolean).map(Number);
      if (parts.length === 4 && parts.every((n) => !Number.isNaN(n)) && parts[2] > 0 && parts[3] > 0) {
        [vbX, vbY, vbW, vbH] = parts;
      }
    }
    // The viewBox mapping is just the outermost transform: fold it in once and
    // every anchor below comes out already in node space.
    const root: Mat = mul([nodeWidth / vbW, 0, 0, nodeHeight / vbH, 0, 0], [1, 0, 0, 1, -vbX, -vbY]);

    const subPaths: SubPath[] = [];
    let anchorCount = 0;
    let group = 0;
    let refused = false;

    const walk = (el: Element, m: Mat, inh: Inherited): void => {
      if (refused) return;
      const tag = tagOf(el);
      if (SKIP.has(tag)) return;
      if (REFUSE.has(tag)) { refused = true; return; }
      // A gradient, pattern or clip we would silently drop.
      if (paintOf(el, "clip-path") || paintOf(el, "mask") || paintOf(el, "filter")) { refused = true; return; }

      const tr = el.getAttribute("transform") || null;
      const m2 = tr ? mul(m, parseTransform(tr)) : m;

      let fill = paintOf(el, "fill");
      let stroke = paintOf(el, "stroke");
      // A gradient is paint we cannot reproduce. Flat stops are a solid the
      // vectoriser spelled oddly; a real ramp is only stood in with its average
      // if the shape turns out to be too small to see (checked once we have it).
      let approximated = false;
      if (fill?.includes("url(")) {
        const g = gradientSolid(doc, fill);
        if (!g) { refused = true; return; }
        fill = g.color;
        approximated ||= !g.flat;
      }
      if (stroke?.includes("url(")) {
        const g = gradientSolid(doc, stroke);
        if (!g) { refused = true; return; }
        stroke = g.color;
        approximated ||= !g.flat;
      }
      const inh2: Inherited = {
        fill: fill ?? inh.fill,
        stroke: stroke ?? inh.stroke,
        strokeWidth: paintOf(el, "stroke-width") ?? inh.strokeWidth,
        fillRule: paintOf(el, "fill-rule") ?? inh.fillRule,
        // Group opacity has no per-subPath equivalent, so it collapses into the
        // paint opacities of everything below it.
        fillOpacity: inh.fillOpacity * opacityOf(el, "opacity") * opacityOf(el, "fill-opacity"),
        strokeOpacity: inh.strokeOpacity * opacityOf(el, "opacity") * opacityOf(el, "stroke-opacity"),
      };

      const d = tag === "svg" || tag === "g" || tag === "a" ? null : shapeToD(el, tag);
      if (d) {
        const own = commandsToSubPaths(parseDAttribute(d));
        const sw = inh2.strokeWidth ? parseFloat(inh2.strokeWidth) : undefined;
        // Scale stroke width by the transform, or hairlines inside a scaled
        // group come back the wrong weight.
        const scale = Math.sqrt(Math.abs(m2[0] * m2[3] - m2[1] * m2[2])) || 1;
        for (const sp of own) {
          for (const a of sp.anchors) {
            const p = xf(m2, a);
            a.x = p.x; a.y = p.y;
            if (a.handleIn) a.handleIn = xf(m2, a.handleIn);
            if (a.handleOut) a.handleOut = xf(m2, a.handleOut);
          }
          anchorCount += sp.anchors.length;
          sp.group = group;
          // SVG's default fill is black, not "no paint": leaving it undefined
          // renders the whole artwork invisible.
          sp.fill = inh2.fill ?? "#000000";
          if (inh2.stroke !== undefined) sp.stroke = inh2.stroke;
          if (sw !== undefined && !Number.isNaN(sw)) sp.strokeWidth = sw * scale;
          if (inh2.fillRule === "evenodd") sp.fillRule = "evenodd";
          if (inh2.fillOpacity < 1) sp.fillOpacity = inh2.fillOpacity;
          if (inh2.strokeOpacity < 1) sp.strokeOpacity = inh2.strokeOpacity;
          subPaths.push(sp);
        }
        if (approximated && coversMoreThanNegligible(own, nodeWidth * nodeHeight)) { refused = true; return; }
        group++;
        if (anchorCount > HARD_ANCHOR_CEILING) { refused = true; return; }
      } else if (tag !== "svg" && tag !== "g" && tag !== "a") {
        // An element we do not know at all: refuse rather than drop it.
        refused = true;
        return;
      }

      const kids = el.childNodes;
      for (let i = 0; i < kids.length; i++) {
        const k = kids[i];
        if (k.nodeType === 1) walk(k as Element, m2, inh2);
        if (refused) return;
      }
    };

    walk(svgEl, root, { fillOpacity: 1, strokeOpacity: 1 });
    if (refused || subPaths.length === 0) return null;

    let pathData: PathData = {
      subPaths,
      viewBox: { x: 0, y: 0, width: nodeWidth, height: nodeHeight },
    };
    // Always refit once. 8px of node space is the point where a vectoriser's
    // stair-stepping collapses into the curve it was tracing; loosen further
    // only if the art is still too dense to edit.
    for (const tol of [DEFAULT_SIMPLIFY_TOLERANCE, 16, 32]) {
      pathData = simplifyPathData(pathData, tol);
      const next = countAnchors(pathData);
      if (next <= MAX_ANCHORS || next === anchorCount) {
        anchorCount = next;
        break;
      }
      anchorCount = next;
    }
    return anchorCount > MAX_ANCHORS ? null : pathData;
  } catch {
    return null;
  }
}

export function insertPointOnSegment(
  subPath: SubPath, segmentIndex: number, t: number
): SubPath {
  const anchors = [...subPath.anchors.map((a) => ({ ...a, handleIn: a.handleIn ? { ...a.handleIn } : undefined, handleOut: a.handleOut ? { ...a.handleOut } : undefined }))];
  const p0 = anchors[segmentIndex];
  const nextIdx = (segmentIndex + 1) % anchors.length;
  const p1 = anchors[nextIdx];

  if (p0.handleOut || p1.handleIn) {
    const cp1x = p0.handleOut?.x ?? p0.x;
    const cp1y = p0.handleOut?.y ?? p0.y;
    const cp2x = p1.handleIn?.x ?? p1.x;
    const cp2y = p1.handleIn?.y ?? p1.y;

    const [left, right, mid] = splitCubic(p0.x, p0.y, cp1x, cp1y, cp2x, cp2y, p1.x, p1.y, t);

    p0.handleOut = { x: left.cp1x, y: left.cp1y };
    const newAnchor: AnchorPoint = {
      x: mid.x, y: mid.y,
      handleIn: { x: left.cp2x, y: left.cp2y },
      handleOut: { x: right.cp1x, y: right.cp1y },
      smooth: true,
    };
    p1.handleIn = { x: right.cp2x, y: right.cp2y };

    anchors.splice(segmentIndex + 1, 0, newAnchor as typeof anchors[number]);
  } else {
    const mx = p0.x + (p1.x - p0.x) * t;
    const my = p0.y + (p1.y - p0.y) * t;
    anchors.splice(segmentIndex + 1, 0, { x: mx, y: my, smooth: false, handleIn: undefined, handleOut: undefined });
  }

  return { ...subPath, anchors };
}

export function deletePoint(pathData: PathData, subPathIdx: number, anchorIdx: number): PathData {
  const subPaths = pathData.subPaths.map((sp, si) => {
    if (si !== subPathIdx) return sp;
    const anchors = sp.anchors.filter((_, ai) => ai !== anchorIdx);
    return { ...sp, anchors };
  }).filter((sp) => sp.anchors.length > 0);

  return { ...pathData, subPaths };
}

export function toggleSmooth(pathData: PathData, subPathIdx: number, anchorIdx: number): PathData {
  const subPaths = pathData.subPaths.map((sp, si) => {
    if (si !== subPathIdx) return sp;
    const anchors = sp.anchors.map((a, ai) => {
      if (ai !== anchorIdx) return a;
      if (a.smooth) {
        return { ...a, smooth: false };
      } else {
        const handleDist = 30;
        const prevA = ai > 0 ? sp.anchors[ai - 1] : (sp.closed ? sp.anchors[sp.anchors.length - 1] : null);
        const nextA = ai < sp.anchors.length - 1 ? sp.anchors[ai + 1] : (sp.closed ? sp.anchors[0] : null);
        let dx = 1, dy = 0;
        if (prevA && nextA) {
          dx = nextA.x - prevA.x; dy = nextA.y - prevA.y;
        } else if (nextA) {
          dx = nextA.x - a.x; dy = nextA.y - a.y;
        } else if (prevA) {
          dx = a.x - prevA.x; dy = a.y - prevA.y;
        }
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len, uy = dy / len;
        return {
          ...a,
          smooth: true,
          handleIn: { x: a.x - ux * handleDist, y: a.y - uy * handleDist },
          handleOut: { x: a.x + ux * handleDist, y: a.y + uy * handleDist },
        };
      }
    });
    return { ...sp, anchors };
  });
  return { ...pathData, subPaths };
}

export function convertToCurve(pathData: PathData, subPathIdx: number, segmentIndex: number): PathData {
  const subPaths = pathData.subPaths.map((sp, si) => {
    if (si !== subPathIdx) return sp;
    const anchors = sp.anchors.map((a, ai) => {
      if (ai !== segmentIndex) return a;
      const nextIdx = (ai + 1) % sp.anchors.length;
      const next = sp.anchors[nextIdx];
      if (next && !a.handleOut) {
        const mx = (a.x + next.x) / 2;
        const my = (a.y + next.y) / 2;
        const updatedA = { ...a, handleOut: { x: (a.x + mx) / 2, y: (a.y + my) / 2 }, smooth: true };
        return updatedA;
      }
      return a;
    });
    const nextSegIdx = (segmentIndex + 1) % sp.anchors.length;
    const next = anchors[nextSegIdx];
    if (next && !next.handleIn) {
      const prev = anchors[segmentIndex];
      const mx = (prev.x + next.x) / 2;
      const my = (prev.y + next.y) / 2;
      anchors[nextSegIdx] = { ...next, handleIn: { x: (next.x + mx) / 2, y: (next.y + my) / 2 }, smooth: true };
    }
    return { ...sp, anchors };
  });
  return { ...pathData, subPaths };
}

export function splitPathAtPoint(pathData: PathData, subPathIdx: number, anchorIdx: number): PathData {
  const sp = pathData.subPaths[subPathIdx];
  if (!sp || sp.anchors.length < 2) return pathData;

  if (sp.closed) {
    const reordered: AnchorPoint[] = [];
    for (let i = 0; i < sp.anchors.length; i++) {
      reordered.push(sp.anchors[(anchorIdx + i) % sp.anchors.length]);
    }
    const newSubPaths = [...pathData.subPaths];
    newSubPaths[subPathIdx] = { anchors: reordered, closed: false };
    return { ...pathData, subPaths: newSubPaths };
  }

  if (anchorIdx === 0 || anchorIdx === sp.anchors.length - 1) return pathData;

  const left: AnchorPoint[] = sp.anchors.slice(0, anchorIdx + 1);
  const right: AnchorPoint[] = sp.anchors.slice(anchorIdx);

  const newSubPaths = [...pathData.subPaths];
  newSubPaths.splice(subPathIdx, 1,
    { anchors: left, closed: false },
    { anchors: right, closed: false }
  );
  return { ...pathData, subPaths: newSubPaths };
}

export function joinEndpoints(
  pathData: PathData,
  sp1Idx: number,
  sp2Idx: number,
  anchor1Idx?: number,
  anchor2Idx?: number
): PathData {
  const sp1 = pathData.subPaths[sp1Idx];
  const sp2 = pathData.subPaths[sp2Idx];
  if (!sp1 || !sp2 || sp1.closed || sp2.closed) return pathData;

  const isEndpoint1 = anchor1Idx === undefined || anchor1Idx === 0 || anchor1Idx === sp1.anchors.length - 1;
  const isEndpoint2 = anchor2Idx === undefined || anchor2Idx === 0 || anchor2Idx === sp2.anchors.length - 1;
  if (!isEndpoint1 || !isEndpoint2) return pathData;

  let a1 = [...sp1.anchors];
  let a2 = [...sp2.anchors];
  if (anchor1Idx === 0) a1 = a1.reverse();
  if (anchor2Idx !== undefined && anchor2Idx === sp2.anchors.length - 1) a2 = a2.reverse();

  const joined: SubPath = {
    anchors: [...a1, ...a2],
    closed: false,
  };
  const newSubPaths = pathData.subPaths.filter((_, i) => i !== sp1Idx && i !== sp2Idx);
  newSubPaths.push(joined);
  return { ...pathData, subPaths: newSubPaths };
}

function splitCubic(
  x0: number, y0: number,
  cx1: number, cy1: number,
  cx2: number, cy2: number,
  x3: number, y3: number,
  t: number
): [{ cp1x: number; cp1y: number; cp2x: number; cp2y: number }, { cp1x: number; cp1y: number; cp2x: number; cp2y: number }, { x: number; y: number }] {
  const ax = lerp(x0, cx1, t);
  const ay = lerp(y0, cy1, t);
  const bx = lerp(cx1, cx2, t);
  const by = lerp(cy1, cy2, t);
  const ccx = lerp(cx2, x3, t);
  const ccy = lerp(cy2, y3, t);
  const dx = lerp(ax, bx, t);
  const dy = lerp(ay, by, t);
  const ex = lerp(bx, ccx, t);
  const ey = lerp(by, ccy, t);
  const fx = lerp(dx, ex, t);
  const fy = lerp(dy, ey, t);

  return [
    { cp1x: ax, cp1y: ay, cp2x: dx, cp2y: dy },
    { cp1x: ex, cp1y: ey, cp2x: ccx, cp2y: ccy },
    { x: fx, y: fy },
  ];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function rdpSimplify(points: { x: number; y: number }[], epsilon: number): { x: number; y: number }[] {
  if (points.length <= 2) return points;
  let maxDist = 0;
  let maxIdx = 0;
  const first = points[0];
  const last = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const d = pointToLineDistance(points[i], first, last);
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }

  if (maxDist > epsilon) {
    const left = rdpSimplify(points.slice(0, maxIdx + 1), epsilon);
    const right = rdpSimplify(points.slice(maxIdx), epsilon);
    return [...left.slice(0, -1), ...right];
  }
  return [first, last];
}

function pointToLineDistance(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  return Math.hypot(p.x - projX, p.y - projY);
}

export function fitCubicBezier(points: { x: number; y: number }[]): SubPath {
  if (points.length < 2) {
    return { anchors: points.map((p) => ({ x: p.x, y: p.y, smooth: false })), closed: false };
  }
  if (points.length === 2) {
    return {
      anchors: [
        { x: points[0].x, y: points[0].y, smooth: false },
        { x: points[1].x, y: points[1].y, smooth: false },
      ],
      closed: false,
    };
  }

  const anchors: AnchorPoint[] = [];

  anchors.push({
    x: points[0].x, y: points[0].y,
    handleOut: {
      x: points[0].x + (points[1].x - points[0].x) / 3,
      y: points[0].y + (points[1].y - points[0].y) / 3,
    },
    smooth: false,
  });

  const step = Math.max(1, Math.floor(points.length / 20));
  for (let i = step; i < points.length - step; i += step) {
    const prev = points[Math.max(0, i - step)];
    const cur = points[i];
    const next = points[Math.min(points.length - 1, i + step)];
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const handleDist = Math.min(len / 3, 30);
    anchors.push({
      x: cur.x, y: cur.y,
      handleIn: { x: cur.x - ux * handleDist, y: cur.y - uy * handleDist },
      handleOut: { x: cur.x + ux * handleDist, y: cur.y + uy * handleDist },
      smooth: true,
    });
  }

  const last = points[points.length - 1];
  const prevLast = points[points.length - 2];
  anchors.push({
    x: last.x, y: last.y,
    handleIn: {
      x: last.x - (last.x - prevLast.x) / 3,
      y: last.y - (last.y - prevLast.y) / 3,
    },
    smooth: false,
  });

  return { anchors, closed: false };
}

export function moveAnchor(pathData: PathData, subPathIdx: number, anchorIdx: number, dx: number, dy: number): PathData {
  const subPaths = pathData.subPaths.map((sp, si) => {
    if (si !== subPathIdx) return sp;
    const anchors = sp.anchors.map((a, ai) => {
      if (ai !== anchorIdx) return a;
      return {
        ...a,
        x: a.x + dx,
        y: a.y + dy,
        handleIn: a.handleIn ? { x: a.handleIn.x + dx, y: a.handleIn.y + dy } : undefined,
        handleOut: a.handleOut ? { x: a.handleOut.x + dx, y: a.handleOut.y + dy } : undefined,
      };
    });
    return { ...sp, anchors };
  });
  return { ...pathData, subPaths };
}

export function moveHandle(
  pathData: PathData,
  subPathIdx: number,
  anchorIdx: number,
  handleType: "in" | "out",
  newX: number,
  newY: number
): PathData {
  const subPaths = pathData.subPaths.map((sp, si) => {
    if (si !== subPathIdx) return sp;
    const anchors = sp.anchors.map((a, ai) => {
      if (ai !== anchorIdx) return a;
      const updated = { ...a };
      if (handleType === "in") {
        updated.handleIn = { x: newX, y: newY };
        if (a.smooth && a.handleOut) {
          const dx = newX - a.x;
          const dy = newY - a.y;
          const dist = Math.hypot(a.handleOut.x - a.x, a.handleOut.y - a.y);
          const len = Math.hypot(dx, dy) || 1;
          updated.handleOut = { x: a.x - (dx / len) * dist, y: a.y - (dy / len) * dist };
        }
      } else {
        updated.handleOut = { x: newX, y: newY };
        if (a.smooth && a.handleIn) {
          const dx = newX - a.x;
          const dy = newY - a.y;
          const dist = Math.hypot(a.handleIn.x - a.x, a.handleIn.y - a.y);
          const len = Math.hypot(dx, dy) || 1;
          updated.handleIn = { x: a.x - (dx / len) * dist, y: a.y - (dy / len) * dist };
        }
      }
      return updated;
    });
    return { ...sp, anchors };
  });
  return { ...pathData, subPaths };
}

function extractSvgViewBox(svgContent: string): { minX: number; minY: number; width: number; height: number } | null {
  const match = svgContent.match(/viewBox\s*=\s*["']([^"']+)["']/);
  if (!match) return null;
  const parts = match[1].trim().split(/[\s,]+/).map(Number);
  if (parts.length >= 4 && parts.every((n) => !isNaN(n))) {
    return { minX: parts[0], minY: parts[1], width: parts[2], height: parts[3] };
  }
  return null;
}

function extractSvgDimensions(svgContent: string): { width: number; height: number } | null {
  const wMatch = svgContent.match(/<svg[^>]*\bwidth\s*=\s*["'](\d+(?:\.\d+)?)(?:px)?["']/);
  const hMatch = svgContent.match(/<svg[^>]*\bheight\s*=\s*["'](\d+(?:\.\d+)?)(?:px)?["']/);
  if (wMatch && hMatch) {
    return { width: parseFloat(wMatch[1]), height: parseFloat(hMatch[1]) };
  }
  return null;
}

function getAllSvgAnchorPoints(svgContent: string): { x: number; y: number }[] {
  const pathDRegex = /<path[^>]*\bd\s*=\s*["']([^"']+)["'][^>]*\/?>/gi;
  const allPoints: { x: number; y: number }[] = [];
  let match: RegExpExecArray | null;

  while ((match = pathDRegex.exec(svgContent)) !== null) {
    const commands = parseDAttribute(match[1]);
    const subPaths = commandsToSubPaths(commands);
    const pathData: PathData = { subPaths };
    const pts = getAnchorPositions(pathData);
    allPoints.push(...pts.map((p) => ({ x: p.x, y: p.y })));
  }

  return allPoints;
}

export function getAnchorPointsNormalized(
  svgContent: string,
  nodeWidth: number,
  nodeHeight: number
): { x: number; y: number }[] {
  const raw = getAllSvgAnchorPoints(svgContent);
  if (raw.length === 0) return raw;

  const vb = extractSvgViewBox(svgContent);
  const dims = extractSvgDimensions(svgContent);

  const svgW = vb?.width ?? dims?.width ?? nodeWidth;
  const svgH = vb?.height ?? dims?.height ?? nodeHeight;
  const offX = vb?.minX ?? 0;
  const offY = vb?.minY ?? 0;

  if (svgW === 0 || svgH === 0) return [];

  const svgAspect = svgW / svgH;
  const nodeAspect = nodeWidth / nodeHeight;

  let renderW: number;
  let renderH: number;
  let insetX = 0;
  let insetY = 0;

  if (svgAspect > nodeAspect) {
    renderW = nodeWidth;
    renderH = nodeWidth / svgAspect;
    insetY = (nodeHeight - renderH) / 2;
  } else {
    renderH = nodeHeight;
    renderW = nodeHeight * svgAspect;
    insetX = (nodeWidth - renderW) / 2;
  }

  const scaleX = renderW / svgW;
  const scaleY = renderH / svgH;

  return raw.map((p) => ({
    x: insetX + (p.x - offX) * scaleX,
    y: insetY + (p.y - offY) * scaleY,
  }));
}

export function scalePathData(pd: PathData, scaleX: number, scaleY: number): PathData {
  const scaleR = Math.min(Math.abs(scaleX), Math.abs(scaleY));
  return {
    ...pd,
    // The viewBox is the frame the anchors are drawn through: leave it behind
    // and a stretched node renders its artwork bleeding outside its own box.
    viewBox: pd.viewBox && {
      x: pd.viewBox.x * scaleX,
      y: pd.viewBox.y * scaleY,
      width: pd.viewBox.width * scaleX,
      height: pd.viewBox.height * scaleY,
    },
    cornerRadius: pd.cornerRadius ? pd.cornerRadius * scaleR : pd.cornerRadius,
    subPaths: pd.subPaths.map((sp) => ({
      ...sp,
      anchors: sp.anchors.map((a) => ({
        ...a,
        x: a.x * scaleX,
        y: a.y * scaleY,
        handleIn: a.handleIn ? { x: a.handleIn.x * scaleX, y: a.handleIn.y * scaleY } : undefined,
        handleOut: a.handleOut ? { x: a.handleOut.x * scaleX, y: a.handleOut.y * scaleY } : undefined,
        cornerRadius: a.cornerRadius ? a.cornerRadius * scaleR : a.cornerRadius,
      })),
    })),
  };
}

export function buildDWithRadius(pd: PathData): string {
  const globalR = pd.cornerRadius ?? 0;
  const parts: string[] = [];

  for (const sp of pd.subPaths) {
    const { anchors, closed } = sp;
    const n = anchors.length;
    if (n === 0) continue;

    if (n === 1) {
      parts.push(`M${anchors[0].x} ${anchors[0].y}`);
      continue;
    }

    const hasRadius = anchors.some((a) => (a.cornerRadius ?? globalR) > 0 && !a.smooth);
    if (!hasRadius) {
      parts.push(`M${anchors[0].x} ${anchors[0].y}`);
      for (let i = 1; i < n; i++) {
        const prev = anchors[i - 1];
        const cur = anchors[i];
        if (prev.handleOut || cur.handleIn) {
          const cp1x = prev.handleOut?.x ?? prev.x;
          const cp1y = prev.handleOut?.y ?? prev.y;
          const cp2x = cur.handleIn?.x ?? cur.x;
          const cp2y = cur.handleIn?.y ?? cur.y;
          parts.push(`C${cp1x} ${cp1y} ${cp2x} ${cp2y} ${cur.x} ${cur.y}`);
        } else {
          parts.push(`L${cur.x} ${cur.y}`);
        }
      }
      if (closed) {
        const last = anchors[n - 1];
        const first = anchors[0];
        if (last.handleOut || first.handleIn) {
          const cp1x = last.handleOut?.x ?? last.x;
          const cp1y = last.handleOut?.y ?? last.y;
          const cp2x = first.handleIn?.x ?? first.x;
          const cp2y = first.handleIn?.y ?? first.y;
          parts.push(`C${cp1x} ${cp1y} ${cp2x} ${cp2y} ${first.x} ${first.y}`);
        }
        parts.push("Z");
      }
      continue;
    }

    const getPrev = (idx: number) => (idx > 0 ? anchors[idx - 1] : closed ? anchors[n - 1] : null);
    const getNext = (idx: number) => (idx < n - 1 ? anchors[idx + 1] : closed ? anchors[0] : null);

    const isLine = (fromIdx: number, toIdx: number): boolean => {
      const from = anchors[((fromIdx % n) + n) % n];
      const to = anchors[((toIdx % n) + n) % n];
      return !from.handleOut && !to.handleIn;
    };

    const off = (from: { x: number; y: number }, to: { x: number; y: number }, d: number) => {
      const len = Math.sqrt((to.x - from.x) ** 2 + (to.y - from.y) ** 2);
      if (len === 0) return { x: from.x, y: from.y };
      const t = Math.min(d / len, 0.5);
      return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
    };

    const canRoundAt = (idx: number): boolean => {
      const a = anchors[idx];
      const r = a.cornerRadius ?? globalR;
      if (r <= 0 || a.smooth || a.handleIn || a.handleOut) return false;
      const p = getPrev(idx);
      const nx = getNext(idx);
      if (!p || !nx) return false;
      const pi = closed ? ((idx - 1 + n) % n) : (idx - 1);
      if (pi < 0) return false;
      return isLine(pi, idx) && isLine(idx, closed ? ((idx + 1) % n) : (idx + 1));
    };

    const totalSegments = closed ? n : n - 1;

    const getStartPointForAnchor = (idx: number): { x: number; y: number } => {
      const a = anchors[idx];
      if (canRoundAt(idx)) {
        const nx = getNext(idx)!;
        return off(a, nx, a.cornerRadius ?? globalR);
      }
      return { x: a.x, y: a.y };
    };

    const startPt = getStartPointForAnchor(0);
    parts.push(`M${startPt.x} ${startPt.y}`);

    for (let seg = 0; seg < totalSegments; seg++) {
      const fromIdx = seg;
      const toIdx = (seg + 1) % n;
      const fromAnchor = anchors[fromIdx];
      const toAnchor = anchors[toIdx];

      if (fromAnchor.handleOut || toAnchor.handleIn) {
        const cp1x = fromAnchor.handleOut?.x ?? fromAnchor.x;
        const cp1y = fromAnchor.handleOut?.y ?? fromAnchor.y;
        const cp2x = toAnchor.handleIn?.x ?? toAnchor.x;
        const cp2y = toAnchor.handleIn?.y ?? toAnchor.y;
        parts.push(`C${cp1x} ${cp1y} ${cp2x} ${cp2y} ${toAnchor.x} ${toAnchor.y}`);
      } else {
        if (canRoundAt(toIdx)) {
          const r = toAnchor.cornerRadius ?? globalR;
          const pIn = off(toAnchor, fromAnchor, r);
          const nxA = getNext(toIdx)!;
          const pOut = off(toAnchor, nxA, r);
          parts.push(`L${pIn.x} ${pIn.y}`);
          parts.push(`Q${toAnchor.x} ${toAnchor.y} ${pOut.x} ${pOut.y}`);
        } else {
          parts.push(`L${toAnchor.x} ${toAnchor.y}`);
        }
      }
    }

    if (closed) parts.push("Z");
  }

  return parts.join(" ");
}

function sampleCubicBezier(
  p0x: number, p0y: number, cp1x: number, cp1y: number,
  cp2x: number, cp2y: number, p1x: number, p1y: number,
  steps: number
): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    pts.push({
      x: u * u * u * p0x + 3 * u * u * t * cp1x + 3 * u * t * t * cp2x + t * t * t * p1x,
      y: u * u * u * p0y + 3 * u * u * t * cp1y + 3 * u * t * t * cp2y + t * t * t * p1y,
    });
  }
  return pts;
}

export function subPathToSampledPoints(sp: SubPath, samplesPerSegment = 20): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < sp.anchors.length; i++) {
    const a = sp.anchors[i];
    const nextIdx = sp.closed ? (i + 1) % sp.anchors.length : i + 1;
    if (nextIdx >= sp.anchors.length && !sp.closed) {
      pts.push({ x: a.x, y: a.y });
      break;
    }
    const next = sp.anchors[nextIdx];
    if (!next) { pts.push({ x: a.x, y: a.y }); break; }
    if (a.handleOut || next.handleIn) {
      const cp1x = a.handleOut?.x ?? a.x;
      const cp1y = a.handleOut?.y ?? a.y;
      const cp2x = next.handleIn?.x ?? next.x;
      const cp2y = next.handleIn?.y ?? next.y;
      const seg = sampleCubicBezier(a.x, a.y, cp1x, cp1y, cp2x, cp2y, next.x, next.y, samplesPerSegment);
      pts.push(...(i === 0 ? seg : seg.slice(1)));
    } else {
      if (i === 0) pts.push({ x: a.x, y: a.y });
      pts.push({ x: next.x, y: next.y });
    }
  }
  return pts;
}

let paperSetup = false;
/** paper needs a canvas; tests and any headless caller have none. */
export function ensurePaper() {
  if (paperSetup) return;
  if (typeof document === "undefined") {
    paper.setup(new paper.Size(1, 1));
  } else {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    paper.setup(canvas);
  }
  paperSetup = true;
}

function dedupePoints(pts: { x: number; y: number }[]): { x: number; y: number }[] {
  return pts.filter((p, i, a) => i === 0 || Math.hypot(p.x - a[i - 1].x, p.y - a[i - 1].y) > 1e-6);
}

/** Indices where the outline turns too sharply to be one smooth curve. */
function findCorners(pts: { x: number; y: number }[], closed: boolean, angleDeg = 35): number[] {
  const n = pts.length;
  if (n < 5) return [];
  const span = Math.max(1, Math.round(n * 0.02));
  const cosLimit = Math.cos((angleDeg * Math.PI) / 180);
  const found: number[] = [];
  const lo = closed ? 0 : span;
  const hi = closed ? n : n - span;
  for (let i = lo; i < hi; i++) {
    const a = pts[(i - span + n) % n];
    const b = pts[i];
    const c = pts[(i + span) % n];
    const v1x = b.x - a.x, v1y = b.y - a.y;
    const v2x = c.x - b.x, v2y = c.y - b.y;
    const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
    if (l1 < 1e-9 || l2 < 1e-9) continue;
    if ((v1x * v2x + v1y * v2y) / (l1 * l2) < cosLimit) found.push(i);
  }
  // One physical corner trips several samples; keep the first of each cluster.
  const merged: number[] = [];
  for (const i of found) {
    if (merged.length && i - merged[merged.length - 1] <= span) continue;
    merged.push(i);
  }
  return merged;
}

/** Least-squares cubic fit (paper's PathFitter) over one run of points. */
function fitRun(pts: { x: number; y: number }[], closed: boolean, tolerance: number): AnchorPoint[] {
  // paper's fitter does not wrap: on a closed ring the final span is
  // unconstrained and bulges. Repeat the first point, fit as an open run, then
  // fold the duplicate seam back onto the start anchor.
  const src = closed ? [...pts, pts[0]] : pts;
  const path = new paper.Path(src.map((p) => new paper.Point(p.x, p.y)));
  path.simplify(tolerance);
  const anchors: AnchorPoint[] = path.segments.map((seg) => ({
    x: seg.point.x,
    y: seg.point.y,
    handleIn: seg.handleIn.isZero() ? undefined : { x: seg.point.x + seg.handleIn.x, y: seg.point.y + seg.handleIn.y },
    handleOut: seg.handleOut.isZero() ? undefined : { x: seg.point.x + seg.handleOut.x, y: seg.point.y + seg.handleOut.y },
    smooth: true,
  }));
  path.remove();
  if (closed && anchors.length > 1) {
    const seam = anchors.pop()!;
    anchors[0] = { ...anchors[0], handleIn: seam.handleIn };
  }
  return anchors;
}

/** Error a shape can absorb before it reads as a different shape. */
const RELATIVE_TOLERANCE = 0.005;

function simplifySubPath(sp: SubPath, tolerance: number): SubPath {
  const pts = dedupePoints(subPathToSampledPoints(sp, 16));
  if (pts.length < 4) return sp;
  // A flat pixel budget is only meaningful against the shape it is spent on:
  // 8px is invisible on a full-bleed silhouette and eats a small feature whole.
  // Spend at most 1% of this subPath's own diagonal.
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const diag = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  tolerance = Math.min(tolerance, diag * RELATIVE_TOLERANCE);
  const corners = findCorners(pts, sp.closed);
  let anchors: AnchorPoint[];
  if (corners.length < 2) {
    anchors = fitRun(pts, sp.closed, tolerance);
  } else {
    // Fit corner-to-corner so sharp joins stay sharp instead of being rounded off.
    anchors = [];
    for (let c = 0; c < corners.length; c++) {
      const start = corners[c];
      const end = corners[(c + 1) % corners.length];
      const run: { x: number; y: number }[] = [];
      for (let i = start; ; i = (i + 1) % pts.length) {
        run.push(pts[i]);
        if (i === end) break;
      }
      if (run.length < 2) continue;
      const fitted = fitRun(run, false, tolerance);
      // The run's last point is the next run's first; drop the shared tail.
      fitted.pop();
      if (fitted.length) {
        fitted[0] = { ...fitted[0], handleIn: undefined, smooth: false };
        anchors.push(...fitted);
      }
    }
  }
  if (anchors.length === 0 || anchors.length >= sp.anchors.length) return sp;
  return { ...sp, anchors };
}

/**
 * Refit every subPath onto the fewest cubic segments that stay within
 * `tolerance` node-pixels of the original outline.
 */
export function simplifyPathData(pathData: PathData, tolerance = DEFAULT_SIMPLIFY_TOLERANCE): PathData {
  ensurePaper();
  return { ...pathData, subPaths: pathData.subPaths.map((sp) => simplifySubPath(sp, tolerance)) };
}
