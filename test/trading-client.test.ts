import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SecureClient, SecureClientOptions } from "@polymarket/client";
import { AuditLog } from "../src/logger.js";
import {
  assertDepositWalletType,
  isRetryableClobAuthError,
  PolymarketTradingClient,
  type TradingClientOptions,
} from "../src/polymarket/trading-client.js";

const PRIVATE_KEY = `0x${"1".repeat(64)}`;
const FUNDER = `0x${"2".repeat(40)}`;
const CREDENTIALS = {
  key: "cached-key",
  secret: "cached-secret",
  passphrase: "cached-passphrase",
};

function fakeSecureClient(credentials = CREDENTIALS): SecureClient {
  return {
    account: {
      signer: `0x${"3".repeat(40)}`,
      wallet: FUNDER,
      walletType: 3,
    },
    credentials,
  } as unknown as SecureClient;
}

async function withTradingOptions(
  run: (options: TradingClientOptions, credentialsPath: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "poly-maker-auth-"));
  const credentialsPath = join(directory, "clob-api-creds.json");
  const options: TradingClientOptions = {
    privateKey: PRIVATE_KEY,
    funder: FUNDER,
    chainId: 137,
    clobUrl: "https://clob.example.test",
    audit: new AuditLog(join(directory, "audit.ndjson")),
    setupApprovals: false,
    credentialsPath,
    authRetryDelaysMs: [0, 0, 0, 0],
    deriveCredentialsFactory: async () => CREDENTIALS,
    preflightFactory: async () => undefined,
  };
  try {
    await run(options, credentialsPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("type=3 preflight rejects non-Deposit Wallet identities", () => {
  assert.doesNotThrow(() => assertDepositWalletType(3));
  assert.throws(() => assertDepositWalletType(0), /DEPOSIT_WALLET/);
  assert.throws(() => assertDepositWalletType(2), /DEPOSIT_WALLET/);
});

test("CLOB auth retry classification only accepts transient transport failures", () => {
  const transport = new Error("connection interrupted");
  transport.name = "TransportError";
  assert.equal(isRetryableClobAuthError(transport), true);
  assert.equal(
    isRetryableClobAuthError(
      new Error("Request timed out: POST https://clob.polymarket.com/auth/api-key"),
    ),
    true,
  );
  assert.equal(isRetryableClobAuthError(new Error("read ECONNRESET")), true);
  assert.equal(isRetryableClobAuthError(new Error("order rejected: insufficient balance")), false);
  assert.equal(
    isRetryableClobAuthError(new Error("Polymarket account is in closed-only mode")),
    false,
  );
});

test("create retries transient CLOB auth failures and resolves", async () => {
  await withTradingOptions(async (options) => {
    let attempts = 0;
    options.createSecureClientFactory = async () => {
      attempts += 1;
      if (attempts <= 2) {
        throw new Error("Request timed out: POST https://clob.polymarket.com/auth/api-key");
      }
      return fakeSecureClient();
    };

    const client = await PolymarketTradingClient.create(options);
    assert.equal(client.wallet, FUNDER);
    assert.equal(attempts, 3);
  });
});

test("create throws the last error after transient auth retries are exhausted", async () => {
  await withTradingOptions(async (options) => {
    const failures = Array.from(
      { length: 5 },
      (_, index) => new Error(`network timeout ${index + 1}`),
    );
    let attempts = 0;
    options.createSecureClientFactory = async () => {
      const error = failures[attempts];
      attempts += 1;
      throw error;
    };

    await assert.rejects(PolymarketTradingClient.create(options), (error) => {
      assert.equal(error, failures[4]);
      return true;
    });
    assert.equal(attempts, 5);
  });
});

test("create reuses cached credentials on the next start", async () => {
  await withTradingOptions(async (options, credentialsPath) => {
    options.createSecureClientFactory = async () => fakeSecureClient();
    await PolymarketTradingClient.create(options);

    let received: SecureClientOptions | undefined;
    let deriveCalls = 0;
    await PolymarketTradingClient.create({
      ...options,
      deriveCredentialsFactory: async () => {
        deriveCalls += 1;
        return CREDENTIALS;
      },
      createSecureClientFactory: async (factoryOptions) => {
        received = factoryOptions;
        return fakeSecureClient();
      },
    });

    assert.deepEqual(received?.credentials, CREDENTIALS);
    assert.equal(deriveCalls, 0);
    assert.equal((await stat(credentialsPath)).mode & 0o777, 0o600);
  });
});

test("create drops a rejected cache and retries without credentials", async () => {
  await withTradingOptions(async (options) => {
    options.createSecureClientFactory = async () => fakeSecureClient();
    await PolymarketTradingClient.create(options);

    const replacement = {
      key: "replacement-key",
      secret: "replacement-secret",
      passphrase: "replacement-passphrase",
    };
    const received: Array<SecureClientOptions["credentials"]> = [];
    await PolymarketTradingClient.create({
      ...options,
      createSecureClientFactory: async (factoryOptions) => {
        received.push(factoryOptions.credentials);
        if (received.length === 1) {
          const error = new Error("API key is invalid") as Error & { status: number };
          error.status = 401;
          throw error;
        }
        return fakeSecureClient(replacement);
      },
    });

    assert.deepEqual(received, [CREDENTIALS, undefined]);

    let nextCredentials: SecureClientOptions["credentials"];
    await PolymarketTradingClient.create({
      ...options,
      createSecureClientFactory: async (factoryOptions) => {
        nextCredentials = factoryOptions.credentials;
        return fakeSecureClient(replacement);
      },
    });
    assert.deepEqual(nextCredentials, replacement);
  });
});
