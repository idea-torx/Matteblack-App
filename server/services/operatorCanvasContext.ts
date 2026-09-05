/**
 * Operator canvas context — bridges the frontend's live view to the server-side
 * operator generation path.
 *
 * The Matte operator runs Claude Code headlessly; when Claude calls a generation
 * MCP tool it loops back into /api/agent/tool, which must decide WHERE on the
 * canvas the result lands. That decision needs two things the MCP call can't
 * carry: the canvas the user is currently looking at, and their viewport (so the
 * first generation lands on-screen). The OperatorPanel captures both at the
 * moment the user sends a message and POSTs them to /api/operator/message, which
 * stashes them here (keyed by user — LOCAL_MODE is single-user, but keying by
 * user keeps it correct). The placement path reads them back in the same
 * process.
 *
 * There is deliberately no placement anchor here any more: placement now reads
 * its anchor off the canvas itself, so it works the same whether the last node
 * came from this turn, an earlier session, or the user's own hand.
 */
import type { Viewport } from "../utils/canvasPlacement.js";

type OperatorContext = {
  canvasId?: string;
  viewport?: Viewport;
  // Reference image URLs the user attached this turn (canvas selection +
  // uploads). Merged into the generation's referenceUrls at /api/agent/tool.
  // Re-set every turn (to [] when nothing is attached) so a stale reference
  // never bleeds into a later, unrelated generation.
  referenceUrls?: string[];
  referenceFiles?: string[];
  referenceLabels?: string[];
  blenderReferenceSessions?: Set<string>; // attach once per scene per turn; explicit replacements then persist
  // The selected canvas image's aspect-ratio label (e.g. "3:4"). When set and
  // the user didn't pin an AR, the next generation inherits it (lineage).
  referenceAspectRatio?: string;
  // The bot running this turn, in the user's words — used as the display name
  // of the presence cursor that walks the canvas during arrange_canvas.
  botName?: string;
  botIcon?: string;
  // Generation jobs this turn has dispatched. Stop has to reach these: killing
  // the claude process ends the *reasoning*, but every generate_media it already
  // fired is a queued fal job that keeps running, keeps charging, and keeps
  // landing on the canvas — which is what "it wouldn't stop generating" is.
  jobIds: Set<string>;
  updatedAt: number;
};

const byUser = new Map<string, OperatorContext>();

/** Called when an operator turn starts, with the frontend's current view. */
export function setOperatorContext(
  userId: string,
  ctx: { canvasId?: string; viewport?: Viewport; referenceUrls?: string[]; referenceAspectRatio?: string; botName?: string; botIcon?: string },
): void {
  byUser.set(userId, {
    canvasId: ctx.canvasId,
    viewport: ctx.viewport,
    referenceUrls: ctx.referenceUrls,
    referenceAspectRatio: ctx.referenceAspectRatio,
    botName: ctx.botName,
    botIcon: ctx.botIcon,
    jobIds: new Set(),
    updatedAt: Date.now(),
  });
}

export function getOperatorContext(userId: string): OperatorContext | undefined {
  return byUser.get(userId);
}

/** Record a job the operator just dispatched, so stop can cancel it. */
export function noteOperatorJob(userId: string, jobId: string): void {
  byUser.get(userId)?.jobIds.add(jobId);
}

/** Job ids dispatched since this turn started; clears them. */
export function takeOperatorJobs(userId: string): string[] {
  const ctx = byUser.get(userId);
  if (!ctx) return [];
  const ids = [...ctx.jobIds];
  ctx.jobIds.clear();
  return ids;
}

// Users whose last turn was interrupted (stream closed mid-run). The NEXT turn
// reads and clears this so the resumed agent is told its task was aborted
// instead of picking it back up from a transcript with dangling tool calls.
const interruptedUsers = new Set<string>();

export function noteOperatorInterrupted(userId: string): void {
  interruptedUsers.add(userId);
}

export function takeOperatorInterrupted(userId: string): boolean {
  return interruptedUsers.delete(userId);
}
