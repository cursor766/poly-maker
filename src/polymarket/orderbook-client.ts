import { Chain, ClobClient, Side } from "@polymarket/clob-client";
import type { ResolvedMarket, TokenBook } from "../types.js";

export class PolymarketOrderBookClient {
  private readonly client: ClobClient;

  constructor(host: string, chainId: number) {
    if (chainId !== Chain.POLYGON && chainId !== Chain.AMOY) {
      throw new Error(`unsupported Polymarket chain id: ${chainId}`);
    }
    this.client = new ClobClient(host, chainId);
  }

  async fetchBooks(market: ResolvedMarket): Promise<ReadonlyMap<string, TokenBook>> {
    const summaries = await this.client.getOrderBooks(
      market.tokenIds.map((tokenId) => ({ token_id: tokenId, side: Side.BUY })),
    );
    const receivedAt = Date.now();
    const books = new Map<string, TokenBook>();

    for (const summary of summaries) {
      if (!market.tokenIds.includes(summary.asset_id)) continue;
      const parseLevels = (levels: Array<{ price: string; size: string }>) =>
        levels
          .map((level) => ({ price: Number(level.price), size: Number(level.size) }))
          .filter(
            (level) =>
              Number.isFinite(level.price) &&
              Number.isFinite(level.size) &&
              level.price > 0 &&
              level.price < 1 &&
              level.size > 0,
          );
      books.set(summary.asset_id, {
        tokenId: summary.asset_id,
        bids: parseLevels(summary.bids).sort((a, b) => b.price - a.price),
        asks: parseLevels(summary.asks).sort((a, b) => a.price - b.price),
        receivedAt,
      });
    }

    if (books.size !== 2) throw new Error(`incomplete Polymarket order books for ${market.slug}`);
    return books;
  }
}
