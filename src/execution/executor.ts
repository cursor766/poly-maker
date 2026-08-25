import type { PositionState, Quote, ResolvedMarket, RestingOrder, TokenBook } from "../types.js";

export interface QuoteExecutor {
  readonly positions: PositionState;
  readonly locked: boolean;
  readonly openOrderCount: number;
  readonly openOrderNotional: number;
  initialize(): Promise<void>;
  reconcile(
    market: ResolvedMarket,
    quotes: readonly Quote[],
    books: ReadonlyMap<string, TokenBook>,
  ): Promise<void>;
  cancelAll(reason: string): Promise<void>;
  cancelOrders(orderIds: readonly string[], reason: string): Promise<void>;
  listRestingOrders(): RestingOrder[];
  lock(reason: string): Promise<void>;
  unlock(): void;
  syncAccount(): Promise<void>;
}
