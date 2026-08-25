import assert from "node:assert/strict";
import test from "node:test";
import { parseSourceMatchList } from "../src/source/match-metadata-client.js";
import {
  getLeague,
  isSourceMatchInLeague,
  listPublicLeagues,
  requireLeague,
} from "../src/web/league-registry.js";

function listedMatch(overrides: {
  tournament: string;
  tournamentId?: string;
}): ReturnType<typeof parseSourceMatchList>[0] {
  const [match] = parseSourceMatchList({
    data: [
      {
        id: "1",
        bo: 7,
        score: "0:0",
        tournament_id: overrides.tournamentId ?? "",
        tournament_cn_name: overrides.tournament,
        match_cn_team: "上海EDG.M,杭州LGD.NBW",
        match_en_team: "EDward Gaming,LGD NBW",
        start_time: 1_787_826_600,
        status: 5,
        suspended: 0,
        visible: 1,
        is_open_match: 1,
        mkt_ids: {},
      },
    ],
  });
  assert.ok(match);
  return match;
}

test("public league registry exposes KPL as the default", () => {
  const leagues = listPublicLeagues();
  assert.deepEqual(
    leagues.map((league) => league.id),
    ["kpl", "kgl"],
  );
  assert.equal(leagues.find((league) => league.isDefault)?.id, "kpl");
  assert.equal(requireLeague("kpl").sourceTournamentIds[0], "13714526843543530");
  assert.equal(getLeague("missing"), undefined);
  assert.throws(() => requireLeague("lol"), /未知联赛/);
});

test("source matches are classified by tournament id first, then name", () => {
  const kpl = requireLeague("kpl");
  const kgl = requireLeague("kgl");
  const byId = listedMatch({
    tournament: "irrelevant",
    tournamentId: "13714526843543530",
  });
  const byName = listedMatch({ tournament: "KPL 职业联赛 夏季赛季后赛" });
  const kglMatch = listedMatch({
    tournament: "KGL 甲级职业联赛 夏季赛",
    tournamentId: "581112559764744",
  });
  assert.equal(isSourceMatchInLeague(byId, kpl), true);
  assert.equal(isSourceMatchInLeague(byId, kgl), false);
  assert.equal(isSourceMatchInLeague(byName, kpl), true);
  assert.equal(isSourceMatchInLeague(byName, kgl), false);
  assert.equal(isSourceMatchInLeague(kglMatch, kgl), true);
  assert.equal(isSourceMatchInLeague(kglMatch, kpl), false);
  assert.equal(byId.tournamentId, "13714526843543530");
});
