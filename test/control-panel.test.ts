import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OddsBook } from "../src/odds/odds-book.js";
import { deleteMarketConfig, writeMarketConfig } from "../src/web/config-writer.js";
import { previewInternals } from "../src/web/preview-service.js";
import { readRuntimeLimits, writeRuntimeLimits } from "../src/web/runtime-overrides.js";
import { SseHub } from "../src/web/sse.js";
import { parseMarketUrls } from "../src/web/url-parser.js";
import { estimateMarketBudget } from "../web/lib/budget.js";

test("parses source match ID and Polymarket event slug", () => {
  const parsed = parseMarketUrls(
    "https://source.example/markets/4689100176946822",
    "https://polymarket.com/esports/honor-of-kings/hok-tesa-ttg-2026-07-31",
  );
  assert.equal(parsed.matchId, "4689100176946822");
  assert.equal(parsed.eventSlug, "hok-tesa-ttg-2026-07-31");
});

test("rejects a source URL without a numeric match ID", () => {
  assert.throws(() =>
    parseMarketUrls(
      "https://source.example/markets/not-a-number",
      "https://polymarket.com/esports/hok-event",
    ),
  );
});

test("calculates complementary recommended BUY prices on tick", () => {
  const prices = previewInternals.recommendedPrices([0.6, 0.4], 0.8, 0.01);
  assert.deepEqual(prices, [0.5, 0.25]);
});

test("suggests Polymarket outcomes by team aliases instead of array order", () => {
  const suggested = previewInternals.suggestPolymarketOutcomes(
    ["广州TTG", "长沙TES A"],
    ["TOP Esports Armor", "Talent Gaming"],
  );
  assert.deepEqual(suggested, ["Talent Gaming", "TOP Esports Armor"]);
});

test("maps KPL city-prefixed names onto Polymarket English outcomes", () => {
  assert.deepEqual(
    previewInternals.suggestPolymarketOutcomes(
      ["上海EDG.M", "杭州LGD.NBW"],
      ["LGD NBW", "EDward Gaming"],
    ),
    ["EDward Gaming", "LGD NBW"],
  );
  assert.deepEqual(
    previewInternals.suggestPolymarketOutcomes(
      ["重庆狼队", "长沙TES A"],
      ["TOP Esports Armor", "Wolves"],
    ),
    ["Wolves", "TOP Esports Armor"],
  );
});

test("preview only keeps pure winner markets for each round", () => {
  const match = {
    matchId: "match",
    teams: ["甲", "乙"] as const,
    bestOf: 3,
    score: "0:0",
    tournament: "KPL",
    markets: new Map([
      [
        "match-winner",
        {
          marketId: "match-winner",
          matchId: "match",
          scope: "match" as const,
          round: 0,
          name: "全场胜负",
          outcomes: new Map([
            ["odd-a", "甲"],
            ["odd-b", "乙"],
          ]),
        },
      ],
      [
        "combo",
        {
          marketId: "combo",
          matchId: "match",
          scope: "game" as const,
          round: 1,
          name: "单局 - 获胜+第一滴血",
          outcomes: new Map([
            ["odd-c", "甲"],
            ["odd-d", "乙"],
          ]),
        },
      ],
      [
        "game1",
        {
          marketId: "game1",
          matchId: "match",
          scope: "game" as const,
          round: 1,
          name: "第1局胜负",
          outcomes: new Map([
            ["odd-e", "甲"],
            ["odd-f", "乙"],
          ]),
        },
      ],
    ]),
    initialOdds: [
      {
        marketId: "match-winner",
        matchId: "match",
        oddId: "odd-a",
        decimalOdd: 2,
        returnRate: 95,
        receivedAt: 1,
      },
      {
        marketId: "match-winner",
        matchId: "match",
        oddId: "odd-b",
        decimalOdd: 2,
        returnRate: 95,
        receivedAt: 1,
      },
      {
        marketId: "combo",
        matchId: "match",
        oddId: "odd-c",
        decimalOdd: 2,
        returnRate: 95,
        receivedAt: 1,
      },
      {
        marketId: "combo",
        matchId: "match",
        oddId: "odd-d",
        decimalOdd: 2,
        returnRate: 95,
        receivedAt: 1,
      },
      {
        marketId: "game1",
        matchId: "match",
        oddId: "odd-e",
        decimalOdd: 1.8,
        returnRate: 95,
        receivedAt: 1,
      },
      {
        marketId: "game1",
        matchId: "match",
        oddId: "odd-f",
        decimalOdd: 2.2,
        returnRate: 95,
        receivedAt: 1,
      },
    ],
    initialStates: [],
  };
  const polymarket = [
    {
      slug: "event",
      conditionId: "c0",
      outcomes: ["A", "B"] as const,
      tokenIds: ["t0", "t1"] as const,
      tickSize: 0.01,
      minOrderSize: 5,
      acceptingOrders: true,
      closed: false,
      feesEnabled: false,
      round: 0,
      tradable: true,
      kind: "moneyline" as const,
      line: null,
      groupItemTitle: "",
    },
    {
      slug: "event-game1",
      conditionId: "c1",
      outcomes: ["A", "B"] as const,
      tokenIds: ["t2", "t3"] as const,
      tickSize: 0.01,
      minOrderSize: 5,
      acceptingOrders: true,
      closed: false,
      feesEnabled: false,
      round: 1,
      tradable: true,
      kind: "child_moneyline" as const,
      line: null,
      groupItemTitle: "",
    },
  ];
  const markets = previewInternals.buildMarkets(match, polymarket, 0.8);
  assert.deepEqual(
    markets.map((item) => item.sourceMarketId),
    ["match-winner", "game1"],
  );
  assert.equal(markets[1]?.conditionId, "c1");
  assert.deepEqual(markets[1]?.tokenIds, ["t2", "t3"]);
});

