import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { FleetServer, type WsFrame } from "../src/fleet-server.js";
import { gitOk } from "@fleetforge/worktree";

const nodeRequire = createRequire(import.meta.url);
const simEntry = nodeRequire.resolve("@fleetforge/sim-agent");

const dirs: string[] = [];
function track(path: string): string {
  dirs.push(path);
  return path;
}

let server: FleetServer;
let baseUrl: string;
let wsUrl: string;
let repo: string;
const frames: WsFrame[] = [];
let socket: WebSocket;

beforeAll(async () => {
  const stateDir = track(mkdtempSync(join(tmpdir(), "fleetforge-srv-state-")));
  repo = track(mkdtempSync(join(tmpdir(), "fleetforge-srv-repo-")));
  await gitOk(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  await gitOk(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
  await gitOk(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);

  server = new FleetServer({
    dbFile: join(stateDir, "fleet.db"),
    stateDir,
    port: 0,
    simEntry,
    onFrame: (frame) => frames.push(frame),
  });
  const { port } = await server.start();
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
  socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
});

afterAll(async () => {
  socket.close();
  await server.stop();
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    } catch {
      // Windows TEMP handle races
    }
  }
});

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
  });
  return (await response.json()) as T;
}

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

function nextWsMessage(): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>));
  });
}

/** Consume WS messages until one matches (event frames interleave freely). */
function waitForWs(
  match: (msg: Record<string, unknown>) => boolean,
  timeoutMs: number,
  sock: WebSocket = socket,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("waitForWs timeout")), timeoutMs);
    const onMessage = (data: import("ws").RawData): void => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (match(msg)) {
        clearTimeout(timer);
        sock.removeListener("message", onMessage);
        resolve(msg);
      }
    };
    sock.on("message", onMessage);
  });
}

describe("FleetServer REST + WS", () => {
  it("hello frame on connect", async () => {
    const fresh = new WebSocket(wsUrl);
    const hello = await new Promise<Record<string, unknown>>((resolve) => {
      fresh.once("message", (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>));
    });
    expect(hello["type"]).toBe("hello");
    fresh.close();
  });

  it(
    "creates + dispatches a task; WS streams events; transcript aggregates",
    { timeout: 60_000 },
    async () => {
      const created = await api<{ task: { id: string } }>("POST", "/api/tasks", {
        prompt: JSON.stringify({
          name: "srv-e2e",
          steps: [
            { type: "say", text: "working via server", chunks: 2 },
            { type: "write", path: "hello.txt", content: "from server\n" },
            { type: "usage", inputTokens: 500, outputTokens: 120 },
          ],
        }),
        agent: "sim",
        repoPath: repo,
        maxAttempts: 1,
      });
      const taskId = created.task.id;
      expect(taskId).toBeTruthy();

      await until(async () => {
        const detail = await server.store.tasks.get(taskId);
        return detail !== null && ["review", "done", "failed"].includes(detail.status);
      }, 30_000);

      const detail = await api<{ task: { status: string; worktreePath: string | null; branch: string | null; costUsd: number } }>("GET", `/api/tasks/${taskId}`);
      expect(detail.task.status).toBe("review");
      expect(detail.task.worktreePath).toContain("worktrees");
      expect(detail.task.branch).toMatch(/^fleet\//);
      expect(detail.task.costUsd).toBeGreaterThan(0);

      // events replay API
      const { events } = await api<{ events: Array<{ kind: string }> }>("GET", `/api/tasks/${taskId}/events`);
      expect(events[0]?.kind).toBe("session.started");
      expect(events.at(-1)?.kind).toBe("session.completed");
      expect(events.map((e) => e.kind)).toContain("file.changed");

      // WS broadcast captured via onFrame
      const eventFrames = frames.filter((f) => f.type === "event");
      expect(eventFrames.length).toBeGreaterThan(0);

      // transcript
      const transcript = await api<{ lines: Array<{ role: string }> }>("GET", `/api/tasks/${taskId}/transcript`);
      expect(transcript.lines.some((line) => line.role === "assistant")).toBe(true);
      expect(transcript.lines.some((line) => line.role === "tool")).toBe(true);
    },
  );

  it(
    "follow-up over WS reaches a running sim session",
    { timeout: 60_000 },
    async () => {
      const created = await api<{ task: { id: string } }>("POST", "/api/tasks", {
        prompt: JSON.stringify({
          name: "followup-srv",
          steps: [{ type: "sleep", ms: 8000 }],
          followUpSteps: [{ type: "say", text: "follow-up ack", chunks: 1 }],
        }),
        agent: "sim",
        repoPath: repo,
      });
      const taskId = created.task.id;

      await until(async () => (await server.store.tasks.get(taskId))?.status === "running", 15_000);

      socket.send(JSON.stringify({ type: "followup", taskId, text: "status?" }));
      // event frames may interleave; wait for the notification specifically
      const notification = await waitForWs((msg) => msg["type"] === "notification", 15_000);
      expect(notification["type"]).toBe("notification");

      await until(
        () => server.store.events.listByTask(taskId).some((e) => e.kind === "followup"),
        15_000,
      );
      await until(
        () => server.store.events.listByTask(taskId).some((e) => e.kind === "message"),
        15_000,
      );

      // REST follow-up endpoint on a non-follow-up driver path is covered by
      // cancel below; end this task cleanly.
      await api("POST", `/api/tasks/${taskId}/cancel`);
      await until(async () => (await server.store.tasks.get(taskId))?.status === "cancelled", 15_000);
    },
  );

  it("rejects follow-ups for tasks without a running session", async () => {
    const created = await api<{ task: { id: string } }>("POST", "/api/tasks", {
      prompt: "x",
      agent: "sim",
      repoPath: repo,
      dispatch: false,
    });
    const response = await fetch(`${baseUrl}/api/tasks/${created.task.id}/followup`, {
      method: "POST",
      body: JSON.stringify({ text: "hello" }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(409);
  });

  it("agents endpoint reports capability matrix and usage aggregates", async () => {
    const { agents } = await api<{ agents: Array<{ driverId: string; installed: boolean; capabilities: Record<string, boolean> }> }>("GET", "/api/agents");
    const sim = agents.find((a) => a.driverId === "sim");
    expect(sim?.installed).toBe(true);
    expect(sim?.capabilities.followUp).toBe(true);

    const usage = await api<{ rows: Array<{ key: string; inputTokens: number }> }>("GET", "/api/usage/aggregate?groupBy=agent");
    expect(usage.rows.some((row) => row.key === "sim" && row.inputTokens > 0)).toBe(true);
  });

  it("settings round-trip and doctor endpoint", async () => {
    await api("PUT", "/api/settings", { maxConcurrent: 5 });
    const { settings } = await api<{ settings: Record<string, unknown> }>("GET", "/api/settings");
    expect(settings["maxConcurrent"]).toBe(5);

    const doctor = await api<{ healthy: boolean; drivers: Array<{ driverId: string }> }>("GET", "/api/doctor");
    expect(doctor.healthy).toBe(true);
    expect(doctor.drivers.map((d) => d.driverId)).toContain("sim");
  });
});
