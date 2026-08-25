import { watch } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { z } from "zod";
import { loadConfig, loadMarketMappings } from "../config.js";
import { createLogger } from "../logger.js";
import { MarketResolver } from "../polymarket/market-resolver.js";
import { PolymarketDataApiClient } from "../polymarket/data-api-client.js";
import { PolymarketOrderBookClient } from "../polymarket/orderbook-client.js";
import { MatchMetadataClient } from "../source/match-metadata-client.js";
import {
  deleteMarketConfig,
  deleteMarketConfigSchema,
  saveBatchMarketConfigSchema,
  saveMarketConfigSchema,
  writeBatchMarketConfigs,
  writeMarketConfig,
} from "./config-writer.js";
import { LeagueDiscoveryService } from "./league-discovery-service.js";
import { listPublicLeagues, requireLeague } from "./league-registry.js";
import { enqueueDeskCommand } from "./desk-commands.js";
import {
  deleteMatchSession,
  listMatchSessions,
  listSavedMatches,
  upsertMatchSession,
} from "./match-sessions.js";
import { PreviewService } from "./preview-service.js";
import { MakerProcessManager } from "./process-manager.js";
import { limitsFromConfig, readRuntimeLimits, writeRuntimeLimits } from "./runtime-overrides.js";
import { SignalMonitorService } from "./signal-monitor-service.js";
import { SseHub } from "./sse.js";

const host = "127.0.0.1";
const port = Number.parseInt(process.env.CONTROL_PORT ?? "48787", 10);
const projectRoot = process.cwd();
const logger = createLogger(process.env.LOG_LEVEL ?? "info");
const config = loadConfig();
if (!config.SOURCE_API_TOKEN) throw new Error("SOURCE_API_TOKEN is required by the control API");

