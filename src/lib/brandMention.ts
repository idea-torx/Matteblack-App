/* Brand IQ "#brand" mention utilities. Thin wrapper over `mentionCore`
 * pinned to the `#` trigger char. Kept as a separate module so existing
 * imports stay stable while a second mention type (`@product`) shares
 * the underlying cursor-detection / ranking / rewriting infrastructure. */

import {
  normalizeToken,
  fuzzyScore,
  rankItems,
  bestMatch,
  getMentionAtCursorWithChar,
  extractAllMentionsWithChar,
  resolveFirstMentionWithChar,
  type MentionItem,
} from "./mentionCore";

export { normalizeToken, fuzzyScore };

const TRIGGER = "#";

export type Brand = {
  id: string;
  name: string;
  slug: string;
  avatar_color?: string | null;
  archived_at?: string | null;
};

export type BrandSuggestion = {
  id: string;
  name: string;
  slug: string;
  avatar_color: string | null;
  score: number;
};

function toItem(b: Brand): MentionItem & { avatar_color: string | null } {
  return { id: b.id, name: b.name, slug: b.slug, avatar_color: b.avatar_color || null };
}

export function rankBrands(query: string, brands: Brand[]): BrandSuggestion[] {
  return rankItems(query, brands.map(toItem)) as BrandSuggestion[];
}

export function bestBrandMatch(query: string, brands: Brand[], minScore = 40): Brand | null {
  const match = bestMatch(query, brands.map(toItem), minScore);
  if (!match) return null;
  return brands.find((b) => b.id === match.id) || null;
}

export function getMentionAtCursor(
  text: string,
  cursor: number,
): { start: number; end: number; query: string } | null {
  return getMentionAtCursorWithChar(text, cursor, TRIGGER);
}

export function extractAllMentions(
  text: string,
): Array<{ start: number; end: number; token: string }> {
  return extractAllMentionsWithChar(text, TRIGGER);
}

export function resolveFirstMention(
  text: string,
  brands: Brand[],
  minScore = 40,
): Brand | null {
  const match = resolveFirstMentionWithChar(text, brands.map(toItem), TRIGGER, minScore);
  if (!match) return null;
  return brands.find((b) => b.id === match.id) || null;
}
