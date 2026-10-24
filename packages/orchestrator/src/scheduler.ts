import type { DriverRegistry } from "@fleetforge/drivers";
import { isPidAlive } from "@fleetforge/drivers";
import type { Task } from "@fleetforge/schema";
import type { FleetStore } from "@fleetforge/store";
import { WorktreeManager, WorktreeError } from "@fleetforge/worktree";
import { killPidTree } from "./kill-pid.js";
import { SessionRunner, type RunResult } from "./runner.js";
import { EventIngestor } from "./ingest.js";

export interface SchedulerOptions {
  maxConcurrent: number;
  maxConcurrentPerRepo: number;
  /** Running sessions older than this without a heartbeat are orphans. */
  heartbeatTimeoutMs: number;
  /** Sweep interval for the watchdog. */
  sweepIntervalMs: number;
}

export const DEFAULT_SCHEDULER_OPTIONS: SchedulerOptions = {
  maxConcurrent: 3,
  maxConcurrentPerRepo: 2,
  heartbeatTimeoutMs: 30_000,
  sweepIntervalMs: 10_000,
};

export interface DispatchOutcome {
  taskId: string;
  status: Task["status"];
  reason?: string;
}

/**
 * The fleet scheduler (ADR-0003/0004/0005):
 *  - priority queue over `queued` tasks, two-tier concurrency caps
 *  - per-task worktree + branch, guarded by the DB-level mutex
 *  - crash restart policy: failed && attempt < maxAttempts → requeue
 *  - watchdog sweep: heartbeat-stale sessions are reaped by PID tree
 *  - recover(): startup reconciliation after a server kill
 */
export class Scheduler {
  private readonly options: SchedulerOptions;
  private readonly runner: SessionRunner;
  private sweepTimer: NodeJS.Timeout | null = null;
  private readonly inflight = new Set<string>();
  private readonly starting = new Set<string>();
  private readonly onEventCallbacks: Array<(taskId: string, envelope: unknown) => void> = [];
  private kicking = false;
  private kickQueued = false;

  constructor(
    private readonly store: FleetStore,
    registry: DriverRegistry,
    ingestor: EventIngestor,
    private readonly worktrees: WorktreeManager,
    options?: Partial<SchedulerOptions>,
  ) {
    this.options = { ...DEFAULT_SCHEDULER_OPTIONS, ...options };
    this.runner = new SessionRunner(store, ingestor, registry);
  }

  /** Expose follow-up capability checks to the API layer. */
  runnerFollowUpCapable(sessionId: string): boolean {
    return this.runner.followUpCapable(sessionId);
  }

  /** Subscribe to live envelopes for WS fan-out (M4). */
  onEvent(cb: (taskId: string, envelope: unknown) => void): void {
    this.onEventCallbacks.push(cb);
  }

