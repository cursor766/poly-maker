import type { RuntimeMarket } from "@/lib/api";

const reasonLabels: Record<string, string> = {
  "mqtt-disconnected": "源站连接断开",
  "polymarket-disconnected": "Polymarket 连接断开",
  "lock-barrier-active": "安全锁等待解除",
  "missing-fair-odds": "等待完整源赔率",
  "pre-lock-fair-odds": "等待锁盘后的新赔率",
  "stale-fair-odds": "源赔率已过期",
  "missing-source-state": "等待源盘口状态",
  "source-suspended": "源盘口暂停",
  "source-hidden": "源盘口隐藏",
  "source-closed": "源盘口关闭",
  "source-market-locked": "源盘口锁盘",
  "polymarket-closed": "Polymarket 市场关闭",
  "incomplete-polymarket-books": "订单簿不完整",
  "stale-polymarket-book": "订单簿数据过期",
  "outcome-position-limit": "单边仓位超限",
  "total-exposure-limit": "总仓位超限",
  "strategy-error": "策略风控拒绝",
  "config-outcome-mapping-changed": "队伍配对已修改，等待新赔率",
};

function reasonText(market: RuntimeMarket): string {
  if (market.rejectDetail && market.rejectDetail !== market.reason) return market.rejectDetail;
  if (!market.reason) return market.locked ? "安全锁生效" : "正常报价";
  return reasonLabels[market.reason] ?? market.reason;
}

export function MarketStatusCard({ market }: { market: RuntimeMarket }) {
  const quotesByOutcome = new Map<string, typeof market.plannedQuotes>();
  for (const quote of market.plannedQuotes) {
    const quotes = quotesByOutcome.get(quote.outcome) ?? [];
    quotes.push(quote);
    quotesByOutcome.set(quote.outcome, quotes);
  }
  return (
    <article className={`deskMarket ${market.locked ? "locked" : ""}`}>
      <header className="deskMarketHead">
        <div>
          <span className="deskRound">{market.round === 0 ? "MATCH" : `GAME ${market.round}`}</span>
          <h3>{market.name}</h3>
          <p>{market.polymarketSlug}</p>
        </div>
        <span className={`marketState ${market.locked ? "locked" : "quoting"}`}>
          {market.locked ? "LOCKED" : "QUOTING"}
        </span>
      </header>

      <div className="deskOutcomes">
        {Object.entries(market.fairPrices).map(([outcome, price]) => (
          <div className="deskOutcome" key={outcome}>
            <div className="deskOutcomeHead">
              <span>{outcome}</span>
              <b>{price > 0 ? `${(price * 100).toFixed(1)}¢` : "—"}</b>
            </div>
            <div className="deskOutcomeMeta">
              <span>仓位 {(market.positions[outcome] ?? 0).toFixed(2)}</span>
              <span>{quotesByOutcome.get(outcome)?.length ?? 0} 层</span>
            </div>
            <div className="quoteChips">
              {(quotesByOutcome.get(outcome) ?? []).map((quote) => (
                <span key={`${quote.tokenId}-${quote.price}-${quote.size}`}>
                  {(quote.price * 100).toFixed(0)}¢ × {quote.size.toFixed(2)}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>

      <footer className="deskMarketFoot">
        <div>
          <span>真实挂单</span>
          <b>
            {market.openOrderCount} / ${market.openOrderNotional.toFixed(2)}
          </b>
        </div>
        <div>
          <span>市场占用</span>
          <b>${market.notionalUsed.toFixed(2)}</b>
        </div>
        <div>
          <span>源盘口</span>
          <b className={market.sourceLocked ? "textDanger" : "textSafe"}>
            {market.sourceLocked ? "锁盘" : "开放"}
          </b>
        </div>
      </footer>
      {(market.locked || market.rejectDetail) && (
        <div className="riskMessage">
          <span>风控原因</span>
          <strong>{reasonText(market)}</strong>
        </div>
      )}
    </article>
  );
}
