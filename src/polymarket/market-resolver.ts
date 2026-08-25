import { createPublicClient } from "@polymarket/client";
import { z } from "zod";
import type { ResolvedMarket } from "../types.js";

const gammaMarketSchema = z.object({
  slug: z.string(),
  conditionId: z.string(),
  outcomes: z.string(),
  clobTokenIds: z.string(),
  orderPriceMinTickSize: z.coerce.number().positive(),
  orderMinSize: z.coerce.number().positive(),
  acceptingOrders: z.boolean(),
  closed: z.boolean(),
  active: z.boolean(),
  enableOrderBook: z.boolean(),
  sportsMarketType: z.string().optional(),
  feesEnabled: z.boolean().optional().default(false),
});

const gammaEventSchema = z.object({
  slug: z.string(),
  title: z.string().default(""),
  startTime: z.string().nullable().optional(),
  markets: z.array(gammaMarketSchema),
});

export interface ListedMoneylineMarket extends ResolvedMarket {
  round: number;
  tradable: boolean;
}

export interface ListedMoneylineEvent {
  slug: string;
  title: string;
  startTime: number | null;
  markets: ListedMoneylineMarket[];
}

export interface MoneylineEventQuery {
  tagSlug: string;
  titlePattern?: RegExp;
  searchFallbackQuery?: string;
  pageSize?: number;
}

function toListedEvent(
  event: Pick<z.infer<typeof gammaEventSchema>, "slug" | "title" | "startTime" | "markets">,
): ListedMoneylineEvent | undefined {
  const markets = event.markets
    .filter(
      (market) =>
        market.sportsMarketType === "moneyline" || market.sportsMarketType === "child_moneyline",
    )
    .map((market) => ({
      ...toResolvedMarket(market),
      round: inferRound(event.slug, market.slug),
      tradable: market.active && !market.closed && market.acceptingOrders && market.enableOrderBook,
    }))
    .sort((left, right) => left.round - right.round);
  if (!markets.some((market) => market.round === 0)) return undefined;
  const parsedStart = event.startTime ? Date.parse(event.startTime) : Number.NaN;
  return {
    slug: event.slug,
    title: event.title,
    startTime: Number.isFinite(parsedStart) ? parsedStart : null,
    markets,
  };
}

function parseStringPair(value: string, field: string): [string, string] {
  const parsed = z.array(z.string()).length(2).parse(JSON.parse(value));
  const first = parsed[0];
  const second = parsed[1];
  if (!first || !second || first === second) throw new Error(`invalid ${field} pair`);
  return [first, second];
}

function inferRound(eventSlug: string, marketSlug: string): number {
  if (marketSlug === eventSlug) return 0;
  const match = /(?:game|map)-?(\d+)$/i.exec(marketSlug);
  return match?.[1] ? Number(match[1]) : 0;
}

function toResolvedMarket(market: z.infer<typeof gammaMarketSchema>): ResolvedMarket {
  return {
    slug: market.slug,
    conditionId: market.conditionId,
    outcomes: parseStringPair(market.outcomes, "outcomes"),
    tokenIds: parseStringPair(market.clobTokenIds, "clobTokenIds"),
    tickSize: market.orderPriceMinTickSize,
    minOrderSize: market.orderMinSize,
    acceptingOrders: market.acceptingOrders,
    closed: market.closed,
    feesEnabled: market.feesEnabled,
  };
}

