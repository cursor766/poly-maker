import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { MarketMapping } from "../types.js";

const configuredMarketSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean(),
  sourceMarketId: z.string().min(1),
  polymarketSlug: z.string().min(1),
  round: z.number().int().min(0).max(7),
  outcomes: z
    .array(
      z.object({
        sourceOddId: z.string().min(1),
        outcome: z.string().min(1),
      }),
    )
    .length(2),
  orderNotional: z.number().positive(),
  quoteLevels: z.number().int().positive().max(10),
  levelSpacingTicks: z.number().int().positive(),
  targetReturnRate: z.number().positive().max(0.99),
  quoteMode: z.enum(["complement-buy", "top-of-book"]).optional(),
  kind: z.enum(["moneyline", "child_moneyline", "map_handicap", "totals"]).optional(),
});

export const saveMarketConfigSchema = z.object({
  sourceMatchId: z.string().min(1),
  polymarketEventSlug: z.string().min(1),
  sourceUrl: z.string().url().optional(),
  polymarketUrl: z.string().url().optional(),
  teams: z.tuple([z.string(), z.string()]).optional(),
  tournament: z.string().optional(),
  markets: z.array(configuredMarketSchema).min(1),
});

export type SaveMarketConfig = z.infer<typeof saveMarketConfigSchema>;

export const saveBatchMarketConfigSchema = z.object({
  matches: z.array(saveMarketConfigSchema).min(1).max(100),
});

export const deleteMarketConfigSchema = z.object({
  sourceMatchId: z.string().min(1),
  polymarketEventSlug: z.string().min(1),
});

async function readExisting(path: string): Promise<MarketMapping[]> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as MarketMapping[];
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return [];
    throw error;
  }
}

function generateMappings(parsed: SaveMarketConfig): MarketMapping[] {
  return parsed.markets.map((market) => ({
    name: market.name,
    enabled: market.enabled,
    sourceMatchId: parsed.sourceMatchId,
    sourceMarketId: market.sourceMarketId,
    polymarketEventSlug: parsed.polymarketEventSlug,
    polymarketSlug: market.polymarketSlug,
    round: market.round,
    quoteMode: market.quoteMode ?? "complement-buy",
    kind: market.kind,
    outcomes: market.outcomes,
    orderNotional: market.orderNotional,
    quoteLevels: market.quoteLevels,
    levelSpacingTicks: market.levelSpacingTicks,
    targetReturnRate: market.targetReturnRate,
  }));
}

async function persistMappings(path: string, mappings: readonly MarketMapping[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(mappings, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

export async function writeMarketConfig(
  input: SaveMarketConfig,
  configPath: string,
): Promise<MarketMapping[]> {
  const parsed = saveMarketConfigSchema.parse(input);
  const path = resolve(configPath);
  const existing = await readExisting(path);
  const retained = existing.filter(
    (mapping) =>
      mapping.sourceMatchId !== parsed.sourceMatchId &&
      mapping.polymarketEventSlug !== parsed.polymarketEventSlug,
  );
  const generated = generateMappings(parsed);
  const mappings = [...retained, ...generated];
  await persistMappings(path, mappings);
  return mappings;
}

export async function writeBatchMarketConfigs(
  input: z.infer<typeof saveBatchMarketConfigSchema>,
  configPath: string,
): Promise<MarketMapping[]> {
  const parsed = saveBatchMarketConfigSchema.parse(input);
  const path = resolve(configPath);
  const keys = new Set(
    parsed.matches.map((match) => `${match.sourceMatchId}::${match.polymarketEventSlug}`),
  );
  const retained = (await readExisting(path)).filter((mapping) => {
    const eventSlug = mapping.polymarketEventSlug ?? mapping.polymarketSlug;
    return !keys.has(`${mapping.sourceMatchId}::${eventSlug}`);
  });
  const generated = parsed.matches.flatMap((match) =>
    generateMappings({
      ...match,
      markets: match.markets.map((market) => ({
        ...market,
        quoteLevels: 1,
        quoteMode: "top-of-book" as const,
      })),
    }),
  );
  const mappings = [...retained, ...generated];
  await persistMappings(path, mappings);
  return mappings;
}

export async function deleteMarketConfig(
  input: z.infer<typeof deleteMarketConfigSchema>,
  configPath: string,
): Promise<MarketMapping[]> {
  const parsed = deleteMarketConfigSchema.parse(input);
  const path = resolve(configPath);
  const mappings = (await readExisting(path)).filter(
    (mapping) =>
      mapping.sourceMatchId !== parsed.sourceMatchId &&
      mapping.polymarketEventSlug !== parsed.polymarketEventSlug,
  );
  await persistMappings(path, mappings);
  return mappings;
}
