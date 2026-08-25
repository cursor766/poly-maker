import "dotenv/config";

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { MarketMapping } from "./types.js";

const booleanFromString = z
  .string()
  .default("false")
  .transform((value) => value.toLowerCase() === "true");

const csvFromString = z
  .string()
  .default("")
  .transform((value) =>
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );

const envSchema = z
  .object({
    MQTT_URL: z.url().default("wss://47.242.169.89:8084/mqtt"),
    MQTT_ORIGIN: z.url().default("https://dy02txh5ba01.cdyifutang.com"),
    MQTT_USERNAME: z.string().min(1),
    MQTT_PASSWORD: z.string().min(1),
    MQTT_CLIENT_ID_PREFIX: z.string().default("poly-maker"),
    MQTT_KEEPALIVE_SECONDS: z.coerce.number().int().positive().default(30),
    MQTT_RECONNECT_MIN_MS: z.coerce.number().int().positive().default(1_000),
    MQTT_RECONNECT_MAX_MS: z.coerce.number().int().positive().default(30_000),
    SOURCE_API_URL: z.url().default("https://dy02awsai4.a8f6er.com:8105"),
    SOURCE_API_TOKEN: z.string().min(1).optional(),
    SOURCE_MATCH_IDS: csvFromString,
    MARKETS_CONFIG_PATH: z.string().default("config/markets.json"),
    DISCOVERY_MODE: booleanFromString,
    OBSERVE_ONLY: booleanFromString,
    TUI_ENABLED: booleanFromString,
    TUI_REFRESH_MS: z.coerce.number().int().min(100).default(500),
    TUI_MAX_MARKETS: z.coerce.number().int().positive().max(100).default(10),
    MAKER_TARGET_RETURN_RATE: z.coerce.number().positive().max(0.99).default(0.8),
    TRADING_MODE: z.enum(["paper", "shadow", "live"]).default("paper"),
    LOG_LEVEL: z.string().default("info"),
    AUDIT_LOG_PATH: z.string().default("data/audit.ndjson"),
    GAMMA_API_URL: z.url().default("https://gamma-api.polymarket.com"),
    CLOB_API_URL: z.url().default("https://clob.polymarket.com"),
    POLYMARKET_WS_URL: z.url().default("wss://ws-subscriptions-clob.polymarket.com/ws/market"),
    POLYGON_CHAIN_ID: z.coerce.number().int().default(137),
    ODDS_STALE_MS: z.coerce.number().int().positive().default(30_000),
    REPRICE_THRESHOLD_TICKS: z.coerce.number().int().positive().default(2),
    MAX_ODDS_JUMP: z.coerce.number().positive().max(1).default(0.15),
    MAX_OVERROUND: z.coerce.number().min(1).max(3).default(1.25),
    MIN_EDGE: z.coerce.number().min(0).max(1).default(0.02),
    QUOTE_HALF_SPREAD: z.coerce.number().positive().max(0.5).default(0.03),
    INVENTORY_SKEW: z.coerce.number().min(0).max(0.1).default(0.002),
    ORDER_SIZE: z.coerce.number().positive().default(5),
    ORDER_NOTIONAL: z.coerce.number().positive().default(5),
    QUOTE_LEVELS: z.coerce.number().int().positive().max(10).default(3),
    QUOTE_LEVEL_SPACING_TICKS: z.coerce.number().int().positive().default(2),
    MAX_OUTCOME_POSITION: z.coerce.number().positive().default(2000),
    MAX_TOTAL_EXPOSURE: z.coerce.number().positive().default(2000),
    MAX_ORDER_NOTIONAL: z.coerce.number().positive().default(300),
    MAX_ACCOUNT_NOTIONAL: z.coerce.number().positive().default(400),
    MAX_GAME_NOTIONAL: z.coerce.number().positive().default(300),
    MAX_MAP_NOTIONAL: z.coerce.number().positive().default(200),
    REFILL_TOP_DELAY_MS: z.coerce.number().int().nonnegative().default(10_000),
    BAIT_POSITION_RATIO: z.coerce.number().positive().max(1).default(0.6),
    REFRESH_MS: z.coerce.number().int().positive().default(500),
    LIVE_TRADING_ACK: z.string().optional(),
    LIVE_TRADING_ACK_2: z.string().optional(),
    POLYMARKET_MARKET_ALLOWLIST: csvFromString,
    CONTROL_MANAGED_HOT_RELOAD: booleanFromString,
    POLYMARKET_B_PRIVATE_KEY: z
      .string()
      .regex(/^(?:0x)?[0-9a-fA-F]{64}$/)
      .optional(),
    POLYMARKET_B_FUNDER: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .optional(),
    POLYMARKET_B_SIGNATURE_TYPE: z.coerce.number().int().default(3),
    POLYMARKET_SETUP_APPROVALS: booleanFromString,
    HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1_000).max(8_000).default(5_000),
    HEARTBEAT_MAX_FAILURES: z.coerce.number().int().positive().default(2),
    ACCOUNT_SYNC_MS: z.coerce.number().int().min(1_000).default(10_000),
    CANCEL_CONFIRM_RETRIES: z.coerce.number().int().positive().max(10).default(3),
    CANCEL_CONFIRM_DELAY_MS: z.coerce.number().int().positive().default(250),
  })
  .superRefine((env, context) => {
    if (env.MQTT_RECONNECT_MAX_MS < env.MQTT_RECONNECT_MIN_MS) {
      context.addIssue({
        code: "custom",
        path: ["MQTT_RECONNECT_MAX_MS"],
        message: "must be greater than or equal to MQTT_RECONNECT_MIN_MS",
      });
    }
    if (env.OBSERVE_ONLY && env.TRADING_MODE === "live") {
      context.addIssue({
        code: "custom",
        path: ["TRADING_MODE"],
        message: "observe-only mode cannot use live trading mode",
      });
    }
    if (env.TRADING_MODE !== "paper") {
      const required = ["POLYMARKET_B_PRIVATE_KEY", "POLYMARKET_B_FUNDER"] as const;
      if (env.POLYGON_CHAIN_ID !== 137) {
        context.addIssue({
          code: "custom",
          path: ["POLYGON_CHAIN_ID"],
          message: "type=3 trading requires Polygon chain 137",
        });
      }
      if (env.POLYMARKET_B_SIGNATURE_TYPE !== 3) {
        context.addIssue({
          code: "custom",
          path: ["POLYMARKET_B_SIGNATURE_TYPE"],
          message: "Deposit Wallet trading requires signature type 3",
        });
      }
      if (env.POLYMARKET_MARKET_ALLOWLIST.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["POLYMARKET_MARKET_ALLOWLIST"],
          message: "shadow/live mode requires an explicit market slug allowlist",
        });
      }
      for (const key of required) {
        if (!env[key]) {
          context.addIssue({
            code: "custom",
            path: [key],
            message: "required in shadow/live mode",
          });
        }
      }
    }
    if (env.TRADING_MODE === "live") {
      if (env.LIVE_TRADING_ACK !== "I_UNDERSTAND_REAL_ORDERS_WILL_BE_PLACED") {
        context.addIssue({
          code: "custom",
          path: ["LIVE_TRADING_ACK"],
          message: "explicit live-trading acknowledgement is required",
        });
      }
      if (env.LIVE_TRADING_ACK_2 !== "ENABLE_TYPE3_LIVE_FOR_ALLOWLIST_ONLY") {
        context.addIssue({
          code: "custom",
          path: ["LIVE_TRADING_ACK_2"],
          message: "second type=3 live-trading acknowledgement is required",
        });
      }
    }
  });

