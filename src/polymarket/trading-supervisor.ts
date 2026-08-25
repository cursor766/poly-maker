import type { AuditLog } from "../logger.js";
import type { TradingGateway } from "./trading-client.js";

export interface TradingSupervisorOptions {
  heartbeatIntervalMs: number;
  heartbeatMaxFailures: number;
  accountSyncMs: number;
}

export class TradingSupervisor {
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private syncTimer: NodeJS.Timeout | undefined;
  private heartbeatId: string | undefined;
  private heartbeatFailures = 0;
  private heartbeatPending = false;
  private unsubscribeUser: (() => Promise<void>) | undefined;

  get heartbeatHealthy(): boolean {
    return this.heartbeatFailures < this.options.heartbeatMaxFailures;
  }

  constructor(
    private readonly gateway: TradingGateway,
    private readonly audit: AuditLog,
    private readonly options: TradingSupervisorOptions,
    private readonly onUnsafe: (reason: string) => Promise<void>,
    private readonly onAccountSync: () => Promise<void>,
  ) {}

  async start(): Promise<void> {
    this.unsubscribeUser = await this.gateway.subscribeUser((event) => {
      void this.handleUserEvent(event);
    });
    await this.sendHeartbeat();
    this.heartbeatTimer = setInterval(
      () => void this.sendHeartbeat(),
      this.options.heartbeatIntervalMs,
    );
    this.syncTimer = setInterval(() => void this.syncAccount(), this.options.accountSyncMs);
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.heartbeatTimer = undefined;
    this.syncTimer = undefined;
    await this.unsubscribeUser?.();
    this.unsubscribeUser = undefined;
  }

  private async sendHeartbeat(): Promise<void> {
    if (this.heartbeatPending) return;
    this.heartbeatPending = true;
    try {
      this.heartbeatId = await this.gateway.postHeartbeat(this.heartbeatId);
      this.heartbeatFailures = 0;
      await this.audit.write("heartbeat_ok", { heartbeatId: this.heartbeatId });
    } catch (error) {
      this.heartbeatFailures += 1;
      await this.audit.write("heartbeat_failed", {
        failures: this.heartbeatFailures,
        error: error instanceof Error ? error.message : String(error),
      });
      if (this.heartbeatFailures >= this.options.heartbeatMaxFailures) {
        await this.onUnsafe("heartbeat-failed");
      }
    } finally {
      this.heartbeatPending = false;
    }
  }

  private async handleUserEvent(event: unknown): Promise<void> {
    const record =
      typeof event === "object" && event !== null ? (event as Record<string, unknown>) : {};
    await this.audit.write("polymarket_user_event", {
      type: record.type ?? "unknown",
      status: record.status,
      orderId: record.orderId ?? record.order_id,
      tokenId: record.tokenId ?? record.asset_id,
    });
    if (record.type === "stream_error") {
      await this.onUnsafe("polymarket-user-stream-error");
      return;
    }
    await this.syncAccount();
  }

  private async syncAccount(): Promise<void> {
    try {
      await this.onAccountSync();
    } catch (error) {
      await this.audit.write("account_sync_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      await this.onUnsafe("account-sync-failed");
    }
  }
}
