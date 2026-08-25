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
    <article className="relative overflow-hidden rounded-[10px] border border-line bg-panel">
      <span
        className={`absolute inset-y-0 left-0 w-0.5 ${market.locked ? "bg-rose" : "bg-gold"}`}
      />
      <header className="flex items-start justify-between gap-3.5 border-b border-line px-5 py-4">
        <div>
          <span className="text-[11px] font-medium tracking-wide text-gold">
            {market.round === 0 ? "MATCH" : `GAME ${market.round}`}
          </span>
          <h3 className="mt-1 text-base font-semibold tracking-tight">{market.name}</h3>
          <p className="mt-1 text-[11px] text-mute">{market.polymarketSlug}</p>
        </div>
        <span
          className={`rounded-md px-2 py-1.5 text-[10px] font-semibold ${
            market.locked ? "bg-rose/10 text-rose" : "bg-sage/10 text-sage"
          }`}
        >
          {market.locked ? "LOCKED" : "QUOTING"}
        </span>
      </header>

      <div className="grid grid-cols-2 gap-px bg-line">
        {Object.entries(market.fairPrices).map(([outcome, price]) => (
          <div className="bg-raised px-5 py-4" key={outcome}>
            <div className="flex justify-between gap-2.5">
              <span className="truncate text-[13px] text-mute">{outcome}</span>
              <b className="tabular-nums">{price > 0 ? `${(price * 100).toFixed(1)}¢` : "—"}</b>
            </div>
            <div className="mt-2 flex justify-between text-[11px] text-mute">
              <span>仓位 {(market.positions[outcome] ?? 0).toFixed(2)}</span>
              <span>{quotesByOutcome.get(outcome)?.length ?? 0} 层</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {(quotesByOutcome.get(outcome) ?? []).map((quote) => (
                <span
                  className="rounded bg-inset px-1.5 py-0.5 text-[11px] text-mute"
                  key={`${quote.tokenId}-${quote.price}-${quote.size}`}
                >
                  {(quote.price * 100).toFixed(0)}¢ × {quote.size.toFixed(2)}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>

      <footer className="grid grid-cols-3 gap-px bg-line text-[12px]">
        <div className="bg-panel px-5 py-3">
          <span className="text-mute">真实挂单</span>
          <b className="mt-1 block tabular-nums">
            {market.openOrderCount} / ${market.openOrderNotional.toFixed(2)}
          </b>
        </div>
        <div className="bg-panel px-5 py-3">
          <span className="text-mute">市场占用</span>
          <b className="mt-1 block tabular-nums">${market.notionalUsed.toFixed(2)}</b>
        </div>
        <div className="bg-panel px-5 py-3">
          <span className="text-mute">源盘口</span>
          <b className={`mt-1 block ${market.sourceLocked ? "text-rose" : "text-sage"}`}>
            {market.sourceLocked ? "锁盘" : "开放"}
          </b>
        </div>
      </footer>
      {(market.locked || market.rejectDetail) && (
        <div className="border-t border-line px-5 py-3">
          <span className="text-[11px] text-mute">风控原因</span>
          <strong className="mt-1 block text-[13px] font-medium">{reasonText(market)}</strong>
        </div>
      )}
    </article>
  );
}
