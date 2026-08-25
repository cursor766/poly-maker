import { MakerApp } from "./app.js";
import { loadConfig, loadMarketMappings } from "./config.js";
import { createLogger } from "./logger.js";
import { acquireProcessLock } from "./process-lock.js";

async function main(): Promise<void> {
  const releaseProcessLock = await acquireProcessLock();
  const config = loadConfig();
  const logger = createLogger(config.TUI_ENABLED ? "silent" : config.LOG_LEVEL);
  const mappings = await loadMarketMappings(config.MARKETS_CONFIG_PATH);
  const app = new MakerApp(config, mappings, logger);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "shutdown requested");
    try {
      await app.stop(signal);
      process.exitCode = 0;
    } catch (error) {
      logger.error({ error }, "shutdown failed");
      process.exitCode = 1;
    } finally {
      await releaseProcessLock();
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await app.start();
  } catch (error) {
    await releaseProcessLock();
    throw error;
  }
}

main().catch((error) => {
  const logger = createLogger(process.env.LOG_LEVEL ?? "info");
  logger.fatal(
    { error: error instanceof Error ? { message: error.message, stack: error.stack } : error },
    "application failed",
  );
  process.exitCode = 1;
});
