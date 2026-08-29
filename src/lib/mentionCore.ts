/* Shared mention-popover infrastructure for the agent composer.
 *
 * Originally written for `#brand` mentions and now also drives `@product`
 * mentions. The trigger char and the entity shape are both configurable
 * so a second mention type doesn't require duplicating cursor detection,
 * fuzzy ranking, and token rewriting. */

export type MentionItem = {
  id: string;
  name: string;
  slug: string;
};

export type MentionSuggestion<T extends MentionItem> = T & { score: number };

/* Lowercase + drop everything that isn't [a-z0-9]. Used for both the
 * needle (typed query) and haystack (item name + slug) so spaces, dashes,
 * and underscores never block a match. */
export function normalizeToken(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp: number[] = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) dp[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[b.length];
}

/* Score a single needle/haystack pair on a 0–100 scale. See brandMention.ts
 * for the historical thresholds; same algorithm. */
export function fuzzyScore(needle: string, haystack: string): number {
  const a = normalizeToken(needle);
  const b = normalizeToken(haystack);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (b.startsWith(a)) return 85;
  if (a.startsWith(b)) return 70;
  if (b.includes(a)) return 65;
  const dist = levenshtein(a, b);
  const longer = Math.max(a.length, b.length);
  const ratio = 1 - dist / longer;
  if (ratio > 0.55) return Math.round(ratio * 60);
  return 0;
}

/* Rank items against an arbitrary query string. Empty query keeps
 * caller-provided order at a neutral score. */
export function rankItems<T extends MentionItem>(
  query: string,
  items: T[],
): MentionSuggestion<T>[] {
  if (!query || !query.trim()) {
    return items.map((it) => ({ ...it, score: 50 }));
  }
  return items
    .map((it) => ({
      ...it,
      score: Math.max(fuzzyScore(query, it.name), fuzzyScore(query, it.slug)),
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
}

/* Best single match for resolving a token at send time. */
export function bestMatch<T extends MentionItem>(
  query: string,
  items: T[],
  minScore = 40,
): T | null {
  const ranked = rankItems(query, items);
  if (ranked.length === 0 || ranked[0].score < minScore) return null;
  return items.find((it) => it.id === ranked[0].id) || null;
}

/* Locate the trigger-prefixed token surrounding `cursor` in `text`. A valid
 * mention starts at the trigger char which is either at the start of input
 * or preceded by whitespace, and runs forward until the next whitespace
 * character. Returns null when the cursor is not inside such a token. */
export function getMentionAtCursorWithChar(
  text: string,
  cursor: number,
  triggerChar: string,
): { start: number; end: number; query: string } | null {
  let i = Math.min(cursor, text.length);
  while (i > 0) {
    const ch = text[i - 1];
    if (ch === triggerChar) {
      const start = i - 1;
      if (start > 0 && !/\s/.test(text[start - 1])) return null;
      let end = cursor;
      while (end < text.length && !/\s/.test(text[end])) end++;
      const query = text.slice(start + 1, end);
      return { start, end, query };
    }
    if (/\s/.test(ch) || ch === triggerChar) return null;
    i--;
  }
  return null;
}

/* Pull every trigger-prefixed token from `text` regardless of cursor. */
export function extractAllMentionsWithChar(
  text: string,
  triggerChar: string,
): Array<{ start: number; end: number; token: string }> {
  const out: Array<{ start: number; end: number; token: string }> = [];
  // Escape the trigger for regex use.
  const esc = triggerChar.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|\\s)${esc}([A-Za-z0-9_-]+)`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index + (m[1] ? m[1].length : 0);
    const end = start + 1 + m[2].length;
    out.push({ start, end, token: m[2] });
  }
  return out;
}

/* Resolve every trigger-prefixed token in `text` to items, preserving
 * order and de-duplicating by id. Used at send time to gather product
 * pins regardless of whether the user opened the popover. */
export function resolveAllMentionsWithChar<T extends MentionItem>(
  text: string,
  items: T[],
  triggerChar: string,
  minScore = 40,
): T[] {
  const mentions = extractAllMentionsWithChar(text, triggerChar);
  const seen = new Set<string>();
  const out: T[] = [];
  for (const m of mentions) {
    const match = bestMatch(m.token, items, minScore);
    if (match && !seen.has(match.id)) {
      seen.add(match.id);
      out.push(match);
    }
  }
  return out;
}

/* Resolve only the first trigger-prefixed token in `text` to an item. */
export function resolveFirstMentionWithChar<T extends MentionItem>(
  text: string,
  items: T[],
  triggerChar: string,
  minScore = 40,
): T | null {
  const all = resolveAllMentionsWithChar(text, items, triggerChar, minScore);
  return all[0] || null;
}
