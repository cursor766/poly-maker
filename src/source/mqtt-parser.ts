import { z } from "zod";
import type { SourceMarketState, SourceOddUpdate } from "../types.js";

const sourceOddSchema = z.object({
  market_id: z.coerce.string().min(1),
  match_id: z.coerce.string().min(1),
  id: z.coerce.string().min(1),
  odd: z.coerce.number().nonnegative(),
  return_rate: z.coerce.number().nonnegative(),
});

const statusUpdateSchema = z.object({
  market_id: z.coerce.string().min(1),
  status: z.coerce.number().optional(),
});

export type ParsedMqttMessage =
  | { kind: "odds"; updates: SourceOddUpdate[] }
  | { kind: "state"; states: SourceMarketState[] }
  | { kind: "discovery"; topic: string; payload: unknown };

function parseJson(payload: Buffer): unknown {
  const text = payload.toString("utf8");
  if (text.length === 0) {
    throw new Error("empty MQTT payload");
  }
  return JSON.parse(text);
}

function unwrapArray(payload: unknown): unknown[] {
  return Array.isArray(payload) ? payload : [payload];
}

function marketIdFromTopic(topic: string): string | undefined {
  return topic.split("/").filter(Boolean).at(-1);
}

export function parseMqttMessage(
  topic: string,
  payload: Buffer,
  receivedAt = Date.now(),
): ParsedMqttMessage {
  const decoded = parseJson(payload);

  if (
    topic === "/market/odds/update" ||
    topic.startsWith("/market/oddsUpdate/") ||
    topic === "/odd/action/insert" ||
    topic.startsWith("/odd/insert/")
  ) {
    const updates = z
      .array(sourceOddSchema)
      .parse(unwrapArray(decoded))
      .filter((value) => value.odd > 1 && value.return_rate > 0)
      .map((value) => ({
        marketId: value.market_id,
        matchId: value.match_id,
        oddId: value.id,
        decimalOdd: value.odd,
        returnRate: value.return_rate,
        receivedAt,
      }));
    return { kind: "odds", updates };
  }

  if (
    topic === "/market/status/update" ||
    topic.startsWith("/market/statusUpdate/") ||
    topic === "/market/action/suspended" ||
    topic === "/market/action/visible" ||
    topic.startsWith("/market/suspended/") ||
    topic.startsWith("/market/visible/")
  ) {
    const isSuspendedTopic =
      topic === "/market/action/suspended" || topic.startsWith("/market/suspended/");
    const isVisibleTopic =
      topic === "/market/action/visible" || topic.startsWith("/market/visible/");
    const topicMarketId = marketIdFromTopic(topic);
    const values = unwrapArray(decoded);
    const states = values.map((value) => {
      const parsed = statusUpdateSchema.safeParse(value);
      const marketId = parsed.success ? parsed.data.market_id : topicMarketId;
      if (!marketId) {
        throw new Error(`cannot determine market id for topic ${topic}`);
      }
      const record =
        typeof value === "object" && value !== null
          ? (value as Record<string, unknown>)
          : ({ value } as Record<string, unknown>);
      const enabled = Boolean(
        isSuspendedTopic
          ? (record.suspended ?? record.value)
          : isVisibleTopic
            ? (record.visible ?? record.value)
            : (record.status ?? record.value),
      );
      const status = parsed.success ? parsed.data.status : undefined;
      const openStatus = status === 1 || status === 6;
      return {
        marketId,
        suspended: isSuspendedTopic ? enabled : status !== undefined && !openStatus,
        visible: isVisibleTopic ? enabled : true,
        open:
          status === undefined
            ? isSuspendedTopic
              ? !enabled
              : !isVisibleTopic || enabled
            : openStatus,
        updatedAt: receivedAt,
      };
    });
    return { kind: "state", states };
  }

  return { kind: "discovery", topic, payload: decoded };
}
