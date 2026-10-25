import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FleetServer } from "../src/fleet-server.js";
import { gitOk } from "@fleetforge/worktree";

const nodeRequire = createRequire(import.meta.url);
const simEntry = nodeRequire.resolve("@fleetforge/sim-agent");

/**
 * Final acceptance replay (docs/ARCHITECTURE.md §8, M8): five tasks against a
 * real repository — three in parallel isolation, one merged after review, one
 * conflicting, one crashing and auto-restarting — then a server kill/restart
 * with state recovery, no orphans, and a consistent board. Runs on CI with the
 * sim agent, no API keys.
 */

const dirs: string[] = [];
function track(path: string): string {
  dirs.push(path);
  return path;
}

let stateDir: string;
let dbFile: string;
let repo: string;

function scenario(steps: unknown[], name: string): string {
  return JSON.stringify({ name, steps });
}

const COMMIT = 'git add -A && git -c user.name=sim -c user.email=sim@sim commit -qm change';

beforeAll(async () => {
  stateDir = track(mkdtempSync(join(tmpdir(), "fleetforge-e2e-state-")));
  dbFile = join(stateDir, "fleet.db");
  repo = track(mkdtempSync(join(tmpdir(), "fleetforge-e2e-repo-")));
  await gitOk(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  writeFileSync(join(repo, "app.txt"), "v1\n");
  await gitOk(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
  await gitOk(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
});

afterAll(async () => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Windows TEMP handle-release races; leftovers are inert
    }
  }
});

async function startServer(): Promise<FleetServer> {
  const server = new FleetServer({ dbFile, stateDir, port: 0, simEntry });
  await server.start();
  return server;
}

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error(`timeout waiting for: ${what}`);
}

