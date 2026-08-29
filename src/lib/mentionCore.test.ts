import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeToken,
  fuzzyScore,
  rankItems,
  bestMatch,
  getMentionAtCursorWithChar,
  extractAllMentionsWithChar,
  resolveAllMentionsWithChar,
} from "./mentionCore";

describe("normalizeToken", () => {
  it("lowercases and strips non-alphanumerics", () => {
    assert.equal(normalizeToken("Acme-Co_2024!"), "acmeco2024");
    assert.equal(normalizeToken(""), "");
    assert.equal(normalizeToken("   spaced  out  "), "spacedout");
  });
});

describe("fuzzyScore", () => {
  it("returns 100 on exact normalized match", () => {
    assert.equal(fuzzyScore("acme co", "acme-co"), 100);
  });
  it("ranks prefix higher than substring", () => {
    const prefix = fuzzyScore("acm", "acme");
    const sub = fuzzyScore("cme", "acme");
    assert.ok(prefix > sub, `expected prefix(${prefix}) > substring(${sub})`);
  });
  it("returns 0 for unrelated strings", () => {
    assert.equal(fuzzyScore("xyz", "totally different name"), 0);
  });
});

describe("rankItems", () => {
  const items = [
    { id: "1", name: "Acme Co", slug: "acme-co" },
    { id: "2", name: "Globex", slug: "globex" },
    { id: "3", name: "Initech", slug: "initech" },
  ];
  it("preserves order at neutral score on empty query", () => {
    const out = rankItems("", items);
    assert.deepEqual(out.map((r) => r.id), ["1", "2", "3"]);
    assert.ok(out.every((r) => r.score === 50));
  });
  it("filters and sorts by score on a real query", () => {
    const out = rankItems("acme", items);
    assert.equal(out[0].id, "1");
    assert.ok(out.every((r) => r.score > 0));
    assert.ok(!out.some((r) => r.id === "3"));
  });
});

describe("bestMatch", () => {
  const items = [
    { id: "1", name: "Acme", slug: "acme" },
    { id: "2", name: "Acme Plus", slug: "acme-plus" },
  ];
  it("returns the top-scoring item when above threshold", () => {
    const m = bestMatch("acm", items);
    assert.ok(m);
    assert.equal(m!.id, "1");
  });
  it("returns null when no item clears minScore", () => {
    assert.equal(bestMatch("zzz", items), null);
  });
});

describe("getMentionAtCursorWithChar", () => {
  it("detects # at start of input", () => {
    const m = getMentionAtCursorWithChar("#acme", 5, "#");
    assert.deepEqual(m, { start: 0, end: 5, query: "acme" });
  });
  it("detects @ after a space", () => {
    const m = getMentionAtCursorWithChar("hello @prod", 11, "@");
    assert.deepEqual(m, { start: 6, end: 11, query: "prod" });
  });
  it("rejects trigger glued to a word (no leading whitespace)", () => {
    // "hi#nope" — the # is preceded by a non-space, so not a mention.
    assert.equal(getMentionAtCursorWithChar("hi#nope", 7, "#"), null);
  });
  it("returns null when cursor isn't inside a mention", () => {
    assert.equal(getMentionAtCursorWithChar("just text", 4, "@"), null);
  });
  it("works with cursor mid-token", () => {
    const m = getMentionAtCursorWithChar("hi @abc def", 5, "@");
    assert.ok(m);
    assert.equal(m!.query, "abc");
  });
});

describe("extractAllMentionsWithChar", () => {
  it("finds all mentions and ignores triggers without leading boundary", () => {
    const out = extractAllMentionsWithChar("hi @one and @two but not foo@three", "@");
    assert.deepEqual(out.map((m) => m.token), ["one", "two"]);
  });
  it("respects the configured trigger char", () => {
    const out = extractAllMentionsWithChar("@one #two @three", "#");
    assert.deepEqual(out.map((m) => m.token), ["two"]);
  });
  it("yields empty array when there are no mentions", () => {
    assert.deepEqual(extractAllMentionsWithChar("plain text", "@"), []);
  });
});

describe("resolveAllMentionsWithChar", () => {
  const items = [
    { id: "1", name: "Acme", slug: "acme" },
    { id: "2", name: "Globex", slug: "globex" },
  ];
  it("resolves multiple distinct mentions in order", () => {
    const out = resolveAllMentionsWithChar("@globex hello @acme", items, "@");
    assert.deepEqual(out.map((i) => i.id), ["2", "1"]);
  });
  it("de-duplicates by id when same item is mentioned twice", () => {
    const out = resolveAllMentionsWithChar("@acme then @acme", items, "@");
    assert.deepEqual(out.map((i) => i.id), ["1"]);
  });
  it("ignores tokens that don't clear minScore", () => {
    const out = resolveAllMentionsWithChar("@xyzzz only", items, "@");
    assert.deepEqual(out, []);
  });
});
