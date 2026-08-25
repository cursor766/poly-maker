import { normalizeDecimalOdds } from "../odds/probability.js";
import type {
  PolymarketOddsSnapshot,
  Quote,
  SourceMarketState,
  SourceMatchMetadata,
  SourceOddUpdate,
  TradingMode,
} from "../types.js";

interface MarketView {
  matchId: string;
  odds: Map<string, SourceOddUpdate>;
  updatedAt: number;
}

interface ExecutionView {
  locked: boolean;
  reason: string | undefined;
  quotes: readonly Quote[];
}

const ANSI = {
  reset: "\u001B[0m",
  bold: "\u001B[1m",
  dim: "\u001B[2m",
  cyan: "\u001B[36m",
  green: "\u001B[32m",
  yellow: "\u001B[33m",
  red: "\u001B[31m",
  magenta: "\u001B[35m",
  white: "\u001B[97m",
};

function paint(value: string, code: string, enabled: boolean): string {
  return enabled ? `${code}${value}${ANSI.reset}` : value;
}

function isWide(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6))
  );
}

function textWidth(value: string): number {
  return [...value].reduce((width, character) => width + (isWide(character) ? 2 : 1), 0);
}

function fit(value: string, width: number): string {
  let output = "";
  let used = 0;
  for (const character of value) {
    const characterWidth = isWide(character) ? 2 : 1;
    if (used + characterWidth > width) break;
    output += character;
    used += characterWidth;
  }
  if (used < textWidth(value) && width > 0) {
    while (used >= width && output.length > 0) {
      const removed = output.at(-1) ?? "";
      output = output.slice(0, -1);
      used -= isWide(removed) ? 2 : 1;
    }
    output += "…";
    used += 1;
  }
  return `${output}${" ".repeat(Math.max(0, width - used))}`;
}

