import assert from "node:assert/strict";
import test from "node:test";
import { buildSubscriptionTopics } from "../src/source/mqtt-client.js";
import { parseMqttMessage } from "../src/source/mqtt-parser.js";

test("parses batch odds publish payload", () => {
  const payload = Buffer.from(
    JSON.stringify([
      {
        market_id: "4619667554695260",
        match_id: "4619629212198122",
        id: "4619667554695960",
        odd: "1.962",
        return_rate: "94.0",
        odd_group: null,
      },
      {
        market_id: "4619667554695260",
        match_id: "4619629212198122",
        id: "4619667554695961",
        odd: "1.804",
        return_rate: "94.0",
        odd_group: null,
      },
    ]),
  );

  const message = parseMqttMessage("/market/odds/update", payload, 1234);
  assert.equal(message.kind, "odds");
  if (message.kind !== "odds") return;
  assert.equal(message.updates.length, 2);
  assert.deepEqual(message.updates[0], {
    marketId: "4619667554695260",
    matchId: "4619629212198122",
    oddId: "4619667554695960",
    decimalOdd: 1.962,
    returnRate: 94,
    receivedAt: 1234,
  });
});

test("ignores temporarily unavailable zero odds", () => {
  const payload = Buffer.from(
    JSON.stringify([{ market_id: "1", match_id: "2", id: "3", odd: "0", return_rate: "94" }]),
  );
  const message = parseMqttMessage("/market/odds/update", payload);
  assert.equal(message.kind, "odds");
  if (message.kind === "odds") assert.equal(message.updates.length, 0);
});

test("rejects structurally malformed odds", () => {
  const payload = Buffer.from(JSON.stringify([{ market_id: "1", odd: "2" }]));
  assert.throws(() => parseMqttMessage("/market/odds/update", payload));
});

test("parses match-specific odd insert messages", () => {
  const payload = Buffer.from(
    JSON.stringify({
      market_id: "5975531956975952",
      match_id: "match",
      id: "odd",
      odd: "2.05",
      return_rate: "94",
    }),
  );
  const message = parseMqttMessage("/odd/insert/5975531956975952", payload, 42);
  assert.equal(message.kind, "odds");
  if (message.kind === "odds") {
    assert.equal(message.updates[0]?.decimalOdd, 2.05);
  }
});

test("turns source market suspension events into locked state", () => {
  const payload = Buffer.from(JSON.stringify([{ market_id: "game1-winner", suspended: 1 }]));
  const message = parseMqttMessage("/market/action/suspended", payload, 99);
  assert.equal(message.kind, "state");
  if (message.kind !== "state") return;
  assert.deepEqual(message.states[0], {
    marketId: "game1-winner",
    suspended: true,
    visible: true,
    open: false,
    updatedAt: 99,
  });
});

test("target filter subscribes only to match-scoped topics", () => {
  const topics = buildSubscriptionTopics(["5975531956975952"], []);
  assert.ok(topics.includes("/market/oddsUpdate/5975531956975952"));
  assert.ok(topics.includes("/odd/insert/5975531956975952"));
  assert.ok(topics.includes("/market/action/suspended"));
  assert.equal(topics.includes("/market/odds/update"), false);
  assert.equal(
    topics.some((topic) => topic.includes("other-match")),
    false,
  );
});
