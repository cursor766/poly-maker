import { api, type ControlStatus, type TradingMode } from "@/lib/api";

export const MATCH_DESK_MODE: TradingMode = "live";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function readMakerStatus(): Promise<ControlStatus> {
  return api<ControlStatus>("/api/status");
}

export async function ensureMakerRunning(
  mode: TradingMode = MATCH_DESK_MODE,
  timeoutMs = 20_000,
): Promise<ControlStatus> {
  let status = await readMakerStatus();
  if (status.process.running) return status;
  try {
    await api("/api/start", {
      method: "POST",
      body: JSON.stringify({ mode }),
    });
  } catch (caught) {
    status = await readMakerStatus();
    if (status.process.running) return status;
    throw caught;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    status = await readMakerStatus();
    if (status.process.running) return status;
    await sleep(300);
  }
  throw new Error("实盘挂单未能启动。请检查钱包密钥与 LIVE_TRADING_ACK。");
}
