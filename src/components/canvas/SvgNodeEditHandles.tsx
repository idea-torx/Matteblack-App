import React from "react";
import { SvgPathOverlay } from "./SvgPathOverlay";
import { SvgEditToolbar, type SvgEditTool } from "./SvgEditToolbar";
import type { PathData } from "../../utils/svgPathModel";

type SvgNodeEditHandlesProps = {
  pathData: PathData;
  nodeWidth: number;
  nodeHeight: number;
  selectedPoints: { subPathIdx: number; anchorIdx: number }[];
  activeGroups: number[];
  enteredGroup: number | null;
  zoom: number;
  rotation?: number;
  isDragging: boolean;
  editTool: SvgEditTool;
  canJoin: boolean;
  canCut: boolean;
  onToolChange: (tool: SvgEditTool) => void;
  onCutAction: () => void;
  onJoinAction: () => void;
  onSimplifyAction: () => void;
  onExit: () => void;
  onDeleteBlobs?: () => void;
  onDownloadBlobs?: () => void;
  onSaveBlobs?: () => void;
  onSelectGroup: (group: number | null, additive: boolean) => void;
  onGroupMovePointerDown: (e: React.PointerEvent, group: number) => void;
  onGroupScalePointerDown: (e: React.PointerEvent, grabX: number, grabY: number, fixedX: number, fixedY: number) => void;
  onGroupRotatePointerDown: (e: React.PointerEvent, grabX: number, grabY: number, cx: number, cy: number) => void;
  onAnchorPointerDown: (e: React.PointerEvent, subPathIdx: number, anchorIdx: number) => void;
  onHandlePointerDown: (e: React.PointerEvent, subPathIdx: number, anchorIdx: number, handleType: "in" | "out") => void;
  onSegmentClick: (e: React.MouseEvent, subPathIdx: number, segmentIdx: number) => void;
};

export function SvgNodeEditHandles({
  pathData,
  nodeWidth,
  nodeHeight,
  selectedPoints,
  activeGroups,
  enteredGroup,
  zoom,
  rotation,
  isDragging,
  editTool,
  canJoin,
  canCut,
  onToolChange,
  onCutAction,
  onJoinAction,
  onSimplifyAction,
  onExit,
  onDeleteBlobs,
  onDownloadBlobs,
  onSaveBlobs,
  onSelectGroup,
  onGroupMovePointerDown,
  onGroupScalePointerDown,
  onGroupRotatePointerDown,
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
        activeGroups={activeGroups}
        enteredGroup={enteredGroup}
        zoom={zoom}
        onSelectGroup={onSelectGroup}
        onGroupMovePointerDown={onGroupMovePointerDown}
        onGroupScalePointerDown={onGroupScalePointerDown}
        onGroupRotatePointerDown={onGroupRotatePointerDown}
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
          onSimplifyAction={onSimplifyAction}
          onExit={onExit}
          blobsActive={enteredGroup === null && activeGroups.length > 0}
          onDeleteBlobs={onDeleteBlobs}
          onDownloadBlobs={onDownloadBlobs}
          onSaveBlobs={onSaveBlobs}
          zoom={zoom}
          rotation={rotation}
          canJoin={canJoin}
          canCut={canCut}
        />
      )}
    </>
  );
}
