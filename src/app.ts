import { type FSWatcher, watch } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { Logger } from "pino";
import { type AppConfig, loadMarketMappings } from "./config.js";
import type { QuoteExecutor } from "./execution/executor.js";
import { LiveExecutor, TradingOperationQueue } from "./execution/live-executor.js";
import { PaperExecutor } from "./execution/paper-executor.js";
import { AuditLog } from "./logger.js";
import { OddsBook } from "./odds/odds-book.js";
import { mapFairProbabilities } from "./odds/outcome-mapper.js";
import { MarketResolver } from "./polymarket/market-resolver.js";
import { PolymarketOddsClient } from "./polymarket/odds-client.js";
import { PolymarketOddsFeed } from "./polymarket/odds-feed.js";
import { PolymarketOrderBookClient } from "./polymarket/orderbook-client.js";
import { PolymarketTradingClient } from "./polymarket/trading-client.js";
import { TradingSupervisor } from "./polymarket/trading-supervisor.js";
import { RiskEngine } from "./risk/risk-engine.js";
import { MatchMetadataClient } from "./source/match-metadata-client.js";
import { MqttOddsFeed } from "./source/mqtt-client.js";
import {
  generateComplementBuyQuotes,
  generateMakerQuotes,
  generateTopOfBookBuyQuotes,
} from "./strategy/maker.js";
import { OddsTui } from "./tui/odds-tui.js";
import type {
  FairSnapshot,
  MarketMapping,
  PositionState,
  Quote,
  ResolvedMarket,
  SourceMarketState,
  SourceOddUpdate,
  TokenBook,
} from "./types.js";
import {
  limitsFromConfig,
  type RuntimeLimits,
  readRuntimeLimits,
} from "./web/runtime-overrides.js";
import { type MakerRuntimeStatus, StatusReporter } from "./web/status-reporter.js";

interface MarketRuntime {
  mapping: MarketMapping;
  market: ResolvedMarket;
  executor: QuoteExecutor;
  risk: RiskEngine;
  lockEpoch: number;
  requiresSourceReopen: boolean;
  protection: Promise<void> | undefined;
}

export class MakerApp {
  private readonly audit: AuditLog;
  private readonly oddsBook: OddsBook;
  private readonly mqtt: MqttOddsFeed;
  private readonly resolver: MarketResolver | undefined;
  private readonly orderBooks: PolymarketOrderBookClient | undefined;
  private readonly polymarketOddsFeed: PolymarketOddsFeed | undefined;
  private readonly tui: OddsTui | undefined;
  private readonly matchMetadataClient: MatchMetadataClient | undefined;
  private readonly metadataLoadedAt = new Map<string, number>();
  private readonly metadataPending = new Set<string>();
  private readonly latestFair = new Map<string, FairSnapshot>();
  private readonly sourceStates = new Map<string, SourceMarketState>();
  private readonly polymarketFreshAt = new Map<number, number>();
  private readonly runtimes: MarketRuntime[] = [];
  private readonly plannedQuotes = new Map<string, Quote[]>();
  private readonly lockReasons = new Map<string, string>();
  private readonly rejectDetails = new Map<string, string>();
  private readonly startedAt = Date.now();
  private readonly statusReporter: StatusReporter;
  private readonly sharedPositions: PositionState = { byToken: new Map(), cash: 0 };
  private readonly tradingOperationQueue = new TradingOperationQueue();
  private readonly allConditionIds: string[] = [];
  private readonly runtimeLimits: RuntimeLimits;
  private readonly configWatchers: FSWatcher[] = [];
  private reloadTimer: NodeJS.Timeout | undefined;
  private reloadSerial: Promise<void> = Promise.resolve();
  private tradingClient: PolymarketTradingClient | undefined;
  private tradingSupervisor: TradingSupervisor | undefined;
  private timer: NodeJS.Timeout | undefined;
  private evaluating = false;
  private mqttConnected = false;
  private polymarketConnected = false;

