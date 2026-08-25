export type TradingMode = "paper" | "shadow" | "live";
export type QuoteMode = "two-sided" | "complement-buy" | "top-of-book";

export interface SourceOddUpdate {
  marketId: string;
  matchId: string;
  oddId: string;
  decimalOdd: number;
  returnRate: number;
  receivedAt: number;
}

export interface SourceMarketState {
  marketId: string;
  suspended: boolean;
  visible: boolean;
  open: boolean;
  updatedAt: number;
}

export type MarketScope = "match" | "game" | "unknown";

export interface SourceMarketMetadata {
  marketId: string;
  matchId: string;
  scope: MarketScope;
  round: number;
  name: string;
  outcomes: ReadonlyMap<string, string>;
}

export interface SourceMatchMetadata {
  matchId: string;
  teams: readonly [string, string];
  bestOf: number;
  score: string;
  tournament: string;
  markets: ReadonlyMap<string, SourceMarketMetadata>;
  initialOdds: SourceOddUpdate[];
  initialStates: SourceMarketState[];
}

export interface PolymarketOddsSnapshot {
  eventSlug: string;
  marketSlug: string;
  round: number;
  outcomes: readonly [string, string];
  prices: readonly [number | null, number | null];
  bestBids: readonly [number | null, number | null];
  referencePrices: readonly [number, number];
  tradingOpen: boolean;
  receivedAt: number;
}

export interface FairSnapshot {
  sourceMarketId: string;
  probabilities: ReadonlyMap<string, number>;
  overround: number;
  receivedAt: number;
}

export interface OutcomeMapping {
  sourceOddId: string;
  outcome: string;
}

export interface MarketMapping {
  name: string;
  enabled: boolean;
  sourceMatchId: string;
  sourceMarketId: string;
  polymarketEventSlug?: string | undefined;
  polymarketSlug: string;
  outcomes: OutcomeMapping[];
  round?: number | undefined;
  quoteMode?: QuoteMode | undefined;
  orderNotional?: number | undefined;
  quoteLevels?: number | undefined;
  levelSpacingTicks?: number | undefined;
  targetReturnRate?: number | undefined;
}

export interface ResolvedMarket {
  slug: string;
  conditionId: string;
  outcomes: readonly [string, string];
  tokenIds: readonly [string, string];
  tickSize: number;
  minOrderSize: number;
  acceptingOrders: boolean;
  closed: boolean;
  feesEnabled: boolean;
}

export interface BookLevel {
  price: number;
  size: number;
}

export interface TokenBook {
  tokenId: string;
  bids: BookLevel[];
  asks: BookLevel[];
  receivedAt: number;
}

export interface Quote {
  tokenId: string;
  outcome: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
}

export interface ManagedOrder {
  id: string;
  conditionId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  matchedSize: number;
}

export interface RestingOrder {
  id: string;
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  matchedSize: number;
}

export interface PositionState {
  byToken: Map<string, number>;
  cash: number;
}
