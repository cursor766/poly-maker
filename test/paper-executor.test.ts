import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PaperExecutor } from "../src/execution/paper-executor.js";
import { AuditLog } from "../src/logger.js";
import type { ResolvedMarket, TokenBook } from "../src/types.js";

const market: ResolvedMarket = {
  slug: "fixture",
  conditionId: "condition",
  outcomes: ["A", "B"],
  tokenIds: ["a", "b"],
  tickSize: 0.01,
  minOrderSize: 5,
  acceptingOrders: true,
  closed: false,
  feesEnabled: false,
};

test("paper executor fills a resting quote only after the book crosses it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "poly-maker-"));
  try {
    const executor = new PaperExecutor(new AuditLog(join(directory, "audit.ndjson")));
    const quote = { tokenId: "a", outcome: "A", side: "BUY" as const, price: 0.4, size: 5 };
    const initial = new Map<string, TokenBook>([
      [
        "a",
        {
          tokenId: "a",
          bids: [{ price: 0.35, size: 5 }],
          asks: [{ price: 0.45, size: 5 }],
          receivedAt: 1,
        },
      ],
    ]);
    await executor.reconcile(market, [quote], initial);
    assert.equal(executor.positions.byToken.get("a"), undefined);

    const crossed = new Map<string, TokenBook>([
      [
        "a",
        {
          tokenId: "a",
          bids: [{ price: 0.38, size: 5 }],
          asks: [{ price: 0.39, size: 5 }],
          receivedAt: 2,
        },
      ],
    ]);
    await executor.reconcile(market, [quote], crossed);
    assert.equal(executor.positions.byToken.get("a"), 5);
    assert.equal(executor.positions.cash, -2);
    const quoteAgain = { tokenId: "b", outcome: "B", side: "BUY" as const, price: 0.4, size: 5 };
    const deeper = { tokenId: "b", outcome: "B", side: "BUY" as const, price: 0.38, size: 5 };
    await executor.reconcile(
      market,
      [quoteAgain, deeper],
      new Map([
        [
          "b",
          {
            tokenId: "b",
            bids: [{ price: 0.35, size: 5 }],
            asks: [{ price: 0.45, size: 5 }],
            receivedAt: 3,
          },
        ],
      ]),
    );
    const resting = executor.listRestingOrders();
    assert.equal(resting.length, 2);
    await executor.cancelOrders([resting[0]?.id ?? ""], "test");
    assert.equal(executor.listRestingOrders().length, 1);
    await executor.cancelAll("test");
    assert.equal(executor.getOpenQuotes().length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
