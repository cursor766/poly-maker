"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { GameTicket } from "@/app/components/GameTicket";
import {
  Button,
  errorClass,
  Field,
  inputClass,
  panelClass,
  successClass,
} from "@/app/components/ui";
import {
  api,
  type ControlStatus,
  type MarketMapping,
  type MarketPreview,
  type MarketTapeResponse,
  type MarketTapeSnapshot,
  type RuntimeLimits,
  type RuntimeMarket,
  type TradingMode,
} from "@/lib/api";
import { ensureMakerRunning, MATCH_DESK_MODE } from "@/lib/maker-session";
import { subscribeToStatus } from "@/lib/stream";
import { clampPrice, clobSize } from "@/lib/tick";

interface MarketForm {
  enabled: boolean;
  outcomes: [string, string];
  orderNotional: number;
  quoteLevels: number;
  levelSpacingTicks: number;
  targetReturnRate: number;
  quoteMode: "complement-buy" | "top-of-book";
}

function roundLabel(round: number): string {
  return round === 0 ? "全场" : `G${round}`;
}

function marketKind(
  market: MarketPreview["markets"][number],
): NonNullable<MarketPreview["markets"][number]["kind"]> {
  return market.kind ?? (market.round === 0 ? "moneyline" : "child_moneyline");
}

function expandBuyQuotes(
  price: number,
  shares: number,
  layers: number,
  spacingTicks: number,
  tickSize: number,
  outcome: string,
): Array<{ outcome: string; price: number; size: number }> {
  const tick = tickSize;
  const quotes: Array<{ outcome: string; price: number; size: number }> = [];
  let previous = Number.POSITIVE_INFINITY;
  for (let level = 0; level < Math.max(1, layers); level += 1) {
    const next = clampPrice(price - level * spacingTicks * tick, tick);
    if (next >= previous) continue;
    previous = next;
    quotes.push({ outcome, price: next, size: clobSize(shares) });
  }
  return quotes;
}

async function waitForRuntimeMarket(sourceMarketId: string, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const status = await api<ControlStatus>("/api/status");
    if (status.runtime?.markets.some((market) => market.sourceMarketId === sourceMarketId)) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error("这个盘口还没加载进挂单进程。稍后再试。");
}

function isGameMarket(market: MarketPreview["markets"][number]): boolean {
  const kind = marketKind(market);
  return (
    kind === "moneyline" ||
    kind === "child_moneyline" ||
    kind === "map_handicap" ||
    kind === "totals"
  );
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
          orderNotional: existing?.orderNotional ?? 50,
          quoteLevels: existing?.quoteLevels ?? 4,
          levelSpacingTicks: existing?.levelSpacingTicks ?? 1,
          targetReturnRate: existing?.targetReturnRate ?? defaultTargetReturnRate,
          quoteMode,
        },
      ];
    }),
  );
}

function withAutoFollow(
  form: MarketForm,
  enabled: boolean,
  autoFollow: boolean,
  targetReturnRate: number,
  orderNotional: number,
): MarketForm {
  if (!autoFollow || !enabled) return { ...form, enabled };
  return {
    ...form,
    enabled: true,
    quoteMode: "complement-buy",
    targetReturnRate,
    orderNotional,
    quoteLevels: 4,
    levelSpacingTicks: 1,
  };
}

