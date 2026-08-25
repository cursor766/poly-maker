import type { ListedMoneylineEvent, MarketResolver } from "../polymarket/market-resolver.js";
import type { PolymarketOrderBookClient } from "../polymarket/orderbook-client.js";
import type { ListedSourceMatch, MatchMetadataClient } from "../source/match-metadata-client.js";
import { calculateTopOfBookPrice } from "../strategy/maker.js";
import type { TokenBook } from "../types.js";
import { isSourceMatchInLeague, requireLeague } from "./league-registry.js";
import { buildMarkets, type PreviewMarket, teamMatchScore } from "./preview-service.js";

export interface LeagueCandidate {
  leagueId: string;
  sourceMatchId: string;
  eventSlug: string;
  sourceUrl: string;
  polymarketUrl: string;
  teams: readonly [string, string];
  englishTeams: readonly [string, string];
  polymarketOutcomes: readonly [string, string];
  tournament: string;
  bestOf: number;
  startTime: number;
  polymarketStartTime: number | null;
  confidence: number;
  notes: string[];
  reason?: string;
  market: PreviewMarket;
  books: Record<
    string,
    { bestBid: number | null; bestAsk: number | null; topPrice: number | null }
  >;
}

export interface RejectedLeagueMatch {
  sourceMatchId: string;
  teams: readonly [string, string];
  startTime: number;
  reason: string;
}

export interface LeagueDiscoveryResult {
  discoveredAt: number;
  matched: LeagueCandidate[];
  review: LeagueCandidate[];
  rejected: RejectedLeagueMatch[];
}

interface PairScore {
  source: ListedSourceMatch;
  event: ListedMoneylineEvent;
  score: number;
  legScores: readonly [number, number];
  mappedOutcomes: readonly [string, string];
}

function scoreTeam(source: ListedSourceMatch, index: number, outcome: string): number {
  return Math.max(
    teamMatchScore(source.match.teams[index] ?? "", outcome),
    teamMatchScore(source.englishTeams[index] ?? "", outcome),
  );
}

function scorePair(source: ListedSourceMatch, event: ListedMoneylineEvent): PairScore | null {
  const market = event.markets.find((item) => item.round === 0);
  if (!market) return null;
  const direct = [
    scoreTeam(source, 0, market.outcomes[0]),
    scoreTeam(source, 1, market.outcomes[1]),
  ] as const;
  const swapped = [
    scoreTeam(source, 0, market.outcomes[1]),
    scoreTeam(source, 1, market.outcomes[0]),
  ] as const;
  const directTotal = direct[0] + direct[1];
  const swappedTotal = swapped[0] + swapped[1];
  return {
    source,
    event,
    score: Math.max(directTotal, swappedTotal),
    legScores: directTotal >= swappedTotal ? direct : swapped,
    mappedOutcomes:
      directTotal >= swappedTotal ? market.outcomes : [market.outcomes[1], market.outcomes[0]],
  };
}

function startTimeDelta(source: ListedSourceMatch, event: ListedMoneylineEvent): number {
  return event.startTime === null
    ? Number.POSITIVE_INFINITY
    : Math.abs(event.startTime - source.startTime);
}

function topBookSummary(
  candidate: PreviewMarket,
  event: ListedMoneylineEvent,
  books: ReadonlyMap<string, TokenBook>,
  targetReturnRate: number,
  minEdge: number,
): LeagueCandidate["books"] {
  const market = event.markets.find((item) => item.round === 0);
  if (!market) return {};
  return Object.fromEntries(
    candidate.outcomes.map((outcome, index) => {
      const polymarketIndex = market.outcomes.indexOf(outcome.suggestedPolymarketOutcome);
      const tokenId = market.tokenIds[polymarketIndex];
      const book = tokenId ? books.get(tokenId) : undefined;
      const opposite = candidate.outcomes[index === 0 ? 1 : 0];
      return [
        outcome.suggestedPolymarketOutcome,
        {
          bestBid: book?.bids[0]?.price ?? null,
          bestAsk: book?.asks[0]?.price ?? null,
          topPrice:
            book && opposite
              ? calculateTopOfBookPrice(
                  outcome.fairProbability,
                  opposite.fairProbability,
                  book,
                  market.tickSize,
                  targetReturnRate,
                  minEdge + (market.feesEnabled ? 0.005 : 0),
                )
              : null,
        },
      ];
    }),
  );
}

export class LeagueDiscoveryService {
  constructor(
    private readonly metadataClient: MatchMetadataClient,
    private readonly marketResolver: MarketResolver,
    private readonly orderBooks: PolymarketOrderBookClient,
    private readonly sourceOrigin: string,
    private readonly targetReturnRate: number,
    private readonly minEdge: number,
  ) {}

