import type { PositionState, Quote, ResolvedMarket, TokenBook } from "../types.js";

export interface MakerParameters {
  minEdge: number;
  quoteHalfSpread: number;
  inventorySkew: number;
  orderSize: number;
  maxOutcomePosition: number;
}

export interface ComplementMakerParameters {
  targetReturnRate: number;
  orderNotional: number;
  maxOutcomePosition: number;
  maxOrderNotional: number;
  maxAccountNotional: number;
  quoteLevels: number;
  levelSpacingTicks: number;
}

export interface TopOfBookMakerParameters extends ComplementMakerParameters {
  minEdge: number;
}

export function calculateTopOfBookPrice(
  fair: number,
  oppositeFair: number,
  book: TokenBook,
  tickSize: number,
  targetReturnRate: number,
  minEdge: number,
): number | null {
  const total = fair + oppositeFair;
  const bestBid = book.bids[0]?.price;
  const bestAsk = book.asks[0]?.price;
  if (!Number.isFinite(total) || total <= 0 || bestBid === undefined || bestAsk === undefined) {
    return null;
  }
  const oppositeTargetAsk = (oppositeFair / total) * (1 / targetReturnRate);
  const complementCap = 1 - oppositeTargetAsk;
  const queueTarget = ceilToTick(bestBid + tickSize, tickSize);
  const safeCap = floorToTick(
    Math.min(complementCap, fair - minEdge, bestAsk - tickSize),
    tickSize,
  );
  return queueTarget <= safeCap + 1e-12 &&
    queueTarget < bestAsk &&
    queueTarget > 0 &&
    queueTarget < 1
    ? queueTarget
    : null;
}

export function describeTopOfBookSkip(
  fair: number,
  oppositeFair: number,
  book: TokenBook,
  tickSize: number,
  targetReturnRate: number,
  minEdge: number,
): string | null {
  if (
    calculateTopOfBookPrice(fair, oppositeFair, book, tickSize, targetReturnRate, minEdge) !== null
  ) {
    return null;
  }
  const bestBid = book.bids[0]?.price;
  const bestAsk = book.asks[0]?.price;
  if (bestBid === undefined || bestAsk === undefined) return "订单簿缺买一或卖一，无法排队";
  const total = fair + oppositeFair;
  if (!Number.isFinite(total) || total <= 0) return "源公平价无效";
  const oppositeTargetAsk = (oppositeFair / total) * (1 / targetReturnRate);
  const complementCap = 1 - oppositeTargetAsk;
  const queueTarget = ceilToTick(bestBid + tickSize, tickSize);
  const edgeCap = fair - minEdge;
  const askCap = bestAsk - tickSize;
  const rawCap = Math.min(complementCap, edgeCap, askCap);
  const safeCap = floorToTick(rawCap, tickSize);
  const binding =
    edgeCap <= complementCap && edgeCap <= askCap
      ? `公平价减边距 ${(edgeCap * 100).toFixed(1)}¢`
      : complementCap <= askCap
        ? `目标回报 ${(targetReturnRate * 100).toFixed(0)}% 上限 ${(complementCap * 100).toFixed(1)}¢`
        : `卖一内一档 ${(askCap * 100).toFixed(1)}¢`;
  return `买一+1tick ${(queueTarget * 100).toFixed(1)}¢ 超过安全上限 ${(safeCap * 100).toFixed(1)}¢（受限于${binding}）`;
}

function floorToTick(value: number, tick: number): number {
  return Math.floor((value + 1e-12) / tick) * tick;
}

function ceilToTick(value: number, tick: number): number {
  return Math.ceil((value - 1e-12) / tick) * tick;
}

function clampPrice(value: number, tick: number): number {
  return Math.min(1 - tick, Math.max(tick, value));
}

