import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import pino, { type Logger } from "pino";

const REDACT_PATHS = [
  "password",
  "username",
  "privateKey",
  "apiKey",
  "apiSecret",
  "passphrase",
  "config.MQTT_PASSWORD",
  "config.MQTT_USERNAME",
  "config.SOURCE_API_TOKEN",
  "config.POLYMARKET_PRIVATE_KEY",
  "config.POLYMARKET_API_SECRET",
  "config.POLYMARKET_B_PRIVATE_KEY",
];

export function createLogger(level: string): Logger {
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    base: { service: "poly-maker" },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export class AuditLog {
  private initialized = false;

  constructor(private readonly path: string) {}

  async write(event: string, data: Record<string, unknown>): Promise<void> {
    if (!this.initialized) {
      await mkdir(dirname(this.path), { recursive: true });
      this.initialized = true;
    }
    const record = JSON.stringify({ timestamp: new Date().toISOString(), event, ...data });
    await appendFile(this.path, `${record}\n`, { encoding: "utf8", mode: 0o600 });
  }
}
