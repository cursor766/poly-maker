import assert from "node:assert/strict";
import test from "node:test";
import { assertDepositWalletType } from "../src/polymarket/trading-client.js";

test("type=3 preflight rejects non-Deposit Wallet identities", () => {
  assert.doesNotThrow(() => assertDepositWalletType(3));
  assert.throws(() => assertDepositWalletType(0), /DEPOSIT_WALLET/);
  assert.throws(() => assertDepositWalletType(2), /DEPOSIT_WALLET/);
});
