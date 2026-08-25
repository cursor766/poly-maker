"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { LeagueAutoMaker } from "@/app/components/LeagueAutoMaker";
import { Button, errorClass, Field, inputClass, panelClass } from "@/app/components/ui";
import {
  api,
  type MarketMapping,
  type MarketPreview,
  type RuntimeLimits,
  type SavedMatch,
  type TradingMode,
} from "@/lib/api";
import { estimateMarketBudget } from "@/lib/budget";

interface MarketForm {
  enabled: boolean;
  outcomes: [string, string];
  orderNotional: number;
  quoteLevels: number;
  levelSpacingTicks: number;
  targetReturnRate: number;
  quoteMode: "complement-buy" | "top-of-book";
}

const sampleSource = "https://example.com/markets/4689100176946822";
const samplePolymarket =
  "https://polymarket.com/esports/honor-of-kings/king-pro-league/hok-tesa-ttg-2026-07-31";

function roundLabel(round: number): string {
  return round === 0 ? "全场" : `G${round}`;
}

function marketKind(
  market: MarketPreview["markets"][number],
): NonNullable<MarketPreview["markets"][number]["kind"]> {
  return market.kind ?? (market.round === 0 ? "moneyline" : "child_moneyline");
}

function marketBadge(market: MarketPreview["markets"][number]): string {
  const kind = marketKind(market);
  if (kind === "map_handicap") return market.line != null ? `+${market.line}` : "让分";
  if (kind === "totals") return market.line != null ? `O/U ${market.line}` : "总数";
  return roundLabel(market.round);
}

function buildForms(
  preview: MarketPreview,
  saved: readonly MarketMapping[],
  defaultTargetReturnRate: number,
): Record<string, MarketForm> {
  const bySource = new Map(saved.map((mapping) => [mapping.sourceMarketId, mapping]));
  return Object.fromEntries(
    preview.markets.map((market) => {
      const existing = bySource.get(market.sourceMarketId);
      const outcomes = existing
        ? ([
            existing.outcomes[0]?.outcome ?? market.outcomes[0].suggestedPolymarketOutcome,
            existing.outcomes[1]?.outcome ?? market.outcomes[1].suggestedPolymarketOutcome,
          ] as [string, string])
        : ([
            market.outcomes[0].suggestedPolymarketOutcome,
            market.outcomes[1].suggestedPolymarketOutcome,
          ] as [string, string]);
      const quoteMode = existing?.quoteMode === "complement-buy" ? "complement-buy" : "top-of-book";
      return [
        market.sourceMarketId,
        {
          enabled: existing?.enabled ?? false,
          outcomes,
          orderNotional: existing?.orderNotional ?? 5,
          quoteLevels: existing?.quoteLevels ?? 2,
          levelSpacingTicks: existing?.levelSpacingTicks ?? 2,
          targetReturnRate: existing?.targetReturnRate ?? defaultTargetReturnRate,
          quoteMode,
        },
      ];
    }),
  );
}

