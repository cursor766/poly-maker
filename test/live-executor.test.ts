import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LiveExecutor } from "../src/execution/live-executor.js";
import { AuditLog } from "../src/logger.js";
import type { TradingGateway, TradingPreflight } from "../src/polymarket/trading-client.js";
import type {
  ManagedOrder,
  PositionState,
  Quote,
  ResolvedMarket,
  TokenBook,
} from "../src/types.js";

const market: ResolvedMarket = {
  slug: "market",
  conditionId: "condition",
  outcomes: ["A", "B"],
  tokenIds: ["a", "b"],
  tickSize: 0.01,
  minOrderSize: 5,
  acceptingOrders: true,
  closed: false,
  feesEnabled: true,
};

class FakeGateway implements TradingGateway {
  readonly wallet = "0x0000000000000000000000000000000000000001";
  orders: ManagedOrder[] = [];
  placed: Quote[] = [];
  canceledIds: string[] = [];
  canceledMarkets: string[] = [];
  mutations: string[] = [];

  async preflight(): Promise<TradingPreflight> {
    return {
      signer: this.wallet,
      wallet: this.wallet,
      walletType: 3,
      balance: 100,
      allowanceReady: true,
      closedOnly: false,
    };
  }

  async listOpenOrders(conditionId?: string): Promise<ManagedOrder[]> {
    return this.orders.filter((order) => !conditionId || order.conditionId === conditionId);
  }

  async placeLimitOrder(quote: Quote): Promise<string> {
    this.placed.push(quote);
    this.mutations.push(`place:${quote.tokenId}:${quote.price}`);
    const id = `order-${this.placed.length}`;
    this.orders.push({
      id,
      conditionId: "condition",
      tokenId: quote.tokenId,
      side: quote.side,
      price: quote.price,
      size: quote.size,
      matchedSize: 0,
    });
    return id;
  }

  async cancelOrders(orderIds: readonly string[]): Promise<void> {
    this.canceledIds.push(...orderIds);
    this.mutations.push(`cancel:${orderIds.join(",")}`);
    this.orders = this.orders.filter((order) => !orderIds.includes(order.id));
  }

  async cancelMarketOrders(conditionId: string): Promise<void> {
    this.canceledMarkets.push(conditionId);
    this.orders = this.orders.filter((order) => order.conditionId !== conditionId);
  }

  async syncPositions(_conditionIds: readonly string[]): Promise<PositionState> {
    return { byToken: new Map(), cash: 100 };
  }

  async postHeartbeat(_heartbeatId?: string): Promise<string> {
    return "heartbeat";
  }

  async subscribeUser(_onEvent: (event: unknown) => void): Promise<() => Promise<void>> {
    return async () => {};
  }

  async close(): Promise<void> {}
}

function makeExecutor(
  gateway: FakeGateway,
  audit: AuditLog,
  mode: "shadow" | "live",
  maxAccountNotional = 20,
): LiveExecutor {
  return new LiveExecutor(gateway, audit, {
    mode,
    conditionId: market.conditionId,
    tokenIds: market.tokenIds,
    allConditionIds: [market.conditionId],
    maxOrderNotional: 5,
    maxAccountNotional,
    cancelConfirmRetries: 2,
    cancelConfirmDelayMs: 1,
    repriceThresholdTicks: 2,
  });
}

const books = new Map<string, TokenBook>();
const quote: Quote = { tokenId: "a", outcome: "A", side: "BUY", price: 0.4, size: 5 };

