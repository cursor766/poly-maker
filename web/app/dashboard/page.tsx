"use client";

import { useCallback, useEffect, useState } from "react";
import { ExposureBar } from "@/app/components/ExposureBar";
import { MarketStatusCard } from "@/app/components/MarketStatusCard";
import { StatusPill } from "@/app/components/StatusPill";
import { Button, errorClass, inputClass } from "@/app/components/ui";
import {
  api,
  type ControlStatus,
  type DeskSnapshot,
  type RuntimeLimits,
  type RuntimeMarket,
  type TradingMode,
} from "@/lib/api";
import { subscribeToStatus } from "@/lib/stream";

export default function DashboardPage() {
  const [status, setStatus] = useState<ControlStatus | null>(null);
  const [limits, setLimits] = useState<RuntimeLimits | null>(null);
  const [draftLimit, setDraftLimit] = useState(0);
  const [mode, setMode] = useState<TradingMode>("live");
  const [streamConnected, setStreamConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [desk, setDesk] = useState<DeskSnapshot>({ markets: {} });

  const refresh = useCallback(async () => {
    try {
      const [nextStatus, nextLimits] = await Promise.all([
        api<ControlStatus>("/api/status"),
        api<RuntimeLimits>("/api/limits"),
      ]);
      setStatus(nextStatus);
      setLimits(nextLimits);
      setDraftLimit(nextLimits.maxAccountNotional);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const unsubscribe = subscribeToStatus(setStatus, setStreamConnected);
    const fallback = window.setInterval(() => void refresh(), 10_000);
    return () => {
      unsubscribe();
      window.clearInterval(fallback);
    };
  }, [refresh]);

  useEffect(() => {
    const marketIds =
      status?.runtime?.markets.map((market) => market.sourceMarketId).join(",") ?? "";
    if (!marketIds) {
      setDesk({ markets: {} });
      return;
    }
    let cancelled = false;
    const loadDesk = async () => {
      try {
        const next = await api<DeskSnapshot>("/api/desk");
        if (!cancelled) setDesk(next);
      } catch {
        if (!cancelled) setDesk({ markets: {} });
      }
    };
    void loadDesk();
    const timer = window.setInterval(() => void loadDesk(), 8_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [status?.runtime?.markets.map((market) => market.sourceMarketId).join(",")]);

  async function start() {
    if (
      mode === "live" &&
      !window.confirm("确认使用当前配置和钱包启动真实挂单？停止按钮会执行保护性撤单。")
    ) {
      return;
    }
    setBusy(true);
    try {
      await api("/api/start", { method: "POST", body: JSON.stringify({ mode }) });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    if (!window.confirm("停止会锁定所有市场并撤销当前挂单，确认继续？")) return;
    setBusy(true);
    try {
      await api("/api/stop", { method: "POST", body: "{}" });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function saveLimit() {
    if (!limits) return;
    setBusy(true);
    try {
      const next = await api<RuntimeLimits>("/api/limits", {
        method: "POST",
        body: JSON.stringify({ ...limits, maxAccountNotional: draftLimit }),
      });
      setLimits(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function sendDeskCommand(
    action: "pause" | "resume" | "cancel",
    sourceMarketId: string,
    orderIds?: string[],
  ) {
    setBusy(true);
    try {
      await api("/api/desk/command", {
        method: "POST",
        body: JSON.stringify({ action, sourceMarketId, ...(orderIds ? { orderIds } : {}) }),
      });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function pauseMarket(sourceMarketId: string) {
    if (!window.confirm("暂停会锁定该市场并撤销当前挂单，不会自动恢复。确认？")) return;
    await sendDeskCommand("pause", sourceMarketId);
  }

  async function resumeMarket(sourceMarketId: string) {
    if (!window.confirm("恢复后将按当前源赔率和盘口重新挂单。确认？")) return;
    await sendDeskCommand("resume", sourceMarketId);
  }

  async function cancelOrder(market: RuntimeMarket, orderId: string) {
    const quoting = !market.locked && !market.operatorPaused;
    if (
      quoting &&
      !window.confirm("核心仍在报价，下一轮会重挂这张单。要彻底停掉请先暂停本市场。仍要撤这张单？")
    ) {
      return;
    }
    if (!quoting && !window.confirm("确认撤销这张挂单？")) return;
    await sendDeskCommand("cancel", market.sourceMarketId, [orderId]);
  }

  const runtime = status?.runtime;
  const running = status?.process.running ?? false;
  const orders = runtime?.markets.reduce((sum, market) => sum + market.openOrderCount, 0) ?? 0;

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-gold">
            Live book
          </p>
          <h1 className="m-0 font-display text-[34px] font-medium tracking-tight">交易台</h1>
          <div className="mt-3 flex flex-wrap gap-2">
            <StatusPill
              ok={running}
              label={running ? `核心 PID ${status?.process.pid}` : "核心未运行"}
            />
            <StatusPill ok={streamConnected} label={streamConnected ? "SSE 实时" : "SSE 重连中"} />
            {runtime && <StatusPill ok={runtime.mqttConnected} label="源站 MQTT" />}
            {runtime && <StatusPill ok={runtime.polymarketConnected} label="Polymarket WS" />}
            {runtime && <StatusPill ok label={runtime.mode.toUpperCase()} neutral />}
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          {!running ? (
            <>
              <select
                className={`${inputClass} w-auto`}
                value={mode}
                onChange={(event) => setMode(event.target.value as TradingMode)}
              >
                <option value="paper">PAPER</option>
                <option value="shadow">SHADOW</option>
                <option value="live">LIVE</option>
              </select>
              <Button disabled={busy} onClick={start}>
                启动核心
              </Button>
            </>
          ) : (
            <Button disabled={busy} onClick={stop} variant="danger">
              锁定并停止
            </Button>
          )}
        </div>
      </header>

      {error && <div className={errorClass}>{error}</div>}

      {(runtime || limits) && (
        <section className="mb-5 grid gap-2.5 rounded-[18px] border border-line bg-panel p-5 sm:grid-cols-2 xl:grid-cols-4">
          {runtime && (
            <>
              <div className="rounded-xl border border-line bg-inset px-4 py-3.5">
                <span className="block text-[11px] uppercase tracking-[0.16em] text-mute-2">
                  账户余额
                </span>
                <strong className="mt-1.5 block font-display text-xl">
                  ${runtime.cash.toFixed(2)}
                </strong>
              </div>
              <div className="rounded-xl border border-line bg-inset px-4 py-3.5">
                <span className="block text-[11px] uppercase tracking-[0.16em] text-mute-2">
                  活跃市场
                </span>
                <strong className="mt-1.5 block font-display text-xl">{runtime.markets.length}</strong>
              </div>
              <div className="rounded-xl border border-line bg-inset px-4 py-3.5">
                <span className="block text-[11px] uppercase tracking-[0.16em] text-mute-2">
                  开放订单
                </span>
                <strong className="mt-1.5 block font-display text-xl">{orders}</strong>
              </div>
              <div className="rounded-xl border border-line bg-inset px-4 py-3.5">
                <ExposureBar
                  used={runtime.accountNotionalUsed}
                  limit={runtime.accountNotionalLimit}
                  label="实时账户占用"
                />
              </div>
            </>
          )}
          {limits && (
            <div className="sm:col-span-2 xl:col-span-4">
              <label
                className="grid max-w-md gap-2 text-xs font-medium text-mute"
                htmlFor="account-limit"
              >
                账户额度上限
                <div className="flex gap-2">
                  <input
                    className={inputClass}
                    id="account-limit"
                    type="number"
                    min="0"
                    value={draftLimit}
                    onChange={(event) => setDraftLimit(Number(event.target.value))}
                  />
                  <Button disabled={busy} onClick={saveLimit} variant="secondary">
                    热更新
                  </Button>
                </div>
              </label>
              <p className="mt-2 mb-0 text-[12px] text-mute">
                0 表示不限制账户占用。限价买单锁定的是价格 × 股数，不是股份面额；$400
                余额大约能挂 4 万股 1¢ 单。全场/单局单盘 ${limits.maxGameNotional}，让分/总数单盘 $
                {limits.maxMapNotional}。单笔不超过 ${limits.maxOrderNotional}。
              </p>
            </div>
          )}
        </section>
      )}

      {!running && (
        <section className="rounded-[18px] border border-dashed border-line bg-panel px-8 py-16 text-center">
          <span className="text-[11px] font-semibold tracking-[0.22em] text-gold">OFFLINE</span>
          <h2 className="mt-3 mb-2 font-display text-2xl font-medium">还没有挂单</h2>
          <p className="m-0 text-sm text-mute">
            在赛事页勾选小局或启动自动跟赔后会自动开始实盘挂单。这里只用来查看仓位、改价和锁定停止。
          </p>
        </section>
      )}
      {running && !runtime && (
        <section className="rounded-[18px] border border-dashed border-line bg-panel px-8 py-16 text-center text-sm text-mute">
          等待核心首次状态快照…
        </section>
      )}

      {runtime && (
        <section className="grid gap-3">
          {runtime.markets.map((market) => (
            <MarketStatusCard
              market={market}
              desk={desk.markets[market.sourceMarketId]}
              mode={runtime.mode}
              busy={busy}
              key={market.sourceMarketId}
              onPause={() => void pauseMarket(market.sourceMarketId)}
              onResume={() => void resumeMarket(market.sourceMarketId)}
              onCancel={(orderId) => void cancelOrder(market, orderId)}
            />
          ))}
        </section>
      )}
    </div>
  );
}