export function generateMakerQuotes(
  market: ResolvedMarket,
  fairByOutcome: ReadonlyMap<string, number>,
  books: ReadonlyMap<string, TokenBook>,
  positions: PositionState,
  parameters: MakerParameters,
): Quote[] {
  const quotes: Quote[] = [];
  const halfSpread = Math.max(parameters.quoteHalfSpread, parameters.minEdge);
  const size = Math.max(parameters.orderSize, market.minOrderSize);

  market.outcomes.forEach((outcome, index) => {
    const tokenId = market.tokenIds[index];
    if (!tokenId) throw new Error(`missing token for outcome ${outcome}`);
    const fair = fairByOutcome.get(outcome);
    const book = books.get(tokenId);
    if (fair === undefined || !book) throw new Error(`missing inputs for outcome ${outcome}`);

    const position = positions.byToken.get(tokenId) ?? 0;
    const adjustedFair = clampPrice(fair - position * parameters.inventorySkew, market.tickSize);
    const bestBid = book.bids[0]?.price;
    const bestAsk = book.asks[0]?.price;

    if (position + size <= parameters.maxOutcomePosition) {
      const rawBuy = Math.min(
        adjustedFair - halfSpread,
        bestAsk === undefined ? 1 : bestAsk - market.tickSize,
      );
      const buy = clampPrice(floorToTick(rawBuy, market.tickSize), market.tickSize);
      if (
        buy <= adjustedFair - parameters.minEdge + 1e-12 &&
        (bestAsk === undefined || buy < bestAsk)
      ) {
        quotes.push({ tokenId, outcome, side: "BUY", price: buy, size });
      }
    }

    if (position - size >= -parameters.maxOutcomePosition) {
      const rawSell = Math.max(
        adjustedFair + halfSpread,
        bestBid === undefined ? 0 : bestBid + market.tickSize,
      );
      const sell = clampPrice(ceilToTick(rawSell, market.tickSize), market.tickSize);
      if (
        sell >= adjustedFair + parameters.minEdge - 1e-12 &&
        (bestBid === undefined || sell > bestBid)
      ) {
        quotes.push({ tokenId, outcome, side: "SELL", price: sell, size });
      }
    }
  });

  return quotes;
}

export function generateComplementBuyQuotes(
  market: ResolvedMarket,
  fairByOutcome: ReadonlyMap<string, number>,
  books: ReadonlyMap<string, TokenBook>,
  positions: PositionState,
  parameters: ComplementMakerParameters,
): Quote[] {
  const firstFair = fairByOutcome.get(market.outcomes[0]);
  const secondFair = fairByOutcome.get(market.outcomes[1]);
  if (firstFair === undefined || secondFair === undefined) {
    throw new Error("missing fair probabilities for complementary quotes");
  }
  const total = firstFair + secondFair;
  if (!Number.isFinite(total) || total <= 0) return [];

  const targetAskTotal = 1 / parameters.targetReturnRate;
  const targetAsks = [
    (firstFair / total) * targetAskTotal,
    (secondFair / total) * targetAskTotal,
  ] as const;
  if (targetAsks.some((price) => price <= 0 || price >= 1)) return [];

  const rawBuyPrices = [1 - targetAsks[1], 1 - targetAsks[0]] as const;
  const existingExposure = [...positions.byToken.values()].reduce(
    (sum, position) => sum + Math.max(0, position),
    0,
  );
  let availableNotional = Math.max(0, parameters.maxAccountNotional - existingExposure);
  const quotes: Quote[] = [];

  market.outcomes.forEach((outcome, index) => {
    const tokenId = market.tokenIds[index];
    const rawPrice = rawBuyPrices[index];
    if (!tokenId || rawPrice === undefined) {
      throw new Error(`missing complementary quote input for ${outcome}`);
    }
    const book = books.get(tokenId);
    if (!book) throw new Error(`missing complementary quote book for ${outcome}`);
    const bestAsk = book.asks[0]?.price;
    const postOnlyPrice =
      bestAsk === undefined ? rawPrice : Math.min(rawPrice, bestAsk - market.tickSize);
    const topPrice = clampPrice(floorToTick(postOnlyPrice, market.tickSize), market.tickSize);
    if (bestAsk !== undefined && topPrice >= bestAsk) return;
    const currentPosition = positions.byToken.get(tokenId) ?? 0;
    let positionCapacity = Math.max(0, parameters.maxOutcomePosition - currentPosition);
    let previousPrice = Number.POSITIVE_INFINITY;
    for (let level = 0; level < parameters.quoteLevels; level += 1) {
      const rawLevelPrice = topPrice - level * parameters.levelSpacingTicks * market.tickSize;
      const price = clampPrice(floorToTick(rawLevelPrice, market.tickSize), market.tickSize);
      if (price >= previousPrice) continue;
      previousPrice = price;

      const notionalCapacity = Math.min(parameters.maxOrderNotional, availableNotional);
      const targetNotional = Math.min(parameters.orderNotional, notionalCapacity);
      const size = Math.min(positionCapacity, targetNotional / price);
      if (size + 1e-12 < market.minOrderSize || price * size <= 0) break;

      const roundedSize = Math.floor(size * 100) / 100;
      if (roundedSize + 1e-12 < market.minOrderSize) break;
      quotes.push({ tokenId, outcome, side: "BUY", price, size: roundedSize });
      const quoteNotional = price * roundedSize;
      availableNotional -= quoteNotional;
      positionCapacity -= roundedSize;
    }
  });

  return quotes;
}

