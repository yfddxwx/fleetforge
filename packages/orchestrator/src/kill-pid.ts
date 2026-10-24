import { spawn } from "node:child_process";
import process from "node:process";

/**
 * Reap an orphan PID tree without a Child handle (server restarted, or the
 * watchdog found a hung CLI). Windows: taskkill /T /F; POSIX: kill the whole
 * process group when the PID is a group leader, else the PID itself.
 */
export async function killPidTree(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      const taskkill = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
      taskkill.once("close", (code) => resolve(code === 0));
      taskkill.once("error", () => resolve(false));
    });
  }
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      process.kill(-pid, signal); // process group
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        return false; // already gone
      }
    }
    const gone = await new Promise<boolean>((resolve) => {
      const deadline = Date.now() + 1500;
      const timer = setInterval(() => {
        try {
          process.kill(pid, 0);
        } catch {
          clearInterval(timer);
          resolve(true);
        }
        if (Date.now() > deadline) {
          clearInterval(timer);
          resolve(false);
        }
      }, 100);
      timer.unref?.();
    });
    if (gone) return true;
  }
  return false;
}