export default function ConfigurePage() {
  const router = useRouter();
  const [sourceUrl, setSourceUrl] = useState("");
  const [polymarketUrl, setPolymarketUrl] = useState("");
  const [preview, setPreview] = useState<MarketPreview | null>(null);
  const [forms, setForms] = useState<Record<string, MarketForm>>({});
  const [savedMatches, setSavedMatches] = useState<SavedMatch[]>([]);
  const [mappings, setMappings] = useState<MarketMapping[]>([]);
  const [makerRunning, setMakerRunning] = useState(false);
  const [limits, setLimits] = useState<RuntimeLimits | null>(null);
  const [mode, setMode] = useState<TradingMode>("shadow");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [manualOpen, setManualOpen] = useState(false);

  const refreshSaved = useCallback(async () => {
    const [markets, status, nextLimits] = await Promise.all([
      api<{ mappings: MarketMapping[]; savedMatches: SavedMatch[] }>("/api/markets"),
      api<{ process: { running: boolean } }>("/api/status"),
      api<RuntimeLimits>("/api/limits"),
    ]);
    setMappings(markets.mappings);
    setSavedMatches(markets.savedMatches);
    setMakerRunning(status.process.running);
    setLimits(nextLimits);
  }, []);

  useEffect(() => {
    void refreshSaved().catch((caught) => {
      setError(caught instanceof Error ? caught.message : String(caught));
    });
  }, [refreshSaved]);

  async function loadPreview(nextSource = sourceUrl, nextPolymarket = polymarketUrl) {
    setLoading(true);
    setError("");
    try {
      const result = await api<MarketPreview>("/api/preview", {
        method: "POST",
        body: JSON.stringify({ sourceUrl: nextSource, polymarketUrl: nextPolymarket }),
      });
      const related = mappings.filter(
        (mapping) =>
          mapping.sourceMatchId === result.matchId ||
          mapping.polymarketEventSlug === result.eventSlug,
      );
      setSourceUrl(nextSource);
      setPolymarketUrl(nextPolymarket);
      setPreview(result);
      setForms(buildForms(result, related, limits?.makerTargetReturnRate ?? 0.8));
      setManualOpen(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  async function openSaved(match: SavedMatch) {
    await loadPreview(match.sourceUrl, match.polymarketUrl);
  }

  async function deleteSaved(match: SavedMatch) {
    const warning =
      match.enabledCount > 0
        ? `“${match.label}”仍有 ${match.enabledCount} 个启用盘口。删除后会停掉这些盘口并撤销对应挂单，确认删除？`
        : `确认从已保存比赛中删除“${match.label}”？`;
    if (!window.confirm(warning)) return;
    setLoading(true);
    setError("");
    try {
      await api("/api/matches/delete", {
        method: "POST",
        body: JSON.stringify({
          sourceMatchId: match.sourceMatchId,
          polymarketEventSlug: match.polymarketEventSlug,
        }),
      });
      if (
        preview?.matchId === match.sourceMatchId ||
        preview?.eventSlug === match.polymarketEventSlug
      ) {
        setPreview(null);
        setForms({});
        setSourceUrl("");
        setPolymarketUrl("");
      }
      await refreshSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  function updateForm(marketId: string, patch: Partial<MarketForm>) {
    setForms((current) => ({
      ...current,
      [marketId]: { ...current[marketId], ...patch } as MarketForm,
    }));
  }

  function setEnabledWhere(predicate: (market: MarketPreview["markets"][number]) => boolean) {
    setForms((current) =>
      Object.fromEntries(
        Object.entries(current).map(([marketId, form]) => {
          const market = preview?.markets.find((item) => item.sourceMarketId === marketId);
          return [marketId, { ...form, enabled: !!market && market.tradable && predicate(market) }];
        }),
      ),
    );
  }

  function enableWhere(predicate: (market: MarketPreview["markets"][number]) => boolean) {
    setForms((current) =>
      Object.fromEntries(
        Object.entries(current).map(([marketId, form]) => {
          const market = preview?.markets.find((item) => item.sourceMarketId === marketId);
          if (!market?.tradable || !predicate(market)) return [marketId, form];
          return [marketId, { ...form, enabled: true }];
        }),
      ),
    );
  }

  function setOnlyRound(round: number) {
    setEnabledWhere((market) => {
      const kind = marketKind(market);
      if (round === 0) return kind === "moneyline";
      return kind === "child_moneyline" && market.round === round;
    });
  }

  function swapPairing(marketId: string) {
    const form = forms[marketId];
    if (!form) return;
    updateForm(marketId, { outcomes: [form.outcomes[1], form.outcomes[0]] });
  }

  async function save(action: "save" | "start") {
    if (!preview) return;
    if (action === "start" && mode === "live") {
      const confirmed = window.confirm(
        "你将启动真实交易。系统会使用 .env 中的钱包并实际挂单，锁盘或停止时会撤单。确认继续？",
      );
      if (!confirmed) return;
    }
    setLoading(true);
    setError("");
    try {
      await api("/api/config", {
        method: "POST",
        body: JSON.stringify({
          sourceMatchId: preview.matchId,
          polymarketEventSlug: preview.eventSlug,
          sourceUrl,
          polymarketUrl,
          teams: preview.teams,
          tournament: preview.tournament,
          markets: preview.markets.map((market) => {
            const form = forms[market.sourceMarketId] as MarketForm;
            return {
              name: `${preview.teams.join(" vs ")} - ${market.name}`,
              enabled: form.enabled && market.tradable,
              sourceMarketId: market.sourceMarketId,
              polymarketSlug: market.polymarketSlug,
              round: market.round,
              outcomes: market.outcomes.map((outcome, index) => ({
                sourceOddId: outcome.sourceOddId,
                outcome: form.outcomes[index] as string,
              })),
              orderNotional: form.orderNotional,
              quoteLevels: form.quoteLevels,
              levelSpacingTicks: form.levelSpacingTicks,
              targetReturnRate: form.targetReturnRate,
              quoteMode: form.quoteMode,
            };
          }),
        }),
      });
      await refreshSaved();
      if (action === "start") {
        await api("/api/start", {
          method: "POST",
          body: JSON.stringify({ mode }),
        });
        router.push("/dashboard");
        return;
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  const estimatedNotional = estimateMarketBudget(
    Object.entries(forms).map(([marketId, form]) => ({
      ...form,
      tradable:
        preview?.markets.find((item) => item.sourceMarketId === marketId)?.tradable ?? false,
    })),
  );
  const budgetExceeded = limits !== null && estimatedNotional > limits.maxAccountNotional + 1e-9;

  return (
    <>
      <header className="mb-7">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-gold">
          Market desk
        </p>
        <h1 className="m-0 font-display text-[34px] font-medium tracking-tight text-ink">
          配置盘口
        </h1>
        <p className="mt-2.5 max-w-[62ch] text-[15px] leading-relaxed text-mute">
          先扫 KPL / KGL 赛程批量挂全场，或手动打开一场比赛改局数和层数。默认 paper / shadow，live
          仍要双重确认。
        </p>
      </header>

      <LeagueAutoMaker limits={limits} makerRunning={makerRunning} onSaved={refreshSaved} />

      {savedMatches.length > 0 && (
        <section className={`${panelClass} mb-5`}>
          <div className="mb-4">
            <h2 className="m-0 text-lg font-medium">已保存的比赛</h2>
            <p className="mt-1.5 text-sm leading-relaxed text-mute">
              点「继续配置」会重新拉取最新赔率，并恢复你上次的启用状态与挂单参数。
            </p>
          </div>
          <div className="grid gap-2.5">
            {savedMatches.map((match) => (
              <article
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-inset px-4 py-3.5"
                key={`${match.sourceMatchId}-${match.polymarketEventSlug}`}
              >
                <div>
                  <strong className="block text-[15px]">{match.label}</strong>
                  <small className="mt-1 block text-xs text-mute">
                    {match.tournament ? `${match.tournament} · ` : ""}
                    {match.enabledCount}/{match.marketCount} 启用
                    {match.enabledRounds.length > 0
                      ? ` · ${match.enabledRounds.map(roundLabel).join(" / ")}`
                      : " · 暂无启用盘口"}
                  </small>
                </div>
                <div className="flex gap-2">
                  <Button
                    disabled={loading}
                    onClick={() => void openSaved(match)}
                    variant="secondary"
                  >
                    继续配置
                  </Button>
                  <Button
                    disabled={loading}
                    onClick={() => void deleteSaved(match)}
                    variant="danger"
                  >
                    删除
                  </Button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      <details
        className="mb-5 overflow-hidden rounded-[18px] border border-line bg-panel"
        open={manualOpen}
        onToggle={(event) => setManualOpen(event.currentTarget.open)}
      >
        <summary className="cursor-pointer list-none px-5 py-4 [&::-webkit-details-marker]:hidden">
          <h2 className="m-0 text-lg font-medium">{preview ? "当前比赛链接" : "手动粘贴链接"}</h2>
          <p className="mt-1.5 text-sm text-mute">
            源站比赛页 + Polymarket 事件页。预览只读，不会下单。
          </p>
        </summary>
        <section className="border-t border-line px-5 py-5">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="m-0 text-lg font-medium">{preview ? "当前比赛链接" : "载入新比赛"}</h2>
              <p className="mt-1.5 text-sm text-mute">
                只读取比赛和盘口信息，不会在预览阶段创建订单。
              </p>
            </div>
            {preview && (
              <Button disabled={loading} onClick={() => void loadPreview()} variant="secondary">
                刷新赔率
              </Button>
            )}
          </div>
          <div className="grid items-end gap-3 md:grid-cols-[1fr_1fr_auto]">
            <Field htmlFor="source-url" label="源站比赛 URL">
              <input
                className={inputClass}
                id="source-url"
                value={sourceUrl}
                onChange={(event) => setSourceUrl(event.target.value)}
                placeholder={sampleSource}
              />
            </Field>
            <Field htmlFor="polymarket-url" label="Polymarket 事件 URL">
              <input
                className={inputClass}
                id="polymarket-url"
                value={polymarketUrl}
                onChange={(event) => setPolymarketUrl(event.target.value)}
                placeholder={samplePolymarket}
              />
            </Field>
            <Button
              disabled={loading || !sourceUrl || !polymarketUrl}
              onClick={() => void loadPreview()}
            >
              {loading ? "读取中…" : preview ? "重新预览" : "预览市场"}
            </Button>
          </div>
          {error && <div className={`${errorClass} mt-3`}>{error}</div>}
        </section>
      </details>

      {preview && (
        <>
          <div className="mb-4 grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-xl border border-line bg-inset px-4 py-3.5">
              <span className="block text-[11px] uppercase tracking-[0.16em] text-mute-2">
                对阵
              </span>
              <strong className="mt-1.5 block text-[15px]">{preview.teams.join(" / ")}</strong>
            </div>
            <div className="rounded-xl border border-line bg-inset px-4 py-3.5">
              <span className="block text-[11px] uppercase tracking-[0.16em] text-mute-2">
                赛事
              </span>
              <strong className="mt-1.5 block text-[15px]">{preview.tournament || "—"}</strong>
            </div>
            <div className="rounded-xl border border-line bg-inset px-4 py-3.5">
              <span className="block text-[11px] uppercase tracking-[0.16em] text-mute-2">
                赛制 / 比分
              </span>
              <strong className="mt-1.5 block text-[15px]">
                BO{preview.bestOf} · {preview.score}
              </strong>
            </div>
            <div className="rounded-xl border border-line bg-inset px-4 py-3.5">
              <span className="block text-[11px] uppercase tracking-[0.16em] text-mute-2">
                已启用
              </span>
              <strong className="mt-1.5 block text-[15px]">
                {Object.values(forms).filter((form) => form.enabled).length}/
                {preview.markets.length}
              </strong>
            </div>
          </div>

          <section className={panelClass}>
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="m-0 text-lg font-medium">盘口与挂单参数</h2>
                <p className="mt-1.5 text-sm leading-relaxed text-mute">
                  默认全部关闭。BO7 可勾选 G1–G6 局胜者，以及 +3.5 地图让分 / 地图总数。目标回报 80%
                  通常挂不进 KPL 买一，贴近盘口请用约 95%。
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {[
                  ...new Set(
                    preview.markets
                      .filter((market) => {
                        const kind = marketKind(market);
                        return kind === "moneyline" || kind === "child_moneyline";
                      })
                      .map((market) => market.round),
                  ),
                ]
                  .sort((left, right) => left - right)
                  .map((round) => (
                    <Button
                      key={`only-${round}`}
                      disabled={loading}
                      onClick={() => setOnlyRound(round)}
                      variant="secondary"
                    >
                      只开{roundLabel(round)}
                    </Button>
                  ))}
                {preview.markets.some((market) => marketKind(market) === "child_moneyline") && (
                  <Button
                    disabled={loading}
                    onClick={() =>
                      enableWhere((market) => marketKind(market) === "child_moneyline")
                    }
                    variant="secondary"
                  >
                    全开局胜者
                  </Button>
                )}
                {preview.markets.some(
                  (market) => marketKind(market) === "map_handicap" && market.line === 3.5,
                ) && (
                  <Button
                    disabled={loading}
                    onClick={() =>
                      enableWhere(
                        (market) => marketKind(market) === "map_handicap" && market.line === 3.5,
                      )
                    }
                    variant="secondary"
                  >
                    开启+3.5
                  </Button>
                )}
                {preview.markets.some((market) => marketKind(market) === "map_handicap") && (
                  <Button
                    disabled={loading}
                    onClick={() => enableWhere((market) => marketKind(market) === "map_handicap")}
                    variant="secondary"
                  >
                    开启地图让分
                  </Button>
                )}
                {preview.markets.some((market) => marketKind(market) === "totals") && (
                  <Button
                    disabled={loading}
                    onClick={() => enableWhere((market) => marketKind(market) === "totals")}
                    variant="secondary"
                  >
                    开启地图总数
                  </Button>
                )}
              </div>
            </div>
            {limits && (
              <div
                className={`mb-4 rounded-xl border px-4 py-3.5 ${
                  budgetExceeded ? "border-rose/35 bg-rose/10" : "border-line bg-inset"
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[11px] uppercase tracking-[0.16em] text-mute-2">
                    预计挂单占用
                  </span>
                  <strong>
                    ${estimatedNotional.toFixed(2)} / ${limits.maxAccountNotional.toFixed(2)}
                  </strong>
                </div>
                <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-line">
                  <i
                    className={`block h-full ${budgetExceeded ? "bg-rose" : "bg-gold"}`}
                    style={{
                      width: `${Math.min(100, (estimatedNotional / limits.maxAccountNotional) * 100)}%`,
                    }}
                  />
                </div>
                <p className="mt-2 mb-0 text-xs text-mute">
                  {budgetExceeded
                    ? "超过账户额度上限，请减少市场、层数或每层额度。"
                    : "按每个市场双边 × 层数 × 每层额度估算。"}
                </p>
              </div>
            )}
            <div className="grid gap-3">
              {preview.markets.length === 0 && (
                <div className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-sm text-mute">
                  未找到源站与 Polymarket 可对应的胜负 / 让分 / 总数盘口。
                </div>
              )}
              {preview.markets.map((market) => {
                const form = forms[market.sourceMarketId];
                if (!form) return null;
                return (
                  <article
                    className="rounded-[14px] border border-line bg-inset p-4"
                    key={market.sourceMarketId}
                  >
                    <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                      <div className="flex items-start gap-3">
                        <span className="mt-0.5 rounded-md border border-gold/25 bg-gold/10 px-2 py-1 font-mono text-[11px] font-semibold text-gold">
                          {marketBadge(market)}
                        </span>
                        <div>
                          <strong className="block">{market.name}</strong>
                          <small className="mt-1 block font-mono text-[11px] text-mute-2">
                            {market.polymarketSlug}
                          </small>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <Button onClick={() => swapPairing(market.sourceMarketId)} variant="ghost">
                          交换队伍配对
                        </Button>
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={form.enabled}
                            disabled={!market.tradable}
                            onChange={(event) =>
                              updateForm(market.sourceMarketId, { enabled: event.target.checked })
                            }
                          />
                          {market.tradable ? "启用" : "不可交易"}
                        </label>
                      </div>
                    </div>
                    <div className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-4">
                      {market.outcomes.map((outcome, index) => (
                        <div
                          className="rounded-[10px] border border-line bg-raised p-3"
                          key={outcome.sourceOddId}
                        >
                          <div className="mb-2 flex items-center justify-between gap-2">
                            <span className="text-sm">{outcome.sourceName}</span>
                            <b className="font-display text-lg text-gold">
                              {outcome.recommendedBuyPrice === null
                                ? "—"
                                : `${Math.round(outcome.recommendedBuyPrice * 100)}¢`}
                            </b>
                          </div>
                          <select
                            className={inputClass}
                            aria-label={`${outcome.sourceName} 对应 Polymarket outcome`}
                            value={form.outcomes[index]}
                            onChange={(event) => {
                              const outcomes = [...form.outcomes] as [string, string];
                              outcomes[index] = event.target.value;
                              updateForm(market.sourceMarketId, { outcomes });
                            }}
                          >
                            {market.polymarketOutcomes.map((name) => (
                              <option key={name} value={name}>
                                对应 {name}
                              </option>
                            ))}
                          </select>
                          <div className="mt-2 font-mono text-[11px] text-mute-2">
                            源赔率 {outcome.decimalOdd.toFixed(3)} · 公平概率{" "}
                            {(outcome.fairProbability * 100).toFixed(1)}%
                          </div>
                        </div>
                      ))}
                      <Field htmlFor={`notional-${market.sourceMarketId}`} label="每层额度 ($)">
                        <input
                          className={inputClass}
                          id={`notional-${market.sourceMarketId}`}
                          type="number"
                          min="1"
                          step="0.5"
                          value={form.orderNotional}
                          onChange={(event) =>
                            updateForm(market.sourceMarketId, {
                              orderNotional: Number(event.target.value),
                            })
                          }
                        />
                      </Field>
                      <Field htmlFor={`levels-${market.sourceMarketId}`} label="层数">
                        <input
                          className={inputClass}
                          id={`levels-${market.sourceMarketId}`}
                          type="number"
                          min="1"
                          max="10"
                          value={form.quoteLevels}
                          onChange={(event) =>
                            updateForm(market.sourceMarketId, {
                              quoteLevels: Number(event.target.value),
                            })
                          }
                        />
                      </Field>
                      <Field htmlFor={`spacing-${market.sourceMarketId}`} label="层间距 (tick)">
                        <input
                          className={inputClass}
                          id={`spacing-${market.sourceMarketId}`}
                          type="number"
                          min="1"
                          value={form.levelSpacingTicks}
                          onChange={(event) =>
                            updateForm(market.sourceMarketId, {
                              levelSpacingTicks: Number(event.target.value),
                            })
                          }
                        />
                      </Field>
                      <Field htmlFor={`return-${market.sourceMarketId}`} label="目标回报 %">
                        <input
                          className={inputClass}
                          id={`return-${market.sourceMarketId}`}
                          type="number"
                          min="50"
                          max="99"
                          step="1"
                          value={Math.round(form.targetReturnRate * 100)}
                          onChange={(event) =>
                            updateForm(market.sourceMarketId, {
                              targetReturnRate: Number(event.target.value) / 100,
                            })
                          }
                        />
                      </Field>
                      <Field htmlFor={`mode-${market.sourceMarketId}`} label="报价模式">
                        <select
                          className={inputClass}
                          id={`mode-${market.sourceMarketId}`}
                          value={form.quoteMode}
                          onChange={(event) =>
                            updateForm(market.sourceMarketId, {
                              quoteMode: event.target.value as MarketForm["quoteMode"],
                            })
                          }
                        >
                          <option value="top-of-book">买一排队</option>
                          <option value="complement-buy">互补限价</option>
                        </select>
                      </Field>
                    </div>
                  </article>
                );
              })}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2.5">
              <select
                className={`${inputClass} w-auto`}
                aria-label="交易模式"
                value={mode}
                onChange={(event) => setMode(event.target.value as TradingMode)}
              >
                <option value="paper">Paper</option>
                <option value="shadow">Shadow</option>
                <option value="live">Live</option>
              </select>
              <Button
                disabled={loading || budgetExceeded}
                onClick={() => void save("save")}
                variant="secondary"
              >
                {makerRunning ? "保存并热更新" : "仅保存配置"}
              </Button>
              {!makerRunning && (
                <Button
                  disabled={loading || preview.markets.length === 0 || budgetExceeded}
                  onClick={() => void save("start")}
                >
                  保存并启动
                </Button>
              )}
            </div>
          </section>
        </>
      )}
    </>
  );
}
