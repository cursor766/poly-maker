import assert from "node:assert/strict";
import test from "node:test";
import { buildManualBuyQuotes } from "../src/strategy/maker.js";

test("manual buy quotes stack extra layers below the recommended price", () => {
  const quotes = buildManualBuyQuotes({
    outcome: "EDward Gaming",
    tokenId: "token-edg",
    price: 0.54,
    shares: 12,
    layers: 3,
    spacingTicks: 1,
    tickSize: 0.01,
    minOrderSize: 5,
  });
  assert.deepEqual(
    quotes.map((quote) => quote.price),
    [0.54, 0.53, 0.52],
  );
  assert.equal(quotes[0]?.size, 12);
  assert.equal(quotes[0]?.side, "BUY");
});

test("manual buy quotes skip duplicate ticks and respect the floor", () => {
  const quotes = buildManualBuyQuotes({
    outcome: "LGD NBW",
    tokenId: "token-lgd",
    price: 0.02,
    shares: 5,
    layers: 5,
    spacingTicks: 1,
    tickSize: 0.01,
    minOrderSize: 5,
  });
  assert.deepEqual(
    quotes.map((quote) => quote.price),
    [0.02, 0.01],
  );
});
