import { z } from "zod";
import type { PolymarketOddsSnapshot } from "../types.js";

const marketSchema = z.object({
  slug: z.string(),
  outcomes: z.string(),
  outcomePrices: z.string(),
  clobTokenIds: z.string(),
  sportsMarketType: z.string().optional(),
  active: z.boolean(),
  closed: z.boolean(),
  acceptingOrders: z.boolean(),
});

const eventSchema = z.object({
  slug: z.string(),
  markets: z.array(marketSchema),
});

const bookSchema = z.object({
  asset_id: z.string(),
  bids: z.array(z.object({ price: z.coerce.number(), size: z.coerce.number() })),
  asks: z.array(z.object({ price: z.coerce.number(), size: z.coerce.number() })),
});

function parsePair(value: string, field: string): [string, string] {
  const pair = z.array(z.string()).length(2).parse(JSON.parse(value));
  const first = pair[0];
  const second = pair[1];
  if (!first || !second) throw new Error(`invalid Polymarket ${field}`);
  return [first, second];
}

function marketRound(
  eventSlug: string,
  marketSlug: string,
  marketType?: string,
): number | undefined {
  if (marketSlug === eventSlug && marketType === "moneyline") return 0;
  if (marketType !== "child_moneyline") return undefined;
  const match = /-game(\d+)$/.exec(marketSlug);
  if (!match?.[1]) return undefined;
  const round = Number(match[1]);
  return Number.isInteger(round) && round > 0 ? round : undefined;
}

function bestPrice(
  levels: readonly { price: number; size: number }[],
  side: "bid" | "ask",
): number | null {
  const prices = levels
    .filter((level) => level.size > 0 && level.price > 0 && level.price < 1)
    .map((level) => level.price);
  if (prices.length === 0) return null;
  return side === "bid" ? Math.max(...prices) : Math.min(...prices);
}

export interface PolymarketWinnerMarket {
  eventSlug: string;
  marketSlug: string;
  round: number;
  outcomes: readonly [string, string];
  referencePrices: readonly [number, number];
  tokenIds: readonly [string, string];
  acceptingOrders: boolean;
}

export class PolymarketOddsClient {
  constructor(
    private readonly gammaApiUrl: string,
    private readonly clobApiUrl: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async fetchWinnerOdds(eventSlug: string): Promise<PolymarketOddsSnapshot[]> {
    return this.fetchWinnerBooks(await this.resolveWinnerMarkets(eventSlug));
  }

  async resolveWinnerMarkets(eventSlug: string): Promise<PolymarketWinnerMarket[]> {
    const response = await this.fetcher(
      `${this.gammaApiUrl}/events?slug=${encodeURIComponent(eventSlug)}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) throw new Error(`Gamma API returned HTTP ${response.status}`);
    const events = z.array(eventSchema).parse(await response.json());
    const event = events.find((item) => item.slug === eventSlug);
    if (!event) throw new Error(`Polymarket event not found: ${eventSlug}`);

    return event.markets.flatMap((market) => {
      const round = marketRound(eventSlug, market.slug, market.sportsMarketType);
      if (round === undefined || !market.active || market.closed) return [];
      const outcomes = parsePair(market.outcomes, "outcomes");
      const rawPrices = parsePair(market.outcomePrices, "outcomePrices");
      const referencePrices = rawPrices.map(Number) as [number, number];
      const tokenIds = parsePair(market.clobTokenIds, "clobTokenIds");
      if (referencePrices.some((price) => !Number.isFinite(price) || price <= 0 || price >= 1)) {
        return [];
      }
      return [
        {
          eventSlug,
          round,
          marketSlug: market.slug,
          outcomes,
          referencePrices,
          tokenIds,
          acceptingOrders: market.acceptingOrders,
        },
      ];
    });
  }

  async fetchWinnerBooks(
    winnerMarkets: readonly PolymarketWinnerMarket[],
  ): Promise<PolymarketOddsSnapshot[]> {
    const receivedAt = Date.now();
    const books = await this.fetchBooks(winnerMarkets.flatMap((market) => market.tokenIds));
    const booksByToken = new Map(books.map((book) => [book.asset_id, book]));
    return winnerMarkets.map((market) => {
      const firstBook = booksByToken.get(market.tokenIds[0]);
      const secondBook = booksByToken.get(market.tokenIds[1]);
      return {
        eventSlug: market.eventSlug,
        marketSlug: market.marketSlug,
        round: market.round,
        outcomes: market.outcomes,
        prices: [bestPrice(firstBook?.asks ?? [], "ask"), bestPrice(secondBook?.asks ?? [], "ask")],
        bestBids: [
          bestPrice(firstBook?.bids ?? [], "bid"),
          bestPrice(secondBook?.bids ?? [], "bid"),
        ],
        referencePrices: market.referencePrices,
        tradingOpen: market.acceptingOrders,
        receivedAt,
      };
    });
  }

  private async fetchBooks(tokenIds: readonly string[]): Promise<z.infer<typeof bookSchema>[]> {
    if (tokenIds.length === 0) return [];
    const response = await this.fetcher(`${this.clobApiUrl}/books`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(tokenIds.map((tokenId) => ({ token_id: tokenId, side: "BUY" }))),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`CLOB books API returned HTTP ${response.status}`);
    return z.array(bookSchema).parse(await response.json());
  }
}
