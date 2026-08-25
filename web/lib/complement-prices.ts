export function sourceImpliedSum(firstOdd: number, secondOdd: number): number | null {
  if (!(firstOdd > 1) || !(secondOdd > 1)) return null;
  const total = 1 / firstOdd + 1 / secondOdd;
  return Number.isFinite(total) && total > 0 ? total : null;
}

export function complementAskTotal(targetReturnRate: number, sourceOverround = 1): number | null {
  if (!(targetReturnRate > 0) || !(sourceOverround > 0)) return null;
  return sourceOverround + (1 - targetReturnRate);
}

export function complementBuyPricesOnTick(
  firstFair: number,
  secondFair: number,
  targetReturnRate: number,
  tickSize: number,
  sourceOverround = 1,
): [number | null, number | null] {
  const total = firstFair + secondFair;
  const askTotal = complementAskTotal(targetReturnRate, sourceOverround);
  if (!Number.isFinite(total) || total <= 0 || askTotal === null || tickSize <= 0) {
    return [null, null];
  }
  const raw = [1 - (secondFair / total) * askTotal, 1 - (firstFair / total) * askTotal] as const;
  return raw.map((price) => {
    if (!Number.isFinite(price) || price <= 0 || price >= 1) return null;
    return Math.min(
      1 - tickSize,
      Math.max(tickSize, Math.floor((price + 1e-12) / tickSize) * tickSize),
    );
  }) as [number | null, number | null];
}
