import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FleetStore } from "../src/index.js";
import { ev } from "@fleetforge/schema";

let dir: string;
let store: FleetStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fleetforge-store-"));
  store = new FleetStore(join(dir, "fleet.db"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeTask(overrides?: { id?: string; repo?: string }) {
  return store.tasks.create({
    id: overrides?.id ?? "task_test1",
    title: "Test task",
    prompt: "do things",
    agent: "sim",
    model: null,
    repoPath: overrides?.repo ?? "D:/tmp/repo-a",
    baseBranch: "main",
    branch: null,
    priority: 0,
    mergeStrategy: "ff",
    maxAttempts: 3,
    createdAt: Date.now(),
  });
}

describe("tasks repo", () => {
  it("creates with defaults and updates", () => {
    const task = makeTask();
    expect(task.status).toBe("backlog");
    expect(task.attempt).toBe(1);
    expect(task.costUsd).toBe(0);

    store.tasks.update(task.id, { status: "running", startedAt: 5 });
    const updated = store.tasks.require(task.id);
    expect(updated.status).toBe("running");
    expect(updated.startedAt).toBe(5);
  });

  it("lists filtered and ordered", () => {
    makeTask({ id: "task_a", repo: "D:/tmp/repo-a" });
    const b = makeTask({ id: "task_b", repo: "D:/tmp/repo-b" });
    store.tasks.update(b.id, { status: "running" });
    const repoB = store.tasks.list({ repoPath: "D:/tmp/repo-b" });
    expect(repoB.map((t) => t.id)).toEqual(["task_b"]);
    expect(store.tasks.list({ status: "running" }).map((t) => t.id)).toEqual(["task_b"]);
  });
});

describe("events repo", () => {
  it("allocates monotonic per-session seq and returns envelopes", () => {
    makeTask();
    store.sessions.create({ id: "sess_1", taskId: "task_test1", driver: "sim", model: null, attempt: 1 });
    store.sessions.create({ id: "sess_2", taskId: "task_test1", driver: "sim", model: null, attempt: 1 });
    const e1 = store.events.ingest("sess_1", "task_test1", ev("session.started", { driver: "sim", pid: 1, model: null, externalRef: null }));
    const e2 = store.events.ingest("sess_1", "task_test1", ev("message.delta", { text: "hi" }));
    const e3 = store.events.ingest("sess_2", "task_test1", ev("message.delta", { text: "other session" }));
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e3.seq).toBe(1); // per session
    expect(e2.schemaVersion).toBe(1);
    expect(store.events.lastSeq("sess_1")).toBe(2);
  });

  it("downgrades invalid payloads to raw instead of throwing", () => {
    makeTask();
    store.sessions.create({ id: "sess_x", taskId: "task_test1", driver: "sim", model: null, attempt: 1 });
    const envelope = store.events.ingest("sess_x", "task_test1", {
      kind: "usage",
      payload: { inputTokens: "bogus" },
    });
    expect(envelope.kind).toBe("raw");
    expect((envelope.payload as { parseError: string }).parseError).toBeTruthy();
  });

  it("rejects unknown kinds via raw as well", () => {
    makeTask();
    store.sessions.create({ id: "sess_y", taskId: "task_test1", driver: "sim", model: null, attempt: 1 });
    const envelope = store.events.ingest("sess_y", "task_test1", { kind: "nope.nope", payload: {} });
    expect(envelope.kind).toBe("raw");
  });

  it("replays history after a seq cursor", () => {
    makeTask();
    store.sessions.create({ id: "sess_z", taskId: "task_test1", driver: "sim", model: null, attempt: 1 });
    for (let i = 0; i < 5; i++) {
      store.events.ingest("sess_z", "task_test1", ev("message.delta", { text: `c${i}` }));
    }
    const replay = store.events.listBySession("sess_z", 2);
    expect(replay.map((e) => e.seq)).toEqual([3, 4, 5]);
  });
});

describe("locks repo", () => {
  it("enforces worktree/branch/task mutual exclusion", () => {
    const lock1 = store.locks.acquire({ worktreePath: "D:/wt/a", branch: "fleet/task-1", taskId: "task_1" });
    expect(lock1).not.toBeNull();

    // different task, same worktree -> blocked
    expect(store.locks.acquire({ worktreePath: "D:/wt/a", branch: "fleet/task-2", taskId: "task_2" })).toBeNull();
    // different task, same branch -> blocked
    expect(store.locks.acquire({ worktreePath: "D:/wt/b", branch: "fleet/task-1", taskId: "task_2" })).toBeNull();

    // same task re-acquiring is idempotent
    const again = store.locks.acquire({ worktreePath: "D:/wt/a", branch: "fleet/task-1", taskId: "task_1" });
    expect(again?.taskId).toBe("task_1");

    // after release, other tasks can take it
    store.locks.releaseByTask("task_1");
    expect(store.locks.acquire({ worktreePath: "D:/wt/a", branch: "fleet/task-1", taskId: "task_2" })).not.toBeNull();
  });

  it("releases stale locks not belonging to running tasks", () => {
    store.locks.acquire({ worktreePath: "D:/wt/a", branch: "fleet/task-1", taskId: "task_1" });
    const released = store.locks.releaseStale(new Set(["task_9"]));
    expect(released).toEqual(["task_1"]);
    expect(store.locks.list()).toEqual([]);
  });
});

describe("session process-tree snapshots", () => {
  it("persists and reads descendant pids", () => {
    makeTask();
    const session = store.sessions.create({ id: "sess_desc", taskId: "task_test1", driver: "sim", model: null, attempt: 1 });
    expect(store.sessions.getDescendants(session.id)).toEqual([]);
    store.sessions.setDescendants(session.id, [111, 222]);
    expect(store.sessions.getDescendants(session.id)).toEqual([111, 222]);
    store.sessions.setDescendants(session.id, [222, 333]);
    expect(store.sessions.getDescendants(session.id)).toEqual([222, 333]);
    expect(store.sessions.getDescendants("sess_missing")).toEqual([]);
  });
});

describe("settings repo", () => {
  it("round-trips JSON values", () => {
    store.settings.set("maxConcurrent", 4);
    expect(store.settings.get<number>("maxConcurrent")).toBe(4);
    store.settings.set("maxConcurrent", 8);
    expect(store.settings.get<number>("maxConcurrent")).toBe(8);
    expect(Object.keys(store.settings.all())).toContain("maxConcurrent");
  });
});

describe("usage repo", () => {
  it("aggregates by group", () => {
    const rows = [
      { id: "u1", sessionId: "s1", taskId: "task_1", driver: "sim", model: "sim-large", inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 0, ts: 1, costUsd: 0.01 },
      { id: "u2", sessionId: "s1", taskId: "task_1", driver: "sim", model: "sim-large", inputTokens: 50, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, ts: 2, costUsd: 0.02 },
    ];
    for (const row of rows) store.usage.record(row);
    const byTask = store.usage.aggregate("task");
    expect(byTask).toEqual([
      { key: "task_1", inputTokens: 150, outputTokens: 15, cacheReadTokens: 5, cacheWriteTokens: 0, costUsd: 0.03, events: 2 },
    ]);
    const byModel = store.usage.aggregate("model");
    expect(byModel[0]?.key).toBe("sim-large");
  });
});
