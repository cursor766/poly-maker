import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type ApiKey, toApiKey } from "@polymarket/bindings";
import { AssetType } from "@polymarket/bindings/clob";
import {
  createSecureClient,
  forkEnvironmentConfig,
  OrderSide,
  type SecureClient,
  type SecureClientOptions,
  WalletType,
} from "@polymarket/client";
import { fetchBalanceAllowance } from "@polymarket/client/actions";
import { privateKey } from "@polymarket/client/viem";
import { ClobClient, createL1Headers, SignatureType } from "@polymarket/clob-client";
import type { Logger } from "pino";
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
  logger?: Pick<Logger, "warn">;
  credentialsPath?: string;
  createSecureClientFactory?: SecureClientFactory;
  deriveCredentialsFactory?: DeriveCredentialsFactory;
  authRetryDelaysMs?: readonly number[];
  preflightFactory?: (client: PolymarketTradingClient) => Promise<void>;
}

export interface ClobApiCredentials {
  key: ApiKey;
  secret: string;
  passphrase: string;
}

interface CachedClobApiCredentials extends ClobApiCredentials {
  funder: string;
}

type SecureClientFactory = (options: SecureClientOptions) => Promise<SecureClient>;
type DeriveCredentialsFactory = (
  clobUrl: string,
  chainId: number,
  signerPrivateKey: string,
  retry: <T>(operation: () => Promise<T>) => Promise<T>,
) => Promise<ClobApiCredentials>;

export interface AuthRetryOptions {
  delaysMs?: readonly number[];
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void | Promise<void>;
}

const DEFAULT_AUTH_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;
const DEFAULT_CREDENTIALS_PATH = "data/clob-api-creds.json";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorNames(error: unknown): string {
  if (typeof error !== "object" || error === null) return "";
  const candidate = error as { name?: unknown; constructor?: { name?: unknown } };
  return [candidate.name, candidate.constructor?.name]
    .filter((name): name is string => typeof name === "string")
    .join(" ");
}

export function isRetryableClobAuthError(error: unknown): boolean {
  const names = errorNames(error);
  if (/\b(?:TimeoutError|TransportError)\b/.test(names)) return true;
  return /timed?\s*out|timeout|econnreset|econnrefused|etimedout|fetch failed|socket hang up|network/i.test(
    `${names} ${errorMessage(error)}`,
  );
}

function retryMessage(error: unknown): string {
  const details = `${errorNames(error)} ${errorMessage(error)}`;
  if (/timed?\s*out|timeout|etimedout/i.test(details)) return "request timed out";
  if (/econnreset|socket hang up/i.test(details)) return "connection reset";
  if (/econnrefused/i.test(details)) return "connection refused";
  if (/fetch failed|network/i.test(details)) return "network transport error";
  return "CLOB transport error";
}

export async function retryClobAuth<T>(
  operation: () => Promise<T>,
  options: AuthRetryOptions = {},
): Promise<T> {
  const delaysMs = options.delaysMs ?? DEFAULT_AUTH_RETRY_DELAYS_MS;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const delayMs = delaysMs[attempt - 1];
      if (!isRetryableClobAuthError(error) || delayMs === undefined) throw error;
      await options.onRetry?.(attempt, error, delayMs);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as {
    status?: unknown;
    response?: { status?: unknown };
    cause?: { status?: unknown; response?: { status?: unknown } };
  };
  const statuses = [
    candidate.status,
    candidate.response?.status,
    candidate.cause?.status,
    candidate.cause?.response?.status,
  ];
  return statuses.find((status): status is number => typeof status === "number");
}

function isInvalidCredentialsError(error: unknown): boolean {
  return (
    errorStatus(error) === 401 ||
    /\b401\b|unauthori[sz]ed|invalid (?:api )?key|invalid credentials|credentials? (?:are )?invalid/i.test(
      errorMessage(error),
    )
  );
}

function isMissingDerivedKeyError(error: unknown): boolean {
  return errorStatus(error) === 400 || /\b400\b/.test(errorMessage(error));
}

