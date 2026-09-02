import { test } from "node:test";
import assert from "node:assert/strict";
import { parseToolAllowlist } from "./toolAllowlist.ts";

test("unset / empty / whitespace → no restriction", () => {
  assert.equal(parseToolAllowlist(undefined), null);
  assert.equal(parseToolAllowlist(""), null);
  assert.equal(parseToolAllowlist(" , "), null);
});

test("comma list → membership set, trimmed", () => {
  const allow = parseToolAllowlist(" list_skills , remember ");
  assert.ok(allow);
  assert.ok(allow.has("list_skills"));
  assert.ok(allow.has("remember"));
  assert.equal(allow.has("generate_media"), false);
  assert.equal(allow.size, 2);
});
