import assert from "node:assert/strict";
import test from "node:test";
import { MarketResolver } from "../src/polymarket/market-resolver.js";

test("resolves the exact active moneyline and preserves outcome-token ordering", async () => {
  const fetcher: typeof fetch = async () =>
    new Response(
      JSON.stringify([
        {
          slug: "event",
          markets: [
            {
              slug: "event",
              conditionId: "condition",
              outcomes: '["LGD NBW","Rogue Warriors"]',
              clobTokenIds: '["home-token","away-token"]',
              orderPriceMinTickSize: 0.01,
              orderMinSize: 5,
              acceptingOrders: true,
              closed: false,
              active: true,
              enableOrderBook: true,
              sportsMarketType: "moneyline",
              feesEnabled: true,
            },
          ],
        },
      ]),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const resolver = new MarketResolver("https://example.test", fetcher);
  const market = await resolver.resolveMoneyline("event");
  assert.deepEqual(market.outcomes, ["LGD NBW", "Rogue Warriors"]);
  assert.deepEqual(market.tokenIds, ["home-token", "away-token"]);
});

test("lists moneyline markets with inferred rounds", async () => {
  const fetcher: typeof fetch = async () =>
    new Response(
      JSON.stringify([
        {
          slug: "event",
          markets: [
            {
              slug: "event",
              conditionId: "match",
              outcomes: '["A","B"]',
              clobTokenIds: '["a","b"]',
              orderPriceMinTickSize: 0.01,
              orderMinSize: 5,
              acceptingOrders: true,
              closed: false,
              active: true,
              enableOrderBook: true,
              sportsMarketType: "moneyline",
              feesEnabled: false,
            },
            {
              slug: "event-game1",
              conditionId: "game1",
              outcomes: '["A","B"]',
              clobTokenIds: '["a1","b1"]',
              orderPriceMinTickSize: 0.01,
              orderMinSize: 5,
              acceptingOrders: true,
              closed: false,
              active: true,
              enableOrderBook: true,
              sportsMarketType: "child_moneyline",
              feesEnabled: false,
            },
            {
              slug: "event-spread",
              conditionId: "spread",
              outcomes: '["A","B"]',
              clobTokenIds: '["as","bs"]',
              orderPriceMinTickSize: 0.01,
              orderMinSize: 5,
              acceptingOrders: true,
              closed: false,
              active: true,
              enableOrderBook: true,
              sportsMarketType: "spreads",
              feesEnabled: false,
            },
          ],
        },
      ]),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const markets = await new MarketResolver("https://example.test", fetcher).listMoneylineMarkets(
    "event",
  );
  assert.equal(markets.length, 2);
  assert.equal(markets[0]?.round, 0);
  assert.equal(markets[1]?.round, 1);
  assert.equal(markets[1]?.slug, "event-game1");
});

test("rejects a closed market", async () => {
  const fetcher: typeof fetch = async () =>
    new Response(
      JSON.stringify([
        {
          slug: "event",
          markets: [
            {
              slug: "event",
              conditionId: "condition",
              outcomes: '["A","B"]',
              clobTokenIds: '["a","b"]',
              orderPriceMinTickSize: 0.01,
              orderMinSize: 5,
              acceptingOrders: false,
              closed: true,
              active: false,
              enableOrderBook: true,
              sportsMarketType: "moneyline",
              feesEnabled: false,
            },
          ],
        },
      ]),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  await assert.rejects(
    new MarketResolver("https://example.test", fetcher).resolveMoneyline("event"),
  );
});