  constructor(
    private readonly config: AppConfig,
    mappings: MarketMapping[],
    private readonly logger: Logger,
  ) {
    this.mappings = [...mappings];
    this.runtimeLimits = limitsFromConfig(config);
    this.audit = new AuditLog(config.AUDIT_LOG_PATH);
    this.oddsBook = new OddsBook(mappings, config.MAX_ODDS_JUMP, config.MAX_OVERROUND);
    this.mqtt = new MqttOddsFeed(config, mappings, logger);
    this.resolver = config.OBSERVE_ONLY ? undefined : new MarketResolver(config.GAMMA_API_URL);
    this.orderBooks = config.OBSERVE_ONLY
      ? undefined
      : new PolymarketOrderBookClient(config.CLOB_API_URL, config.POLYGON_CHAIN_ID);
    this.polymarketOddsFeed =
      config.TUI_ENABLED || !config.OBSERVE_ONLY
        ? new PolymarketOddsFeed(
            new PolymarketOddsClient(config.GAMMA_API_URL, config.CLOB_API_URL),
            config.POLYMARKET_WS_URL,
          )
        : undefined;
    this.tui = config.TUI_ENABLED
      ? new OddsTui(
          config.TUI_REFRESH_MS,
          config.TUI_MAX_MARKETS,
          config.MAKER_TARGET_RETURN_RATE,
          config.TRADING_MODE,
        )
      : undefined;
    this.matchMetadataClient = config.SOURCE_API_TOKEN
      ? new MatchMetadataClient(config.SOURCE_API_URL, config.SOURCE_API_TOKEN)
      : undefined;
    this.statusReporter = new StatusReporter("data/status.json", () => this.statusSnapshot());
  }

  private mappings: MarketMapping[];

  async start(): Promise<void> {
    Object.assign(
      this.runtimeLimits,
      await readRuntimeLimits(this.runtimeLimits).catch((error) => {
        this.logger.warn({ error }, "runtime overrides ignored");
        return this.runtimeLimits;
      }),
    );
    const activeMappings = this.activeMappings(this.mappings);
    if (this.config.TRADING_MODE !== "paper" && activeMappings.length > 0) {
      const privateKey = this.config.POLYMARKET_B_PRIVATE_KEY;
      const funder = this.config.POLYMARKET_B_FUNDER;
      if (!privateKey || !funder) throw new Error("missing type=3 wallet configuration");
      this.tradingClient = await PolymarketTradingClient.create({
        privateKey,
        funder,
        chainId: this.config.POLYGON_CHAIN_ID,
        clobUrl: this.config.CLOB_API_URL,
        audit: this.audit,
        setupApprovals: this.config.POLYMARKET_SETUP_APPROVALS,
      });
    }
    for (const mapping of activeMappings) this.runtimes.push(await this.buildRuntime(mapping));

    if (!this.config.OBSERVE_ONLY && !this.config.DISCOVERY_MODE && this.runtimes.length === 0) {
      throw new Error("no enabled market mapping; enable discovery mode or configure a market");
    }

    this.bindFeedEvents();
    this.tui?.start();
    this.polymarketOddsFeed?.start([
      ...new Set(
        this.mappings.map((mapping) => mapping.polymarketEventSlug ?? mapping.polymarketSlug),
      ),
    ]);
    const initialMatchIds =
      this.config.SOURCE_MATCH_IDS.length > 0
        ? this.config.SOURCE_MATCH_IDS
        : this.mappings.map((mapping) => mapping.sourceMatchId);
    for (const matchId of initialMatchIds) {
      void this.ensureMatchMetadata(matchId);
    }
    this.mqtt.start();
    if (this.tradingClient) {
      this.tradingSupervisor = new TradingSupervisor(
        this.tradingClient,
        this.audit,
        {
          heartbeatIntervalMs: this.config.HEARTBEAT_INTERVAL_MS,
          heartbeatMaxFailures: this.config.HEARTBEAT_MAX_FAILURES,
          accountSyncMs: this.config.ACCOUNT_SYNC_MS,
        },
        (reason) => this.protectAll(reason),
        async () => {
          const executor = this.runtimes[0]?.executor;
          if (executor) await executor.syncAccount();
        },
      );
      await this.tradingSupervisor.start();
    }
    if (!this.config.OBSERVE_ONLY) {
      this.timer = setInterval(() => void this.evaluateAll(), this.config.REFRESH_MS);
    }
    this.logger.info(
      {
        mode: this.config.TRADING_MODE,
        observeOnly: this.config.OBSERVE_ONLY,
        discovery: this.config.DISCOVERY_MODE,
        activeMarkets: this.runtimes.length,
      },
      "maker application started",
    );
    this.statusReporter.start();
    this.startConfigWatchers();
  }

