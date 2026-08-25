import type { ListedSourceMatch } from "../source/match-metadata-client.js";

export interface LeagueDefinition {
  id: string;
  name: string;
  shortName: string;
  description: string;
  gameId: string;
  sourceTournamentIds: readonly string[];
  sourceTournamentPattern: RegExp;
  polymarketTagSlug: string;
  polymarketTitlePattern: RegExp;
  polymarketSearchQuery: string;
  isDefault?: boolean;
}

export interface PublicLeague {
  id: string;
  name: string;
  shortName: string;
  description: string;
  isDefault: boolean;
}

export const LEAGUES: readonly LeagueDefinition[] = [
  {
    id: "kpl",
    name: "King Pro League",
    shortName: "KPL",
    description: "王者荣耀职业联赛。按源站 tournament_id 与 Polymarket 标题 King Pro League 配对。",
    gameId: "257561197207055",
    sourceTournamentIds: ["13714526843543530"],
    sourceTournamentPattern: /\bKPL\b(?!.*Growth)/i,
    polymarketTagSlug: "honor-of-kings",
    polymarketTitlePattern: /King Pro League/i,
    polymarketSearchQuery: "King Pro League",
    isDefault: true,
  },
  {
    id: "kgl",
    name: "KPL Growth League",
    shortName: "KGL",
    description:
      "王者荣耀甲级联赛。按源站 tournament_id 与 Polymarket 标题 KPL Growth League 配对。",
    gameId: "257561197207055",
    sourceTournamentIds: ["581112559764744"],
    sourceTournamentPattern: /KGL|甲级职业联赛/i,
    polymarketTagSlug: "honor-of-kings",
    polymarketTitlePattern: /KPL Growth League/i,
    polymarketSearchQuery: "KPL Growth League",
  },
];

const leaguesById = new Map(LEAGUES.map((league) => [league.id, league]));

export function listPublicLeagues(): PublicLeague[] {
  return LEAGUES.map((league) => ({
    id: league.id,
    name: league.name,
    shortName: league.shortName,
    description: league.description,
    isDefault: league.isDefault === true,
  }));
}

export function getLeague(leagueId: string): LeagueDefinition | undefined {
  return leaguesById.get(leagueId);
}

export function requireLeague(leagueId: string): LeagueDefinition {
  const league = getLeague(leagueId);
  if (!league) throw new Error(`未知联赛：${leagueId}`);
  return league;
}

export function isSourceMatchInLeague(item: ListedSourceMatch, league: LeagueDefinition): boolean {
  if (item.tournamentId && league.sourceTournamentIds.includes(item.tournamentId)) {
    return true;
  }
  return league.sourceTournamentPattern.test(item.match.tournament);
}
