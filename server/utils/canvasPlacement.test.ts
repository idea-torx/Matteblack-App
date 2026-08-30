/**
 * Self-check for canvas placement. Run:
 *   npx tsx server/utils/canvasPlacement.test.ts
 *
 * The properties that matter are the ones the old spiral broke: a new node goes
 * to the RIGHT of the rightmost one, the answer does not depend on the viewport
 * once the canvas has anything on it, and nothing ever overlaps.
 */
import assert from "node:assert/strict";
import { layout, GAP, type Rect } from "./canvasPlacement.js";
import { layout as clientLayout } from "../../src/utils/canvasPlacement.js";

const VP = { cx: 0, cy: 0, w: 1280, h: 720 };
const sq = (n: number) => new Array(n).fill({ w: 1024, h: 1024 });
const overlap = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

function assertNoOverlaps(all: Rect[]) {
  for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length; j++)
      assert.ok(!overlap(all[i], all[j]), `overlap: ${JSON.stringify(all[i])} / ${JSON.stringify(all[j])}`);
}

// Empty canvas: centred on what the user is looking at.
{
  const [r] = layout({ cx: 500, cy: 300, w: 1280, h: 720 }, [{ w: 1024, h: 512 }], []);
  assert.deepEqual(r, { x: 500 - 512, y: 300 - 256, w: 1024, h: 512 });
}

// The whole ask: to the right of the last node, same row.
{
  const a: Rect = { x: 0, y: 0, w: 1024, h: 1024 };
  const [r] = layout(VP, [{ w: 1024, h: 1024 }], [a]);
  assert.equal(r.x, a.x + a.w + GAP);
  assert.equal(r.y, a.y);
}

// "Rightmost", not "first" — a node further right wins wherever it sits.
{
  const occ: Rect[] = [
    { x: 0, y: 0, w: 1024, h: 1024 },
    { x: 5000, y: -3000, w: 1024, h: 1024 },
    { x: 2000, y: 4000, w: 1024, h: 1024 },
  ];
  const [r] = layout(VP, sq(1), occ);
  assert.equal(r.x, 5000 + 1024 + GAP);
  assert.equal(r.y, -3000);
}

// Wrapping into occupied ground slides right rather than overlapping, and
// still never goes back up. (Right of the anchor is unblockable by definition —
// anything blocking it would be further right, and so be the anchor — so the
// wrapped row is where sliding actually earns its keep.)
{
  const occ: Rect[] = [
    { x: 0, y: 0, w: 1024, h: 1024 },
    { x: 0, y: 1400, w: 3000, h: 900 }, // sits under the start of the next row
  ];
  const out = layout(VP, sq(12), occ);
  const wrapped = out.filter((r) => r.y > 0);
  assert.ok(wrapped.length > 0);
  assert.ok(wrapped.every((r) => r.y >= 0), "never placed above the content");
  assertNoOverlaps([...occ, ...out]);
}

// Zoom and pan must not change the answer. This is the regression: row width
// used to be viewport-derived, so the same canvas placed differently depending
// on how far the user happened to be zoomed out.
{
  const occ: Rect[] = [{ x: 0, y: 0, w: 1024, h: 1024 }];
  const wide = layout({ cx: 9999, cy: -9999, w: 40000, h: 30000 }, sq(8), occ);
  const tight = layout({ cx: -400, cy: 77, w: 320, h: 200 }, sq(8), occ);
  assert.deepEqual(wide, tight);
}

// A batch lands as one row at a single y, marching right.
{
  const out = layout(VP, sq(4), [{ x: 0, y: 0, w: 1024, h: 1024 }]);
  assert.ok(out.every((r) => r.y === 0));
  for (let i = 1; i < out.length; i++) assert.equal(out[i].x, out[i - 1].x + out[i - 1].w + GAP);
}

// Long runs wrap below the content instead of marching off forever, and the
// new row starts at the content's left edge.
{
  const occ: Rect[] = [{ x: 0, y: 0, w: 1024, h: 1024 }];
  const out = layout(VP, sq(20), occ);
  const wrapped = out.filter((r) => r.y > 0);
  assert.ok(wrapped.length > 0, "20 items should have wrapped");
  assert.equal(wrapped[0].x, 0, "a wrapped row starts at the content's left edge");
  assert.ok(wrapped[0].y >= 1024 + GAP, "a wrapped row clears the content above it");
  assertNoOverlaps([...occ, ...out]);
}

// Placing one at a time gives the same shape as placing them all at once —
// the agent drops nodes one per tool call, the panel drops them in batches.
{
  const occ: Rect[] = [{ x: 0, y: 0, w: 1024, h: 1024 }];
  const batch = layout(VP, sq(6), occ);
  const running = occ.slice();
  const one: Rect[] = [];
  for (let i = 0; i < 6; i++) {
    const r = layout(VP, sq(1), running)[0];
    one.push(r);
    running.push(r);
  }
  assert.deepEqual(one, batch);
}

// Degenerate inputs don't hang or throw.
assert.deepEqual(layout(VP, [], [{ x: 0, y: 0, w: 10, h: 10 }]), []);
assertNoOverlaps(layout(VP, sq(3), new Array(300).fill(0).map((_, i) => ({ x: i * 100, y: 0, w: 1024, h: 1024 }))));

// The server copy and the frontend copy must stay identical.
{
  const cases: [Rect[], number][] = [[[], 3], [[{ x: 0, y: 0, w: 1024, h: 1024 }], 9], [[{ x: -500, y: 900, w: 300, h: 300 }, { x: 900, y: 0, w: 1024, h: 576 }], 5]];
  for (const [occ, n] of cases) {
    assert.deepEqual(clientLayout(VP, sq(n), occ), layout(VP, sq(n), occ), "server/client placement drifted");
  }
}

console.log("canvasPlacement: all checks passed");
