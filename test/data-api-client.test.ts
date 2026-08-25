import assert from "node:assert/strict";
import test from "node:test";
import { parseTrade, PolymarketDataApiClient } from "../src/polymarket/data-api-client.js";

test("parses Polymarket data-api trades into desk activity", () => {
  const trade = parseTrade(
    {
      transactionHash: "0xabc",
      timestamp: 1_787_626_917,
      side: "BUY",
      outcome: "EDward Gaming",
      price: "0.67",
      size: 50,
      name: "zhouxx",
      proxyWallet: "0x1a97344451463bb516cbab365c7e2e3835ec0a4d",
    },
    0,
  );
  assert.ok(trade);
  assert.equal(trade.side, "BUY");
  assert.equal(trade.outcome, "EDward Gaming");
  assert.equal(trade.price, 0.67);
  assert.equal(trade.size, 50);
  assert.equal(trade.notional, 33.5);
  assert.equal(trade.at, 1_787_626_917_000);
});

test("data api client maps holder groups onto outcomes", async () => {
  const client = new PolymarketDataApiClient("https://data.example");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    assert.match(url, /\/holders\?market=condition/);
    return new Response(
      JSON.stringify([
        {
          token: "token-a",
          holders: [
            { proxyWallet: "0xaaa", name: "alice", amount: 80, outcomeIndex: 0 },
            { proxyWallet: "0xbbb", name: "bob", amount: 20, outcomeIndex: 0 },
          ],
        },
        {
          token: "token-b",
          holders: [{ proxyWallet: "0xccc", name: "carol", amount: 10, outcomeIndex: 1 }],
        },
      ]),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const groups = await client.fetchHolders("condition", ["EDward Gaming", "LGD NBW"]);
    assert.equal(groups.length, 2);
    assert.equal(groups[0]?.outcome, "EDward Gaming");
    assert.equal(groups[0]?.holders[0]?.name, "alice");
    assert.equal(groups[0]?.holders[0]?.share, 0.8);
    assert.equal(groups[1]?.outcome, "LGD NBW");
    assert.equal(groups[1]?.holders[0]?.amount, 10);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
