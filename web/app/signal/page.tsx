"use client";

import { useCallback, useEffect, useState } from "react";
import { StatusPill } from "@/app/components/StatusPill";
import { api, type SignalEvent, type SignalMonitorSnapshot, type SignalVerdict } from "@/lib/api";
import { subscribeToSignalMonitor } from "@/lib/stream";

const DEFAULT_SOURCE = "5841185802920233";
const DEFAULT_EVENT = "lol-jdg-edg-2026-08-07";
const DEFAULT_MARKET = "lol-jdg-edg-2026-08-07-game1";

function pct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

function money(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `$${value.toFixed(2)}`;
}

function lag(value: number | null | undefined): string {
  if (value === null || value === undefined) return "等待 Poly 跟进";
  if (value < 1000) return `${value} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

function verdictLabel(verdict: SignalVerdict): string {
  switch (verdict) {
    case "fillable":
      return "能吃满";
    case "partial":
      return "只能部分吃";
    case "no_liquidity":
      return "没流动性";
    case "already_priced":
      return "已经定价";
    case "no_edge":
      return "没边际";
    case "lock_watch":
      return "锁盘观察";
  }
}

function kindLabel(kind: SignalEvent["kind"]): string {
  if (kind === "lock") return "锁盘";
  if (kind === "unlock") return "解锁";
  return "跳价";
}

function verdictClass(verdict: SignalVerdict): string {
  if (verdict === "fillable") return "signalGood";
  if (verdict === "partial" || verdict === "lock_watch") return "signalWarn";
  return "signalBad";
}

function freshness(ts: number | null | undefined): string {
  if (!ts) return "无";
  const age = Date.now() - ts;
  if (age < 1500) return "刚刚";
  if (age < 10_000) return `${Math.round(age / 1000)}s 前`;
  return new Date(ts).toLocaleTimeString();
}

export default function SignalPage() {
  const [snapshot, setSnapshot] = useState<SignalMonitorSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [sourceMatchId, setSourceMatchId] = useState(DEFAULT_SOURCE);
  const [eventSlug, setEventSlug] = useState(DEFAULT_EVENT);
  const [marketSlug, setMarketSlug] = useState(DEFAULT_MARKET);
  const [jumpThreshold, setJumpThreshold] = useState(0.015);
  const [notionalUsd, setNotionalUsd] = useState(50);
  const [maxSlippage, setMaxSlippage] = useState(0.02);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    void api<SignalMonitorSnapshot>("/api/signal-monitor")
      .then((initial) => {
        setSnapshot(initial);
        setSourceMatchId(initial.options.sourceMatchId);
        setEventSlug(initial.options.polymarketEventSlug);
        setMarketSlug(initial.options.polymarketMarketSlug);
        setJumpThreshold(initial.options.jumpThreshold);
        setNotionalUsd(initial.options.notionalUsd);
        setMaxSlippage(initial.options.maxSlippage);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    return subscribeToSignalMonitor(setSnapshot, setConnected);
  }, []);

  const start = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = await api<SignalMonitorSnapshot>("/api/signal-monitor/start", {
        method: "POST",
        body: JSON.stringify({
          sourceMatchId,
          polymarketEventSlug: eventSlug,
          polymarketMarketSlug: marketSlug,
          jumpThreshold,
          notionalUsd,
          maxSlippage,
        }),
      });
      setSnapshot(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [sourceMatchId, eventSlug, marketSlug, jumpThreshold, notionalUsd, maxSlippage]);

  const stop = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setSnapshot(await api<SignalMonitorSnapshot>("/api/signal-monitor/stop", { method: "POST" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const outcomes = snapshot?.outcomes ?? snapshot?.teams;
  const flash = snapshot?.signals[0] && Date.now() - snapshot.signals[0].at < 8000;

  return (
    <div className="signalPage">
      <p className="eyebrow">LIVE SIGNAL LAB</p>
      <h1>源站信号 → Polymarket 吃单模拟</h1>
      <p className="lead">
        重大团战源站会先<strong>锁盘</strong>（赔率停更），解锁后才跳价。本页同时盯锁盘窗口与解锁后的第一跳，判断那时去
        Polymarket 吃单能不能吃到。默认 G1；局结束后可把 Market 改成{" "}
        <code>lol-jdg-edg-2026-08-07-game2</code>。
      </p>

      <section className="panel signalControls">
        <div className="panelTitle">
          <div>
            <h2>监听参数</h2>
            <p>默认已填本场 G1；可调跳动阈值、名义金额与滑点。</p>
          </div>
          <div className="signalActions">
            <StatusPill
              ok={connected}
              label={connected ? "SSE 已连接" : "SSE 断开"}
            />
            {snapshot?.running ? (
              <button className="danger" disabled={loading} onClick={() => void stop()} type="button">
                停止监听
              </button>
            ) : (
              <button className="primary" disabled={loading} onClick={() => void start()} type="button">
                开始监听 G1
              </button>
            )}
          </div>
        </div>

        <div className="signalFormGrid">
          <label className="field">
            源站 Match ID
            <input value={sourceMatchId} onChange={(e) => setSourceMatchId(e.target.value)} />
          </label>
          <label className="field">
            Polymarket Event
            <input value={eventSlug} onChange={(e) => setEventSlug(e.target.value)} />
          </label>
          <label className="field">
            Polymarket Market
            <input value={marketSlug} onChange={(e) => setMarketSlug(e.target.value)} />
          </label>
          <label className="field">
            跳动阈值
            <input
              type="number"
              min={0.005}
              max={0.2}
              step={0.005}
              value={jumpThreshold}
              onChange={(e) => setJumpThreshold(Number(e.target.value))}
            />
          </label>
          <label className="field">
            模拟吃单金额 ($)
            <input
              type="number"
              min={5}
              max={1000}
              step={5}
              value={notionalUsd}
              onChange={(e) => setNotionalUsd(Number(e.target.value))}
            />
          </label>
          <label className="field">
            最大滑点
            <input
              type="number"
              min={0.01}
              max={0.1}
              step={0.01}
              value={maxSlippage}
              onChange={(e) => setMaxSlippage(Number(e.target.value))}
            />
          </label>
        </div>
        {error ? <p className="errorText">{error}</p> : null}
        {snapshot?.lastError ? <p className="errorText">服务：{snapshot.lastError}</p> : null}
      </section>

      <section className={`panel signalHero ${flash ? "signalFlash" : ""}`}>
        <div className="signalStatusRow">
          <StatusPill ok={!!snapshot?.running} label={snapshot?.running ? "监听中" : "未启动"} />
          <StatusPill ok={!!snapshot?.mqttConnected} label="源站 MQTT" />
          <StatusPill ok={!!snapshot?.polymarketConnected} label="Polymarket WS" />
          <StatusPill ok={!!snapshot?.sourceBound} label={snapshot?.sourceBound ? "已绑定盘口" : "等待绑定"} />
          <StatusPill
            ok={!snapshot?.sourceLocked}
            label={
              snapshot?.sourceLocked
                ? `源站锁盘中${snapshot.lockStartedAt ? ` · ${Math.max(0, Math.round((Date.now() - snapshot.lockStartedAt) / 1000))}s` : ""}`
                : "源站开盘"
            }
          />
        </div>

        <div className="signalCompare">
          <div className={snapshot?.sourceLocked ? "lockedPanel" : undefined}>
            <span className="muted">源站公平价{snapshot?.sourceLocked ? "（已冻结）" : ""}</span>
            <strong>
              {outcomes?.[0] ?? "T1"} {pct(snapshot?.sourceFairs[0])}
            </strong>
            <strong>
              {outcomes?.[1] ?? "T2"} {pct(snapshot?.sourceFairs[1])}
            </strong>
            <small suppressHydrationWarning>
              更新 {freshness(snapshot?.sourceUpdatedAt ?? null)}
              {snapshot?.sourceLocked && snapshot.preLockFairs[0] !== null
                ? ` · 锁前 ${pct(snapshot.preLockFairs[0])}`
                : ""}
              <span style={{ display: "none" }}>{tick}</span>
            </small>
          </div>
          <div>
            <span className="muted">Polymarket 中价</span>
            <strong>
              {outcomes?.[0] ?? "T1"} {pct(snapshot?.polyMids[0])}
            </strong>
            <strong>
              {outcomes?.[1] ?? "T2"} {pct(snapshot?.polyMids[1])}
            </strong>
            <small suppressHydrationWarning>
              Ask {pct(snapshot?.polyAsks[0])} / {pct(snapshot?.polyAsks[1])} · 更新{" "}
              {freshness(snapshot?.polyUpdatedAt ?? null)}
            </small>
          </div>
        </div>

        <div className="signalStats">
          <div>
            <span>锁盘 / 解锁</span>
            <strong>
              {snapshot?.stats.locks ?? 0}/{snapshot?.stats.unlocks ?? 0}
            </strong>
          </div>
          <div>
            <span>能吃满</span>
            <strong className="good">{snapshot?.stats.fillable ?? 0}</strong>
          </div>
          <div>
            <span>部分/错过</span>
            <strong>
              {(snapshot?.stats.partial ?? 0) + (snapshot?.stats.missed ?? 0)}
            </strong>
          </div>
          <div>
            <span>Poly 平均滞后</span>
            <strong>{lag(snapshot?.stats.avgLagMs)}</strong>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panelTitle">
          <div>
            <h2>锁盘 / 解锁 / 跳价机会</h2>
            <p>团战锁盘时源站停更；解锁后第一跳才带方向。表里会分别标记锁盘观察与解锁吃单结果。</p>
          </div>
        </div>
        <div className="signalTableWrap">
          <table className="signalTable">
            <thead>
              <tr>
                <th>时间</th>
                <th>类型</th>
                <th>方向 / 事件</th>
                <th>源站变化</th>
                <th>Poly Ask</th>
                <th>模拟成交</th>
                <th>锁盘期 Poly</th>
                <th>结论</th>
              </tr>
            </thead>
            <tbody>
              {(snapshot?.signals ?? []).length === 0 ? (
                <tr>
                  <td colSpan={8} className="emptyCell">
                    {snapshot?.running
                      ? "已监听。等团战锁盘，或解锁后的第一跳…"
                      : "点击「开始监听 G1」后，这里会滚动出现机会。"}
                  </td>
                </tr>
              ) : (
                snapshot?.signals.map((signal) => <SignalRow key={signal.id} signal={signal} />)
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function SignalRow({ signal }: { signal: SignalEvent }) {
  return (
    <tr>
      <td>{new Date(signal.at).toLocaleTimeString()}</td>
      <td>
        <span className={`signalKind ${signal.kind}`}>{kindLabel(signal.kind)}</span>
        {signal.lockDurationMs != null ? (
          <small className="blockMuted">锁 {(signal.lockDurationMs / 1000).toFixed(1)}s</small>
        ) : null}
      </td>
      <td>
        {signal.side === "BUY" ? `BUY ${signal.outcome}` : signal.outcome}
        <small className="blockMuted">{signal.reason}</small>
      </td>
      <td>
        {pct(signal.sourcePrev)} → {pct(signal.sourceFair)}
        <small className="blockMuted">
          {signal.sourceDelta >= 0 ? "+" : ""}
          {pct(signal.sourceDelta)}
        </small>
      </td>
      <td>
        {pct(signal.polyAskAtSignal)}
        <small className="blockMuted">mid {pct(signal.polyMidAtSignal)}</small>
      </td>
      <td>
        {signal.side === "WATCH" ? "—" : money(signal.fill.filledUsd)}
        <small className="blockMuted">
          {signal.side === "WATCH"
            ? "等待方向"
            : `VWAP ${pct(signal.fill.vwap)} · edge ${pct(signal.fill.edgeVsSource)}`}
        </small>
      </td>
      <td>
        {signal.polyMovedDuringLock === null
          ? "—"
          : `${signal.polyMovedDuringLock >= 0 ? "+" : ""}${pct(signal.polyMovedDuringLock)}`}
        <small className="blockMuted">
          {signal.polyLagMs != null ? `解锁后滞后 ${lag(signal.polyLagMs)}` : ""}
        </small>
      </td>
      <td>
        <span className={`signalTag ${verdictClass(signal.verdict)}`}>
          {verdictLabel(signal.verdict)}
        </span>
      </td>
    </tr>
  );
}