function parseCredentials(value: unknown): ClobApiCredentials | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.key !== "string" ||
    typeof candidate.secret !== "string" ||
    typeof candidate.passphrase !== "string"
  ) {
    return undefined;
  }
  return {
    key: toApiKey(candidate.key),
    secret: candidate.secret,
    passphrase: candidate.passphrase,
  };
}

async function readCachedCredentials(
  path: string,
  funder: string,
): Promise<ClobApiCredentials | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const cached = parsed as Partial<CachedClobApiCredentials>;
    if (cached.funder?.toLowerCase() !== funder.toLowerCase()) return undefined;
    return parseCredentials(cached);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function writeCachedCredentials(
  path: string,
  funder: string,
  credentials: ClobApiCredentials,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  const contents = `${JSON.stringify({ funder, ...credentials })}\n`;
  await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
}

async function deleteCachedCredentials(path: string): Promise<void> {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function deriveCredentials(
  clobUrl: string,
  chainId: number,
  signerPrivateKey: string,
  retry: <T>(operation: () => Promise<T>) => Promise<T>,
): Promise<ClobApiCredentials> {
  const account = privateKeyToAccount(signerPrivateKey as `0x${string}`);
  const signer = createWalletClient({ account, chain: polygon, transport: http() });
  const requestCredentials = async (
    method: "GET" | "POST",
    path: string,
  ): Promise<ClobApiCredentials> => {
    const headers = await createL1Headers(signer, chainId);
    const response = await fetch(new URL(path, clobUrl), {
      method,
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const error = new Error(`CLOB auth request rejected (${response.status})`) as Error & {
        status: number;
      };
      error.status = response.status;
      throw error;
    }
    const body = (await response.json()) as Record<string, unknown>;
    const credentials = parseCredentials({
      key: body.apiKey ?? body.key,
      secret: body.secret,
      passphrase: body.passphrase,
    });
    if (!credentials) throw new Error("CLOB auth returned invalid credentials");
    return credentials;
  };
  try {
    return await retry(() => requestCredentials("GET", "/auth/derive-api-key"));
  } catch (error) {
    if (!isMissingDerivedKeyError(error)) throw error;
    return retry(() => requestCredentials("POST", "/auth/api-key"));
  }
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
    const credentialsPath = options.credentialsPath ?? DEFAULT_CREDENTIALS_PATH;
    const cachedCredentials = await readCachedCredentials(credentialsPath, options.funder);
    const retry = <T>(operation: () => Promise<T>) =>
      retryClobAuth(operation, {
        ...(options.authRetryDelaysMs ? { delaysMs: options.authRetryDelaysMs } : {}),
        onRetry: async (attempt, error, delayMs) => {
          const message = retryMessage(error);
          options.logger?.warn({ attempt, delayMs, message }, "CLOB auth timed out, retrying");
          await options.audit.write("trading_auth_retry", { attempt, delayMs, message });
        },
      });
    const environment = forkEnvironmentConfig({
      name: "poly-maker",
      chainId: options.chainId,
      clob: { rest: options.clobUrl },
    });
    const signer = privateKey(signerPrivateKey);
    const factory = options.createSecureClientFactory ?? createSecureClient;
    const credentials =
      cachedCredentials ??
      (await (options.deriveCredentialsFactory ?? deriveCredentials)(
        options.clobUrl,
        options.chainId,
        signerPrivateKey,
        retry,
      ));
    let client: SecureClient;
    try {
      client = await retry(() =>
        factory({
          wallet: options.funder,
          signer,
          credentials,
          environment,
        }),
      );
    } catch (error) {
      if (!cachedCredentials || !isInvalidCredentialsError(error)) throw error;
      await deleteCachedCredentials(credentialsPath);
      client = await retry(() =>
        factory({
          wallet: options.funder,
          signer,
          environment,
        }),
      );
    }
    await writeCachedCredentials(credentialsPath, options.funder, client.credentials);
    const trading = new PolymarketTradingClient(
      client,
      options.audit,
      options.clobUrl,
      options.chainId,
      signerPrivateKey,
      options.funder,
      options.setupApprovals,
    );
    await (options.preflightFactory ?? ((client) => client.preflight()))(trading);
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
