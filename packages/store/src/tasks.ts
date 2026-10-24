import type { Database } from "./db.js";
import type { Task, TaskStatus } from "@fleetforge/schema";

interface TaskRow {
  id: string;
  title: string;
  prompt: string;
  agent: string;
  model: string | null;
  repo_path: string;
  base_branch: string;
  branch: string | null;
  worktree_path: string | null;
  priority: number;
  status: string;
  merge_strategy: string;
  max_attempts: number;
  attempt: number;
  session_id: string | null;
  cost_usd: number;
  exit_code: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    agent: row.agent,
    ...(row.model !== null ? { model: row.model } : {}),
    repoPath: row.repo_path,
    baseBranch: row.base_branch,
    branch: row.branch,
    worktreePath: row.worktree_path,
    priority: row.priority,
    status: row.status as TaskStatus,
    mergeStrategy: row.merge_strategy as Task["mergeStrategy"],
    maxAttempts: row.max_attempts,
    attempt: row.attempt,
    sessionId: row.session_id,
    costUsd: row.cost_usd,
    exitCode: row.exit_code,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export interface NewTaskInput {
  id: string;
  title: string;
  prompt: string;
  agent: string;
  model: string | null;
  repoPath: string;
  baseBranch: string;
  branch: string | null;
  priority: number;
  mergeStrategy: Task["mergeStrategy"];
  maxAttempts: number;
  createdAt: number;
}

/** Task persistence. Status transitions are enforced by callers (orchestrator). */
export class TaskRepo {
  constructor(private readonly db: Database) {}

  create(input: NewTaskInput): Task {
    this.db
      .prepare(
        `INSERT INTO tasks (id, title, prompt, agent, model, repo_path, base_branch, branch,
           priority, status, merge_strategy, max_attempts, attempt, cost_usd, created_at, updated_at)
         VALUES (@id, @title, @prompt, @agent, @model, @repoPath, @baseBranch, @branch,
           @priority, 'backlog', @mergeStrategy, @maxAttempts, 1, 0, @createdAt, @createdAt)`,
      )
      .run({
        id: input.id,
        title: input.title,
        prompt: input.prompt,
        agent: input.agent,
        model: input.model,
        repoPath: input.repoPath,
        baseBranch: input.baseBranch,
        branch: input.branch,
        priority: input.priority,
        mergeStrategy: input.mergeStrategy,
        maxAttempts: input.maxAttempts,
        createdAt: input.createdAt,
      });
    return this.get(input.id) as Task;
  }

  get(id: string): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  require(id: string): Task {
    const task = this.get(id);
    if (!task) throw new Error(`task not found: ${id}`);
    return task;
  }

  list(filter?: { status?: TaskStatus; repoPath?: string }): Task[] {
    const clauses: string[] = [];
    const params: Record<string, string> = {};
    if (filter?.status) {
      clauses.push("status = @status");
      params.status = filter.status;
    }
    if (filter?.repoPath) {
      clauses.push("repo_path = @repoPath");
      params.repoPath = filter.repoPath;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks ${where}
         ORDER BY (status = 'running') DESC, priority DESC, created_at ASC`,
      )
      .all(params) as TaskRow[];
    return rows.map(rowToTask);
  }

  update(id: string, patch: Partial<Pick<Task, "status" | "sessionId" | "branch" | "worktreePath" | "exitCode" | "error" | "costUsd" | "attempt" | "startedAt" | "finishedAt">>): void {
    const sets: string[] = ["updated_at = @updatedAt"];
    const params: Record<string, string | number | null> = { id, updatedAt: Date.now() };
    if (patch.status !== undefined) {
      sets.push("status = @status");
      params.status = patch.status;
    }
    if (patch.sessionId !== undefined) {
      sets.push("session_id = @sessionId");
      params.sessionId = patch.sessionId;
    }
    if (patch.branch !== undefined) {
      sets.push("branch = @branch");
      params.branch = patch.branch;
    }
    if (patch.worktreePath !== undefined) {
      sets.push("worktree_path = @worktreePath");
      params.worktreePath = patch.worktreePath;
    }
    if (patch.exitCode !== undefined) {
      sets.push("exit_code = @exitCode");
      params.exitCode = patch.exitCode;
    }
    if (patch.error !== undefined) {
      sets.push("error = @error");
      params.error = patch.error;
    }
    if (patch.costUsd !== undefined) {
      sets.push("cost_usd = @costUsd");
      params.costUsd = patch.costUsd;
    }
    if (patch.attempt !== undefined) {
      sets.push("attempt = @attempt");
      params.attempt = patch.attempt;
    }
    if (patch.startedAt !== undefined) {
      sets.push("started_at = @startedAt");
      params.startedAt = patch.startedAt;
    }
    if (patch.finishedAt !== undefined) {
      sets.push("finished_at = @finishedAt");
      params.finishedAt = patch.finishedAt;
    }
    this.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = @id`).run(params);
  }

  /** Add delta to the rolled-up task cost (usage ingest). */
  addCost(id: string, deltaUsd: number): void {
    this.db
      .prepare("UPDATE tasks SET cost_usd = cost_usd + ?, updated_at = ? WHERE id = ?")
      .run(deltaUsd, Date.now(), id);
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  }
}
