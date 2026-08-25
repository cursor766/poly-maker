import assert from "node:assert/strict";
import test from "node:test";
import { generateComplementBuyQuotes } from "../src/strategy/maker.js";
import type { PositionState, ResolvedMarket, TokenBook } from "../src/types.js";

const market: ResolvedMarket = {
  slug: "match",
  conditionId: "condition",
  outcomes: ["A", "B"],
  tokenIds: ["a", "b"],
  tickSize: 0.01,
  minOrderSize: 5,
  acceptingOrders: true,
  closed: false,
  feesEnabled: true,
};

const positions: PositionState = { byToken: new Map(), cash: 100 };

test("converts 80% return-rate asks into complementary BUY-only quotes", () => {
  const books = new Map<string, TokenBook>([
    [
      "a",
      {
        tokenId: "a",
        bids: [{ price: 0.3, size: 10 }],
        asks: [{ price: 0.9, size: 10 }],
        receivedAt: 1,
      },
    ],
    [
      "b",
      {
        tokenId: "b",
        bids: [{ price: 0.2, size: 10 }],
        asks: [{ price: 0.9, size: 10 }],
        receivedAt: 1,
      },
    ],
  ]);
  const quotes = generateComplementBuyQuotes(
    market,
    new Map([
      ["A", 0.6],
      ["B", 0.4],
    ]),
    books,
    positions,
    {
      targetReturnRate: 0.8,
      orderNotional: 5,
      maxOutcomePosition: 50,
      maxOrderNotional: 5,
      maxAccountNotional: 20,
      quoteLevels: 1,
      levelSpacingTicks: 2,
    },
  );

  assert.deepEqual(
    quotes.map(({ tokenId, side, price }) => ({ tokenId, side, price })),
    [
      { tokenId: "a", side: "BUY", price: 0.5 },
      { tokenId: "b", side: "BUY", price: 0.25 },
    ],
  );
  for (const quote of quotes) assert.ok(quote.price * quote.size <= 5 + 1e-9);
});

test("retreats one tick instead of crossing the best ask", () => {
  const books = new Map<string, TokenBook>([
    [
      "a",
      {
        tokenId: "a",
        bids: [],
        asks: [{ price: 0.45, size: 10 }],
        receivedAt: 1,
      },
    ],
    [
      "b",
      {
        tokenId: "b",
        bids: [],
        asks: [{ price: 0.2, size: 10 }],
        receivedAt: 1,
      },
    ],
  ]);
  const quotes = generateComplementBuyQuotes(
    market,
    new Map([
      ["A", 0.6],
      ["B", 0.4],
    ]),
    books,
    positions,
    {
      targetReturnRate: 0.8,
      orderNotional: 5,
      maxOutcomePosition: 50,
      maxOrderNotional: 5,
      maxAccountNotional: 20,
      quoteLevels: 1,
      levelSpacingTicks: 2,
    },
  );
  assert.equal(quotes[0]?.price, 0.44);
  assert.equal(quotes[1]?.price, 0.19);
});

test("generates three five-dollar layers per outcome at two-tick spacing", () => {
  const books = new Map<string, TokenBook>([
    [
      "a",
      {
        tokenId: "a",
        bids: [],
        asks: [{ price: 0.9, size: 10 }],
        receivedAt: 1,
      },
    ],
    [
      "b",
      {
        tokenId: "b",
        bids: [],
        asks: [{ price: 0.9, size: 10 }],
        receivedAt: 1,
      },
    ],
  ]);
  const quotes = generateComplementBuyQuotes(
    market,
    new Map([
      ["A", 0.6],
      ["B", 0.4],
    ]),
    books,
    positions,
    {
      targetReturnRate: 0.8,
      orderNotional: 5,
      maxOutcomePosition: 100,
      maxOrderNotional: 5,
      maxAccountNotional: 30,
      quoteLevels: 3,
      levelSpacingTicks: 2,
    },
  );

  assert.deepEqual(
    quotes.map(({ tokenId, price }) => ({ tokenId, price })),
    [
      { tokenId: "a", price: 0.5 },
      { tokenId: "a", price: 0.48 },
      { tokenId: "a", price: 0.46 },
      { tokenId: "b", price: 0.25 },
      { tokenId: "b", price: 0.23 },
      { tokenId: "b", price: 0.21 },
    ],
  );
  for (const quote of quotes) assert.ok(quote.price * quote.size <= 5 + 1e-9);
});