  async stop(reason = "shutdown"): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = undefined;
    for (const watcher of this.configWatchers) watcher.close();
    this.configWatchers.length = 0;
    await this.protectAll(reason);
    await this.statusReporter.stop();
    await this.tradingSupervisor?.stop();
    this.polymarketOddsFeed?.stop();
    this.mqtt.stop();
    this.tui?.stop();
    await this.tradingClient?.close();
    await this.audit.write("shutdown", { reason });
  }

  private activeMappings(mappings: readonly MarketMapping[]): MarketMapping[] {
    return mappings.filter(
      (item) =>
        item.enabled &&
        !this.config.OBSERVE_ONLY &&
        (this.config.TRADING_MODE === "paper" ||
          this.config.CONTROL_MANAGED_HOT_RELOAD ||
          this.config.POLYMARKET_MARKET_ALLOWLIST.includes(item.polymarketSlug)),
    );
  }

  private async buildRuntime(mapping: MarketMapping): Promise<MarketRuntime> {
    if (!this.resolver) throw new Error("Polymarket resolver is disabled");
    const market = await this.resolver.resolveMoneyline(
      mapping.polymarketEventSlug ?? mapping.polymarketSlug,
      mapping.polymarketSlug,
    );
    mapFairProbabilities(mapping, market, {
      sourceMarketId: mapping.sourceMarketId,
      probabilities: new Map(mapping.outcomes.map((item) => [item.sourceOddId, 0.5])),
      overround: 1,
      receivedAt: Date.now(),
    });
    if (!this.allConditionIds.includes(market.conditionId)) {
      this.allConditionIds.push(market.conditionId);
    }
    const limits = this.runtimeLimits;
    const config = this.config;
    const executor =
      this.config.TRADING_MODE === "paper"
        ? new PaperExecutor(this.audit)
        : new LiveExecutor(
            this.tradingClient as PolymarketTradingClient,
            this.audit,
            {
              mode: this.config.TRADING_MODE,
              conditionId: market.conditionId,
              tokenIds: market.tokenIds,
              allConditionIds: this.allConditionIds,
              get maxOrderNotional() {
                return limits.maxOrderNotional;
              },
              get maxAccountNotional() {
                return limits.maxAccountNotional;
              },
              cancelConfirmRetries: config.CANCEL_CONFIRM_RETRIES,
              cancelConfirmDelayMs: config.CANCEL_CONFIRM_DELAY_MS,
              get repriceThresholdTicks() {
                return limits.repriceThresholdTicks;
              },
            },
            this.sharedPositions,
            this.tradingOperationQueue,
          );
    await executor.lock("startup-safety-lock");
    await executor.initialize();
    this.logger.info(
      { slug: market.slug, outcomes: market.outcomes },
      "Polymarket moneyline resolved",
    );
    return {
      mapping,
      market,
      executor,
      risk: new RiskEngine(this.runtimeLimits),
      lockEpoch: Date.now(),
      requiresSourceReopen: false,
      protection: undefined,
    };
  }

  async reloadMappings(nextMappings: MarketMapping[]): Promise<void> {
    this.reloadSerial = this.reloadSerial.then(async () => {
      while (this.evaluating) await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      const next = [...nextMappings];
      const nextActive = this.activeMappings(next);
      const key = (mapping: MarketMapping) => `${mapping.sourceMarketId}:${mapping.polymarketSlug}`;
      const wanted = new Map(nextActive.map((mapping) => [key(mapping), mapping]));

      for (let index = this.runtimes.length - 1; index >= 0; index -= 1) {
        const runtime = this.runtimes[index];
        if (!runtime || wanted.has(key(runtime.mapping))) continue;
        await runtime.executor.lock("config-market-disabled");
        this.runtimes.splice(index, 1);
        this.plannedQuotes.delete(runtime.mapping.sourceMarketId);
        this.lockReasons.delete(runtime.mapping.sourceMarketId);
        this.rejectDetails.delete(runtime.mapping.sourceMarketId);
      }

      for (const mapping of nextActive) {
        const existing = this.runtimes.find((runtime) => key(runtime.mapping) === key(mapping));
        if (!existing) {
          try {
            this.runtimes.push(await this.buildRuntime(mapping));
          } catch (error) {
            this.logger.error({ error, slug: mapping.polymarketSlug }, "hot-add market failed");
          }
          continue;
        }
        const outcomesChanged =
          JSON.stringify(existing.mapping.outcomes) !== JSON.stringify(mapping.outcomes);
        if (outcomesChanged) {
          await this.protectRuntime(existing, "config-outcome-mapping-changed");
          this.latestFair.delete(mapping.sourceMarketId);
        }
        existing.mapping = mapping;
      }

      this.mappings = next;
      this.oddsBook.replaceMappings(next);
      this.mqtt.updateMappings(next);
      this.polymarketOddsFeed?.updateSubscriptions(
        next.map((mapping) => mapping.polymarketEventSlug ?? mapping.polymarketSlug),
      );
      this.allConditionIds.splice(
        0,
        this.allConditionIds.length,
        ...new Set(this.runtimes.map((runtime) => runtime.market.conditionId)),
      );
      for (const matchId of new Set(nextActive.map((mapping) => mapping.sourceMatchId))) {
        this.metadataLoadedAt.delete(matchId);
        void this.ensureMatchMetadata(matchId);
      }
      await this.audit.write("config_hot_reloaded", {
        configuredMarkets: next.length,
        activeMarkets: this.runtimes.length,
      });
    });
    return this.reloadSerial;
  }

  private startConfigWatchers(): void {
    const watched = [
      {
        path: resolve(this.config.MARKETS_CONFIG_PATH),
        reload: async () =>
          this.reloadMappings(await loadMarketMappings(this.config.MARKETS_CONFIG_PATH)),
      },
      {
        path: resolve("data/runtime-overrides.json"),
        reload: async () => {
          Object.assign(this.runtimeLimits, await readRuntimeLimits(limitsFromConfig(this.config)));
          await this.audit.write("runtime_limits_hot_reloaded", this.runtimeLimits);
        },
      },
    ];
    for (const item of watched) {
      const targetName = basename(item.path);
      const watcher = watch(dirname(item.path), (_event, filename) => {
        if (filename && filename.toString() !== targetName) return;
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => {
          void item.reload().catch((error) => {
            this.logger.error({ error, path: item.path }, "hot reload failed");
          });
        }, 300);
      });
      this.configWatchers.push(watcher);
    }
  }

  private bindFeedEvents(): void {
    this.polymarketOddsFeed?.on("odds", (snapshots) => {
      this.tui?.recordPolymarketOdds(snapshots);
      for (const snapshot of snapshots) {
        if (snapshot.tradingOpen) this.polymarketFreshAt.set(snapshot.round, snapshot.receivedAt);
        if (snapshot.tradingOpen) continue;
        for (const runtime of this.runtimes.filter(
          (item) => (item.mapping.round ?? 0) === snapshot.round,
        )) {
          void this.protectRuntime(runtime, "polymarket-market-locked");
        }
      }
    });
    this.polymarketOddsFeed?.on("connected", () => {
      this.polymarketConnected = true;
    });
    this.polymarketOddsFeed?.on("disconnected", () => {
      this.polymarketConnected = false;
      void this.protectAll("polymarket-ws-disconnected");
    });
    this.polymarketOddsFeed?.on("error", (error) => {
      this.logger.warn({ error: error.message }, "Polymarket WebSocket feed error");
    });
    this.mqtt.on("connected", () => {
      this.mqttConnected = true;
      this.tui?.setConnected(true);
    });
    this.mqtt.on("disconnected", () => {
      this.mqttConnected = false;
      this.tui?.setConnected(false);
      void this.protectAll("mqtt-disconnected");
    });
    this.mqtt.on("state", (states) => {
      for (const state of states) this.sourceStates.set(state.marketId, state);
      this.tui?.recordStates(states);
      const lockedMarketIds = new Set(
        states
          .filter((state) => state.suspended || !state.visible || !state.open)
          .map((state) => state.marketId),
      );
      if (lockedMarketIds.size > 0) {
        for (const runtime of this.runtimes.filter((item) =>
          lockedMarketIds.has(item.mapping.sourceMarketId),
        )) {
          void this.protectRuntime(runtime, "source-market-locked");
        }
      }
    });
    this.mqtt.on("odds", (updates) => {
      const filteredUpdates =
        this.mappings.length === 0
          ? updates
          : updates.filter((update) =>
              this.mappings.some((mapping) => mapping.sourceMatchId === update.matchId),
            );
      if (filteredUpdates.length === 0) return;

      this.tui?.recordOdds(filteredUpdates);
      for (const matchId of new Set(filteredUpdates.map((update) => update.matchId))) {
        void this.ensureMatchMetadata(matchId);
      }
      if (this.config.DISCOVERY_MODE && !this.config.TUI_ENABLED) {
        for (const update of filteredUpdates) {
          this.logger.info(
            {
              marketId: update.marketId,
              matchId: update.matchId,
              oddId: update.oddId,
              odd: update.decimalOdd,
            },
            "odds discovery",
          );
        }
      }
      this.applySourceOdds(filteredUpdates);
    });
    this.mqtt.on("discovery", (message) => {
      if (this.config.DISCOVERY_MODE) {
        this.logger.debug({ topic: message.topic, payload: message.payload }, "MQTT discovery");
      }
    });
    this.mqtt.on("error", (error) => {
      this.tui?.recordError(error);
    });
  }

  private applySourceOdds(updates: readonly SourceOddUpdate[]): void {
    const result = this.oddsBook.apply(updates);
    for (const snapshot of result.snapshots) {
      this.latestFair.set(snapshot.sourceMarketId, snapshot);
      void this.audit.write("fair_odds", {
        sourceMarketId: snapshot.sourceMarketId,
        overround: snapshot.overround,
        probabilities: Object.fromEntries(snapshot.probabilities),
      });
    }
    for (const rejection of result.rejected) {
      this.logger.warn(
        {
          marketId: rejection.update.marketId,
          oddId: rejection.update.oddId,
          reason: rejection.reason,
        },
        "odds update rejected",
      );
    }
  }

  private async ensureMatchMetadata(matchId: string): Promise<void> {
    const refreshIntervalMs = Math.min(10_000, Math.floor(this.runtimeLimits.oddsStaleMs / 2));
    const lastLoadedAt = this.metadataLoadedAt.get(matchId) ?? 0;
    if (
      !this.matchMetadataClient ||
      Date.now() - lastLoadedAt < refreshIntervalMs ||
      this.metadataPending.has(matchId)
    ) {
      return;
    }
    this.metadataPending.add(matchId);
    try {
      const metadata = await this.matchMetadataClient.fetchMatch(matchId);
      this.metadataLoadedAt.set(matchId, Date.now());
      for (const state of metadata.initialStates) this.sourceStates.set(state.marketId, state);
      this.tui?.recordMatchMetadata(metadata);
      this.tui?.recordOdds(metadata.initialOdds);
      this.applySourceOdds(metadata.initialOdds);
      this.logger.debug(
        { matchId, markets: metadata.markets.size },
        "source match metadata loaded",
      );
    } catch (error) {
      const parsed = error instanceof Error ? error : new Error(String(error));
      this.logger.warn({ matchId, error: parsed.message }, "source match metadata failed");
      this.tui?.recordError(parsed);
    } finally {
      this.metadataPending.delete(matchId);
    }
  }

  private async evaluateAll(): Promise<void> {
    if (this.evaluating || this.runtimes.length === 0) return;
    for (const matchId of new Set(this.runtimes.map((runtime) => runtime.mapping.sourceMatchId))) {
      void this.ensureMatchMetadata(matchId);
    }
    this.evaluating = true;
    try {
      await Promise.all(this.runtimes.map((runtime) => this.evaluate(runtime)));
    } finally {
      this.evaluating = false;
    }
  }

  private async evaluate(runtime: MarketRuntime): Promise<void> {
    if (this.config.OBSERVE_ONLY || !this.orderBooks) return;
    let books: ReadonlyMap<string, TokenBook>;
    try {
      books = await this.orderBooks.fetchBooks(runtime.market);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ error: message, slug: runtime.market.slug }, "order book fetch failed");
      this.rejectDetails.set(runtime.mapping.sourceMarketId, message);
      await this.protectRuntime(runtime, "polymarket-book-error", false);
      return;
    }

    const fair = this.latestFair.get(runtime.mapping.sourceMarketId);
    if (runtime.executor.locked && fair && this.canUnlock(runtime, fair, books)) {
      runtime.executor.unlock();
      runtime.requiresSourceReopen = false;
      this.lockReasons.delete(runtime.mapping.sourceMarketId);
      this.tui?.recordExecutionState(runtime.mapping.round ?? 0, false);
      await this.audit.write("lock_barrier_released", {
        sourceMarketId: runtime.mapping.sourceMarketId,
        conditionId: runtime.market.conditionId,
        lockEpoch: runtime.lockEpoch,
        fairReceivedAt: fair.receivedAt,
      });
    }
    const decision = runtime.risk.evaluate({
      now: Date.now(),
      mqttConnected: this.mqttConnected,
      polymarketConnected: this.polymarketConnected,
      locked: runtime.executor.locked,
      minFairReceivedAt: runtime.lockEpoch,
      requireSourceState: true,
      fair,
      sourceState: this.sourceStates.get(runtime.mapping.sourceMarketId),
      market: runtime.market,
      books,
      positions: runtime.executor.positions,
    });
    if (!decision.allowed || !fair) {
      if (decision.reason && decision.reason !== "lock-barrier-active") {
        this.rejectDetails.set(runtime.mapping.sourceMarketId, decision.reason);
      }
      await this.protectRuntime(runtime, decision.reason ?? "risk-rejected", false);
      return;
    }

    try {
      const fairByOutcome = mapFairProbabilities(runtime.mapping, runtime.market, fair);
      const complementParameters = {
        targetReturnRate:
          runtime.mapping.targetReturnRate ?? this.runtimeLimits.makerTargetReturnRate,
        orderNotional: runtime.mapping.orderNotional ?? this.config.ORDER_NOTIONAL,
        maxOutcomePosition: this.runtimeLimits.maxOutcomePosition,
        maxOrderNotional: this.runtimeLimits.maxOrderNotional,
        maxAccountNotional: this.runtimeLimits.maxAccountNotional,
        quoteLevels: runtime.mapping.quoteLevels ?? this.config.QUOTE_LEVELS,
        levelSpacingTicks:
          runtime.mapping.levelSpacingTicks ?? this.config.QUOTE_LEVEL_SPACING_TICKS,
      };
      const quotes =
        runtime.mapping.quoteMode === "top-of-book"
          ? generateTopOfBookBuyQuotes(
              runtime.market,
              fairByOutcome,
              books,
              runtime.executor.positions,
              {
                ...complementParameters,
                minEdge: this.config.MIN_EDGE + (runtime.market.feesEnabled ? 0.005 : 0),
              },
            )
          : runtime.mapping.quoteMode === "complement-buy" || this.config.TRADING_MODE !== "paper"
            ? generateComplementBuyQuotes(
                runtime.market,
                fairByOutcome,
                books,
                runtime.executor.positions,
                complementParameters,
              )
            : generateMakerQuotes(
                runtime.market,
                fairByOutcome,
                books,
                runtime.executor.positions,
                {
                  minEdge: this.config.MIN_EDGE + (runtime.market.feesEnabled ? 0.005 : 0),
                  quoteHalfSpread: this.config.QUOTE_HALF_SPREAD,
                  inventorySkew: this.config.INVENTORY_SKEW,
                  orderSize: this.config.ORDER_SIZE,
                  maxOutcomePosition: this.runtimeLimits.maxOutcomePosition,
                },
              );
      this.tui?.recordExecutionState(runtime.mapping.round ?? 0, false, undefined, quotes);
      this.plannedQuotes.set(runtime.mapping.sourceMarketId, quotes);
      await runtime.executor.reconcile(runtime.market, quotes, books);
      this.rejectDetails.delete(runtime.mapping.sourceMarketId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ error: message, slug: runtime.market.slug }, "strategy failed closed");
      this.rejectDetails.set(runtime.mapping.sourceMarketId, message);
      await this.protectRuntime(runtime, "strategy-error", false);
    }
  }

  private canUnlock(
    runtime: MarketRuntime,
    fair: FairSnapshot,
    books: ReadonlyMap<string, TokenBook>,
  ): boolean {
    const state = this.sourceStates.get(runtime.mapping.sourceMarketId);
    if (
      !this.mqttConnected ||
      !this.polymarketConnected ||
      runtime.protection !== undefined ||
      (this.tradingSupervisor !== undefined && !this.tradingSupervisor.heartbeatHealthy) ||
      !state ||
      state.suspended ||
      !state.visible ||
      !state.open ||
      (runtime.requiresSourceReopen && state.updatedAt <= runtime.lockEpoch) ||
      fair.receivedAt <= runtime.lockEpoch ||
      (this.polymarketFreshAt.get(runtime.mapping.round ?? 0) ?? 0) <= runtime.lockEpoch ||
      runtime.market.closed ||
      !runtime.market.acceptingOrders
    ) {
      return false;
    }
    const now = Date.now();
    return runtime.market.tokenIds.every((tokenId) => {
      const book = books.get(tokenId);
      return book !== undefined && now - book.receivedAt <= this.runtimeLimits.oddsStaleMs;
    });
  }

  private async protectRuntime(
    runtime: MarketRuntime,
    reason: string,
    refreshEpoch = true,
  ): Promise<void> {
    if (!runtime.executor.locked || refreshEpoch) runtime.lockEpoch = Date.now();
    if (
      reason === "source-market-locked" ||
      reason === "source-suspended" ||
      reason === "source-hidden" ||
      reason === "source-closed"
    ) {
      runtime.requiresSourceReopen = true;
    }
    if (reason !== "lock-barrier-active") {
      this.lockReasons.set(runtime.mapping.sourceMarketId, reason);
      this.plannedQuotes.set(runtime.mapping.sourceMarketId, []);
    }
    if (runtime.executor.locked) {
      if (reason !== "lock-barrier-active") {
        this.tui?.recordExecutionState(runtime.mapping.round ?? 0, true, reason);
      }
      if (runtime.protection) await runtime.protection;
      return;
    }
    this.tui?.recordExecutionState(runtime.mapping.round ?? 0, true, reason);
    const protection = runtime.executor.lock(reason);
    runtime.protection = protection;
    try {
      await protection;
    } finally {
      if (runtime.protection === protection) runtime.protection = undefined;
    }
  }

  private async protectAll(reason: string): Promise<void> {
    await Promise.all(this.runtimes.map((runtime) => this.protectRuntime(runtime, reason)));
  }

  private statusSnapshot(): MakerRuntimeStatus {
    const sharedPositions = this.runtimes[0]?.executor.positions;
    const positionNotional = [...(sharedPositions?.byToken.values() ?? [])].reduce(
      (sum, position) => sum + Math.max(0, position),
      0,
    );
    const openOrderNotional = this.runtimes.reduce(
      (sum, runtime) => sum + runtime.executor.openOrderNotional,
      0,
    );
    return {
      running: true as const,
      mode: this.config.TRADING_MODE,
      startedAt: this.startedAt,
      updatedAt: Date.now(),
      mqttConnected: this.mqttConnected,
      polymarketConnected: this.polymarketConnected,
      cash: sharedPositions?.cash ?? 0,
      accountNotionalUsed: positionNotional + openOrderNotional,
      accountNotionalLimit: this.runtimeLimits.maxAccountNotional,
      markets: this.runtimes.map((runtime) => {
        const state = this.sourceStates.get(runtime.mapping.sourceMarketId);
        const fair = this.latestFair.get(runtime.mapping.sourceMarketId);
        const reason = this.lockReasons.get(runtime.mapping.sourceMarketId);
        const rejectDetail = this.rejectDetails.get(runtime.mapping.sourceMarketId);
        const marketPositionNotional = runtime.market.tokenIds.reduce(
          (sum, tokenId) => sum + Math.max(0, runtime.executor.positions.byToken.get(tokenId) ?? 0),
          0,
        );
        return {
          name: runtime.mapping.name,
          round: runtime.mapping.round ?? 0,
          polymarketSlug: runtime.mapping.polymarketSlug,
          sourceMarketId: runtime.mapping.sourceMarketId,
          locked: runtime.executor.locked,
          ...(reason ? { reason } : {}),
          ...(rejectDetail ? { rejectDetail } : {}),
          sourceOpen: state ? state.open && state.visible && !state.suspended : null,
          sourceLocked: state ? state.suspended || !state.visible || !state.open : true,
          fairPrices: Object.fromEntries(
            runtime.mapping.outcomes.map((outcome) => [
              outcome.outcome,
              fair?.probabilities.get(outcome.sourceOddId) ?? 0,
            ]),
          ),
          plannedQuotes: this.plannedQuotes.get(runtime.mapping.sourceMarketId) ?? [],
          openOrderCount: runtime.executor.openOrderCount,
          openOrderNotional: runtime.executor.openOrderNotional,
          notionalUsed: marketPositionNotional + runtime.executor.openOrderNotional,
          positions: Object.fromEntries(
            runtime.market.outcomes.map((outcome, index) => [
              outcome,
              runtime.executor.positions.byToken.get(runtime.market.tokenIds[index] ?? "") ?? 0,
            ]),
          ),
        };
      }),
    };
  }
}
