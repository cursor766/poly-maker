import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  consumeDeskCommands,
  enqueueDeskCommand,
  skipExistingDeskCommands,
} from "../src/web/desk-commands.js";

test("desk commands append and consume from a cursor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "poly-desk-"));
  const path = join(directory, "desk-commands.jsonl");
  const cursorPath = join(directory, "desk-commands.cursor");
  try {
    await skipExistingDeskCommands(path, cursorPath);
    const first = await enqueueDeskCommand({ action: "pause", sourceMarketId: "m1" }, path);
    const second = await enqueueDeskCommand(
      { action: "cancel", sourceMarketId: "m1", orderIds: ["o-1"] },
      path,
    );
    const placed = await enqueueDeskCommand(
      {
        action: "place",
        sourceMarketId: "m1",
        quotes: [{ outcome: "EDG", price: 0.54, size: 10 }],
      },
      path,
    );
    const seen: string[] = [];
    const handled = await consumeDeskCommands(
      async (command) => {
        seen.push(`${command.action}:${command.id}`);
      },
      path,
      cursorPath,
    );
    assert.equal(handled, 3);
    assert.deepEqual(seen, [`pause:${first.id}`, `cancel:${second.id}`, `place:${placed.id}`]);

    const again = await consumeDeskCommands(async () => undefined, path, cursorPath);
    assert.equal(again, 0);

    const lines = (await readFile(path, "utf8")).trim().split("\n");
    assert.equal(lines.length, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("skipExisting ignores commands written before the maker started", async () => {
  const directory = await mkdtemp(join(tmpdir(), "poly-desk-skip-"));
  const path = join(directory, "desk-commands.jsonl");
  const cursorPath = join(directory, "desk-commands.cursor");
  try {
    await enqueueDeskCommand({ action: "pause", sourceMarketId: "old" }, path);
    await skipExistingDeskCommands(path, cursorPath);
    const seen: string[] = [];
    assert.equal(
      await consumeDeskCommands(
        async (command) => {
          seen.push(command.sourceMarketId);
        },
        path,
        cursorPath,
      ),
      0,
    );
    await enqueueDeskCommand({ action: "resume", sourceMarketId: "new" }, path);
    assert.equal(
      await consumeDeskCommands(
        async (command) => {
          seen.push(command.sourceMarketId);
        },
        path,
        cursorPath,
      ),
      1,
    );
    assert.deepEqual(seen, ["new"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
