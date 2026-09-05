// Run: npx tsx --test src/utils/blenderDirection.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { directionDuration } from "./blenderDirection.ts";

test("snaps the playblast length to a seedance duration", () => {
  assert.equal(directionDuration([1, 120], 24), "4");   // 5.04s -> 4
  assert.equal(directionDuration([1, 240], 24), "10");  // 10.04s -> 10
  assert.equal(directionDuration([1, 168], 24), "6");   // 7.04s -> 7, ties snap down
  assert.equal(directionDuration([100, 340], 24), "10");
  assert.equal(directionDuration([1, 300], 60), "4");   // 5s at 60fps
});

test("bad metadata falls back to the shortest clip", () => {
  assert.equal(directionDuration(undefined, undefined), "4");
  assert.equal(directionDuration([1], 24), "4");
  assert.equal(directionDuration(["a", "b"], 24), "4");
});
