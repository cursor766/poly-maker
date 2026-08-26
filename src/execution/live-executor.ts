import type { AuditLog } from "../logger.js";
import type { TradingGateway } from "../polymarket/trading-client.js";
import { clobPrice, clobSize } from "../strategy/tick.js";
import type {
  ManagedOrder,
  PositionState,
  Quote,
  ResolvedMarket,
  RestingOrder,
  TokenBook,
  TradingMode,
} from "../types.js";
import type { QuoteExecutor } from "./executor.js";

export interface LiveExecutorOptions {
  mode: Extract<TradingMode, "shadow" | "live">;
  conditionId: string;
  tokenIds: readonly string[];
  allConditionIds: readonly string[];
  maxOrderNotional: number;
  maxAccountNotional: number;
  cancelConfirmRetries: number;
  cancelConfirmDelayMs: number;
  repriceThresholdTicks: number;
}

function orderKey(order: Pick<ManagedOrder, "tokenId" | "side">): string {
  return `${order.tokenId}:${order.side}`;
}

function quoteKey(quote: Quote): string {
  return `${quote.tokenId}:${quote.side}`;
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) < 1e-8;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class TradingOperationQueue {
  private serial: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation, operation);
    this.serial = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class LiveExecutor implements QuoteExecutor {
  readonly positions: PositionState;
  locked = true;
  openOrderCount = 0;
  openOrderNotional = 0;
  private lastOrders: ManagedOrder[] = [];

  constructor(
    private readonly gateway: TradingGateway,
    private readonly audit: AuditLog,
    private readonly options: LiveExecutorOptions,
    positions: PositionState = { byToken: new Map(), cash: 0 },
    private readonly operationQueue = new TradingOperationQueue(),
  ) {
    this.positions = positions;
  }

  async initialize(): Promise<void> {
    await this.enqueue(async () => {
      const orphanOrders = await this.gateway.listOpenOrders(this.options.conditionId);
      this.lastOrders = orphanOrders;
      this.openOrderCount = orphanOrders.length;
      this.openOrderNotional = orphanOrders.reduce(
        (sum, order) => sum + order.price * Math.max(0, order.size - order.matchedSize),
        0,
      );
      if (orphanOrders.length === 0) return;
      await this.audit.write("orphan_orders", {
        conditionId: this.options.conditionId,
        mode: this.options.mode,
        orderIds: orphanOrders.map((order) => order.id),
      });
      if (this.options.mode === "live") {
        await this.cancelRemote(orphanOrders, "startup-orphan-reconciliation");
        this.openOrderCount = 0;
        this.openOrderNotional = 0;
      }
    });
    await this.syncAccount();
  }

  async reconcile(
    market: ResolvedMarket,
    quotes: readonly Quote[],
    _books: ReadonlyMap<string, TokenBook>,
  ): Promise<void> {
    await this.enqueue(async () => {
      if (this.locked) return;
      const safeQuotes = await this.validateQuotes(quotes);
      const remote = await this.gateway.listOpenOrders(this.options.conditionId);
      this.lastOrders = remote;
      const retainedDesired = new Set<number>();
      const cancel: ManagedOrder[] = [];

      for (const order of remote) {
        const replacementIndex = safeQuotes
          .map((quote, index) => ({ quote, index }))
          .filter(
            ({ quote, index }) =>
              !retainedDesired.has(index) && quoteKey(quote) === orderKey(order),
          )
          .sort(
            (left, right) =>
              Math.abs(order.price - left.quote.price) - Math.abs(order.price - right.quote.price),
          )[0]?.index;
        const replacement =
          replacementIndex === undefined ? undefined : safeQuotes[replacementIndex];
        const remaining = order.size - order.matchedSize;
        const priceDelta = replacement
          ? Math.abs(order.price - replacement.price)
          : Number.POSITIVE_INFINITY;
        const currentNotional = order.price * remaining;
        const desiredNotional = replacement ? replacement.price * replacement.size : 0;
        if (
          replacement &&
          (nearlyEqual(order.price, replacement.price) ||
            priceDelta < market.tickSize * this.options.repriceThresholdTicks) &&
          currentNotional >= desiredNotional * 0.5 &&
          currentNotional <= desiredNotional * 1.1
        ) {
          retainedDesired.add(replacementIndex as number);
        } else {
          cancel.push(order);
        }
      }

      const place = safeQuotes.filter((_, index) => !retainedDesired.has(index));
      await this.audit.write("live_reconcile_plan", {
        mode: this.options.mode,
        market: market.slug,
        conditionId: this.options.conditionId,
        cancel: cancel.map((order) => order.id),
        place,
      });
      if (this.options.mode === "shadow") {
        this.openOrderCount = remote.length;
        this.openOrderNotional = remote.reduce(
          (sum, order) => sum + order.price * Math.max(0, order.size - order.matchedSize),
          0,
        );
        return;
      }

      const unmatchedCancel = [...cancel];
      for (const quote of place) {
        if (this.locked) return;
        const replacementIndex = unmatchedCancel
          .map((order, index) => ({ order, index }))
          .filter(({ order }) => orderKey(order) === quoteKey(quote))
          .sort(
            (left, right) =>
              Math.abs(left.order.price - quote.price) - Math.abs(right.order.price - quote.price),
          )[0]?.index;
        await this.placeQuote(market, quote);
        if (replacementIndex !== undefined) {
          const [replaced] = unmatchedCancel.splice(replacementIndex, 1);
          if (replaced) await this.cancelRemote([replaced], "quote-replacement");
        }
      }
      if (unmatchedCancel.length > 0) {
        await this.cancelRemote(unmatchedCancel, "quote-removal");
      }
      this.lastOrders = await this.gateway.listOpenOrders(this.options.conditionId);
      this.openOrderCount = this.lastOrders.length;
      this.openOrderNotional = this.lastOrders.reduce(
        (sum, order) => sum + order.price * Math.max(0, order.size - order.matchedSize),
        0,
      );
    });
  }

  async cancelAll(reason: string): Promise<void> {
    await this.enqueue(async () => {
      const open = await this.gateway.listOpenOrders(this.options.conditionId);
      this.lastOrders = open;
      await this.audit.write("live_cancel_plan", {
        mode: this.options.mode,
        reason,
        conditionId: this.options.conditionId,
        orderIds: open.map((order) => order.id),
      });
      if (this.options.mode === "live" && open.length > 0) {
        await this.cancelRemote(open, reason);
      }
      if (this.options.mode === "live") {
        this.openOrderCount = 0;
        this.openOrderNotional = 0;
        this.lastOrders = [];
      }
    });
  }

  async cancelOrders(orderIds: readonly string[], reason: string): Promise<void> {
    if (orderIds.length === 0) {
      await this.cancelAll(reason);
      return;
    }
    await this.enqueue(async () => {
      const open = await this.gateway.listOpenOrders(this.options.conditionId);
      const targets = open.filter((order) => orderIds.includes(order.id));
      this.lastOrders = open;
      if (this.options.mode === "live" && targets.length > 0) {
        await this.cancelRemote(targets, reason);
        this.lastOrders = await this.gateway.listOpenOrders(this.options.conditionId);
        this.openOrderCount = this.lastOrders.length;
        this.openOrderNotional = this.lastOrders.reduce(
          (sum, order) => sum + order.price * Math.max(0, order.size - order.matchedSize),
          0,
        );
      }
    });
  }

  listRestingOrders(): RestingOrder[] {
    return this.lastOrders.map((order) => ({
      id: order.id,
      tokenId: order.tokenId,
      side: order.side,
      price: order.price,
      size: order.size,
      matchedSize: order.matchedSize,
    }));
  }

  async lock(reason: string): Promise<void> {
    this.locked = true;
    await this.cancelAll(reason);
  }

  unlock(): void {
    this.locked = false;
  }

  async syncAccount(): Promise<void> {
    const next = await this.gateway.syncPositions(this.options.allConditionIds);
    this.positions.byToken.clear();
    for (const [tokenId, size] of next.byToken) this.positions.byToken.set(tokenId, size);
    this.positions.cash = next.cash;
    await this.audit.write("account_sync", {
      conditionId: this.options.conditionId,
      cash: next.cash,
      positions: Object.fromEntries(next.byToken),
    });
  }

  private async validateQuotes(quotes: readonly Quote[]): Promise<Quote[]> {
    const accountOrders = await this.gateway.listOpenOrders();
    const otherOrderNotional = accountOrders
      .filter((order) => order.conditionId !== this.options.conditionId)
      .reduce((sum, order) => sum + order.price * Math.max(0, order.size - order.matchedSize), 0);
    const positionNotional = [...this.positions.byToken.values()].reduce(
      (sum, position) => sum + Math.max(0, position),
      0,
    );
    let remaining =
      this.options.maxAccountNotional > 0
        ? this.options.maxAccountNotional - otherOrderNotional - positionNotional
        : Number.POSITIVE_INFINITY;
    const valid: Quote[] = [];
    for (const quote of quotes) {
      if (quote.side !== "BUY")
        throw new Error("live executor accepts complementary BUY orders only");
      if (!this.options.tokenIds.includes(quote.tokenId)) {
        throw new Error(`token ${quote.tokenId} is outside executor market`);
      }
      const notional = quote.price * quote.size;
      if (notional > this.options.maxOrderNotional + 1e-9) continue;
      if (notional > remaining + 1e-9) continue;
      valid.push(quote);
      remaining -= notional;
    }
    if (valid.length !== quotes.length) {
      await this.audit.write("account_notional_trimmed", {
        conditionId: this.options.conditionId,
        limit: this.options.maxAccountNotional,
        otherOrderNotional,
        positionNotional,
        planned: quotes.length,
        kept: valid.length,
      });
    }
    return valid;
  }

  private async cancelRemote(orders: readonly ManagedOrder[], reason: string): Promise<void> {
    const orderIds = orders.map((order) => order.id);
    let usedMarketFallback = false;
    try {
      await this.gateway.cancelOrders(orderIds);
    } catch {
      await this.gateway.cancelMarketOrders(this.options.conditionId);
      usedMarketFallback = true;
    }
    for (let attempt = 0; attempt < this.options.cancelConfirmRetries; attempt += 1) {
      const remaining = await this.gateway.listOpenOrders(this.options.conditionId);
      const remainingTargetIds = remaining
        .filter((order) => orderIds.includes(order.id))
        .map((order) => order.id);
      if (remainingTargetIds.length === 0) {
        await this.audit.write("live_cancel_confirmed", {
          conditionId: this.options.conditionId,
          reason,
          orderIds,
        });
        return;
      }
      await delay(this.options.cancelConfirmDelayMs);
    }
    if (!usedMarketFallback) {
      await this.gateway.cancelMarketOrders(this.options.conditionId);
      const remaining = await this.gateway.listOpenOrders(this.options.conditionId);
      if (!remaining.some((order) => orderIds.includes(order.id))) {
        await this.audit.write("live_cancel_confirmed", {
          conditionId: this.options.conditionId,
          reason,
          orderIds,
          fallback: "market",
        });
        return;
      }
    }
    throw new Error(`orders remain open after cancellation for ${this.options.conditionId}`);
  }

  private async placeQuote(market: ResolvedMarket, quote: Quote): Promise<void> {
    const orderId = await this.gateway.placeLimitOrder({
      ...quote,
      price: clobPrice(quote.price, market.tickSize),
      size: clobSize(quote.size),
    });
    await this.audit.write("live_quote", {
      market: market.slug,
      conditionId: this.options.conditionId,
      orderId,
      ...quote,
      postOnly: true,
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    return this.operationQueue.run(operation);
  }
}
