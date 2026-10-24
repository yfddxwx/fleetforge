import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { defaultRegistry, type DriverRegistry } from "@fleetforge/drivers";
import { newId } from "@fleetforge/schema";
import { FleetStore } from "@fleetforge/store";
import { PriceBook } from "@fleetforge/usage";
import { EventIngestor } from "../src/ingest.js";
import { SessionRunner } from "../src/runner.js";

const require = createRequire(import.meta.url);
let simEntry: string;
try {
  // resolves to fixtures/sim-agent/dist/main.js via the workspace symlink
  simEntry = require.resolve("@fleetforge/sim-agent");
} catch {
  simEntry = "";
}

const dirs: string[] = [];
let store: FleetStore;
let registry: DriverRegistry;
let runner: SessionRunner;
let repoDir: string;

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "fleetforge-run-repo-"));
  dirs.push(repoDir);
  const dbDir = mkdtempSync(join(tmpdir(), "fleetforge-run-db-"));
  dirs.push(dbDir);
  store = new FleetStore(join(dbDir, "fleet.db"));
  registry = defaultRegistry({ entry: simEntry, speed: 0 });
  const ingestor = new EventIngestor(store, new PriceBook());
  runner = new SessionRunner(store, ingestor, registry);
});

afterEach(() => {
  store.close();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

function makeTask(prompt: string, overrides?: { agent?: string }) {
  return store.tasks.create({
    id: newId("task"),
    title: "runner test",
    prompt,
    agent: overrides?.agent ?? "sim",
    model: null,
    repoPath: repoDir,
    baseBranch: "main",
    branch: null,
    priority: 0,
    mergeStrategy: "ff",
    maxAttempts: 1,
    createdAt: Date.now(),
  });
}

describe("SessionRunner (real sim-agent spawn)", () => {
  it("runs a happy-path scenario: events persisted, usage costed, task→review", { timeout: 30000 }, async () => {
    const task = makeTask(
      JSON.stringify({
        name: "happy",
        model: "sim-large",
        steps: [
          { type: "say", text: "working", chunks: 2 },
          { type: "write", path: "out.txt", content: "payload" },
          { type: "usage", inputTokens: 1000, outputTokens: 500 },
          { type: "shell", command: "echo done" },
        ],
      }),
    );

    const envelopes: Array<{ kind: string }> = [];
    const result = await runner.run(task, { onEvent: (e) => envelopes.push(e) });

    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(envelopes[0]?.kind).toBe("session.started");
    expect(envelopes.at(-1)?.kind).toBe("session.completed");
    expect(envelopes.map((e) => e.kind)).toContain("file.changed");
    expect(envelopes.map((e) => e.kind)).toContain("usage");

    // persistence
    const kinds = store.events.listByTask(task.id).map((e) => e.kind);
    expect(kinds[0]).toBe("session.started");
    expect(kinds.at(-1)).toBe("session.completed");

    // usage rollup
    const session = store.sessions.require(result.sessionId);
    expect(session.inputTokens).toBe(1000);
    expect(session.outputTokens).toBe(500);
    expect(session.costUsd).toBeGreaterThan(0);
    expect(store.tasks.require(task.id).costUsd).toBeGreaterThan(0);
    expect(store.tasks.require(task.id).status).toBe("review");
    expect(store.tasks.require(task.id).finishedAt).not.toBeNull();
  });

  it("maps crash to failed with error recorded", { timeout: 30000 }, async () => {
    const task = makeTask(
      JSON.stringify({
        name: "crashy",
        steps: [
          { type: "say", text: "boot" },
          { type: "crash", exitCode: 42, message: "boom" },
        ],
      }),
    );
    const result = await runner.run(task);
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(42);
    const t = store.tasks.require(task.id);
    expect(t.status).toBe("failed");
    expect(t.error).toContain("boom");
    expect(store.sessions.require(result.sessionId).status).toBe("failed");
  });

  it("maps scripted fail to failed", { timeout: 30000 }, async () => {
    const task = makeTask(
      JSON.stringify({
        name: "fails",
        steps: [{ type: "fail", message: "tests red" }],
      }),
    );
    const result = await runner.run(task);
    expect(result.status).toBe("failed");
    expect(store.tasks.require(task.id).error).toContain("tests red");
  });

  it("cancel kills the process tree and marks cancelled", { timeout: 30000 }, async () => {
    const task = makeTask(
      JSON.stringify({
        name: "long",
        steps: [{ type: "sleep", ms: 60000 }],
        followUpSteps: [],
      }),
    );
    let sessionId = "";
    const done = runner.run(task, {
      onSessionStart: (info) => {
        sessionId = info.sessionId;
        void runner.cancel(sessionId);
      },
    });
    const result = await done;
    expect(result.status).toBe("cancelled");
    expect(store.tasks.require(task.id).status).toBe("cancelled");
    expect(store.tasks.require(task.id).finishedAt).not.toBeNull();
  });

  it("unknown driver fails fast with clear error", { timeout: 30000 }, async () => {
    const task = makeTask("anything", { agent: "no-such-driver" });
    const result = await runner.run(task);
    expect(result.status).toBe("failed");
    expect(store.tasks.require(task.id).error).toContain("no-such-driver");
  });
});

describe("EventIngestor", () => {
  it("rejects usage into unknown session", () => {
    expect(() =>
      new EventIngestor(store, new PriceBook()).ingest("sess_missing", {
        kind: "message.delta",
        payload: { text: "x" },
      }),
    ).toThrow(/unknown session/);
  });

  it("downgrades invalid payloads to raw envelopes", () => {
    const task = makeTask("t");
    const session = store.sessions.create({ id: "s_ing", taskId: task.id, driver: "sim", model: null, attempt: 1 });
    const ingestor = new EventIngestor(store, new PriceBook());
    const envelope = ingestor.ingest(session.id, { kind: "usage", payload: { inputTokens: -5 } });
    expect(envelope.kind).toBe("raw");
  });
});