test("live executor diffs remote orders and cancels only its condition", async () => {
  const directory = await mkdtemp(join(tmpdir(), "poly-maker-live-"));
  try {
    const gateway = new FakeGateway();
    gateway.orders = [
      {
        id: "replace",
        conditionId: "condition",
        tokenId: "a",
        side: "BUY",
        price: 0.3,
        size: 5,
        matchedSize: 0,
      },
      {
        id: "other-market",
        conditionId: "other",
        tokenId: "x",
        side: "BUY",
        price: 0.2,
        size: 5,
        matchedSize: 0,
      },
    ];
    const executor = makeExecutor(gateway, new AuditLog(join(directory, "audit.ndjson")), "live");
    executor.unlock();
    await executor.reconcile(market, [quote], books);

    assert.deepEqual(gateway.canceledIds, ["replace"]);
    assert.equal(gateway.placed.length, 1);
    assert.deepEqual(gateway.mutations, ["place:a:0.4", "cancel:replace"]);
    assert.deepEqual(gateway.canceledMarkets, []);
    assert.ok(gateway.orders.some((order) => order.id === "order-1"));
    assert.ok(gateway.orders.some((order) => order.id === "other-market"));
    assert.ok(executor.listRestingOrders().some((order) => order.tokenId === "a"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("trims quotes to the remaining account limit instead of failing closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "poly-maker-budget-"));
  try {
    const gateway = new FakeGateway();
    gateway.orders = [
      {
        id: "other-market",
        conditionId: "other",
        tokenId: "x",
        side: "BUY",
        price: 0.5,
        size: 36,
        matchedSize: 0,
      },
    ];
    const executor = makeExecutor(gateway, new AuditLog(join(directory, "audit.ndjson")), "live");
    executor.unlock();
    const layeredQuotes: Quote[] = [
      { tokenId: "a", outcome: "A", side: "BUY", price: 0.4, size: 5 },
      { tokenId: "b", outcome: "B", side: "BUY", price: 0.4, size: 5 },
    ];
    await executor.reconcile(market, layeredQuotes, books);
    assert.equal(gateway.placed.length, 1);
    assert.equal(gateway.placed[0]?.tokenId, "a");
    assert.equal(gateway.placed[0]?.price, 0.4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not fail closed when the account is already at the notional cap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "poly-maker-cap-"));
  try {
    const gateway = new FakeGateway();
    gateway.orders = [
      {
        id: "other-market",
        conditionId: "other",
        tokenId: "x",
        side: "BUY",
        price: 0.5,
        size: 50,
        matchedSize: 0,
      },
    ];
    const executor = makeExecutor(gateway, new AuditLog(join(directory, "audit.ndjson")), "live");
    executor.unlock();
    await executor.reconcile(market, [quote], books);
    assert.equal(gateway.placed.length, 0);
    assert.equal(gateway.canceledIds.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("places quotes when the account notional cap is disabled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "poly-maker-uncapped-"));
  try {
    const gateway = new FakeGateway();
    gateway.orders = [
      {
        id: "other-market",
        conditionId: "other",
        tokenId: "x",
        side: "BUY",
        price: 0.5,
        size: 50,
        matchedSize: 0,
      },
    ];
    const executor = makeExecutor(
      gateway,
      new AuditLog(join(directory, "audit.ndjson")),
      "live",
      0,
    );
    executor.unlock();
    await executor.reconcile(market, [quote], books);
    assert.equal(gateway.placed.length, 1);
    assert.equal(gateway.placed[0]?.tokenId, "a");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retains an existing quote when target moves by only one tick", async () => {
  const directory = await mkdtemp(join(tmpdir(), "poly-maker-reprice-"));
  try {
    const gateway = new FakeGateway();
    gateway.orders = [
      {
        id: "stable",
        conditionId: "condition",
        tokenId: "a",
        side: "BUY",
        price: 0.39,
        size: 5,
        matchedSize: 0,
      },
    ];
    const executor = makeExecutor(gateway, new AuditLog(join(directory, "audit.ndjson")), "live");
    executor.unlock();
    await executor.reconcile(market, [quote], books);

    assert.deepEqual(gateway.canceledIds, []);
    assert.equal(gateway.placed.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reconciles multiple price levels for the same outcome", async () => {
  const directory = await mkdtemp(join(tmpdir(), "poly-maker-levels-"));
  try {
    const gateway = new FakeGateway();
    const executor = makeExecutor(gateway, new AuditLog(join(directory, "audit.ndjson")), "live");
    const layeredQuotes: Quote[] = [
      { tokenId: "a", outcome: "A", side: "BUY", price: 0.4, size: 5 },
      { tokenId: "a", outcome: "A", side: "BUY", price: 0.38, size: 5 },
      { tokenId: "a", outcome: "A", side: "BUY", price: 0.36, size: 5 },
    ];
    executor.unlock();
    await executor.reconcile(market, layeredQuotes, books);
    await executor.reconcile(market, layeredQuotes, books);

    assert.equal(gateway.placed.length, 3);
    assert.equal(gateway.orders.length, 3);
    assert.deepEqual(gateway.canceledIds, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("lock wins a race with queued order submission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "poly-maker-lock-"));
  try {
    const gateway = new FakeGateway();
    const executor = makeExecutor(gateway, new AuditLog(join(directory, "audit.ndjson")), "live");
    executor.unlock();
    const reconciliation = executor.reconcile(market, [quote], books);
    const locking = executor.lock("source-locked");
    await Promise.all([reconciliation, locking]);
    assert.equal(gateway.placed.length, 0);
    assert.equal(executor.locked, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("shadow mode reads and plans but never mutates remote orders", async () => {
  const directory = await mkdtemp(join(tmpdir(), "poly-maker-shadow-"));
  try {
    const gateway = new FakeGateway();
    gateway.orders = [
      {
        id: "orphan",
        conditionId: "condition",
        tokenId: "a",
        side: "BUY",
        price: 0.3,
        size: 5,
        matchedSize: 0,
      },
    ];
    const executor = makeExecutor(gateway, new AuditLog(join(directory, "audit.ndjson")), "shadow");
    await executor.initialize();
    executor.unlock();
    await executor.reconcile(market, [quote], books);
    await executor.cancelAll("test");
    assert.equal(gateway.placed.length, 0);
    assert.equal(gateway.canceledIds.length, 0);
    assert.equal(gateway.orders.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
