"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { LeagueAutoMaker } from "@/app/components/LeagueAutoMaker";
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
}

const sampleSource = "https://example.com/markets/4689100176946822";
const samplePolymarket =
  "https://polymarket.com/esports/honor-of-kings/king-pro-league/hok-tesa-ttg-2026-07-31";

function roundLabel(round: number): string {
  return round === 0 ? "全场" : `G${round}`;
}

function buildForms(
  preview: MarketPreview,
  saved: readonly MarketMapping[],
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
      return [
        market.sourceMarketId,
        {
          enabled: existing?.enabled ?? false,
          outcomes,
          orderNotional: existing?.orderNotional ?? 5,
          quoteLevels: existing?.quoteLevels ?? 2,
          levelSpacingTicks: existing?.levelSpacingTicks ?? 2,
          targetReturnRate: existing?.targetReturnRate ?? 0.8,
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
      setForms(buildForms(result, related));
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

  function setOnlyRound(round: number) {
    setForms((current) =>
      Object.fromEntries(
        Object.entries(current).map(([marketId, form]) => {
          const market = preview?.markets.find((item) => item.sourceMarketId === marketId);
          return [marketId, { ...form, enabled: market?.round === round && !!market.tradable }];
        }),
      ),
    );
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
      <div className="eyebrow">Market configuration</div>
      <h1>配置一场比赛的各局盘口</h1>
      <p className="lead">
        首次粘贴源站与 Polymarket 链接。之后同一场比赛可从下方列表一键重新打开，切换第一局 /
        第二局，不必重复粘贴 URL。
      </p>

      <LeagueAutoMaker limits={limits} makerRunning={makerRunning} onSaved={refreshSaved} />

      {savedMatches.length > 0 && (
        <section className="panel" style={{ marginBottom: 18 }}>
          <div className="panelTitle">
            <div>
              <h2>已保存的比赛</h2>
              <p>点「继续配置」会重新拉取最新赔率，并恢复你上次的启用状态与挂单参数。</p>
            </div>
          </div>
          <div className="sessionList">
            {savedMatches.map((match) => (
              <article
                className="sessionCard"
                key={`${match.sourceMatchId}-${match.polymarketEventSlug}`}
              >
                <div>
                  <strong>{match.label}</strong>
                  <small>
                    {match.tournament ? `${match.tournament} · ` : ""}
                    {match.enabledCount}/{match.marketCount} 启用
                    {match.enabledRounds.length > 0
                      ? ` · ${match.enabledRounds.map(roundLabel).join(" / ")}`
                      : " · 暂无启用盘口"}
                  </small>
                </div>
                <div className="sessionActions">
                  <button
                    className="secondary"
                    type="button"
                    disabled={loading}
                    onClick={() => void openSaved(match)}
                  >
                    继续配置
                  </button>
                  <button
                    className="deleteButton"
                    type="button"
                    disabled={loading}
                    onClick={() => void deleteSaved(match)}
                  >
                    删除
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      <section className="panel">
        <div className="panelTitle">
          <div>
            <h2>{preview ? "当前比赛链接" : "载入新比赛"}</h2>
            <p>只读取比赛和盘口信息，不会在预览阶段创建订单。</p>
          </div>
          {preview && (
            <button
              className="secondary"
              type="button"
              disabled={loading}
              onClick={() => void loadPreview()}
            >
              刷新赔率
            </button>
          )}
        </div>
        <div className="urlGrid">
          <div className="field">
            <label htmlFor="source-url">源站比赛 URL</label>
            <input
              id="source-url"
              value={sourceUrl}
              onChange={(event) => setSourceUrl(event.target.value)}
              placeholder={sampleSource}
            />
          </div>
          <div className="field">
            <label htmlFor="polymarket-url">Polymarket 事件 URL</label>
            <input
              id="polymarket-url"
              value={polymarketUrl}
              onChange={(event) => setPolymarketUrl(event.target.value)}
              placeholder={samplePolymarket}
            />
          </div>
          <button
            className="primary"
            type="button"
            disabled={loading || !sourceUrl || !polymarketUrl}
            onClick={() => void loadPreview()}
          >
            {loading ? "读取中…" : preview ? "重新预览" : "预览市场"}
          </button>
        </div>
        {error && <div className="error">{error}</div>}
      </section>

      {preview && (
        <>
          <div className="summary">
            <div className="metric">
              <span>对阵</span>
              <strong>{preview.teams.join(" / ")}</strong>
            </div>
            <div className="metric">
              <span>赛事</span>
              <strong>{preview.tournament || "—"}</strong>
            </div>
            <div className="metric">
              <span>赛制 / 比分</span>
              <strong>
                BO{preview.bestOf} · {preview.score}
              </strong>
            </div>
            <div className="metric">
              <span>已启用</span>
              <strong>
                {Object.values(forms).filter((form) => form.enabled).length}/
                {preview.markets.length}
              </strong>
            </div>
          </div>

          <section className="panel">
            <div className="panelTitle">
              <div>
                <h2>盘口与挂单参数</h2>
                <p>默认全部关闭；勾选你要做的局。第一局结束后再回来只勾第二局即可。</p>
              </div>
              <div className="quickRounds">
                {preview.markets.map((market) => (
                  <button
                    key={`only-${market.sourceMarketId}`}
                    className="secondary"
                    type="button"
                    disabled={loading || !market.tradable}
                    onClick={() => setOnlyRound(market.round)}
                  >
                    只开{roundLabel(market.round)}
                  </button>
                ))}
              </div>
            </div>
            {limits && (
              <div className={`budgetBanner ${budgetExceeded ? "over" : ""}`}>
                <div>
                  <span>预计挂单占用</span>
                  <strong>
                    ${estimatedNotional.toFixed(2)} / ${limits.maxAccountNotional.toFixed(2)}
                  </strong>
                </div>
                <div className="budgetTrack">
                  <i
                    style={{
                      width: `${Math.min(100, (estimatedNotional / limits.maxAccountNotional) * 100)}%`,
                    }}
                  />
                </div>
                <p>
                  {budgetExceeded
                    ? "超过账户额度上限，请减少市场、层数或每层额度。"
                    : "按每个市场双边 × 层数 × 每层额度估算。"}
                </p>
              </div>
            )}
            <div className="marketList">
              {preview.markets.length === 0 && (
                <div className="empty">未找到源站与 Polymarket 可对应的胜负盘口。</div>
              )}
              {preview.markets.map((market) => {
                const form = forms[market.sourceMarketId];
                if (!form) return null;
                return (
                  <article className="marketCard" key={market.sourceMarketId}>
                    <div className="marketHead">
                      <div className="marketName">
                        <span className="round">{roundLabel(market.round)}</span>
                        <div>
                          <strong>{market.name}</strong>
                          <small>{market.polymarketSlug}</small>
                        </div>
                      </div>
                      <div className="mappingActions">
                        <button
                          className="swapButton"
                          type="button"
                          onClick={() => swapPairing(market.sourceMarketId)}
                        >
                          交换队伍配对
                        </button>
                        <label className="toggle">
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
                    <div className="marketBody">
                      {market.outcomes.map((outcome, index) => (
                        <div className="outcomeBox" key={outcome.sourceOddId}>
                          <div className="outcomeTop">
                            <span>{outcome.sourceName}</span>
                            <b>
                              {outcome.recommendedBuyPrice === null
                                ? "—"
                                : `${Math.round(outcome.recommendedBuyPrice * 100)}¢`}
                            </b>
                          </div>
                          <select
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
                          <div className="micro">
                            源赔率 {outcome.decimalOdd.toFixed(3)} · 公平概率{" "}
                            {(outcome.fairProbability * 100).toFixed(1)}%
                          </div>
                        </div>
                      ))}
                      <div className="field">
                        <label htmlFor={`notional-${market.sourceMarketId}`}>每层额度 ($)</label>
                        <input
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
                      </div>
                      <div className="field">
                        <label htmlFor={`levels-${market.sourceMarketId}`}>层数</label>
                        <input
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
                      </div>
                      <div className="field">
                        <label htmlFor={`spacing-${market.sourceMarketId}`}>层间距 (tick)</label>
                        <input
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
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
            <div className="actions">
              <select
                aria-label="交易模式"
                value={mode}
                onChange={(event) => setMode(event.target.value as TradingMode)}
              >
                <option value="paper">Paper</option>
                <option value="shadow">Shadow</option>
                <option value="live">Live</option>
              </select>
              <button
                className="secondary"
                type="button"
                disabled={loading || budgetExceeded}
                onClick={() => void save("save")}
              >
                {makerRunning ? "保存并热更新" : "仅保存配置"}
              </button>
              {!makerRunning && (
                <button
                  className="primary"
                  type="button"
                  disabled={loading || preview.markets.length === 0 || budgetExceeded}
                  onClick={() => void save("start")}
                >
                  保存并启动
                </button>
              )}
            </div>
          </section>
        </>
      )}
    </>
  );
}
