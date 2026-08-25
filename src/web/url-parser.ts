export interface ParsedMarketUrls {
  sourceUrl: string;
  polymarketUrl: string;
  matchId: string;
  eventSlug: string;
}

function parseHttpUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${label}不是有效的 URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label}必须使用 http 或 https`);
  }
  return url;
}

export function parseMarketUrls(sourceValue: string, polymarketValue: string): ParsedMarketUrls {
  const source = parseHttpUrl(sourceValue, "源站地址");
  const polymarket = parseHttpUrl(polymarketValue, "Polymarket 地址");
  const sourceParts = source.pathname.split("/").filter(Boolean);
  const marketsIndex = sourceParts.lastIndexOf("markets");
  const matchId = marketsIndex >= 0 ? sourceParts[marketsIndex + 1] : undefined;
  if (!matchId || !/^\d+$/.test(matchId)) {
    throw new Error("源站地址中缺少 /markets/<比赛ID>");
  }

  const polymarketParts = polymarket.pathname.split("/").filter(Boolean);
  const eventSlug = polymarketParts.at(-1);
  if (!eventSlug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(eventSlug)) {
    throw new Error("Polymarket 地址中缺少有效的事件 slug");
  }

  return {
    sourceUrl: source.toString(),
    polymarketUrl: polymarket.toString(),
    matchId,
    eventSlug,
  };
}
