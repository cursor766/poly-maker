import type { FairSnapshot, MarketMapping, ResolvedMarket } from "../types.js";

export function mapFairProbabilities(
  mapping: MarketMapping,
  resolved: ResolvedMarket,
  snapshot: FairSnapshot,
): ReadonlyMap<string, number> {
  if (snapshot.sourceMarketId !== mapping.sourceMarketId) {
    throw new Error("fair snapshot does not match source market mapping");
  }
  if (mapping.outcomes.length !== 2) {
    throw new Error("binary market mapping must contain exactly two outcomes");
  }

  const resolvedOutcomes = new Set(resolved.outcomes);
  const result = new Map<string, number>();
  for (const item of mapping.outcomes) {
    if (!resolvedOutcomes.has(item.outcome)) {
      throw new Error(`mapped outcome ${item.outcome} is absent from Polymarket`);
    }
    const probability = snapshot.probabilities.get(item.sourceOddId);
    if (probability === undefined) {
      throw new Error(`missing fair probability for source odd ${item.sourceOddId}`);
    }
    result.set(item.outcome, probability);
  }
  if (result.size !== 2) throw new Error("source odd IDs and outcomes must be unique");

  const total = [...result.values()].reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - 1) > 1e-9) throw new Error("mapped probabilities do not sum to one");
  return result;
}
