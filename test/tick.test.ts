import assert from "node:assert/strict";
import test from "node:test";
import { generateComplementBuyQuotes } from "../src/strategy/maker.js";
import { ceilToTick, clobPrice, clobSize, floorToTick } from "../src/strategy/tick.js";
import type { PositionState, ResolvedMarket, TokenBook } from "../src/types.js";

test("floorToTick emits JSON-safe 0.01 prices instead of binary leftovers", () => {
  const binaryLeftover = Math.floor((0.47 + 1e-12) / 0.01) * 0.01;
  const naiveFloor = Math.floor(0.47 / 0.01) * 0.01;
  assert.equal(JSON.stringify(binaryLeftover), "0.47000000000000003");
  assert.equal(naiveFloor, 0.46);
  assert.equal(JSON.stringify(floorToTick(0.4783, 0.01)), "0.47");
  assert.equal(JSON.stringify(floorToTick(binaryLeftover, 0.01)), "0.47");
  assert.equal(JSON.stringify(clobPrice(binaryLeftover)), "0.47");
  assert.equal(JSON.stringify(floorToTick(0.29, 0.01)), "0.29");
  assert.equal(JSON.stringify(floorToTick(0.47, 0.01)), "0.47");
  assert.equal(JSON.stringify(ceilToTick(binaryLeftover, 0.01)), "0.47");
  assert.equal(JSON.stringify(clobSize(Math.floor(5.47 * 100) / 100)), "5.47");
});

test("stacked-vig complement buys stringify with at most 2 decimals", () => {
  const market: ResolvedMarket = {
    slug: "hok-edg-lgd-2026-08-27-game1",
    conditionId: "condition",
    outcomes: ["A", "B"],
    tokenIds: ["a", "b"],
    tickSize: 0.01,
    minOrderSize: 5,
    acceptingOrders: true,
    closed: false,
    feesEnabled: true,
  };
  const books = new Map<string, TokenBook>([
    ["a", { tokenId: "a", bids: [], asks: [{ price: 0.92, size: 10 }], receivedAt: 1 }],
    ["b", { tokenId: "b", bids: [], asks: [{ price: 0.92, size: 10 }], receivedAt: 1 }],
  ]);
  const positions: PositionState = { byToken: new Map(), cash: 100 };
  const quotes = generateComplementBuyQuotes(
    market,
    new Map([
      ["A", 0.5305164319248826],
      ["B", 0.4694835680751174],
    ]),
    books,
    positions,
    {
      targetReturnRate: 0.95,
      sourceOverround: 1.047197640117994,
      orderNotional: 5,
      maxOutcomePosition: 50,
      maxOrderNotional: 5,
      maxAccountNotional: 20,
      quoteLevels: 1,
      levelSpacingTicks: 1,
    },
  );
  assert.ok(quotes.length >= 2);
  for (const quote of quotes) {
    const serialized = JSON.stringify(quote.price);
    const decimals = serialized.split(".")[1]?.length ?? 0;
    assert.ok(decimals <= 2, serialized);
    assert.equal(quote.price, Number(quote.price.toFixed(2)));
  }
});
