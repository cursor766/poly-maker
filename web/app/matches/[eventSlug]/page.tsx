"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { MatchConfigDesk } from "@/app/components/MatchConfigDesk";
import { panelClass } from "@/app/components/ui";
import { api, type SavedMatch } from "@/lib/api";
import { eventSlugFromPolymarketUrl } from "@/lib/match-route";

function MatchConfigPageInner() {
  const params = useParams<{ eventSlug: string }>();
  const search = useSearchParams();
  const eventSlug = decodeURIComponent(params.eventSlug ?? "");
  const querySource = search.get("sourceUrl")?.trim() ?? "";
  const queryPoly = search.get("polymarketUrl")?.trim() ?? "";

  const [saved, setSaved] = useState<SavedMatch | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (querySource && queryPoly) {
      setLoaded(true);
      return;
    }
    api<{ savedMatches?: SavedMatch[] }>("/api/markets")
      .then((data) => {
        const matches = data.savedMatches ?? [];
        const found =
          matches.find((item) => item.polymarketEventSlug === eventSlug) ??
          matches.find((item) => eventSlugFromPolymarketUrl(item.polymarketUrl) === eventSlug) ??
          null;
        setSaved(found);
      })
      .catch(() => setSaved(null))
      .finally(() => setLoaded(true));
  }, [eventSlug, queryPoly, querySource]);

  const sourceUrl = querySource || saved?.sourceUrl || "";
  const polymarketUrl = queryPoly || saved?.polymarketUrl || "";

  if (!loaded) {
    return (
      <section className={panelClass}>
        <p className="m-0 text-sm text-mute">正在打开这场比赛…</p>
      </section>
    );
  }

  if (!sourceUrl || !polymarketUrl) {
    return (
      <section className={panelClass}>
        <h2 className="m-0 text-lg font-medium">找不到这场比赛</h2>
        <p className="mt-2 text-sm leading-relaxed text-mute">
          slug <code>{eventSlug}</code> 没有对应的源站链接和 Polymarket
          链接。请从联赛列表或已保存比赛进入。
        </p>
        <p className="mb-0 mt-3">
          <Link className="text-sm font-medium text-gold hover:text-ink" href="/">
            返回比赛列表
          </Link>
        </p>
      </section>
    );
  }

  return (
    <MatchConfigDesk eventSlug={eventSlug} sourceUrl={sourceUrl} polymarketUrl={polymarketUrl} />
  );
}

export default function MatchConfigPage() {
  return (
    <Suspense
      fallback={
        <section className={panelClass}>
          <p className="m-0 text-sm text-mute">正在打开这场比赛…</p>
        </section>
      }
    >
      <MatchConfigPageInner />
    </Suspense>
  );
}
