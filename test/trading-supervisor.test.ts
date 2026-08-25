import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuditLog } from "../src/logger.js";
import type { TradingGateway, TradingPreflight } from "../src/polymarket/trading-client.js";
import { TradingSupervisor } from "../src/polymarket/trading-supervisor.js";
import type { ManagedOrder, PositionState, Quote } from "../src/types.js";

class FailingHeartbeatGateway implements TradingGateway {
  readonly wallet = "0x0000000000000000000000000000000000000001";

  async preflight(): Promise<TradingPreflight> {
    throw new Error("unused");
  }

  async listOpenOrders(_conditionId?: string): Promise<ManagedOrder[]> {
    return [];
  }

  async placeLimitOrder(_quote: Quote): Promise<string> {
    throw new Error("unused");
  }

  async cancelOrders(_orderIds: readonly string[]): Promise<void> {}
  async cancelMarketOrders(_conditionId: string): Promise<void> {}

  async syncPositions(_conditionIds: readonly string[]): Promise<PositionState> {
    return { byToken: new Map(), cash: 0 };
  }

  async postHeartbeat(_heartbeatId?: string): Promise<string> {
    throw new Error("heartbeat unavailable");
  }

  async subscribeUser(_onEvent: (event: unknown) => void): Promise<() => Promise<void>> {
    return async () => {};
  }

  async close(): Promise<void> {}
}

test("heartbeat failure triggers the protective callback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "poly-maker-heartbeat-"));
  try {
    const reasons: string[] = [];
    const supervisor = new TradingSupervisor(
      new FailingHeartbeatGateway(),
      new AuditLog(join(directory, "audit.ndjson")),
      { heartbeatIntervalMs: 5_000, heartbeatMaxFailures: 1, accountSyncMs: 10_000 },
      async (reason) => {
        reasons.push(reason);
      },
      async () => {},
    );
    await supervisor.start();
    assert.deepEqual(reasons, ["heartbeat-failed"]);
    assert.equal(supervisor.heartbeatHealthy, false);
    await supervisor.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
