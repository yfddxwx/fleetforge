import process from "node:process";
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { isPidAlive } from "@fleetforge/drivers";
import { killPidTree } from "../src/kill-pid.js";

/** Small helper: a long-lived child whose PID we can target. */
function spawnSleeper(): { pid: number; exited: Promise<void> } {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return { pid: child.pid as number, exited };
}

describe("killPidTree (orphan reaping primitive)", () => {
  it("reaps a live process and reports true", { timeout: 20_000 }, async () => {
    const sleeper = spawnSleeper();
    expect(isPidAlive(sleeper.pid)).toBe(true);
    const killed = await killPidTree(sleeper.pid);
    expect(killed).toBe(true);
    await sleeper.exited;
    const deadline = Date.now() + 5000;
    while (isPidAlive(sleeper.pid) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(isPidAlive(sleeper.pid)).toBe(false);
  });

  it("returns false for invalid PIDs without throwing", async () => {
    expect(await killPidTree(0)).toBe(false);
    expect(await killPidTree(-5)).toBe(false);
    expect(await killPidTree(Number.NaN)).toBe(false);
  });

  it("returns false for an already-dead PID", { timeout: 20_000 }, async () => {
    const sleeper = spawnSleeper();
    await killPidTree(sleeper.pid);
    await sleeper.exited;
    // second kill: already gone (Windows taskkill exits non-zero; POSIX ESRCH)
    await new Promise((r) => setTimeout(r, 300));
    expect(await killPidTree(sleeper.pid)).toBe(false);
  });
});
