export function eventSlugFromPolymarketUrl(value: string): string | null {
  try {
    const slug = new URL(value.trim()).pathname.split("/").filter(Boolean).at(-1);
    if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)+$/i.test(slug)) return null;
    return slug;
  } catch {
    return null;
  }
}

export function matchConfigPath(
  eventSlug: string,
  urls?: { sourceUrl?: string; polymarketUrl?: string },
): string {
  const path = `/matches/${encodeURIComponent(eventSlug)}`;
  const params = new URLSearchParams();
  if (urls?.sourceUrl) params.set("sourceUrl", urls.sourceUrl);
  if (urls?.polymarketUrl) params.set("polymarketUrl", urls.polymarketUrl);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}