describe("final acceptance replay (CI, sim only)", () => {
  it(
    "five-task fleet: parallel isolation, merge, conflict, crash-restart, kill-server recovery",
    { timeout: 300_000 },
    async () => {
      const server = await startServer();
      const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
        const port = (server.app.server.address() as { port: number }).port;
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          method,
          ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
        });
        return { status: response.status, json: (await response.json()) as Record<string, unknown> };
      };

      // --- 1-3: three parallel tasks in isolated worktrees -------------------
      const parallel: Array<{ id: string; file: string }> = [];
      for (let i = 1; i <= 3; i++) {
        const { json } = await api("POST", "/api/tasks", {
          prompt: scenario([
            { type: "say", text: `parallel task ${i}`, chunks: 1 },
            { type: "write", path: `parallel-${i}.txt`, content: `from task ${i}\n` },
            { type: "shell", command: COMMIT },
            { type: "usage", inputTokens: 400 + i * 10, outputTokens: 90 },
          ], `parallel-${i}`),
          agent: "sim",
          repoPath: repo,
        });
        parallel.push({ id: (json["task"] as { id: string }).id, file: `parallel-${i}.txt` });
      }

      // --- 4: merge candidate -------------------------------------------------
      const { json: mergeJson } = await api("POST", "/api/tasks", {
        prompt: scenario([
          { type: "write", path: "shipped.txt", content: "fleet output\n" },
          { type: "shell", command: COMMIT },
          { type: "usage", inputTokens: 500, outputTokens: 120 },
        ], "ship-it"),
        agent: "sim",
        repoPath: repo,
      });
      const mergeTaskId = (mergeJson["task"] as { id: string }).id;

      // --- 5: crash on the first attempt, succeed on the second --------------
      // The shell step counts executions in its worktree (which persists across
      // retries) and fails only the first run: a deterministic crash-restart
      // drill on every platform, no scenario rewriting races.
      const CRASH_ONCE = [
        'node -e "const fs=require(\'fs\');const f=\'attempts.txt\';const n=fs.existsSync(f)?+fs.readFileSync(f,\'utf8\'):0;fs.writeFileSync(f,String(n+1));process.exit(n===0?9:0)"',
      ].join("");
      const crashScenario = JSON.stringify({
        name: "crash-once",
        steps: [
          { type: "say", text: "attempt", chunks: 1 },
          { type: "shell", command: CRASH_ONCE },
          { type: "write", path: "recovered.txt", content: "second attempt\n" },
          { type: "shell", command: COMMIT },
          { type: "usage", inputTokens: 220, outputTokens: 60 },
        ],
      });
      const { json: crashJson } = await api("POST", "/api/tasks", {
        prompt: crashScenario,
        agent: "sim",
        repoPath: repo,
        maxAttempts: 10,
      });
      const crashTaskId = (crashJson["task"] as { id: string }).id;

      // wait for the four normal tasks to settle; the crash task keeps retrying
      await until(
        () => {
          return (
            parallel.every(({ id }) => ["review", "failed"].includes(server.store.tasks.get(id)?.status ?? "?")) &&
            ["review", "failed"].includes(server.store.tasks.get(mergeTaskId)?.status ?? "?")
          );
        },
        120_000,
        "initial four tasks settled",
      );

      // worktrees are distinct and isolated
      const parallelTasks = parallel.map(({ id }) => server.store.tasks.get(id)!);
      expect(new Set(parallelTasks.map((t) => t.worktreePath)).size).toBe(3);
      expect(new Set(parallelTasks.map((t) => t.branch)).size).toBe(3);
      for (const { file } of parallel) {
        // files exist only in their own worktrees, not the main checkout
        expect(existsSync(join(repo, file))).toBe(false);
      }
      // every held lock belongs to an active (queued/running) task — the mutex
      // is released on completion; the crash task legitimately holds its lock
      // while its second attempt is in flight.
      for (const lock of server.store.locks.list()) {
        const status = server.store.tasks.get(lock.taskId)?.status;
        expect(["queued", "running"]).toContain(status);
      }

      // --- review & merge (#4) ------------------------------------------------
      const diff = await api("GET", `/api/tasks/${mergeTaskId}/diff`);
      expect((diff.json["files"] as Array<{ path: string }>).some((f) => f.path === "shipped.txt")).toBe(true);
      expect(diff.json["mergeable"]).toBe(true);

      const merged = await api("POST", `/api/tasks/${mergeTaskId}/merge`, { dryRun: false });
      expect(merged.json["merged"]).toBe(true);
      expect(server.store.tasks.get(mergeTaskId)?.status).toBe("done");
      expect((await gitOk(repo, ["log", "--oneline", "main"])).includes("change")).toBe(true);
      expect(existsSync(join(repo, "shipped.txt"))).toBe(true);

      // --- conflict (#5-adjacent): move base under one parallel task ----------
      const conflictTarget = parallelTasks[2]!;
      writeFileSync(join(repo, "app.txt"), "base-side edit\n");
      await gitOk(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
      await gitOk(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base moved"]);
      // make that task's branch actually touch app.txt so a real conflict occurs
      const wt = conflictTarget.worktreePath!;
      writeFileSync(join(wt, "app.txt"), "task-side edit\n");
      await gitOk(wt, ["-c", "user.name=sim", "-c", "user.email=sim@sim", "add", "-A"]);
      await gitOk(wt, ["-c", "user.name=sim", "-c", "user.email=sim@sim", "commit", "-qm", "task moved"]);

      const conflictResult = await api("POST", `/api/tasks/${conflictTarget.id}/merge`, { dryRun: false });
      expect(conflictResult.status).toBe(409);
      expect(conflictResult.json["conflicts"]).toContain("app.txt");
      expect(server.store.tasks.get(conflictTarget.id)?.status).toBe("conflict");

      // the crash-once scenario fails exactly one attempt, then succeeds
      await until(
        () => {
          const task = server.store.tasks.get(crashTaskId);
          return task?.status === "review" || (task?.attempt ?? 0) >= 10 && task?.status === "failed";
        },
        90_000,
        "crash task retry settled",
      );
      expect(server.store.tasks.get(crashTaskId)?.status).toBe("review");
      expect((server.store.tasks.get(crashTaskId)?.attempt ?? 0)).toBeGreaterThanOrEqual(2);

      // --- cost dashboard ------------------------------------------------------
      const costs = await api("GET", "/api/usage/aggregate?groupBy=agent");
      const simRow = (costs.json["rows"] as Array<{ key: string; inputTokens: number; costUsd: number }>).find((r) => r.key === "sim");
      expect(simRow?.inputTokens).toBeGreaterThan(1000);
      expect(simRow?.costUsd).toBeGreaterThan(0);

      // --- kill the server mid-task, restart, recover --------------------------
      const { json: longJson } = await api("POST", "/api/tasks", {
        prompt: scenario([{ type: "sleep", ms: 60000 }], "long-running"),
        agent: "sim",
        repoPath: repo,
      });
      const longTaskId = (longJson["task"] as { id: string }).id;
      await until(() => server.store.tasks.get(longTaskId)?.status === "running", 30_000, "long task running");

      const liveSession = server.store.sessions.listByStatus("running").find((s) => s.taskId === longTaskId);
      expect(liveSession?.pid).toBeTruthy();

      // simulate a hard kill: writers stop and the DB closes, but the live
      // agent tree is left orphaned in the OS for the next server to reap
      await server.simulateCrash();

      // a fresh server over the same DB recovers state and reaps the orphan
      const revived = await startServer();
      const board = revived.store.tasks.list();
      const longAfter = board.find((t) => t.id === longTaskId);
      expect(longAfter?.attempt).toBe(2); // requeued by restart policy
      // task state is consistent: no task stuck in "running" without a session
      for (const task of board) {
        if (task.status === "running") {
          expect(revived.store.sessions.listByTask(task.id).some((s) => s.status === "running")).toBe(true);
        }
      }
      expect(revived.store.sessions.get(liveSession!.id)?.status).toBe("orphan-killed");

      // clean end: cancel whatever requeued, close revived server
      const port2 = (revived.app.server.address() as { port: number }).port;
      await fetch(`http://127.0.0.1:${port2}/api/tasks/${longTaskId}/cancel`, { method: "POST" });
      await until(() => revived.store.tasks.get(longTaskId)?.status === "cancelled", 30_000, "long task cancelled");
      await revived.stop();
    },
  );
});

