"use client";

import { useEffect, useMemo, useState } from "react";
import {
  api,
  type LeagueCandidate,
  type LeagueDiscoveryResult,
  type LeagueSummary,
  type MarketPreview,
  type RuntimeLimits,
} from "@/lib/api";
import { ExposureBar } from "./ExposureBar";
import { Button, errorClass, inputClass, panelClass, successClass } from "./ui";

interface LeagueAutoMakerProps {
  limits: RuntimeLimits | null;
  makerRunning: boolean;
  onSaved: () => Promise<void>;
}

function timeLabel(value: number): string {
  return value > 0
    ? new Date(value).toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
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
  const [targetReturnRate, setTargetReturnRate] = useState(0.95);
  const [includeGameWinners, setIncludeGameWinners] = useState(false);
  const [includeMapMarkets, setIncludeMapMarkets] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const activeLeague = leagues.find((league) => league.id === leagueId) ?? leagues[0];
  const matched = result?.matched ?? [];
  const review = result?.review ?? [];
  const candidates = useMemo(() => [...matched, ...review], [matched, review]);
  const selectedCandidates = useMemo(
    () => candidates.filter((candidate) => selected.has(candidate.sourceMatchId)),
    [candidates, selected],
  );
  const extraFactor = 1 + (includeGameWinners ? 6 : 0) + (includeMapMarkets ? 5 : 0);
  const estimatedNotional = selectedCandidates.length * orderNotional * 2 * extraFactor;
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
    const reviewCount = selectedCandidates.filter((candidate) => candidate.reason).length;
    const extras = [includeGameWinners ? "局胜者" : "", includeMapMarkets ? "地图让分/总数" : ""]
      .filter(Boolean)
      .join("、");
    const confirmed = window.confirm(
      `将配置 ${selectedCandidates.length} 场 ${activeLeague?.shortName ?? "联赛"} 全场胜负${
        extras ? `，并尽量带上${extras}` : ""
      }，每边一层、每层 $${orderNotional.toFixed(2)}、目标回报 ${(targetReturnRate * 100).toFixed(0)}%${
        reviewCount > 0 ? `。其中 ${reviewCount} 场未通过自动安全检查，需你自行确认。` : "。"
      }确认继续？`,
    );
    if (!confirmed) return;
    setBusy(true);
    setError("");
    try {
      const matches = await Promise.all(
        selectedCandidates.map(async (candidate) => {
          const reverse = swapped.has(candidate.sourceMatchId);
          const winnerMarket = {
            name: `${candidate.teams.join(" vs ")} - 全场胜负`,
            enabled: true,
            sourceMarketId: candidate.market.sourceMarketId,
            polymarketSlug: candidate.market.polymarketSlug,
            round: 0,
            quoteMode: "top-of-book" as const,
            outcomes: candidate.market.outcomes.map((outcome, index) => ({
              sourceOddId: outcome.sourceOddId,
              outcome:
                candidate.market.outcomes[reverse ? 1 - index : index]
                  ?.suggestedPolymarketOutcome ?? outcome.suggestedPolymarketOutcome,
            })),
            orderNotional,
            quoteLevels: 1,
            levelSpacingTicks: 1,
            targetReturnRate,
          };
          if (!includeGameWinners && !includeMapMarkets) {
            return {
              sourceMatchId: candidate.sourceMatchId,
              polymarketEventSlug: candidate.eventSlug,
              sourceUrl: candidate.sourceUrl,
              polymarketUrl: candidate.polymarketUrl,
              teams: candidate.teams,
              tournament: candidate.tournament,
              markets: [winnerMarket],
            };
          }
          const preview = await api<MarketPreview>("/api/preview", {
            method: "POST",
            body: JSON.stringify({
              sourceUrl: candidate.sourceUrl,
              polymarketUrl: candidate.polymarketUrl,
            }),
          });
          const extraMarkets = preview.markets.filter((market) => {
            const kind = market.kind ?? (market.round === 0 ? "moneyline" : "child_moneyline");
            if (kind === "moneyline") return false;
            if (includeGameWinners && kind === "child_moneyline") return true;
            if (includeMapMarkets && (kind === "map_handicap" || kind === "totals")) return true;
            return false;
          });
          return {
            sourceMatchId: candidate.sourceMatchId,
            polymarketEventSlug: candidate.eventSlug,
            sourceUrl: candidate.sourceUrl,
            polymarketUrl: candidate.polymarketUrl,
            teams: candidate.teams,
            tournament: candidate.tournament,
            markets: [
              winnerMarket,
              ...extraMarkets.map((market) => ({
                name: `${preview.teams.join(" vs ")} - ${market.name}`,
                enabled: market.tradable,
                sourceMarketId: market.sourceMarketId,
                polymarketSlug: market.polymarketSlug,
                round: market.round,
                quoteMode: "top-of-book" as const,
                outcomes: market.outcomes.map((outcome) => ({
                  sourceOddId: outcome.sourceOddId,
                  outcome: outcome.suggestedPolymarketOutcome,
                })),
                orderNotional,
                quoteLevels: 1,
                levelSpacingTicks: 1,
                targetReturnRate,
              })),
            ],
          };
        }),
      );
      await api(`/api/leagues/${leagueId}/config`, {
        method: "POST",
        body: JSON.stringify({ matches }),
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
    <section className={`${panelClass} mb-5`}>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-gold">
            League discovery
          </p>
          <h2 className="m-0 font-display text-[22px] font-medium tracking-tight">联赛一键做市</h2>
          <p className="mt-2 max-w-[62ch] text-sm leading-relaxed text-mute">
            从源站拉开放赛程，按队名和时间对齐 Polymarket。默认只挂全场一层买一前 1 tick；BO7
            可勾选局胜者与地图让分。80% 目标回报通常挂不进当前买一，建议 95%。
          </p>
        </div>
        <div
          className="flex rounded-lg border border-line bg-inset p-1"
          role="tablist"
          aria-label="选择联赛"
        >
          {(leagues.length > 0 ? leagues : [{ id: "kpl", shortName: "KPL", name: "KPL" }]).map(
            (league) => {
              const active = league.id === leagueId;
              return (
                <button
                  aria-selected={active}
                  className={`h-8 rounded-md px-3 text-[13px] font-semibold ${
                    active ? "bg-gold text-on-gold" : "text-mute hover:text-ink"
                  }`}
                  key={league.id}
                  onClick={() => selectLeague(league.id)}
                  role="tab"
                  type="button"
                >
                  {league.shortName}
                </button>
              );
            },
          )}
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <strong className="block text-[15px]">{activeLeague?.name ?? "King Pro League"}</strong>
          <span className="text-sm text-mute">
            {activeLeague?.description ?? "王者荣耀职业联赛"}
          </span>
        </div>
        <Button disabled={busy} onClick={() => void discover()}>
          {busy ? "正在扫描…" : result ? `重新扫描 ${activeLeague?.shortName ?? ""}` : "扫描赛程"}
        </Button>
      </div>

      {error && <div className={errorClass}>{error}</div>}
      {message && <div className={successClass}>{message}</div>}

      {result && (
        <>
          <div className="mb-4 grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-xl border border-line bg-inset px-4 py-3.5">
              <span className="block text-[11px] uppercase tracking-[0.16em] text-mute-2">
                可配置
              </span>
              <b className="mt-1.5 block font-display text-xl font-medium">
                {result.matched.length}
              </b>
            </div>
            <div className="rounded-xl border border-line bg-inset px-4 py-3.5">
              <span className="block text-[11px] uppercase tracking-[0.16em] text-mute-2">
                待复核
              </span>
              <b className="mt-1.5 block font-display text-xl font-medium">
                {result.review.length}
              </b>
            </div>
            <div className="rounded-xl border border-line bg-inset px-4 py-3.5">
              <span className="block text-[11px] uppercase tracking-[0.16em] text-mute-2">
                未匹配
              </span>
              <b className="mt-1.5 block font-display text-xl font-medium">
                {result.rejected.length}
              </b>
            </div>
            <label className="rounded-xl border border-line bg-inset px-4 py-3.5 text-[11px] uppercase tracking-[0.16em] text-mute-2">
              每边额度
              <input
                className={`${inputClass} mt-2`}
                min="1"
                onChange={(event) => setOrderNotional(Number(event.target.value))}
                step="0.5"
                type="number"
                value={orderNotional}
              />
            </label>
            <label className="rounded-xl border border-line bg-inset px-4 py-3.5 text-[11px] uppercase tracking-[0.16em] text-mute-2">
              目标回报 %
              <input
                className={`${inputClass} mt-2`}
                max="99"
                min="50"
                onChange={(event) => setTargetReturnRate(Number(event.target.value) / 100)}
                step="1"
                type="number"
                value={Math.round(targetReturnRate * 100)}
              />
            </label>
          </div>
          {limits && (
            <div className="mb-4">
              <ExposureBar
                label="本次预计账户占用"
                limit={limits.maxAccountNotional}
                used={estimatedNotional}
              />
            </div>
          )}

          {candidates.length === 0 && (
            <div className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-sm text-mute">
              没有可自动启用的 {activeLeague?.shortName}{" "}
              全场盘。查看下方未匹配原因，或改用手动链接。
            </div>
          )}

          <div className="grid gap-3">
            {candidates.map((candidate) => {
              const reverse = swapped.has(candidate.sourceMatchId);
              const checked = selected.has(candidate.sourceMatchId);
              const needsReview = Boolean(candidate.reason);
              return (
                <article
                  className={`rounded-[14px] border p-4 ${
                    checked
                      ? needsReview
                        ? "border-amber/45 bg-amber/[0.06]"
                        : "border-gold/40 bg-gold/[0.06]"
                      : needsReview
                        ? "border-amber/30 bg-inset"
                        : "border-line bg-inset"
                  }`}
                  key={candidate.sourceMatchId}
                >
                  <header className="mb-3 flex flex-wrap items-center justify-between gap-3">
                    <label className="flex items-center gap-2.5 text-sm">
                      <input checked={checked} onChange={() => toggle(candidate)} type="checkbox" />
                      <span>
                        {timeLabel(candidate.startTime)}
                        <small className="mt-0.5 block text-xs text-mute">
                          {candidate.tournament}
                          {candidate.bestOf ? ` · BO${candidate.bestOf}` : ""}
                        </small>
                      </span>
                    </label>
                    <em className="text-xs not-italic text-mute">
                      {pct(candidate.confidence)} 置信
                    </em>
                  </header>
                  <div className="grid grid-cols-[1fr_auto_1fr] items-stretch gap-2">
                    {candidate.market.outcomes.map((outcome, index) => {
                      const mapped =
                        candidate.market.outcomes[reverse ? 1 - index : index]
                          ?.suggestedPolymarketOutcome ?? outcome.suggestedPolymarketOutcome;
                      const book = candidate.books[mapped];
                      return (
                        <div key={outcome.sourceOddId} className="contents">
                          {index === 1 && (
                            <div className="grid place-items-center px-1 text-[11px] font-semibold tracking-[0.18em] text-mute-2">
                              VS
                            </div>
                          )}
                          <div className="rounded-[10px] border border-line bg-raised p-3 text-center">
                            <strong className="block text-[15px]">{outcome.sourceName}</strong>
                            {candidate.englishTeams?.[index] && (
                              <small className="mt-0.5 block text-[11px] text-mute-2">
                                {candidate.englishTeams[index]}
                              </small>
                            )}
                            <b className="mt-2 block font-display text-2xl font-medium text-gold">
                              {cents(book?.topPrice)}
                            </b>
                            <small className="mt-1 block font-mono text-[11px] text-mute">
                              源 {outcome.decimalOdd.toFixed(2)} · 买一 {cents(book?.bestBid)} /
                              卖一 {cents(book?.bestAsk)}
                            </small>
                            <small className="mt-1 block text-[11px] text-mute-2">→ {mapped}</small>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {candidate.reason && (
                    <p className="mt-3 mb-0 rounded-lg border border-amber/25 bg-amber/10 px-3 py-2 text-xs text-amber">
                      {candidate.reason}
                    </p>
                  )}
                  {candidate.notes && candidate.notes.length > 0 && (
                    <ul className="mt-2 mb-0 list-disc pl-5 text-xs text-mute">
                      {candidate.notes.map((note) => (
                        <li key={note}>{note}</li>
                      ))}
                    </ul>
                  )}
                  <footer className="mt-3 flex items-center justify-between gap-3">
                    <a
                      className="text-xs font-medium text-mute hover:text-ink"
                      href={candidate.polymarketUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      Polymarket
                    </a>
                    <Button onClick={() => swap(candidate)} variant="ghost">
                      交换配对
                    </Button>
                  </footer>
                </article>
              );
            })}
          </div>

          {result.rejected.length > 0 && (
            <details className="mt-4 rounded-xl border border-line bg-inset px-4 py-3">
              <summary className="cursor-pointer text-sm text-mute">
                无法匹配 {result.rejected.length} 场
              </summary>
              {result.rejected.map((item) => (
                <p className="mt-2 mb-0 text-sm text-mute" key={`rejected-${item.sourceMatchId}`}>
                  {item.teams.join(" vs ")}：{item.reason}
                </p>
              ))}
            </details>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                checked={includeGameWinners}
                onChange={(event) => setIncludeGameWinners(event.target.checked)}
                type="checkbox"
              />
              同时配置局胜者（G1–G6）
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                checked={includeMapMarkets}
                onChange={(event) => setIncludeMapMarkets(event.target.checked)}
                type="checkbox"
              />
              同时配置地图让分 / 总数（含 +3.5）
            </label>
            <Button
              disabled={busy || selectedCandidates.length === 0 || budgetExceeded}
              onClick={() => void saveBatch()}
            >
              确认配置 {selectedCandidates.length} 场
              {includeGameWinners || includeMapMarkets ? "及相关盘口" : "全场"}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
