import { test } from "node:test";
import assert from "node:assert/strict";
import { pickVersionDir } from "./blenderAddon.js";

test("picks the highest major.minor dir and ignores the rest", () => {
  assert.equal(pickVersionDir(["3.2", "5.1", "4.10", "config", "2.93.1"]), "5.1");
  assert.equal(pickVersionDir(["4.2", "4.10"]), "4.10");
  assert.equal(pickVersionDir(["config"]), null);
});
