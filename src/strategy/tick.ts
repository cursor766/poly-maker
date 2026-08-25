export type SnapDirection = "floor" | "ceil" | "round";

export function tickDecimalPlaces(tickSize: number): number {
  if (!Number.isFinite(tickSize) || tickSize <= 0) {
    return 2;
  }
  const normalized = tickSize.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
  const dot = normalized.indexOf(".");
  return dot < 0 ? 0 : Math.min(8, normalized.length - dot - 1);
}

function splitScaled(
  value: number,
  factor: number,
): { ticks: number; frac: number; negative: boolean } {
  const negative = value < 0;
  const scaled = Math.abs(value) * factor;
  const [intPart, fracPart = "0"] = scaled.toFixed(6).split(".");
  return {
    ticks: Number.parseInt(intPart ?? "0", 10) || 0,
    frac: Number.parseInt(`${fracPart}000000`.slice(0, 6), 10) || 0,
    negative,
  };
}

export function snapPriceToTick(price: number, tickSize: number, direction: SnapDirection): number {
  if (!Number.isFinite(price) || !Number.isFinite(tickSize) || tickSize <= 0) {
    return price;
  }
  const places = tickDecimalPlaces(tickSize);
  const { ticks, frac, negative } = splitScaled(price, 1 / tickSize);

  let snappedTicks = ticks;
  if (direction === "ceil") {
    if (frac > 0) {
      snappedTicks += 1;
    }
  } else if (direction === "round") {
    if (frac >= 500_000) {
      snappedTicks += 1;
    }
  }

  const signed = negative ? -snappedTicks : snappedTicks;
  return Number((signed * tickSize).toFixed(places));
}

export function floorToTick(value: number, tickSize: number): number {
  return snapPriceToTick(value, tickSize, "floor");
}

export function ceilToTick(value: number, tickSize: number): number {
  return snapPriceToTick(value, tickSize, "ceil");
}

export function clampPrice(price: number, tickSize: number): number {
  const places = tickDecimalPlaces(tickSize);
  const min = Number(tickSize.toFixed(places));
  const max = Number((1 - tickSize).toFixed(places));
  return Math.min(max, Math.max(min, price));
}

export function clobPrice(price: number, tickSize = 0.01): number {
  return clampPrice(floorToTick(price, tickSize), tickSize);
}

export function clobSize(size: number, sizeDecimals = 2): number {
  if (!Number.isFinite(size) || size <= 0) {
    return 0;
  }
  const factor = 10 ** sizeDecimals;
  const { ticks } = splitScaled(size, factor);
  return Number((ticks / factor).toFixed(sizeDecimals));
}
