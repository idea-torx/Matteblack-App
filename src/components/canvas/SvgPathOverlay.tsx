import React from "react";
import { buildDWithRadius, type PathData } from "../../utils/svgPathModel";

type SelectedPoint = {
  subPathIdx: number;
  anchorIdx: number;
};

type SvgPathOverlayProps = {
  pathData: PathData;
  nodeWidth: number;
  nodeHeight: number;
  selectedPoints: SelectedPoint[];
  /** Which shapes are opened for point editing; empty = pick one first. */
  activeGroups: number[];
  /** The one shape you are inside; only its points are drawn. */
  enteredGroup: number | null;
  zoom: number;
  onSelectGroup: (group: number | null, additive: boolean) => void;
  onGroupMovePointerDown: (e: React.PointerEvent, group: number) => void;
  onGroupScalePointerDown: (e: React.PointerEvent, grabX: number, grabY: number, fixedX: number, fixedY: number) => void;
  onGroupRotatePointerDown: (e: React.PointerEvent, grabX: number, grabY: number, cx: number, cy: number) => void;
  onAnchorPointerDown: (e: React.PointerEvent, subPathIdx: number, anchorIdx: number) => void;
  onHandlePointerDown: (e: React.PointerEvent, subPathIdx: number, anchorIdx: number, handleType: "in" | "out") => void;
  onSegmentClick?: (e: React.MouseEvent, subPathIdx: number, segmentIdx: number) => void;
};

// Small dots, generous invisible hit boxes: the target you aim at is far
// bigger than the mark you see.
const ANCHOR_SIZE = 7;
const HANDLE_RADIUS = 4;
const HIT_AREA_SIZE = 24;
const SEGMENT_HIT_WIDTH = 16;
const GRIP_SIZE = 9;
const STROKE_COLOR = "#2196F3";
const HANDLE_LINE_COLOR = "#90CAF9";
const MIN_HANDLE_SCREEN_DIST = 24;

/** The shape a subPath belongs to: one source path element, holes included. */
const groupOf = (sp: PathData["subPaths"][number], i: number) => sp.group ?? i;

