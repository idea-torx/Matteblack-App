import { PRESENCE_COLOR_PALETTE } from "./types";

/**
 * Deterministic color assignment that mirrors the server-side helper so a
 * given session's color stays consistent even before the snapshot arrives.
 */
export function colorForSession(sessionId: string): string {
  let hash = 0;
  for (let i = 0; i < sessionId.length; i++) {
    hash = (hash * 31 + sessionId.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % PRESENCE_COLOR_PALETTE.length;
  return PRESENCE_COLOR_PALETTE[idx];
}

/**
 * Initials for an avatar fallback (no avatar URL or image load error).
 * Falls back to "?" if the name is empty.
 */
export function initialsForName(name: string): string {
  const trimmed = (name || "").trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
