export type TradingMode = "paper" | "shadow" | "live";

export interface PreviewOutcome {
  sourceOddId: string;
  sourceName: string;
  decimalOdd: number;
  fairProbability: number;
  suggestedPolymarketOutcome: string;
  recommendedBuyPrice: number | null;
}

export interface PreviewMarket {
  name: string;
  round: number;
  kind?: "moneyline" | "child_moneyline" | "map_handicap" | "totals";
  line?: number | null;
  sourceMarketId: string;
  polymarketSlug: string;
  polymarketOutcomes: [string, string];
  tickSize: number;
  minOrderSize: number;
  tradable: boolean;
  overround: number;
  conditionId?: string;
  tokenIds?: [string, string];
  outcomes: [PreviewOutcome, PreviewOutcome];
}

export interface MarketPreview {
  matchId: string;
  eventSlug: string;
  teams: [string, string];
  tournament: string;
  bestOf: number;
  score: string;
  markets: PreviewMarket[];
}

export interface RestingOrder {
  id: string;
  tokenId: string;
  outcome: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  matchedSize: number;
}

export interface BookSide {
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
  receivedAt: number;
}

export interface RuntimeMarket {
  name: string;
  round: number;
  polymarketSlug: string;
  sourceMarketId: string;
  conditionId: string;
  outcomes: [string, string];
  tokenIds: [string, string];
  locked: boolean;
  operatorPaused: boolean;
  reason?: string;
  rejectDetail?: string;
  quoteNote?: string;
  tickSize?: number;
  targetReturnRate?: number;
  quoteMode?: "two-sided" | "complement-buy" | "top-of-book" | "manual";
  sourceOpen: boolean | null;
  sourceLocked: boolean;
  fairPrices: Record<string, number>;
  plannedQuotes: Array<{
    tokenId: string;
    outcome: string;
    side: "BUY" | "SELL";
    price: number;
    size: number;
  }>;
  openOrders: RestingOrder[];
  books: Record<string, BookSide>;
  openOrderCount: number;
  openOrderNotional: number;
  notionalUsed: number;
  positions: Record<string, number>;
}

export interface ControlStatus {
  process: { running: boolean; pid: number | null };
  runtime: null | {
    mode: TradingMode;
    startedAt: number;
    updatedAt: number;
    mqttConnected: boolean;
    polymarketConnected: boolean;
    cash: number;
    accountNotionalUsed: number;
    accountNotionalLimit: number;
    markets: RuntimeMarket[];
  };
}

export interface RuntimeLimits {
  maxAccountNotional: number;
  maxOrderNotional: number;
  maxOutcomePosition: number;
  maxTotalExposure: number;
  makerTargetReturnRate: number;
  oddsStaleMs: number;
  repriceThresholdTicks: number;
}

export interface MarketMapping {
  name: string;
  enabled: boolean;
  sourceMatchId: string;
  sourceMarketId: string;
  polymarketEventSlug?: string;
  polymarketSlug: string;
  round?: number;
  outcomes: Array<{ sourceOddId: string; outcome: string }>;
  orderNotional?: number;
  quoteLevels?: number;
  levelSpacingTicks?: number;
  targetReturnRate?: number;
  quoteMode?: "two-sided" | "complement-buy" | "top-of-book";
}

export interface LeagueSummary {
  id: string;
  name: string;
  shortName: string;
  description: string;
  isDefault: boolean;
}

export interface LeagueCandidate {
  leagueId?: string;
  sourceMatchId: string;
  eventSlug: string;
  sourceUrl: string;
  polymarketUrl: string;
  teams: [string, string];
  englishTeams?: [string, string];
  polymarketOutcomes: [string, string];
  tournament: string;
  bestOf?: number;
  startTime: number;
  polymarketStartTime: number | null;
  confidence: number;
  notes?: string[];
  reason?: string;
  market: PreviewMarket;
  books: Record<
    string,
    { bestBid: number | null; bestAsk: number | null; topPrice: number | null }
  >;
}

export interface LeagueDiscoveryResult {
  discoveredAt: number;
  matched: LeagueCandidate[];
  review: LeagueCandidate[];
  rejected: Array<{
    sourceMatchId: string;
    teams: [string, string];
    startTime: number;
    reason: string;
  }>;
}

