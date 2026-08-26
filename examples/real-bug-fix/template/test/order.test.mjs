import assert from "node:assert/strict";
import test from "node:test";

import { parseOrderLine } from "../src/order-parser.ts";
import { subtotalCents } from "../src/pricing.ts";

test("parses a basic line", () => {
  assert.deepEqual(parseOrderLine("A,1,150"), { sku: "A", quantity: 1, unitPriceCents: 150 });
});

test("totals a one-quantity line", () => {
  assert.equal(subtotalCents([parseOrderLine("A,1,150")]), 150);
});
