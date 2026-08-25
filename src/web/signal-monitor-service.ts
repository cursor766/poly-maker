import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { connect, type MqttClient } from "mqtt";
import type { Logger } from "pino";
import WebSocket from "ws";
import type { AppConfig } from "../config.js";
import { normalizeDecimalOdds } from "../odds/probability.js";
import type { MarketResolver } from "../polymarket/market-resolver.js";
import type { MatchMetadataClient } from "../source/match-metadata-client.js";
import { buildSubscriptionTopics } from "../source/mqtt-client.js";

export interface SignalMonitorOptions {
  sourceMatchId: string;
  polymarketEventSlug: string;
  polymarketMarketSlug: string;
  jumpThreshold: number;
  notionalUsd: number;
  maxSlippage: number;
  cooldownMs: number;
  polyLagTicks: number;
}

export interface BookLevel {
  price: number;
  size: number;
}

export interface FillSimulation {
  fillable: boolean;
  filledUsd: number;
  unfilledUsd: number;
  vwap: number | null;
  levelsTaken: number;
  bestAsk: number | null;
  bestBid: number | null;
  askDepthUsd: number;
  edgeVsSource: number | null;
}

export type SignalKind = "lock" | "unlock" | "jump";

export type SignalVerdict =
  | "fillable"
  | "partial"
  | "no_liquidity"
  | "already_priced"
  | "no_edge"
  | "lock_watch";

export interface SignalEvent {
  id: string;
  kind: SignalKind;
  at: number;
  sourceMarketId: string;
  outcome: string;
  tokenId: string;
  side: "BUY" | "WATCH";
  sourcePrev: number;
  sourceFair: number;
  sourceDelta: number;
  polyMidAtSignal: number | null;
  polyAskAtSignal: number | null;
  polyBidAtSignal: number | null;
  polyMidAtLock: number | null;
  polyMovedDuringLock: number | null;
  lockDurationMs: number | null;
  fill: FillSimulation;
  verdict: SignalVerdict;
  reason: string;
  polyMovedAt: number | null;
  polyLagMs: number | null;
  polyMidAfter: number | null;
}

export interface SignalMonitorSnapshot {
  running: boolean;
  startedAt: number | null;
  options: SignalMonitorOptions;
  mqttConnected: boolean;
  polymarketConnected: boolean;
  sourceBound: boolean;
  sourceLocked: boolean;
  lockStartedAt: number | null;
  sourceMarketId: string | null;
  teams: [string, string] | null;
  outcomes: [string, string] | null;
  sourceFairs: [number | null, number | null];
  preLockFairs: [number | null, number | null];
  polyMids: [number | null, number | null];
  polyBids: [number | null, number | null];
  polyAsks: [number | null, number | null];
  sourceUpdatedAt: number | null;
  polyUpdatedAt: number | null;
  signals: SignalEvent[];
  stats: {
    signals: number;
    locks: number;
    unlocks: number;
    fillable: number;
    partial: number;
    missed: number;
    avgLagMs: number | null;
  };
  lastError: string | null;
}

interface BoundSourceMarket {
  marketId: string;
  oddIds: [string, string];
  outcomes: [string, string];
}

interface PendingLagWatch {
  signalId: string;
  tokenId: string;
  direction: 1 | -1;
  baselineMid: number;
  threshold: number;
  createdAt: number;
}

const DEFAULT_OPTIONS: SignalMonitorOptions = {
  sourceMatchId: "5841185802920233",
  polymarketEventSlug: "lol-jdg-edg-2026-08-07",
  polymarketMarketSlug: "lol-jdg-edg-2026-08-07-game1",
  jumpThreshold: 0.02,
  notionalUsd: 50,
  maxSlippage: 0.02,
  cooldownMs: 4_000,
  polyLagTicks: 1,
};

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function asFinite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function walkAsks(
  asks: readonly BookLevel[],
  notionalUsd: number,
  maxPrice: number,
): Omit<FillSimulation, "edgeVsSource" | "bestBid"> & { bestBid: null } {
  const bestAsk = asks[0]?.price ?? null;
  let remaining = notionalUsd;
  let spent = 0;
  let shares = 0;
  let levelsTaken = 0;
  let askDepthUsd = 0;

  for (const level of asks) {
    askDepthUsd += level.price * level.size;
    if (level.price > maxPrice) break;
    const levelNotional = level.price * level.size;
    const take = Math.min(remaining, levelNotional);
    if (take <= 0) continue;
    spent += take;
    shares += take / level.price;
    remaining -= take;
    levelsTaken += 1;
    if (remaining <= 1e-9) break;
  }

  const filledUsd = spent;
  const unfilledUsd = Math.max(0, notionalUsd - filledUsd);
  const vwap = shares > 0 ? spent / shares : null;
  return {
    fillable: unfilledUsd <= 1e-6,
    filledUsd: round4(filledUsd),
    unfilledUsd: round4(unfilledUsd),
    vwap: vwap === null ? null : round4(vwap),
    levelsTaken,
    bestAsk,
    bestBid: null,
    askDepthUsd: round4(askDepthUsd),
  };
}

export class SignalMonitorService {
  private readonly emitter = new EventEmitter();
  private readonly oddsByMarket = new Map<string, Map<string, number>>();
  private readonly oddNames = new Map<string, string>();
  private readonly fairByOddId = new Map<string, number>();
  private readonly prevFairByOddId = new Map<string, number>();
  private readonly books = new Map<string, { bid: number | null; ask: number | null }>();
  private readonly lagWatches = new Map<string, PendingLagWatch>();
  private boundScore = Number.POSITIVE_INFINITY;

