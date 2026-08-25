import type { DeskCommand } from "./desk-commands.js";

const QUEUEABLE = new Set(["place", "replace"]);

export function queueInactiveDeskCommand(
  command: DeskCommand,
  activeMarketIds: ReadonlySet<string>,
  pending: DeskCommand[],
): boolean {
  if (activeMarketIds.has(command.sourceMarketId)) return false;
  if (!QUEUEABLE.has(command.action)) return false;
  pending.push(command);
  return true;
}

export function takeReadyDeskCommands(
  pending: DeskCommand[],
  activeMarketIds: ReadonlySet<string>,
  maxAgeMs = 30_000,
  now = Date.now(),
): DeskCommand[] {
  const ready: DeskCommand[] = [];
  const kept: DeskCommand[] = [];
  for (const command of pending) {
    if (now - command.at > maxAgeMs) continue;
    if (activeMarketIds.has(command.sourceMarketId)) ready.push(command);
    else kept.push(command);
  }
  pending.splice(0, pending.length, ...kept);
  return ready;
}