export function generateTopOfBookBuyQuotes(
  market: ResolvedMarket,
  fairByOutcome: ReadonlyMap<string, number>,
  books: ReadonlyMap<string, TokenBook>,
  positions: PositionState,
  parameters: TopOfBookMakerParameters,
): Quote[] {
  const fairs = market.outcomes.map((outcome) => fairByOutcome.get(outcome));
  const firstFair = fairs[0];
  const secondFair = fairs[1];
  if (firstFair === undefined || secondFair === undefined) {
    throw new Error("missing fair probabilities for top-of-book quotes");
  }
  const total = firstFair + secondFair;
  if (!Number.isFinite(total) || total <= 0) return [];
  const targetAskTotal = 1 / parameters.targetReturnRate;
  const targetAsks = [
    (firstFair / total) * targetAskTotal,
    (secondFair / total) * targetAskTotal,
  ] as const;
  if (targetAsks.some((price) => price <= 0 || price >= 1)) return [];
  const complementCaps = [1 - targetAsks[1], 1 - targetAsks[0]] as const;
  const existingExposure = [...positions.byToken.values()].reduce(
    (sum, position) => sum + Math.max(0, position),
    0,
  );
  let availableNotional = Math.max(0, parameters.maxAccountNotional - existingExposure);
  const quotes: Quote[] = [];

  market.outcomes.forEach((outcome, index) => {
    const tokenId = market.tokenIds[index];
    const fair = fairs[index];
    const complementCap = complementCaps[index];
    if (!tokenId || fair === undefined || complementCap === undefined) return;
    const book = books.get(tokenId);
    if (!book) return;
    const queueTarget = calculateTopOfBookPrice(
      fair,
      index === 0 ? secondFair : firstFair,
      book,
      market.tickSize,
      parameters.targetReturnRate,
      parameters.minEdge,
    );
    if (queueTarget === null) return;
    const currentPosition = positions.byToken.get(tokenId) ?? 0;
    const positionCapacity = Math.max(0, parameters.maxOutcomePosition - currentPosition);
    const targetNotional = Math.min(
      parameters.orderNotional,
      parameters.maxOrderNotional,
      availableNotional,
    );
    const size = Math.min(positionCapacity, targetNotional / queueTarget);
    const roundedSize = Math.floor(size * 100) / 100;
    if (roundedSize + 1e-12 < market.minOrderSize) return;
    quotes.push({ tokenId, outcome, side: "BUY", price: queueTarget, size: roundedSize });
    availableNotional -= queueTarget * roundedSize;
  });
  return quotes;
}
