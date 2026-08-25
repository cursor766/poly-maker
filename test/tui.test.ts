import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { OddsTui } from "../src/tui/odds-tui.js";

test("TUI tracks MQTT connection and incoming odds", () => {
  const tui = new OddsTui(500, 10);
  tui.setConnected(true);
  tui.recordOdds([
    {
      marketId: "market",
      matchId: "match",
      oddId: "home",
      decimalOdd: 1.962,
      returnRate: 94,
      receivedAt: 1_000,
    },
    {
      marketId: "market",
      matchId: "match",
      oddId: "away",
      decimalOdd: 1.804,
      returnRate: 94,
      receivedAt: 1_001,
    },
  ]);

  assert.deepEqual(tui.snapshot(), {
    connected: true,
    messageCount: 2,
    marketCount: 1,
    lastMessageAt: 1_001,
  });
});

test("TUI renders a readable match card from the initial odds snapshot", () => {
  const tui = new OddsTui(500, 10);
  tui.setConnected(true);
  tui.recordMatchMetadata({
    matchId: "5975531956975952",
    teams: ["杭州LGD.NBW", "济南RW侠"],
    bestOf: 5,
    score: "0:0",
    tournament: "KPL 职业联赛 夏季赛",
    markets: new Map([
      [
        "match-winner",
        {
          marketId: "match-winner",
          matchId: "5975531956975952",
          scope: "match",
          round: 0,
          name: "全场胜负",
          outcomes: new Map([
            ["home", "杭州LGD.NBW"],
            ["away", "济南RW侠"],
          ]),
        },
      ],
      [
        "map-handicap",
        {
          marketId: "map-handicap",
          matchId: "5975531956975952",
          scope: "match",
          round: 0,
          name: "地图让分",
          outcomes: new Map([
            ["handicap-home", "杭州LGD.NBW -2.5"],
            ["handicap-away", "济南RW侠 +2.5"],
          ]),
        },
      ],
    ]),
    initialOdds: [
      {
        marketId: "match-winner",
        matchId: "5975531956975952",
        oddId: "home",
        decimalOdd: 2.658,
        returnRate: 95,
        receivedAt: 1_000,
      },
      {
        marketId: "map-handicap",
        matchId: "5975531956975952",
        oddId: "handicap-home",
        decimalOdd: 8.276,
        returnRate: 94.5,
        receivedAt: 1_000,
      },
      {
        marketId: "map-handicap",
        matchId: "5975531956975952",
        oddId: "handicap-away",
        decimalOdd: 1.066,
        returnRate: 94.5,
        receivedAt: 1_000,
      },
      {
        marketId: "match-winner",
        matchId: "5975531956975952",
        oddId: "away",
        decimalOdd: 1.478,
        returnRate: 95,
        receivedAt: 1_000,
      },
    ],
    initialStates: [
      {
        marketId: "match-winner",
        suspended: false,
        visible: true,
        open: true,
        updatedAt: 1_000,
      },
    ],
  });
  tui.recordPolymarketOdds([
    {
      eventSlug: "hok-lgd-rw-2026-07-31",
      marketSlug: "hok-lgd-rw-2026-07-31",
      round: 0,
      outcomes: ["LGD NBW", "Rogue Warriors"],
      prices: [0.4, 0.64],
      bestBids: [0.36, 0.6],
      referencePrices: [0.395, 0.605],
      tradingOpen: true,
      receivedAt: 1_500,
    },
  ]);
  tui.recordError(new Error("internal validation details"));

  const screen = tui.buildScreen(2_000, 120, false);
  assert.match(screen, /POLY MAKER/);
  assert.match(screen, /杭州LGD\.NBW/);
  assert.match(screen, /济南RW侠/);
  assert.match(screen, /全场胜负/);
  assert.match(screen, /2\.658/);
  assert.match(screen, /Polymarket/);
  assert.match(screen, /买40¢/);
  assert.match(screen, /你的模拟卖价/);
  assert.match(screen, /合计 125¢ · 返还 80%/);
  assert.equal(screen.includes("地图让分"), false);
  assert.equal(screen.includes("internal validation details"), false);
  assert.equal(screen.includes("\u001B["), false);
});

test("observe-only TUI configuration loads without Polymarket credentials", () => {
  const config = loadConfig({
    MQTT_USERNAME: "fixture",
    MQTT_PASSWORD: "fixture",
    OBSERVE_ONLY: "true",
    TUI_ENABLED: "true",
    TRADING_MODE: "paper",
  });
  assert.equal(config.OBSERVE_ONLY, true);
  assert.equal(config.TUI_ENABLED, true);
  assert.equal(config.MAKER_TARGET_RETURN_RATE, 0.8);
});

test("observe-only mode rejects live trading configuration", () => {
  assert.throws(() =>
    loadConfig({
      MQTT_USERNAME: "fixture",
      MQTT_PASSWORD: "fixture",
      OBSERVE_ONLY: "true",
      TUI_ENABLED: "true",
      TRADING_MODE: "live",
    }),
  );
});

test("type=3 shadow mode requires Deposit Wallet signature and allowlist", () => {
  const base = {
    MQTT_USERNAME: "fixture",
    MQTT_PASSWORD: "fixture",
    OBSERVE_ONLY: "false",
    TRADING_MODE: "shadow",
    POLYMARKET_B_PRIVATE_KEY: `0x${"1".repeat(64)}`,
    POLYMARKET_B_FUNDER: `0x${"2".repeat(40)}`,
    POLYMARKET_MARKET_ALLOWLIST: "allowed-market",
  };
  assert.equal(loadConfig(base).POLYMARKET_B_SIGNATURE_TYPE, 3);
  assert.throws(() => loadConfig({ ...base, POLYMARKET_B_SIGNATURE_TYPE: "2" }));
  assert.throws(() => loadConfig({ ...base, POLYMARKET_MARKET_ALLOWLIST: "" }));
});

test("live mode requires both explicit acknowledgements", () => {
  assert.throws(() =>
    loadConfig({
      MQTT_USERNAME: "fixture",
      MQTT_PASSWORD: "fixture",
      OBSERVE_ONLY: "false",
      TRADING_MODE: "live",
      POLYMARKET_B_PRIVATE_KEY: `0x${"1".repeat(64)}`,
      POLYMARKET_B_FUNDER: `0x${"2".repeat(40)}`,
      POLYMARKET_MARKET_ALLOWLIST: "allowed-market",
      LIVE_TRADING_ACK: "I_UNDERSTAND_REAL_ORDERS_WILL_BE_PLACED",
    }),
  );
});

test("shadow TUI clearly states that order mutations are disabled", () => {
  const tui = new OddsTui(500, 10, 0.8, "shadow");
  assert.match(tui.buildScreen(1_000, 120, false), /SHADOW {2}· {2}ACCOUNT READ ONLY/);
});
