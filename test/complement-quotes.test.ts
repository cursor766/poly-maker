import assert from "node:assert/strict";
import test from "node:test";
import { complementTargetBuyPrices, generateComplementBuyQuotes } from "../src/strategy/maker.js";
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

test("95% extra rake on a de-vigged book makes both BUY prices sum to 95 cents", () => {
  const prices = complementTargetBuyPrices(0.53, 0.47, 0.95);
  assert.ok(prices);
  const [buyA, buyB] = prices;
  assert.ok(Math.abs(buyA + buyB - 0.95) < 1e-12);
  assert.ok(buyA > 0.5 && buyA < 0.51);
  assert.ok(buyB > 0.44 && buyB < 0.45);
});

test("keeps source overround then adds 5 points of water", () => {
  const prices = complementTargetBuyPrices(0.53, 0.47, 0.95, 1.06);
  assert.ok(prices);
  const [buyA, buyB] = prices;
  assert.ok(Math.abs(buyA + buyB - (2 - 1.11)) < 1e-12);
  const askA = 1 - buyB;
  const askB = 1 - buyA;
  assert.ok(Math.abs(askA + askB - 1.11) < 1e-12);
  assert.ok(buyA < 0.53);
  assert.ok(buyB < 0.47);
});

test("5% rake lifts asks above 100¢ and drops complementary buys below 100¢", () => {
  const prices = complementTargetBuyPrices(0.53, 0.47, 0.95);
  assert.ok(prices);
  const [buyA, buyB] = prices;
  const askA = 1 - buyB;
  const askB = 1 - buyA;
  assert.ok(askA + askB > 1);
  assert.ok(buyA + buyB < 1);
  assert.ok(Math.abs(askA + askB - 1.05) < 1e-12);
});

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
      { tokenId: "a", side: "BUY", price: 0.52 },
      { tokenId: "b", side: "BUY", price: 0.28 },
    ],
  );
  for (const quote of quotes) assert.ok(quote.price * quote.size <= 5 + 1e-9);
});

test("95% complementary quotes keep both sides under the source-fair pair", () => {
  const books = new Map<string, TokenBook>([
    [
      "a",
      {
        tokenId: "a",
        bids: [{ price: 0.08, size: 10 }],
        asks: [{ price: 0.92, size: 10 }],
        receivedAt: 1,
      },
    ],
    [
      "b",
      {
        tokenId: "b",
        bids: [{ price: 0.08, size: 10 }],
        asks: [{ price: 0.92, size: 10 }],
        receivedAt: 1,
      },
    ],
  ]);
  const quotes = generateComplementBuyQuotes(
    market,
    new Map([
      ["A", 0.53],
      ["B", 0.47],
    ]),
    books,
    positions,
    {
      targetReturnRate: 0.95,
      sourceOverround: 1.06,
      orderNotional: 5,
      maxOutcomePosition: 50,
      maxOrderNotional: 5,
      maxAccountNotional: 20,
      quoteLevels: 1,
      levelSpacingTicks: 2,
    },
  );
  assert.deepEqual(
    quotes.map(({ outcome, side, price }) => ({
      outcome,
      side,
      price: Number(price.toFixed(2)),
    })),
    [
      { outcome: "A", side: "BUY", price: 0.47 },
      { outcome: "B", side: "BUY", price: 0.41 },
    ],
  );
  const first = quotes[0];
  const second = quotes[1];
  assert.ok(first && second);
  assert.equal(Number((first.price + second.price).toFixed(2)), 0.88);
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
      { tokenId: "a", price: 0.52 },
      { tokenId: "a", price: 0.5 },
      { tokenId: "a", price: 0.48 },
      { tokenId: "b", price: 0.28 },
      { tokenId: "b", price: 0.26 },
      { tokenId: "b", price: 0.24 },
    ],
  );
  for (const quote of quotes) assert.ok(quote.price * quote.size <= 5 + 1e-9);
});

test("reserves other markets' open notional instead of overshooting the account cap", () => {
  const books = new Map<string, TokenBook>([
    ["a", { tokenId: "a", bids: [], asks: [{ price: 0.9, size: 10 }], receivedAt: 1 }],
    ["b", { tokenId: "b", bids: [], asks: [{ price: 0.9, size: 10 }], receivedAt: 1 }],
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
      reservedAccountNotional: 20,
      quoteLevels: 1,
      levelSpacingTicks: 2,
    },
  );
  assert.equal(quotes.length, 0);
});

test("an unlimited account cap still quotes when other markets already have orders", () => {
  const books = new Map<string, TokenBook>([
    ["a", { tokenId: "a", bids: [], asks: [{ price: 0.9, size: 10 }], receivedAt: 1 }],
    ["b", { tokenId: "b", bids: [], asks: [{ price: 0.9, size: 10 }], receivedAt: 1 }],
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
      maxAccountNotional: 0,
      reservedAccountNotional: 9600,
      quoteLevels: 1,
      levelSpacingTicks: 2,
    },
  );
  assert.equal(quotes.length, 2);
});
