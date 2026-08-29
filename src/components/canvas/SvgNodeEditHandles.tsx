import React from "react";
import { SvgPathOverlay } from "./SvgPathOverlay";
import { SvgEditToolbar, type SvgEditTool } from "./SvgEditToolbar";
import type { PathData } from "../../utils/svgPathModel";

type SvgNodeEditHandlesProps = {
  pathData: PathData;
  nodeWidth: number;
  nodeHeight: number;
  selectedPoints: { subPathIdx: number; anchorIdx: number }[];
  zoom: number;
  isDragging: boolean;
  editTool: SvgEditTool;
  canJoin: boolean;
  canCut: boolean;
  onToolChange: (tool: SvgEditTool) => void;
  onCutAction: () => void;
  onJoinAction: () => void;
  onExit: () => void;
  onAnchorPointerDown: (e: React.PointerEvent, subPathIdx: number, anchorIdx: number) => void;
  onHandlePointerDown: (e: React.PointerEvent, subPathIdx: number, anchorIdx: number, handleType: "in" | "out") => void;
  onSegmentClick: (e: React.MouseEvent, subPathIdx: number, segmentIdx: number) => void;
};

export function SvgNodeEditHandles({
  pathData,
  nodeWidth,
  nodeHeight,
  selectedPoints,
  zoom,
  isDragging,
  editTool,
  canJoin,
  canCut,
  onToolChange,
  onCutAction,
  onJoinAction,
  onExit,
  onAnchorPointerDown,
  onHandlePointerDown,
  onSegmentClick,
}: SvgNodeEditHandlesProps) {
  return (
    <>
      <SvgPathOverlay
        pathData={pathData}
        nodeWidth={nodeWidth}
        nodeHeight={nodeHeight}
        selectedPoints={selectedPoints}
        zoom={zoom}
        onAnchorPointerDown={onAnchorPointerDown}
        onHandlePointerDown={onHandlePointerDown}
        onSegmentClick={onSegmentClick}
      />
      {!isDragging && (
        <SvgEditToolbar
          activeTool={editTool}
          onToolChange={onToolChange}
          onCutAction={onCutAction}
          onJoinAction={onJoinAction}
          onExit={onExit}
          zoom={zoom}
          canJoin={canJoin}
          canCut={canCut}
        />
      )}
    </>
  );
}