function age(timestamp: number | undefined, now: number): string {
  if (!timestamp) return "-";
  const milliseconds = Math.max(0, now - timestamp);
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}s`;
  return `${Math.floor(milliseconds / 60_000)}m`;
}

function probabilityBar(probability: number | undefined, width: number): string {
  if (probability === undefined) return "·".repeat(width);
  const filled = Math.max(0, Math.min(width, Math.round(probability * width)));
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function makerAskPrices(
  probabilities: readonly number[],
  targetReturnRate: number,
): readonly [number, number] | undefined {
  const firstProbability = probabilities[0];
  const secondProbability = probabilities[1];
  if (firstProbability === undefined || secondProbability === undefined) return undefined;
  const totalCents = Math.round(100 / targetReturnRate);
  const firstCents = Math.round(firstProbability * totalCents);
  const secondCents = totalCents - firstCents;
  if (firstCents <= 0 || firstCents >= 100 || secondCents <= 0 || secondCents >= 100) {
    return undefined;
  }
  return [firstCents / 100, secondCents / 100];
}

function polymarketQuote(ask: number | null, bid: number | null): string {
  const askText = ask === null ? "买--" : `买${(ask * 100).toFixed(0)}¢`;
  const bidText = bid === null ? "卖--" : `卖${(bid * 100).toFixed(0)}¢`;
  const decimalText = ask === null ? "--" : (1 / ask).toFixed(2);
  return `${askText} ${bidText} / ${decimalText}`;
}

function isWinnerMarketName(name: string | undefined): boolean {
  return name === "全场胜负" || /^第\d+局胜负$/.test(name ?? "");
}

export class OddsTui {
  private readonly startedAt = Date.now();
  private readonly markets = new Map<string, MarketView>();
  private readonly states = new Map<string, SourceMarketState>();
  private readonly matches = new Map<string, SourceMatchMetadata>();
  private readonly polymarketOdds = new Map<number, PolymarketOddsSnapshot>();
  private readonly execution = new Map<number, ExecutionView>();
  private connected = false;
  private messageCount = 0;
  private lastMessageAt?: number;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly refreshMs: number,
    private readonly maxMarkets: number,
    private readonly makerTargetReturnRate = 0.8,
    private readonly tradingMode: TradingMode = "paper",
  ) {}

  start(): void {
    if (this.timer) return;
    process.stdout.write("\u001B[?1049h\u001B[2J\u001B[H\u001B[?25l");
    this.render();
    this.timer = setInterval(() => this.render(), this.refreshMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    process.stdout.write("\u001B[?25h\u001B[?1049l");
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
  }

  recordOdds(updates: readonly SourceOddUpdate[]): void {
    for (const update of updates) {
      const market = this.markets.get(update.marketId) ?? {
        matchId: update.matchId,
        odds: new Map<string, SourceOddUpdate>(),
        updatedAt: update.receivedAt,
      };
      const previous = market.odds.get(update.oddId);
      if (previous && previous.receivedAt > update.receivedAt) continue;
      market.matchId = update.matchId;
      market.odds.set(update.oddId, update);
      market.updatedAt = Math.max(market.updatedAt, update.receivedAt);
      this.markets.set(update.marketId, market);
      this.messageCount += 1;
      this.lastMessageAt = Math.max(this.lastMessageAt ?? 0, update.receivedAt);
    }
  }

  recordStates(states: readonly SourceMarketState[]): void {
    for (const state of states) this.states.set(state.marketId, state);
  }

  recordMatchMetadata(metadata: SourceMatchMetadata): void {
    this.matches.set(metadata.matchId, metadata);
    this.recordStates(metadata.initialStates);
    this.recordOdds(metadata.initialOdds);
  }

  recordPolymarketOdds(snapshots: readonly PolymarketOddsSnapshot[]): void {
    this.polymarketOdds.clear();
    for (const snapshot of snapshots) this.polymarketOdds.set(snapshot.round, snapshot);
  }

  recordExecutionState(
    round: number,
    locked: boolean,
    reason?: string,
    quotes: readonly Quote[] = [],
  ): void {
    this.execution.set(round, { locked, reason, quotes });
  }

  recordError(error: Error): void {
    void error;
  }

  snapshot(): {
    connected: boolean;
    messageCount: number;
    marketCount: number;
    lastMessageAt: number | undefined;
  } {
    return {
      connected: this.connected,
      messageCount: this.messageCount,
      marketCount: this.markets.size,
      lastMessageAt: this.lastMessageAt,
    };
  }

  buildScreen(now = Date.now(), requestedWidth = 120, useColor = false): string {
    const width = Math.max(88, Math.min(requestedWidth, 140));
    const inner = width - 2;
    const lines: string[] = [];
    const connection = this.connected
      ? paint("● ONLINE", ANSI.green, useColor)
      : paint("● OFFLINE", ANSI.red, useColor);

    lines.push(paint(`╭${"─".repeat(inner)}╮`, ANSI.cyan, useColor));
    lines.push(
      `${paint("│", ANSI.cyan, useColor)} ${paint("POLY MAKER", ANSI.bold + ANSI.white, useColor)}  ${paint("LIVE ODDS TERMINAL", ANSI.cyan, useColor)}${" ".repeat(Math.max(1, inner - 48))}${connection} ${paint("│", ANSI.cyan, useColor)}`,
    );
    const modeLine =
      this.tradingMode === "paper"
        ? "PAPER  ·  MQTT FEED  ·  POLYMARKET WS  ·  SIMULATION"
        : this.tradingMode === "shadow"
          ? "SHADOW  ·  ACCOUNT READ ONLY  ·  NO ORDER MUTATIONS"
          : "LIVE TYPE3  ·  BUY-ONLY  ·  LOCK BARRIER ACTIVE";
    lines.push(
      `${paint("│", ANSI.cyan, useColor)} ${paint(fit(modeLine, inner - 2), ANSI.yellow, useColor)} ${paint("│", ANSI.cyan, useColor)}`,
    );
    lines.push(paint(`╰${"─".repeat(inner)}╯`, ANSI.cyan, useColor));

    const match = [...this.matches.values()][0];
    if (match) {
      const [homeScore = "0", awayScore = "0"] = match.score.split(":");
      lines.push("");
      lines.push(
        `${paint(match.tournament || "赛事", ANSI.magenta, useColor)}  ${paint(`BO${match.bestOf}`, ANSI.dim, useColor)}  ${paint(`MATCH ${match.matchId}`, ANSI.dim, useColor)}`,
      );
      lines.push(
        `${paint(fit(match.teams[0], 28), ANSI.bold, useColor)} ${paint(homeScore, ANSI.green, useColor)}  ${paint("─", ANSI.dim, useColor)}  ${paint(awayScore, ANSI.green, useColor)} ${paint(match.teams[1], ANSI.bold, useColor)}`,
      );
    }

    const targetMarkets = [...this.markets.entries()].filter(([marketId, market]) =>
      isWinnerMarketName(this.matches.get(market.matchId)?.markets.get(marketId)?.name),
    );

    lines.push("");
    lines.push(
      [
        `${paint("连接", ANSI.dim, useColor)} ${connection}`,
        `${paint("运行", ANSI.dim, useColor)} ${age(this.startedAt, now)}`,
        `${paint("更新", ANSI.dim, useColor)} ${this.messageCount}`,
        `${paint("盘口", ANSI.dim, useColor)} ${targetMarkets.length}`,
        `${paint("最新", ANSI.dim, useColor)} ${age(this.lastMessageAt, now)} 前`,
      ].join(paint("   │   ", ANSI.dim, useColor)),
    );

    const markets = targetMarkets
      .sort((left, right) => {
        const leftMetadata = this.matches.get(left[1].matchId)?.markets.get(left[0]);
        const rightMetadata = this.matches.get(right[1].matchId)?.markets.get(right[0]);
        const leftPriority = leftMetadata?.name === "全场胜负" ? 0 : 1;
        const rightPriority = rightMetadata?.name === "全场胜负" ? 0 : 1;
        return (
          leftPriority - rightPriority ||
          (leftMetadata?.round ?? 0) - (rightMetadata?.round ?? 0) ||
          right[1].updatedAt - left[1].updatedAt
        );
      })
      .slice(0, this.maxMarkets);

    if (markets.length === 0) {
      lines.push("", paint("  等待目标比赛赔率快照或 MQTT 增量……", ANSI.yellow, useColor));
    }

    for (const [marketId, market] of markets) {
      const matchMetadata = this.matches.get(market.matchId);
      const marketMetadata = matchMetadata?.markets.get(marketId);
      const legs = [...market.odds.values()].sort((left, right) =>
        left.oddId.localeCompare(right.oddId),
      );
      let normalized: number[] = [];
      if (legs.length === 2) {
        try {
          normalized = normalizeDecimalOdds(legs.map((leg) => leg.decimalOdd)).probabilities;
        } catch {
          normalized = [];
        }
      }
      const state = this.states.get(marketId);
      const status = state
        ? state.suspended
          ? "PAUSED"
          : !state.visible
            ? "HIDDEN"
            : state.open
              ? "OPEN"
              : "CLOSED"
        : "LIVE";
      const statusColor = status === "OPEN" || status === "LIVE" ? ANSI.green : ANSI.yellow;
      const scope =
        marketMetadata?.scope === "match"
          ? "全场"
          : marketMetadata?.scope === "game"
            ? `第${marketMetadata.round}局`
            : "待识别";
      const marketName = marketMetadata?.name ?? "未知盘口";

      lines.push("");
      lines.push(paint(`┌${"─".repeat(inner)}┐`, ANSI.dim, useColor));
      lines.push(
        `${paint("│", ANSI.dim, useColor)} ${paint(scope, ANSI.cyan, useColor)}  ${paint(marketName, ANSI.bold, useColor)}  ${paint(status, statusColor, useColor)}${" ".repeat(Math.max(1, inner - textWidth(scope) - textWidth(marketName) - status.length - 8))}${paint(`${age(market.updatedAt, now)} 前`, ANSI.dim, useColor)} ${paint("│", ANSI.dim, useColor)}`,
      );

      legs.forEach((leg, index) => {
        const fair = normalized[index];
        const outcomeName = marketMetadata?.outcomes.get(leg.oddId) ?? `选项 ${index + 1}`;
        const probability = fair === undefined ? "   --   " : `${(fair * 100).toFixed(2)}%`;
        const bar = probabilityBar(fair, 18);
        lines.push(
          `${paint("│", ANSI.dim, useColor)}   ${paint(fit(outcomeName, 28), ANSI.bold, useColor)} ${paint(leg.decimalOdd.toFixed(3).padStart(7), ANSI.yellow, useColor)}   ${paint(probability.padStart(7), ANSI.green, useColor)}   ${paint(bar, ANSI.cyan, useColor)}${" ".repeat(Math.max(1, inner - 70))}${paint("│", ANSI.dim, useColor)}`,
        );
      });
      const polymarket = this.polymarketOdds.get(marketMetadata?.round ?? -1);
      const execution = this.execution.get(marketMetadata?.round ?? -1);
      const sourceLocked = state ? state.suspended || !state.visible || !state.open : true;
      const makerPrices = makerAskPrices(normalized, this.makerTargetReturnRate);
      const makerLabel = this.tradingMode === "paper" ? "你的模拟卖价" : "源站目标卖价";
      const makerLine = sourceLocked
        ? `${makerLabel}  已暂停：源站锁盘`
        : !polymarket
          ? `${makerLabel}  已暂停：Polymarket 无对应市场`
          : !polymarket.tradingOpen
            ? `${makerLabel}  已暂停：Polymarket 已锁盘`
            : makerPrices
              ? `${makerLabel}  ${marketMetadata?.outcomes.get(legs[0]?.oddId ?? "") ?? "选项1"} ${(makerPrices[0] * 100).toFixed(0)}¢ / ${(1 / makerPrices[0]).toFixed(2)}    ${marketMetadata?.outcomes.get(legs[1]?.oddId ?? "") ?? "选项2"} ${(makerPrices[1] * 100).toFixed(0)}¢ / ${(1 / makerPrices[1]).toFixed(2)}    合计 ${((makerPrices[0] + makerPrices[1]) * 100).toFixed(0)}¢ · 返还 ${(this.makerTargetReturnRate * 100).toFixed(0)}%`
              : `${makerLabel}  已暂停：当前公平概率无法满足目标返还率`;
      lines.push(
        `${paint("│", ANSI.dim, useColor)}   ${paint(fit(makerLine, inner - 4), ANSI.yellow, useColor)} ${paint("│", ANSI.dim, useColor)}`,
      );
      if (execution && this.tradingMode !== "paper") {
        const executionLines = execution.locked
          ? [`${this.tradingMode.toUpperCase()} 已锁定：${execution.reason ?? "等待新鲜双边赔率"}`]
          : execution.quotes.length === 0
            ? [`${this.tradingMode.toUpperCase()} 无计划订单`]
            : [...new Set(execution.quotes.map((quote) => quote.outcome))].map((outcome) => {
                const layers = execution.quotes
                  .filter((quote) => quote.outcome === outcome)
                  .map((quote) => `${(quote.price * 100).toFixed(0)}¢×${quote.size}`)
                  .join(" / ");
                return `${this.tradingMode.toUpperCase()} ${outcome} BUY ${layers}`;
              });
        for (const executionLine of executionLines) {
          lines.push(
            `${paint("│", ANSI.dim, useColor)}   ${paint(fit(executionLine, inner - 4), execution.locked ? ANSI.red : ANSI.green, useColor)} ${paint("│", ANSI.dim, useColor)}`,
          );
        }
      }
      const polymarketLine = polymarket
        ? `Polymarket ${polymarket.tradingOpen ? "OPEN" : "LOCKED"}  ${polymarket.outcomes[0]} ${polymarketQuote(polymarket.prices[0], polymarket.bestBids[0])}    ${polymarket.outcomes[1]} ${polymarketQuote(polymarket.prices[1], polymarket.bestBids[1])}  · ${age(polymarket.receivedAt, now)} 前`
        : "Polymarket  暂无对应胜负市场";
      lines.push(
        `${paint("│", ANSI.dim, useColor)}   ${paint(fit(polymarketLine, inner - 4), ANSI.magenta, useColor)} ${paint("│", ANSI.dim, useColor)}`,
      );
      lines.push(
        `${paint("│", ANSI.dim, useColor)}   ${paint(`market ${marketId}`, ANSI.dim, useColor)}${" ".repeat(Math.max(1, inner - marketId.length - 11))}${paint("│", ANSI.dim, useColor)}`,
      );
      lines.push(paint(`└${"─".repeat(inner)}┘`, ANSI.dim, useColor));
    }

    const footer =
      this.tradingMode === "live"
        ? "Ctrl+C 退出并撤单  ·  TYPE3 实盘  ·  仅对白名单市场提交订单"
        : this.tradingMode === "shadow"
          ? "Ctrl+C 退出  ·  SHADOW 只读账户  ·  不会提交或撤销订单"
          : "Ctrl+C 退出  ·  PAPER 模拟  ·  不会向 Polymarket 提交订单";
    lines.push("", paint(footer, ANSI.dim, useColor));
    return lines.join("\n");
  }

  render(now = Date.now()): void {
    const output = this.buildScreen(now, process.stdout.columns ?? 120, true);
    process.stdout.write(`\u001B[H${output}\u001B[J`);
  }
}
