import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { MarketMapping, TradingMode } from "../types.js";

function processRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

export class MakerProcessManager {
  private child: ChildProcess | undefined;

  constructor(
    private readonly projectRoot: string,
    private readonly pidPath = "data/maker.pid",
    private readonly lockPath = ".poly-maker.pid",
  ) {}

  async status(): Promise<{ running: boolean; pid: number | null }> {
    const managedPid = await this.readPid(this.pidPath);
    const lockPid = await this.readPid(this.lockPath);
    if (managedPid !== null && !processRunning(managedPid)) await this.removePath(this.pidPath);
    if (lockPid !== null && !processRunning(lockPid)) await this.removePath(this.lockPath);
    const pid =
      managedPid !== null && processRunning(managedPid)
        ? managedPid
        : lockPid !== null && processRunning(lockPid)
          ? lockPid
          : null;
    return { running: pid !== null, pid };
  }

  async start(mode: TradingMode, mappings: readonly MarketMapping[]): Promise<number> {
    const current = await this.status();
    if (current.running) throw new Error(`做市进程已在运行（PID ${current.pid}）`);
    const enabled = mappings.filter((mapping) => mapping.enabled);
    if (enabled.length === 0) throw new Error("至少需要启用一个市场");
    const matchIds = [...new Set(mappings.map((mapping) => mapping.sourceMatchId))];
    const allowlist = [...new Set(mappings.map((mapping) => mapping.polymarketSlug))];

    const child = spawn(resolve(this.projectRoot, "node_modules/.bin/tsx"), ["src/index.ts"], {
      cwd: this.projectRoot,
      env: {
        ...process.env,
        TRADING_MODE: mode,
        OBSERVE_ONLY: "false",
        TUI_ENABLED: "false",
        CONTROL_MANAGED_HOT_RELOAD: "true",
        SOURCE_MATCH_IDS: matchIds.join(","),
        POLYMARKET_MARKET_ALLOWLIST: allowlist.join(","),
      },
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (!child.pid) throw new Error("无法启动做市进程");
    this.child = child;
    const pid = child.pid;
    await this.writePid(pid);
    child.once("exit", () => {
      if (this.child === child) this.child = undefined;
      void this.removePidIfOwned(pid);
    });
    await wait(300);
    if (child.exitCode !== null) {
      await this.removePidIfOwned(pid);
      throw new Error(`做市进程启动失败，退出码 ${child.exitCode}`);
    }
    return pid;
  }

  async stop(timeoutMs = 15_000): Promise<void> {
    const current = await this.status();
    if (!current.running || current.pid === null) return;
    process.kill(current.pid, "SIGTERM");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && processRunning(current.pid)) await wait(100);
    if (processRunning(current.pid)) {
      throw new Error("做市进程仍在执行保护性撤单，请稍后重试");
    }
    await this.removePidIfOwned(current.pid);
  }

  private async readPid(relativePath = this.pidPath): Promise<number | null> {
    try {
      const value = await readFile(resolve(this.projectRoot, relativePath), "utf8");
      const pid = Number.parseInt(value, 10);
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async writePid(pid: number): Promise<void> {
    const path = resolve(this.projectRoot, this.pidPath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, String(pid), "utf8");
  }

  private async removePidIfOwned(pid: number): Promise<void> {
    if ((await this.readPid()) === pid) await this.removePid();
  }

  private async removePid(): Promise<void> {
    await this.removePath(this.pidPath);
  }

  private async removePath(relativePath: string): Promise<void> {
    await unlink(resolve(this.projectRoot, relativePath)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
