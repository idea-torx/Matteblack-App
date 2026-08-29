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

export function extractPathDataFromSvg(svgContent: string, nodeWidth: number, nodeHeight: number): PathData | null {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgContent, "image/svg+xml");
    const svgEl = doc.querySelector("svg");
    const pathEl = doc.querySelector("path");
    if (!pathEl) return null;

    const d = pathEl.getAttribute("d");
    if (!d) return null;

    let vbX = 0, vbY = 0, vbW = nodeWidth, vbH = nodeHeight;
    const viewBox = svgEl?.getAttribute("viewBox");
    if (viewBox) {
      const parts = viewBox.split(/[\s,]+/).map(Number);
      if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
        [vbX, vbY, vbW, vbH] = parts;
      }
    }

    const commands = parseDAttribute(d);
    const subPaths = commandsToSubPaths(commands);

    const scaleX = nodeWidth / vbW;
    const scaleY = nodeHeight / vbH;
    for (const sp of subPaths) {
      for (const a of sp.anchors) {
        a.x = (a.x - vbX) * scaleX;
        a.y = (a.y - vbY) * scaleY;
        if (a.handleIn) { a.handleIn.x = (a.handleIn.x - vbX) * scaleX; a.handleIn.y = (a.handleIn.y - vbY) * scaleY; }
        if (a.handleOut) { a.handleOut.x = (a.handleOut.x - vbX) * scaleX; a.handleOut.y = (a.handleOut.y - vbY) * scaleY; }
      }
    }

    const fill = pathEl.getAttribute("fill") || svgEl?.getAttribute("fill") || undefined;
    const stroke = pathEl.getAttribute("stroke") || svgEl?.getAttribute("stroke") || undefined;
    const sw = pathEl.getAttribute("stroke-width") || svgEl?.getAttribute("stroke-width") || undefined;
    const op = pathEl.getAttribute("opacity") || svgEl?.getAttribute("opacity") || undefined;

    return {
      subPaths,
      fill: fill && fill !== "none" ? fill : undefined,
      stroke: stroke && stroke !== "none" ? stroke : undefined,
      strokeWidth: sw ? parseFloat(sw) : undefined,
      opacity: op ? parseFloat(op) : undefined,
    };
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