export function MatchConfigDesk({
  eventSlug,
  sourceUrl,
  polymarketUrl,
}: {
  eventSlug: string;
  sourceUrl: string;
  polymarketUrl: string;
}) {
  const [preview, setPreview] = useState<MarketPreview | null>(null);
  const [forms, setForms] = useState<Record<string, MarketForm>>({});
  const [makerRunning, setMakerRunning] = useState(false);
  const [runtimeMarkets, setRuntimeMarkets] = useState<Record<string, RuntimeMarket>>({});
  const [tape, setTape] = useState<Record<string, MarketTapeSnapshot>>({});
  const [limits, setLimits] = useState<RuntimeLimits | null>(null);
  const [mode, setMode] = useState<TradingMode>(MATCH_DESK_MODE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [autoFollow, setAutoFollow] = useState(false);
  const [autoReturnRate, setAutoReturnRate] = useState(0.95);
  const [autoNotional, setAutoNotional] = useState(50);

  const applyStatus = useCallback((status: ControlStatus) => {
    setMakerRunning(status.process.running);
    setRuntimeMarkets(
      Object.fromEntries(
        (status.runtime?.markets ?? []).map((market) => [market.sourceMarketId, market]),
      ),
    );
    if (status.runtime?.mode) setMode(status.runtime.mode);
  }, []);

  const refreshMeta = useCallback(async () => {
    const [markets, status, nextLimits] = await Promise.all([
      api<{ mappings: MarketMapping[] }>("/api/markets"),
      api<ControlStatus>("/api/status"),
      api<RuntimeLimits>("/api/limits"),
    ]);
    applyStatus(status);
    setLimits(nextLimits);
    return { mappings: markets.mappings, limits: nextLimits };
  }, [applyStatus]);

  const loadPreview = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const meta = await refreshMeta();
      const result = await api<MarketPreview>("/api/preview", {
        method: "POST",
        body: JSON.stringify({ sourceUrl, polymarketUrl }),
      });
      const related = meta.mappings.filter(
        (mapping) =>
          mapping.sourceMatchId === result.matchId ||
          mapping.polymarketEventSlug === result.eventSlug,
      );
      setPreview(result);
      setForms(buildForms(result, related, meta.limits.makerTargetReturnRate ?? 0.8));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [polymarketUrl, refreshMeta, sourceUrl]);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  useEffect(() => {
    return subscribeToStatus(applyStatus, () => undefined);
  }, [applyStatus]);

  useEffect(() => {
    const gameMarkets = (preview?.markets ?? []).filter(
      (market) => isGameMarket(market) && market.conditionId && market.tokenIds,
    );
    if (gameMarkets.length === 0) {
      setTape({});
      return;
    }
    let cancelled = false;
    const loadTape = async () => {
      try {
        const next = await api<MarketTapeResponse>("/api/market-tape", {
          method: "POST",
          body: JSON.stringify({
            markets: gameMarkets.map((market) => ({
              sourceMarketId: market.sourceMarketId,
              conditionId: market.conditionId,
              slug: market.polymarketSlug,
              tokenIds: market.tokenIds,
              outcomes: market.polymarketOutcomes,
              tickSize: market.tickSize,
              minOrderSize: market.minOrderSize,
            })),
          }),
        });
        if (!cancelled) setTape(next.markets);
      } catch {
        if (!cancelled) setTape({});
      }
    };
    void loadTape();
    const timer = window.setInterval(() => {
      void loadTape();
      void refreshMeta();
    }, 6000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [preview, refreshMeta]);

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
          const enabled = !!market && market.tradable && predicate(market);
          return [
            marketId,
            withAutoFollow(form, enabled, autoFollow, autoReturnRate, autoNotional),
          ];
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
          return [marketId, withAutoFollow(form, true, autoFollow, autoReturnRate, autoNotional)];
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

  async function persistConfig(nextForms = forms) {
    if (!preview) return;
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
          const form = nextForms[market.sourceMarketId] as MarketForm;
          return {
            name: `${preview.teams.join(" vs ")} - ${market.name}`,
            enabled: form.enabled && market.tradable,
            sourceMarketId: market.sourceMarketId,
            polymarketSlug: market.polymarketSlug,
            round: market.round,
            kind: marketKind(market),
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
    await refreshMeta();
  }

  async function persistAndQuote(nextForms = forms) {
    if (!preview) return;
    await persistConfig(nextForms);
    const enabled = preview.markets.some(
      (market) => market.tradable && nextForms[market.sourceMarketId]?.enabled,
    );
    if (!enabled) return;
    applyStatus(await ensureMakerRunning(MATCH_DESK_MODE));
  }

  async function resumeAutoMarket(sourceMarketId: string) {
    await waitForRuntimeMarket(sourceMarketId);
    await api("/api/desk/command", {
      method: "POST",
      body: JSON.stringify({ action: "resume", sourceMarketId }),
    });
  }

  async function toggleGameEnabled(market: MarketPreview["markets"][number], enabled: boolean) {
    const current = forms[market.sourceMarketId];
    if (!current) return;
    const nextForms = {
      ...forms,
      [market.sourceMarketId]: withAutoFollow(
        current,
        enabled,
        autoFollow,
        autoReturnRate,
        autoNotional,
      ),
    };
    setForms(nextForms);
    if (!autoFollow) return;
    setLoading(true);
    setError("");
    setMessage("");
    try {
      await persistAndQuote(nextForms);
      if (enabled) await resumeAutoMarket(market.sourceMarketId);
      else if (makerRunning) {
        await api("/api/desk/command", {
          method: "POST",
          body: JSON.stringify({ action: "cancel", sourceMarketId: market.sourceMarketId }),
        });
      }
      await refreshMeta();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  async function startAutoFollow() {
    if (!preview) return;
    const nextForms = Object.fromEntries(
      Object.entries(forms).map(([marketId, form]) => [
        marketId,
        withAutoFollow(form, form.enabled, true, autoReturnRate, autoNotional),
      ]),
    ) as Record<string, MarketForm>;
    const selected = preview.markets.filter(
      (market) => market.tradable && nextForms[market.sourceMarketId]?.enabled,
    );
    if (selected.length === 0) {
      setError("请先勾选要自动跟赔的全场或小局。");
      return;
    }
    setAutoFollow(true);
    setForms(nextForms);
    setLoading(true);
    setError("");
    setMessage("");
    try {
      await persistAndQuote(nextForms);
      for (const market of selected) {
        await resumeAutoMarket(market.sourceMarketId);
      }
      await refreshMeta();
      setMessage(
        `已对 ${selected.length} 个盘口开启自动跟赔：保留源站水分后再加 ${((1 - autoReturnRate) * 100).toFixed(0)} 个点。`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  async function sendDeskCommand(body: Record<string, unknown>) {
    setLoading(true);
    setError("");
    try {
      await api("/api/desk/command", {
        method: "POST",
        body: JSON.stringify(body),
      });
      await refreshMeta();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  async function placeGameOrder(
    market: MarketPreview["markets"][number],
    input: {
      outcome: string;
      price: number;
      shares: number;
      layers: number;
      spacingTicks: number;
    },
  ) {
    const quotes = expandBuyQuotes(
      input.price,
      input.shares,
      input.layers,
      input.spacingTicks,
      market.tickSize,
      input.outcome,
    );
    if (quotes.length === 0) return;
    setLoading(true);
    setError("");
    try {
      const nextForms = {
        ...forms,
        [market.sourceMarketId]: {
          ...forms[market.sourceMarketId],
          enabled: true,
          orderNotional: Number((input.price * input.shares).toFixed(2)),
          quoteLevels: input.layers,
          levelSpacingTicks: input.spacingTicks,
        },
      };
      setForms(nextForms);
      await persistAndQuote(nextForms);
      await waitForRuntimeMarket(market.sourceMarketId);
      await api("/api/desk/command", {
        method: "POST",
        body: JSON.stringify({
          action: "place",
          sourceMarketId: market.sourceMarketId,
          quotes,
        }),
      });
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        const status = await api<ControlStatus>("/api/status");
        const live = status.runtime?.markets.find(
          (item) => item.sourceMarketId === market.sourceMarketId,
        );
        applyStatus(status);
        if (live && (live.openOrderCount > 0 || live.quoteMode === "manual")) break;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      await refreshMeta();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    if (!preview) return;
    setLoading(true);
    setError("");
    setMessage("");
    try {
      const wasRunning = makerRunning;
      await persistAndQuote();
      const enabledCount = Object.values(forms).filter((form) => form.enabled).length;
      if (enabledCount === 0) {
        setMessage("配置已保存。勾选盘口后会自动开始实盘挂单。");
      } else if (wasRunning) {
        setMessage("配置已保存，挂单参数已热更新。");
      } else {
        setMessage("配置已保存，正在实盘挂单。");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  const title = preview?.teams.join(" vs ") ?? eventSlug;

  return (
    <>
      <header className="mb-7">
        <Link className="mb-3 inline-block text-[13px] text-mute hover:text-ink" href="/">
          ← 返回比赛列表
        </Link>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-gold">
          Match desk
        </p>
        <h1 className="m-0 font-display text-[34px] font-medium tracking-tight text-ink">
          {title}
        </h1>
        <p className="mt-2.5 max-w-[62ch] text-[15px] leading-relaxed text-mute">
          勾选全场或小局后直接实盘挂单，不用再到交易台启动核心。自动跟赔会保留源站大于 100%
          的隐含水分，再额外加 5 个点。全场和小局都在票上跟赔；空簿会铺多层，单边吃太多会停。
        </p>
      </header>

      {error && <div className={`${errorClass} mb-4`}>{error}</div>}
      {message && <div className={`${successClass} mb-4`}>{message}</div>}

      {!preview && loading && (
        <section className={`${panelClass} text-sm text-mute`}>正在读取这场比赛的盘口…</section>
      )}

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
                  全场和小局都用同一张票：勾选即启用，顶部打开自动跟赔后按源赔率双边跟价。有买一时最多比买一抬
                  2
                  tick，不会跳到理论价中间；空簿才按理论安全价铺档。保存或启动自动跟赔后会直接挂单。
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button disabled={loading} onClick={() => void loadPreview()} variant="secondary">
                  刷新赔率
                </Button>
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
            <div className="mb-4 rounded-xl border border-gold/25 bg-gold/5 px-4 py-3.5">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  checked={autoFollow}
                  onChange={(event) => setAutoFollow(event.target.checked)}
                  type="checkbox"
                />
                开启自动跟赔
              </label>
              <p className="mt-2 mb-3 text-[13px] leading-relaxed text-mute">
                源站两边 1/赔率 合计通常大于 100%，这笔水分会保留。目标回报{" "}
                {(autoReturnRate * 100).toFixed(0)}% 表示再加{" "}
                {((1 - autoReturnRate) * 100).toFixed(0)} 个点：卖价合计 = 源隐含 +{" "}
                {((1 - autoReturnRate) * 100).toFixed(0)}
                ¢，买单合计更低。源赔率变动超过当前挂价后自动改价。有买一时最多比买一抬 2
                tick，空簿才按理论安全价铺档；单边仓位会压报价、加大对边对冲，而不是只在 60%
                停掉。顶档被吃掉后会等一会儿再补。
              </p>
              {autoFollow ? (
                <div className="grid items-end gap-2.5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                  <Field htmlFor="auto-return" label="目标回报 %（额外抽水）">
                    <input
                      className={inputClass}
                      id="auto-return"
                      max="99"
                      min="50"
                      onChange={(event) => setAutoReturnRate(Number(event.target.value) / 100)}
                      step="1"
                      type="number"
                      value={Math.round(autoReturnRate * 100)}
                    />
                  </Field>
                  <Field htmlFor="auto-notional" label="每层额度 $">
                    <input
                      className={inputClass}
                      id="auto-notional"
                      min="1"
                      onChange={(event) => setAutoNotional(Number(event.target.value))}
                      step="1"
                      type="number"
                      value={autoNotional}
                    />
                  </Field>
                  <Button disabled={loading} onClick={() => void startAutoFollow()}>
                    按勾选启动自动跟赔
                  </Button>
                </div>
              ) : null}
            </div>
            {limits && (
              <p className="mb-4 mt-0 text-xs leading-relaxed text-mute">
                限价买单锁定的是价格 × 股数的 USDC，不是股份面额。$400 余额大约能挂 4 万股 1¢
                单。全场/单局单盘仍限制 ${limits.maxGameNotional}，让分/总数 $
                {limits.maxMapNotional}。
              </p>
            )}
            <div className="grid gap-3">
              {preview.markets.length === 0 && (
                <div className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-sm text-mute">
                  未找到源站与 Polymarket 可对应的胜负 / 让分 / 总数盘口。
                </div>
              )}
              {preview.markets
                .filter((market) => !isGameMarket(market))
                .map((market) => {
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
                          <Button
                            onClick={() => swapPairing(market.sourceMarketId)}
                            variant="ghost"
                          >
                            交换队伍配对
                          </Button>
                          <label className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={form.enabled}
                              disabled={!market.tradable}
                              onChange={(event) =>
                                void toggleGameEnabled(market, event.target.checked)
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
              {preview.markets.filter(isGameMarket).map((market) => {
                const form = forms[market.sourceMarketId];
                if (!form) return null;
                return (
                  <GameTicket
                    autoFollow={autoFollow}
                    autoReturnRate={autoReturnRate}
                    busy={loading}
                    defaultLayers={form.quoteLevels}
                    defaultShares={Math.max(market.minOrderSize, form.orderNotional)}
                    defaultSpacing={form.levelSpacingTicks}
                    enabled={form.enabled}
                    key={market.sourceMarketId}
                    makerRunning={makerRunning}
                    mappedOutcomes={form.outcomes}
                    market={market}
                    mode={mode}
                    onCancel={(orderId) =>
                      sendDeskCommand({
                        action: "cancel",
                        sourceMarketId: market.sourceMarketId,
                        orderIds: [orderId],
                      })
                    }
                    onCancelAll={() =>
                      sendDeskCommand({ action: "cancel", sourceMarketId: market.sourceMarketId })
                    }
                    onPlace={(input) => placeGameOrder(market, input)}
                    onReplace={(orderId, price, size) =>
                      sendDeskCommand({
                        action: "replace",
                        sourceMarketId: market.sourceMarketId,
                        orderId,
                        price,
                        size,
                      })
                    }
                    onSwap={() => swapPairing(market.sourceMarketId)}
                    onToggleEnabled={(enabled) => void toggleGameEnabled(market, enabled)}
                    runtime={runtimeMarkets[market.sourceMarketId]}
                    tape={tape[market.sourceMarketId]}
                  />
                );
              })}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2.5">
              <Button
                disabled={loading}
                onClick={() => void save()}
                variant={makerRunning ? "secondary" : "primary"}
              >
                {makerRunning ? "保存并热更新" : "保存并挂单"}
              </Button>
            </div>
          </section>
        </>
      )}
    </>
  );
}
