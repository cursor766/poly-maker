import { AssetType } from "@polymarket/bindings/clob";
import { createSecureClient, OrderSide, type SecureClient, WalletType } from "@polymarket/client";
import { fetchBalanceAllowance } from "@polymarket/client/actions";
import { privateKey } from "@polymarket/client/viem";
import { ClobClient, SignatureType } from "@polymarket/clob-client";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import type { AuditLog } from "../logger.js";
import { clobPrice, clobSize } from "../strategy/tick.js";
import type { ManagedOrder, PositionState, Quote } from "../types.js";

export interface TradingPreflight {
  signer: string;
  wallet: string;
  walletType: number;
  balance: number;
  allowanceReady: boolean;
  closedOnly: boolean;
}

export interface TradingGateway {
  readonly wallet: string;
  preflight(): Promise<TradingPreflight>;
  listOpenOrders(conditionId?: string): Promise<ManagedOrder[]>;
  placeLimitOrder(quote: Quote): Promise<string>;
  cancelOrders(orderIds: readonly string[]): Promise<void>;
  cancelMarketOrders(conditionId: string): Promise<void>;
  syncPositions(conditionIds: readonly string[]): Promise<PositionState>;
  postHeartbeat(heartbeatId?: string): Promise<string>;
  subscribeUser(onEvent: (event: unknown) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

export interface TradingClientOptions {
  privateKey: string;
  funder: string;
  chainId: number;
  clobUrl: string;
  audit: AuditLog;
  setupApprovals: boolean;
}

function parseBaseUnits(value: unknown): number {
  if (typeof value === "bigint") return Number(value) / 1_000_000;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed / 1_000_000 : 0;
}

export function assertDepositWalletType(walletType: number): void {
  if (walletType !== WalletType.DEPOSIT_WALLET) {
    throw new Error(`wallet must be DEPOSIT_WALLET, received type ${walletType}`);
  }
}

export class PolymarketTradingClient implements TradingGateway {
  readonly wallet: string;
  private readonly heartbeatClient: ClobClient;

  private constructor(
    private readonly client: SecureClient,
    private readonly audit: AuditLog,
    clobUrl: string,
    chainId: number,
    signerPrivateKey: string,
    funder: string,
    private readonly setupApprovals: boolean,
  ) {
    this.wallet = client.account.wallet;
    const credentials = client.credentials;
    const account = privateKeyToAccount(signerPrivateKey as `0x${string}`);
    const heartbeatSigner = createWalletClient({ account, chain: polygon, transport: http() });
    this.heartbeatClient = new ClobClient(
      clobUrl,
      chainId,
      heartbeatSigner,
      {
        key: String(credentials.key),
        secret: credentials.secret,
        passphrase: credentials.passphrase,
      },
      SignatureType.EOA,
      funder,
    );
  }

  static async create(options: TradingClientOptions): Promise<PolymarketTradingClient> {
    if (options.chainId !== 137) throw new Error("type=3 client requires Polygon chain 137");
    const signerPrivateKey = options.privateKey.startsWith("0x")
      ? options.privateKey
      : `0x${options.privateKey}`;
    const client = await createSecureClient({
      wallet: options.funder,
      signer: privateKey(signerPrivateKey),
    });
    const trading = new PolymarketTradingClient(
      client,
      options.audit,
      options.clobUrl,
      options.chainId,
      signerPrivateKey,
      options.funder,
      options.setupApprovals,
    );
    await trading.preflight();
    return trading;
  }

  async preflight(): Promise<TradingPreflight> {
    const account = this.client.account;
    assertDepositWalletType(account.walletType);
    const closedOnly = await this.client.fetchClosedOnlyMode();
    if (closedOnly) throw new Error("Polymarket account is in closed-only mode");
    let balanceAllowance = await fetchBalanceAllowance(this.client, {
      assetType: AssetType.COLLATERAL,
    });
    let allowanceReady = Object.values(balanceAllowance.allowances).some(
      (allowance) => parseBaseUnits(allowance) > 0,
    );
    if (!allowanceReady && this.setupApprovals) {
      await this.client.setupTradingApprovals();
      balanceAllowance = await fetchBalanceAllowance(this.client, {
        assetType: AssetType.COLLATERAL,
      });
      allowanceReady = Object.values(balanceAllowance.allowances).some(
        (allowance) => parseBaseUnits(allowance) > 0,
      );
    }
    const balance = parseBaseUnits(balanceAllowance.balance);
    if (!allowanceReady) {
      throw new Error("collateral allowance is missing; approve it before enabling trading");
    }
    const result: TradingPreflight = {
      signer: account.signer,
      wallet: account.wallet,
      walletType: account.walletType,
      balance,
      allowanceReady,
      closedOnly,
    };
    await this.audit.write("trading_preflight", {
      wallet: result.wallet,
      walletType: result.walletType,
      balance: result.balance,
      allowanceReady: result.allowanceReady,
      closedOnly: result.closedOnly,
    });
    return result;
  }

  async listOpenOrders(conditionId?: string): Promise<ManagedOrder[]> {
    const orders: ManagedOrder[] = [];
    const paginator = this.client.listOpenOrders(conditionId ? { market: conditionId } : undefined);
    for await (const page of paginator) {
      for (const order of page.items) {
        const side = order.side.toUpperCase();
        if (side !== "BUY" && side !== "SELL") continue;
        orders.push({
          id: order.id,
          conditionId: order.conditionId,
          tokenId: order.tokenId,
          side,
          price: Number(order.price),
          size: Number(order.originalSize),
          matchedSize: Number(order.sizeMatched),
        });
      }
    }
    return orders;
  }

  async placeLimitOrder(quote: Quote): Promise<string> {
    if (quote.side !== "BUY") throw new Error("live type=3 execution permits BUY-only orders");
    const response = await this.client.placeLimitOrder({
      tokenId: quote.tokenId,
      price: clobPrice(quote.price),
      size: clobSize(quote.size),
      side: OrderSide.BUY,
      postOnly: true,
    });
    if (!response.ok) throw new Error(`order rejected: ${response.code}: ${response.message}`);
    return response.orderId;
  }

  async cancelOrders(orderIds: readonly string[]): Promise<void> {
    if (orderIds.length === 0) return;
    await this.client.cancelOrders({ orderIds: [...orderIds] });
  }

  async cancelMarketOrders(conditionId: string): Promise<void> {
    await this.client.cancelMarketOrders({ market: conditionId });
  }

  async syncPositions(conditionIds: readonly string[]): Promise<PositionState> {
    const byToken = new Map<string, number>();
    const conditions = new Set(conditionIds);
    const paginator = this.client.listPositions({ pageSize: 100 });
    for await (const page of paginator) {
      for (const position of page.items) {
        if (!conditions.has(position.conditionId) || !position.tokenId) continue;
        byToken.set(position.tokenId, Number(position.size ?? 0));
      }
    }
    const collateral = await fetchBalanceAllowance(this.client, {
      assetType: AssetType.COLLATERAL,
    });
    return { byToken, cash: parseBaseUnits(collateral.balance) };
  }

  async postHeartbeat(heartbeatId?: string): Promise<string> {
    const response = await this.heartbeatClient.postHeartbeat(heartbeatId);
    return response.heartbeat_id;
  }

  async subscribeUser(onEvent: (event: unknown) => void): Promise<() => Promise<void>> {
    const handle = await this.client.subscribe([{ topic: "user" }] as const);
    let active = true;
    void (async () => {
      try {
        for await (const event of handle) {
          if (!active) break;
          onEvent(event);
        }
      } catch (error) {
        if (active) onEvent({ type: "stream_error", error });
      }
    })();
    return async () => {
      active = false;
      await handle.close();
    };
  }

  async close(): Promise<void> {
    await this.client.closeSubscriptions();
  }
}
