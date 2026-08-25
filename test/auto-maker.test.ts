import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MarketResolver } from "../src/polymarket/market-resolver.js";
import { parseSourceMatchList } from "../src/source/match-metadata-client.js";
import { describeTopOfBookSkip, generateTopOfBookBuyQuotes } from "../src/strategy/maker.js";
import type { PositionState, ResolvedMarket, TokenBook } from "../src/types.js";
import { writeBatchMarketConfigs } from "../src/web/config-writer.js";
import { leagueDiscoveryInternals } from "../src/web/league-discovery-service.js";

const gammaMarket = {
  slug: "hok-jly-jag-2026-08-01",
  conditionId: "condition",
  outcomes: JSON.stringify(["JLY", "JA Gaming"]),
  clobTokenIds: JSON.stringify(["a", "b"]),
  orderPriceMinTickSize: 0.01,
  orderMinSize: 5,
  acceptingOrders: true,
  closed: false,
  active: true,
  enableOrderBook: true,
  sportsMarketType: "moneyline",
  feesEnabled: false,
};

test("parses KGL source index matches and default winner odds", () => {
  const matches = parseSourceMatchList({
    data: [
      {
        id: "5807770960989295",
        bo: 5,
        score: "0:0",
        tournament_cn_name: "KGL&nbsp;甲级职业联赛&nbsp;夏季赛",
        match_cn_team: "JLY,JAG",
        match_team: "JLY,JA&nbsp;Gaming",
        match_en_team: "JLY,JA&nbsp;Gaming",
        start_time: 1_785_564_000,
        status: 5,
        suspended: 0,
        visible: 1,
        is_open_match: 1,
        mkt_ids: {},
        default_market: {
          id: "market",
          round: 0,
          status: 6,
          suspended: 0,
          visible: 1,
          return_rate: 94.5,
          name: "全局&nbsp;-&nbsp;获胜",
          cn_name: "全局&nbsp;-&nbsp;获胜",
          en_name: "Match&nbsp;Winner",
          odds: {
            a: { id: "odd-a", name: "@T1", en_name: "@T1", sort_id: 0, odd: "3.24" },
            b: { id: "odd-b", name: "@T2", en_name: "@T2", sort_id: 1, odd: "1.334" },
          },
        },
      },
    ],
  });
  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0]?.englishTeams, ["JLY", "JA Gaming"]);
  assert.equal(matches[0]?.match.initialOdds.length, 2);
  assert.equal(matches[0]?.match.markets.get("market")?.name, "全场胜负");
  assert.equal(matches[0]?.sourceOpen, true);
});

test("lists paginated active Polymarket league moneylines", async () => {
  const offsets: string[] = [];
  const resolver = new MarketResolver("https://gamma.example", async (input) => {
    const url = new URL(String(input));
    offsets.push(url.searchParams.get("offset") ?? "");
    const offset = Number(url.searchParams.get("offset"));
    const data =
      offset === 0
        ? [
            {
              slug: "hok-jly-jag-2026-08-01",
              title: "JLY vs JA Gaming",
              startTime: "2026-08-01T14:00:00Z",
              markets: [gammaMarket],
            },
          ]
        : [];
    return new Response(JSON.stringify(data), { status: 200 });
  });
  const events = await resolver.listActiveMoneylineEvents("kpl-growth-league", 1);
  assert.deepEqual(offsets, ["0", "1"]);
  assert.equal(events[0]?.markets[0]?.round, 0);
  assert.equal(events[0]?.markets[0]?.tradable, true);
});

