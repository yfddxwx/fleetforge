import type { Database } from "./db.js";

/** worktree/branch/task mutual exclusion — the hard DB-level constraint (ADR-0003). */
export interface WorktreeLock {
  worktreePath: string;
  branch: string;
  taskId: string;
  acquiredAt: number;
}

export class LockRepo {
  constructor(private readonly db: Database) {}

  private toLock(row: { worktree_path: string; branch: string; task_id: string; acquired_at: number }): WorktreeLock {
    return {
      worktreePath: row.worktree_path,
      branch: row.branch,
      taskId: row.task_id,
      acquiredAt: row.acquired_at,
    };
  }

  /**
   * Acquire the worktree+branch lock for a task. Returns null when any of the
   * three keys is already held by a *different* running task.
   * Runs inside BEGIN IMMEDIATE — the UNIQUE constraints are the mutex.
   */
  acquire(lock: Omit<WorktreeLock, "acquiredAt">): WorktreeLock | null {
    const acquire = this.db.transaction((): WorktreeLock | null => {
      const conflicting = this.db
        .prepare(
          `SELECT * FROM worktree_locks
           WHERE (worktree_path = ? OR branch = ? OR task_id = ?) AND task_id != ?`,
        )
        .get(lock.worktreePath, lock.branch, lock.taskId, lock.taskId) as
        | { worktree_path: string; branch: string; task_id: string; acquired_at: number }
        | undefined;
      if (conflicting) return null;
      const existing = this.db
        .prepare("SELECT * FROM worktree_locks WHERE task_id = ?")
        .get(lock.taskId) as
        | { worktree_path: string; branch: string; task_id: string; acquired_at: number }
        | undefined;
      if (existing) return this.toLock(existing);
      this.db
        .prepare(
          `INSERT INTO worktree_locks (worktree_path, branch, task_id, acquired_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(lock.worktreePath, lock.branch, lock.taskId, Date.now());
      return { ...lock, acquiredAt: Date.now() };
    });
    return acquire();
  }

  releaseByTask(taskId: string): boolean {
    const result = this.db.prepare("DELETE FROM worktree_locks WHERE task_id = ?").run(taskId);
    return result.changes > 0;
  }

  getByTask(taskId: string): WorktreeLock | null {
    const row = this.db
      .prepare("SELECT * FROM worktree_locks WHERE task_id = ?")
      .get(taskId) as
      | { worktree_path: string; branch: string; task_id: string; acquired_at: number }
      | undefined;
    return row ? this.toLock(row) : null;
  }

  list(): WorktreeLock[] {
    const rows = this.db
      .prepare("SELECT * FROM worktree_locks ORDER BY acquired_at ASC")
      .all() as Array<{ worktree_path: string; branch: string; task_id: string; acquired_at: number }>;
    return rows.map((row) => this.toLock(row));
  }

  /** Startup reconciliation: locks whose task is not running anymore are stale. */
  releaseStale(runningTaskIds: Set<string>): string[] {
    const released: string[] = [];
    const remove = this.db.prepare("DELETE FROM worktree_locks WHERE task_id = ?");
    for (const lock of this.list()) {
      if (!runningTaskIds.has(lock.taskId)) {
        remove.run(lock.taskId);
        released.push(lock.taskId);
      }
    }
    return released;
  }
}