describe("ingestion throughput (50 concurrent sessions, no backlog)", () => {
  it(
    "persists a large multi-session burst quickly",
    { timeout: 120_000 },
    async () => {
      const { EventIngestor, } = await import("@fleetforge/orchestrator");
      const { FleetStore } = await import("@fleetforge/store");
      const { PriceBook } = await import("@fleetforge/usage");
      const { newId } = await import("@fleetforge/schema");
      const dbDir = track(mkdtempSync(join(tmpdir(), "fleetforge-load-")));
      const store = new FleetStore(join(dbDir, "fleet.db"));
      const ingestor = new EventIngestor(store, new PriceBook());

      const task = store.tasks.create({
        id: newId("task"),
        title: "load",
        prompt: "p",
        agent: "sim",
        model: null,
        repoPath: repo,
        baseBranch: "main",
        branch: null,
        priority: 0,
        mergeStrategy: "ff",
        maxAttempts: 1,
        createdAt: Date.now(),
      });

      const sessions = Array.from({ length: 50 }, (_, i) => {
        const session = store.sessions.create({ id: `sess_load_${i}`, taskId: task.id, driver: "sim", model: "sim-large", attempt: 1 });
        return session.id;
      });

      const started = Date.now();
      // 50 sessions × 40 events each, interleaved (simulates concurrent pumps)
      const EVENT_COUNT = 40;
      for (let round = 0; round < EVENT_COUNT; round++) {
        for (const sessionId of sessions) {
          if (round === 0) {
            ingestor.ingest(sessionId, { kind: "session.started", payload: { driver: "sim", pid: 1, model: "sim-large", externalRef: null } });
          } else if (round === EVENT_COUNT - 1) {
            ingestor.ingest(sessionId, { kind: "session.completed", payload: { status: "completed", exitCode: 0, error: null } });
          } else {
            ingestor.ingest(sessionId, { kind: "message.delta", payload: { text: `chunk ${round}` } });
            ingestor.ingest(sessionId, { kind: "usage", payload: { model: "sim-large", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } });
          }
        }
      }
      const elapsed = Date.now() - started;

      expect(store.events.count()).toBe(50 * (2 + 2 * (EVENT_COUNT - 2)));
      // 2000 events in well under the watchdog heartbeat window ⇒ no backlog
      expect(elapsed).toBeLessThan(10_000);
      const perSessionCost = store.sessions.get("sess_load_1")?.costUsd ?? 0;
      expect(perSessionCost).toBeGreaterThan(0);
      store.close();
    },
  );
});
