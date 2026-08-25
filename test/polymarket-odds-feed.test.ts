import assert from "node:assert/strict";
import test from "node:test";
import {
  PolymarketOddsFeed,
  type PolymarketWebSocketConnection,
} from "../src/polymarket/odds-feed.js";
import type { PolymarketOddsSnapshot } from "../src/types.js";

class FakeWebSocket {
  readyState = 1;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.terminate();
  }

  terminate(): void {
    this.readyState = 3;
    this.emit("close");
  }

  on(event: string, listener: unknown): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener as (...args: unknown[]) => void);
    this.listeners.set(event, listeners);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

test("streams best bid and ask updates from Polymarket WebSocket", async () => {
  const market = {
    eventSlug: "event",
    marketSlug: "event",
    round: 0,
    outcomes: ["LGD NBW", "Rogue Warriors"] as const,
    referencePrices: [0.4, 0.6] as const,
    tokenIds: ["lgd-token", "rw-token"] as const,
    acceptingOrders: true,
  };
  const initial: PolymarketOddsSnapshot = {
    eventSlug: "event",
    marketSlug: "event",
    round: 0,
    outcomes: market.outcomes,
    prices: [0.42, 0.62],
    bestBids: [0.38, 0.58],
    referencePrices: market.referencePrices,
    tradingOpen: true,
    receivedAt: 1,
  };
  const socket = new FakeWebSocket();
  const feed = new PolymarketOddsFeed(
    {
      resolveWinnerMarkets: async () => [market],
      fetchWinnerBooks: async () => [initial],
    },
    "wss://example.test/ws/market",
    () => socket as unknown as PolymarketWebSocketConnection,
  );

  const streamed = new Promise<PolymarketOddsSnapshot[]>((resolve) => {
    let updates = 0;
    feed.on("odds", (snapshots) => {
      updates += 1;
      if (updates === 2) resolve(snapshots);
    });
  });
  feed.on("error", (error) => {
    throw error;
  });
  feed.on("connected", () => {
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          event_type: "price_change",
          price_changes: [
            {
              asset_id: "lgd-token",
              best_bid: "0.39",
              best_ask: "0.41",
            },
          ],
        }),
      ),
    );
  });

  feed.start(["event"]);
  setImmediate(() => socket.emit("open"));
  const snapshots = await streamed;
  feed.stop();

  assert.deepEqual(JSON.parse(socket.sent[0] ?? "{}"), {
    assets_ids: ["lgd-token", "rw-token"],
    type: "market",
    custom_feature_enabled: true,
  });
  assert.deepEqual(snapshots[0]?.prices, [0.41, 0.62]);
  assert.deepEqual(snapshots[0]?.bestBids, [0.39, 0.58]);
});