test("preview pairs map handicap and totals by line instead of round", () => {
  const match = {
    matchId: "match",
    teams: ["甲", "乙"] as const,
    bestOf: 7,
    score: "0:0",
    tournament: "KPL",
    markets: new Map([
      [
        "match-winner",
        {
          marketId: "match-winner",
          matchId: "match",
          scope: "match" as const,
          round: 0,
          name: "全场胜负",
          outcomes: new Map([
            ["odd-a", "甲"],
            ["odd-b", "乙"],
          ]),
        },
      ],
      [
        "handicap-35",
        {
          marketId: "handicap-35",
          matchId: "match",
          scope: "match" as const,
          round: 0,
          name: "地图让分",
          outcomes: new Map([
            ["odd-h1", "甲 -3.5"],
            ["odd-h2", "乙 +3.5"],
          ]),
        },
      ],
      [
        "totals-55",
        {
          marketId: "totals-55",
          matchId: "match",
          scope: "match" as const,
          round: 0,
          name: "地图总数大小",
          outcomes: new Map([
            ["odd-o", "大 5.5"],
            ["odd-u", "小 5.5"],
          ]),
        },
      ],
    ]),
    initialOdds: [
      {
        marketId: "match-winner",
        matchId: "match",
        oddId: "odd-a",
        decimalOdd: 1.57,
        returnRate: 95.5,
        receivedAt: 1,
      },
      {
        marketId: "match-winner",
        matchId: "match",
        oddId: "odd-b",
        decimalOdd: 2.75,
        returnRate: 95.5,
        receivedAt: 1,
      },
      {
        marketId: "handicap-35",
        matchId: "match",
        oddId: "odd-h1",
        decimalOdd: 8.2,
        returnRate: 94.5,
        receivedAt: 1,
      },
      {
        marketId: "handicap-35",
        matchId: "match",
        oddId: "odd-h2",
        decimalOdd: 1.07,
        returnRate: 94.5,
        receivedAt: 1,
      },
      {
        marketId: "totals-55",
        matchId: "match",
        oddId: "odd-o",
        decimalOdd: 1.85,
        returnRate: 94.5,
        receivedAt: 1,
      },
      {
        marketId: "totals-55",
        matchId: "match",
        oddId: "odd-u",
        decimalOdd: 1.95,
        returnRate: 94.5,
        receivedAt: 1,
      },
    ],
    initialStates: [],
  };
  const polymarket = [
    {
      slug: "event",
      conditionId: "c0",
      outcomes: ["A", "B"] as const,
      tokenIds: ["t0", "t1"] as const,
      tickSize: 0.01,
      minOrderSize: 5,
      acceptingOrders: true,
      closed: false,
      feesEnabled: true,
      round: 0,
      tradable: true,
      kind: "moneyline" as const,
      line: null,
      groupItemTitle: "",
    },
    {
      slug: "event-game-handicap-away-3pt5",
      conditionId: "c-h",
      outcomes: ["A -3.5", "B +3.5"] as const,
      tokenIds: ["th0", "th1"] as const,
      tickSize: 0.01,
      minOrderSize: 5,
      acceptingOrders: true,
      closed: false,
      feesEnabled: true,
      round: 0,
      tradable: true,
      kind: "map_handicap" as const,
      line: 3.5,
      groupItemTitle: "B +3.5",
    },
    {
      slug: "event-total-maps-5pt5",
      conditionId: "c-t",
      outcomes: ["Over", "Under"] as const,
      tokenIds: ["tt0", "tt1"] as const,
      tickSize: 0.01,
      minOrderSize: 5,
      acceptingOrders: true,
      closed: false,
      feesEnabled: true,
      round: 0,
      tradable: true,
      kind: "totals" as const,
      line: 5.5,
      groupItemTitle: "5.5",
    },
  ];
  const markets = previewInternals.buildMarkets(match, polymarket, 0.95);
  assert.deepEqual(
    markets.map((item) => [item.sourceMarketId, item.kind, item.line, item.polymarketSlug]),
    [
      ["match-winner", "moneyline", null, "event"],
      ["handicap-35", "map_handicap", 3.5, "event-game-handicap-away-3pt5"],
      ["totals-55", "totals", 5.5, "event-total-maps-5pt5"],
    ],
  );
  assert.deepEqual(
    markets[1]?.outcomes.map((item) => item.suggestedPolymarketOutcome),
    ["A -3.5", "B +3.5"],
  );
  assert.deepEqual(
    markets[2]?.outcomes.map((item) => item.suggestedPolymarketOutcome),
    ["Over", "Under"],
  );
});