test("filters honor-of-kings tag events by league title", async () => {
  const resolver = new MarketResolver("https://gamma.example", async () => {
    return new Response(
      JSON.stringify([
        {
          slug: "hok-edg-lgd-2026-08-27",
          title: "Honor of Kings: EDward Gaming vs LGD NBW (BO7) - King Pro League Playoffs",
          startTime: "2026-08-27T10:30:00Z",
          markets: [{ ...gammaMarket, slug: "hok-edg-lgd-2026-08-27" }],
        },
        {
          slug: "hok-bmg-one-2026-08-23",
          title: "Honor of Kings: BanMei Gaming vs ONE Team (BO5) - Garena Challenger Series",
          startTime: "2026-08-23T10:00:00Z",
          markets: [{ ...gammaMarket, slug: "hok-bmg-one-2026-08-23" }],
        },
      ]),
      { status: 200 },
    );
  });
  const events = await resolver.listActiveMoneylineEvents({
    tagSlug: "honor-of-kings",
    titlePattern: /King Pro League/i,
    searchFallbackQuery: "King Pro League",
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.slug, "hok-edg-lgd-2026-08-27");
});

test("top-of-book mode improves best bid by one tick within source caps", () => {
  const market: ResolvedMarket = {
    slug: "event",
    conditionId: "condition",
    outcomes: ["A", "B"],
    tokenIds: ["a", "b"],
    tickSize: 0.01,
    minOrderSize: 5,
    acceptingOrders: true,
    closed: false,
    feesEnabled: false,
  };
  const books = new Map<string, TokenBook>([
    [
      "a",
      {
        tokenId: "a",
        bids: [{ price: 0.47, size: 10 }],
        asks: [{ price: 0.55, size: 10 }],
        receivedAt: 1,
      },
    ],
    [
      "b",
      {
        tokenId: "b",
        bids: [{ price: 0.2, size: 10 }],
        asks: [{ price: 0.3, size: 10 }],
        receivedAt: 1,
      },
    ],
  ]);
  const positions: PositionState = { byToken: new Map(), cash: 100 };
  const quotes = generateTopOfBookBuyQuotes(
    market,
    new Map([
      ["A", 0.6],
      ["B", 0.4],
    ]),
    books,
    positions,
    {
      targetReturnRate: 0.8,
      minEdge: 0.02,
      orderNotional: 5,
      maxOutcomePosition: 100,
      maxOrderNotional: 5,
      maxAccountNotional: 30,
      quoteLevels: 1,
      levelSpacingTicks: 1,
    },
  );
  assert.deepEqual(
    quotes.map((quote) => quote.price),
    [0.48, 0.21],
  );
});

test("top-of-book mode skips a side when queue price exceeds source cap", () => {
  const market: ResolvedMarket = {
    slug: "event",
    conditionId: "condition",
    outcomes: ["A", "B"],
    tokenIds: ["a", "b"],
    tickSize: 0.01,
    minOrderSize: 5,
    acceptingOrders: true,
    closed: false,
    feesEnabled: false,
  };
  const books = new Map<string, TokenBook>([
    [
      "a",
      {
        tokenId: "a",
        bids: [{ price: 0.52, size: 10 }],
        asks: [{ price: 0.55, size: 10 }],
        receivedAt: 1,
      },
    ],
    [
      "b",
      {
        tokenId: "b",
        bids: [{ price: 0.2, size: 10 }],
        asks: [{ price: 0.3, size: 10 }],
        receivedAt: 1,
      },
    ],
  ]);
  const quotes = generateTopOfBookBuyQuotes(
    market,
    new Map([
      ["A", 0.6],
      ["B", 0.4],
    ]),
    books,
    { byToken: new Map(), cash: 100 },
    {
      targetReturnRate: 0.8,
      minEdge: 0.02,
      orderNotional: 5,
      maxOutcomePosition: 100,
      maxOrderNotional: 5,
      maxAccountNotional: 30,
      quoteLevels: 1,
      levelSpacingTicks: 1,
    },
  );
  assert.deepEqual(
    quotes.map((quote) => quote.outcome),
    ["B"],
  );
});

test("top-of-book skip explains the binding cap on a KPL-like book", () => {
  const edgBook = {
    tokenId: "edg",
    bids: [{ price: 0.6, size: 297.4 }],
    asks: [{ price: 0.67, size: 191.5 }],
    receivedAt: 1,
  };
  const lgdBook = {
    tokenId: "lgd",
    bids: [{ price: 0.33, size: 191.5 }],
    asks: [{ price: 0.4, size: 297.4 }],
    receivedAt: 1,
  };
  assert.match(
    describeTopOfBookSkip(0.637, 0.363, edgBook, 0.01, 0.8, 0.025) ?? "",
    /买一\+1tick 61\.0¢ 超过安全上限/,
  );
  assert.match(
    describeTopOfBookSkip(0.363, 0.637, lgdBook, 0.01, 0.8, 0.025) ?? "",
    /买一\+1tick 34\.0¢ 超过安全上限/,
  );
  assert.equal(describeTopOfBookSkip(0.637, 0.363, edgBook, 0.01, 0.95, 0.025), null);
});

test("batch config atomically forces one-layer top-of-book mappings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "poly-maker-batch-"));
  const path = join(directory, "markets.json");
  try {
    const mappings = await writeBatchMarketConfigs(
      {
        matches: ["one", "two"].map((id) => ({
          sourceMatchId: id,
          polymarketEventSlug: `event-${id}`,
          markets: [
            {
              name: `${id} match winner`,
              enabled: true,
              sourceMarketId: `market-${id}`,
              polymarketSlug: `event-${id}`,
              round: 3,
              outcomes: [
                { sourceOddId: `a-${id}`, outcome: "A" },
                { sourceOddId: `b-${id}`, outcome: "B" },
              ],
              orderNotional: 5,
              quoteLevels: 4,
              levelSpacingTicks: 2,
              targetReturnRate: 0.8,
            },
          ],
        })),
      },
      path,
    );
    assert.equal(mappings.length, 2);
    assert.ok(mappings.every((mapping) => mapping.quoteMode === "top-of-book"));
    assert.ok(mappings.every((mapping) => mapping.quoteLevels === 1 && mapping.round === 3));
    assert.equal(JSON.parse(await readFile(path, "utf8")).length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("league pairing uses both team names and rejects array-order guessing", () => {
  const source = {
    match: {
      matchId: "source",
      teams: ["JLY", "JAG"] as const,
      bestOf: 5,
      score: "0:0",
      tournament: "KGL",
      markets: new Map(),
      initialOdds: [],
      initialStates: [],
    },
    englishTeams: ["JLY", "JA Gaming"] as const,
    startTime: Date.now(),
    status: 5,
    sourceOpen: true,
    tournamentId: "581112559764744",
  };
  const event = {
    slug: "event",
    title: "JA Gaming vs JLY",
    startTime: Date.now(),
    markets: [
      {
        slug: "event",
        conditionId: "condition",
        outcomes: ["JA Gaming", "JLY"] as const,
        tokenIds: ["a", "b"] as const,
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
    ],
  };
  const score = leagueDiscoveryInternals.scorePair(source, event);
  assert.deepEqual(score?.legScores, [3, 3]);
  assert.equal(score?.score, 6);
  assert.deepEqual(score?.mappedOutcomes, ["JLY", "JA Gaming"]);
});
