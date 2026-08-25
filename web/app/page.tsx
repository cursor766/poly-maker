"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { LeagueAutoMaker } from "@/app/components/LeagueAutoMaker";
import { Button, errorClass, Field, inputClass, panelClass } from "@/app/components/ui";
import { api, type RuntimeLimits, type SavedMatch } from "@/lib/api";
import { eventSlugFromPolymarketUrl, matchConfigPath } from "@/lib/match-route";

const sampleSource = "https://example.com/markets/4689100176946822";
const samplePolymarket =
  "https://polymarket.com/esports/honor-of-kings/king-pro-league/hok-tesa-ttg-2026-07-31";

function roundLabel(round: number): string {
  return round === 0 ? "全场" : `G${round}`;
}

export default function ConfigurePage() {
  const router = useRouter();
  const [sourceUrl, setSourceUrl] = useState("");
  const [polymarketUrl, setPolymarketUrl] = useState("");
  const [savedMatches, setSavedMatches] = useState<SavedMatch[]>([]);
  const [makerRunning, setMakerRunning] = useState(false);
  const [limits, setLimits] = useState<RuntimeLimits | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [manualOpen, setManualOpen] = useState(false);

  const refreshSaved = useCallback(async () => {
    const [markets, status, nextLimits] = await Promise.all([
      api<{ mappings: unknown[]; savedMatches: SavedMatch[] }>("/api/markets"),
      api<{ process: { running: boolean } }>("/api/status"),
      api<RuntimeLimits>("/api/limits"),
    ]);
    setSavedMatches(markets.savedMatches);
    setMakerRunning(status.process.running);
    setLimits(nextLimits);
  }, []);

  useEffect(() => {
    void refreshSaved().catch((caught) => {
      setError(caught instanceof Error ? caught.message : String(caught));
    });
  }, [refreshSaved]);

  function openMatch(match: SavedMatch) {
    router.push(
      matchConfigPath(match.polymarketEventSlug, {
        sourceUrl: match.sourceUrl,
        polymarketUrl: match.polymarketUrl,
      }),
    );
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
      await refreshSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  function openManual() {
    const slug = eventSlugFromPolymarketUrl(polymarketUrl);
    if (!sourceUrl.trim() || !slug) {
      setError("请填写源站比赛 URL，以及带事件 slug 的 Polymarket 事件页。");
      return;
    }
    setError("");
    router.push(
      matchConfigPath(slug, {
        sourceUrl: sourceUrl.trim(),
        polymarketUrl: polymarketUrl.trim(),
      }),
    );
  }

  return (
    <>
      <header className="mb-7">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-gold">
          Market desk
        </p>
        <h1 className="m-0 font-display text-[34px] font-medium tracking-tight text-ink">
          选择比赛
        </h1>
        <p className="mt-2.5 max-w-[62ch] text-[15px] leading-relaxed text-mute">
          先扫 KPL / KGL 赛程，点进一场（例如 上海EDG.M vs 杭州LGD.NBW）再配置全场和小局。默认 paper
          / shadow，live 仍要双重确认。
        </p>
      </header>

      {error && <div className={`${errorClass} mb-4`}>{error}</div>}

      <LeagueAutoMaker limits={limits} makerRunning={makerRunning} onSaved={refreshSaved} />

      {savedMatches.length > 0 && (
        <section className={`${panelClass} mb-5`}>
          <div className="mb-4">
            <h2 className="m-0 text-lg font-medium">已保存的比赛</h2>
            <p className="mt-1.5 text-sm leading-relaxed text-mute">
              点进一场比赛会打开详情页，再勾选全场、G1–G6 和让分盘。
            </p>
          </div>
          <div className="grid gap-2.5">
            {savedMatches.map((match) => (
              <article
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-inset px-4 py-3.5"
                key={`${match.sourceMatchId}-${match.polymarketEventSlug}`}
              >
                <Link
                  className="min-w-0 flex-1 text-ink no-underline hover:text-gold"
                  href={matchConfigPath(match.polymarketEventSlug, {
                    sourceUrl: match.sourceUrl,
                    polymarketUrl: match.polymarketUrl,
                  })}
                >
                  <strong className="block text-[15px]">{match.label}</strong>
                  <small className="mt-1 block text-xs text-mute">
                    {match.tournament ? `${match.tournament} · ` : ""}
                    {match.enabledCount}/{match.marketCount} 启用
                    {match.enabledRounds.length > 0
                      ? ` · ${match.enabledRounds.map(roundLabel).join(" / ")}`
                      : " · 暂无启用盘口"}
                  </small>
                </Link>
                <div className="flex gap-2">
                  <Button disabled={loading} onClick={() => openMatch(match)} variant="secondary">
                    配置小局
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
          <h2 className="m-0 text-lg font-medium">手动粘贴链接</h2>
          <p className="mt-1.5 text-sm text-mute">
            源站比赛页 + Polymarket 事件页。会进入这场比赛的详情页再配置盘口。
          </p>
        </summary>
        <section className="border-t border-line px-5 py-5">
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
            <Button disabled={!sourceUrl || !polymarketUrl} onClick={openManual}>
              进入比赛
            </Button>
          </div>
          {error && <div className={`${errorClass} mt-3`}>{error}</div>}
        </section>
      </details>
    </>
  );
}
