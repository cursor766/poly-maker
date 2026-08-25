"use client";

import { useCallback, useEffect, useState } from "react";
import { ExposureBar } from "@/app/components/ExposureBar";
import { MarketStatusCard } from "@/app/components/MarketStatusCard";
import { StatusPill } from "@/app/components/StatusPill";
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
    <div className="tradingDesk">
      <header className="deskHero">
        <div>
          <div className="eyebrow">Realtime maker operations</div>
          <h1>做市交易台</h1>
          <div className="connectionRow">
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
        <div className="deskControls">
          {!running ? (
            <>
              <select value={mode} onChange={(event) => setMode(event.target.value as TradingMode)}>
                <option value="paper">PAPER</option>
                <option value="shadow">SHADOW</option>
                <option value="live">LIVE</option>
              </select>
              <button className="primary" type="button" disabled={busy} onClick={start}>
                启动核心
              </button>
            </>
          ) : (
            <button className="danger" type="button" disabled={busy} onClick={stop}>
              锁定并停止
            </button>
          )}
        </div>
      </header>

      {error && <div className="error">{error}</div>}

      {runtime && (
        <section className="deskOverview">
          <div className="overviewMetric">
            <span>账户余额</span>
            <strong>${runtime.cash.toFixed(2)}</strong>
          </div>
          <div className="overviewMetric">
            <span>活跃市场</span>
            <strong>{runtime.markets.length}</strong>
          </div>
          <div className="overviewMetric">
            <span>开放订单</span>
            <strong>{orders}</strong>
          </div>
          <div className="overviewExposure">
            <ExposureBar
              used={runtime.accountNotionalUsed}
              limit={runtime.accountNotionalLimit}
              label="实时账户占用"
            />
          </div>
          <div className="limitEditor">
            <label htmlFor="account-limit">账户额度上限</label>
            <div>
              <input
                id="account-limit"
                type="number"
                min="1"
                value={draftLimit}
                onChange={(event) => setDraftLimit(Number(event.target.value))}
              />
              <button className="secondary" type="button" disabled={busy} onClick={saveLimit}>
                热更新
              </button>
            </div>
          </div>
        </section>
      )}

      {!running && (
        <section className="deskEmpty">
          <span>OFFLINE</span>
          <h2>交易核心未运行</h2>
          <p>先在市场配置中启用盘口，然后从这里启动。配置修改可在运行中热生效。</p>
        </section>
      )}
      {running && !runtime && <section className="deskEmpty">等待核心首次状态快照…</section>}

      {runtime && (
        <section className="deskMarketGrid">
          {runtime.markets.map((market) => (
            <MarketStatusCard market={market} key={market.sourceMarketId} />
          ))}
        </section>
      )}
    </div>
  );
}
