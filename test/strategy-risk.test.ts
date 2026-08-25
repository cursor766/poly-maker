import assert from "node:assert/strict";
import test from "node:test";
import { RiskEngine } from "../src/risk/risk-engine.js";
import { generateMakerQuotes } from "../src/strategy/maker.js";
import type { FairSnapshot, PositionState, ResolvedMarket, TokenBook } from "../src/types.js";

const market: ResolvedMarket = {
  slug: "fixture",
  conditionId: "condition",
  outcomes: ["LGD NBW", "Rogue Warriors"],
  tokenIds: ["home", "away"],
  tickSize: 0.01,
  minOrderSize: 5,
  acceptingOrders: true,
  closed: false,
  feesEnabled: true,
};

const books = new Map<string, TokenBook>([
  [
    "home",
    {
      tokenId: "home",
      bids: [{ price: 0.4, size: 10 }],
      asks: [{ price: 0.45, size: 10 }],
      receivedAt: 1_000,
    },
  ],
  [
    "away",
    {
      tokenId: "away",
      bids: [{ price: 0.55, size: 10 }],
      asks: [{ price: 0.6, size: 10 }],
      receivedAt: 1_000,
    },
  ],
]);

const positions: PositionState = { byToken: new Map(), cash: 0 };

test("maker generates tick-aligned post-only two-sided quotes", () => {
  const quotes = generateMakerQuotes(
    market,
    new Map([
      ["LGD NBW", 0.48],
      ["Rogue Warriors", 0.52],
    ]),
    books,
    positions,
    {
      minEdge: 0.02,
      quoteHalfSpread: 0.03,
      inventorySkew: 0.002,
      orderSize: 5,
      maxOutcomePosition: 50,
    },
  );
  assert.equal(quotes.length, 4);
  for (const quote of quotes) {
    assert.ok(Math.abs(Math.round(quote.price * 100) - quote.price * 100) < 1e-9);
    const book = books.get(quote.tokenId);
    assert.ok(book);
    const bestBid = book.bids[0];
    const bestAsk = book.asks[0];
    assert.ok(bestBid);
    assert.ok(bestAsk);
    if (quote.side === "BUY") assert.ok(quote.price < bestAsk.price);
    else assert.ok(quote.price > bestBid.price);
  }
});

test("inventory skew lowers bids for a long outcome", () => {
  const neutral = generateMakerQuotes(
    market,
    new Map([
      ["LGD NBW", 0.48],
      ["Rogue Warriors", 0.52],
    ]),
    books,
    positions,
    {
      minEdge: 0.02,
      quoteHalfSpread: 0.03,
      inventorySkew: 0.002,
      orderSize: 5,
      maxOutcomePosition: 50,
    },
  );
  const long = generateMakerQuotes(
    market,
    new Map([
      ["LGD NBW", 0.48],
      ["Rogue Warriors", 0.52],
    ]),
    books,
    { byToken: new Map([["home", 10]]), cash: 0 },
    {
      minEdge: 0.02,
      quoteHalfSpread: 0.03,
      inventorySkew: 0.002,
      orderSize: 5,
      maxOutcomePosition: 50,
    },
  );
  const neutralBid = neutral.find((quote) => quote.tokenId === "home" && quote.side === "BUY");
  const longBid = long.find((quote) => quote.tokenId === "home" && quote.side === "BUY");
  assert.ok(neutralBid);
  assert.ok(longBid);
  assert.ok(longBid.price < neutralBid.price);
});

test("risk engine kills quoting on stale odds and disconnect", () => {
  const risk = new RiskEngine({
    oddsStaleMs: 5_000,
    maxOutcomePosition: 50,
    maxTotalExposure: 75,
  });
  const fair: FairSnapshot = {
    sourceMarketId: "market",
    probabilities: new Map([
      ["home-id", 0.48],
      ["away-id", 0.52],
    ]),
    overround: 1.06,
    receivedAt: 1_000,
  };

  const disconnected = risk.evaluate({
    now: 2_000,
    mqttConnected: false,
    fair,
    sourceState: undefined,
    market,
    books,
    positions,
  });
  assert.equal(disconnected.reason, "mqtt-disconnected");

  const stale = risk.evaluate({
    now: 7_000,
    mqttConnected: true,
    fair,
    sourceState: undefined,
    market,
    books,
    positions,
  });
  assert.equal(stale.reason, "stale-fair-odds");

  const preLock = risk.evaluate({
    now: 2_000,
    mqttConnected: true,
    polymarketConnected: true,
    minFairReceivedAt: 1_500,
    fair,
    sourceState: undefined,
    market,
    books,
    positions,
  });
  assert.equal(preLock.reason, "pre-lock-fair-odds");
});
