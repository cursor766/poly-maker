import { normalizeDecimalOdds } from "../odds/probability.js";
import type {
  ListedMoneylineMarket,
  MarketResolver,
  QuoteableMarketKind,
} from "../polymarket/market-resolver.js";
import type { MatchMetadataClient } from "../source/match-metadata-client.js";
import type { SourceMarketMetadata, SourceMatchMetadata } from "../types.js";
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
  kind: QuoteableMarketKind;
  line: number | null;
  sourceMarketId: string;
  polymarketSlug: string;
  conditionId: string;
  tokenIds: readonly [string, string];
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

function sourceMarketKind(name: string): QuoteableMarketKind | undefined {
  if (name === "全场胜负") return "moneyline";
  if (/^第\d+局胜负$/.test(name)) return "child_moneyline";
  if (name === "地图让分" || /map handicap/i.test(name)) return "map_handicap";
  if (name === "地图总数大小" || name.startsWith("地图总数")) return "totals";
  return undefined;
}

export function parseSignedLine(value: string): number | null {
  const match = /([+-]?\d+(?:\.\d+)?)/.exec(value);
  if (!match?.[1]) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

export function sourceMarketLine(source: SourceMarketMetadata): number | null {
  for (const name of source.outcomes.values()) {
    const line = parseSignedLine(name);
    if (line !== null) return Math.abs(line);
  }
  const fromName = parseSignedLine(source.name);
  return fromName === null ? null : Math.abs(fromName);
}

function linesEqual(left: number | null, right: number | null): boolean {
  return left !== null && right !== null && Math.abs(left - right) < 1e-9;
}

function previewName(
  source: SourceMarketMetadata,
  kind: QuoteableMarketKind,
  line: number | null,
): string {
  if (kind === "map_handicap" && line !== null) return `地图让分 +${line}`;
  if (kind === "totals" && line !== null) return `地图总数 ${line}`;
  return source.name;
}

function totalsSide(name: string): "over" | "under" | null {
  if (/over|大/i.test(name) && !/under/i.test(name)) return "over";
  if (/under|小/i.test(name)) return "under";
  return null;
}

function listedKind(market: ListedMoneylineMarket): QuoteableMarketKind {
  return market.kind ?? (market.round === 0 ? "moneyline" : "child_moneyline");
}

function kindOrder(kind: QuoteableMarketKind | undefined): number {
  if (kind === "moneyline") return 0;
  if (kind === "child_moneyline") return 1;
  if (kind === "map_handicap") return 2;
  if (kind === "totals") return 3;
  return 9;
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
  const sourceTotals = [totalsSide(sourceNames[0]), totalsSide(sourceNames[1])] as const;
  const polyTotals = [
    totalsSide(polymarketOutcomes[0]),
    totalsSide(polymarketOutcomes[1]),
  ] as const;
  if (
    sourceTotals[0] &&
    sourceTotals[1] &&
    sourceTotals[0] !== sourceTotals[1] &&
    polyTotals[0] &&
    polyTotals[1]
  ) {
    return sourceTotals[0] === polyTotals[0]
      ? polymarketOutcomes
      : [polymarketOutcomes[1], polymarketOutcomes[0]];
  }
  const sourceSigns = [parseSignedLine(sourceNames[0]), parseSignedLine(sourceNames[1])] as const;
  const polySigns = [
    parseSignedLine(polymarketOutcomes[0]),
    parseSignedLine(polymarketOutcomes[1]),
  ] as const;
  if (
    sourceSigns[0] !== null &&
    sourceSigns[1] !== null &&
    Math.sign(sourceSigns[0]) !== Math.sign(sourceSigns[1]) &&
    polySigns[0] !== null &&
    polySigns[1] !== null &&
    Math.sign(polySigns[0]) !== Math.sign(polySigns[1])
  ) {
    return Math.sign(sourceSigns[0]) === Math.sign(polySigns[0])
      ? polymarketOutcomes
      : [polymarketOutcomes[1], polymarketOutcomes[0]];
  }
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

function findPolymarketMarket(
  source: SourceMarketMetadata,
  polymarketMarkets: readonly ListedMoneylineMarket[],
  usedSlugs: Set<string>,
): ListedMoneylineMarket | undefined {
  const kind = sourceMarketKind(source.name);
  if (!kind) return undefined;
  const line = sourceMarketLine(source);
  const match = polymarketMarkets.find((candidate) => {
    if (usedSlugs.has(candidate.slug)) return false;
    const candidateKind = listedKind(candidate);
    if (candidateKind !== kind) return false;
    if (kind === "moneyline") return candidate.round === 0;
    if (kind === "child_moneyline") return candidate.round === source.round;
    return linesEqual(candidate.line, line);
  });
  if (match) usedSlugs.add(match.slug);
  return match;
}

export function buildMarkets(
  match: SourceMatchMetadata,
  polymarketMarkets: readonly ListedMoneylineMarket[],
  targetReturnRate: number,
): PreviewMarket[] {
  const oddsById = new Map(match.initialOdds.map((odd) => [odd.oddId, odd]));
  const usedSlugs = new Set<string>();
  const previews: PreviewMarket[] = [];
  for (const source of [...match.markets.values()].sort((left, right) => {
    const kindDelta =
      kindOrder(sourceMarketKind(left.name)) - kindOrder(sourceMarketKind(right.name));
    if (kindDelta !== 0) return kindDelta;
    return left.round - right.round || left.name.localeCompare(right.name);
  })) {
    const kind = sourceMarketKind(source.name);
    if (!kind || source.outcomes.size !== 2) continue;
    const polymarket = findPolymarketMarket(source, polymarketMarkets, usedSlugs);
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
    const line =
      kind === "moneyline" || kind === "child_moneyline" ? null : sourceMarketLine(source);
    previews.push({
      name: previewName(source, kind, line),
      round: source.round,
      kind,
      line,
      sourceMarketId: source.marketId,
      polymarketSlug: polymarket.slug,
      conditionId: polymarket.conditionId,
      tokenIds: polymarket.tokenIds,
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