  /** Queue a backlog (or re-queue a finished) task and try to start it. */
  dispatch(taskId: string): DispatchOutcome {
    const task = this.store.tasks.get(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (task.status === "running") {
      return { taskId, status: task.status, reason: "already running" };
    }
    this.store.tasks.update(taskId, { status: "queued" });
    void this.kick();
    return { taskId, status: "queued" };
  }

  /** Cancel a queued/running task (process-tree kill). */
  async cancel(taskId: string): Promise<void> {
    const task = this.store.tasks.get(taskId);
    if (!task) return;
    if (task.sessionId && this.runner.isRunning(task.sessionId)) {
      await this.runner.cancel(task.sessionId);
      return; // runner finalizes task state on session end
    }
    this.store.tasks.update(taskId, { status: "cancelled", finishedAt: Date.now() });
    this.store.locks.releaseByTask(taskId);
  }

  /**
   * Send a follow-up instruction to a running task's session.
   * Returns false when the task isn't running or its driver can't accept it.
   */
  async followUp(taskId: string, text: string): Promise<{ sent: boolean; reason?: string }> {
    const task = this.store.tasks.get(taskId);
    if (!task?.sessionId) return { sent: false, reason: "task has no session" };
    if (!this.runner.isRunning(task.sessionId)) return { sent: false, reason: "session not running" };
    if (!this.runner.followUpCapable(task.sessionId)) {
      return { sent: false, reason: "driver does not support mid-session follow-ups" };
    }
    await this.runner.followUp(task.sessionId, text);
    return { sent: true };
  }

  /** Try to start queued tasks while capacity allows. */
  async kick(): Promise<void> {
    if (this.kicking) {
      this.kickQueued = true;
      return;
    }
    this.kicking = true;
    try {
      await this.startEligible();
    } finally {
      this.kicking = false;
      if (this.kickQueued) {
        this.kickQueued = false;
        void this.kick();
      }
    }
  }

  private async startEligible(): Promise<void> {
    const queued = this.store.tasks
      .list({ status: "queued" })
      .filter((task) => !this.inflight.has(task.id) && !this.starting.has(task.id));
    for (const task of queued) {
      if (this.effectiveRunning() >= this.options.maxConcurrent) return;
      if (this.effectiveRunningForRepo(task.repoPath) >= this.options.maxConcurrentPerRepo) continue;
      this.starting.add(task.id);
      void this.prepareAndRun(task);
    }
  }

  /** Tasks already running plus tasks currently being prepared. */
  private effectiveRunning(): number {
    return this.store.tasks.list({ status: "running" }).length + this.starting.size;
  }

  private effectiveRunningForRepo(repoPath: string): number {
    return (
      this.store.tasks.list({ status: "running", repoPath }).filter((t) => !this.starting.has(t.id)).length +
      [...this.starting].filter((id) => this.store.tasks.get(id)?.repoPath === repoPath).length
    );
  }

  /** Create worktree + acquire the DB lock, then run the session (parallel). */
  private async prepareAndRun(task: Task): Promise<void> {
    try {
      let prepared = task;
      if (!task.worktreePath || !task.branch) {
        try {
          const handle = await this.worktrees.create({
            taskId: task.id,
            title: task.title,
            repoPath: task.repoPath,
            baseBranch: task.baseBranch,
          });
          this.store.tasks.update(task.id, { worktreePath: handle.path, branch: handle.branch });
          prepared = this.store.tasks.require(task.id);
        } catch (error) {
          if (error instanceof WorktreeError && (error.code === "no-commits" || error.code === "base-missing")) {
            this.store.tasks.update(task.id, {
              status: "failed",
              error: error.message,
              finishedAt: Date.now(),
            });
            return;
          }
          throw error;
        }
      }
      const lock = this.store.locks.acquire({
        worktreePath: prepared.worktreePath as string,
        branch: prepared.branch as string,
        taskId: prepared.id,
      });
      if (!lock) {
        // someone else holds the worktree/branch — stay queued, retry later
        return;
      }

      this.inflight.add(task.id);
      const result = await this.runner.run(prepared, {
        onEvent: (envelope) => {
          for (const cb of this.onEventCallbacks) cb(prepared.id, envelope);
        },
      });
      this.finalizeAfterRun(prepared, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.tasks.update(task.id, { status: "failed", error: message, finishedAt: Date.now() });
      this.store.locks.releaseByTask(task.id);
    } finally {
      this.starting.delete(task.id);
      this.inflight.delete(task.id);
      void this.kick();
    }
  }

  /** Crash restart policy: requeue while attempts remain, else mark failed. */
  private finalizeAfterRun(task: Task, result: RunResult): void {
    this.store.locks.releaseByTask(task.id);
    if (result.status === "failed" && task.attempt < task.maxAttempts) {
      const attempt = task.attempt + 1;
      this.store.tasks.update(task.id, {
        status: "queued",
        attempt,
        error: `attempt ${task.attempt} failed (${result.error ?? "unknown"}); requeueing`,
      });
      void this.kick();
    }
  }

  /**
   * Watchdog: running sessions with stale heartbeats are killed by PID tree
   * and their tasks requeued per policy. Returns reaped session ids.
   */
  async sweep(): Promise<string[]> {
    const now = Date.now();
    const reaped: string[] = [];
    for (const session of this.store.sessions.listByStatus("running")) {
      if (now - session.heartbeatAt < this.options.heartbeatTimeoutMs) continue;
      if (session.pid !== null && isPidAlive(session.pid)) {
        await killPidTree(session.pid);
      }
      this.store.sessions.complete(session.id, {
        status: "orphan-killed",
        exitCode: null,
        endedAt: now,
      });
      const task = this.store.tasks.get(session.taskId);
      this.store.tasks.update(session.taskId, {
        status: "failed",
        error: `heartbeat stale >${this.options.heartbeatTimeoutMs}ms; session reaped`,
        finishedAt: now,
      });
      this.store.locks.releaseByTask(session.taskId);
      reaped.push(session.id);
      if (task && task.attempt < task.maxAttempts) {
        this.store.tasks.update(session.taskId, {
          status: "queued",
          attempt: task.attempt + 1,
        });
        void this.kick();
      }
    }
    return reaped;
  }

  startWatchdog(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      void this.sweep();
    }, this.options.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  stopWatchdog(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /**
   * Startup reconciliation after a server kill (ADR-0005):
   * live PIDs of "running" sessions are orphaned CLIs — reap them by tree,
   * mark sessions orphan-killed, then requeue tasks per restart policy.
   */
  async recover(): Promise<{ reaped: string[]; requeued: string[]; failed: string[] }> {
    const reaped: string[] = [];
    const requeued: string[] = [];
    const failed: string[] = [];
    for (const session of this.store.sessions.listByStatus("running")) {
      if (session.pid !== null && isPidAlive(session.pid)) {
        await killPidTree(session.pid);
      }
      this.store.sessions.complete(session.id, {
        status: "orphan-killed",
        exitCode: null,
        endedAt: Date.now(),
      });
      reaped.push(session.id);
    }
    for (const task of this.store.tasks.list({ status: "running" })) {
      if (task.attempt < task.maxAttempts) {
        this.store.tasks.update(task.id, { status: "queued", attempt: task.attempt + 1 });
        requeued.push(task.id);
      } else {
        this.store.tasks.update(task.id, {
          status: "failed",
          error: "server restarted; no attempts left",
          finishedAt: Date.now(),
        });
        failed.push(task.id);
      }
      this.store.locks.releaseByTask(task.id);
    }
    // locks for tasks that are no longer running are stale by definition
    this.store.locks.releaseStale(new Set(this.store.tasks.list({ status: "running" }).map((t) => t.id)));
    void this.kick();
    return { reaped, requeued, failed };
  }
}