const metadataClient = new MatchMetadataClient(config.SOURCE_API_URL, config.SOURCE_API_TOKEN);
const marketResolver = new MarketResolver(config.GAMMA_API_URL);
const previewService = new PreviewService(
  metadataClient,
  marketResolver,
  config.MAKER_TARGET_RETURN_RATE,
);
const leagueDiscoveryService = new LeagueDiscoveryService(
  metadataClient,
  marketResolver,
  new PolymarketOrderBookClient(config.CLOB_API_URL, config.POLYGON_CHAIN_ID),
  config.MQTT_ORIGIN,
  config.MAKER_TARGET_RETURN_RATE,
  config.MIN_EDGE,
);
const dataApi = new PolymarketDataApiClient();
const processManager = new MakerProcessManager(projectRoot);
const defaultRuntimeLimits = limitsFromConfig(config);
const sse = new SseHub();
const signalSse = new SseHub();
const signalMonitor = new SignalMonitorService(
  config,
  metadataClient,
  marketResolver,
  logger.child({ component: "signal-monitor" }),
);
signalMonitor.onSnapshot((snapshot) => signalSse.publish("snapshot", snapshot));
signalMonitor.onSignal((signal) => signalSse.publish("signal", signal));
const allowedOrigins = new Set([
  "http://127.0.0.1:3000",
  "http://localhost:3000",
  "http://127.0.0.1:3001",
  "http://localhost:3001",
]);

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error("请求体过大");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function readRuntimeStatus(): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(resolve(projectRoot, "data/status.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function controlStatus(): Promise<unknown> {
  const processStatus = await processManager.status();
  return {
    process: processStatus,
    runtime: processStatus.running ? await readRuntimeStatus() : null,
  };
}

async function deskSnapshot(): Promise<{
  markets: Record<
    string,
    {
      conditionId: string;
      trades: Awaited<ReturnType<PolymarketDataApiClient["fetchTrades"]>>;
      holders: Awaited<ReturnType<PolymarketDataApiClient["fetchHolders"]>>;
      error?: string;
    }
  >;
}> {
  const runtime = (await readRuntimeStatus()) as {
    markets?: Array<{
      sourceMarketId?: string;
      conditionId?: string;
      outcomes?: [string, string];
    }>;
  } | null;
  const markets = runtime?.markets ?? [];
  const entries = await Promise.all(
    markets.map(async (market) => {
      const sourceMarketId = market.sourceMarketId ?? "";
      const conditionId = market.conditionId ?? "";
      const outcomes = market.outcomes ?? ["Yes", "No"];
      if (!sourceMarketId || !conditionId) {
        return [
          sourceMarketId,
          { conditionId, trades: [], holders: [], error: "等待核心写入市场 ID" },
        ] as const;
      }
      try {
        const [trades, holders] = await Promise.all([
          dataApi.fetchTrades(conditionId),
          dataApi.fetchHolders(conditionId, outcomes),
        ]);
        return [sourceMarketId, { conditionId, trades, holders }] as const;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return [sourceMarketId, { conditionId, trades: [], holders: [], error: message }] as const;
      }
    }),
  );
  return { markets: Object.fromEntries(entries.filter(([id]) => id)) };
}

const server = createServer(async (request, response) => {
  const origin = request.headers.origin;
  if (origin && !allowedOrigins.has(origin)) {
    sendJson(response, 403, { error: "不允许的请求来源" });
    return;
  }
  if (origin) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "origin");
  }
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  try {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);
    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, {
        ok: true,
        pid: process.pid,
        uptimeSeconds: Math.floor(process.uptime()),
        streamClients: sse.clientCount,
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/stream") {
      sse.add(request, response, await controlStatus());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/preview") {
      const body = z
        .object({ sourceUrl: z.string().min(1), polymarketUrl: z.string().min(1) })
        .parse(await readJson(request));
      sendJson(response, 200, await previewService.preview(body.sourceUrl, body.polymarketUrl));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/leagues") {
      sendJson(response, 200, { leagues: listPublicLeagues() });
      return;
    }
    const leagueDiscover = /^\/api\/leagues\/([^/]+)\/discover$/.exec(url.pathname);
    if (request.method === "GET" && leagueDiscover?.[1]) {
      sendJson(response, 200, await leagueDiscoveryService.discover(leagueDiscover[1]));
      return;
    }
    const leagueConfig = /^\/api\/leagues\/([^/]+)\/config$/.exec(url.pathname);
    if (request.method === "POST" && leagueConfig?.[1]) {
      requireLeague(leagueConfig[1]);
      const body = saveBatchMarketConfigSchema.parse(await readJson(request));
      const mappings = await writeBatchMarketConfigs(body, config.MARKETS_CONFIG_PATH);
      for (const match of body.matches) {
        if (!match.sourceUrl || !match.polymarketUrl) continue;
        await upsertMatchSession({
          sourceMatchId: match.sourceMatchId,
          polymarketEventSlug: match.polymarketEventSlug,
          sourceUrl: match.sourceUrl,
          polymarketUrl: match.polymarketUrl,
          ...(match.teams ? { teams: match.teams } : {}),
          ...(match.tournament ? { tournament: match.tournament } : {}),
        });
      }
      sse.publish("config", { updatedAt: Date.now(), mappings: mappings.length });
      sendJson(response, 200, { mappings });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/config") {
      const body = saveMarketConfigSchema.parse(await readJson(request));
      const mappings = await writeMarketConfig(body, config.MARKETS_CONFIG_PATH);
      if (body.sourceUrl && body.polymarketUrl) {
        await upsertMatchSession({
          sourceMatchId: body.sourceMatchId,
          polymarketEventSlug: body.polymarketEventSlug,
          sourceUrl: body.sourceUrl,
          polymarketUrl: body.polymarketUrl,
          ...(body.teams ? { teams: body.teams } : {}),
          ...(body.tournament ? { tournament: body.tournament } : {}),
        });
      }
      sse.publish("config", { updatedAt: Date.now(), mappings: mappings.length });
      sendJson(response, 200, { mappings });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/markets") {
      const mappings = await loadMarketMappings(config.MARKETS_CONFIG_PATH);
      const sessions = await listMatchSessions();
      sendJson(response, 200, {
        mappings,
        savedMatches: await listSavedMatches(mappings, sessions, config.MQTT_ORIGIN),
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/matches/delete") {
      const body = deleteMarketConfigSchema.parse(await readJson(request));
      const mappings = await deleteMarketConfig(body, config.MARKETS_CONFIG_PATH);
      await deleteMatchSession(body.sourceMatchId, body.polymarketEventSlug);
      sse.publish("config", { updatedAt: Date.now(), mappings: mappings.length });
      sendJson(response, 200, { mappings });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/limits") {
      sendJson(response, 200, await readRuntimeLimits(defaultRuntimeLimits));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/limits") {
      const limits = await writeRuntimeLimits(await readJson(request), defaultRuntimeLimits);
      sse.publish("limits", limits);
      sendJson(response, 200, limits);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/start") {
      const body = z
        .object({
          mode: z.enum(["paper", "shadow", "live"]),
          restart: z.boolean().optional(),
        })
        .parse(await readJson(request));
      if (body.restart) await processManager.stop();
      const mappings = await loadMarketMappings(config.MARKETS_CONFIG_PATH);
      const pid = await processManager.start(body.mode, mappings);
      sse.publish("status", await controlStatus());
      sendJson(response, 202, { running: true, pid, mode: body.mode });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/stop") {
      await processManager.stop();
      sse.publish("status", await controlStatus());
      sendJson(response, 200, { running: false });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/status") {
      sendJson(response, 200, await controlStatus());
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/signal-monitor") {
      sendJson(response, 200, signalMonitor.getSnapshot());
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/signal-monitor/stream") {
      signalSse.add(request, response, signalMonitor.getSnapshot());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/signal-monitor/start") {
      const body = z
        .object({
          sourceMatchId: z.string().min(1).optional(),
          polymarketEventSlug: z.string().min(1).optional(),
          polymarketMarketSlug: z.string().min(1).optional(),
          jumpThreshold: z.number().positive().max(0.5).optional(),
          notionalUsd: z.number().positive().max(5_000).optional(),
          maxSlippage: z.number().positive().max(0.2).optional(),
          cooldownMs: z.number().int().positive().max(60_000).optional(),
        })
        .parse(await readJson(request));
      const options = Object.fromEntries(
        Object.entries(body).filter(([, value]) => value !== undefined),
      );
      const snapshot = await signalMonitor.start(options);
      signalSse.publish("snapshot", snapshot);
      sendJson(response, 200, snapshot);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/signal-monitor/stop") {
      const snapshot = await signalMonitor.stop();
      signalSse.publish("snapshot", snapshot);
      sendJson(response, 200, snapshot);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/desk") {
      sendJson(response, 200, await deskSnapshot());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/desk/command") {
      const running = await processManager.status();
      if (!running.running) throw new Error("交易核心未运行，无法暂停或撤单");
      const body = z
        .object({
          action: z.enum(["pause", "resume", "cancel"]),
          sourceMarketId: z.string().min(1),
          orderIds: z.array(z.string().min(1)).optional(),
        })
        .parse(await readJson(request));
      const command = await enqueueDeskCommand(body);
      sendJson(response, 202, { command });
      return;
    }
    sendJson(response, 404, { error: "接口不存在" });
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? error.issues.map((issue) => issue.message).join("; ")
        : error instanceof Error
          ? error.message
          : String(error);
    logger.warn({ error: message }, "control API request failed");
    sendJson(response, 400, { error: message });
  }
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "control API shutdown requested");
  await processManager.stop().catch((error) => {
    logger.error({ error }, "maker process shutdown failed");
  });
  statusWatcher.close();
  await signalMonitor.stop().catch(() => undefined);
  signalSse.close();
  sse.close();
  server.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
await mkdir(resolve(projectRoot, "data"), { recursive: true });
const statusWatcher = watch(resolve(projectRoot, "data"), (_event, filename) => {
  if (filename?.toString() !== "status.json") return;
  void controlStatus()
    .then((status) => sse.publish("status", status))
    .catch((error) => logger.warn({ error }, "status stream update failed"));
});
server.on("error", (error) => {
  logger.fatal(
    { error, host, port },
    `control API failed to listen; set CONTROL_PORT if ${host}:${port} is occupied`,
  );
  process.exitCode = 1;
});
server.listen(port, host, () => {
  logger.info({ url: `http://${host}:${port}` }, "maker control API started");
});
