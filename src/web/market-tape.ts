import type { PolymarketDataApiClient } from "../polymarket/data-api-client.js";
import type { PolymarketOrderBookClient } from "../polymarket/orderbook-client.js";
import type { BookLevel, ResolvedMarket } from "../types.js";

export interface TapeMarketRequest {
  sourceMarketId: string;
  conditionId: string;
  slug: string;
  tokenIds: readonly [string, string];
  outcomes: readonly [string, string];
  tickSize: number;
  minOrderSize: number;
}

export interface TapeBookSide {
  bids: BookLevel[];
  asks: BookLevel[];
  receivedAt: number;
}

export interface MarketTapeSnapshot {
  sourceMarketId: string;
  conditionId: string;
  books: Record<string, TapeBookSide>;
  trades: Awaited<ReturnType<PolymarketDataApiClient["fetchTrades"]>>;
  error?: string;
}

function asResolved(market: TapeMarketRequest): ResolvedMarket {
  return {
    slug: market.slug,
    conditionId: market.conditionId,
    outcomes: market.outcomes,
    tokenIds: market.tokenIds,
    tickSize: market.tickSize,
    minOrderSize: market.minOrderSize,
    acceptingOrders: true,
    closed: false,
    feesEnabled: false,
  };
}

export async function fetchMarketTape(
  orderBooks: PolymarketOrderBookClient,
  dataApi: PolymarketDataApiClient,
  markets: readonly TapeMarketRequest[],
): Promise<{ markets: Record<string, MarketTapeSnapshot> }> {
  const entries = await Promise.all(
    markets.map(async (market) => {
      try {
        const [books, trades] = await Promise.all([
          orderBooks.fetchBooks(asResolved(market)),
          dataApi.fetchTrades(market.conditionId, 12),
        ]);
        const byOutcome = Object.fromEntries(
          market.outcomes.map((outcome, index) => {
            const tokenId = market.tokenIds[index];
            const book = tokenId ? books.get(tokenId) : undefined;
            return [
              outcome,
              {
                bids: book?.bids.slice(0, 8) ?? [],
                asks: book?.asks.slice(0, 8) ?? [],
                receivedAt: book?.receivedAt ?? 0,
              },
            ];
          }),
        );
        return [
          market.sourceMarketId,
          {
            sourceMarketId: market.sourceMarketId,
            conditionId: market.conditionId,
            books: byOutcome,
            trades,
          },
        ] as const;
      } catch (error) {
        return [
          market.sourceMarketId,
          {
            sourceMarketId: market.sourceMarketId,
            conditionId: market.conditionId,
            books: {},
            trades: [],
            error: error instanceof Error ? error.message : String(error),
          },
        ] as const;
      }
    }),
  );
  return { markets: Object.fromEntries(entries) };
}
