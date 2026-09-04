// Run: npx tsx --test src/utils/svgPathModel.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SubPath } from "./svgPathModel.ts";
// @xmldom/xmldom is already a dependency; it gives node a DOMParser without
// pulling in a whole browser.
import { DOMParser } from "@xmldom/xmldom";
(globalThis as { DOMParser?: unknown }).DOMParser = DOMParser;
const { extractPathDataFromSvg } = await import("./svgPathModel.ts");

test("single path scales into node space", () => {
  const pd = extractPathDataFromSvg(
    `<svg viewBox="0 0 10 10"><path d="M0 0 L10 0 L10 10 Z" fill="#f00"/></svg>`, 100, 100);
  assert.ok(pd);
  assert.equal(pd.subPaths.length, 1);
  assert.deepEqual(pd.subPaths[0].anchors.map((a) => [a.x, a.y]), [[0, 0], [100, 0], [100, 100]]);
  assert.equal(pd.subPaths[0].fill, "#f00");
  assert.deepEqual(pd.viewBox, { x: 0, y: 0, width: 100, height: 100 });
});

test("every path is kept, with its own paint, in document order", () => {
  const pd = extractPathDataFromSvg(
    `<svg viewBox="0 0 10 10">
       <path d="M0 0 L5 0 L5 5 Z" fill="#111"/>
       <path d="M5 5 L10 5 L10 10 Z" fill="#222"/>
     </svg>`, 10, 10);
  assert.ok(pd);
  assert.deepEqual(pd.subPaths.map((sp) => sp.fill), ["#111", "#222"]);
  assert.deepEqual(pd.subPaths.map((sp) => sp.group), [0, 1]);
});

test("ancestor transforms and inherited fill are flattened onto anchors", () => {
  const pd = extractPathDataFromSvg(
    `<svg viewBox="0 0 10 10"><g transform="translate(2 3)" fill="#0f0">
       <g transform="scale(2)"><path d="M1 1 L2 1"/></g></g></svg>`, 10, 10);
  assert.ok(pd);
  assert.deepEqual(pd.subPaths[0].anchors.map((a) => [a.x, a.y]), [[4, 5], [6, 5]]);
  assert.equal(pd.subPaths[0].fill, "#0f0");
});

test("subPaths of one path share a group so holes survive", () => {
  const pd = extractPathDataFromSvg(
    `<svg viewBox="0 0 10 10"><path fill-rule="evenodd" d="M0 0 L10 0 L10 10 Z M2 2 L4 2 L4 4 Z"/></svg>`, 10, 10);
  assert.ok(pd);
  assert.equal(pd.subPaths.length, 2);
  assert.deepEqual(pd.subPaths.map((sp) => sp.group), [0, 0]);
  assert.equal(pd.subPaths[0].fillRule, "evenodd");
});

test("basic shapes become paths; missing fill defaults to black", () => {
  const pd = extractPathDataFromSvg(`<svg viewBox="0 0 10 10"><rect x="0" y="0" width="10" height="10"/></svg>`, 10, 10);
  assert.ok(pd);
  assert.equal(pd.subPaths[0].anchors.length, 4);
  assert.equal(pd.subPaths[0].fill, "#000000");
  assert.ok(extractPathDataFromSvg(`<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>`, 10, 10));
});

test("what we cannot reproduce is refused, so the node keeps its own artwork", () => {
  const refused = [
    `<svg viewBox="0 0 10 10"><text x="0" y="5">hi</text></svg>`,
    `<svg viewBox="0 0 10 10"><defs><linearGradient id="g"/></defs><path d="M0 0 L1 1" fill="url(#g)"/></svg>`,
    `<svg viewBox="0 0 10 10"><path d="M0 0 L1 1" clip-path="url(#c)"/></svg>`,
    `<svg viewBox="0 0 10 10"><image href="x.png"/></svg>`,
    `<svg viewBox="0 0 10 10"></svg>`,
  ];
  for (const svg of refused) assert.equal(extractPathDataFromSvg(svg, 10, 10), null, svg);
});

const { simplifyPathData, countAnchors } = await import("./svgPathModel.ts");

