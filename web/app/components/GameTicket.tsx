"use client";

import { useMemo, useState } from "react";
import { Button, inputClass } from "@/app/components/ui";
import type {
  DeskTrade,
  MarketTapeSnapshot,
  PreviewMarket,
  RestingOrder,
  RuntimeMarket,
  TradingMode,
} from "@/lib/api";

function cents(value: number): string {
  return `${(value * 100).toFixed(value * 100 >= 10 ? 0 : 1)}¢`;
}

function timeLabel(at: number): string {
  if (!at) return "—";
  return new Date(at).toLocaleTimeString("zh-CN", { hour12: false });
}

function maxSize(levels: Array<{ size: number }>): number {
  return Math.max(1, ...levels.map((level) => level.size));
}

export function GameTicket({
  market,
  mappedOutcomes,
  tape,
  runtime,
  mode,
  makerRunning,
  busy,
  defaultShares,
  defaultLayers,
  defaultSpacing,
  onPlace,
  onCancelAll,
  onCancel,
  onReplace,
  onSwap,
}: {
  market: PreviewMarket;
  mappedOutcomes: [string, string];
  tape?: MarketTapeSnapshot;
  runtime?: RuntimeMarket;
  mode: TradingMode;
  makerRunning: boolean;
  busy: boolean;
  defaultShares: number;
  defaultLayers: number;
  defaultSpacing: number;
  onPlace: (input: {
    outcome: string;
    price: number;
    shares: number;
    layers: number;
    spacingTicks: number;
  }) => Promise<void>;
  onCancelAll: () => Promise<void>;
  onCancel: (orderId: string) => Promise<void>;
  onReplace: (orderId: string, price: number, size: number) => Promise<void>;
  onSwap: () => void;
}) {
  const [sideIndex, setSideIndex] = useState(0);
  const [priceCents, setPriceCents] = useState<number | "">("");
  const [shares, setShares] = useState(Math.max(market.minOrderSize, defaultShares));
  const [layers, setLayers] = useState(Math.max(1, defaultLayers));
  const [spacing, setSpacing] = useState(Math.max(1, defaultSpacing));
  const [editPrice, setEditPrice] = useState<Record<string, string>>({});

  const outcome = market.outcomes[sideIndex];
  const mapped = mappedOutcomes[sideIndex] ?? outcome?.suggestedPolymarketOutcome;
  const book = mapped ? tape?.books[mapped] : undefined;
  const recommended = outcome?.recommendedBuyPrice ?? null;
  const bestBid = book?.bids[0]?.price ?? null;
  const bestAsk = book?.asks[0]?.price ?? null;
  const suggested = recommended ?? (bestBid !== null ? bestBid + market.tickSize : bestAsk);
  const price =
    priceCents === ""
      ? (suggested ?? 0)
      : Math.min(1 - market.tickSize, Math.max(market.tickSize, Number(priceCents) / 100));
  const asks = [...(book?.asks ?? [])].slice(0, 6).reverse();
  const bids = (book?.bids ?? []).slice(0, 6);
  const depthMax = maxSize([...asks, ...bids]);
  const trades = (tape?.trades ?? []).filter((trade) => !mapped || trade.outcome === mapped);
  const openOrders = runtime?.openOrders ?? [];
  const canTrade = market.tradable && makerRunning && mode !== "shadow";
  const notional = price * shares * layers;

  const layerPreview = useMemo(() => {
    const tick = market.tickSize;
    return Array.from({ length: Math.max(1, layers) }, (_, index) => {
      const next = Math.min(1 - tick, Math.max(tick, price - index * spacing * tick));
      return next;
    }).filter((value, index, list) => list.indexOf(value) === index);
  }, [layers, market.tickSize, price, spacing]);

  return (
    <article className="overflow-hidden rounded-[16px] border border-line bg-panel">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3.5">
        <div>
          <span className="rounded-md border border-gold/25 bg-gold/10 px-2 py-0.5 font-mono text-[11px] font-semibold text-gold">
            {market.round === 0
              ? market.kind === "map_handicap"
                ? `+${market.line}`
                : market.kind === "totals"
                  ? `O/U ${market.line}`
                  : "全场"
              : `G${market.round}`}
          </span>
          <h3 className="mt-1.5 m-0 text-[15px] font-semibold">{market.name}</h3>
          <p className="mt-1 mb-0 font-mono text-[11px] text-mute-2">{market.polymarketSlug}</p>
        </div>
        <Button onClick={onSwap} variant="ghost">
          交换配对
        </Button>
      </header>

      <div className="grid grid-cols-2 gap-2 p-3">
        {market.outcomes.map((item, index) => {
          const active = index === sideIndex;
          const mappedName = mappedOutcomes[index];
          const itemBook = mappedName ? tape?.books[mappedName] : undefined;
          const last = itemBook?.bids[0]?.price ?? item.recommendedBuyPrice;
          return (
            <button
              className={`rounded-xl border px-3 py-3 text-left transition-colors ${
                active
                  ? index === 0
                    ? "border-sage/50 bg-sage/10"
                    : "border-rose/50 bg-rose/10"
                  : "border-line bg-inset hover:border-line-strong"
              }`}
              key={item.sourceOddId}
              onClick={() => {
                setSideIndex(index);
                setPriceCents("");
              }}
              type="button"
            >
              <span className="block truncate text-[13px] font-medium">{item.sourceName}</span>
              <b
                className={`mt-1 block font-display text-2xl font-medium ${
                  index === 0 ? "text-sage" : "text-rose"
                }`}
              >
                {last ? cents(last) : "—"}
              </b>
              <small className="mt-1 block text-[11px] text-mute">
                源 {(item.fairProbability * 100).toFixed(1)}% · 推荐{" "}
                {item.recommendedBuyPrice ? cents(item.recommendedBuyPrice) : "—"}
              </small>
            </button>
          );
        })}
      </div>

      <div className="grid gap-px bg-line lg:grid-cols-[minmax(0,1.1fr)_minmax(280px,0.9fr)]">
        <section className="bg-raised px-4 py-4">
          <div className="mb-3 flex items-center justify-between text-[11px] uppercase tracking-[0.16em] text-mute-2">
            <span>Order book</span>
            <span>
              买一 {bestBid ? cents(bestBid) : "—"} / 卖一 {bestAsk ? cents(bestAsk) : "—"}
            </span>
          </div>
          <div className="mb-1 grid grid-cols-[1fr_72px_72px] px-1 text-[10px] uppercase tracking-[0.14em] text-mute-2">
            <span>价格</span>
            <span className="text-right">Shares</span>
            <span className="text-right">Total</span>
          </div>
          <div className="grid gap-0.5 font-mono text-[12px]">
            {asks.map((level) => (
              <BookRow
                depth={level.size / depthMax}
                key={`ask-${level.price}`}
                level={level}
                onClick={() => setPriceCents(Math.round(level.price * 1000) / 10)}
                side="ask"
              />
            ))}
            <div className="my-1 rounded-md border border-line bg-inset py-1.5 text-center text-[11px] tracking-[0.18em] text-mute">
              SPREAD{" "}
              {bestBid !== null && bestAsk !== null
                ? `${((bestAsk - bestBid) * 100).toFixed(1)}¢`
                : "—"}
            </div>
            {bids.map((level) => (
              <BookRow
                depth={level.size / depthMax}
                key={`bid-${level.price}`}
                level={level}
                onClick={() => setPriceCents(Math.round(level.price * 1000) / 10)}
                side="bid"
              />
            ))}
            {asks.length === 0 && bids.length === 0 ? (
              <p className="py-6 text-center text-sm text-mute">
                {tape?.error ?? "正在读取订单簿…"}
              </p>
            ) : null}
          </div>
        </section>

        <section className="bg-panel px-4 py-4">
          <div className="mb-3 flex items-center justify-between">
            <strong className="text-[13px]">Buy {outcome?.sourceName}</strong>
            <span className="text-[11px] text-mute">Limit</span>
          </div>
          <label className="mb-3 grid gap-1.5 text-[11px] text-mute">
            价格（推荐 {suggested ? cents(suggested) : "—"}）
            <input
              className={inputClass}
              min={1}
              onChange={(event) => setPriceCents(Number(event.target.value))}
              step={market.tickSize * 100}
              type="number"
              value={priceCents === "" ? Math.round((suggested ?? 0) * 1000) / 10 : priceCents}
            />
          </label>
          <label className="mb-3 grid gap-1.5 text-[11px] text-mute">
            Shares
            <input
              className={inputClass}
              min={market.minOrderSize}
              onChange={(event) => setShares(Number(event.target.value))}
              step={1}
              type="number"
              value={shares}
            />
          </label>
          <div className="mb-3 grid grid-cols-2 gap-2">
            <label className="grid gap-1.5 text-[11px] text-mute">
              层数
              <input
                className={inputClass}
                max={10}
                min={1}
                onChange={(event) => setLayers(Number(event.target.value))}
                type="number"
                value={layers}
              />
            </label>
            <label className="grid gap-1.5 text-[11px] text-mute">
              层间距 tick
              <input
                className={inputClass}
                min={1}
                onChange={(event) => setSpacing(Number(event.target.value))}
                type="number"
                value={spacing}
              />
            </label>
          </div>
          <p className="mt-0 mb-3 text-[11px] leading-relaxed text-mute">
            将在 {layerPreview.map((value) => cents(value)).join(" / ")} 挂 {shares} shares · 约 $
            {notional.toFixed(2)}
          </p>
          {!makerRunning ? (
            <p className="mt-0 mb-3 text-[12px] text-amber">先保存并启动核心后才能一键挂单。</p>
          ) : mode === "shadow" ? (
            <p className="mt-0 mb-3 text-[12px] text-amber">Shadow 只读，请用 Paper 或 Live。</p>
          ) : null}
          <Button
            className="w-full"
            disabled={busy || !canTrade || !mapped || !price || shares < market.minOrderSize}
            onClick={() =>
              void onPlace({
                outcome: mapped as string,
                price,
                shares,
                layers,
                spacingTicks: spacing,
              })
            }
          >
            一键挂单 Buy {outcome?.sourceName}
          </Button>
        </section>
      </div>

      <div className="grid gap-px bg-line md:grid-cols-2">
        <section className="bg-panel px-4 py-4">
          <div className="mb-3 flex items-center justify-between">
            <h4 className="m-0 text-[13px] font-medium">我们的挂单</h4>
            <Button
              disabled={busy || !canTrade || openOrders.length === 0}
              onClick={() => void onCancelAll()}
              variant="danger"
            >
              一键撤单
            </Button>
          </div>
          {openOrders.length === 0 ? (
            <p className="m-0 text-sm text-mute">当前没有挂单。</p>
          ) : (
            <div className="grid gap-2">
              {openOrders.map((order) => (
                <OpenOrderRow
                  busy={busy || !canTrade}
                  editValue={editPrice[order.id] ?? `${Math.round(order.price * 1000) / 10}`}
                  key={order.id}
                  onCancel={() => void onCancel(order.id)}
                  onEdit={(value) => setEditPrice((current) => ({ ...current, [order.id]: value }))}
                  onReplace={() => {
                    const next = Number(editPrice[order.id] ?? order.price * 100) / 100;
                    void onReplace(order.id, next, order.size - order.matchedSize || order.size);
                  }}
                  order={order}
                />
              ))}
            </div>
          )}
        </section>
        <section className="bg-panel px-4 py-4">
          <h4 className="m-0 mb-3 text-[13px] font-medium">Activity</h4>
          {trades.length === 0 ? (
            <p className="m-0 text-sm text-mute">{tape?.error ?? "还没有成交。"}</p>
          ) : (
            <ul className="m-0 grid list-none gap-2 p-0">
              {trades.slice(0, 8).map((trade: DeskTrade) => (
                <li className="flex justify-between gap-3 text-[12px]" key={trade.id}>
                  <span className="text-mute">{timeLabel(trade.at)}</span>
                  <span className={trade.side === "BUY" ? "text-sage" : "text-rose"}>
                    {trade.side}
                  </span>
                  <span className="tabular-nums">
                    {cents(trade.price)} × {trade.size.toFixed(1)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </article>
  );
}

function BookRow({
  level,
  side,
  depth,
  onClick,
}: {
  level: { price: number; size: number };
  side: "bid" | "ask";
  depth: number;
  onClick: () => void;
}) {
  return (
    <button
      className={`relative grid grid-cols-[1fr_72px_72px] overflow-hidden rounded-sm px-1.5 py-1 text-left ${
        side === "bid" ? "text-sage" : "text-rose"
      }`}
      onClick={onClick}
      type="button"
    >
      <i
        className={`absolute inset-y-0 right-0 ${side === "bid" ? "bg-sage/15" : "bg-rose/15"}`}
        style={{ width: `${Math.max(8, depth * 100)}%` }}
      />
      <span className="relative">{cents(level.price)}</span>
      <span className="relative text-right tabular-nums">{level.size.toFixed(1)}</span>
      <span className="relative text-right tabular-nums">
        {(level.price * level.size).toFixed(1)}
      </span>
    </button>
  );
}

function OpenOrderRow({
  order,
  editValue,
  busy,
  onEdit,
  onReplace,
  onCancel,
}: {
  order: RestingOrder;
  editValue: string;
  busy: boolean;
  onEdit: (value: string) => void;
  onReplace: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-inset px-3 py-2 text-[12px]">
      <span>
        {order.side} {order.outcome} · {cents(order.price)} × {order.size.toFixed(1)}
      </span>
      <div className="flex items-center gap-2">
        <input
          aria-label="改价 ¢"
          className={`${inputClass} h-8 w-16 px-2`}
          onChange={(event) => onEdit(event.target.value)}
          type="number"
          value={editValue}
        />
        <Button disabled={busy} onClick={onReplace} variant="secondary">
          改价
        </Button>
        <Button disabled={busy} onClick={onCancel} variant="ghost">
          撤
        </Button>
      </div>
    </div>
  );
}
