import React from "react";
import type { PathData } from "../../utils/svgPathModel";

type SelectedPoint = {
  subPathIdx: number;
  anchorIdx: number;
};

type SvgPathOverlayProps = {
  pathData: PathData;
  nodeWidth: number;
  nodeHeight: number;
  selectedPoints: SelectedPoint[];
  zoom: number;
  onAnchorPointerDown: (e: React.PointerEvent, subPathIdx: number, anchorIdx: number) => void;
  onHandlePointerDown: (e: React.PointerEvent, subPathIdx: number, anchorIdx: number, handleType: "in" | "out") => void;
  onSegmentClick?: (e: React.MouseEvent, subPathIdx: number, segmentIdx: number) => void;
};

const ANCHOR_SIZE = 12;
const HANDLE_SIZE = 10;
const HIT_AREA_SIZE = 36;
const SEGMENT_HIT_WIDTH = 24;
const STROKE_COLOR = "#2196F3";
const HANDLE_LINE_COLOR = "#90CAF9";
const MIN_HANDLE_SCREEN_DIST = 32;

export function SvgPathOverlay({
  pathData,
  nodeWidth,
  nodeHeight,
  selectedPoints,
  zoom,
  onAnchorPointerDown,
  onHandlePointerDown,
  onSegmentClick,
}: SvgPathOverlayProps) {
  let vbW = 0;
  let vbH = 0;
  for (const sp of pathData.subPaths) {
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
  vbW = vbW || nodeWidth;
  vbH = vbH || nodeHeight;

  const vbScaleX = nodeWidth / vbW;
  const vbScaleY = nodeHeight / vbH;
  const invZoomX = 1 / Math.max(zoom * vbScaleX, 0.1);
  const invZoomY = 1 / Math.max(zoom * vbScaleY, 0.1);
  const invZoomAvg = (invZoomX + invZoomY) / 2;
  const minDistVb = MIN_HANDLE_SCREEN_DIST * invZoomAvg;
  const selectedSet = new Set(selectedPoints.map((p) => `${p.subPathIdx}-${p.anchorIdx}`));

  return (
    <svg
      width={nodeWidth}
      height={nodeHeight}
      viewBox={`0 0 ${vbW} ${vbH}`}
      preserveAspectRatio="none"
      style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none", overflow: "visible" }}
    >
      {pathData.subPaths.map((sp, si) => {
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
                strokeWidth={1.5 * invZoomAvg}
                strokeDasharray={`${4 * invZoomAvg} ${3 * invZoomAvg}`}
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

          if (a.handleIn) {
            const hdx = a.handleIn.x - a.x;
            const hdy = a.handleIn.y - a.y;
            const hDist = Math.hypot(hdx, hdy);
            let hiX = a.handleIn.x, hiY = a.handleIn.y;
            if (hDist > 0 && hDist < minDistVb) {
              const s = minDistVb / hDist;
              hiX = a.x + hdx * s;
              hiY = a.y + hdy * s;
            }
            elements.push(
              <line key={`hi-line-${si}-${ai}`} x1={a.x} y1={a.y} x2={hiX} y2={hiY} stroke={HANDLE_LINE_COLOR} strokeWidth={1 * invZoomAvg} style={{ pointerEvents: "none" }} />,
              <ellipse
                key={`hi-hit-${si}-${ai}`}
                cx={hiX} cy={hiY} rx={hitSzX / 2} ry={hitSzY / 2}
                fill="transparent"
                style={{ pointerEvents: "auto", cursor: "pointer" }}
                onPointerDown={(e) => { e.stopPropagation(); onHandlePointerDown(e, si, ai, "in"); }}
              />,
              <ellipse
                key={`hi-${si}-${ai}`}
                cx={hiX} cy={hiY} rx={HANDLE_SIZE * invZoomX} ry={HANDLE_SIZE * invZoomY}
                fill="white" stroke={STROKE_COLOR} strokeWidth={1.5 * invZoomAvg}
                style={{ pointerEvents: "none" }}
              />
            );
          }
          if (a.handleOut) {
            const hdx = a.handleOut.x - a.x;
            const hdy = a.handleOut.y - a.y;
            const hDist = Math.hypot(hdx, hdy);
            let hoX = a.handleOut.x, hoY = a.handleOut.y;
            if (hDist > 0 && hDist < minDistVb) {
              const s = minDistVb / hDist;
              hoX = a.x + hdx * s;
              hoY = a.y + hdy * s;
            }
            elements.push(
              <line key={`ho-line-${si}-${ai}`} x1={a.x} y1={a.y} x2={hoX} y2={hoY} stroke={HANDLE_LINE_COLOR} strokeWidth={1 * invZoomAvg} style={{ pointerEvents: "none" }} />,
              <ellipse
                key={`ho-hit-${si}-${ai}`}
                cx={hoX} cy={hoY} rx={hitSzX / 2} ry={hitSzY / 2}
                fill="transparent"
                style={{ pointerEvents: "auto", cursor: "pointer" }}
                onPointerDown={(e) => { e.stopPropagation(); onHandlePointerDown(e, si, ai, "out"); }}
              />,
              <ellipse
                key={`ho-${si}-${ai}`}
                cx={hoX} cy={hoY} rx={HANDLE_SIZE * invZoomX} ry={HANDLE_SIZE * invZoomY}
                fill="white" stroke={STROKE_COLOR} strokeWidth={1.5 * invZoomAvg}
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
            <rect
              key={`anchor-${si}-${ai}`}
              x={a.x - szX / 2} y={a.y - szY / 2} width={szX} height={szY}
              fill={isSelected ? STROKE_COLOR : "white"}
              stroke={STROKE_COLOR}
              strokeWidth={1.5 * invZoomAvg}
              style={{ pointerEvents: "none" }}
            />
          );
        }

        return <g key={`sp-${si}`}>{elements}</g>;
      })}
    </svg>
  );
}