const outcomeMappingSchema = z.object({
  sourceOddId: z.string().min(1),
  outcome: z.string().min(1),
});

const marketMappingSchema = z
  .object({
    name: z.string().min(1),
    enabled: z.boolean(),
    sourceMatchId: z.string(),
    sourceMarketId: z.string().min(1),
    polymarketEventSlug: z.string().min(1).optional(),
    polymarketSlug: z.string().min(1),
    outcomes: z.array(outcomeMappingSchema),
    round: z.number().int().min(0).max(7).optional(),
    quoteMode: z.enum(["two-sided", "complement-buy", "top-of-book"]).optional(),
    kind: z.enum(["moneyline", "child_moneyline", "map_handicap", "totals"]).optional(),
    orderNotional: z.number().positive().optional(),
    quoteLevels: z.number().int().positive().max(10).optional(),
    levelSpacingTicks: z.number().int().positive().optional(),
    targetReturnRate: z.number().positive().max(0.99).optional(),
  })
  .superRefine((mapping, context) => {
    if (mapping.enabled && mapping.outcomes.length !== 2) {
      context.addIssue({
        code: "custom",
        path: ["outcomes"],
        message: "enabled binary markets require exactly two outcome mappings",
      });
    }
    if (mapping.enabled && !mapping.sourceMatchId) {
      context.addIssue({
        code: "custom",
        path: ["sourceMatchId"],
        message: "enabled mappings require sourceMatchId",
      });
    }
  });

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  return envSchema.parse(environment);
}

export async function loadMarketMappings(path: string): Promise<MarketMapping[]> {
  const contents = await readFile(resolve(path), "utf8");
  return z.array(marketMappingSchema).parse(JSON.parse(contents));
}
