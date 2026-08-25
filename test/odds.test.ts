import assert from "node:assert/strict";
import test from "node:test";
import { OddsBook } from "../src/odds/odds-book.js";
import { mapFairProbabilities } from "../src/odds/outcome-mapper.js";
import { normalizeDecimalOdds } from "../src/odds/probability.js";
import type { MarketMapping, ResolvedMarket } from "../src/types.js";

const mapping: MarketMapping = {
  name: "fixture",
  enabled: true,
  sourceMatchId: "match",
  sourceMarketId: "market",
  polymarketSlug: "fixture",
  outcomes: [
    { sourceOddId: "home", outcome: "LGD NBW" },
    { sourceOddId: "away", outcome: "Rogue Warriors" },
  ],
};

const resolved: ResolvedMarket = {
  slug: "fixture",
  conditionId: "condition",
  outcomes: ["LGD NBW", "Rogue Warriors"],
  tokenIds: ["token-home", "token-away"],
  tickSize: 0.01,
  minOrderSize: 5,
  acceptingOrders: true,
  closed: false,
  feesEnabled: true,
};

test("removes overround from decimal odds", () => {
  const result = normalizeDecimalOdds([1.962, 1.804]);
  const [home, away] = result.probabilities;
  assert.ok(home !== undefined);
  assert.ok(away !== undefined);
  assert.ok(Math.abs(home - 0.47899) < 0.0001);
  assert.ok(Math.abs(away - 0.52101) < 0.0001);
  assert.ok(Math.abs(home + away - 1) < 1e-12);
});

test("odds book emits only after both configured legs arrive", () => {
  const book = new OddsBook([mapping], 0.15, 1.25);
  const first = book.apply([
    {
      marketId: "market",
      matchId: "match",
      oddId: "home",
      decimalOdd: 1.962,
      returnRate: 94,
      receivedAt: 100,
    },
  ]);
  assert.equal(first.snapshots.length, 0);

  const second = book.apply([
    {
      marketId: "market",
      matchId: "match",
      oddId: "away",
      decimalOdd: 1.804,
      returnRate: 94,
      receivedAt: 101,
    },
  ]);
  assert.equal(second.snapshots.length, 1);
  const snapshot = second.snapshots[0];
  assert.ok(snapshot);
  const mapped = mapFairProbabilities(mapping, resolved, snapshot);
  assert.ok((mapped.get("Rogue Warriors") ?? 0) > 0.52);
});

test("odds book rejects implausible single-update jumps", () => {
  const book = new OddsBook([mapping], 0.1, 1.25);
  book.apply([
    {
      marketId: "market",
      matchId: "match",
      oddId: "home",
      decimalOdd: 2,
      returnRate: 94,
      receivedAt: 100,
    },
  ]);
  const result = book.apply([
    {
      marketId: "market",
      matchId: "match",
      oddId: "home",
      decimalOdd: 1.2,
      returnRate: 94,
      receivedAt: 101,
    },
  ]);
  assert.equal(result.rejected.length, 1);
});

test("outcome mapper fails closed on a wrong team name", () => {
  const bad = {
    ...mapping,
    outcomes: [
      { sourceOddId: "home", outcome: "Wrong Team" },
      { sourceOddId: "away", outcome: "Rogue Warriors" },
    ],
  };
  assert.throws(() =>
    mapFairProbabilities(bad, resolved, {
      sourceMarketId: "market",
      probabilities: new Map([
        ["home", 0.5],
        ["away", 0.5],
      ]),
      overround: 1,
      receivedAt: 1,
    }),
  );
});
