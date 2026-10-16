import assert from "node:assert/strict";
import test from "node:test";
import { total } from "../src/index.js";

test("total includes every value", () => {
  assert.equal(total([2, 3, 5]), 10);
});

test("empty total is the additive identity", () => {
  assert.equal(total([]), 0);
});
