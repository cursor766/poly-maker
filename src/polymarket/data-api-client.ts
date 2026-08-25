export interface MarketTrade {
  id: string;
  at: number;
  side: "BUY" | "SELL";
  outcome: string;
  price: number;
  size: number;
  notional: number;
  name: string;
  wallet: string;
}

export interface MarketHolder {
  outcome: string;
  name: string;
  wallet: string;
  amount: number;
  share: number;
}

export interface MarketHolderGroup {
  tokenId: string;
  outcome: string;
  holders: MarketHolder[];
}

interface RawTrade {
  transactionHash?: string;
  timestamp?: number | string;
  side?: string;
  outcome?: string;
  price?: number | string;
  size?: number | string;
  name?: string;
  pseudonym?: string;
  proxyWallet?: string;
}

interface RawHolder {
  proxyWallet?: string;
  name?: string;
  pseudonym?: string;
  amount?: number | string;
  outcomeIndex?: number;
}

interface RawHolderToken {
  token?: string;
  holders?: RawHolder[];
}

export class PolymarketDataApiClient {
  constructor(private readonly host = "https://data-api.polymarket.com") {}

  async fetchTrades(conditionId: string, limit = 20): Promise<MarketTrade[]> {
    const url = new URL("/trades", this.host);
    url.searchParams.set("market", conditionId);
    url.searchParams.set("limit", String(limit));
    const payload = await this.getJson<RawTrade[]>(url);
    return (Array.isArray(payload) ? payload : []).flatMap((item, index) => {
      const trade = parseTrade(item, index);
      return trade ? [trade] : [];
    });
  }

  async fetchHolders(
    conditionId: string,
    outcomes: readonly string[],
    limit = 8,
  ): Promise<MarketHolderGroup[]> {
    const url = new URL("/holders", this.host);
    url.searchParams.set("market", conditionId);
    url.searchParams.set("limit", String(limit));
    const payload = await this.getJson<RawHolderToken[] | null>(url);
    const groups = Array.isArray(payload) ? payload : [];
    return groups.map((group, index) => {
      const holders = (group.holders ?? [])
        .map((holder) => parseHolder(holder, outcomes[holder.outcomeIndex ?? index] ?? `Outcome ${index}`))
        .filter((holder): holder is MarketHolder => holder !== null);
      const total = holders.reduce((sum, holder) => sum + holder.amount, 0);
      return {
        tokenId: group.token ?? "",
        outcome: outcomes[index] ?? holders[0]?.outcome ?? `Outcome ${index}`,
        holders: holders.map((holder) => ({
          ...holder,
          share: total > 0 ? holder.amount / total : 0,
        })),
      };
    });
  }

  private async getJson<T>(url: URL): Promise<T> {
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`Polymarket data API ${response.status} for ${url.pathname}`);
    }
    return (await response.json()) as T;
  }
}

export function parseTrade(item: RawTrade, index: number): MarketTrade | null {
  const side = String(item.side ?? "").toUpperCase();
  if (side !== "BUY" && side !== "SELL") return null;
  const price = Number(item.price);
  const size = Number(item.size);
  if (!Number.isFinite(price) || !Number.isFinite(size) || size <= 0) return null;
  const timestamp = Number(item.timestamp);
  const at = timestamp > 1e12 ? timestamp : timestamp * 1000;
  return {
    id: item.transactionHash || `trade-${index}-${timestamp}`,
    at: Number.isFinite(at) ? at : 0,
    side,
    outcome: item.outcome || "—",
    price,
    size,
    notional: price * size,
    name: item.name || item.pseudonym || shortenWallet(item.proxyWallet),
    wallet: item.proxyWallet ?? "",
  };
}

function parseHolder(item: RawHolder, outcome: string): MarketHolder | null {
  const amount = Number(item.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return {
    outcome,
    name: item.name || item.pseudonym || shortenWallet(item.proxyWallet),
    wallet: item.proxyWallet ?? "",
    amount,
    share: 0,
  };
}

function shortenWallet(wallet: string | undefined): string {
  if (!wallet || wallet.length < 10) return wallet || "unknown";
  return `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
}
