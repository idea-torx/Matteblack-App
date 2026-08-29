import paper from "paper";
import type { PathData, SubPath, AnchorPoint } from "./svgPathModel";

export type BooleanOpType = "union" | "subtract" | "intersect" | "exclude" | "flatten";

type NodeInfo = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  pathData: PathData;
};

type BooleanOpResult = {
  pathData: PathData;
  x: number;
  y: number;
  width: number;
  height: number;
};

let paperSetup = false;
function ensurePaper() {
  if (!paperSetup) {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    paper.setup(canvas);
    paperSetup = true;
  }
}

function subPathToPaperPath(sp: SubPath, offsetX: number, offsetY: number): paper.Path {
  const segments: paper.Segment[] = [];
  for (const a of sp.anchors) {
    const point = new paper.Point(a.x + offsetX, a.y + offsetY);
    const handleIn = a.handleIn
      ? new paper.Point(a.handleIn.x + offsetX - point.x, a.handleIn.y + offsetY - point.y)
      : new paper.Point(0, 0);
    const handleOut = a.handleOut
      ? new paper.Point(a.handleOut.x + offsetX - point.x, a.handleOut.y + offsetY - point.y)
      : new paper.Point(0, 0);
    segments.push(new paper.Segment(point, handleIn, handleOut));
  }
  const path = new paper.Path(segments);
  path.closed = sp.closed;
  return path;
}

function pathDataToPaperItem(pathData: PathData, offsetX: number, offsetY: number): paper.PathItem {
  if (pathData.subPaths.length === 1) {
    return subPathToPaperPath(pathData.subPaths[0], offsetX, offsetY);
  }
  const children = pathData.subPaths.map((sp) => subPathToPaperPath(sp, offsetX, offsetY));
  if (children.length === 0) {
    return new paper.Path();
  }
  return new paper.CompoundPath({ children });
}

function paperPathToPathData(item: paper.PathItem, basePathData: PathData): PathData {
  const subPaths: SubPath[] = [];

  const paths: paper.Path[] = [];
  if (item instanceof paper.CompoundPath) {
    for (const child of item.children) {
      if (child instanceof paper.Path) paths.push(child);
    }
  } else if (item instanceof paper.Path) {
    paths.push(item);
  }

  for (const path of paths) {
    const anchors: AnchorPoint[] = [];
    for (const seg of path.segments) {
      const pt = seg.point;
      const hIn = seg.handleIn;
      const hOut = seg.handleOut;
      anchors.push({
        x: pt.x,
        y: pt.y,
        handleIn: (hIn && (Math.abs(hIn.x) > 0.01 || Math.abs(hIn.y) > 0.01))
          ? { x: pt.x + hIn.x, y: pt.y + hIn.y }
          : undefined,
        handleOut: (hOut && (Math.abs(hOut.x) > 0.01 || Math.abs(hOut.y) > 0.01))
          ? { x: pt.x + hOut.x, y: pt.y + hOut.y }
          : undefined,
        smooth: false,
      });
    }
    subPaths.push({ anchors, closed: path.closed });
  }

  return {
    subPaths,
    fill: basePathData.fill,
    stroke: basePathData.stroke,
    strokeWidth: basePathData.strokeWidth,
    opacity: basePathData.opacity,
  };
}

function buildResultFromPaper(resultItem: paper.PathItem, basePathData: PathData): BooleanOpResult {
  const bounds = resultItem.bounds;
  const originX = bounds.x;
  const originY = bounds.y;

  const pathData = paperPathToPathData(resultItem, basePathData);

  for (const sp of pathData.subPaths) {
    for (const a of sp.anchors) {
      a.x -= originX;
      a.y -= originY;
      if (a.handleIn) { a.handleIn.x -= originX; a.handleIn.y -= originY; }
      if (a.handleOut) { a.handleOut.x -= originX; a.handleOut.y -= originY; }
    }
  }

  return {
    pathData,
    x: originX,
    y: originY,
    width: Math.max(bounds.width, 1),
    height: Math.max(bounds.height, 1),
  };
}

