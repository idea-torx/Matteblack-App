import { memo } from "react";
import type { RemoteSession } from "./presenceStore";
import { useCursorInterpolation } from "./useCursorInterpolation";
import styles from "./RemoteCursor.module.css";

interface RemoteCursorProps {
  session: RemoteSession;
  panX: number;
  panY: number;
  zoom: number;
}

/**
 * Single remote cursor + name label. Positioned in screen space so the
 * pointer stays the same physical size regardless of canvas zoom, while
 * tracking a world-space coordinate that pans/zooms with the canvas.
 */
function RemoteCursorImpl({ session, panX, panY, zoom }: RemoteCursorProps) {
  const cursor = useCursorInterpolation(session);
  if (!cursor || !cursor.visible) return null;

  const screenX = cursor.x * zoom + panX;
  const screenY = cursor.y * zoom + panY;
  const color = session.color;

  return (
    <div
      className={styles.cursor}
      data-idle={session.idle ? "true" : "false"}
      style={{ transform: `translate3d(${screenX}px, ${screenY}px, 0)` }}
      aria-hidden="true"
    >
      <svg
        className={styles.pointer}
        width="20"
        height="20"
        viewBox="0 0 20 20"
        fill="none"
      >
        <path
          d="M3 2.5 L3 16 L7 12 L9.5 17 L11.5 16 L9 11 L14 11 Z"
          fill={color}
          stroke="#ffffff"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
      </svg>
      {session.avatarUrl && (
        <img className={styles.head} src={session.avatarUrl} alt="" style={{ borderColor: color }} />
      )}
      <span className={styles.label} style={{ background: color }}>
        {session.displayName}
      </span>
    </div>
  );
}

export const RemoteCursor = memo(RemoteCursorImpl);
