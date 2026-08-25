import { Button } from "@/app/components/ui";
import type { DeskMarketSnapshot, RestingOrder, RuntimeMarket, TradingMode } from "@/lib/api";

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
  "operator-paused": "操作员暂停报价",
  "operator-cancel": "操作员撤单",
  "polymarket-book-error": "订单簿拉取失败",
};

function reasonText(market: RuntimeMarket): string {
  if (market.rejectDetail && market.rejectDetail !== market.reason) return market.rejectDetail;
  if (!market.reason) return market.locked ? "安全锁生效" : "正常报价";
  return reasonLabels[market.reason] ?? market.reason;
}

function cents(value: number): string {
  return `${(value * 100).toFixed(1)}¢`;
}

function timeLabel(at: number): string {
  if (!at) return "—";
  return new Date(at).toLocaleTimeString("zh-CN", { hour12: false });
}

export function MarketStatusCard({
  market,
  desk,
  mode,
  busy,
  onPause,
  onResume,
  onCancel,
}: {
  market: RuntimeMarket;
  desk?: DeskMarketSnapshot;
  mode: TradingMode;
  busy: boolean;
  onPause: () => void;
  onResume: () => void;
  onCancel: (orderId: string) => void;
}) {
  const outcomes = market.outcomes ?? (Object.keys(market.fairPrices) as [string, string]);
  const openOrders = market.openOrders ?? [];
  const quoting = !market.locked && !market.operatorPaused;

  return (
    <article className="relative overflow-hidden rounded-[10px] border border-line bg-panel">
      <span
        className={`absolute inset-y-0 left-0 w-0.5 ${quoting ? "bg-gold" : "bg-rose"}`}
      />
      <header className="flex flex-wrap items-start justify-between gap-3.5 border-b border-line px-5 py-4">
        <div>
          <span className="text-[11px] font-medium tracking-wide text-gold">
            {market.round === 0 ? "MATCH" : `GAME ${market.round}`}
          </span>
          <h3 className="mt-1 text-base font-semibold tracking-tight">{market.name}</h3>
          <p className="mt-1 text-[11px] text-mute">{market.polymarketSlug}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`rounded-md px-2 py-1.5 text-[10px] font-semibold ${
              quoting ? "bg-sage/10 text-sage" : "bg-rose/10 text-rose"
            }`}
          >
            {market.operatorPaused ? "PAUSED" : market.locked ? "LOCKED" : "QUOTING"}
          </span>
          {market.operatorPaused ? (
            <Button disabled={busy} onClick={onResume} variant="secondary">
              恢复报价
            </Button>
          ) : (
            <Button disabled={busy} onClick={onPause} variant="danger">
              暂停并撤单
            </Button>
          )}
        </div>
      </header>

      <div className="grid gap-px bg-line md:grid-cols-2">
        {outcomes.map((outcome) => (
          <OrderBookPane
            key={outcome}
            outcome={outcome}
            fair={market.fairPrices[outcome] ?? 0}
            position={market.positions[outcome] ?? 0}
            book={market.books?.[outcome]}
            orders={openOrders.filter((order) => order.outcome === outcome)}
          />
        ))}
      </div>

      <section className="border-t border-line px-5 py-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h4 className="m-0 text-[13px] font-medium">我们的挂单</h4>
          <span className="text-[11px] text-mute">
            {openOrders.length} 笔 · ${market.openOrderNotional.toFixed(2)}
            {mode === "paper" ? " · paper" : mode === "shadow" ? " · shadow 只读" : ""}
          </span>
        </div>
        {openOrders.length === 0 ? (
          <p className="m-0 text-sm text-mute">当前没有挂单。</p>
        ) : (
          <div className="grid gap-2">
            {openOrders.map((order) => (
              <div
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-inset px-3 py-2 text-[13px]"
                key={order.id}
              >
                <span>
                  {order.side} {order.outcome} · {cents(order.price)} × {order.size.toFixed(2)}
                  {order.matchedSize > 0 ? ` · 已成 ${order.matchedSize.toFixed(2)}` : ""}
                </span>
                <Button
                  disabled={busy || mode === "shadow"}
                  onClick={() => onCancel(order.id)}
                  variant="ghost"
                >
                  撤单
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="grid gap-px bg-line md:grid-cols-2">
        <section className="bg-panel px-5 py-4">
          <h4 className="m-0 mb-3 text-[13px] font-medium">成交 activity</h4>
          {desk?.error ? <p className="m-0 text-xs text-rose">{desk.error}</p> : null}
          {(desk?.trades.length ?? 0) === 0 ? (
            <p className="m-0 text-sm text-mute">还没有成交。</p>
          ) : (
            <ul className="m-0 grid list-none gap-2 p-0">
              {desk?.trades.slice(0, 8).map((trade) => (
                <li className="flex justify-between gap-3 text-[12px]" key={trade.id}>
                  <span className="text-mute">{timeLabel(trade.at)}</span>
                  <span className={trade.side === "BUY" ? "text-sage" : "text-rose"}>
                    {trade.side} {trade.outcome}
                  </span>
                  <span className="tabular-nums">
                    {cents(trade.price)} × {trade.size.toFixed(1)}
                  </span>
                  <span className="truncate text-mute">{trade.name}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="bg-panel px-5 py-4">
          <h4 className="m-0 mb-3 text-[13px] font-medium">Top holders</h4>
          {(desk?.holders.length ?? 0) === 0 ? (
            <p className="m-0 text-sm text-mute">暂无持仓分布。</p>
          ) : (
            <div className="grid gap-3">
              {desk?.holders.map((group) => (
                <div key={group.tokenId || group.outcome}>
                  <strong className="block text-[12px]">{group.outcome}</strong>
                  <ul className="mt-1.5 mb-0 grid list-none gap-1 p-0">
                    {group.holders.slice(0, 5).map((holder) => (
                      <li className="flex justify-between gap-3 text-[12px]" key={holder.wallet}>
                        <span className="truncate">{holder.name}</span>
                        <span className="tabular-nums text-mute">
                          {holder.amount.toFixed(1)} · {(holder.share * 100).toFixed(0)}%
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>
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
      {(market.locked || market.rejectDetail || market.operatorPaused) && (
        <div className="border-t border-line px-5 py-3">
          <span className="text-[11px] text-mute">状态</span>
          <strong className="mt-1 block text-[13px] font-medium">{reasonText(market)}</strong>
        </div>
      )}
    </article>
  );
}

function OrderBookPane({
  outcome,
  fair,
  position,
  book,
  orders,
}: {
  outcome: string;
  fair: number;
  position: number;
  book?: RuntimeMarket["books"][string];
  orders: RestingOrder[];
}) {
  const ourPrices = new Set(orders.map((order) => order.price.toFixed(4)));
  const asks = [...(book?.asks ?? [])].slice(0, 6).reverse();
  const bids = (book?.bids ?? []).slice(0, 6);
  return (
    <div className="bg-raised px-5 py-4">
      <div className="mb-3 flex justify-between gap-2.5">
        <span className="truncate text-[13px]">{outcome}</span>
        <b className="tabular-nums">{fair > 0 ? cents(fair) : "—"}</b>
      </div>
      <div className="mb-2 flex justify-between text-[11px] text-mute">
        <span>仓位 {position.toFixed(2)}</span>
        <span>{orders.length} 笔挂单</span>
      </div>
      <div className="grid gap-px font-mono text-[11px]">
        {asks.map((level) => (
          <BookRow
            key={`ask-${level.price}`}
            level={level}
            ours={ourPrices.has(level.price.toFixed(4))}
            side="ask"
          />
        ))}
        <div className="py-1 text-center text-[10px] tracking-[0.16em] text-mute-2">SPREAD</div>
        {bids.map((level) => (
          <BookRow
            key={`bid-${level.price}`}
            level={level}
            ours={ourPrices.has(level.price.toFixed(4))}
            side="bid"
          />
        ))}
        {asks.length === 0 && bids.length === 0 ? (
          <div className="py-3 text-center text-mute">等待订单簿…</div>
        ) : null}
      </div>
    </div>
  );
}

function BookRow({
  level,
  ours,
  side,
}: {
  level: { price: number; size: number };
  ours: boolean;
  side: "bid" | "ask";
}) {
  return (
    <div
      className={`flex justify-between rounded-sm px-1.5 py-0.5 ${
        ours ? "bg-gold/15 text-gold" : side === "bid" ? "text-sage" : "text-rose"
      }`}
    >
      <span>{cents(level.price)}</span>
      <span>{level.size.toFixed(1)}</span>
      {ours ? <span>我们</span> : <span />}
    </div>
  );
}
