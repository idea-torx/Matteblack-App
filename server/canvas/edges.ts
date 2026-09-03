// Read-only provenance: which generation fed which. Derived entirely from what
// jobs.params already recorded at generation time — nothing is written for it.

export type ProvenanceEdge = { from: string; to: string; kind: string };

/** One canvas node plus the job that produced it. */
export type EdgeNodeRow = {
  id: string;
  jobType?: string | null;
  params?: Record<string, unknown> | null;
  /** Every URL that identifies this node's output: job result, asset file, node src. */
  urls: (string | null | undefined)[];
};

// Param keys that hold an input URL (string or string[]). Covers the
// agent paths (routes/agent.ts) and the in-app generate path (index.ts).
const INPUT_KEYS = [
  "referenceImageUrls", "referenceVideoUrls", "referenceUrls", "imageUrls",
  "image_url", "video_url", "audio_url",
  "firstFrameUrl", "lastFrameUrl", "continuedFrom",
] as const;

const KIND_BY_JOB_TYPE: Record<string, string> = {
  upscale: "upscale",
  remove_bg: "remove_background",
  resize: "resize",
  image_to_vector: "vectorize",
  text_to_vector: "vectorize",
};

// ponytail: lineage is matched by URL string (pathname/basename), so a result
// re-hosted under a different filename loses its edge, and two nodes sharing a
// basename can cross-link. Upgrade: a source_asset_id column written at
// generation time, and this becomes a join.
function urlKeys(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw) return [];
  let p = raw;
  try { p = new URL(raw, "http://x").pathname; } catch { /* keep raw */ }
  const base = p.slice(p.lastIndexOf("/") + 1);
  return base ? [p, base] : [p];
}

function inputUrls(params: Record<string, unknown> | null | undefined): { url: string; key: string }[] {
  const out: { url: string; key: string }[] = [];
  if (!params) return out;
  for (const key of INPUT_KEYS) {
    const v = params[key];
    if (typeof v === "string") out.push({ url: v, key });
    else if (Array.isArray(v)) for (const u of v) if (typeof u === "string") out.push({ url: u, key });
  }
  return out;
}

export function deriveEdges(nodes: EdgeNodeRow[]): ProvenanceEdge[] {
  const byUrl = new Map<string, string>();
  for (const n of nodes) {
    for (const u of n.urls) {
      for (const k of urlKeys(u)) if (!byUrl.has(k)) byUrl.set(k, n.id);
    }
  }
  const edges: ProvenanceEdge[] = [];
  const seen = new Set<string>();
  for (const n of nodes) {
    for (const { url, key } of inputUrls(n.params)) {
      let from: string | undefined;
      for (const k of urlKeys(url)) { from = byUrl.get(k); if (from) break; }
      if (!from || from === n.id) continue; // unknown input, or self-reference
      const kind =
        key === "continuedFrom" ? "continuation"
        : key === "firstFrameUrl" || key === "lastFrameUrl" ? "keyframe"
        : KIND_BY_JOB_TYPE[n.jobType || ""] || "reference";
      const sig = `${from}>${n.id}:${kind}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      edges.push({ from, to: n.id, kind });
    }
  }
  return edges;
}
