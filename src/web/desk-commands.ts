import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";

export const DESK_COMMANDS_PATH = "data/desk-commands.jsonl";
export const DESK_COMMAND_CURSOR_PATH = "data/desk-commands.cursor";

export const deskQuoteSchema = z.object({
  outcome: z.string().min(1),
  price: z.number().positive().lt(1),
  size: z.number().positive(),
});

export const deskCommandSchema = z
  .object({
    id: z.string().min(1),
    action: z.enum(["pause", "resume", "cancel", "place", "replace"]),
    sourceMarketId: z.string().min(1),
    orderIds: z.array(z.string().min(1)).optional(),
    quotes: z.array(deskQuoteSchema).max(10).optional(),
    orderId: z.string().min(1).optional(),
    price: z.number().positive().lt(1).optional(),
    size: z.number().positive().optional(),
    at: z.number().int().positive(),
  })
  .superRefine((value, context) => {
    if (value.action === "place" && (!value.quotes || value.quotes.length === 0)) {
      context.addIssue({ code: "custom", path: ["quotes"], message: "手动挂单需要 quotes" });
    }
    if (value.action === "replace" && !value.orderId) {
      context.addIssue({ code: "custom", path: ["orderId"], message: "改价需要 orderId" });
    }
    if (value.action === "replace" && value.price === undefined) {
      context.addIssue({ code: "custom", path: ["price"], message: "改价需要 price" });
    }
  });

export type DeskCommand = z.infer<typeof deskCommandSchema>;

export async function enqueueDeskCommand(
  input: Omit<DeskCommand, "id" | "at"> & { id?: string; at?: number },
  path = DESK_COMMANDS_PATH,
): Promise<DeskCommand> {
  const command = deskCommandSchema.parse({
    id: input.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: input.at ?? Date.now(),
    action: input.action,
    sourceMarketId: input.sourceMarketId,
    ...(input.orderIds && input.orderIds.length > 0 ? { orderIds: input.orderIds } : {}),
    ...(input.quotes && input.quotes.length > 0 ? { quotes: input.quotes } : {}),
    ...(input.orderId ? { orderId: input.orderId } : {}),
    ...(input.price !== undefined ? { price: input.price } : {}),
    ...(input.size !== undefined ? { size: input.size } : {}),
  });
  const file = resolve(path);
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(command)}\n`, "utf8");
  return command;
}

export async function skipExistingDeskCommands(
  path = DESK_COMMANDS_PATH,
  cursorPath = DESK_COMMAND_CURSOR_PATH,
): Promise<number> {
  const count = await countCommandLines(path);
  await writeCursor(count, cursorPath);
  return count;
}

export async function consumeDeskCommands(
  handler: (command: DeskCommand) => Promise<void>,
  path = DESK_COMMANDS_PATH,
  cursorPath = DESK_COMMAND_CURSOR_PATH,
): Promise<number> {
  let text = "";
  try {
    text = await readFile(resolve(path), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const cursor = await readCursor(cursorPath);
  let handled = 0;
  for (let index = cursor; index < lines.length; index += 1) {
    const command = deskCommandSchema.parse(JSON.parse(lines[index] ?? "{}"));
    await handler(command);
    handled += 1;
    await writeCursor(index + 1, cursorPath);
  }
  return handled;
}

async function countCommandLines(path: string): Promise<number> {
  try {
    const text = await readFile(resolve(path), "utf8");
    return text.split("\n").filter((line) => line.trim().length > 0).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function readCursor(cursorPath: string): Promise<number> {
  try {
    const parsed = Number.parseInt(await readFile(resolve(cursorPath), "utf8"), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function writeCursor(count: number, cursorPath: string): Promise<void> {
  const file = resolve(cursorPath);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${count}\n`, "utf8");
}
