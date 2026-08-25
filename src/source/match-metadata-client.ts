import { z } from "zod";
import type {
  SourceMarketMetadata,
  SourceMarketState,
  SourceMatchMetadata,
  SourceOddUpdate,
} from "../types.js";

const oddMetadataSchema = z.object({
  id: z.coerce.string(),
  name: z.string().default(""),
  en_name: z.string().default(""),
  sort_id: z.coerce.number().int().nonnegative(),
  odd: z.coerce.number().optional(),
});

const marketMetadataSchema = z.object({
  id: z.coerce.string(),
  round: z.coerce.number().int().nonnegative(),
  name: z.string().default(""),
  cn_name: z.string().default(""),
  en_name: z.string().default(""),
  status: z.coerce.number().default(0),
  suspended: z.coerce.number().default(0),
  visible: z.coerce.number().default(1),
  return_rate: z.coerce.number().nonnegative().default(0),
  odds: z.record(z.string(), oddMetadataSchema).default({}),
});

const matchMetadataSchema = z.object({
  id: z.coerce.string(),
  bo: z.coerce.number().int().positive(),
  score: z.string().default(""),
  tournament_id: z.coerce.string().optional().default(""),
  tournament_cn_name: z.string().default(""),
  tournament_name: z.string().default(""),
  match_cn_team: z.string().default(""),
  match_team: z.string().default(""),
  match_en_team: z.string().default(""),
  start_time: z.coerce.number().int().nonnegative().default(0),
  end_time: z.coerce.number().int().nonnegative().default(0),
  status: z.coerce.number().int().default(0),
  suspended: z.coerce.number().int().default(0),
  visible: z.coerce.number().int().default(1),
  is_open_match: z.coerce.number().int().default(1),
  mkt_ids: z.record(z.string(), z.array(z.coerce.string())),
  default_market: marketMetadataSchema.optional(),
});

const responseSchema = z.object({
  data: z.array(matchMetadataSchema),
  status: z.union([z.literal("true"), z.literal(true)]).optional(),
});

const marketViewResponseSchema = z.object({
  data: z.array(marketMetadataSchema),
  status: z.union([z.literal("true"), z.literal(true)]),
});

function decodeText(value: string): string {
  return value
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&apos;", "'")
    .replace(/\s+/g, " ")
    .trim();
}

function parseTeamPair(value: string): [string, string] {
  const teams = decodeText(value)
    .split(",")
    .map((team) => team.trim());
  if (!teams[0] || !teams[1]) throw new Error("invalid team pair");
  return [teams[0], teams[1]];
}

function parseTeams(match: z.infer<typeof matchMetadataSchema>): [string, string] {
  try {
    return parseTeamPair(match.match_cn_team || match.match_team);
  } catch {
    throw new Error(`invalid teams for match ${match.id}`);
  }
}

function genericMarketName(round: number): string {
  return round === 0 ? "全场盘口" : `第${round}局盘口`;
}

function normalizeMarketName(market: z.infer<typeof marketMetadataSchema>): string {
  const cnName = decodeText(market.cn_name || market.name);
  const enName = decodeText(market.en_name);
  if (enName.toLowerCase() === "match winner" || cnName === "全局 - 获胜") {
    return "全场胜负";
  }
  if (enName.toLowerCase() === "map winner" || cnName === "单局 - 获胜") {
    return `第${market.round}局胜负`;
  }
  return cnName || enName || genericMarketName(market.round);
}

function resolveOutcomeName(
  odd: z.infer<typeof oddMetadataSchema>,
  teams: readonly [string, string],
): string {
  const raw = decodeText(odd.name || odd.en_name);
  const teamToken = /^@T([12])/.exec(raw);
  if (teamToken) {
    const team = teams[Number(teamToken[1]) - 1];
    return team ? raw.replace(teamToken[0], team) : raw;
  }
  return raw || `选项${odd.sort_id + 1}`;
}

function appendMarketSnapshot(
  market: z.infer<typeof marketMetadataSchema>,
  matchId: string,
  teams: readonly [string, string],
  receivedAt: number,
  markets: Map<string, SourceMarketMetadata>,
  initialOdds: SourceOddUpdate[],
  initialStates: SourceMarketState[],
): void {
  const knownRound = markets.get(market.id)?.round;
  const round =
    knownRound ?? (Number.isInteger(market.round) && market.round >= 0 ? market.round : 0);
  markets.set(market.id, {
    marketId: market.id,
    matchId,
    scope: round === 0 ? "match" : "game",
    round,
    name: normalizeMarketName({ ...market, round }),
    outcomes: new Map(
      Object.values(market.odds).map((odd) => [odd.id, resolveOutcomeName(odd, teams)]),
    ),
  });
  initialStates.push({
    marketId: market.id,
    suspended: market.suspended !== 0,
    visible: market.visible !== 0,
    open: [6, 7, 8, 9, 10].includes(market.status) && market.suspended === 0,
    updatedAt: receivedAt,
  });
  for (const odd of Object.values(market.odds)) {
    if (odd.odd === undefined || odd.odd <= 1 || market.return_rate <= 0) continue;
    initialOdds.push({
      marketId: market.id,
      matchId,
      oddId: odd.id,
      decimalOdd: odd.odd,
      returnRate: market.return_rate,
      receivedAt,
    });
  }
}