export function performBooleanOp(
  op: BooleanOpType,
  nodes: NodeInfo[],
): BooleanOpResult | null {
  if (nodes.length < 2) return null;
  ensurePaper();

  try {
    const paperPaths = nodes.map((n) =>
      pathDataToPaperItem(n.pathData, n.x, n.y)
    );

    let result: paper.PathItem;

    switch (op) {
      case "union": {
        result = paperPaths[0];
        for (let i = 1; i < paperPaths.length; i++) {
          result = result.unite(paperPaths[i]);
        }
        break;
      }
      case "subtract": {
        result = paperPaths[0];
        for (let i = 1; i < paperPaths.length; i++) {
          result = result.subtract(paperPaths[i]);
        }
        break;
      }
      case "intersect": {
        result = paperPaths[0];
        for (let i = 1; i < paperPaths.length; i++) {
          result = result.intersect(paperPaths[i]);
        }
        break;
      }
      case "exclude": {
        result = paperPaths[0];
        for (let i = 1; i < paperPaths.length; i++) {
          result = result.exclude(paperPaths[i]);
        }
        break;
      }
      case "flatten": {
        result = paperPaths[0];
        for (let i = 1; i < paperPaths.length; i++) {
          result = result.unite(paperPaths[i]);
        }
        break;
      }
      default:
        return null;
    }

    const boolResult = buildResultFromPaper(result, nodes[0].pathData);

    for (const p of paperPaths) p.remove();
    result.remove();

    return boolResult;
  } catch (e) {
    console.error("Boolean operation failed:", e);
    return fallbackCombine(op, nodes);
  }
}

function fallbackCombine(op: BooleanOpType, nodes: NodeInfo[]): BooleanOpResult {
  const allSubPaths: SubPath[] = [];
  for (const n of nodes) {
    for (const sp of n.pathData.subPaths) {
      const anchors: AnchorPoint[] = sp.anchors.map((a) => ({
        x: a.x + n.x,
        y: a.y + n.y,
        handleIn: a.handleIn ? { x: a.handleIn.x + n.x, y: a.handleIn.y + n.y } : undefined,
        handleOut: a.handleOut ? { x: a.handleOut.x + n.x, y: a.handleOut.y + n.y } : undefined,
        smooth: a.smooth,
      }));
      allSubPaths.push({ anchors, closed: sp.closed });
    }
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const sp of allSubPaths) {
    for (const a of sp.anchors) {
      minX = Math.min(minX, a.x); minY = Math.min(minY, a.y);
      maxX = Math.max(maxX, a.x); maxY = Math.max(maxY, a.y);
      if (a.handleIn) { minX = Math.min(minX, a.handleIn.x); minY = Math.min(minY, a.handleIn.y); maxX = Math.max(maxX, a.handleIn.x); maxY = Math.max(maxY, a.handleIn.y); }
      if (a.handleOut) { minX = Math.min(minX, a.handleOut.x); minY = Math.min(minY, a.handleOut.y); maxX = Math.max(maxX, a.handleOut.x); maxY = Math.max(maxY, a.handleOut.y); }
    }
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 100; maxY = 100; }

  for (const sp of allSubPaths) {
    for (const a of sp.anchors) {
      a.x -= minX; a.y -= minY;
      if (a.handleIn) { a.handleIn.x -= minX; a.handleIn.y -= minY; }
      if (a.handleOut) { a.handleOut.x -= minX; a.handleOut.y -= minY; }
    }
  }

  return {
    pathData: {
      subPaths: allSubPaths,
      fill: nodes[0].pathData.fill,
      stroke: nodes[0].pathData.stroke,
      strokeWidth: nodes[0].pathData.strokeWidth,
      opacity: nodes[0].pathData.opacity,
      fillRule: op === "subtract" || op === "exclude" || op === "intersect" ? "evenodd" : "nonzero",
    },
    x: minX,
    y: minY,
    width: Math.max(maxX - minX, 1),
    height: Math.max(maxY - minY, 1),
  };
}
