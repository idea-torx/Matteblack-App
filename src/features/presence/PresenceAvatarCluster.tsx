import { memo, useState } from "react";
import { useRemoteSessions, usePresenceStore, type RemoteSession } from "./presenceStore";
import { initialsForName } from "./presenceColors";
import styles from "./PresenceAvatarCluster.module.css";

const MAX_VISIBLE = 4;

/**
 * Collapse multiple presence sessions for the same signed-in user into a
 * single avatar. This handles the common cases where a person opens the
 * canvas in two tabs, reconnects after a flaky network, or briefly holds
 * a stale SSE session while a new one is being registered. The most
 * recently joined session wins so the avatar reflects the user's freshest
 * cursor / idle state. Guests (userId === null) are kept separate — each
 * anonymous tab is genuinely a different presence from the server's POV.
 *
 * Also drops any session whose userId matches the local viewer, so the
 * viewer never sees a "ghost of themselves" if their own browser holds
 * two open tabs.
 */
function dedupeAndExcludeSelf(
  sessions: RemoteSession[],
  selfUserId: string | null,
): RemoteSession[] {
  const byUser = new Map<string, RemoteSession>();
  const guests: RemoteSession[] = [];
  for (const s of sessions) {
    if (selfUserId && s.userId === selfUserId) continue;
    if (!s.userId) {
      guests.push(s);
      continue;
    }
    const prev = byUser.get(s.userId);
    if (!prev || s.joinedAt > prev.joinedAt) byUser.set(s.userId, s);
  }
  return [...byUser.values(), ...guests];
}

interface PresenceAvatarClusterProps {
  /** Pan/zoom the canvas to a world coordinate. */
  onPanTo?: (worldX: number, worldY: number) => void;
}

interface AvatarProps {
  session: RemoteSession;
  onClick?: () => void;
}

function Avatar({ session, onClick }: AvatarProps) {
  const [hover, setHover] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  const initials = initialsForName(session.displayName);
  const showImg = session.avatarUrl && !imgFailed;
  return (
    <button
      type="button"
      className={styles.avatar}
      data-idle={session.idle ? "true" : "false"}
      style={{ ["--ring" as string]: session.color }}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      aria-label={`Jump to ${session.displayName}'s cursor`}
    >
      {showImg ? (
        <img
          src={session.avatarUrl ?? ""}
          alt=""
          onError={() => setImgFailed(true)}
        />
      ) : (
        <span>{initials}</span>
      )}
      {hover && <span className={styles.tooltip}>{session.displayName}</span>}
    </button>
  );
}

function PresenceAvatarClusterImpl({ onPanTo }: PresenceAvatarClusterProps) {
  const sessions = useRemoteSessions();
  const selfUserId = usePresenceStore((s) => s.self?.userId ?? null);

  const deduped = dedupeAndExcludeSelf(sessions, selfUserId);
  if (deduped.length === 0) {
    /* In dev, render an empty placeholder so the position ghost overlay
     * (Alt+G) can show where the cluster *would* sit even when no one
     * else is on the canvas. The placeholder is hidden in production
     * builds and stays visually inert (transparent, no avatars) in dev
     * — the dashed outline only appears when ghosts are toggled on. */
    if (!import.meta.env.DEV) return null;
    return (
      <div
        className={styles.cluster}
        role="group"
        aria-label="Other people on this canvas"
        data-empty="true"
      />
    );
  }

  // Sort oldest-first. The cluster is left-anchored next to the zoom
  // toolbar; newer joiners are appended on the RIGHT (further into the
  // canvas) while the original participant stays anchored next to the
  // toolbar. The overflow chip lives at the far right where extra
  // members would otherwise spill out of the visible row.
  const sortedOldestFirst = [...deduped].sort((a, b) => a.joinedAt - b.joinedAt);
  const visible = sortedOldestFirst.slice(0, MAX_VISIBLE);
  const overflow = sortedOldestFirst.length - visible.length;

  return (
    <div
      className={styles.cluster}
      role="group"
      aria-label="Other people on this canvas"
    >
      {visible.map((session) => (
        <Avatar
          key={session.sessionId}
          session={session}
          onClick={() => {
            if (!onPanTo || !session.lastCursor) return;
            onPanTo(session.lastCursor.x, session.lastCursor.y);
          }}
        />
      ))}
      {overflow > 0 && (
        <span className={styles.overflow} aria-label={`${overflow} more`}>
          +{overflow}
        </span>
      )}
    </div>
  );
}

export const PresenceAvatarCluster = memo(PresenceAvatarClusterImpl);
