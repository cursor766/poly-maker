import { EventEmitter } from "node:events";
import WebSocket, { type RawData } from "ws";
import type { PolymarketOddsSnapshot } from "../types.js";
import type { PolymarketWinnerMarket } from "./odds-client.js";

interface TopOfBook {
  bid: number | null;
  ask: number | null;
}

export interface PolymarketWebSocketConnection {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  terminate(): void;
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: RawData) => void): this;
  on(event: "close", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

type WebSocketFactory = (url: string) => PolymarketWebSocketConnection;

interface PolymarketOddsFeedEvents {
  odds: [PolymarketOddsSnapshot[]];
  error: [Error];
  connected: [];
  disconnected: [];
}

interface PolymarketOddsSource {
  resolveWinnerMarkets(eventSlug: string): Promise<PolymarketWinnerMarket[]>;
  fetchWinnerBooks(markets: readonly PolymarketWinnerMarket[]): Promise<PolymarketOddsSnapshot[]>;
}

function price(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 1 ? parsed : null;
}

function topPrice(value: unknown, side: "bid" | "ask"): number | null {
  if (!Array.isArray(value)) return null;
  const prices = value.flatMap((level) => {
    if (typeof level !== "object" || level === null) return [];
    const record = level as Record<string, unknown>;
    const parsedPrice = price(record.price);
    const size = Number(record.size);
    return parsedPrice !== null && Number.isFinite(size) && size > 0 ? [parsedPrice] : [];
  });
  if (prices.length === 0) return null;
  return side === "bid" ? Math.max(...prices) : Math.min(...prices);
}

function records(payload: unknown): Record<string, unknown>[] {
  const values = Array.isArray(payload) ? payload : [payload];
  return values.filter(
    (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
  );
}

export class PolymarketOddsFeed {
  private readonly emitter = new EventEmitter();
  private socket: PolymarketWebSocketConnection | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private stopped = true;
  private reconnectDelay = 1_000;
  private eventSlugs: string[] = [];
  private markets: PolymarketWinnerMarket[] = [];
  private readonly books = new Map<string, TopOfBook>();
  private readonly closedMarketSlugs = new Set<string>();

  constructor(
    private readonly client: PolymarketOddsSource,
    private readonly webSocketUrl: string,
    private readonly webSocketFactory: WebSocketFactory = (url) =>
      new WebSocket(url) as PolymarketWebSocketConnection,
  ) {}

  on<K extends keyof PolymarketOddsFeedEvents>(
    event: K,
    listener: (...args: PolymarketOddsFeedEvents[K]) => void,
  ): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  start(eventSlugs: readonly string[]): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.eventSlugs = [...new Set(eventSlugs)];
    void this.bootstrap();
  }

  updateSubscriptions(eventSlugs: readonly string[]): void {
    const next = [...new Set(eventSlugs)];
    if (
      next.length === this.eventSlugs.length &&
      next.every((slug) => this.eventSlugs.includes(slug))
    ) {
      return;
    }
    this.stop();
    this.start(next);
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeat = undefined;
    this.reconnectTimer = undefined;
    this.socket?.terminate();
    this.socket = undefined;
  }

  private async bootstrap(): Promise<void> {
    try {
      this.markets = (
        await Promise.all(this.eventSlugs.map((slug) => this.client.resolveWinnerMarkets(slug)))
      ).flat();
      this.closedMarketSlugs.clear();
      const snapshots = await this.client.fetchWinnerBooks(this.markets);
      this.seedBooks(snapshots);
      this.emitter.emit("odds", snapshots);
      this.connect();
    } catch (error) {
      this.emitError(error);
      this.scheduleReconnect();
    }
  }

  private connect(): void {
    if (this.stopped || this.markets.length === 0) return;
    const socket = this.webSocketFactory(this.webSocketUrl);
    this.socket = socket;
    socket.on("open", () => {
      this.reconnectDelay = 1_000;
      socket.send(
        JSON.stringify({
          assets_ids: this.markets.flatMap((market) => market.tokenIds),
          type: "market",
          custom_feature_enabled: true,
        }),
      );
      this.heartbeat = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send("PING");
      }, 10_000);
      this.emitter.emit("connected");
    });
    socket.on("message", (data) => this.handleMessage(data));
    socket.on("error", (error) => this.emitError(error));
    socket.on("close", () => {
      if (this.socket !== socket) return;
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = undefined;
      this.socket = undefined;
      this.emitter.emit("disconnected");
      this.scheduleReconnect();
    });
  }

  private handleMessage(data: RawData): void {
    const text = data.toString();
    if (text === "PONG") return;
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return;
    }

    let changed = false;
    for (const event of records(payload)) {
      const eventType = event.event_type;
      if (eventType === "book" && typeof event.asset_id === "string") {
        this.books.set(event.asset_id, {
          bid: topPrice(event.bids, "bid"),
          ask: topPrice(event.asks, "ask"),
        });
        changed = true;
      } else if (eventType === "best_bid_ask" && typeof event.asset_id === "string") {
        this.books.set(event.asset_id, {
          bid: price(event.best_bid),
          ask: price(event.best_ask),
        });
        changed = true;
      } else if (eventType === "price_change" && Array.isArray(event.price_changes)) {
        for (const change of records(event.price_changes)) {
          if (typeof change.asset_id !== "string") continue;
          this.books.set(change.asset_id, {
            bid: price(change.best_bid),
            ask: price(change.best_ask),
          });
          changed = true;
        }
      } else if (eventType === "market_resolved" && typeof event.winning_asset_id === "string") {
        const market = this.markets.find((item) =>
          item.tokenIds.includes(event.winning_asset_id as string),
        );
        if (market) {
          this.closedMarketSlugs.add(market.marketSlug);
          changed = true;
        }
      }
    }
    if (changed) this.emitter.emit("odds", this.snapshots());
  }

  private seedBooks(snapshots: readonly PolymarketOddsSnapshot[]): void {
    this.books.clear();
    for (const snapshot of snapshots) {
      const market = this.markets.find((item) => item.marketSlug === snapshot.marketSlug);
      if (!market) continue;
      this.books.set(market.tokenIds[0], {
        bid: snapshot.bestBids[0],
        ask: snapshot.prices[0],
      });
      this.books.set(market.tokenIds[1], {
        bid: snapshot.bestBids[1],
        ask: snapshot.prices[1],
      });
    }
  }

  private snapshots(): PolymarketOddsSnapshot[] {
    const receivedAt = Date.now();
    return this.markets.map((market) => {
      const first = this.books.get(market.tokenIds[0]);
      const second = this.books.get(market.tokenIds[1]);
      return {
        eventSlug: market.eventSlug,
        marketSlug: market.marketSlug,
        round: market.round,
        outcomes: market.outcomes,
        prices: [first?.ask ?? null, second?.ask ?? null],
        bestBids: [first?.bid ?? null, second?.bid ?? null],
        referencePrices: market.referencePrices,
        tradingOpen: market.acceptingOrders && !this.closedMarketSlugs.has(market.marketSlug),
        receivedAt,
      };
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.bootstrap();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
  }

  private emitError(error: unknown): void {
    this.emitter.emit("error", error instanceof Error ? error : new Error(String(error)));
  }
}
