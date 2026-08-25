export function tickDecimalPlaces(tickSize: number): number {
  if (!Number.isFinite(tickSize) || tickSize <= 0) {
    return 2;
  }
  const normalized = tickSize.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
  const dot = normalized.indexOf(".");
  return dot < 0 ? 0 : Math.min(8, normalized.length - dot - 1);
}

function splitScaled(value: number, factor: number): { ticks: number; frac: number } {
  const scaled = Math.abs(value) * factor;
  const [intPart, fracPart = "0"] = scaled.toFixed(6).split(".");
  return {
    ticks: Number.parseInt(intPart ?? "0", 10) || 0,
    frac: Number.parseInt(`${fracPart}000000`.slice(0, 6), 10) || 0,
  };
}

export function floorToTick(value: number, tickSize: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(tickSize) || tickSize <= 0) {
    return value;
  }
  const places = tickDecimalPlaces(tickSize);
  const { ticks } = splitScaled(value, 1 / tickSize);
  return Number((ticks * tickSize).toFixed(places));
}

export function clampPrice(price: number, tickSize: number): number {
  const places = tickDecimalPlaces(tickSize);
  const min = Number(tickSize.toFixed(places));
  const max = Number((1 - tickSize).toFixed(places));
  return Math.min(max, Math.max(min, floorToTick(price, tickSize)));
}

export function clobSize(size: number, sizeDecimals = 2): number {
  if (!Number.isFinite(size) || size <= 0) {
    return 0;
  }
  const factor = 10 ** sizeDecimals;
  const { ticks } = splitScaled(size, factor);
  return Number((ticks / factor).toFixed(sizeDecimals));
}
