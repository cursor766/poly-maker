import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { MarketMapping } from "../types.js";

const sessionSchema = z.object({
  sourceMatchId: z.string().min(1),
  polymarketEventSlug: z.string().min(1),
  sourceUrl: z.string().url(),
  polymarketUrl: z.string().url(),
  teams: z.tuple([z.string(), z.string()]).optional(),
  tournament: z.string().optional(),
  updatedAt: z.number().int().positive(),
});

export type MatchSession = z.infer<typeof sessionSchema>;

async function readSessions(path: string): Promise<MatchSession[]> {
  try {
    return z.array(sessionSchema).parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function upsertMatchSession(
  session: Omit<MatchSession, "updatedAt"> & { updatedAt?: number },
  path = "data/match-sessions.json",
): Promise<MatchSession[]> {
  const file = resolve(path);
  const existing = await readSessions(file);
  const next: MatchSession = {
    ...session,
    updatedAt: session.updatedAt ?? Date.now(),
  };
  const sessions = [
    next,
    ...existing.filter(
      (item) =>
        item.sourceMatchId !== next.sourceMatchId &&
        item.polymarketEventSlug !== next.polymarketEventSlug,
    ),
  ].sort((left, right) => right.updatedAt - left.updatedAt);
  await mkdir(dirname(file), { recursive: true });
  const temporaryPath = `${file}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(sessions, null, 2)}\n`, "utf8");
  await rename(temporaryPath, file);
  return sessions;
}

export async function listMatchSessions(
  path = "data/match-sessions.json",
): Promise<MatchSession[]> {
  return readSessions(resolve(path));
}

export async function deleteMatchSession(
  sourceMatchId: string,
  polymarketEventSlug: string,
  path = "data/match-sessions.json",
): Promise<MatchSession[]> {
  const file = resolve(path);
  const sessions = (await readSessions(file)).filter(
    (item) =>
      item.sourceMatchId !== sourceMatchId && item.polymarketEventSlug !== polymarketEventSlug,
  );
  await mkdir(dirname(file), { recursive: true });
  const temporaryPath = `${file}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(sessions, null, 2)}\n`, "utf8");
  await rename(temporaryPath, file);
  return sessions;
}

export interface SavedMatchSummary {
  sourceMatchId: string;
  polymarketEventSlug: string;
  sourceUrl: string;
  polymarketUrl: string;
  label: string;
  tournament?: string;
  enabledRounds: number[];
  marketCount: number;
  enabledCount: number;
  updatedAt: number;
}

export async function listSavedMatches(
  mappings: readonly MarketMapping[],
  sessions: readonly MatchSession[],
  mqttOrigin: string,
): Promise<SavedMatchSummary[]> {
  const byKey = new Map<string, MarketMapping[]>();
  for (const mapping of mappings) {
    const eventSlug = mapping.polymarketEventSlug ?? mapping.polymarketSlug;
    const key = `${mapping.sourceMatchId}::${eventSlug}`;
    const list = byKey.get(key) ?? [];
    list.push(mapping);
    byKey.set(key, list);
  }

  const summaries: SavedMatchSummary[] = [];
  for (const [key, markets] of byKey) {
    const [sourceMatchId, polymarketEventSlug] = key.split("::") as [string, string];
    const session = sessions.find(
      (item) =>
        item.sourceMatchId === sourceMatchId && item.polymarketEventSlug === polymarketEventSlug,
    );
    const label =
      session?.teams?.join(" vs ") ??
      markets[0]?.name.replace(
        /\s+-\s+(Match Winner|Game \d+ Winner|全场胜负|第\d+局胜负).*$/,
        "",
      ) ??
      `${sourceMatchId} / ${polymarketEventSlug}`;
    summaries.push({
      sourceMatchId,
      polymarketEventSlug,
      sourceUrl: session?.sourceUrl ?? `${mqttOrigin.replace(/\/$/, "")}/markets/${sourceMatchId}`,
      polymarketUrl:
        session?.polymarketUrl ?? `https://polymarket.com/event/${polymarketEventSlug}`,
      label,
      ...(session?.tournament ? { tournament: session.tournament } : {}),
      enabledRounds: markets
        .filter((market) => market.enabled)
        .map((market) => market.round ?? 0)
        .sort((left, right) => left - right),
      marketCount: markets.length,
      enabledCount: markets.filter((market) => market.enabled).length,
      updatedAt: session?.updatedAt ?? 0,
    });
  }

  return summaries.sort(
    (left, right) => right.updatedAt - left.updatedAt || left.label.localeCompare(right.label),
  );
}
