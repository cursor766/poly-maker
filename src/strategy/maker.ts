import type { PositionState, Quote, ResolvedMarket, TokenBook } from "../types.js";
import { adaptiveQuoteLevels, shouldSuppressTopRefill, sideIsBaited } from "./ladder.js";
import { ceilToTick, clampPrice, clobSize, floorToTick } from "./tick.js";

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
  sourceOverround?: number;
  reservedAccountNotional?: number;
  maxMarketNotional?: number;
  adaptiveLadder?: boolean;
  nearbyTicks?: number;
  refillTopDelayMs?: number;
  now?: number;
  lastFillAtByToken?: ReadonlyMap<string, number>;
  ownBidsByToken?: ReadonlyMap<string, readonly { price: number; size: number }[]>;
  baitPositionRatio?: number;
  maxImproveTicks?: number;
  inventorySkew?: number;
  pmDisagreePullTicks?: number;
  pmDisagreeHalt?: number;
}

export function longShareExposure(positions: PositionState): number {
  return [...positions.byToken.values()].reduce((sum, position) => sum + Math.max(0, position), 0);
}

export function availableAccountNotional(
  maxAccountNotional: number,
  positions: PositionState,
  reservedAccountNotional = 0,
): number {
  if (!(maxAccountNotional > 0)) return Number.POSITIVE_INFINITY;
  return Math.max(
    0,
    maxAccountNotional - longShareExposure(positions) - Math.max(0, reservedAccountNotional),
  );
}

export function availableMarketNotional(
  maxMarketNotional: number | undefined,
  maxAccountNotional: number,
  localShares: number,
): number {
  const cap =
    maxMarketNotional !== undefined && maxMarketNotional > 0
      ? maxMarketNotional
      : maxAccountNotional > 0
        ? maxAccountNotional
        : Number.POSITIVE_INFINITY;
  return Math.max(0, cap - Math.max(0, localShares));
}

export interface TopOfBookMakerParameters extends ComplementMakerParameters {
  minEdge: number;
}

export function stackedVigAskTotal(
  targetReturnRate: number,
  sourceOverround = 1,
): number | undefined {
  if (!Number.isFinite(targetReturnRate) || targetReturnRate <= 0) return undefined;
  if (!Number.isFinite(sourceOverround) || sourceOverround <= 0) return undefined;
  return sourceOverround + (1 - targetReturnRate);
}

