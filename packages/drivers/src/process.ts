import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

export interface SpawnedProcess {
  child: ReturnType<typeof spawn>;
  pid: number | null;
  /** Kill the whole process tree. SIGTERM-equivalent first, then force. */
  killTree(): Promise<void>;
  /** Human-readable platform marker for tests/docs. */
  killStrategy: "taskkill-tree" | "process-group";
}

/**
 * Spawn a child in its own process group (POSIX) so the entire tree can be
 * reaped; on Windows the tree is reaped via `taskkill /T /F`.
 * Never leave zombie CLIs behind — see docs/adr/0005-process-tree-kill.md.
 */
export function spawnTree(
  command: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string>; detached?: boolean },
): SpawnedProcess {
  const isWindows = process.platform === "win32";
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: options.detached ?? !isWindows, // own process group on POSIX
  });

  const pid: number | null = typeof child.pid === "number" ? child.pid : null;
  const killStrategy: SpawnedProcess["killStrategy"] = isWindows
    ? "taskkill-tree"
    : "process-group";

  async function killTree(): Promise<void> {
    if (pid === null || child.exitCode !== null || child.signalCode !== null) return;
    if (isWindows) {
      await runTaskkill(pid);
    } else {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      const exited = await waitForExit(child, 2000);
      if (!exited) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    }
  }

  return { child, pid, killTree, killStrategy };
}

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, timeoutMs);
    function onExit(): void {
      clearTimeout(timer);
      resolve(true);
    }
    child.once("exit", onExit);
  });
}

function runTaskkill(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const taskkill = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
    });
    // Failure (e.g. process already gone) is fine — outcome is what matters.
    taskkill.once("close", () => resolve());
    taskkill.once("error", () => resolve());
  });
}

/** Check whether a PID belongs to a live process (orphan sweep uses this). */
export function isPidAlive(pid: number): boolean {
  if (process.platform === "win32") {
    try {
      // `tasklist /FI "PID eq N"` prints a CSV row containing the PID when alive.
      const out = spawnSyncString("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
      return out.includes(`"${pid}"`);
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return code === "EPERM"; // exists but not ours
  }
}

function spawnSyncString(command: string, args: string[]): string {
  const result = spawnSync(command, args, { windowsHide: true, encoding: "utf8" });
  return result.stdout ?? "";
}
