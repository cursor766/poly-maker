import type { TokenBook } from "../types.js";

export type MappedMarketKind = "moneyline" | "child_moneyline" | "map_handicap" | "totals";

export function inferMappedMarketKind(input: {
  kind?: MappedMarketKind | undefined;
  name?: string | undefined;
  round?: number | undefined;
}): MappedMarketKind {
  if (input.kind) return input.kind;
  const name = input.name ?? "";
  if (/让分|handicap/i.test(name)) return "map_handicap";
  if (/总数|totals|o\/u/i.test(name)) return "totals";
  if ((input.round ?? 0) === 0) return "moneyline";
  return "child_moneyline";
}

export function marketNotionalCap(kind: MappedMarketKind, gameCap: number, mapCap: number): number {
  return kind === "map_handicap" || kind === "totals" ? mapCap : gameCap;
}

export function foreignNearbyBidSize(
  book: TokenBook,
  targetPrice: number,
  tickSize: number,
  nearbyTicks: number,
  ownBids: readonly { price: number; size: number }[],
): number {
  const lo = targetPrice - nearbyTicks * tickSize;
  const ownAt = (price: number) =>
    ownBids.reduce((sum, bid) => (Math.abs(bid.price - price) < 1e-8 ? sum + bid.size : sum), 0);
  return book.bids
    .filter((level) => level.price + 1e-12 >= lo && level.price <= targetPrice + 1e-12)
    .reduce((sum, level) => sum + Math.max(0, level.size - ownAt(level.price)), 0);
}

export function adaptiveQuoteLevels(input: {
  book: TokenBook;
  targetPrice: number;
  tickSize: number;
  nearbyTicks: number;
  ownBids: readonly { price: number; size: number }[];
  layerShares: number;
  maxLevels: number;
}): number {
  const maxLevels = Math.max(1, Math.min(10, Math.floor(input.maxLevels)));
  const foreign = foreignNearbyBidSize(
    input.book,
    input.targetPrice,
    input.tickSize,
    input.nearbyTicks,
    input.ownBids,
  );
  if (foreign + 1e-9 < Math.max(input.layerShares, 1)) return maxLevels;
  return 1;
}

export function shouldSuppressTopRefill(
  lastFillAt: number | undefined,
  now: number,
  delayMs: number,
): boolean {
  if (lastFillAt === undefined || !(delayMs > 0)) return false;
  return now - lastFillAt < delayMs;
}

export function sideIsBaited(positionShares: number, marketCap: number, ratio: number): boolean {
  if (!(marketCap > 0) || !(ratio > 0)) return false;
  return Math.max(0, positionShares) + 1e-9 >= marketCap * ratio;
}
