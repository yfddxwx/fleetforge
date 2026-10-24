import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FleetServer } from "../src/fleet-server.js";
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
let repo: string;

beforeAll(async () => {
  const stateDir = track(mkdtempSync(join(tmpdir(), "fleetforge-merge-state-")));
  repo = track(mkdtempSync(join(tmpdir(), "fleetforge-merge-repo-")));
  await gitOk(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  writeFileSync(join(repo, "base.txt"), "base\n");
  await gitOk(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
  await gitOk(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);

  server = new FleetServer({ dbFile: join(stateDir, "fleet.db"), stateDir, port: 0, simEntry });
  await server.start();
  baseUrl = `http://127.0.0.1:${server.app.server.address() !== null && typeof server.app.server.address() === "object" ? (server.app.server.address() as { port: number }).port : 7700}`;
});

afterAll(async () => {
  await server.stop();
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    } catch {
      // Windows TEMP handle races
    }
  }
});

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
  });
  return { status: response.status, json: (await response.json()) as T };
}

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** sim scenario that commits a file change on the task branch (cmd.exe-safe quoting). */
function scenarioWrite(name: string, file: string, content: string): string {
  return JSON.stringify({
    name,
    steps: [
      { type: "write", path: file, content },
      { type: "shell", command: 'git add -A && git -c user.name=sim -c user.email=sim@sim commit -qm "sim change"' },
      { type: "usage", inputTokens: 100, outputTokens: 20 },
    ],
  });
}

async function runTask(prompt: string): Promise<string> {
  const { json } = await api<{ task: { id: string } }>("POST", "/api/tasks", {
    prompt,
    agent: "sim",
    repoPath: repo,
  });
  const id = json.task.id;
  await until(async () => {
    const task = server.store.tasks.get(id);
    return task !== null && ["review", "failed"].includes(task.status);
  }, 30_000);
  if (server.store.tasks.get(id)?.status === "failed") {
    console.log("RUNTASK FAILED:", server.store.tasks.get(id)?.error);
    const tail = server.store.events
      .listByTask(id)
      .filter((e) => e.kind === "session.log" || e.kind === "tool.completed")
      .slice(-5)
      .map((e) => JSON.stringify(e.payload).slice(0, 200));
    console.log(tail.join("|"));
  }
  return id;
}

describe("review & merge API", () => {
  it(
    "diff → dry-run → merge (ff) → task done, worktree reclaimed",
    { timeout: 90_000 },
    async () => {
      const id = await runTask(scenarioWrite("merge-ok", "feature.txt", "shipped\n"));
      const task = server.store.tasks.require(id);
      expect(task.status).toBe("review");
      const worktreePath = task.worktreePath as string;

      const diff = await api<{ files: Array<{ path: string; change: string }>; mergeable: boolean; commits: number; patch: string }>("GET", `/api/tasks/${id}/diff`);
      expect(diff.status).toBe(200);
      expect(diff.json.mergeable).toBe(true);
      expect(diff.json.files.some((f) => f.path === "feature.txt")).toBe(true);
      expect(diff.json.patch).toContain("+shipped");

      // default is dry-run: base must not move
      const dry = await api<{ merged: boolean; dryRun: boolean }>("POST", `/api/tasks/${id}/merge`, {});
      expect(dry.json.dryRun).toBe(true);
      expect(dry.json.merged).toBe(false);
      expect((await gitOk(repo, ["log", "--oneline", "main"])).includes("sim change")).toBe(false);

      // real merge
      const merged = await api<{ merged: boolean; commit: string | null; task: { status: string } }>("POST", `/api/tasks/${id}/merge`, { dryRun: false });
      expect(merged.status).toBe(200);
      expect(merged.json.merged).toBe(true);
      expect(merged.json.commit).toBeTruthy();
      expect(merged.json.task.status).toBe("done");
      expect((await gitOk(repo, ["log", "--oneline", "main"])).includes("sim change")).toBe(true);
      // worktree reclaimed by default
      await until(() => !existsSync(worktreePath), 10_000);
      expect(existsSync(worktreePath)).toBe(false);
    },
  );

  it(
    "squash strategy folds multiple commits into one",
    { timeout: 90_000 },
    async () => {
      const id = await runTask(
        JSON.stringify({
          name: "squash-ok",
          steps: [
            { type: "write", path: "one.txt", content: "1\n" },
            { type: "shell", command: "git add -A && git -c user.name=sim -c user.email=sim@sim commit -qm one" },
            { type: "write", path: "two.txt", content: "2\n" },
            { type: "shell", command: "git add -A && git -c user.name=sim -c user.email=sim@sim commit -qm two" },
          ],
        }),
      );
      const merged = await api<{ merged: boolean; task: { status: string } }>("POST", `/api/tasks/${id}/merge`, {
        dryRun: false,
        strategy: "squash",
      });
      expect(merged.json.merged).toBe(true);
      expect(merged.json.task.status).toBe("done");
      const log = await gitOk(repo, ["log", "--oneline", "main"]);
      expect(log.includes("two")).toBe(false); // task commits folded away
      expect(log).toContain("fleet: merge");
    },
  );

  it(
    "conflict is detected, task marked conflict with guidance",
    { timeout: 120_000 },
    async () => {
      const id = await runTask(scenarioWrite("conflicting", "base.txt", "task version\n"));
      // advance base with a conflicting change to the same file
      await gitOk(repo, ["checkout", "-q", "main"]);
      const tmpf = join(repo, "base.txt");
      writeFileSync(tmpf, "base version\n");
      await gitOk(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
      await gitOk(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base moved"]);

      const result = await api<{ error: string; conflicts: string[]; guidance: string[]; task: { status: string } }>(
        "POST",
        `/api/tasks/${id}/merge`,
        { dryRun: false },
      );
      expect(result.status).toBe(409);
      expect(result.json.conflicts).toContain("base.txt");
      expect(result.json.guidance?.[0]).toContain("cd");
      expect(server.store.tasks.require(id).status).toBe("conflict");
    },
  );

  it(
    "discard requires force when dirty; worktree and branch reclaimed",
    { timeout: 90_000 },
    async () => {
      const id = await runTask(scenarioWrite("dirty", "dirty.txt", "committed\n"));
      const task = server.store.tasks.require(id);
      const worktreePath = task.worktreePath as string;
      const branch = task.branch as string;
      // simulate uncommitted changes the agent left behind
      writeFileSync(join(worktreePath, "uncommitted.txt"), "dirty\n");

      const refused = await api<{ confirmationRequired: boolean }>("POST", `/api/tasks/${id}/discard`, {});
      expect(refused.status).toBe(409);
      expect(refused.json.confirmationRequired).toBe(true);

      const forced = await api<{ task: { status: string }; removedWorktree: boolean; removedBranch: boolean }>(
        "POST",
        `/api/tasks/${id}/discard`,
        { force: true },
      );
      expect(forced.json.task.status).toBe("cancelled");
      expect(forced.json.removedWorktree).toBe(true);
      expect(existsSync(worktreePath)).toBe(false);
      const branchGone = await gitOk(repo, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]).catch(() => "");
      expect(branchGone).toBe("");
    },
  );
});