export function SvgPathOverlay({
  pathData,
  nodeWidth,
  nodeHeight,
  selectedPoints,
  activeGroups,
  enteredGroup,
  zoom,
  onSelectGroup,
  onGroupMovePointerDown,
  onGroupScalePointerDown,
  onGroupRotatePointerDown,
  onAnchorPointerDown,
  onHandlePointerDown,
  onSegmentClick,
}: SvgPathOverlayProps) {
  // The path is drawn through pathData.viewBox, so the overlay has to use the
  // same one. Deriving a box from the anchors' own extent stretches every point
  // away from the artwork it is supposed to sit on.
  const vbW = pathData.viewBox?.width || nodeWidth;
  const vbH = pathData.viewBox?.height || nodeHeight;
  const vbX = pathData.viewBox?.x ?? 0;
  const vbY = pathData.viewBox?.y ?? 0;

  const invZoomX = 1 / Math.max(zoom * (nodeWidth / vbW), 0.1);
  const invZoomY = 1 / Math.max(zoom * (nodeHeight / vbH), 0.1);
  const invZoomAvg = (invZoomX + invZoomY) / 2;
  const minDistVb = MIN_HANDLE_SCREEN_DIST * invZoomAvg;
  const selectedSet = new Set(selectedPoints.map((p) => `${p.subPathIdx}-${p.anchorIdx}`));

  const active = new Set(activeGroups);
  const groups = new Map<number, number[]>();
  pathData.subPaths.forEach((sp, i) => {
    const g = groupOf(sp, i);
    const list = groups.get(g);
    if (list) list.push(i); else groups.set(g, [i]);
  });

  return (
    <svg
      width={nodeWidth}
      height={nodeHeight}
      viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`}
      preserveAspectRatio="none"
      // Anything the overlay handles is point editing, never node selection: a
      // shift-click that reaches the node toggles it out of the canvas
      // selection and takes the whole editor down with it.
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none", overflow: "visible" }}
    >
      <defs>
        <pattern id="svg-edit-active" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform={`rotate(45) scale(${invZoomAvg})`}>
          <line x1="0" y1="0" x2="0" y2="8" stroke={STROKE_COLOR} strokeWidth="2" />
        </pattern>
      </defs>

      {/* Every shape is a container: click one to open it, like a Figma group. */}
      {[...groups.entries()].map(([g, idxs]) => {
        const isActive = active.has(g);
        const d = idxs.map((i) => buildDWithRadius({ subPaths: [pathData.subPaths[i]] })).join(" ");
        return (
          <path
            key={`shape-${g}`}
            d={d}
            fill={isActive ? "url(#svg-edit-active)" : "transparent"}
            fillOpacity={isActive ? 0.55 : 1}
            fillRule={pathData.subPaths[idxs[0]].fillRule ?? "nonzero"}
            stroke={isActive ? STROKE_COLOR : "transparent"}
            strokeWidth={1 * invZoomAvg}
            // An open shape stays clickable: otherwise a shift-click inside it
            // falls through and lands on whatever large shape sits underneath.
            style={{ pointerEvents: "fill", cursor: isActive ? "move" : "pointer" }}
            onPointerDown={(e) => {
              e.stopPropagation();
              // Already picked: hand it to the mover, which decides on pointer-up
              // whether that press was a drag or the click that goes inside.
              if (isActive) onGroupMovePointerDown(e, g);
              else onSelectGroup(g, e.shiftKey || e.metaKey || e.ctrlKey);
            }}
          />
        );
      })}

      {pathData.subPaths.map((sp, si) => {
        if (groupOf(sp, si) !== enteredGroup) return null;
        const elements: React.ReactNode[] = [];

        for (let ai = 0; ai < sp.anchors.length; ai++) {
          const a = sp.anchors[ai];
          const nextIdx = sp.closed ? (ai + 1) % sp.anchors.length : ai + 1;
          if (nextIdx < sp.anchors.length || (sp.closed && ai < sp.anchors.length)) {
            const next = sp.anchors[nextIdx];
            if (!next) continue;
            let segD: string;
            if (a.handleOut || next.handleIn) {
              const cp1x = a.handleOut?.x ?? a.x;
              const cp1y = a.handleOut?.y ?? a.y;
              const cp2x = next.handleIn?.x ?? next.x;
              const cp2y = next.handleIn?.y ?? next.y;
              segD = `M${a.x} ${a.y} C${cp1x} ${cp1y} ${cp2x} ${cp2y} ${next.x} ${next.y}`;
            } else {
              segD = `M${a.x} ${a.y} L${next.x} ${next.y}`;
            }
            elements.push(
              <path
                key={`seg-hit-${si}-${ai}`}
                d={segD}
                fill="none"
                stroke="transparent"
                strokeWidth={SEGMENT_HIT_WIDTH * invZoomAvg}
                style={{ pointerEvents: "stroke", cursor: "crosshair" }}
                onClick={(e) => { e.stopPropagation(); onSegmentClick?.(e, si, ai); }}
              />,
              <path
                key={`seg-${si}-${ai}`}
                d={segD}
                fill="none"
                stroke={STROKE_COLOR}
                strokeWidth={1 * invZoomAvg}
                style={{ pointerEvents: "none" }}
              />
            );
          }
        }

        for (let ai = 0; ai < sp.anchors.length; ai++) {
          const a = sp.anchors[ai];
          const isSelected = selectedSet.has(`${si}-${ai}`);
          const szX = ANCHOR_SIZE * invZoomX;
          const szY = ANCHOR_SIZE * invZoomY;

          const hitSzX = HIT_AREA_SIZE * invZoomX;
          const hitSzY = HIT_AREA_SIZE * invZoomY;

          // Handles only clutter the shape until the point they belong to is
          // picked, which is how Figma keeps a dense outline readable.
          for (const which of ["in", "out"] as const) {
            const h = which === "in" ? a.handleIn : a.handleOut;
            if (!h || !isSelected) continue;
            const hdx = h.x - a.x;
            const hdy = h.y - a.y;
            const hDist = Math.hypot(hdx, hdy);
            let hx = h.x, hy = h.y;
            if (hDist > 0 && hDist < minDistVb) {
              const s = minDistVb / hDist;
              hx = a.x + hdx * s;
              hy = a.y + hdy * s;
            }
            elements.push(
              <line key={`h-line-${which}-${si}-${ai}`} x1={a.x} y1={a.y} x2={hx} y2={hy} stroke={HANDLE_LINE_COLOR} strokeWidth={1 * invZoomAvg} style={{ pointerEvents: "none" }} />,
              <ellipse
                key={`h-hit-${which}-${si}-${ai}`}
                cx={hx} cy={hy} rx={hitSzX / 2} ry={hitSzY / 2}
                fill="transparent"
                style={{ pointerEvents: "auto", cursor: "pointer" }}
                onPointerDown={(e) => { e.stopPropagation(); onHandlePointerDown(e, si, ai, which); }}
              />,
              <ellipse
                key={`h-${which}-${si}-${ai}`}
                cx={hx} cy={hy} rx={HANDLE_RADIUS * invZoomX} ry={HANDLE_RADIUS * invZoomY}
                fill="white" stroke={STROKE_COLOR} strokeWidth={1 * invZoomAvg}
                style={{ pointerEvents: "none" }}
              />
            );
          }

          elements.push(
            <rect
              key={`anchor-hit-${si}-${ai}`}
              x={a.x - hitSzX / 2} y={a.y - hitSzY / 2} width={hitSzX} height={hitSzY}
              fill="transparent"
              style={{ pointerEvents: "auto", cursor: "move" }}
              onPointerDown={(e) => { e.stopPropagation(); onAnchorPointerDown(e, si, ai); }}
            />,
            <ellipse
              key={`anchor-${si}-${ai}`}
              cx={a.x} cy={a.y} rx={szX / 2} ry={szY / 2}
              fill={isSelected ? STROKE_COLOR : "white"}
              stroke={STROKE_COLOR}
              strokeWidth={1 * invZoomAvg}
              style={{ pointerEvents: "none" }}
            />
          );
        }

        return <g key={`sp-${si}`}>{elements}</g>;
      })}

      {/* One box around everything that is open, so the shapes scale together. */}
      {(() => {
        if (active.size === 0 || enteredGroup !== null) return null;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        pathData.subPaths.forEach((sp, i) => {
          if (!active.has(groupOf(sp, i))) return;
          for (const a of sp.anchors) {
            for (const p of [a, a.handleIn, a.handleOut]) {
              if (!p) continue;
              x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
              x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
            }
          }
        });
        if (!(x1 > x0) || !(y1 > y0)) return null;
        const gx = GRIP_SIZE * invZoomX, gy = GRIP_SIZE * invZoomY;
        const corners: [number, number][] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
        return (
          <g>
            <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0}
              fill="none" stroke={STROKE_COLOR} strokeWidth={1 * invZoomAvg}
              strokeDasharray={`${4 * invZoomAvg} ${3 * invZoomAvg}`}
              style={{ pointerEvents: "none" }} />
            {/* Rotate: a grip on a stalk above the box, turning about its centre. */}
            {(() => {
              const mx = (x0 + x1) / 2, cy2 = (y0 + y1) / 2;
              const stalk = 22 * invZoomY;
              const ry = y0 - stalk;
              return (
                <>
                  <line x1={mx} y1={y0} x2={mx} y2={ry} stroke={STROKE_COLOR} strokeWidth={1 * invZoomAvg} style={{ pointerEvents: "none" }} />
                  <circle cx={mx} cy={ry} r={(GRIP_SIZE / 2) * invZoomAvg}
                    fill="white" stroke={STROKE_COLOR} strokeWidth={1 * invZoomAvg}
                    style={{ pointerEvents: "auto", cursor: "grab" }}
                    onPointerDown={(e) => onGroupRotatePointerDown(e, mx, ry, mx, cy2)} />
                </>
              );
            })()}
            {corners.map(([cx, cy], i) => (
              <rect key={`grip-${i}`}
                x={cx - gx / 2} y={cy - gy / 2} width={gx} height={gy}
                fill="white" stroke={STROKE_COLOR} strokeWidth={1 * invZoomAvg}
                style={{ pointerEvents: "auto", cursor: i % 2 === 0 ? "nwse-resize" : "nesw-resize" }}
                onPointerDown={(e) => onGroupScalePointerDown(e, cx, cy, corners[(i + 2) % 4][0], corners[(i + 2) % 4][1])} />
            ))}
          </g>
        );
      })()}
    </svg>
  );
}
