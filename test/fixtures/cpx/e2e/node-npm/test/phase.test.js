import assert from "node:assert/strict";
import test from "node:test";
import { total } from "../src/index.js";

test("phase suite preserves negative totals", () => {
  assert.equal(total([-3, -2]), -5);
});
