/* "@product" mention utilities for the agent composer. Mirrors the
 * `#brand` mention infrastructure but pinned to the `@` trigger char and
 * using the axiom/product entity shape. */

import {
  rankItems,
  getMentionAtCursorWithChar,
  extractAllMentionsWithChar,
  resolveAllMentionsWithChar,
  type MentionItem,
} from "./mentionCore";

const TRIGGER = "@";

export type ProductSourceKind = "user" | "workspace" | "platform";

export type Product = {
  id: string;
  slug: string;
  name: string;
  description: string;
  thumbnail: string | null;
  sourceKind: ProductSourceKind;
};

export type ProductSuggestion = Product & { score: number };

function toItem(p: Product): MentionItem & {
  description: string;
  thumbnail: string | null;
  sourceKind: ProductSourceKind;
} {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    description: p.description,
    thumbnail: p.thumbnail,
    sourceKind: p.sourceKind,
  };
}

export function rankProducts(query: string, products: Product[]): ProductSuggestion[] {
  return rankItems(query, products.map(toItem)) as ProductSuggestion[];
}

export function getProductMentionAtCursor(
  text: string,
  cursor: number,
): { start: number; end: number; query: string } | null {
  return getMentionAtCursorWithChar(text, cursor, TRIGGER);
}

export function extractAllProductMentions(
  text: string,
): Array<{ start: number; end: number; token: string }> {
  return extractAllMentionsWithChar(text, TRIGGER);
}

/* Resolve every @product token in `text` to a Product, preserving order
 * and de-duplicating by id. Returns the typed Product objects. */
export function resolveAllProductMentions(
  text: string,
  products: Product[],
  minScore = 40,
): Product[] {
  const matched = resolveAllMentionsWithChar(text, products.map(toItem), TRIGGER, minScore);
  const byId = new Map(products.map((p) => [p.id, p] as const));
  const out: Product[] = [];
  for (const m of matched) {
    const p = byId.get(m.id);
    if (p) out.push(p);
  }
  return out;
}