export function parseMatchMetadata(
  payload: unknown,
  receivedAt = Date.now(),
): SourceMatchMetadata[] {
  const response = responseSchema.parse(payload);
  return response.data.map((match) => {
    const teams = parseTeams(match);
    const markets = new Map<string, SourceMarketMetadata>();
    const initialOdds: SourceOddUpdate[] = [];
    const initialStates: SourceMarketState[] = [];

    for (const [roundText, marketIds] of Object.entries(match.mkt_ids)) {
      const round = Number(roundText);
      if (!Number.isInteger(round) || round < 0) continue;
      for (const marketId of marketIds) {
        markets.set(marketId, {
          marketId,
          matchId: match.id,
          scope: round === 0 ? "match" : "game",
          round,
          name: genericMarketName(round),
          outcomes: new Map(),
        });
      }
    }

    if (match.default_market) {
      appendMarketSnapshot(
        match.default_market,
        match.id,
        teams,
        receivedAt,
        markets,
        initialOdds,
        initialStates,
      );
    }

    return {
      matchId: match.id,
      teams,
      bestOf: match.bo,
      score: match.score,
      tournament: decodeText(match.tournament_cn_name || match.tournament_name),
      markets,
      initialOdds,
      initialStates,
    };
  });
}

export interface ListedSourceMatch {
  match: SourceMatchMetadata;
  englishTeams: readonly [string, string];
  startTime: number;
  status: number;
  sourceOpen: boolean;
  tournamentId: string;
}

export function parseSourceMatchList(
  payload: unknown,
  receivedAt = Date.now(),
): ListedSourceMatch[] {
  const response = responseSchema.parse(payload);
  const parsed = new Map(
    parseMatchMetadata(payload, receivedAt).map((match) => [match.matchId, match]),
  );
  return response.data.flatMap((raw) => {
    const match = parsed.get(raw.id);
    if (!match) return [];
    let englishTeams: [string, string];
    try {
      englishTeams = parseTeamPair(raw.match_en_team || raw.match_team);
    } catch {
      englishTeams = [...match.teams];
    }
    return [
      {
        match,
        englishTeams,
        startTime: raw.start_time * 1_000,
        status: raw.status,
        sourceOpen:
          raw.suspended === 0 && raw.visible !== 0 && raw.is_open_match !== 0 && raw.end_time === 0,
        tournamentId: raw.tournament_id,
      },
    ];
  });
}

function mergeMarketSnapshots(
  match: SourceMatchMetadata,
  payloads: readonly unknown[],
  receivedAt = Date.now(),
): SourceMatchMetadata {
  const markets = new Map(match.markets);
  const oddsById = new Map(match.initialOdds.map((odd) => [odd.oddId, odd]));
  const statesByMarket = new Map(match.initialStates.map((state) => [state.marketId, state]));

  for (const payload of payloads) {
    const response = marketViewResponseSchema.parse(payload);
    for (const market of response.data) {
      const odds: SourceOddUpdate[] = [];
      const states: SourceMarketState[] = [];
      appendMarketSnapshot(market, match.matchId, match.teams, receivedAt, markets, odds, states);
      for (const odd of odds) oddsById.set(odd.oddId, odd);
      for (const state of states) statesByMarket.set(state.marketId, state);
    }
  }

  return {
    ...match,
    markets,
    initialOdds: [...oddsById.values()],
    initialStates: [...statesByMarket.values()],
  };
}

export class MatchMetadataClient {
  constructor(
    private readonly apiUrl: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async fetchMatch(matchId: string): Promise<SourceMatchMetadata> {
    const response = await this.fetcher(`${this.apiUrl}/game/matchList`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        token: this.token,
      },
      body: new URLSearchParams({ ids: matchId }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`match metadata API returned HTTP ${response.status}`);
    const matches = parseMatchMetadata(await response.json());
    const match = matches.find((item) => item.matchId === matchId);
    if (!match) throw new Error(`match metadata not found: ${matchId}`);
    const stageResults = await Promise.allSettled(
      Array.from({ length: match.bestOf + 1 }, (_, stageId) =>
        this.fetchMarketStage(matchId, stageId),
      ),
    );
    const snapshots = stageResults.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    return mergeMarketSnapshots(match, snapshots);
  }

  async listMatches(
    gameId: string,
    options: { flag?: number; day?: number; pageSize?: number } = {},
  ): Promise<ListedSourceMatch[]> {
    const url = new URL(`${this.apiUrl}/game/index`);
    url.searchParams.set("game_id", gameId);
    url.searchParams.set("flag", String(options.flag ?? 2));
    url.searchParams.set("day", String(options.day ?? -1));
    url.searchParams.set("page_size", String(options.pageSize ?? 30));
    const response = await this.fetcher(url, {
      headers: { token: this.token, device: "2", lang: "cn" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`source match list API returned HTTP ${response.status}`);
    return parseSourceMatchList(await response.json());
  }

  private async fetchMarketStage(matchId: string, stageId: number): Promise<unknown> {
    const url = new URL(`${this.apiUrl}/game/view`);
    url.searchParams.set("match_id", matchId);
    url.searchParams.set("stage_id", String(stageId));
    const response = await this.fetcher(url, {
      headers: { token: this.token },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`market view API returned HTTP ${response.status} for stage ${stageId}`);
    }
    return response.json();
  }
}