export function calculateTopOfBookPrice(
  fair: number,
  oppositeFair: number,
  book: TokenBook,
  tickSize: number,
  targetReturnRate: number,
  minEdge: number,
  sourceOverround = 1,
): number | null {
  const total = fair + oppositeFair;
  const bestBid = book.bids[0]?.price;
  const bestAsk = book.asks[0]?.price;
  const askTotal = stackedVigAskTotal(targetReturnRate, sourceOverround);
  if (
    !Number.isFinite(total) ||
    total <= 0 ||
    askTotal === undefined ||
    bestBid === undefined ||
    bestAsk === undefined
  ) {
    return null;
  }
  const oppositeTargetAsk = (oppositeFair / total) * askTotal;
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
  sourceOverround = 1,
): string | null {
  if (
    calculateTopOfBookPrice(
      fair,
      oppositeFair,
      book,
      tickSize,
      targetReturnRate,
      minEdge,
      sourceOverround,
    ) !== null
  ) {
    return null;
  }
  const bestBid = book.bids[0]?.price;
  const bestAsk = book.asks[0]?.price;
  if (bestBid === undefined || bestAsk === undefined) return "订单簿缺买一或卖一，无法排队";
  const total = fair + oppositeFair;
  const askTotal = stackedVigAskTotal(targetReturnRate, sourceOverround);
  if (!Number.isFinite(total) || total <= 0 || askTotal === undefined) return "源公平价无效";
  const oppositeTargetAsk = (oppositeFair / total) * askTotal;
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

export function complementTargetBuyPrices(
  firstFair: number,
  secondFair: number,
  targetReturnRate: number,
  sourceOverround = 1,
): readonly [number, number] | undefined {
  const total = firstFair + secondFair;
  const askTotal = stackedVigAskTotal(targetReturnRate, sourceOverround);
  if (!Number.isFinite(total) || total <= 0 || askTotal === undefined) return undefined;
  const firstAsk = (firstFair / total) * askTotal;
  const secondAsk = (secondFair / total) * askTotal;
  if (firstAsk <= 0 || firstAsk >= 1 || secondAsk <= 0 || secondAsk >= 1) return undefined;
  return [1 - secondAsk, 1 - firstAsk];
}

export function skewFairsForInventory(
  fairByOutcome: ReadonlyMap<string, number>,
  market: ResolvedMarket,
  positions: PositionState,
  inventorySkew: number,
): ReadonlyMap<string, number> {
  if (!(inventorySkew > 0) || market.outcomes.length !== 2 || market.tokenIds.length !== 2) {
    return fairByOutcome;
  }
  const firstOutcome = market.outcomes[0];
  const secondOutcome = market.outcomes[1];
  const firstTokenId = market.tokenIds[0];
  const secondTokenId = market.tokenIds[1];
  if (!firstOutcome || !secondOutcome || !firstTokenId || !secondTokenId) return fairByOutcome;
  const firstFair = fairByOutcome.get(firstOutcome);
  const secondFair = fairByOutcome.get(secondOutcome);
  if (firstFair === undefined || secondFair === undefined) return fairByOutcome;

  const delta =
    inventorySkew *
    ((positions.byToken.get(firstTokenId) ?? 0) - (positions.byToken.get(secondTokenId) ?? 0));
  const skewed = new Map(fairByOutcome);
  skewed.set(firstOutcome, clampPrice(firstFair - delta, market.tickSize));
  skewed.set(secondOutcome, clampPrice(secondFair + delta, market.tickSize));
  return skewed;
}

export function queueCappedBuyPrice(
  theoreticalPrice: number,
  sourceFair: number,
  book: TokenBook,
  tickSize: number,
  maxImproveTicks = 2,
  pmDisagreePullTicks = 2,
  pmDisagreeHalt = 0.15,
  extraImproveTicks = 0,
): number | null {
  const bestBid = book.bids[0]?.price;
  const bestAsk = book.asks[0]?.price;
  let safetyCap = floorToTick(
    Math.min(theoreticalPrice, bestAsk === undefined ? theoreticalPrice : bestAsk - tickSize),
    tickSize,
  );

  if (bestBid !== undefined && bestAsk !== undefined) {
    const disagreement = Math.abs((bestBid + bestAsk) / 2 - sourceFair);
    if (disagreement > pmDisagreeHalt + 1e-12) return null;
    if (disagreement > 0.08 + 1e-12) {
      const pullTicks = Math.max(0, Math.floor(pmDisagreePullTicks));
      safetyCap = floorToTick(safetyCap - pullTicks * tickSize, tickSize);
    }
  }

  const improveTicks =
    Math.max(0, Math.floor(maxImproveTicks)) + Math.max(0, Math.floor(extraImproveTicks));
  const rawTop =
    bestBid === undefined ? safetyCap : Math.min(safetyCap, bestBid + improveTicks * tickSize);
  const topPrice = clampPrice(floorToTick(rawTop, tickSize), tickSize);
  if (bestAsk !== undefined && topPrice >= bestAsk) return null;
  return topPrice;
}

function inventorySizeMultiplier(
  currentPosition: number,
  oppositePosition: number,
  positionCap: number,
): number {
  if (!(positionCap > 0)) return 1;
  const imbalance = Math.max(-1, Math.min(1, (currentPosition - oppositePosition) / positionCap));
  return imbalance >= 0 ? 1 - 0.65 * imbalance : 1 + 0.35 * -imbalance;
}

export function buildManualBuyQuotes(input: {
  outcome: string;
  tokenId: string;
  price: number;
  shares: number;
  layers: number;
  spacingTicks: number;
  tickSize: number;
  minOrderSize: number;
}): Quote[] {
  const tick = input.tickSize;
  const layers = Math.max(1, Math.min(10, Math.floor(input.layers)));
  const spacing = Math.max(1, Math.floor(input.spacingTicks));
  const size = clobSize(Math.max(input.minOrderSize, Math.floor(input.shares * 100) / 100));
  const quotes: Quote[] = [];
  let previous = Number.POSITIVE_INFINITY;
  for (let level = 0; level < layers; level += 1) {
    const price = clampPrice(floorToTick(input.price - level * spacing * tick, tick), tick);
    if (price >= previous) continue;
    previous = price;
    quotes.push({
      tokenId: input.tokenId,
      outcome: input.outcome,
      side: "BUY",
      price,
      size,
    });
  }
  return quotes;
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
  const size = clobSize(Math.max(parameters.orderSize, market.minOrderSize));

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
  const skewedFairs = skewFairsForInventory(
    fairByOutcome,
    market,
    positions,
    parameters.inventorySkew ?? 0,
  );
  const firstFair = skewedFairs.get(market.outcomes[0]);
  const secondFair = skewedFairs.get(market.outcomes[1]);
  if (firstFair === undefined || secondFair === undefined) {
    throw new Error("missing fair probabilities for complementary quotes");
  }
  const rawBuyPrices = complementTargetBuyPrices(
    firstFair,
    secondFair,
    parameters.targetReturnRate,
    parameters.sourceOverround ?? 1,
  );
  if (!rawBuyPrices) return [];
  const localShares = market.tokenIds.reduce(
    (sum, tokenId) => sum + Math.max(0, positions.byToken.get(tokenId) ?? 0),
    0,
  );
  const accountAvailable = availableAccountNotional(
    parameters.maxAccountNotional,
    positions,
    parameters.reservedAccountNotional,
  );
  const marketAvailable = availableMarketNotional(
    parameters.maxMarketNotional,
    parameters.maxAccountNotional,
    localShares,
  );
  let availableNotional = Math.min(accountAvailable, marketAvailable);
  const quotes: Quote[] = [];

  market.outcomes.forEach((outcome, index) => {
    const tokenId = market.tokenIds[index];
    const rawPrice = rawBuyPrices[index];
    if (!tokenId || rawPrice === undefined) {
      throw new Error(`missing complementary quote input for ${outcome}`);
    }
    const book = books.get(tokenId);
    if (!book) throw new Error(`missing complementary quote book for ${outcome}`);
    const currentPosition = positions.byToken.get(tokenId) ?? 0;
    const oppositeTokenId = market.tokenIds[1 - index];
    const oppositePosition =
      oppositeTokenId === undefined ? 0 : (positions.byToken.get(oppositeTokenId) ?? 0);
    if (
      sideIsBaited(
        currentPosition,
        parameters.maxMarketNotional ?? parameters.maxAccountNotional,
        parameters.baitPositionRatio ?? 0.6,
      )
    ) {
      return;
    }
    const sourceFair = fairByOutcome.get(outcome);
    if (sourceFair === undefined) {
      throw new Error(`missing source fair probability for ${outcome}`);
    }
    const topPrice = queueCappedBuyPrice(
      rawPrice,
      sourceFair,
      book,
      market.tickSize,
      parameters.maxImproveTicks ?? 2,
      parameters.pmDisagreePullTicks ?? 2,
      parameters.pmDisagreeHalt ?? 0.15,
      oppositePosition > currentPosition + 1e-9 ? 1 : 0,
    );
    if (topPrice === null) return;
    let positionCapacity = Math.max(0, parameters.maxOutcomePosition - currentPosition);
    const ownBids = parameters.ownBidsByToken?.get(tokenId) ?? [];
    const sizeMultiplier = inventorySizeMultiplier(
      currentPosition,
      oppositePosition,
      parameters.maxMarketNotional !== undefined && parameters.maxMarketNotional > 0
        ? Math.min(parameters.maxOutcomePosition, parameters.maxMarketNotional)
        : parameters.maxOutcomePosition,
    );
    const layerNotional = Math.min(
      parameters.orderNotional * sizeMultiplier,
      parameters.maxOrderNotional,
    );
    const layerShares = Math.max(
      market.minOrderSize,
      layerNotional / Math.max(topPrice, market.tickSize),
    );
    const levels = parameters.adaptiveLadder
      ? adaptiveQuoteLevels({
          book,
          targetPrice: topPrice,
          tickSize: market.tickSize,
          nearbyTicks: parameters.nearbyTicks ?? 3,
          ownBids,
          layerShares,
          maxLevels: parameters.quoteLevels,
        })
      : parameters.quoteLevels;
    const startLevel =
      levels > 1 &&
      shouldSuppressTopRefill(
        parameters.lastFillAtByToken?.get(tokenId),
        parameters.now ?? Date.now(),
        parameters.refillTopDelayMs ?? 0,
      )
        ? 1
        : 0;
    let previousPrice = Number.POSITIVE_INFINITY;
    for (let level = startLevel; level < levels; level += 1) {
      const rawLevelPrice = topPrice - level * parameters.levelSpacingTicks * market.tickSize;
      const price = clampPrice(floorToTick(rawLevelPrice, market.tickSize), market.tickSize);
      if (price >= previousPrice) continue;
      previousPrice = price;

      const notionalCapacity = Math.min(parameters.maxOrderNotional, availableNotional);
      const targetNotional = Math.min(layerNotional, notionalCapacity);
      const size = Math.min(positionCapacity, targetNotional / price);
      if (size + 1e-12 < market.minOrderSize || price * size <= 0) break;

      const roundedSize = clobSize(Math.floor(size * 100) / 100);
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
  const targetAskTotal = stackedVigAskTotal(
    parameters.targetReturnRate,
    parameters.sourceOverround ?? 1,
  );
  if (targetAskTotal === undefined) return [];
  const targetAsks = [
    (firstFair / total) * targetAskTotal,
    (secondFair / total) * targetAskTotal,
  ] as const;
  if (targetAsks.some((price) => price <= 0 || price >= 1)) return [];
  const complementCaps = [1 - targetAsks[1], 1 - targetAsks[0]] as const;
  const localShares = market.tokenIds.reduce(
    (sum, tokenId) => sum + Math.max(0, positions.byToken.get(tokenId) ?? 0),
    0,
  );
  const accountAvailable = availableAccountNotional(
    parameters.maxAccountNotional,
    positions,
    parameters.reservedAccountNotional,
  );
  const marketAvailable = availableMarketNotional(
    parameters.maxMarketNotional,
    parameters.maxAccountNotional,
    localShares,
  );
  let availableNotional = Math.min(accountAvailable, marketAvailable);
  const quotes: Quote[] = [];

  market.outcomes.forEach((outcome, index) => {
    const tokenId = market.tokenIds[index];
    const fair = fairs[index];
    const complementCap = complementCaps[index];
    if (!tokenId || fair === undefined || complementCap === undefined) return;
    const currentPosition = positions.byToken.get(tokenId) ?? 0;
    if (
      sideIsBaited(
        currentPosition,
        parameters.maxMarketNotional ?? parameters.maxAccountNotional,
        parameters.baitPositionRatio ?? 0.6,
      )
    ) {
      return;
    }
    const book = books.get(tokenId);
    if (!book) return;
    const queueTarget = calculateTopOfBookPrice(
      fair,
      index === 0 ? secondFair : firstFair,
      book,
      market.tickSize,
      parameters.targetReturnRate,
      parameters.minEdge,
      parameters.sourceOverround ?? 1,
    );
    if (queueTarget === null) return;
    const positionCapacity = Math.max(0, parameters.maxOutcomePosition - currentPosition);
    const targetNotional = Math.min(
      parameters.orderNotional,
      parameters.maxOrderNotional,
      availableNotional,
    );
    const size = Math.min(positionCapacity, targetNotional / queueTarget);
    const roundedSize = clobSize(Math.floor(size * 100) / 100);
    if (roundedSize + 1e-12 < market.minOrderSize) return;
    quotes.push({ tokenId, outcome, side: "BUY", price: queueTarget, size: roundedSize });
    availableNotional -= queueTarget * roundedSize;
  });
  return quotes;
}
