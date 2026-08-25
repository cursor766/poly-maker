import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { BookLevel, Quote, RestingOrder, TradingMode } from "../types.js";

export interface MarketRuntimeStatus {
  name: string;
  round: number;
  polymarketSlug: string;
  sourceMarketId: string;
  conditionId: string;
  outcomes: readonly [string, string];
  tokenIds: readonly [string, string];
  locked: boolean;
  operatorPaused: boolean;
  reason?: string;
  rejectDetail?: string;
  sourceOpen: boolean | null;
  sourceLocked: boolean;
  fairPrices: Record<string, number>;
  plannedQuotes: Quote[];
  openOrders: Array<RestingOrder & { outcome: string }>;
  books: Record<string, { bids: BookLevel[]; asks: BookLevel[]; receivedAt: number }>;
  openOrderCount: number;
  openOrderNotional: number;
  notionalUsed: number;
  positions: Record<string, number>;
}

export interface MakerRuntimeStatus {
  running: true;
  mode: TradingMode;
  startedAt: number;
  updatedAt: number;
  mqttConnected: boolean;
  polymarketConnected: boolean;
  cash: number;
  accountNotionalUsed: number;
  accountNotionalLimit: number;
  markets: MarketRuntimeStatus[];
}

export class StatusReporter {
  private timer: NodeJS.Timeout | undefined;
  private writing = false;

  constructor(
    private readonly path: string,
    private readonly snapshot: () => MakerRuntimeStatus,
    private readonly intervalMs = 1_000,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.write();
    this.timer = setInterval(() => void this.write(), this.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.write();
  }

  private async write(): Promise<void> {
    if (this.writing) return;
    this.writing = true;
    try {
      const path = resolve(this.path);
      await mkdir(dirname(path), { recursive: true });
      const temporaryPath = `${path}.${process.pid}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(this.snapshot(), null, 2)}\n`, "utf8");
      await rename(temporaryPath, path);
    } finally {
      this.writing = false;
    }
  }
}
