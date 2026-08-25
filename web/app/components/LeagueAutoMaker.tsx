"use client";

import { useEffect, useMemo, useState } from "react";
import {
  api,
  type LeagueCandidate,
  type LeagueDiscoveryResult,
  type LeagueSummary,
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
        weekday: "short",
      })
    : "时间待定";
}

function cents(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${(value * 100).toFixed(0)}¢`;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

export function LeagueAutoMaker({ limits, makerRunning, onSaved }: LeagueAutoMakerProps) {
  const [leagues, setLeagues] = useState<LeagueSummary[]>([]);
  const [leagueId, setLeagueId] = useState("kpl");
  const [result, setResult] = useState<LeagueDiscoveryResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [swapped, setSwapped] = useState<Set<string>>(new Set());
  const [orderNotional, setOrderNotional] = useState(5);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const activeLeague = leagues.find((league) => league.id === leagueId) ?? leagues[0];
  const candidates = result?.matched ?? [];
  const selectedCandidates = useMemo(
    () => candidates.filter((candidate) => selected.has(candidate.sourceMatchId)),
    [candidates, selected],
  );
  const estimatedNotional = selectedCandidates.length * orderNotional * 2;
  const budgetExceeded = limits !== null && estimatedNotional > limits.maxAccountNotional + 1e-9;

  useEffect(() => {
    void api<{ leagues: LeagueSummary[] }>("/api/leagues")
      .then((payload) => {
        setLeagues(payload.leagues);
        const fallback = payload.leagues.find((league) => league.isDefault) ?? payload.leagues[0];
        if (fallback) setLeagueId(fallback.id);
      })
      .catch((caught) => {
        setError(caught instanceof Error ? caught.message : String(caught));
      });
  }, []);

  async function discover(nextLeagueId = leagueId) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const next = await api<LeagueDiscoveryResult>(`/api/leagues/${nextLeagueId}/discover`);
      setResult(next);
      setSelected(new Set(next.matched.map((candidate) => candidate.sourceMatchId)));
      setSwapped(new Set());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  function selectLeague(nextId: string) {
    setLeagueId(nextId);
    setResult(null);
    setSelected(new Set());
    setSwapped(new Set());
    setMessage("");
    setError("");
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
      `将配置 ${selectedCandidates.length} 场 ${activeLeague?.shortName ?? "联赛"} 全场胜负，每边一层、每层 $${orderNotional.toFixed(2)}。确认继续？`,
    );
    if (!confirmed) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/leagues/${leagueId}/config`, {
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
          ? "批量配置已写入，交易核心正在热加载。"
          : "批量配置已写入，可到交易台启动核心。",
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="leagueDesk">
      <div className="leagueDeskHead">
        <div>
          <p className="eyebrow">League discovery</p>
          <h2>联赛一键做市</h2>
          <p>
            从源站拉开放赛程，按队名和时间对齐 Polymarket 全场胜负，只挂一层买一前 1
            tick。方向仍需你确认。
          </p>
        </div>
        <div className="leagueSwitch" role="tablist" aria-label="选择联赛">
          {(leagues.length > 0 ? leagues : [{ id: "kpl", shortName: "KPL", name: "KPL" }]).map(
            (league) => (
              <button
                aria-selected={league.id === leagueId}
                className={league.id === leagueId ? "active" : undefined}
                key={league.id}
                onClick={() => selectLeague(league.id)}
                role="tab"
                type="button"
              >
                {league.shortName}
              </button>
            ),
          )}
        </div>
      </div>

      <div className="leagueToolbar">
        <div className="leagueMeta">
          <strong>{activeLeague?.name ?? "King Pro League"}</strong>
          <span>{activeLeague?.description ?? "王者荣耀职业联赛"}</span>
        </div>
        <button className="primary" disabled={busy} onClick={() => void discover()} type="button">
          {busy ? "正在扫描…" : result ? `重新扫描 ${activeLeague?.shortName ?? ""}` : "扫描赛程"}
        </button>
      </div>

      {error && <div className="error">{error}</div>}
      {message && <div className="successMessage">{message}</div>}

      {result && (
        <>
          <div className="leagueStats">
            <div>
              <span>可配置</span>
              <b>{result.matched.length}</b>
            </div>
            <div>
              <span>待复核</span>
              <b>{result.review.length}</b>
            </div>
            <div>
              <span>未匹配</span>
              <b>{result.rejected.length}</b>
            </div>
            <label>
              每边额度
              <input
                min="1"
                onChange={(event) => setOrderNotional(Number(event.target.value))}
                step="0.5"
                type="number"
                value={orderNotional}
              />
            </label>
          </div>
          {limits && (
            <ExposureBar
              label="本次预计账户占用"
              limit={limits.maxAccountNotional}
              used={estimatedNotional}
            />
          )}

          {candidates.length === 0 && (
            <div className="empty">
              没有可自动启用的 {activeLeague?.shortName}{" "}
              全场盘。查看下方未匹配原因，或改用手动链接。
            </div>
          )}

          <div className="matchTicketList">
            {candidates.map((candidate) => {
              const reverse = swapped.has(candidate.sourceMatchId);
              const checked = selected.has(candidate.sourceMatchId);
              return (
                <article
                  className={`matchTicket ${checked ? "selected" : ""}`}
                  key={candidate.sourceMatchId}
                >
                  <header className="matchTicketTop">
                    <label className="leagueCheck">
                      <input checked={checked} onChange={() => toggle(candidate)} type="checkbox" />
                      <span>
                        {timeLabel(candidate.startTime)}
                        <small>
                          {candidate.tournament}
                          {candidate.bestOf ? ` · BO${candidate.bestOf}` : ""}
                        </small>
                      </span>
                    </label>
                    <em>{pct(candidate.confidence)} 置信</em>
                  </header>
                  <div className="matchTicketTeams">
                    <strong>{candidate.teams[0]}</strong>
                    <span>VS</span>
                    <strong>{candidate.teams[1]}</strong>
                  </div>
                  {candidate.englishTeams && (
                    <div className="matchTicketEn">
                      {candidate.englishTeams[0]} · {candidate.englishTeams[1]}
                    </div>
                  )}
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
                          <b>{cents(book?.topPrice)}</b>
                          <small>
                            买一 {cents(book?.bestBid)} / 卖一 {cents(book?.bestAsk)} · 源{" "}
                            {outcome.decimalOdd.toFixed(2)}
                          </small>
                        </div>
                      );
                    })}
                  </div>
                  {candidate.notes && candidate.notes.length > 0 && (
                    <ul className="matchNotes">
                      {candidate.notes.map((note) => (
                        <li key={note}>{note}</li>
                      ))}
                    </ul>
                  )}
                  <footer className="matchTicketFoot">
                    <a href={candidate.polymarketUrl} rel="noreferrer" target="_blank">
                      Polymarket
                    </a>
                    <button className="swapButton" onClick={() => swap(candidate)} type="button">
                      交换配对
                    </button>
                  </footer>
                </article>
              );
            })}
          </div>

          {(result.review.length > 0 || result.rejected.length > 0) && (
            <details className="leagueIssues">
              <summary>未自动启用 {result.review.length + result.rejected.length} 场</summary>
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
              disabled={busy || selectedCandidates.length === 0 || budgetExceeded}
              onClick={() => void saveBatch()}
              type="button"
            >
              确认配置 {selectedCandidates.length} 场全场
            </button>
          </div>
        </>
      )}
    </section>
  );
}
