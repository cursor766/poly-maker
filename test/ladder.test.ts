import assert from "node:assert/strict";
import test from "node:test";
import {
  adaptiveQuoteLevels,
  inferMappedMarketKind,
  marketNotionalCap,
  shouldSuppressTopRefill,
  sideIsBaited,
} from "../src/strategy/ladder.js";
import { generateComplementBuyQuotes } from "../src/strategy/maker.js";
import type { ResolvedMarket, TokenBook } from "../src/types.js";

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

const fairs = new Map([
  ["A", 0.6],
  ["B", 0.4],
]);

const emptyBooks = new Map<string, TokenBook>([
  ["a", { tokenId: "a", bids: [], asks: [{ price: 0.92, size: 10 }], receivedAt: 1 }],
  ["b", { tokenId: "b", bids: [], asks: [{ price: 0.92, size: 10 }], receivedAt: 1 }],
]);

const baseParameters = {
  targetReturnRate: 0.8,
  orderNotional: 5,
  maxOutcomePosition: 2000,
  maxOrderNotional: 300,
  maxAccountNotional: 400,
  maxMarketNotional: 300,
  quoteLevels: 4,
  levelSpacingTicks: 1,
  adaptiveLadder: true,
};

test("infers market kind from name and round", () => {
  assert.equal(inferMappedMarketKind({ round: 0 }), "moneyline");
  assert.equal(inferMappedMarketKind({ round: 1 }), "child_moneyline");
  assert.equal(inferMappedMarketKind({ name: "地图让分", round: 0 }), "map_handicap");
  assert.equal(inferMappedMarketKind({ name: "地图总数大小", round: 0 }), "totals");
  assert.equal(marketNotionalCap("child_moneyline", 300, 200), 300);
  assert.equal(marketNotionalCap("map_handicap", 300, 200), 200);
});

test("empty nearby book uses max layers and a crowded book uses one", () => {
  const empty = adaptiveQuoteLevels({
    book: { tokenId: "a", bids: [], asks: [], receivedAt: 1 },
    targetPrice: 0.56,
    tickSize: 0.01,
    nearbyTicks: 3,
    ownBids: [],
    layerShares: 10,
    maxLevels: 4,
  });
  const crowded = adaptiveQuoteLevels({
    book: {
      tokenId: "a",
      bids: [
        { price: 0.56, size: 80 },
        { price: 0.55, size: 40 },
      ],
      asks: [],
      receivedAt: 1,
    },
    targetPrice: 0.56,
    tickSize: 0.01,
    nearbyTicks: 3,
    ownBids: [],
    layerShares: 10,
    maxLevels: 4,
  });
  const ownOnly = adaptiveQuoteLevels({
    book: {
      tokenId: "a",
      bids: [{ price: 0.56, size: 12 }],
      asks: [],
      receivedAt: 1,
    },
    targetPrice: 0.56,
    tickSize: 0.01,
    nearbyTicks: 3,
    ownBids: [{ price: 0.56, size: 12 }],
    layerShares: 10,
    maxLevels: 4,
  });
  assert.equal(empty, 4);
  assert.equal(crowded, 1);
  assert.equal(ownOnly, 4);
});

test("suppresses the vacated top after a recent fill", () => {
  assert.equal(shouldSuppressTopRefill(1_000, 5_000, 10_000), true);
  assert.equal(shouldSuppressTopRefill(1_000, 12_000, 10_000), false);
  assert.equal(shouldSuppressTopRefill(undefined, 5_000, 10_000), false);
});

test("adaptive complement quotes stack four ticks on an empty book", () => {
  const quotes = generateComplementBuyQuotes(
    market,
    fairs,
    emptyBooks,
    { byToken: new Map(), cash: 100 },
    baseParameters,
  );
  const a = quotes.filter((quote) => quote.tokenId === "a").map((quote) => quote.price);
  assert.deepEqual(a, [0.52, 0.51, 0.5, 0.49]);
});

test("adaptive complement quotes keep one level when other makers sit nearby", () => {
  const books = new Map<string, TokenBook>([
    [
      "a",
      {
        tokenId: "a",
        bids: [
          { price: 0.52, size: 80 },
          { price: 0.51, size: 40 },
        ],
        asks: [{ price: 0.68, size: 10 }],
        receivedAt: 1,
      },
    ],
    [
      "b",
      {
        tokenId: "b",
        bids: [{ price: 0.28, size: 80 }],
        asks: [{ price: 0.52, size: 10 }],
        receivedAt: 1,
      },
    ],
  ]);
  const quotes = generateComplementBuyQuotes(
    market,
    fairs,
    books,
    { byToken: new Map(), cash: 100 },
    baseParameters,
  );
  assert.equal(quotes.filter((quote) => quote.tokenId === "a").length, 1);
  assert.equal(quotes.find((quote) => quote.tokenId === "a")?.price, 0.52);
});

test("skips a baited side once inventory reaches the market cap ratio", () => {
  const quotes = generateComplementBuyQuotes(
    market,
    fairs,
    emptyBooks,
    { byToken: new Map([["a", 200]]), cash: 100 },
    { ...baseParameters, baitPositionRatio: 0.6, maxMarketNotional: 300 },
  );
  assert.equal(sideIsBaited(200, 300, 0.6), true);
  assert.equal(
    quotes.some((quote) => quote.tokenId === "a"),
    false,
  );
  assert.ok(quotes.some((quote) => quote.tokenId === "b"));
});

test("delays replenishing the top bid after a fill on a multi-level ladder", () => {
  const quotes = generateComplementBuyQuotes(
    market,
    fairs,
    emptyBooks,
    { byToken: new Map(), cash: 100 },
    {
      ...baseParameters,
      now: 5_000,
      refillTopDelayMs: 10_000,
      lastFillAtByToken: new Map([["a", 1_000]]),
    },
  );
  const a = quotes.filter((quote) => quote.tokenId === "a").map((quote) => quote.price);
  assert.equal(a.includes(0.52), false);
  assert.deepEqual(a, [0.51, 0.5, 0.49]);
});