  private options: SignalMonitorOptions = { ...DEFAULT_OPTIONS };
  private mqtt: MqttClient | undefined;
  private polySocket: WebSocket | undefined;
  private polyHeartbeat: NodeJS.Timeout | undefined;
  private lagTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private running = false;
  private startedAt: number | null = null;
  private mqttConnected = false;
  private polymarketConnected = false;
  private lastError: string | null = null;
  private sourceUpdatedAt: number | null = null;
  private polyUpdatedAt: number | null = null;
  private bound: BoundSourceMarket | null = null;
  private teams: [string, string] | null = null;
  private outcomes: [string, string] | null = null;
  private tokenIds: [string, string] | null = null;
  private tickSize = 0.01;
  private lastSignalAt = 0;
  private signals: SignalEvent[] = [];
  private polyMids: [number | null, number | null] = [null, null];
  private sourceFairs: [number | null, number | null] = [null, null];
  private preLockFairs: [number | null, number | null] = [null, null];
  private polyMidsAtLock: [number | null, number | null] = [null, null];
  private sourceLocked = false;
  private lockStartedAt: number | null = null;
  private marketSuspended = new Map<string, boolean>();
  private awaitingUnlockJump = false;
  private unlockMeta: {
    lockStartedAt: number | null;
    preLock: [number | null, number | null];
    polyAtLock: [number | null, number | null];
  } | null = null;
  private jumpQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: AppConfig,
    private readonly metadataClient: MatchMetadataClient | null,
    private readonly marketResolver: MarketResolver,
    private readonly logger: Logger,
  ) {}

  onSnapshot(listener: (snapshot: SignalMonitorSnapshot) => void): () => void {
    this.emitter.on("snapshot", listener);
    return () => this.emitter.off("snapshot", listener);
  }

  onSignal(listener: (signal: SignalEvent) => void): () => void {
    this.emitter.on("signal", listener);
    return () => this.emitter.off("signal", listener);
  }

  getSnapshot(): SignalMonitorSnapshot {
    const fillable = this.signals.filter((item) => item.verdict === "fillable").length;
    const partial = this.signals.filter((item) => item.verdict === "partial").length;
    const missed = this.signals.filter(
      (item) =>
        item.verdict === "no_liquidity" ||
        item.verdict === "already_priced" ||
        item.verdict === "no_edge",
    ).length;
    const lags = this.signals
      .map((item) => item.polyLagMs)
      .filter((value): value is number => value !== null);
    return {
      running: this.running,
      startedAt: this.startedAt,
      options: this.options,
      mqttConnected: this.mqttConnected,
      polymarketConnected: this.polymarketConnected,
      sourceBound: this.bound !== null,
      sourceLocked: this.sourceLocked,
      lockStartedAt: this.lockStartedAt,
      sourceMarketId: this.bound?.marketId ?? null,
      teams: this.teams,
      outcomes: this.outcomes,
      sourceFairs: this.sourceFairs,
      preLockFairs: this.preLockFairs,
      polyMids: this.polyMids,
      polyBids: [
        this.tokenIds ? (this.books.get(this.tokenIds[0])?.bid ?? null) : null,
        this.tokenIds ? (this.books.get(this.tokenIds[1])?.bid ?? null) : null,
      ],
      polyAsks: [
        this.tokenIds ? (this.books.get(this.tokenIds[0])?.ask ?? null) : null,
        this.tokenIds ? (this.books.get(this.tokenIds[1])?.ask ?? null) : null,
      ],
      sourceUpdatedAt: this.sourceUpdatedAt,
      polyUpdatedAt: this.polyUpdatedAt,
      signals: [...this.signals],
      stats: {
        signals: this.signals.length,
        locks: this.signals.filter((item) => item.kind === "lock").length,
        unlocks: this.signals.filter((item) => item.kind === "unlock").length,
        fillable,
        partial,
        missed,
        avgLagMs:
          lags.length === 0
            ? null
            : Math.round(lags.reduce((sum, value) => sum + value, 0) / lags.length),
      },
      lastError: this.lastError,
    };
  }

  async start(partial: Partial<SignalMonitorOptions> = {}): Promise<SignalMonitorSnapshot> {
    if (this.running) await this.stop();
    this.options = { ...DEFAULT_OPTIONS, ...partial };
    this.running = true;
    this.startedAt = Date.now();
    this.lastError = null;
    this.signals = [];
    this.bound = null;
    this.oddsByMarket.clear();
    this.oddNames.clear();
    this.fairByOddId.clear();
    this.prevFairByOddId.clear();
    this.books.clear();
    this.lagWatches.clear();
    this.boundScore = Number.POSITIVE_INFINITY;
    this.sourceFairs = [null, null];
    this.preLockFairs = [null, null];
    this.polyMidsAtLock = [null, null];
    this.polyMids = [null, null];
    this.sourceLocked = false;
    this.lockStartedAt = null;
    this.awaitingUnlockJump = false;
    this.unlockMeta = null;
    this.marketSuspended.clear();
    this.publish();

    try {
      await this.resolvePolymarket();
      await this.tryBindFromMetadata();
      this.openMqtt();
      this.openPolymarketWs();
      this.lagTimer = setInterval(() => this.expireLagWatches(), 1_000);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.warn({ error: this.lastError }, "signal monitor failed to start");
      await this.stop();
      throw error;
    }

    this.publish();
    return this.getSnapshot();
  }

  async stop(): Promise<SignalMonitorSnapshot> {
    this.running = false;
    if (this.lagTimer) clearInterval(this.lagTimer);
    this.lagTimer = undefined;
    if (this.polyHeartbeat) clearInterval(this.polyHeartbeat);
    this.polyHeartbeat = undefined;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const mqtt = this.mqtt;
    this.mqtt = undefined;
    mqtt?.end(true);
    this.mqttConnected = false;
    const socket = this.polySocket;
    this.polySocket = undefined;
    socket?.terminate();
    this.polymarketConnected = false;
    this.publish();
    return this.getSnapshot();
  }

  private publish(): void {
    this.emitter.emit("snapshot", this.getSnapshot());
  }

  private async resolvePolymarket(): Promise<void> {
    const markets = await this.marketResolver.listMoneylineMarkets(this.options.polymarketEventSlug);
    const market =
      markets.find((item) => item.slug === this.options.polymarketMarketSlug) ??
      markets.find((item) => item.round === 1);
    if (!market) {
      throw new Error(`Polymarket G1 market not found: ${this.options.polymarketMarketSlug}`);
    }
    this.outcomes = [...market.outcomes] as [string, string];
    this.tokenIds = [...market.tokenIds] as [string, string];
    this.tickSize = market.tickSize;
    this.teams = [...market.outcomes] as [string, string];
  }

  private async tryBindFromMetadata(): Promise<void> {
    if (!this.metadataClient || !this.outcomes) return;
    try {
      const match = await this.metadataClient.fetchMatch(this.options.sourceMatchId);
      this.teams = [...match.teams] as [string, string];
      for (const market of match.markets.values()) {
        if (market.round !== 1) continue;
        if (!/胜负|winner/i.test(market.name)) continue;
        const mapped = this.mapOddIdsToOutcomes(market.outcomes);
        if (!mapped) continue;
        this.bound = {
          marketId: market.marketId,
          oddIds: mapped.oddIds,
          outcomes: mapped.outcomes,
        };
        for (const odd of match.initialOdds) {
          if (odd.marketId !== market.marketId) continue;
          this.applyOdd(odd.marketId, odd.oddId, odd.decimalOdd, false);
        }
        this.logger.info(
          { marketId: market.marketId, name: market.name },
          "signal monitor bound source G1 market from metadata",
        );
        return;
      }
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "signal monitor metadata bind failed; will auto-detect from MQTT",
      );
    }
  }

  private mapOddIdsToOutcomes(
    outcomes: ReadonlyMap<string, string>,
  ): { oddIds: [string, string]; outcomes: [string, string] } | null {
    if (!this.outcomes) return null;
    const entries = [...outcomes.entries()];
    const first = entries.find(([, name]) => this.outcomeMatches(name, this.outcomes![0]));
    const second = entries.find(([, name]) => this.outcomeMatches(name, this.outcomes![1]));
    if (!first || !second) return null;
    return {
      oddIds: [first[0], second[0]],
      outcomes: [this.outcomes[0], this.outcomes[1]],
    };
  }

  private outcomeMatches(sourceName: string, polymarketName: string): boolean {
    const left = sourceName.toLowerCase();
    const right = polymarketName.toLowerCase();
    if (left.includes(right) || right.includes(left)) return true;
    const aliases: Record<string, string[]> = {
      "jd gaming": ["jdg", "jd gaming"],
      "edward gaming": ["edg", "edward gaming", "edward"],
    };
    const keys = aliases[right] ?? [right];
    return keys.some((alias) => left.includes(alias));
  }

  private openMqtt(): void {
    const suffix = randomBytes(4).toString("hex");
    const client = connect(this.config.MQTT_URL, {
      protocolVersion: 4,
      clean: true,
      clientId: `${this.config.MQTT_CLIENT_ID_PREFIX}-signal-${suffix}`,
      username: this.config.MQTT_USERNAME,
      password: this.config.MQTT_PASSWORD,
      keepalive: this.config.MQTT_KEEPALIVE_SECONDS,
      reconnectPeriod: this.config.MQTT_RECONNECT_MIN_MS,
      connectTimeout: 10_000,
      wsOptions: { headers: { Origin: this.config.MQTT_ORIGIN } },
      rejectUnauthorized: false,
    });
    this.mqtt = client;

    client.on("connect", () => {
      this.mqttConnected = true;
      const topics = buildSubscriptionTopics([this.options.sourceMatchId], []);
      client.subscribe(topics, { qos: 0 });
      this.publish();
    });
    client.on("close", () => {
      this.mqttConnected = false;
      this.publish();
    });
    client.on("error", (error) => {
      this.lastError = error.message;
      this.publish();
    });
    client.on("message", (topic, payload) => {
      try {
        if (topic.includes("oddsUpdate") || topic === "/market/odds/update") {
          this.handleMqttOdds(payload);
          return;
        }
        if (
          topic.includes("statusUpdate") ||
          topic.includes("suspended") ||
          topic.includes("visible") ||
          topic === "/market/status/update" ||
          topic === "/market/action/suspended" ||
          topic === "/market/action/visible"
        ) {
          this.handleMqttState(topic, payload);
        }
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.publish();
      }
    });
  }

  private handleMqttState(topic: string, payload: Buffer): void {
    const decoded = JSON.parse(payload.toString("utf8")) as unknown;
    const rows = Array.isArray(decoded) ? decoded : [decoded];
    const isSuspendedTopic = topic.includes("suspended");
    const isVisibleTopic = topic.includes("visible");
    for (const row of rows) {
      if (typeof row !== "object" || row === null) continue;
      const record = row as Record<string, unknown>;
      const marketId = String(record.market_id ?? topic.split("/").filter(Boolean).at(-1) ?? "");
      if (!marketId) continue;
      const matchId = record.match_id !== undefined ? String(record.match_id) : null;
      if (matchId && matchId !== this.options.sourceMatchId) continue;

      let suspended: boolean | null = null;
      if (isSuspendedTopic) {
        suspended = Boolean(record.suspended ?? record.value ?? true);
      } else if (isVisibleTopic) {
        const visible = Boolean(record.visible ?? record.value ?? true);
        suspended = !visible;
      } else if (record.status !== undefined) {
        const status = Number(record.status);
        // 1/6 = open; 8/9 often settle/winner. Treat non-open as locked.
        suspended = !(status === 1 || status === 6);
      }
      if (suspended === null) continue;
      this.marketSuspended.set(marketId, suspended);
      if (this.bound?.marketId === marketId) {
        void this.setBoundLockState(suspended);
      }
    }
    this.publish();
  }

  private async setBoundLockState(locked: boolean): Promise<void> {
    if (!this.bound) return;
    if (locked === this.sourceLocked) return;
    if (locked) {
      this.sourceLocked = true;
      this.lockStartedAt = Date.now();
      this.awaitingUnlockJump = false;
      this.unlockMeta = null;
      this.preLockFairs = [...this.sourceFairs] as [number | null, number | null];
      this.polyMidsAtLock = [...this.polyMids] as [number | null, number | null];
      await this.emitLockSignal();
      return;
    }
    // Unlock: odds usually arrive right after. Wait for post-lock fair jump.
    this.sourceLocked = false;
    this.awaitingUnlockJump = true;
    this.unlockMeta = {
      lockStartedAt: this.lockStartedAt,
      preLock: [...this.preLockFairs] as [number | null, number | null],
      polyAtLock: [...this.polyMidsAtLock] as [number | null, number | null],
    };
    this.lockStartedAt = null;
    const notice: SignalEvent = {
      id: `unlock-wait-${Date.now()}`,
      kind: "unlock",
      at: Date.now(),
      sourceMarketId: this.bound.marketId,
      outcome: "源站解锁",
      tokenId: this.tokenIds?.[0] ?? "",
      side: "WATCH",
      sourcePrev: this.preLockFairs[0] ?? 0,
      sourceFair: this.sourceFairs[0] ?? 0,
      sourceDelta: 0,
      polyMidAtSignal: this.polyMids[0],
      polyAskAtSignal: this.tokenIds
        ? (this.books.get(this.tokenIds[0])?.ask ?? null)
        : null,
      polyBidAtSignal: this.tokenIds
        ? (this.books.get(this.tokenIds[0])?.bid ?? null)
        : null,
      polyMidAtLock: this.unlockMeta.polyAtLock[0],
      polyMovedDuringLock:
        this.polyMids[0] !== null && this.unlockMeta.polyAtLock[0] !== null
          ? round4(this.polyMids[0] - this.unlockMeta.polyAtLock[0])
          : null,
      lockDurationMs: this.unlockMeta.lockStartedAt
        ? Date.now() - this.unlockMeta.lockStartedAt
        : null,
      fill: this.emptyFill(
        this.tokenIds ? (this.books.get(this.tokenIds[0])?.ask ?? null) : null,
        this.tokenIds ? (this.books.get(this.tokenIds[0])?.bid ?? null) : null,
      ),
      verdict: "lock_watch",
      reason: "源站已解锁，等待赔率重开后的第一跳，再评估能否吃到 Polymarket",
      polyMovedAt: null,
      polyLagMs: null,
      polyMidAfter: null,
    };
    this.signals = [notice, ...this.signals].slice(0, 100);
    this.emitter.emit("signal", notice);
    this.publish();
  }

  private emptyFill(bestAsk: number | null, bestBid: number | null): FillSimulation {
    return {
      fillable: false,
      filledUsd: 0,
      unfilledUsd: this.options.notionalUsd,
      vwap: null,
      levelsTaken: 0,
      bestAsk,
      bestBid,
      askDepthUsd: 0,
      edgeVsSource: null,
    };
  }

  private async emitLockSignal(): Promise<void> {
    if (!this.bound || !this.tokenIds || !this.outcomes) return;
    const now = Date.now();
    try {
      await this.refreshBooks();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    const signal: SignalEvent = {
      id: `lock-${now}`,
      kind: "lock",
      at: now,
      sourceMarketId: this.bound.marketId,
      outcome: "源站锁盘",
      tokenId: this.tokenIds[0],
      side: "WATCH",
      sourcePrev: this.preLockFairs[0] ?? 0,
      sourceFair: this.preLockFairs[0] ?? 0,
      sourceDelta: 0,
      polyMidAtSignal: this.polyMids[0],
      polyAskAtSignal: this.books.get(this.tokenIds[0])?.ask ?? null,
      polyBidAtSignal: this.books.get(this.tokenIds[0])?.bid ?? null,
      polyMidAtLock: this.polyMids[0],
      polyMovedDuringLock: null,
      lockDurationMs: null,
      fill: this.emptyFill(
        this.books.get(this.tokenIds[0])?.ask ?? null,
        this.books.get(this.tokenIds[0])?.bid ?? null,
      ),
      verdict: "lock_watch",
      reason:
        "重大事件锁盘：源站赔率停更。此时应看直播方向，并观察 Polymarket 是否仍可交易。",
      polyMovedAt: null,
      polyLagMs: null,
      polyMidAfter: null,
    };
    this.signals = [signal, ...this.signals].slice(0, 100);
    this.emitter.emit("signal", signal);
    this.publish();
  }

  private maybeEmitUnlockJump(fairA: number, fairB: number): void {
    if (!this.awaitingUnlockJump || !this.unlockMeta || !this.bound) return;
    const prev0 = this.unlockMeta.preLock[0];
    const prev1 = this.unlockMeta.preLock[1];
    if (prev0 === null || prev1 === null) {
      this.awaitingUnlockJump = false;
      this.unlockMeta = null;
      return;
    }
    const delta0 = fairA - prev0;
    const delta1 = fairB - prev1;
    if (
      Math.abs(delta0) < this.options.jumpThreshold * 0.5 &&
      Math.abs(delta1) < this.options.jumpThreshold * 0.5
    ) {
      return;
    }
    const meta = this.unlockMeta;
    this.awaitingUnlockJump = false;
    this.unlockMeta = null;
    const buyIndex = (
      Math.abs(delta0) >= Math.abs(delta1) ? (delta0 >= 0 ? 0 : 1) : delta1 >= 0 ? 1 : 0
    ) as 0 | 1;
    const prevFair = buyIndex === 0 ? prev0 : prev1;
    const nextFair = buyIndex === 0 ? fairA : fairB;
    this.enqueueJump(buyIndex, prevFair, nextFair, {
      kind: "unlock",
      polyMidAtLock: meta.polyAtLock[buyIndex],
      polyMovedDuringLock:
        this.polyMids[buyIndex] !== null && meta.polyAtLock[buyIndex] !== null
          ? round4(this.polyMids[buyIndex]! - meta.polyAtLock[buyIndex]!)
          : null,
      lockDurationMs: meta.lockStartedAt ? Date.now() - meta.lockStartedAt : null,
      bypassCooldown: true,
    });
  }

  private handleMqttOdds(payload: Buffer): void {
    const decoded = JSON.parse(payload.toString("utf8")) as unknown;
    const rows = Array.isArray(decoded) ? decoded : [decoded];
    for (const row of rows) {
      if (typeof row !== "object" || row === null) continue;
      const record = row as Record<string, unknown>;
      const matchId = String(record.match_id ?? "");
      if (matchId !== this.options.sourceMatchId) continue;
      const marketId = String(record.market_id ?? "");
      const oddId = String(record.id ?? "");
      const odd = asFinite(record.odd);
      const name = String(record.name ?? record.en_name ?? "");
      if (!marketId || !oddId || odd === null || odd <= 1) continue;
      if (name) this.oddNames.set(oddId, name.replaceAll("&nbsp;", " ").trim());
      this.applyOdd(marketId, oddId, odd, true);
    }
    this.maybeAutoBind();
    this.publish();
  }

  private applyOdd(
    marketId: string,
    oddId: string,
    decimalOdd: number,
    detectJump: boolean,
  ): void {
    let marketOdds = this.oddsByMarket.get(marketId);
    if (!marketOdds) {
      marketOdds = new Map();
      this.oddsByMarket.set(marketId, marketOdds);
    }
    marketOdds.set(oddId, decimalOdd);
    this.sourceUpdatedAt = Date.now();

    if (!this.bound || this.bound.marketId !== marketId) {
      return;
    }

    const [oddA, oddB] = this.bound.oddIds;
    const oddAValue = marketOdds.get(oddA);
    const oddBValue = marketOdds.get(oddB);
    if (oddAValue === undefined || oddBValue === undefined) return;

    let fairA: number;
    let fairB: number;
    try {
      const normalized = normalizeDecimalOdds([oddAValue, oddBValue]);
      fairA = normalized.probabilities[0] ?? 0;
      fairB = normalized.probabilities[1] ?? 0;
    } catch {
      return;
    }

    const prevA = this.fairByOddId.get(oddA);
    const prevB = this.fairByOddId.get(oddB);
    this.fairByOddId.set(oddA, fairA);
    this.fairByOddId.set(oddB, fairB);
    if (prevA !== undefined) this.prevFairByOddId.set(oddA, prevA);
    if (prevB !== undefined) this.prevFairByOddId.set(oddB, prevB);
    this.sourceFairs = [fairA, fairB];
    this.maybeEmitUnlockJump(fairA, fairB);

    if (!detectJump || this.sourceLocked) return;
    if (oddId !== oddA && oddId !== oddB) return;

    const candidates: Array<{ index: 0 | 1; prev: number; next: number }> = [];
    if (prevA !== undefined) candidates.push({ index: 0, prev: prevA, next: fairA });
    if (prevB !== undefined) candidates.push({ index: 1, prev: prevB, next: fairB });
    const best = candidates.sort(
      (left, right) => Math.abs(right.next - right.prev) - Math.abs(left.next - left.prev),
    )[0];
    if (!best) return;
    const delta = best.next - best.prev;
    if (Math.abs(delta) < this.options.jumpThreshold) return;

    const buyIndex = (delta > 0 ? best.index : ((1 - best.index) as 0 | 1));
    const buyFair = buyIndex === 0 ? fairA : fairB;
    const buyPrev =
      buyIndex === best.index ? best.prev : buyIndex === 0 ? (prevA ?? 1 - best.prev) : (prevB ?? 1 - best.prev);
    this.enqueueJump(buyIndex, buyPrev, buyFair);
  }

  private enqueueJump(
    outcomeIndex: 0 | 1,
    prevFair: number,
    nextFair: number,
    extra: {
      kind?: SignalKind;
      polyMidAtLock?: number | null;
      polyMovedDuringLock?: number | null;
      lockDurationMs?: number | null;
      bypassCooldown?: boolean;
    } = {},
  ): void {
    this.jumpQueue = this.jumpQueue
      .then(() => this.onSourceJump(outcomeIndex, prevFair, nextFair, extra))
      .catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.publish();
      });
  }

  private isCleanMoneylineName(name: string | undefined): boolean {
    if (!name) return false;
    const normalized = name.toLowerCase().replace(/\s+/g, " ").trim();
    if (/[+-]\d/.test(normalized)) return false;
    if (/handicap|spread|total|over|under|kill|回合|让分|大小/.test(normalized)) {
      return false;
    }
    return (
      /^@t[12]$/i.test(normalized) ||
      /jd|jdg|edward|edg|gaming/.test(normalized)
    );
  }

  private isHandicapName(name: string | undefined): boolean {
    if (!name) return false;
    return /[+-]\d/.test(name) || /让分|handicap|spread/i.test(name);
  }

  private pairQuality(
    leftId: string,
    rightId: string,
    fairs: [number, number],
    polyMid: number,
  ): { score: number; flip: boolean; clean: boolean } {
    const scoreDirect = Math.abs(fairs[0] - polyMid) + Math.abs(fairs[1] - (1 - polyMid));
    const scoreFlip = Math.abs(fairs[1] - polyMid) + Math.abs(fairs[0] - (1 - polyMid));
    const flip = scoreFlip < scoreDirect;
    const leftName = this.oddNames.get(leftId);
    const rightName = this.oddNames.get(rightId);
    if (this.isHandicapName(leftName) || this.isHandicapName(rightName)) {
      return { score: Math.min(scoreDirect, scoreFlip), flip, clean: false };
    }
    const clean =
      (this.isCleanMoneylineName(leftName) && this.isCleanMoneylineName(rightName)) ||
      (this.isCleanMoneylineName(leftName) && !rightName) ||
      (this.isCleanMoneylineName(rightName) && !leftName);
    return { score: Math.min(scoreDirect, scoreFlip), flip, clean };
  }

  private maybeAutoBind(): void {
    if (!this.outcomes || !this.tokenIds) return;
    const polyMid = this.polyMids[0];
    if (polyMid === null) return;

    let best:
      | {
          score: number;
          clean: boolean;
          marketId: string;
          oddIds: [string, string];
          fairs: [number, number];
        }
      | undefined;

    for (const [marketId, odds] of this.oddsByMarket) {
      if (odds.size < 2) continue;
      const entries = [...odds.entries()];
      // Prefer exact two-odd markets; otherwise search pairs.
      const pairs: Array<[typeof entries[number], typeof entries[number]]> = [];
      if (entries.length === 2) {
        pairs.push([entries[0]!, entries[1]!]);
      } else {
        for (let i = 0; i < entries.length; i += 1) {
          for (let j = i + 1; j < entries.length; j += 1) {
            pairs.push([entries[i]!, entries[j]!]);
          }
        }
      }
      for (const [left, right] of pairs) {
        if (![left[1], right[1]].every((odd) => odd >= 1.05 && odd <= 12)) continue;
        try {
          const normalized = normalizeDecimalOdds([left[1], right[1]]);
          const fairs = normalized.probabilities as [number, number];
          const quality = this.pairQuality(left[0], right[0], fairs, polyMid);
          const maxScore = quality.clean ? 0.36 : 0.16;
          if (quality.score > maxScore) continue;
          if (
            !best ||
            Number(quality.clean) > Number(best.clean) ||
            (quality.clean === best.clean && quality.score < best.score)
          ) {
            best = {
              score: quality.score,
              clean: quality.clean,
              marketId,
              oddIds: quality.flip
                ? ([right[0], left[0]] as [string, string])
                : ([left[0], right[0]] as [string, string]),
              fairs: quality.flip ? [fairs[1], fairs[0]] : fairs,
            };
          }
        } catch {
          continue;
        }
      }
    }

    if (!best) return;
    if (this.bound) {
      const betterClean = best.clean && best.score + 0.02 < this.boundScore;
      const sameMarketBetter =
        best.marketId === this.bound.marketId && best.score + 0.01 < this.boundScore;
      if (!betterClean && !sameMarketBetter && best.marketId !== this.bound.marketId) return;
      if (best.marketId === this.bound.marketId && best.score >= this.boundScore) return;
    }

    this.bound = {
      marketId: best.marketId,
      oddIds: best.oddIds,
      outcomes: this.outcomes,
    };
    this.boundScore = best.score;
    this.sourceFairs = best.fairs;
    this.fairByOddId.set(best.oddIds[0], best.fairs[0]);
    this.fairByOddId.set(best.oddIds[1], best.fairs[1]);
    this.prevFairByOddId.set(best.oddIds[0], best.fairs[0]);
    this.prevFairByOddId.set(best.oddIds[1], best.fairs[1]);
    this.logger.info(
      {
        marketId: best.marketId,
        score: best.score,
        clean: best.clean,
        fairs: best.fairs,
        names: [this.oddNames.get(best.oddIds[0]), this.oddNames.get(best.oddIds[1])],
      },
      "signal monitor auto-bound source market to Polymarket G1",
    );
  }

  private openPolymarketWs(): void {
    if (!this.tokenIds || !this.running) return;
    const socket = new WebSocket(this.config.POLYMARKET_WS_URL);
    this.polySocket = socket;
    socket.on("open", () => {
      this.polymarketConnected = true;
      socket.send(JSON.stringify({ type: "market", assets_ids: this.tokenIds }));
      this.polyHeartbeat = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send("PING");
      }, 10_000);
      void this.refreshBooks();
      this.publish();
    });
    socket.on("close", () => {
      this.polymarketConnected = false;
      this.publish();
      if (!this.running) return;
      this.reconnectTimer = setTimeout(() => this.openPolymarketWs(), 1_500);
    });
    socket.on("error", (error) => {
      this.lastError = error.message;
      this.publish();
    });
    socket.on("message", (raw) => {
      const text = raw.toString();
      if (text === "PONG") return;
      try {
        this.handlePolyMessage(JSON.parse(text));
      } catch {
        // ignore malformed
      }
    });
  }

  private handlePolyMessage(payload: unknown): void {
    const events = Array.isArray(payload) ? payload : [payload];
    for (const event of events) {
      if (typeof event !== "object" || event === null) continue;
      const record = event as Record<string, unknown>;
      if (Array.isArray(record.price_changes)) {
        for (const change of record.price_changes) {
          if (typeof change !== "object" || change === null) continue;
          this.applyTopOfBook(change as Record<string, unknown>);
        }
      }
      this.applyTopOfBook(record);
    }
    this.updatePolyMids();
    this.checkLagWatches();
    this.publish();
  }

  private applyTopOfBook(record: Record<string, unknown>): void {
    const assetId = String(record.asset_id ?? "");
    if (!this.tokenIds?.includes(assetId)) return;
    const current = this.books.get(assetId);
    const bid =
      asFinite(record.best_bid) ?? this.topPrice(record.bids, "bid") ?? current?.bid ?? null;
    const ask =
      asFinite(record.best_ask) ?? this.topPrice(record.asks, "ask") ?? current?.ask ?? null;
    this.books.set(assetId, { bid, ask });
    this.polyUpdatedAt = Date.now();
  }

  private topPrice(value: unknown, side: "bid" | "ask"): number | null {
    if (!Array.isArray(value)) return null;
    const prices = value.flatMap((level) => {
      if (typeof level !== "object" || level === null) return [];
      const price = asFinite((level as Record<string, unknown>).price);
      return price !== null && price > 0 && price < 1 ? [price] : [];
    });
    if (prices.length === 0) return null;
    return side === "bid" ? Math.max(...prices) : Math.min(...prices);
  }

  private updatePolyMids(): void {
    if (!this.tokenIds) return;
    this.polyMids = this.tokenIds.map((tokenId) => {
      const book = this.books.get(tokenId);
      if (!book) return null;
      if (book.bid !== null && book.ask !== null) return round4((book.bid + book.ask) / 2);
      return book.ask ?? book.bid;
    }) as [number | null, number | null];
  }

  private async refreshBooks(): Promise<void> {
    if (!this.tokenIds) return;
    await Promise.all(this.tokenIds.map((tokenId) => this.fetchBook(tokenId)));
    this.updatePolyMids();
    this.publish();
  }

  private async fetchBook(tokenId: string): Promise<BookLevel[]> {
    const response = await fetch(
      `${this.config.CLOB_API_URL}/book?token_id=${encodeURIComponent(tokenId)}`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!response.ok) throw new Error(`CLOB book HTTP ${response.status}`);
    const body = (await response.json()) as {
      bids?: Array<{ price: string; size: string }>;
      asks?: Array<{ price: string; size: string }>;
    };
    const bids = (body.bids ?? [])
      .map((level) => ({ price: Number(level.price), size: Number(level.size) }))
      .filter((level) => level.price > 0 && level.size > 0)
      .sort((left, right) => right.price - left.price);
    const asks = (body.asks ?? [])
      .map((level) => ({ price: Number(level.price), size: Number(level.size) }))
      .filter((level) => level.price > 0 && level.size > 0)
      .sort((left, right) => left.price - right.price);
    this.books.set(tokenId, {
      bid: bids[0]?.price ?? null,
      ask: asks[0]?.price ?? null,
    });
    this.polyUpdatedAt = Date.now();
    return asks;
  }

  private async onSourceJump(
    outcomeIndex: 0 | 1,
    prevFair: number,
    nextFair: number,
    extra: {
      kind?: SignalKind;
      polyMidAtLock?: number | null;
      polyMovedDuringLock?: number | null;
      lockDurationMs?: number | null;
      bypassCooldown?: boolean;
    } = {},
  ): Promise<void> {
    if (!this.bound || !this.tokenIds || !this.outcomes) return;
    const now = Date.now();
    if (!extra.bypassCooldown && now - this.lastSignalAt < this.options.cooldownMs) return;
    const delta = nextFair - prevFair;
    const minJump =
      extra.kind === "unlock" ? this.options.jumpThreshold * 0.25 : this.options.jumpThreshold * 0.5;
    if (Math.abs(delta) < minJump && extra.kind !== "unlock") return;

    this.lastSignalAt = now;
    const outcome = this.outcomes[outcomeIndex];
    const tokenId = this.tokenIds[outcomeIndex];
    const polyMid = this.polyMids[outcomeIndex];
    const book = this.books.get(tokenId);
    let asks: BookLevel[] = [];
    try {
      asks = await this.fetchBook(tokenId);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    const bestAsk = asks[0]?.price ?? book?.ask ?? null;
    const bestBid = book?.bid ?? null;
    const maxPrice =
      bestAsk === null ? Number.POSITIVE_INFINITY : bestAsk + this.options.maxSlippage;
    const walked = walkAsks(asks, this.options.notionalUsd, maxPrice);
    const fill: FillSimulation = {
      ...walked,
      bestBid,
      edgeVsSource: walked.vwap === null ? null : round4(nextFair - walked.vwap),
    };

    const movedDuringLock = extra.polyMovedDuringLock ?? null;
    let verdict: SignalVerdict;
    let reason: string;
    if (
      movedDuringLock !== null &&
      Math.sign(movedDuringLock) === Math.sign(delta) &&
      Math.abs(movedDuringLock) >= Math.abs(delta) * 0.6
    ) {
      verdict = "already_priced";
      reason = `锁盘期间 Poly 已同向移动 ${round4(movedDuringLock * 100).toFixed(1)}pp，解锁后优势可能已被吃掉`;
    } else if (polyMid !== null && Math.abs(polyMid - nextFair) <= this.tickSize) {
      verdict = "already_priced";
      reason = "Polymarket 中价已接近源站公平价，信号优势不大";
    } else if (fill.bestAsk === null || fill.levelsTaken === 0) {
      verdict = "no_liquidity";
      reason = "Polymarket 卖盘为空或不可用";
    } else if (fill.edgeVsSource !== null && fill.edgeVsSource < 0.005) {
      verdict = "no_edge";
      reason = `吃进后相对源站公平价几乎无边际（edge=${fill.edgeVsSource}）`;
    } else if (fill.fillable) {
      verdict = "fillable";
      reason =
        extra.kind === "unlock"
          ? `解锁后可按 ask+${this.options.maxSlippage} 吃满 $${this.options.notionalUsd}`
          : `可按不超过 ask+${this.options.maxSlippage} 吃满 $${this.options.notionalUsd}`;
    } else if (fill.filledUsd > 0) {
      verdict = "partial";
      reason = `仅能部分成交 $${fill.filledUsd.toFixed(2)} / $${this.options.notionalUsd}`;
    } else {
      verdict = "no_liquidity";
      reason = "滑点限制内无可吃卖单";
    }

    const signal: SignalEvent = {
      id: `${extra.kind ?? "jump"}-${now}-${outcomeIndex}`,
      kind: extra.kind ?? "jump",
      at: now,
      sourceMarketId: this.bound.marketId,
      outcome,
      tokenId,
      side: "BUY",
      sourcePrev: round4(prevFair),
      sourceFair: round4(nextFair),
      sourceDelta: round4(delta),
      polyMidAtSignal: polyMid,
      polyAskAtSignal: bestAsk,
      polyBidAtSignal: bestBid,
      polyMidAtLock: extra.polyMidAtLock ?? null,
      polyMovedDuringLock: movedDuringLock,
      lockDurationMs: extra.lockDurationMs ?? null,
      fill,
      verdict,
      reason,
      polyMovedAt: null,
      polyLagMs: null,
      polyMidAfter: null,
    };
    this.signals = [signal, ...this.signals].slice(0, 100);
    this.lagWatches.set(signal.id, {
      signalId: signal.id,
      tokenId,
      direction: delta >= 0 ? 1 : -1,
      baselineMid: polyMid ?? bestAsk ?? nextFair,
      threshold: this.options.polyLagTicks * this.tickSize,
      createdAt: now,
    });
    this.emitter.emit("signal", signal);
    this.publish();
  }

  private checkLagWatches(): void {
    for (const [id, watch] of this.lagWatches) {
      const book = this.books.get(watch.tokenId);
      if (!book || book.bid === null || book.ask === null) continue;
      const mid = (book.bid + book.ask) / 2;
      const moved =
        watch.direction > 0
          ? mid >= watch.baselineMid + watch.threshold
          : mid <= watch.baselineMid - watch.threshold;
      if (!moved) continue;
      const signal = this.signals.find((item) => item.id === id);
      if (signal) {
        signal.polyMovedAt = Date.now();
        signal.polyLagMs = Date.now() - signal.at;
        signal.polyMidAfter = round4(mid);
      }
      this.lagWatches.delete(id);
    }
  }

  private expireLagWatches(): void {
    const now = Date.now();
    for (const [id, watch] of this.lagWatches) {
      if (now - watch.createdAt < 30_000) continue;
      this.lagWatches.delete(id);
    }
  }
}
