import type {
  FairSnapshot,
  PositionState,
  ResolvedMarket,
  SourceMarketState,
  TokenBook,
} from "../types.js";

export interface RiskLimits {
  oddsStaleMs: number;
  maxOutcomePosition: number;
  maxTotalExposure: number;
}

export interface RiskContext {
  now: number;
  mqttConnected: boolean;
  polymarketConnected?: boolean;
  locked?: boolean;
  minFairReceivedAt?: number;
  requireSourceState?: boolean;
  fair: FairSnapshot | undefined;
  sourceState: SourceMarketState | undefined;
  market: ResolvedMarket;
  books: ReadonlyMap<string, TokenBook> | undefined;
  positions: PositionState;
}

export interface RiskDecision {
  allowed: boolean;
  reason?: string;
}

export class RiskEngine {
  constructor(private readonly limits: RiskLimits) {}

  evaluate(context: RiskContext): RiskDecision {
    if (!context.mqttConnected) return { allowed: false, reason: "mqtt-disconnected" };
    if (context.polymarketConnected === false) {
      return { allowed: false, reason: "polymarket-disconnected" };
    }
    if (context.locked) return { allowed: false, reason: "lock-barrier-active" };
    if (!context.fair) return { allowed: false, reason: "missing-fair-odds" };
    if (
      context.minFairReceivedAt !== undefined &&
      context.fair.receivedAt <= context.minFairReceivedAt
    ) {
      return { allowed: false, reason: "pre-lock-fair-odds" };
    }
    if (context.now - context.fair.receivedAt > this.limits.oddsStaleMs) {
      return { allowed: false, reason: "stale-fair-odds" };
    }
    if (context.requireSourceState && !context.sourceState) {
      return { allowed: false, reason: "missing-source-state" };
    }
    if (context.sourceState) {
      if (context.sourceState.suspended) return { allowed: false, reason: "source-suspended" };
      if (!context.sourceState.visible) return { allowed: false, reason: "source-hidden" };
      if (!context.sourceState.open) return { allowed: false, reason: "source-closed" };
    }
    if (context.market.closed || !context.market.acceptingOrders) {
      return { allowed: false, reason: "polymarket-closed" };
    }
    if (context.books?.size !== 2) {
      return { allowed: false, reason: "incomplete-polymarket-books" };
    }
    for (const tokenId of context.market.tokenIds) {
      const book = context.books.get(tokenId);
      if (!book || context.now - book.receivedAt > this.limits.oddsStaleMs) {
        return { allowed: false, reason: "stale-polymarket-book" };
      }
      const position = Math.abs(context.positions.byToken.get(tokenId) ?? 0);
      if (position > this.limits.maxOutcomePosition) {
        return { allowed: false, reason: "outcome-position-limit" };
      }
    }
    const exposure = [...context.positions.byToken.values()].reduce(
      (sum, position) => sum + Math.abs(position),
      0,
    );
    if (exposure > this.limits.maxTotalExposure) {
      return { allowed: false, reason: "total-exposure-limit" };
    }
    return { allowed: true };
  }
}
