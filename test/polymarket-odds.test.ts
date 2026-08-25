import assert from "node:assert/strict";
import test from "node:test";
import { PolymarketOddsClient } from "../src/polymarket/odds-client.js";

test("loads active winner books without failing on an empty side", async () => {
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input.toString());
    if (url.hostname === "clob.test") {
      assert.equal(url.pathname, "/books");
      assert.equal(init?.method, "POST");
      const requests = JSON.parse(String(init?.body)) as Array<{ token_id: string }>;
      const quotes: Record<string, [number, number | null]> = {
        "match-lgd": [0.36, 0.4],
        "match-rw": [0.6, 0.64],
        "game1-lgd": [0.03, null],
        "game1-rw": [0.02, 0.97],
      };
      return Response.json(
        requests.map(({ token_id: tokenId }) => {
          const quote = quotes[tokenId];
          assert.ok(quote);
          return {
            asset_id: tokenId,
            bids: [{ price: String(quote[0]), size: "10" }],
            asks: quote[1] === null ? [] : [{ price: String(quote[1]), size: "10" }],
          };
        }),
      );
    }
    assert.equal(url.toString(), "https://gamma.test/events?slug=hok-lgd-rw-2026-07-31");
    return Response.json([
      {
        slug: "hok-lgd-rw-2026-07-31",
        markets: [
          {
            slug: "hok-lgd-rw-2026-07-31",
            outcomes: '["LGD NBW","Rogue Warriors"]',
            outcomePrices: '["0.395","0.605"]',
            clobTokenIds: '["match-lgd","match-rw"]',
            sportsMarketType: "moneyline",
            active: true,
            closed: false,
            acceptingOrders: true,
          },
          {
            slug: "hok-lgd-rw-2026-07-31-game1",
            outcomes: '["LGD NBW","Rogue Warriors"]',
            outcomePrices: '["0.505","0.495"]',
            clobTokenIds: '["game1-lgd","game1-rw"]',
            sportsMarketType: "child_moneyline",
            active: true,
            closed: false,
            acceptingOrders: true,
          },
          {
            slug: "hok-lgd-rw-2026-07-31-total-games-3pt5",
            outcomes: '["Over","Under"]',
            outcomePrices: '["0.54","0.46"]',
            clobTokenIds: '["total-over","total-under"]',
            sportsMarketType: "totals",
            active: true,
            closed: false,
            acceptingOrders: true,
          },
        ],
      },
    ]);
  };

  const snapshots = await new PolymarketOddsClient(
    "https://gamma.test",
    "https://clob.test",
    fetcher,
  ).fetchWinnerOdds("hok-lgd-rw-2026-07-31");
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0]?.round, 0);
  assert.deepEqual(snapshots[0]?.prices, [0.4, 0.64]);
  assert.deepEqual(snapshots[0]?.bestBids, [0.36, 0.6]);
  assert.deepEqual(snapshots[0]?.referencePrices, [0.395, 0.605]);
  assert.equal(snapshots[1]?.round, 1);
  assert.deepEqual(snapshots[1]?.prices, [null, 0.97]);
});
