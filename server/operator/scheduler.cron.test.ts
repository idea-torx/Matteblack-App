/**
 * computeNext() — the 5-field cron matcher behind scheduled operator runs.
 *
 * Run with `npm run test:scheduler`: importing scheduler.ts pulls in db.ts,
 * which builds a pool at module load, so the script pins LOCAL_MODE=false plus a
 * dummy DATABASE_URL (pg.Pool does not connect until a query, so nothing is hit).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeNext } from "./scheduler.js";

/** Local-time constructor, so these assertions mean the same thing in any TZ. */
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);

test("computeNext: hourly, strictly after", () => {
  assert.deepEqual(computeNext("0 * * * *", at(2026, 3, 10, 14, 30)), at(2026, 3, 10, 15, 0));
  // Already exactly on the mark → the NEXT one, never the same instant.
  assert.deepEqual(computeNext("0 * * * *", at(2026, 3, 10, 15, 0)), at(2026, 3, 10, 16, 0));
});

test("computeNext: daily at 9, rolls to tomorrow once past", () => {
  assert.deepEqual(computeNext("0 9 * * *", at(2026, 3, 10, 8, 59)), at(2026, 3, 10, 9, 0));
  assert.deepEqual(computeNext("0 9 * * *", at(2026, 3, 10, 9, 1)), at(2026, 3, 11, 9, 0));
});

test("computeNext: day-of-week — Mondays 09:00", () => {
  // 2026-03-10 is a Tuesday; the next Monday is the 16th.
  assert.equal(at(2026, 3, 10).getDay(), 2);
  assert.deepEqual(computeNext("0 9 * * 1", at(2026, 3, 10, 12, 0)), at(2026, 3, 16, 9, 0));
  // Sunday as 7 is the same as 0.
  assert.deepEqual(computeNext("0 9 * * 7", at(2026, 3, 10, 12, 0)), at(2026, 3, 15, 9, 0));
});

test("computeNext: weekday range skips the weekend", () => {
  // Friday 2026-03-13, after 9 → Monday the 16th.
  assert.equal(at(2026, 3, 13).getDay(), 5);
  assert.deepEqual(computeNext("0 9 * * 1-5", at(2026, 3, 13, 10, 0)), at(2026, 3, 16, 9, 0));
});

test("computeNext: month rollover, incl. a short month and a leap year", () => {
  assert.deepEqual(computeNext("0 9 1 * *", at(2026, 1, 20, 0, 0)), at(2026, 2, 1, 9, 0));
  // Day 31 does not exist in April → skips to May.
  assert.deepEqual(computeNext("0 0 31 * *", at(2026, 4, 1, 0, 0)), at(2026, 5, 31, 0, 0));
  // Feb 29 only exists in a leap year (2028).
  assert.deepEqual(computeNext("0 0 29 2 *", at(2026, 3, 1, 0, 0)), at(2028, 2, 29, 0, 0));
});

test("computeNext: steps and lists", () => {
  assert.deepEqual(computeNext("*/15 * * * *", at(2026, 3, 10, 14, 3)), at(2026, 3, 10, 14, 15));
  assert.deepEqual(computeNext("0 9,17 * * *", at(2026, 3, 10, 10, 0)), at(2026, 3, 10, 17, 0));
});

test("computeNext: dom AND dow restricted means EITHER matches (standard cron)", () => {
  // The 1st or any Monday, whichever comes first. 2026-03-10 is a Tuesday, so
  // the next hit is Monday the 16th, not April 1st.
  assert.deepEqual(computeNext("0 0 1 * 1", at(2026, 3, 10, 12, 0)), at(2026, 3, 16, 0, 0));
});

test("computeNext: rejects malformed expressions", () => {
  for (const bad of ["", "0 9 * *", "0 9 * * * *", "60 * * * *", "0 24 * * *", "0 9 0 * *", "abc * * * *", "*/0 * * * *"]) {
    assert.throws(() => computeNext(bad, at(2026, 3, 10)), new RegExp("."), `expected "${bad}" to throw`);
  }
});