  async discover(leagueId: string): Promise<LeagueDiscoveryResult> {
    const league = requireLeague(leagueId);
    const [sourceMatches, events] = await Promise.all([
      this.metadataClient.listMatches(league.gameId),
      this.marketResolver.listActiveMoneylineEvents({
        tagSlug: league.polymarketTagSlug,
        titlePattern: league.polymarketTitlePattern,
        searchFallbackQuery: league.polymarketSearchQuery,
      }),
    ]);
    const sources = sourceMatches.filter((item) => isSourceMatchInLeague(item, league));
    const rejected: RejectedLeagueMatch[] = [];
    const review: LeagueCandidate[] = [];
    const matched: LeagueCandidate[] = [];
    const usedEvents = new Set<string>();

    for (const source of sources) {
      const scores = events
        .map((event) => scorePair(source, event))
        .filter((item): item is PairScore => item !== null)
        .sort(
          (left, right) =>
            right.score - left.score ||
            startTimeDelta(source, left.event) - startTimeDelta(source, right.event),
        );
      const best = scores[0];
      const second = scores[1];
      if (!best || best.score < 6 || Math.min(...best.legScores) < 3) {
        rejected.push({
          sourceMatchId: source.match.matchId,
          teams: source.match.teams,
          startTime: source.startTime,
          reason: "未找到队伍名称可双向确认的 Polymarket 比赛",
        });
        continue;
      }
      const timeDelta = best.event.startTime === null ? 0 : startTimeDelta(source, best.event);
      if (best.event.startTime !== null && timeDelta > 36 * 60 * 60 * 1_000) {
        rejected.push({
          sourceMatchId: source.match.matchId,
          teams: source.match.teams,
          startTime: source.startTime,
          reason: "队伍相同但开赛时间相差超过 36 小时",
        });
        continue;
      }
      const polymarket = best.event.markets.find((item) => item.round === 0);
      const builtPreview = polymarket
        ? buildMarkets(source.match, [polymarket], this.targetReturnRate)[0]
        : undefined;
      if (!polymarket || !builtPreview) {
        rejected.push({
          sourceMatchId: source.match.matchId,
          teams: source.match.teams,
          startTime: source.startTime,
          reason: "缺少可对应的全场胜负盘口或完整源赔率",
        });
        continue;
      }
      const preview: PreviewMarket = {
        ...builtPreview,
        outcomes: [
          {
            ...builtPreview.outcomes[0],
            suggestedPolymarketOutcome: best.mappedOutcomes[0],
          },
          {
            ...builtPreview.outcomes[1],
            suggestedPolymarketOutcome: best.mappedOutcomes[1],
          },
        ],
      };
      let books = new Map<string, TokenBook>();
      try {
        books = new Map(await this.orderBooks.fetchBooks(polymarket));
      } catch {
        // Candidate remains visible for review, but cannot be enabled by default.
      }
      const summary = topBookSummary(
        preview,
        best.event,
        books,
        this.targetReturnRate,
        this.minEdge,
      );
      const safePrices = Object.values(summary).every((item) => item.topPrice !== null);
      const secondTimeDelta = second
        ? startTimeDelta(source, second.event)
        : Number.POSITIVE_INFINITY;
      const ambiguous =
        ((second?.score ?? 0) >= best.score - 2 &&
          (best.event.startTime === null ||
            second?.event.startTime === null ||
            secondTimeDelta - timeDelta <= 6 * 3_600_000)) ||
        usedEvents.has(best.event.slug);
      const notes: string[] = [];
      if (source.match.bestOf >= 7) {
        notes.push("BO7：本流程只挂全场。Polymarket 通常只开到 G6，第 7 局不会自动配置。");
      }
      const gameRounds = best.event.markets
        .map((market) => market.round)
        .filter((round) => round > 0);
      const highestGame = gameRounds.length > 0 ? Math.max(...gameRounds) : 0;
      if (source.match.bestOf > highestGame) {
        notes.push(
          highestGame === 0
            ? `源站 BO${source.match.bestOf}，Polymarket 目前只有全场盘。`
            : `源站 BO${source.match.bestOf}，Polymarket 最高开到 G${highestGame}。`,
        );
      }
      const reason = !source.sourceOpen
        ? "源站比赛或盘口当前未开放"
        : !polymarket.tradable
          ? "Polymarket 当前不可交易"
          : ambiguous
            ? "存在多个相近匹配，需要人工确认"
            : !safePrices
              ? "当前买一加 1 tick 超过源赔率安全上限"
              : undefined;
      const confidence = Math.min(
        1,
        (best.score / 16) *
          (best.event.startTime === null ? 0.85 : timeDelta <= 6 * 3_600_000 ? 1 : 0.9),
      );
      const candidate: LeagueCandidate = {
        leagueId: league.id,
        sourceMatchId: source.match.matchId,
        eventSlug: best.event.slug,
        sourceUrl: `${this.sourceOrigin.replace(/\/$/, "")}/markets/${source.match.matchId}`,
        polymarketUrl: `https://polymarket.com/event/${best.event.slug}`,
        teams: source.match.teams,
        englishTeams: source.englishTeams,
        polymarketOutcomes: polymarket.outcomes,
        tournament: source.match.tournament,
        bestOf: source.match.bestOf,
        startTime: source.startTime,
        polymarketStartTime: best.event.startTime,
        confidence,
        notes,
        ...(reason ? { reason } : {}),
        market: preview,
        books: summary,
      };
      usedEvents.add(best.event.slug);
      if (reason) review.push(candidate);
      else matched.push(candidate);
    }
    return { discoveredAt: Date.now(), matched, review, rejected };
  }

  async discoverKgl(): Promise<LeagueDiscoveryResult> {
    return this.discover("kgl");
  }
}

export const leagueDiscoveryInternals = { scorePair, topBookSummary };
