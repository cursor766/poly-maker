import type { FairSnapshot, MarketMapping, SourceOddUpdate } from "../types.js";
import { normalizeDecimalOdds } from "./probability.js";

export interface ApplyResult {
  snapshots: FairSnapshot[];
  rejected: Array<{ update: SourceOddUpdate; reason: string }>;
}

export class OddsBook {
  private readonly odds = new Map<string, Map<string, SourceOddUpdate>>();
  private readonly mappingsBySourceMarket = new Map<string, MarketMapping>();

  constructor(
    mappings: MarketMapping[],
    private readonly maxOddsJump: number,
    private readonly maxOverround: number,
  ) {
    this.replaceMappings(mappings);
  }

  replaceMappings(mappings: readonly MarketMapping[]): void {
    this.mappingsBySourceMarket.clear();
    for (const mapping of mappings)
      this.mappingsBySourceMarket.set(mapping.sourceMarketId, mapping);
  }

  apply(updates: readonly SourceOddUpdate[]): ApplyResult {
    const touched = new Set<string>();
    const rejected: ApplyResult["rejected"] = [];

    for (const update of updates) {
      const market = this.odds.get(update.marketId) ?? new Map<string, SourceOddUpdate>();
      const previous = market.get(update.oddId);
      if (previous && update.receivedAt < previous.receivedAt) {
        rejected.push({ update, reason: "out-of-order update" });
        continue;
      }
      if (previous) {
        const probabilityJump = Math.abs(1 / update.decimalOdd - 1 / previous.decimalOdd);
        if (probabilityJump > this.maxOddsJump) {
          rejected.push({ update, reason: `probability jump ${probabilityJump.toFixed(4)}` });
          continue;
        }
      }
      market.set(update.oddId, update);
      this.odds.set(update.marketId, market);
      touched.add(update.marketId);
    }

    const snapshots: FairSnapshot[] = [];
    for (const marketId of touched) {
      const snapshot = this.snapshot(marketId);
      if (snapshot) snapshots.push(snapshot);
    }
    return { snapshots, rejected };
  }

  snapshot(marketId: string): FairSnapshot | undefined {
    const mapping = this.mappingsBySourceMarket.get(marketId);
    const market = this.odds.get(marketId);
    if (!mapping?.enabled || mapping.outcomes.length !== 2 || !market) return undefined;

    const legs = mapping.outcomes.map(({ sourceOddId }) => market.get(sourceOddId));
    if (legs.some((leg) => !leg)) return undefined;
    const completeLegs = legs as [SourceOddUpdate, SourceOddUpdate];
    if (completeLegs.some((leg) => mapping.sourceMatchId !== leg.matchId)) return undefined;

    const normalized = normalizeDecimalOdds(completeLegs.map((leg) => leg.decimalOdd));
    if (normalized.overround > this.maxOverround) return undefined;

    return {
      sourceMarketId: marketId,
      probabilities: new Map(
        mapping.outcomes.map((outcome, index) => [
          outcome.sourceOddId,
          normalized.probabilities[index] as number,
        ]),
      ),
      overround: normalized.overround,
      receivedAt: Math.min(...completeLegs.map((leg) => leg.receivedAt)),
    };
  }

  discoverySnapshot(): Record<string, Array<{ oddId: string; odd: number; matchId: string }>> {
    return Object.fromEntries(
      [...this.odds.entries()].map(([marketId, market]) => [
        marketId,
        [...market.values()].map((value) => ({
          oddId: value.oddId,
          odd: value.decimalOdd,
          matchId: value.matchId,
        })),
      ]),
    );
  }
}
