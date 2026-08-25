import assert from "node:assert/strict";
import test from "node:test";

import { sum } from "../src/sum.ts";

test("sum adds positive numbers", () => {
  assert.equal(sum(2, 3), 5);
});

test("sum handles negatives and decimals", () => {
  assert.equal(sum(-1.5, 0.5), -1);
});
