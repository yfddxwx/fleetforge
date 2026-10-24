import process from "node:process";
import { resolve } from "node:path";
import { slugify, newId } from "@fleetforge/schema";
import type { Task } from "@fleetforge/schema";
import { defaultRegistry } from "@fleetforge/drivers";
import { FleetStore } from "@fleetforge/store";
import { PriceBook } from "@fleetforge/usage";
import { EventIngestor, SessionRunner } from "@fleetforge/orchestrator";
import { EventStreamRenderer, supportsColor } from "../render.js";
import { defaultDbPath, defaultStateDir, ensureDir, findSimAgentEntry } from "../paths.js";

export interface TaskNewOptions {
  agent: string;
  repo?: string;
  baseBranch?: string;
  model?: string;
  priority?: number;
  title?: string;
  db?: string;
  yes?: boolean;
}

/**
 * `fleet task new [--agent sim] [--repo path] [--base main] "prompt"`
 * M1 semantics: run the task inline (local session), stream normalized events
 * live to the terminal, persist everything. The server-based path arrives in
 * M4 and reuses the same pipeline.
 */
export async function taskNew(prompt: string, options: TaskNewOptions): Promise<number> {
  const stateDir = ensureDir(defaultStateDir());
  const dbFile = options.db ? options.db : defaultDbPath(stateDir);
  const store = new FleetStore(dbFile);
  const registry = defaultRegistry({ entry: findSimAgentEntry() });

  try {
    const driver = registry.get(options.agent);
    if (!driver) {
      process.stderr.write(`unknown agent "${options.agent}" (available: ${registry.ids().join(", ")})\n`);
      return 2;
    }

    const repoPath = options.repo ? resolve(options.repo) : process.cwd();
    const baseBranch = options.baseBranch ?? (await currentBranch(repoPath));

    const now = Date.now();
    const id = newId("task");
    const firstLine = prompt.split("\n")[0] ?? "";
    const title = options.title ?? (firstLine.slice(0, 80) || "untitled");
    const task: Task = store.tasks.create({
      id,
      title,
      prompt,
      agent: options.agent,
      model: options.model ?? null,
      repoPath,
      baseBranch,
      branch: null,
      priority: options.priority ?? 0,
      mergeStrategy: "ff",
      maxAttempts: 1,
      createdAt: now,
    });

    const colored = supportsColor(process.stdout);
    const renderer = new EventStreamRenderer((line) => process.stdout.write(`${line}\n`), colored);
    process.stdout.write(
      `${colored ? "\x1b[1m" : ""}task ${task.id} · agent ${task.agent} · repo ${repoPath} @ ${baseBranch}${colored ? "\x1b[0m" : ""}\n`,
    );

    const ingestor = new EventIngestor(store, new PriceBook());
    const runner = new SessionRunner(store, ingestor, registry);
    const result = await runner.run(task, { onEvent: (envelope) => renderer.render(envelope) });

    renderer.flushDelta();
    process.stdout.write(
      `\n${colored ? "\x1b[1m" : ""}result: ${result.status}${result.error ? ` — ${result.error}` : ""}${colored ? "\x1b[0m" : ""}\n` +
        `session ${result.sessionId} · cost $${result.costUsd.toFixed(4)} · task status: ${store.tasks.require(task.id).status}\n`,
    );
    return result.status === "completed" ? 0 : 1;
  } finally {
    store.close();
  }
}

async function currentBranch(repoPath: string): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  try {
    const { stdout } = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoPath });
    return stdout.trim() || "main";
  } catch {
    return "main";
  }
}

export function branchNameFor(taskId: string, title: string): string {
  return `fleet/${taskId.replace(/^task_/, "").slice(0, 8)}-${slugify(title)}`;
}
