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
            {
              slug: "event-game-handicap-away-3pt5",
              conditionId: "handicap",
              outcomes: '["A","B"]',
              clobTokenIds: '["ah","bh"]',
              orderPriceMinTickSize: 0.01,
              orderMinSize: 5,
              acceptingOrders: true,
              closed: false,
              active: true,
              enableOrderBook: true,
              sportsMarketType: "map_handicap",
              feesEnabled: false,
            },
            {
              slug: "event-total-maps-5pt5",
              conditionId: "totals",
              outcomes: '["Over","Under"]',
              clobTokenIds: '["to","tu"]',
              orderPriceMinTickSize: 0.01,
              orderMinSize: 5,
              acceptingOrders: true,
              closed: false,
              active: true,
              enableOrderBook: true,
              sportsMarketType: "totals",
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
  assert.equal(markets.length, 4);
  assert.equal(markets[0]?.kind, "moneyline");
  const game = markets.find((market) => market.kind === "child_moneyline");
  assert.equal(game?.round, 1);
  assert.equal(game?.slug, "event-game1");
  const handicap = markets.find((market) => market.kind === "map_handicap");
  assert.equal(handicap?.line, 3.5);
  assert.equal(handicap?.round, 0);
  const totals = markets.find((market) => market.kind === "totals");
  assert.equal(totals?.line, 5.5);
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
