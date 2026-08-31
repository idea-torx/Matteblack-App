/**
 * Self-check for `render_html`'s asset inlining.
 * Run: `npx tsx server/routes/agentRender.assets.test.ts`
 *
 * The whole point of `images` is that the bytes reach the page WITHOUT reaching
 * the agent's context. Two things have to hold, and neither fails loudly:
 *   1. every `asset:NAME` is replaced — a missed one renders as a broken image
 *      that looks like the agent wrote bad CSS;
 *   2. an unreadable ref is REPORTED, not silently dropped, or the agent gets a
 *      blank poster back and no idea why.
 */
import assert from "node:assert/strict";
import { inlineAssets } from "./agentRender.js";

const URI = "data:image/png;base64,AAAA";
const fake = async (ref: string) => (ref === "/bad/path.png" ? null : URI);

// Every occurrence, in CSS and in markup, in one pass.
const doc = `<style>body{background:url(asset:hero)}</style><img src="asset:logo"><i style="background:url(asset:hero)"></i>`;
const r = await inlineAssets(doc, { hero: "/uploads/a.png", logo: "~/repo/logo.png" }, fake);
assert.equal(r.html.includes("asset:"), false, "every placeholder must be substituted");
assert.equal(r.html.split(URI).length - 1, 3, "both hero uses and the logo");
assert.deepEqual(r.missing, []);

// A name that is a prefix of another must not eat the longer one's placeholder.
// Declared prefix-first, which is the order that breaks a naive left-to-right pass.
const distinct = async (ref: string) => `data:image/png;base64,${ref}`;
const p = await inlineAssets(`<i>asset:bg</i><i>asset:bg2</i>`, { bg: "SHORT", bg2: "LONG" }, distinct);
assert.equal(
  p.html,
  `<i>data:image/png;base64,SHORT</i><i>data:image/png;base64,LONG</i>`,
  "asset:bg must not consume the prefix of asset:bg2",
);

// Unreadable and malformed refs are reported, never silent.
const m = await inlineAssets(`<img src="asset:gone">`, { gone: "/bad/path.png" }, fake);
assert.deepEqual(m.missing, ["gone"]);
assert.ok(m.html.includes("asset:gone"), "an unresolved placeholder is left as-is");
assert.deepEqual((await inlineAssets("x", { "../etc": "y" }, fake)).missing, ["../etc"], "name charset is enforced");
assert.deepEqual((await inlineAssets("x", { ok: 42 }, fake)).missing, ["ok"], "non-string ref");

// The reason travels with the key — a bare name sent the last debugging session
// chasing the path when the file was simply too big.
const why = async () => ({ error: "13.4MB, over the 12.0MB limit" });
const w = await inlineAssets(`<img src="asset:bg">`, { bg: "/huge.png" }, why);
assert.deepEqual(w.problems, ["bg: 13.4MB, over the 12.0MB limit"]);
assert.deepEqual(w.missing, ["bg"]);

// No images at all is the common case and must be a no-op.
assert.equal((await inlineAssets("<p>hi</p>", undefined, fake)).html, "<p>hi</p>");

console.log("all render_html asset checks passed");
