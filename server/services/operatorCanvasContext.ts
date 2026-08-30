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
  // The selected canvas image's aspect-ratio label (e.g. "3:4"). When set and
  // the user didn't pin an AR, the next generation inherits it (lineage).
  referenceAspectRatio?: string;
  updatedAt: number;
};

const byUser = new Map<string, OperatorContext>();

/** Called when an operator turn starts, with the frontend's current view. */
export function setOperatorContext(
  userId: string,
  ctx: { canvasId?: string; viewport?: Viewport; referenceUrls?: string[]; referenceAspectRatio?: string },
): void {
  byUser.set(userId, {
    canvasId: ctx.canvasId,
    viewport: ctx.viewport,
    referenceUrls: ctx.referenceUrls,
    referenceAspectRatio: ctx.referenceAspectRatio,
    updatedAt: Date.now(),
  });
}

export function getOperatorContext(userId: string): OperatorContext | undefined {
  return byUser.get(userId);
}

