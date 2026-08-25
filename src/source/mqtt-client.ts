import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { connect, type IClientOptions, type MqttClient } from "mqtt";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import type { MarketMapping, SourceMarketState, SourceOddUpdate } from "../types.js";
import { parseMqttMessage } from "./mqtt-parser.js";

interface OddsFeedEvents {
  odds: [SourceOddUpdate[]];
  state: [SourceMarketState[]];
  discovery: [{ topic: string; payload: unknown }];
  connected: [];
  disconnected: [];
  error: [Error];
}

export function buildSubscriptionTopics(
  targetMatchIds: readonly string[],
  mappings: readonly MarketMapping[],
): string[] {
  const topics = new Set<string>(["/market/action/suspended", "/market/action/visible"]);
  if (targetMatchIds.length === 0) {
    topics.add("/market/odds/update");
    topics.add("/market/status/update");
    topics.add("/match/status/update");
    topics.add("/match/score/update");
    topics.add("/odd/action/insert");
    topics.add("/odd/status/update");
  }

  const scopedMatchIds =
    targetMatchIds.length > 0 ? targetMatchIds : mappings.map((mapping) => mapping.sourceMarketId);
  for (const matchId of new Set(scopedMatchIds)) {
    topics.add(`/market/oddsUpdate/${matchId}`);
    topics.add(`/market/statusUpdate/${matchId}`);
    topics.add(`/market/suspended/${matchId}`);
    topics.add(`/market/visible/${matchId}`);
    topics.add(`/odd/insert/${matchId}`);
    topics.add(`/odd/statusUpdate/${matchId}`);
    topics.add(`/odd/suspended/${matchId}`);
    topics.add(`/odd/visible/${matchId}`);
    topics.add(`/match/data/3/${matchId}/1`);
    topics.add(`/match/ant/event/${matchId}/1`);
  }
  return [...topics];
}

export class MqttOddsFeed {
  private readonly emitter = new EventEmitter();
  private client: MqttClient | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectDelay: number;
  private stopped = true;

  constructor(
    private readonly config: AppConfig,
    private mappings: MarketMapping[],
    private readonly logger: Logger,
  ) {
    this.reconnectDelay = config.MQTT_RECONNECT_MIN_MS;
  }

  on<K extends keyof OddsFeedEvents>(
    event: K,
    listener: (...args: OddsFeedEvents[K]) => void,
  ): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const client = this.client;
    this.client = undefined;
    if (client) client.end(true);
  }

  updateMappings(mappings: readonly MarketMapping[]): void {
    this.mappings = [...mappings];
    const client = this.client;
    if (client?.connected) this.subscribe(client);
  }

  private open(): void {
    if (this.stopped) return;

    const suffix = randomBytes(6).toString("hex");
    const options: IClientOptions = {
      protocolVersion: 4,
      clean: true,
      clientId: `${this.config.MQTT_CLIENT_ID_PREFIX}-${suffix}`,
      username: this.config.MQTT_USERNAME,
      password: this.config.MQTT_PASSWORD,
      keepalive: this.config.MQTT_KEEPALIVE_SECONDS,
      reconnectPeriod: 0,
      connectTimeout: 10_000,
      resubscribe: false,
      wsOptions: {
        headers: { Origin: this.config.MQTT_ORIGIN },
      },
    };

    this.logger.info({ url: this.config.MQTT_URL }, "connecting to MQTT odds feed");
    const client = connect(this.config.MQTT_URL, options);
    this.client = client;

    client.on("connect", () => {
      this.reconnectDelay = this.config.MQTT_RECONNECT_MIN_MS;
      this.subscribe(client);
      this.emitter.emit("connected");
      this.logger.info("MQTT odds feed connected");
    });
    client.on("message", (topic, payload) => {
      try {
        const message = parseMqttMessage(topic, payload);
        if (message.kind === "odds") this.emitter.emit("odds", message.updates);
        else if (message.kind === "state") this.emitter.emit("state", message.states);
        else this.emitter.emit("discovery", message);
      } catch (error) {
        const parsed = error instanceof Error ? error : new Error(String(error));
        this.logger.warn({ error: parsed.message, topic }, "invalid MQTT message ignored");
        this.emitter.emit("error", parsed);
      }
    });
    client.on("error", (error) => {
      this.logger.warn({ error: error.message }, "MQTT client error");
      this.emitter.emit("error", error);
    });
    client.on("close", () => {
      if (this.client === client) this.client = undefined;
      this.emitter.emit("disconnected");
      this.scheduleReconnect();
    });
  }

  private subscribe(client: MqttClient): void {
    const configuredMatchIds = this.mappings.map((mapping) => mapping.sourceMatchId);
    const topics = buildSubscriptionTopics(
      [...new Set([...this.config.SOURCE_MATCH_IDS, ...configuredMatchIds])],
      this.mappings,
    );
    client.subscribe(topics, { qos: 0 }, (error) => {
      if (error) {
        this.logger.error({ error: error.message }, "MQTT subscribe failed");
        client.end(true);
        return;
      }
      this.logger.info({ count: topics.length }, "MQTT subscriptions active");
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(
      this.config.MQTT_RECONNECT_MAX_MS,
      Math.round(this.reconnectDelay * 1.8),
    );
    this.logger.warn({ delayMs: delay }, "MQTT disconnected; reconnect scheduled");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.open();
    }, delay);
  }
}