test("simplify drops most anchors, keeps the silhouette and the paint", () => {
  const anchors = Array.from({ length: 200 }, (_, i) => {
    const t = (i / 200) * Math.PI * 2;
    return { x: 50 + 40 * Math.cos(t), y: 50 + 40 * Math.sin(t), smooth: false };
  });
  const before = { subPaths: [{ anchors, closed: true, fill: "#abc", group: 3, fillRule: "evenodd" as const }] };
  const after = simplifyPathData(before);

  assert.ok(countAnchors(after) < 30, `expected far fewer anchors, got ${countAnchors(after)}`);
  for (const a of after.subPaths[0].anchors) {
    assert.ok(Math.abs(Math.hypot(a.x - 50, a.y - 50) - 40) < 4, `off-circle anchor ${a.x},${a.y}`);
  }
  assert.equal(after.subPaths[0].fill, "#abc");
  assert.equal(after.subPaths[0].group, 3);
  assert.equal(after.subPaths[0].fillRule, "evenodd");
  assert.equal(after.subPaths[0].closed, true);
});

test("art too dense to edit is refitted at import instead of refused", () => {
  const pts = Array.from({ length: 3000 }, (_, i) => {
    const t = (i / 3000) * Math.PI * 2;
    return `${(50 + 40 * Math.cos(t)).toFixed(2)} ${(50 + 40 * Math.sin(t)).toFixed(2)}`;
  });
  const svg = `<svg viewBox="0 0 100 100"><path fill="#123" d="M${pts.join("L")}Z"/>` +
    `<path fill="#456" d="M${pts.join("L")}Z"/></svg>`;
  const pd = extractPathDataFromSvg(svg, 100, 100);
  assert.ok(pd, "6000 anchors should be simplified into editability, not refused");
  assert.ok(countAnchors(pd) <= 4000, `still ${countAnchors(pd)} anchors`);
  assert.deepEqual(pd.subPaths.map((sp) => sp.fill), ["#123", "#456"]);
});

const { subPathToSampledPoints, DEFAULT_SIMPLIFY_TOLERANCE } = await import("./svgPathModel.ts");

/** Worst distance from any point on `sp` to the nearest point of `ref`. */
function maxDeviation(sp: SubPath, ref: { x: number; y: number }[]): number {
  let worst = 0;
  for (const p of subPathToSampledPoints(sp, 400)) {
    let best = Infinity;
    for (const q of ref) best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y));
    worst = Math.max(worst, best);
  }
  return worst;
}

function ring(cx: number, cy: number, r: number, n: number) {
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    return { x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) };
  });
}

test("traced circles refit to sub-pixel accuracy at any scale", () => {
  for (const [r, n] of [[12, 100], [40, 200], [200, 400]] as const) {
    const pts = ring(200, 200, r, n);
    const before = { anchors: pts.map((p) => ({ ...p, smooth: false })), closed: true };
    const after = simplifyPathData({ subPaths: [before] }, 1).subPaths[0];
    // Measure against a far denser ring: nearest-vertex distance to the traced
    // outline itself would report half its own vertex spacing as error.
    const dev = maxDeviation(after, ring(200, 200, r, 20000));
    assert.ok(after.anchors.length <= 16, `r=${r}: ${after.anchors.length} anchors`);
    assert.ok(dev < 1, `r=${r}: deviation ${dev}`);
  }
});

test("sharp corners survive: a star is already minimal and is left alone", () => {
  const pts = Array.from({ length: 10 }, (_, i) => {
    const t = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? 50 : 20;
    return { x: 100 + r * Math.cos(t), y: 100 + r * Math.sin(t), smooth: false };
  });
  const before = { anchors: pts, closed: true };
  const after = simplifyPathData({ subPaths: [before] }).subPaths[0];
  assert.deepEqual(after.anchors, pts, "a 10-anchor star has nothing to remove");
});

test("a densely traced star keeps its points instead of rounding them off", () => {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const b = ((i + 1) / 10) * Math.PI * 2 - Math.PI / 2;
    const ra = i % 2 === 0 ? 50 : 20;
    const rb = i % 2 === 0 ? 20 : 50;
    for (let s = 0; s < 20; s++) {
      const t = s / 20;
      pts.push({
        x: 100 + (ra * Math.cos(a)) * (1 - t) + (rb * Math.cos(b)) * t,
        y: 100 + (ra * Math.sin(a)) * (1 - t) + (rb * Math.sin(b)) * t,
      });
    }
  }
  const before = { anchors: pts.map((p) => ({ ...p, smooth: false })), closed: true };
  const after = simplifyPathData({ subPaths: [before] }).subPaths[0];
  assert.ok(after.anchors.length < 30, `${after.anchors.length} anchors`);
  assert.ok(maxDeviation(after, pts) < 2, `deviation ${maxDeviation(after, pts)}`);
});

