import assert from "node:assert/strict";
import test from "node:test";
import { annotateBookLevels } from "../web/lib/own-book.js";

test("marks a public bid that matches our resting order", () => {
  const rows = annotateBookLevels(
    [
      { price: 0.62, size: 144.2 },
      { price: 0.61, size: 20 },
    ],
    [{ side: "BUY", price: 0.62, size: 50, matchedSize: 0 }],
    "BUY",
    "bid",
  );
  assert.equal(rows[0]?.ours, 50);
  assert.equal(rows[0]?.size, 144.2);
  assert.equal(rows[1]?.ours, 0);
});

test("inserts our bid when the public book has not caught up yet", () => {
  const rows = annotateBookLevels(
    [{ price: 0.6, size: 10 }],
    [{ side: "BUY", price: 0.62, size: 80, matchedSize: 10 }],
    "BUY",
    "bid",
  );
  assert.deepEqual(
    rows.map((row) => [row.price, row.size, row.ours]),
    [
      [0.62, 70, 70],
      [0.6, 10, 0],
    ],
  );
});

test("ignores the opposite side and filled size", () => {
  const rows = annotateBookLevels(
    [{ price: 0.7, size: 12 }],
    [
      { side: "SELL", price: 0.7, size: 12, matchedSize: 0 },
      { side: "BUY", price: 0.62, size: 5, matchedSize: 5 },
    ],
    "BUY",
    "bid",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.ours, 0);
});
