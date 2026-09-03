/**
 * Self-check for arrange_canvas payload validation.
 * Run: `npx tsx server/routes/agent.arrange.test.ts`
 *
 * The operator writes these ids and numbers from its own head, so this is the
 * only thing between a hallucinated id (or a NaN) and an UPDATE on the user's
 * canvas. It fails silently in the useful direction if it breaks: bad rows just
 * get written.
 */
import assert from "node:assert/strict";
import { parseArrangeMoves } from "./agent.js";

const ID = "11111111-2222-3333-4444-555555555555";
const errs = (m: unknown) => (parseArrangeMoves(m) as { errors: string[] }).errors;
const okMoves = (m: unknown) => (parseArrangeMoves(m) as { moves: unknown[] }).moves;

// Shape
assert.ok(errs([]).length > 0, "empty array rejected");
assert.ok(errs("nope").length > 0, "non-array rejected");
assert.ok(errs(Array.from({ length: 201 }, () => ({ id: ID, x: 0 }))).length > 0, "over 200 rejected");

// Ids
assert.ok(errs([{ id: "not-a-uuid", x: 0 }]).length > 0, "non-uuid rejected");
assert.ok(errs([{ x: 0 }]).length > 0, "missing id rejected");

// Numbers
assert.ok(errs([{ id: ID, x: Number.NaN }]).length > 0, "NaN rejected");
assert.ok(errs([{ id: ID, y: Infinity }]).length > 0, "Infinity rejected");
assert.ok(errs([{ id: ID, x: "10" }]).length > 0, "string coordinate rejected");
assert.ok(errs([{ id: ID, width: -1 }]).length > 0, "negative width rejected");
assert.ok(errs([{ id: ID }]).length > 0, "no-op move rejected");

// Happy path — partial updates pass through untouched.
const good = okMoves([{ id: ID, x: 24, y: 48 }, { id: ID, width: 0 }]);
assert.equal(good.length, 2);
assert.deepEqual(good[0], { id: ID, x: 24, y: 48, width: undefined, height: undefined });

console.log("agent.arrange.test.ts: ok");