export interface SavedMatch {
  sourceMatchId: string;
  polymarketEventSlug: string;
  sourceUrl: string;
  polymarketUrl: string;
  label: string;
  tournament?: string;
  enabledRounds: number[];
  marketCount: number;
  enabledCount: number;
  updatedAt: number;
}

export interface MarketsResponse {
  mappings: MarketMapping[];
  savedMatches: SavedMatch[];
}

export interface DeskTrade {
  id: string;
  at: number;
  side: "BUY" | "SELL";
  outcome: string;
  price: number;
  size: number;
  notional: number;
  name: string;
  wallet: string;
}

export interface DeskHolder {
  outcome: string;
  name: string;
  wallet: string;
  amount: number;
  share: number;
}

export interface DeskHolderGroup {
  tokenId: string;
  outcome: string;
  holders: DeskHolder[];
}

export interface DeskMarketSnapshot {
  conditionId: string;
  trades: DeskTrade[];
  holders: DeskHolderGroup[];
  error?: string;
}

export interface DeskSnapshot {
  markets: Record<string, DeskMarketSnapshot>;
}

export interface MarketTapeBook {
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
  receivedAt: number;
}

export interface MarketTapeSnapshot {
  sourceMarketId: string;
  conditionId: string;
  books: Record<string, MarketTapeBook>;
  trades: DeskTrade[];
  error?: string;
}

export interface MarketTapeResponse {
  markets: Record<string, MarketTapeSnapshot>;
}

export const controlApiUrl = process.env.NEXT_PUBLIC_CONTROL_API ?? "http://127.0.0.1:48787";

export type SignalKind = "lock" | "unlock" | "jump";

export type SignalVerdict =
  | "fillable"
  | "partial"
  | "no_liquidity"
  | "already_priced"
  | "no_edge"
  | "lock_watch";

export interface SignalFill {
  fillable: boolean;
  filledUsd: number;
  unfilledUsd: number;
  vwap: number | null;
  levelsTaken: number;
  bestAsk: number | null;
  bestBid: number | null;
  askDepthUsd: number;
  edgeVsSource: number | null;
}

export interface SignalEvent {
  id: string;
  kind: SignalKind;
  at: number;
  sourceMarketId: string;
  outcome: string;
  tokenId: string;
  side: "BUY" | "WATCH";
  sourcePrev: number;
  sourceFair: number;
  sourceDelta: number;
  polyMidAtSignal: number | null;
  polyAskAtSignal: number | null;
  polyBidAtSignal: number | null;
  polyMidAtLock: number | null;
  polyMovedDuringLock: number | null;
  lockDurationMs: number | null;
  fill: SignalFill;
  verdict: SignalVerdict;
  reason: string;
  polyMovedAt: number | null;
  polyLagMs: number | null;
  polyMidAfter: number | null;
}

export interface SignalMonitorSnapshot {
  running: boolean;
  startedAt: number | null;
  options: {
    sourceMatchId: string;
    polymarketEventSlug: string;
    polymarketMarketSlug: string;
    jumpThreshold: number;
    notionalUsd: number;
    maxSlippage: number;
    cooldownMs: number;
    polyLagTicks: number;
  };
  mqttConnected: boolean;
  polymarketConnected: boolean;
  sourceBound: boolean;
  sourceLocked: boolean;
  lockStartedAt: number | null;
  sourceMarketId: string | null;
  teams: [string, string] | null;
  outcomes: [string, string] | null;
  sourceFairs: [number | null, number | null];
  preLockFairs: [number | null, number | null];
  polyMids: [number | null, number | null];
  polyBids: [number | null, number | null];
  polyAsks: [number | null, number | null];
  sourceUpdatedAt: number | null;
  polyUpdatedAt: number | null;
  signals: SignalEvent[];
  stats: {
    signals: number;
    locks: number;
    unlocks: number;
    fillable: number;
    partial: number;
    missed: number;
    avgLagMs: number | null;
  };
  lastError: string | null;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${controlApiUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
    cache: "no-store",
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `请求失败：HTTP ${response.status}`);
  return body;
}
