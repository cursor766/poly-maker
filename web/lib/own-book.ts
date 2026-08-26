export interface BookLevel {
  price: number;
  size: number;
}

export interface OwnBookOrder {
  outcome?: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  matchedSize?: number;
}

export interface AnnotatedBookLevel {
  price: number;
  size: number;
  ours: number;
}

export function remainingOrderSize(order: OwnBookOrder): number {
  return Math.max(0, order.size - (order.matchedSize ?? 0));
}

export function priceKey(price: number): string {
  return price.toFixed(4);
}

export function annotateBookLevels(
  levels: readonly BookLevel[],
  orders: readonly OwnBookOrder[],
  side: "BUY" | "SELL",
  sort: "bid" | "ask",
): AnnotatedBookLevel[] {
  const ours = new Map<string, { price: number; size: number }>();
  for (const order of orders) {
    if (order.side !== side) continue;
    const left = remainingOrderSize(order);
    if (left <= 0) continue;
    const key = priceKey(order.price);
    const previous = ours.get(key);
    ours.set(key, { price: order.price, size: (previous?.size ?? 0) + left });
  }

  const seen = new Set<string>();
  const rows: AnnotatedBookLevel[] = levels.map((level) => {
    const key = priceKey(level.price);
    seen.add(key);
    return { price: level.price, size: level.size, ours: ours.get(key)?.size ?? 0 };
  });
  for (const [key, level] of ours) {
    if (seen.has(key)) continue;
    rows.push({ price: level.price, size: level.size, ours: level.size });
  }
  rows.sort((left, right) => (sort === "bid" ? right.price - left.price : left.price - right.price));
  return rows;
}