test("writes market overrides and preserves unrelated mappings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "poly-maker-config-"));
  const path = join(directory, "markets.json");
  try {
    await writeMarketConfig(
      {
        sourceMatchId: "match-a",
        polymarketEventSlug: "event-a",
        markets: [
          {
            name: "A vs B - 全场胜负",
            enabled: true,
            sourceMarketId: "source-market",
            polymarketSlug: "event-a",
            round: 0,
            outcomes: [
              { sourceOddId: "odd-a", outcome: "A" },
              { sourceOddId: "odd-b", outcome: "B" },
            ],
            orderNotional: 4,
            quoteLevels: 3,
            levelSpacingTicks: 2,
            targetReturnRate: 0.8,
          },
        ],
      },
      path,
    );
    const contents = JSON.parse(await readFile(path, "utf8"));
    assert.equal(contents[0].orderNotional, 4);
    assert.equal(contents[0].quoteLevels, 3);
    assert.equal(contents[0].quoteMode, "complement-buy");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("deletes all saved mappings for a finished match", async () => {
  const directory = await mkdtemp(join(tmpdir(), "poly-maker-delete-"));
  const path = join(directory, "markets.json");
  try {
    const input = {
      sourceMatchId: "finished",
      polymarketEventSlug: "finished-event",
      markets: [
        {
          name: "A vs B - 全场胜负",
          enabled: false,
          sourceMarketId: "source-market",
          polymarketSlug: "finished-event",
          round: 0,
          outcomes: [
            { sourceOddId: "odd-a", outcome: "A" },
            { sourceOddId: "odd-b", outcome: "B" },
          ],
          orderNotional: 5,
          quoteLevels: 2,
          levelSpacingTicks: 2,
          targetReturnRate: 0.8,
        },
      ],
    };
    await writeMarketConfig(input, path);
    const mappings = await deleteMarketConfig(
      { sourceMatchId: "finished", polymarketEventSlug: "finished-event" },
      path,
    );
    assert.deepEqual(mappings, []);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("lists saved matches for one-click reopen without pasting URLs", async () => {
  const { listSavedMatches } = await import("../src/web/match-sessions.js");
  const summaries = await listSavedMatches(
    [
      {
        name: "甲 vs 乙 - 第1局胜负",
        enabled: true,
        sourceMatchId: "111",
        sourceMarketId: "m1",
        polymarketEventSlug: "event-x",
        polymarketSlug: "event-x-game1",
        round: 1,
        outcomes: [
          { sourceOddId: "a", outcome: "甲" },
          { sourceOddId: "b", outcome: "乙" },
        ],
      },
      {
        name: "甲 vs 乙 - 第2局胜负",
        enabled: false,
        sourceMatchId: "111",
        sourceMarketId: "m2",
        polymarketEventSlug: "event-x",
        polymarketSlug: "event-x-game2",
        round: 2,
        outcomes: [
          { sourceOddId: "c", outcome: "甲" },
          { sourceOddId: "d", outcome: "乙" },
        ],
      },
    ],
    [
      {
        sourceMatchId: "111",
        polymarketEventSlug: "event-x",
        sourceUrl: "https://source.example/markets/111",
        polymarketUrl: "https://polymarket.com/event/event-x",
        teams: ["甲", "乙"],
        updatedAt: 10,
      },
    ],
    "https://source.example",
  );
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.label, "甲 vs 乙");
  assert.deepEqual(summaries[0]?.enabledRounds, [1]);
  assert.equal(summaries[0]?.sourceUrl, "https://source.example/markets/111");
});

test("runtime limits persist partial overrides over safe defaults", async () => {
  const directory = await mkdtemp(join(tmpdir(), "poly-maker-limits-"));
  const path = join(directory, "limits.json");
  const defaults = {
    maxAccountNotional: 50,
    maxOrderNotional: 10,
    maxOutcomePosition: 25,
    maxTotalExposure: 40,
    makerTargetReturnRate: 0.8,
    oddsStaleMs: 30_000,
    repriceThresholdTicks: 2,
  };
  try {
    await writeRuntimeLimits({ maxAccountNotional: 80 }, defaults, path);
    const limits = await readRuntimeLimits(defaults, path);
    assert.equal(limits.maxAccountNotional, 80);
    assert.equal(limits.maxOrderNotional, 10);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("SSE hub immediately sends status snapshots", () => {
  const request = new EventEmitter();
  const writes: string[] = [];
  const response = {
    writeHead: () => response,
    write: (value: string) => {
      writes.push(value);
      return true;
    },
    end: () => response,
  };
  const hub = new SseHub();
  hub.add(request as IncomingMessage, response as unknown as ServerResponse, {
    process: { running: true, pid: 123 },
  });
  assert.match(writes.join(""), /event: status/);
  assert.match(writes.join(""), /"running":true/);
  request.emit("close");
  hub.close();
});

test("budget estimate counts two outcomes across enabled quote layers", () => {
  assert.equal(
    estimateMarketBudget([
      { enabled: true, tradable: true, orderNotional: 5, quoteLevels: 3 },
      { enabled: false, tradable: true, orderNotional: 20, quoteLevels: 2 },
    ]),
    30,
  );
});

test("OddsBook replaces mappings without losing collected source odds", () => {
  const first = {
    name: "market",
    enabled: true,
    sourceMatchId: "match",
    sourceMarketId: "market",
    polymarketSlug: "event",
    outcomes: [
      { sourceOddId: "a", outcome: "A" },
      { sourceOddId: "b", outcome: "B" },
    ],
  };
  const book = new OddsBook([first], 1, 2);
  book.apply([
    {
      marketId: "market",
      matchId: "match",
      oddId: "a",
      decimalOdd: 2,
      returnRate: 95,
      receivedAt: 1,
    },
    {
      marketId: "market",
      matchId: "match",
      oddId: "b",
      decimalOdd: 2,
      returnRate: 95,
      receivedAt: 1,
    },
  ]);
  book.replaceMappings([{ ...first, enabled: false }]);
  assert.equal(book.snapshot("market"), undefined);
  book.replaceMappings([first]);
  assert.ok(book.snapshot("market"));
});