function subPathToSampledPoints(sp: SubPath, samplesPerSegment = 20): { x: number; y: number }[] {
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

function segmentMaxDeviationWrapped(
  sampled: { x: number; y: number }[],
  fromIdx: number,
  toIdx: number
): number {
  const a = sampled[fromIdx];
  const b = sampled[toIdx % sampled.length];
  let maxDev = 0;
  const total = sampled.length;
  const count = fromIdx <= toIdx
    ? toIdx - fromIdx - 1
    : (total - fromIdx - 1) + toIdx;
  for (let step = 1; step <= count; step++) {
    const idx = (fromIdx + step) % total;
    const d = pointToLineDistance(sampled[idx], a, b);
    if (d > maxDev) maxDev = d;
  }
  return maxDev;
}

function fitSmartPath(
  simplified: { x: number; y: number }[],
  sampled: { x: number; y: number }[],
  curveTolerance: number,
  closed: boolean
): SubPath {
  const simplifiedIndices: number[] = simplified.map((sp) => {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < sampled.length; i++) {
      const d = Math.hypot(sampled[i].x - sp.x, sampled[i].y - sp.y);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    return bestIdx;
  });

  if (closed) {
    simplifiedIndices.sort((a, b) => a - b);
  }

  const segCount = closed ? simplified.length : simplified.length - 1;

  const sortedSimplified = closed
    ? simplifiedIndices.map((si) => sampled[si])
    : simplified;

  const segIsCurved: boolean[] = [];

  for (let i = 0; i < segCount; i++) {
    const fromSampleIdx = simplifiedIndices[i];
    const toSampleIdx = closed
      ? simplifiedIndices[(i + 1) % simplified.length]
      : simplifiedIndices[i + 1];

    let samplesBetween: number;
    if (closed && i === segCount - 1) {
      samplesBetween = (sampled.length - fromSampleIdx) + toSampleIdx - 1;
    } else if (toSampleIdx > fromSampleIdx) {
      samplesBetween = toSampleIdx - fromSampleIdx - 1;
    } else {
      samplesBetween = (sampled.length - fromSampleIdx) + toSampleIdx - 1;
    }

    if (samplesBetween <= 0) {
      segIsCurved.push(false);
    } else {
      const dev = segmentMaxDeviationWrapped(sampled, fromSampleIdx, toSampleIdx);
      segIsCurved.push(dev > curveTolerance);
    }
  }

  const pts = closed ? sortedSimplified : simplified;
  const n = pts.length;
  const anchors: AnchorPoint[] = pts.map((pt, i) => {
    const prevSeg = closed ? (i - 1 + segCount) % segCount : i - 1;
    const nextSeg = i;
    const needsHandleIn = prevSeg >= 0 && segIsCurved[prevSeg];
    const needsHandleOut = nextSeg < segCount && segIsCurved[nextSeg];

    if (!needsHandleIn && !needsHandleOut) {
      return { x: pt.x, y: pt.y, smooth: false };
    }

    const prevPt = closed ? pts[(i - 1 + n) % n] : (i > 0 ? pts[i - 1] : null);
    const nextPt = closed ? pts[(i + 1) % n] : (i < n - 1 ? pts[i + 1] : null);

    let dx = 0, dy = 0;
    if (prevPt && nextPt) {
      dx = nextPt.x - prevPt.x;
      dy = nextPt.y - prevPt.y;
    } else if (nextPt) {
      dx = nextPt.x - pt.x;
      dy = nextPt.y - pt.y;
    } else if (prevPt) {
      dx = pt.x - prevPt.x;
      dy = pt.y - prevPt.y;
    }
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;

    const anchor: AnchorPoint = { x: pt.x, y: pt.y, smooth: true };

    if (needsHandleIn && prevPt) {
      const dist = Math.min(Math.hypot(pt.x - prevPt.x, pt.y - prevPt.y) / 3, 30);
      anchor.handleIn = { x: pt.x - ux * dist, y: pt.y - uy * dist };
    }
    if (needsHandleOut && nextPt) {
      const dist = Math.min(Math.hypot(nextPt.x - pt.x, nextPt.y - pt.y) / 3, 30);
      anchor.handleOut = { x: pt.x + ux * dist, y: pt.y + uy * dist };
    }

    return anchor;
  });

  return { anchors, closed };
}

function rdpSimplifyClosed(points: { x: number; y: number }[], epsilon: number): { x: number; y: number }[] {
  if (points.length <= 4) return points;

  let maxDist = 0;
  let splitIdx = 0;
  for (let i = 0; i < points.length; i++) {
    const opposite = (i + Math.floor(points.length / 2)) % points.length;
    const d = Math.hypot(points[i].x - points[opposite].x, points[i].y - points[opposite].y);
    if (d > maxDist) { maxDist = d; splitIdx = i; }
  }

  const oppositeIdx = (splitIdx + Math.floor(points.length / 2)) % points.length;
  const half1: { x: number; y: number }[] = [];
  const half2: { x: number; y: number }[] = [];

  let idx = splitIdx;
  while (true) {
    half1.push(points[idx]);
    if (idx === oppositeIdx) break;
    idx = (idx + 1) % points.length;
  }
  idx = oppositeIdx;
  while (true) {
    half2.push(points[idx]);
    if (idx === splitIdx) break;
    idx = (idx + 1) % points.length;
  }

  const s1 = rdpSimplify(half1, epsilon);
  const s2 = rdpSimplify(half2, epsilon);

  const result = [...s1];
  for (let i = 1; i < s2.length - 1; i++) {
    result.push(s2[i]);
  }
  return result;
}

function computeAdaptiveTolerance(sp: SubPath): number {
  if (sp.anchors.length <= 2) return 3;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const a of sp.anchors) {
    if (a.x < minX) minX = a.x;
    if (a.y < minY) minY = a.y;
    if (a.x > maxX) maxX = a.x;
    if (a.y > maxY) maxY = a.y;
  }
  const diag = Math.hypot(maxX - minX, maxY - minY) || 1;

  let totalSegLen = 0;
  for (let i = 1; i < sp.anchors.length; i++) {
    totalSegLen += Math.hypot(
      sp.anchors[i].x - sp.anchors[i - 1].x,
      sp.anchors[i].y - sp.anchors[i - 1].y
    );
  }
  if (sp.closed && sp.anchors.length > 1) {
    totalSegLen += Math.hypot(
      sp.anchors[0].x - sp.anchors[sp.anchors.length - 1].x,
      sp.anchors[0].y - sp.anchors[sp.anchors.length - 1].y
    );
  }

  const avgSegLen = totalSegLen / sp.anchors.length;
  const density = diag / (avgSegLen || 1);

  const tol = diag * 0.02 * Math.max(1, density / 3);
  return Math.max(3, Math.min(tol, diag * 0.15));
}

export function simplifyPathData(pathData: PathData): PathData {
  const newSubPaths = pathData.subPaths.map((sp) => {
    if (sp.anchors.length <= 2) return sp;

    const tolerance = computeAdaptiveTolerance(sp);

    const sampled = subPathToSampledPoints(sp, 20);
    if (sampled.length < 3) return sp;

    let simplified: { x: number; y: number }[];

    if (sp.closed) {
      const unique = sampled.filter((p, i, arr) => {
        if (i === 0) return true;
        return Math.hypot(p.x - arr[i - 1].x, p.y - arr[i - 1].y) > 0.01;
      });
      const lastFirst = Math.hypot(
        unique[unique.length - 1].x - unique[0].x,
        unique[unique.length - 1].y - unique[0].y
      );
      const pts = lastFirst < tolerance ? unique.slice(0, -1) : unique;
      if (pts.length < 3) return sp;

      simplified = rdpSimplifyClosed(pts, tolerance);
      if (simplified.length < 3) return sp;
    } else {
      simplified = rdpSimplify(sampled, tolerance);
      if (simplified.length < 2) return sp;
    }

    return fitSmartPath(simplified, sampled, tolerance, sp.closed);
  });

  return { ...pathData, subPaths: newSubPaths };
}
