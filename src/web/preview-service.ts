import { normalizeDecimalOdds } from "../odds/probability.js";
import type { ListedMoneylineMarket, MarketResolver } from "../polymarket/market-resolver.js";
import type { MatchMetadataClient } from "../source/match-metadata-client.js";
import type { SourceMatchMetadata } from "../types.js";
import { parseMarketUrls } from "./url-parser.js";

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
  sourceMarketId: string;
  polymarketSlug: string;
  polymarketOutcomes: readonly [string, string];
  tickSize: number;
  minOrderSize: number;
  tradable: boolean;
  overround: number;
  outcomes: readonly [PreviewOutcome, PreviewOutcome];
}

export interface MarketPreview {
  sourceUrl: string;
  polymarketUrl: string;
  matchId: string;
  eventSlug: string;
  teams: readonly [string, string];
  tournament: string;
  bestOf: number;
  score: string;
  markets: PreviewMarket[];
}

function floorToTick(value: number, tick: number): number {
  return Math.floor((value + 1e-12) / tick) * tick;
}

function recommendedPrices(
  probabilities: readonly [number, number],
  targetReturnRate: number,
  tickSize: number,
): readonly [number | null, number | null] {
  const askTotal = 1 / targetReturnRate;
  const raw = [1 - probabilities[1] * askTotal, 1 - probabilities[0] * askTotal] as const;
  return raw.map((price) => {
    if (!Number.isFinite(price) || price <= 0 || price >= 1) return null;
    return Math.min(1 - tickSize, Math.max(tickSize, floorToTick(price, tickSize)));
  }) as [number | null, number | null];
}

function winnerMarket(name: string): boolean {
  return name === "全场胜负" || /^第\d+局胜负$/.test(name);
}

function normalizeTeamTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[.\-_]/g, " ")
    .replace(/(esports|gaming|team|club|pro|honor|kings)/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

export function teamMatchScore(sourceName: string, polymarketOutcome: string): number {
  const sourceTokens = normalizeTeamTokens(sourceName);
  const outcomeTokens = normalizeTeamTokens(polymarketOutcome);
  if (sourceTokens.length === 0 || outcomeTokens.length === 0) return 0;
  let score = 0;
  for (const source of sourceTokens) {
    for (const outcome of outcomeTokens) {
      if (source === outcome || source.includes(outcome) || outcome.includes(source)) score += 3;
    }
  }
  // Common KPL / Polymarket aliases.
  const joinedSource = sourceTokens.join(" ");
  const joinedOutcome = outcomeTokens.join(" ");
  const aliases: Array<[RegExp, RegExp]> = [
    [/tes|tesa|top|长沙/, /top|armor|tes/],
    [/ttg|talent|广州/, /talent|ttg/],
    [/lgd|nbw|杭州/, /lgd|nbw/],
    [/rw|济南|rogue/, /rogue|warriors|rw/],
    [/edg|edward|上海/, /edward|edg/],
    [/wolves|狼队|wol|重庆/, /wolves/],
    [/hero|久竞|jiujing|南通/, /hero|jiujing/],
    [/jdg|北京/, /\bjd\b|jdg/],
    [/estar/, /estar/],
    [/超玩会|\bag\b/, /\bag\b|super play/],
    [/weibo|\bwbg\b/, /weibo|\bwbg\b/],
    [/\brng\b/, /\brng\b/],
    [/\bdrg\b/, /\bdrg\b/],
  ];
  for (const [sourcePattern, outcomePattern] of aliases) {
    if (sourcePattern.test(joinedSource) && outcomePattern.test(joinedOutcome)) score += 5;
  }
  return score;
}

export function suggestPolymarketOutcomes(
  sourceNames: readonly [string, string],
  polymarketOutcomes: readonly [string, string],
): readonly [string, string] {
  const firstScores = [
    teamMatchScore(sourceNames[0], polymarketOutcomes[0]),
    teamMatchScore(sourceNames[0], polymarketOutcomes[1]),
  ] as const;
  const secondScores = [
    teamMatchScore(sourceNames[1], polymarketOutcomes[0]),
    teamMatchScore(sourceNames[1], polymarketOutcomes[1]),
  ] as const;
  const firstPrefersSecond = firstScores[1] > firstScores[0];
  const secondPrefersFirst = secondScores[0] > secondScores[1];
  if (firstPrefersSecond && secondPrefersFirst) {
    return [polymarketOutcomes[1], polymarketOutcomes[0]];
  }
  if (firstScores[0] === firstScores[1] && secondScores[0] === secondScores[1]) {
    // Fall back to team-list order when scores are tied.
    return polymarketOutcomes;
  }
  if (firstScores[1] > firstScores[0] && secondScores[1] >= secondScores[0]) {
    return [polymarketOutcomes[1], polymarketOutcomes[0]];
  }
  return polymarketOutcomes;
}

function orderSourceOutcomes(
  outcomes: ReadonlyMap<string, string>,
  teams: readonly [string, string],
): Array<[string, string]> {
  const entries = [...outcomes.entries()];
  return entries.sort((left, right) => {
    const leftIndex = teams.findIndex((team) => left[1].includes(team) || team.includes(left[1]));
    const rightIndex = teams.findIndex(
      (team) => right[1].includes(team) || team.includes(right[1]),
    );
    const leftRank = leftIndex === -1 ? 99 : leftIndex;
    const rightRank = rightIndex === -1 ? 99 : rightIndex;
    return leftRank - rightRank;
  });
}

export function buildMarkets(
  match: SourceMatchMetadata,
  polymarketMarkets: readonly ListedMoneylineMarket[],
  targetReturnRate: number,
): PreviewMarket[] {
  const oddsById = new Map(match.initialOdds.map((odd) => [odd.oddId, odd]));
  const previews: PreviewMarket[] = [];
  for (const source of [...match.markets.values()].sort((a, b) => a.round - b.round)) {
    if (!winnerMarket(source.name) || source.outcomes.size !== 2) continue;
    const polymarket = polymarketMarkets.find((candidate) => candidate.round === source.round);
    if (!polymarket) continue;
    const sourceOutcomes = orderSourceOutcomes(source.outcomes, match.teams);
    const first = sourceOutcomes[0];
    const second = sourceOutcomes[1];
    if (!first || !second) continue;
    const firstOdd = oddsById.get(first[0]);
    const secondOdd = oddsById.get(second[0]);
    if (!firstOdd || !secondOdd) continue;
    const suggested = suggestPolymarketOutcomes([first[1], second[1]], polymarket.outcomes);
    const normalized = normalizeDecimalOdds([firstOdd.decimalOdd, secondOdd.decimalOdd]);
    const probabilities = normalized.probabilities as [number, number];
    const prices = recommendedPrices(probabilities, targetReturnRate, polymarket.tickSize);
    previews.push({
      name: source.name,
      round: source.round,
      sourceMarketId: source.marketId,
      polymarketSlug: polymarket.slug,
      polymarketOutcomes: polymarket.outcomes,
      tickSize: polymarket.tickSize,
      minOrderSize: polymarket.minOrderSize,
      tradable: polymarket.tradable,
      overround: normalized.overround,
      outcomes: [
        {
          sourceOddId: first[0],
          sourceName: first[1],
          decimalOdd: firstOdd.decimalOdd,
          fairProbability: probabilities[0],
          suggestedPolymarketOutcome: suggested[0],
          recommendedBuyPrice: prices[0],
        },
        {
          sourceOddId: second[0],
          sourceName: second[1],
          decimalOdd: secondOdd.decimalOdd,
          fairProbability: probabilities[1],
          suggestedPolymarketOutcome: suggested[1],
          recommendedBuyPrice: prices[1],
        },
      ],
    });
  }
  return previews;
}

export class PreviewService {
  constructor(
    private readonly metadataClient: MatchMetadataClient,
    private readonly marketResolver: MarketResolver,
    private readonly targetReturnRate: number,
  ) {}

  async preview(sourceUrl: string, polymarketUrl: string): Promise<MarketPreview> {
    const parsed = parseMarketUrls(sourceUrl, polymarketUrl);
    const [match, polymarketMarkets] = await Promise.all([
      this.metadataClient.fetchMatch(parsed.matchId),
      this.marketResolver.listMoneylineMarkets(parsed.eventSlug),
    ]);
    return {
      ...parsed,
      teams: match.teams,
      tournament: match.tournament,
      bestOf: match.bestOf,
      score: match.score,
      markets: buildMarkets(match, polymarketMarkets, this.targetReturnRate),
    };
  }
}

export const previewInternals = {
  recommendedPrices,
  buildMarkets,
  suggestPolymarketOutcomes,
  teamMatchScore,
};
