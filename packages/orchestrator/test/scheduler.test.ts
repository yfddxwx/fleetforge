import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultRegistry, type DriverRegistry } from "@fleetforge/drivers";
import { newId } from "@fleetforge/schema";
import { FleetStore } from "@fleetforge/store";
import { PriceBook } from "@fleetforge/usage";
import { WorktreeManager, gitOk } from "@fleetforge/worktree";
import { EventIngestor } from "../src/ingest.js";
import { Scheduler } from "../src/scheduler.js";

const nodeRequire = createRequire(import.meta.url);
const simEntry = nodeRequire.resolve("@fleetforge/sim-agent");

const dirs: string[] = [];
let repoA: string;
let repoB: string;
let store: FleetStore;
let worktrees: WorktreeManager;
let registry: DriverRegistry;

function trackDir(path: string): string {
  dirs.push(path);
  return path;
}

async function makeRepo(name: string): Promise<string> {
  const repo = trackDir(mkdtempSync(join(tmpdir(), `fleetforge-sched-${name}-`)));
  await gitOk(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  await gitOk(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
  await gitOk(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return repo;
}

function makeScheduler(overrides?: Partial<ConstructorParameters<typeof Scheduler>[4]>) {
  const ingestor = new EventIngestor(store, new PriceBook());
  const scheduler = new Scheduler(store, registry, ingestor, worktrees, {
    maxConcurrent: 2,
    maxConcurrentPerRepo: 1,
    heartbeatTimeoutMs: 15_000,
    sweepIntervalMs: 60_000,
    ...overrides,
  });
  return scheduler;
}

function queueTask(agent: string, prompt: string, repo: string, overrides?: { priority?: number; maxAttempts?: number }) {
  return store.tasks.create({
    id: newId("task"),
    title: prompt.slice(0, 30),
    prompt,
    agent,
    model: null,
    repoPath: repo,
    baseBranch: "main",
    branch: null,
    priority: overrides?.priority ?? 0,
    mergeStrategy: "ff",
    maxAttempts: overrides?.maxAttempts ?? 1,
    createdAt: Date.now(),
  });
}

/** Wait until predicate over the DB holds (poll). */
async function until(predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeEach(async () => {
  const dbDir = trackDir(mkdtempSync(join(tmpdir(), "fleetforge-sched-db-")));
  store = new FleetStore(join(dbDir, "fleet.db"));
  repoA = await makeRepo("a");
  repoB = await makeRepo("b");
  const wtRoot = trackDir(mkdtempSync(join(tmpdir(), "fleetforge-sched-wt-")));
  worktrees = new WorktreeManager(join(wtRoot, "worktrees"));
  registry = defaultRegistry({ entry: simEntry, speed: 0 });
});

afterEach(async () => {
  store.close();
  // give reaped/cancelled child processes a beat to release handles (Windows)
  await new Promise((r) => setTimeout(r, 300));
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    } catch {
      // TEMP leftovers on Windows handle-release races are inert
    }
  }
});

/** Node one-liner "agent": emits schema JSON then sleeps N ms (prompt = N). */
const SLEEPER_SCRIPT = `
console.log(JSON.stringify({kind:"session.log",payload:{stream:"stdout",text:"sleeping {prompt}ms"}}));
setTimeout(()=>{ console.log(JSON.stringify({kind:"message",payload:{role:"assistant",text:"done"}})); }, {prompt});
`;

describe("Scheduler concurrency & isolation", () => {
  it(
    "respects global and per-repo caps; tasks run in isolated worktrees",
    { timeout: 90_000 },
    async () => {
      const shellsRegistry = defaultRegistry({
        entry: simEntry,
        shells: [
          {
            id: "sleeper",
            label: "sleepy",
            config: { command: process.execPath, argsTemplate: ["-e", SLEEPER_SCRIPT.replace(/\{prompt\}/g, "{prompt}")] },
          },
        ],
      });
      registry = shellsRegistry;
      const scheduler = makeScheduler({ maxConcurrent: 2, maxConcurrentPerRepo: 1 });

      const snapshots: Array<{ running: number; perRepo: Map<string, number>; paths: string[] }> = [];
      const stop = setInterval(() => {
        const running = store.tasks.list({ status: "running" });
        const perRepo = new Map<string, number>();
        for (const t of running) perRepo.set(t.repoPath, (perRepo.get(t.repoPath) ?? 0) + 1);
        snapshots.push({
          running: running.length,
          perRepo,
          paths: running.map((t) => `${t.worktreePath}|${t.branch}`),
        });
      }, 40);

      const tasks = [
        queueTask("sleeper", "600", repoA),
        queueTask("sleeper", "600", repoA),
        queueTask("sleeper", "600", repoA),
        queueTask("sleeper", "600", repoB),
        queueTask("sleeper", "600", repoB),
      ];
      for (const task of tasks) scheduler.dispatch(task.id);

      await until(() => store.tasks.list({ status: "backlog" }).length === 0 && store.tasks.list().every((t) => ["review", "done", "failed", "cancelled"].includes(t.status)), 60_000);
      clearInterval(stop);

      // invariants on every sampled snapshot
      for (const snap of snapshots.filter((s) => s.running > 0)) {
        expect(snap.running, "global cap").toBeLessThanOrEqual(2);
        for (const [repo, count] of snap.perRepo) {
          expect(count, `per-repo cap ${repo}`).toBeLessThanOrEqual(1);
        }
        expect(new Set(snap.paths).size, "worktree/branch uniqueness").toBe(snap.paths.length);
      }
      // all five completed
      expect(store.tasks.list().every((t) => t.status === "review")).toBe(true);
      // distinct worktrees per task
      const finished = store.tasks.list();
      expect(new Set(finished.map((t) => t.worktreePath)).size).toBe(5);
    },
  );

  it(
    "property test: random task stream never violates the mutex invariants",
    { timeout: 120_000 },
    async () => {
      const shellsRegistry = defaultRegistry({
        entry: simEntry,
        shells: [{ id: "sleeper", config: { command: process.execPath, argsTemplate: ["-e", SLEEPER_SCRIPT] } }],
      });
      registry = shellsRegistry;
      const scheduler = makeScheduler({ maxConcurrent: 3, maxConcurrentPerRepo: 2 });
      const repos = [repoA, repoB];

      const violations: string[] = [];
      const stop = setInterval(() => {
        const running = store.tasks.list({ status: "running" });
        if (running.length > 3) violations.push(`global ${running.length}`);
        const perRepo = new Map<string, number>();
        const seen = new Set<string>();
        for (const t of running) {
          perRepo.set(t.repoPath, (perRepo.get(t.repoPath) ?? 0) + 1);
          const key = `${t.worktreePath}|${t.branch}`;
          if (seen.has(key)) violations.push(`dup ${key}`);
          seen.add(key);
        }
        for (const [repo, n] of perRepo) if (n > 2) violations.push(`repo ${repo} ${n}`);
      }, 30);

      let seed = 42;
      const rand = () => {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        return seed / 4294967296;
      };
      const tasks: string[] = [];
      for (let i = 0; i < 12; i++) {
        const duration = String(50 + Math.floor(rand() * 400));
        const task = queueTask("sleeper", duration, repos[Math.floor(rand() * 2)] as string, {
          priority: Math.floor(rand() * 5),
        });
        tasks.push(task.id);
        scheduler.dispatch(task.id);
        if (rand() < 0.5) await new Promise((r) => setTimeout(r, Math.floor(rand() * 60)));
      }

      await until(
        () => store.tasks.list().every((t) => ["review", "failed", "cancelled"].includes(t.status)),
        100_000,
      );
      clearInterval(stop);
      expect(violations).toEqual([]);
      expect(store.tasks.list()).toHaveLength(12);
      expect(store.tasks.list().every((t) => t.status === "review")).toBe(true);
      // every task ended with its own worktree & branch, all distinct
      const finished = store.tasks.list();
      expect(new Set(finished.map((t) => t.worktreePath)).size).toBe(12);
      expect(new Set(finished.map((t) => t.branch)).size).toBe(12);
    },
  );

  it(
    "crashed task requeues and succeeds on the next attempt",
    { timeout: 90_000 },
    async () => {
      // scenario file on disk: first run crashes; we rewrite it before the retry
      const scenarioFile = join(trackDir(mkdtempSync(join(tmpdir(), "fleetforge-sc-"))), "s.json");
      const crash = {
        name: "flaky",
        steps: [
          { type: "say", text: "attempting", chunks: 1 },
          { type: "crash", exitCode: 13, message: "simulated crash" },
        ],
      };
      writeFileSync(scenarioFile, JSON.stringify(crash));
      const task = queueTask("sim", `@${scenarioFile}`, repoA, { maxAttempts: 2 });
      const scheduler = makeScheduler();

      scheduler.dispatch(task.id);
      await until(() => store.tasks.require(task.id).attempt === 2 && store.tasks.require(task.id).status === "running", 30_000);

      // rewrite the scenario so the retry succeeds
      writeFileSync(
        scenarioFile,
        JSON.stringify({
          name: "flaky-fixed",
          steps: [
            { type: "write", path: "out.txt", content: "recovered\n" },
            { type: "say", text: "fixed now", chunks: 1 },
            { type: "usage", inputTokens: 10, outputTokens: 5 },
          ],
        }),
      );

      await until(() => ["review", "failed"].includes(store.tasks.require(task.id).status), 30_000);
      const final = store.tasks.require(task.id);
      expect(final.status).toBe("review");
      expect(final.attempt).toBe(2);
      // lock released after success
      expect(store.locks.getByTask(task.id)).toBeNull();
    },
  );

  it(
    "sweep reaps heartbeat-stale sessions by PID tree and requeues",
    { timeout: 60_000 },
    async () => {
      const shellsRegistry = defaultRegistry({
        entry: simEntry,
        shells: [{ id: "sleeper", config: { command: process.execPath, argsTemplate: ["-e", SLEEPER_SCRIPT] } }],
      });
      registry = shellsRegistry;
      const scheduler = makeScheduler({ heartbeatTimeoutMs: 200, sweepIntervalMs: 60_000 });
      const task = queueTask("sleeper", "30000", repoA, { maxAttempts: 2 });
      scheduler.dispatch(task.id);

      await until(() => store.tasks.require(task.id).status === "running", 15_000);
      const session = store.sessions.require(store.tasks.require(task.id).sessionId as string);

      // forge a stale heartbeat, then sweep manually
      store.db.prepare("UPDATE sessions SET heartbeat_at = ? WHERE id = ?").run(Date.now() - 10_000, session.id);
      const reaped = await scheduler.sweep();

      expect(reaped).toContain(session.id);
      // task requeued (attempt 2)
      const t = store.tasks.require(task.id);
      expect(["queued", "running"]).toContain(t.status);
      expect(t.attempt).toBe(2);
      // reaped session marked orphan-killed
      expect(store.sessions.require(session.id).status).toBe("orphan-killed");
      // cancel the retried attempt to end the test cleanly
      await scheduler.cancel(task.id);
      await until(() => store.tasks.require(task.id).status === "cancelled", 15_000);
    },
  );

  it(
    "recover(): after a server kill, orphans are reaped and tasks requeued",
    { timeout: 60_000 },
    async () => {
      const shellsRegistry = defaultRegistry({
        entry: simEntry,
        shells: [{ id: "sleeper", config: { command: process.execPath, argsTemplate: ["-e", SLEEPER_SCRIPT] } }],
      });
      registry = shellsRegistry;
      const scheduler = makeScheduler();
      const task = queueTask("sleeper", "60000", repoA, { maxAttempts: 2 });
      scheduler.dispatch(task.id);
      await until(() => store.tasks.require(task.id).status === "running", 15_000);
      const session = store.sessions.require(store.tasks.require(task.id).sessionId as string);

      // simulate the server dying: stop watchdog/scheduler, no graceful cancel
      scheduler.stopWatchdog();
      const fresh = makeScheduler();
      const report = await fresh.recover();

      expect(report.reaped).toContain(session.id);
      expect(store.sessions.require(session.id).status).toBe("orphan-killed");
      expect(report.requeued).toContain(task.id);
      expect(store.tasks.require(task.id).attempt).toBe(2);
      // the requeued task restarts; cancel it to end the test
      await until(() => store.tasks.require(task.id).status === "running", 15_000);
      await fresh.cancel(task.id);
      await until(() => store.tasks.require(task.id).status === "cancelled", 15_000);
      expect(store.locks.list()).toEqual([]);
    },
  );

  it("tasks on empty repos fail fast with a clear error", async () => {
    const empty = trackDir(mkdtempSync(join(tmpdir(), "fleetforge-empty-")));
    await gitOk(empty, ["init", "-q", "-b", "main"]);
    const scheduler = makeScheduler();
    const task = queueTask("sim", "hello", empty);
    scheduler.dispatch(task.id);
    await until(() => store.tasks.require(task.id).status === "failed", 15_000);
    expect(store.tasks.require(task.id).error).toContain("no commits");
  });
});
