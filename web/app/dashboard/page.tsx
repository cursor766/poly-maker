"use client";

import { useCallback, useEffect, useState } from "react";
import { ExposureBar } from "@/app/components/ExposureBar";
import { MarketStatusCard } from "@/app/components/MarketStatusCard";
import { StatusPill } from "@/app/components/StatusPill";
import { Button, errorClass, inputClass } from "@/app/components/ui";
import { api, type ControlStatus, type RuntimeLimits, type TradingMode } from "@/lib/api";
import { subscribeToStatus } from "@/lib/stream";

export default function DashboardPage() {
  const [status, setStatus] = useState<ControlStatus | null>(null);
  const [limits, setLimits] = useState<RuntimeLimits | null>(null);
  const [draftLimit, setDraftLimit] = useState(0);
  const [mode, setMode] = useState<TradingMode>("shadow");
  const [streamConnected, setStreamConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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

      {runtime && (
        <section className="mb-5 grid gap-2.5 rounded-[18px] border border-line bg-panel p-5 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-xl border border-line bg-inset px-4 py-3.5">
            <span className="block text-[11px] uppercase tracking-[0.16em] text-mute-2">账户余额</span>
            <strong className="mt-1.5 block font-display text-xl">${runtime.cash.toFixed(2)}</strong>
          </div>
          <div className="rounded-xl border border-line bg-inset px-4 py-3.5">
            <span className="block text-[11px] uppercase tracking-[0.16em] text-mute-2">活跃市场</span>
            <strong className="mt-1.5 block font-display text-xl">{runtime.markets.length}</strong>
          </div>
          <div className="rounded-xl border border-line bg-inset px-4 py-3.5">
            <span className="block text-[11px] uppercase tracking-[0.16em] text-mute-2">开放订单</span>
            <strong className="mt-1.5 block font-display text-xl">{orders}</strong>
          </div>
          <div className="rounded-xl border border-line bg-inset px-4 py-3.5">
            <ExposureBar
              used={runtime.accountNotionalUsed}
              limit={runtime.accountNotionalLimit}
              label="实时账户占用"
            />
          </div>
          <div className="sm:col-span-2 xl:col-span-4">
            <label className="grid max-w-md gap-2 text-xs font-medium text-mute" htmlFor="account-limit">
              账户额度上限
              <div className="flex gap-2">
                <input
                  className={inputClass}
                  id="account-limit"
                  type="number"
                  min="1"
                  value={draftLimit}
                  onChange={(event) => setDraftLimit(Number(event.target.value))}
                />
                <Button disabled={busy} onClick={saveLimit} variant="secondary">
                  热更新
                </Button>
              </div>
            </label>
          </div>
        </section>
      )}

      {!running && (
        <section className="rounded-[18px] border border-dashed border-line bg-panel px-8 py-16 text-center">
          <span className="text-[11px] font-semibold tracking-[0.22em] text-gold">OFFLINE</span>
          <h2 className="mt-3 mb-2 font-display text-2xl font-medium">交易核心未运行</h2>
          <p className="m-0 text-sm text-mute">
            先在市场配置中启用盘口，然后从这里启动。配置修改可在运行中热生效。
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
            <MarketStatusCard market={market} key={market.sourceMarketId} />
          ))}
        </section>
      )}
    </div>
  );
}
