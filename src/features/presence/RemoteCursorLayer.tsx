import { memo } from "react";
import { useRemoteSessions } from "./presenceStore";
import { RemoteCursor } from "./RemoteCursor";

interface RemoteCursorLayerProps {
  panX: number;
  panY: number;
  zoom: number;
}

/**
 * Absolute overlay covering the canvas viewport. Renders one RemoteCursor
 * per peer session. Sits on top of the canvas content (above nodes) but
 * below toolbars; pointer events disabled so it never blocks interaction.
 */
function RemoteCursorLayerImpl({ panX, panY, zoom }: RemoteCursorLayerProps) {
  const sessions = useRemoteSessions();
  if (sessions.length === 0) return null;
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        overflow: "hidden",
        zIndex: 15,
      }}
    >
      {sessions.map((session) => (
        <RemoteCursor
          key={session.sessionId}
          session={session}
          panX={panX}
          panY={panY}
          zoom={zoom}
        />
      ))}
    </div>
  );
}

export const RemoteCursorLayer = memo(RemoteCursorLayerImpl);
