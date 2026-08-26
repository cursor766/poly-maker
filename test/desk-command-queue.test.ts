import assert from "node:assert/strict";
import test from "node:test";
import { queueInactiveDeskCommand, takeReadyDeskCommands } from "../src/web/desk-command-queue.js";
import type { DeskCommand } from "../src/web/desk-commands.js";

function command(
  partial: Partial<DeskCommand> & Pick<DeskCommand, "action" | "sourceMarketId">,
): DeskCommand {
  return {
    id: "cmd",
    at: Date.now(),
    ...partial,
  };
}

test("queues place until the market is hot-added", () => {
  const pending: DeskCommand[] = [];
  const placed = command({
    action: "place",
    sourceMarketId: "6198168328205343",
    quotes: [{ outcome: "EDward Gaming", price: 0.41, size: 100 }],
  });
  assert.equal(queueInactiveDeskCommand(placed, new Set(), pending), true);
  assert.equal(takeReadyDeskCommands(pending, new Set(), 30_000, placed.at).length, 0);
  const ready = takeReadyDeskCommands(pending, new Set(["6198168328205343"]), 30_000, placed.at);
  assert.equal(ready.length, 1);
  assert.equal(ready[0]?.id, "cmd");
  assert.equal(pending.length, 0);
});

test("does not queue pause for an unknown market", () => {
  const pending: DeskCommand[] = [];
  assert.equal(
    queueInactiveDeskCommand(
      command({ action: "pause", sourceMarketId: "missing" }),
      new Set(),
      pending,
    ),
    false,
  );
  assert.equal(pending.length, 0);
});

test("drops queued place commands that stay inactive past max age", () => {
  const pending: DeskCommand[] = [
    command({ action: "place", sourceMarketId: "stale", at: 1_000, quotes: [] }),
  ];
  const ready = takeReadyDeskCommands(pending, new Set(), 5_000, 10_000);
  assert.equal(ready.length, 0);
  assert.equal(pending.length, 0);
});
