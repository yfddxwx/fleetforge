import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPidAlive } from "@fleetforge/drivers";
import { FleetServer } from "../src/fleet-server.js";
import { gitOk } from "@fleetforge/worktree";

const nodeRequire = createRequire(import.meta.url);
const simEntry = nodeRequire.resolve("@fleetforge/sim-agent");

const dirs: string[] = [];
function track(path: string): string {
  dirs.push(path);
  return path;
}

let stateDir: string;
let repo: string;

beforeAll(async () => {
  stateDir = track(mkdtempSync(join(tmpdir(), "fleetforge-stop-state-")));
  repo = track(mkdtempSync(join(tmpdir(), "fleetforge-stop-repo-")));
  await gitOk(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  await gitOk(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
  await gitOk(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
});

afterAll(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    } catch {
      // Windows TEMP handle races
    }
  }
});

describe("graceful shutdown reaps live agent trees (no orphans)", () => {
  it(
    "server.stop() kills the running agent process tree and leaves no running session",
    { timeout: 90_000 },
    async () => {
      const server = new FleetServer({ dbFile: join(stateDir, "stop.db"), stateDir, port: 0, simEntry });
      await server.start();
      const port = (server.app.server.address() as { port: number }).port;
      const created = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: JSON.stringify({ name: "long-stop", steps: [{ type: "sleep", ms: 60000 }] }),
          agent: "sim",
          repoPath: repo,
        }),
      });
      const taskId = ((await created.json()) as { task: { id: string } }).task.id;

      const deadline = Date.now() + 30_000;
      let pid: number | null = null;
      while (Date.now() < deadline) {
        const session = server.store.sessions.listByStatus("running").find((s) => s.taskId === taskId);
        if (session?.pid) {
          pid = session.pid;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(pid).not.toBeNull();
      expect(isPidAlive(pid as number)).toBe(true);

      await server.stop();

      const reapDeadline = Date.now() + 10_000;
      while (isPidAlive(pid as number) && Date.now() < reapDeadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(isPidAlive(pid as number)).toBe(false);
    },
  );
});
