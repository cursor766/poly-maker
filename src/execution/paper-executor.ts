import type { AuditLog } from "../logger.js";
import type { PositionState, Quote, ResolvedMarket, TokenBook } from "../types.js";
import type { QuoteExecutor } from "./executor.js";

function quoteKey(quote: Quote): string {
  return `${quote.tokenId}:${quote.side}`;
}

export class PaperExecutor implements QuoteExecutor {
  readonly positions: PositionState = { byToken: new Map(), cash: 0 };
  private readonly openQuotes = new Map<string, Quote>();
  locked = false;

  get openOrderCount(): number {
    return this.openQuotes.size;
  }

  get openOrderNotional(): number {
    return [...this.openQuotes.values()].reduce((sum, quote) => sum + quote.price * quote.size, 0);
  }

  constructor(private readonly audit: AuditLog) {}

  async initialize(): Promise<void> {}

  async reconcile(
    market: ResolvedMarket,
    quotes: readonly Quote[],
    books: ReadonlyMap<string, TokenBook>,
  ): Promise<void> {
    if (this.locked) return;
    await this.simulateFills(books);

    const desired = new Map(quotes.map((quote) => [quoteKey(quote), quote]));
    for (const [key, open] of this.openQuotes) {
      const replacement = desired.get(key);
      if (!replacement || replacement.price !== open.price || replacement.size !== open.size) {
        this.openQuotes.delete(key);
        await this.audit.write("paper_cancel", { market: market.slug, ...open });
      }
    }
    for (const [key, quote] of desired) {
      const open = this.openQuotes.get(key);
      if (open?.price === quote.price && open.size === quote.size) continue;
      this.openQuotes.set(key, quote);
      await this.audit.write("paper_quote", { market: market.slug, ...quote });
    }
  }

  async cancelAll(reason: string): Promise<void> {
    if (this.openQuotes.size === 0) return;
    const count = this.openQuotes.size;
    this.openQuotes.clear();
    await this.audit.write("paper_cancel_all", { reason, count });
  }

  async lock(reason: string): Promise<void> {
    this.locked = true;
    await this.cancelAll(reason);
  }

  unlock(): void {
    this.locked = false;
  }

  async syncAccount(): Promise<void> {}

  getOpenQuotes(): Quote[] {
    return [...this.openQuotes.values()];
  }

  private async simulateFills(books: ReadonlyMap<string, TokenBook>): Promise<void> {
    for (const [key, quote] of [...this.openQuotes]) {
      const book = books.get(quote.tokenId);
      if (!book) continue;
      const crossed =
        quote.side === "BUY"
          ? (book.asks[0]?.price ?? Number.POSITIVE_INFINITY) <= quote.price
          : (book.bids[0]?.price ?? Number.NEGATIVE_INFINITY) >= quote.price;
      if (!crossed) continue;

      const direction = quote.side === "BUY" ? 1 : -1;
      this.positions.byToken.set(
        quote.tokenId,
        (this.positions.byToken.get(quote.tokenId) ?? 0) + direction * quote.size,
      );
      this.positions.cash -= direction * quote.price * quote.size;
      this.openQuotes.delete(key);
      await this.audit.write("paper_fill", {
        ...quote,
        cash: this.positions.cash,
        position: this.positions.byToken.get(quote.tokenId),
      });
    }
  }
}
