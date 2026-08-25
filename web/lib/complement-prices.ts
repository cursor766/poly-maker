export function complementBuyPricesOnTick(
  firstFair: number,
  secondFair: number,
  targetReturnRate: number,
  tickSize: number,
): [number | null, number | null] {
  const total = firstFair + secondFair;
  if (!Number.isFinite(total) || total <= 0 || targetReturnRate <= 0 || tickSize <= 0) {
    return [null, null];
  }
  const askTotal = 1 / targetReturnRate;
  const raw = [1 - (secondFair / total) * askTotal, 1 - (firstFair / total) * askTotal] as const;
  return raw.map((price) => {
    if (!Number.isFinite(price) || price <= 0 || price >= 1) return null;
    return Math.min(
      1 - tickSize,
      Math.max(tickSize, Math.floor((price + 1e-12) / tickSize) * tickSize),
    );
  }) as [number | null, number | null];
}
