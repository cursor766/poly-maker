export interface BudgetMarket {
  enabled: boolean;
  tradable: boolean;
  orderNotional: number;
  quoteLevels: number;
}

export function estimateMarketBudget(markets: readonly BudgetMarket[]): number {
  return markets.reduce(
    (sum, market) =>
      market.enabled && market.tradable ? sum + market.orderNotional * market.quoteLevels * 2 : sum,
    0,
  );
}
