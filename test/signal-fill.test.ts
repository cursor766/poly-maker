import assert from "node:assert/strict";
import { describe, it } from "node:test";

function walkAsks(
  asks: Array<{ price: number; size: number }>,
  notionalUsd: number,
  maxPrice: number,
) {
  let remaining = notionalUsd;
  let spent = 0;
  let shares = 0;
  let levelsTaken = 0;
  for (const level of asks) {
    if (level.price > maxPrice) break;
    const levelNotional = level.price * level.size;
    const take = Math.min(remaining, levelNotional);
    if (take <= 0) continue;
    spent += take;
    shares += take / level.price;
    remaining -= take;
    levelsTaken += 1;
    if (remaining <= 1e-9) break;
  }
  return {
    fillable: remaining <= 1e-6,
    filledUsd: spent,
    vwap: shares > 0 ? spent / shares : null,
    levelsTaken,
  };
}

describe("signal ask fill simulation", () => {
  it("fully fills within slippage", () => {
    const result = walkAsks(
      [
        { price: 0.78, size: 40 },
        { price: 0.79, size: 80 },
      ],
      50,
      0.8,
    );
    assert.equal(result.fillable, true);
    assert.equal(result.levelsTaken, 2);
    assert.ok(result.vwap !== null && result.vwap < 0.79);
  });

  it("stops at slippage cap", () => {
    const result = walkAsks(
      [
        { price: 0.78, size: 10 },
        { price: 0.82, size: 1000 },
      ],
      50,
      0.8,
    );
    assert.equal(result.fillable, false);
    assert.ok(result.filledUsd < 50);
    assert.equal(result.levelsTaken, 1);
  });
});
