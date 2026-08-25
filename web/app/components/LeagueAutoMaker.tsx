"use client";

import { useMemo, useState } from "react";
import {
  api,
  type LeagueCandidate,
  type LeagueDiscoveryResult,
  type RuntimeLimits,
} from "@/lib/api";
import { ExposureBar } from "./ExposureBar";

interface LeagueAutoMakerProps {
  limits: RuntimeLimits | null;
  makerRunning: boolean;
  onSaved: () => Promise<void>;
}

function timeLabel(value: number): string {
  return value > 0
    ? new Date(value).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "时间待定";
}

function cents(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(0)}¢`;
}

export function LeagueAutoMaker({ limits, makerRunning, onSaved }: LeagueAutoMakerProps) {
  const [result, setResult] = useState<LeagueDiscoveryResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [swapped, setSwapped] = useState<Set<string>>(new Set());
  const [orderNotional, setOrderNotional] = useState(5);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const candidates = result?.matched ?? [];
  const selectedCandidates = useMemo(
    () => candidates.filter((candidate) => selected.has(candidate.sourceMatchId)),
    [candidates, selected],
  );
  const estimatedNotional = selectedCandidates.length * orderNotional * 2;
  const budgetExceeded = limits !== null && estimatedNotional > limits.maxAccountNotional + 1e-9;

  async function discover() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const next = await api<LeagueDiscoveryResult>("/api/leagues/kgl/discover");
      setResult(next);
      setSelected(new Set(next.matched.map((candidate) => candidate.sourceMatchId)));
      setSwapped(new Set());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  function toggle(candidate: LeagueCandidate) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(candidate.sourceMatchId)) next.delete(candidate.sourceMatchId);
      else next.add(candidate.sourceMatchId);
      return next;
    });
  }

  function swap(candidate: LeagueCandidate) {
    setSwapped((current) => {
      const next = new Set(current);
      if (next.has(candidate.sourceMatchId)) next.delete(candidate.sourceMatchId);
      else next.add(candidate.sourceMatchId);
      return next;
    });
  }

  async function saveBatch() {
    if (selectedCandidates.length === 0 || !limits) return;
    const confirmed = window.confirm(
      `将一次配置 ${selectedCandidates.length} 场 KGL 全场胜负，每边只挂一层、每层 $${orderNotional.toFixed(2)}。确认继续？`,
    );
    if (!confirmed) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/leagues/kgl/config", {
        method: "POST",
        body: JSON.stringify({
          matches: selectedCandidates.map((candidate) => {
            const reverse = swapped.has(candidate.sourceMatchId);
            return {
              sourceMatchId: candidate.sourceMatchId,
              polymarketEventSlug: candidate.eventSlug,
              sourceUrl: candidate.sourceUrl,
              polymarketUrl: candidate.polymarketUrl,
              teams: candidate.teams,
              tournament: candidate.tournament,
              markets: [
                {
                  name: `${candidate.teams.join(" vs ")} - 全场胜负`,
                  enabled: true,
                  sourceMarketId: candidate.market.sourceMarketId,
                  polymarketSlug: candidate.market.polymarketSlug,
                  round: 0,
                  quoteMode: "top-of-book",
                  outcomes: candidate.market.outcomes.map((outcome, index) => ({
                    sourceOddId: outcome.sourceOddId,
                    outcome:
                      candidate.market.outcomes[reverse ? 1 - index : index]
                        ?.suggestedPolymarketOutcome ?? outcome.suggestedPolymarketOutcome,
                  })),
                  orderNotional,
                  quoteLevels: 1,
                  levelSpacingTicks: 1,
                  targetReturnRate: limits.makerTargetReturnRate,
                },
              ],
            };
          }),
        }),
      });
      await onSaved();
      setMessage(
        makerRunning
          ? "批量配置已保存，交易核心正在热加载。"
          : "批量配置已保存，可前往交易台启动核心。",
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel leaguePanel">
      <div className="panelTitle">
        <div>
          <div className="eyebrow">KGL batch discovery</div>
          <h2>KGL 一键自动做市</h2>
          <p>自动匹配源站与 Polymarket，只配置全场胜负，并抢最高买价前 1 tick。</p>
        </div>
        <button className="primary" type="button" disabled={busy} onClick={discover}>
          {busy ? "发现中…" : result ? "重新发现" : "一键发现 KGL"}
        </button>
      </div>

      {error && <div className="error">{error}</div>}
      {message && <div className="successMessage">{message}</div>}

      {result && (
        <>
          <div className="leagueSummary">
            <span>
              可安全配置 <b>{result.matched.length}</b>
            </span>
            <span>
              需人工处理 <b>{result.review.length}</b>
            </span>
            <span>
              无法匹配 <b>{result.rejected.length}</b>
            </span>
            <label>
              每边额度 $
              <input
                type="number"
                min="1"
                step="0.5"
                value={orderNotional}
                onChange={(event) => setOrderNotional(Number(event.target.value))}
              />
            </label>
          </div>
          {limits && (
            <ExposureBar
              used={estimatedNotional}
              limit={limits.maxAccountNotional}
              label="本次预计账户占用"
            />
          )}

          <div className="leagueCandidateList">
            {candidates.map((candidate) => {
              const reverse = swapped.has(candidate.sourceMatchId);
              return (
                <article className="leagueCandidate" key={candidate.sourceMatchId}>
                  <label className="leagueCheck">
                    <input
                      type="checkbox"
                      checked={selected.has(candidate.sourceMatchId)}
                      onChange={() => toggle(candidate)}
                    />
                    <span>
                      <strong>{candidate.teams.join(" vs ")}</strong>
                      <small>
                        {timeLabel(candidate.startTime)} · 匹配置信度{" "}
                        {(candidate.confidence * 100).toFixed(0)}%
                      </small>
                    </span>
                  </label>
                  <div className="leagueOutcomes">
                    {candidate.market.outcomes.map((outcome, index) => {
                      const mapped =
                        candidate.market.outcomes[reverse ? 1 - index : index]
                          ?.suggestedPolymarketOutcome ?? outcome.suggestedPolymarketOutcome;
                      const book = candidate.books[mapped];
                      return (
                        <div key={outcome.sourceOddId}>
                          <span>
                            {outcome.sourceName} → {mapped}
                          </span>
                          <b>{cents(book?.topPrice ?? null)}</b>
                          <small>
                            买一 {cents(book?.bestBid ?? null)} / 卖一{" "}
                            {cents(book?.bestAsk ?? null)}
                          </small>
                        </div>
                      );
                    })}
                  </div>
                  <button className="swapButton" type="button" onClick={() => swap(candidate)}>
                    交换配对
                  </button>
                </article>
              );
            })}
          </div>

          {(result.review.length > 0 || result.rejected.length > 0) && (
            <details className="leagueIssues">
              <summary>查看未自动启用的比赛</summary>
              {result.review.map((candidate) => (
                <p key={`review-${candidate.sourceMatchId}`}>
                  {candidate.teams.join(" vs ")}：{candidate.reason}
                </p>
              ))}
              {result.rejected.map((item) => (
                <p key={`rejected-${item.sourceMatchId}`}>
                  {item.teams.join(" vs ")}：{item.reason}
                </p>
              ))}
            </details>
          )}
          <div className="actions">
            <button
              className="primary"
              type="button"
              disabled={busy || selectedCandidates.length === 0 || budgetExceeded}
              onClick={saveBatch}
            >
              确认并批量配置 {selectedCandidates.length} 场
            </button>
          </div>
        </>
      )}
    </section>
  );
}
