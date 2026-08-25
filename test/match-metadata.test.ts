import assert from "node:assert/strict";
import test from "node:test";
import { MatchMetadataClient, parseMatchMetadata } from "../src/source/match-metadata-client.js";

const fixture = {
  data: [
    {
      id: "match",
      bo: 5,
      score: "0:0",
      tournament_cn_name: "KPL&nbsp;职业联赛",
      match_cn_team: "杭州LGD.NBW,济南RW侠",
      mkt_ids: {
        "0": ["match-winner", "match-other"],
        "1": ["game1-winner"],
        "2": ["game2-winner"],
      },
      default_market: {
        id: "match-winner",
        round: 0,
        name: "全局&nbsp;-&nbsp;获胜",
        cn_name: "全局&nbsp;-&nbsp;获胜",
        en_name: "Match&nbsp;Winner",
        return_rate: 95,
        odds: {
          first: { id: "odd-home", name: "@T1", en_name: "@T1", sort_id: 0, odd: "2.658" },
          second: { id: "odd-away", name: "@T2", en_name: "@T2", sort_id: 1, odd: "1.478" },
        },
      },
    },
  ],
  status: "true",
};

test("classifies full-match and per-game market IDs", () => {
  const metadata = parseMatchMetadata(fixture)[0];
  assert.ok(metadata);
  assert.deepEqual(metadata.teams, ["杭州LGD.NBW", "济南RW侠"]);
  assert.equal(metadata.markets.get("match-winner")?.scope, "match");
  assert.equal(metadata.markets.get("match-winner")?.name, "全场胜负");
  assert.equal(metadata.markets.get("match-other")?.name, "全场盘口");
  assert.equal(metadata.markets.get("game1-winner")?.scope, "game");
  assert.equal(metadata.markets.get("game1-winner")?.round, 1);
  assert.equal(metadata.markets.get("game2-winner")?.round, 2);
  assert.equal(metadata.markets.get("match-winner")?.outcomes.get("odd-home"), "杭州LGD.NBW");
  assert.equal(metadata.markets.get("match-winner")?.outcomes.get("odd-away"), "济南RW侠");
  assert.equal(metadata.initialOdds.length, 2);
  assert.equal(metadata.initialOdds[0]?.decimalOdd, 2.658);
});

test("metadata client sends token and form-encoded ids", async () => {
  const requestedStages: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(new Headers(init?.headers).get("token"), "token-value");
    const url = new URL(input.toString());
    if (url.pathname === "/game/view") {
      requestedStages.push(url.searchParams.get("stage_id") ?? "");
      assert.equal(url.searchParams.get("match_id"), "match");
      return Response.json({ data: [], status: "true" });
    }
    assert.equal(init?.body?.toString(), "ids=match");
    return new Response(JSON.stringify(fixture), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const metadata = await new MatchMetadataClient(
    "https://example.test",
    "token-value",
    fetcher,
  ).fetchMatch("match");
  assert.equal(metadata.bestOf, 5);
  assert.deepEqual(requestedStages.sort(), ["0", "1", "2", "3", "4", "5"]);
});
