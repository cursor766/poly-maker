import { open, readFile, unlink } from "node:fs/promises";

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function acquireProcessLock(path = ".poly-maker.pid"): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx");
      await handle.writeFile(String(process.pid));
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await handle.close();
        await unlink(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      };
    } catch (error) {
      const fsError = error as NodeJS.ErrnoException;
      if (fsError.code !== "EEXIST") throw error;
      const owner = Number.parseInt(await readFile(path, "utf8").catch(() => ""), 10);
      if (isProcessRunning(owner)) {
        throw new Error(`another poly-maker process is already running (PID ${owner})`);
      }
      await unlink(path).catch((unlinkError: NodeJS.ErrnoException) => {
        if (unlinkError.code !== "ENOENT") throw unlinkError;
      });
    }
  }
  throw new Error("failed to acquire poly-maker process lock");
}