export class MarketResolver {
  constructor(
    private readonly gammaApiUrl: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async listMoneylineMarkets(eventSlug: string): Promise<ListedMoneylineMarket[]> {
    const response = await this.fetcher(
      `${this.gammaApiUrl}/events?slug=${encodeURIComponent(eventSlug)}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) throw new Error(`Gamma API returned HTTP ${response.status}`);
    const events = z.array(gammaEventSchema).parse(await response.json());
    const event = events.find((item) => item.slug === eventSlug);
    if (!event) throw new Error(`Polymarket event not found: ${eventSlug}`);

    return event.markets
      .filter(
        (market) =>
          market.sportsMarketType === "moneyline" || market.sportsMarketType === "child_moneyline",
      )
      .map((market) => ({
        ...toResolvedMarket(market),
        round: inferRound(eventSlug, market.slug),
        tradable:
          market.active && !market.closed && market.acceptingOrders && market.enableOrderBook,
      }))
      .sort((left, right) => left.round - right.round);
  }

  async listActiveMoneylineEvents(
    query: MoneylineEventQuery | string,
    pageSize?: number,
  ): Promise<ListedMoneylineEvent[]> {
    const resolved: MoneylineEventQuery =
      typeof query === "string"
        ? { tagSlug: query, ...(pageSize === undefined ? {} : { pageSize }) }
        : query;
    const limit = resolved.pageSize ?? pageSize ?? 100;
    const collected: z.infer<typeof gammaEventSchema>[] = [];
    for (let offset = 0; ; offset += limit) {
      const url = new URL(`${this.gammaApiUrl}/events`);
      url.searchParams.set("tag_slug", resolved.tagSlug);
      url.searchParams.set("active", "true");
      url.searchParams.set("closed", "false");
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("offset", String(offset));
      const response = await this.fetchWithRetry(url);
      const page = z.array(gammaEventSchema).parse(await response.json());
      collected.push(...page);
      if (page.length < limit) break;
    }
    const tagged = collected.filter((event) =>
      resolved.titlePattern ? resolved.titlePattern.test(event.title) : true,
    );
    const mapped = tagged.flatMap((event) => {
      const listed = toListedEvent(event);
      return listed ? [listed] : [];
    });
    if (mapped.length > 0) return mapped;
    if (resolved.searchFallbackQuery) {
      return this.searchActiveMoneylineEvents(resolved.searchFallbackQuery, resolved.titlePattern);
    }
    if (typeof query === "string" && collected.length === 0) {
      return this.searchActiveMoneylineEvents("KPL Growth League");
    }
    return [];
  }

  async resolveMoneyline(eventSlug: string, marketSlug = eventSlug): Promise<ResolvedMarket> {
    const market = (await this.listMoneylineMarkets(eventSlug)).find(
      (item) => item.slug === marketSlug,
    );
    if (!market) throw new Error(`moneyline market not found: ${marketSlug}`);
    if (!market.tradable) {
      throw new Error(`Polymarket moneyline is not safely tradable: ${marketSlug}`);
    }
    return market;
  }

  private async fetchWithRetry(url: URL): Promise<Response> {
    let lastStatus = 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await this.fetcher(url, { signal: AbortSignal.timeout(10_000) });
      if (response.ok) return response;
      lastStatus = response.status;
      if (response.status !== 429 && response.status < 500) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 250 * 2 ** attempt));
    }
    throw new Error(`Gamma API returned HTTP ${lastStatus}`);
  }

  private async searchActiveMoneylineEvents(
    query: string,
    titlePattern = /KPL Growth League/i,
  ): Promise<ListedMoneylineEvent[]> {
    const client = createPublicClient();
    const events: ListedMoneylineEvent[] = [];
    let pages = 0;
    for await (const page of client.search({ q: query, pageSize: 50 })) {
      pages += 1;
      for (const event of page.items.events) {
        if (
          !event.title ||
          !event.slug ||
          !titlePattern.test(event.title) ||
          !event.state.active ||
          event.state.closed ||
          event.state.ended
        ) {
          continue;
        }
        const eventSlug = event.slug;
        const markets = event.markets.flatMap((market) => {
          const sportsMarketType = market.sports?.sportsMarketType;
          if (
            !market.slug ||
            !market.conditionId ||
            !sportsMarketType ||
            !["moneyline", "child_moneyline"].includes(sportsMarketType) ||
            !market.trading.minimumTickSize ||
            !market.trading.minimumOrderSize
          ) {
            return [];
          }
          const yes = market.outcomes.yes;
          const no = market.outcomes.no;
          if (!yes.tokenId || !no.tokenId || yes.label === no.label) return [];
          const round = inferRound(eventSlug, market.slug);
          return [
            {
              slug: market.slug,
              conditionId: market.conditionId,
              outcomes: [yes.label, no.label] as [string, string],
              tokenIds: [yes.tokenId, no.tokenId] as [string, string],
              tickSize: market.trading.minimumTickSize,
              minOrderSize: Number(market.trading.minimumOrderSize),
              acceptingOrders: market.state.acceptingOrders === true,
              closed: market.state.closed === true,
              feesEnabled: market.trading.feesEnabled === true,
              round,
              tradable:
                market.state.active === true &&
                !market.state.closed &&
                market.state.acceptingOrders === true &&
                market.state.enableOrderBook === true,
            },
          ];
        });
        if (!markets.some((market) => market.round === 0)) continue;
        const parsedStart = event.schedule.startTime
          ? Date.parse(event.schedule.startTime)
          : Number.NaN;
        events.push({
          slug: eventSlug,
          title: event.title,
          startTime: Number.isFinite(parsedStart) ? parsedStart : null,
          markets: markets.sort((left, right) => left.round - right.round),
        });
      }
      if (!page.hasMore || pages >= 5) break;
    }
    return events;
  }
}