test("import simplifies by default, not only when over the editability ceiling", () => {
  const pts = Array.from({ length: 300 }, (_, i) => {
    const t = (i / 300) * Math.PI * 2;
    return `${(50 + 40 * Math.cos(t)).toFixed(3)} ${(50 + 40 * Math.sin(t)).toFixed(3)}`;
  });
  const pd = extractPathDataFromSvg(`<svg viewBox="0 0 100 100"><path fill="#123" d="M${pts.join("L")}Z"/></svg>`, 100, 100);
  assert.ok(pd);
  assert.ok(countAnchors(pd) < 20, `300 anchors should come in refitted, got ${countAnchors(pd)}`);
  const drift = maxDeviation(pd.subPaths[0], ring(50, 50, 40, 20000));
  assert.ok(drift < DEFAULT_SIMPLIFY_TOLERANCE, `drifted ${drift}px, past the tolerance it promised`);
});

test("art that is already minimal is imported untouched", () => {
  const pd = extractPathDataFromSvg(`<svg viewBox="0 0 10 10"><path d="M1 1L9 1L9 9L1 9Z"/></svg>`, 10, 10);
  assert.equal(countAnchors(pd!), 4);
});

test("a gradient between two indistinguishable stops is a solid, not a refusal", () => {
  const flat = `<svg viewBox="0 0 10 10"><defs><linearGradient id="g">` +
    `<stop offset="0" stop-color="rgb(1,0,0)"/><stop offset="1" stop-color="rgb(9,5,4)"/>` +
    `</linearGradient></defs><path d="M1 1L9 1L9 9Z" fill="url(#g)"/></svg>`;
  const pd = extractPathDataFromSvg(flat, 10, 10);
  assert.ok(pd, "a two-near-black-stop ramp is a solid the vectoriser spelled oddly");
  assert.equal(pd.subPaths[0].fill, "rgb(1,0,0)");

  const real = flat.replace('stop-color="rgb(9,5,4)"', 'stop-color="rgb(240,10,10)"');
  assert.equal(extractPathDataFromSvg(real, 10, 10), null, "a real colour ramp still refuses");

  // One 5x6px speck of real gradient should not cost a 1465x2048 poster its
  // editability: it is stood in with the average stop instead.
  const speck = real.replace('viewBox="0 0 10 10"', 'viewBox="0 0 1465 2048"')
    .replace('d="M1 1L9 1L9 9Z"', 'd="M1026 1432L1031 1432L1031 1438Z"') +
    "";
  const pd2 = extractPathDataFromSvg(speck, 1465, 2048);
  assert.ok(pd2, "a negligible gradient speck should not refuse the whole artwork");
  assert.equal(pd2.subPaths[0].fill, "rgb(121,5,5)");
});

const { scalePathData } = await import("./svgPathModel.ts");

test("scaling carries the viewBox, so stretched art stays inside its node", () => {
  const pd = extractPathDataFromSvg(`<svg viewBox="0 0 10 10"><path d="M0 0L10 0L10 10Z"/></svg>`, 100, 100)!;
  const wide = scalePathData(pd, 2, 1);
  assert.deepEqual(wide.viewBox, { x: 0, y: 0, width: 200, height: 100 });
  const xs = wide.subPaths[0].anchors.map((a) => a.x);
  assert.ok(Math.max(...xs) <= wide.viewBox!.width, "anchors must stay within the frame they draw through");
});

test("duplicateGroups copies only the picked group", async () => {
  const { duplicateGroups, rotateGroups } = await import("./svgPathModel.ts");
  const pd = extractPathDataFromSvg(
    `<svg viewBox="0 0 10 10"><path d="M0 0 L2 0 L2 2 Z"/><path d="M4 4 L6 4 L6 6 Z"/><path d="M8 8 L9 8 L9 9 Z"/></svg>`,
    10, 10);
  assert.ok(pd);
  assert.equal(pd.subPaths.length, 3);
  const { pathData: dup, groups } = duplicateGroups(pd, [1], 3, 0);
  assert.equal(dup.subPaths.length, 4);
  assert.deepEqual(groups, [3]);
  assert.deepEqual(dup.subPaths[3].anchors.map((a) => [a.x, a.y]), [[7, 4], [9, 4], [9, 6]]);
  // The originals are untouched.
  assert.deepEqual(dup.subPaths.slice(0, 3), pd.subPaths.map((sp, i) => ({ ...sp, group: sp.group ?? i })));

  // A quarter turn about (5,5) sends (4,4) to (6,4).
  const rot = rotateGroups(pd, [1], Math.PI / 2, 5, 5);
  const [x, y] = [rot.subPaths[1].anchors[0].x, rot.subPaths[1].anchors[0].y];
  assert.ok(Math.abs(x - 6) < 1e-9 && Math.abs(y - 4) < 1e-9, `got ${x},${y}`);
  assert.deepEqual(rot.subPaths[0], pd.subPaths[0]);
});
