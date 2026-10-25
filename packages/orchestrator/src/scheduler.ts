import type { DriverRegistry } from "@fleetforge/drivers";
import { isPidAlive } from "@fleetforge/drivers";
import type { Task } from "@fleetforge/schema";
import type { FleetStore } from "@fleetforge/store";
import { WorktreeManager, WorktreeError } from "@fleetforge/worktree";
import { killPidTree } from "./kill-pid.js";
import { snapshotDescendants } from "./process-tree.js";
import { SessionRunner, type RunResult } from "./runner.js";
import { EventIngestor } from "./ingest.js";

export interface SchedulerOptions {
  maxConcurrent: number;
  maxConcurrentPerRepo: number;
  /** Running sessions older than this without a heartbeat are orphans. */
  heartbeatTimeoutMs: number;
  /** Sweep interval for the watchdog. */
  sweepIntervalMs: number;
  /** How often live sessions' process trees are snapshotted to the DB. */
  treeSnapshotMs: number;
}

export const DEFAULT_SCHEDULER_OPTIONS: SchedulerOptions = {
  maxConcurrent: 4,
  maxConcurrentPerRepo: 3,
  heartbeatTimeoutMs: 30_000,
  sweepIntervalMs: 10_000,
  treeSnapshotMs: 10_000,
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
  private options: SchedulerOptions;
  private readonly runner: SessionRunner;
  private sweepTimer: NodeJS.Timeout | null = null;
  private treeTimer: NodeJS.Timeout | null = null;
  private readonly inflight = new Set<string>();
  private readonly starting = new Set<string>();
  private readonly onEventCallbacks: Array<(taskId: string, envelope: unknown) => void> = [];
  private kicking = false;
  private kickQueued = false;
  private stopped = false;

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
    if (this.stopped) return;
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

  /**
   * Tear down all background writers before the DB closes.
   * `killChildren=false` models a hard crash: live agent trees stay orphaned
   * in the OS so the next server's recover() has something real to reap.
   */
  async stop(options: { killChildren: boolean }): Promise<void> {
    this.stopped = true;
    this.stopWatchdog();
    // let an in-flight kick loop observe the flag
    await new Promise<void>((resolve) => setImmediate(resolve));
    await this.runner.stop(options.killChildren);
  }

  /** Apply concurrency-limit changes from the settings page immediately. */
  updateLimits(limits: { maxConcurrent?: number; maxConcurrentPerRepo?: number }): void {
    if (limits.maxConcurrent !== undefined) this.options.maxConcurrent = limits.maxConcurrent;
    if (limits.maxConcurrentPerRepo !== undefined) this.options.maxConcurrentPerRepo = limits.maxConcurrentPerRepo;
    void this.kick();
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
    if (this.stopped) {
      this.starting.delete(task.id);
      return;
    }
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
        onSessionStart: () => {
          // capture early descendants (tool subprocesses) before a possible crash
          const timer = setTimeout(() => {
            void this.snapshotTrees();
          }, 1200);
          timer.unref?.();
        },
      });
      this.finalizeAfterRun(prepared, result);
    } catch (error) {
      if (!this.stopped) {
        const message = error instanceof Error ? error.message : String(error);
        this.store.tasks.update(task.id, { status: "failed", error: message, finishedAt: Date.now() });
        this.store.locks.releaseByTask(task.id);
      }
    } finally {
      this.starting.delete(task.id);
      this.inflight.delete(task.id);
      void this.kick();
    }
  }

  /** Crash restart policy: requeue while attempts remain, else mark failed. */
  private finalizeAfterRun(task: Task, result: RunResult): void {
    if (this.stopped) return;
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
    if (this.stopped) return [];
    const now = Date.now();
    const reaped: string[] = [];
    for (const session of this.store.sessions.listByStatus("running")) {
      if (now - session.heartbeatAt < this.options.heartbeatTimeoutMs) continue;
      await this.reapSession(session);
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

  /**
   * Kill a session's whole process tree: the recorded token first (when alive)
   * and every descendant captured by the periodic snapshot. The snapshot covers
   * the hard-kill case where the agent CLI died but its tool subprocesses
   * survived (their parents are gone, so `taskkill /T` can't reach them).
   */
  private async reapSession(session: { id: string; pid: number | null }): Promise<void> {
    if (session.pid !== null && isPidAlive(session.pid)) {
      await killPidTree(session.pid);
    }
    for (const descendant of this.store.sessions.getDescendants(session.id)) {
      if (descendant !== session.pid && isPidAlive(descendant)) {
        await killPidTree(descendant);
      }
    }
  }

  /**
   * Persist current process-tree snapshots for all live sessions. Called on a
   * timer so a later server incarnation can reap descendants by recorded PID.
   */
  async snapshotTrees(): Promise<void> {
    if (this.stopped) return;
    const live = this.store.sessions
      .listByStatus("running")
      .filter((session): session is typeof session & { pid: number } => typeof session.pid === "number");
    if (live.length === 0) return;
    const trees = await snapshotDescendants(live.map((session) => session.pid));
    if (this.stopped) return;
    for (const session of live) {
      const descendants = trees.get(session.pid) ?? [];
      const merged = new Set([...this.store.sessions.getDescendants(session.id), ...descendants]);
      this.store.sessions.setDescendants(session.id, [...merged]);
    }
  }

  startWatchdog(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      void this.sweep();
    }, this.options.sweepIntervalMs);
    this.sweepTimer.unref?.();
    this.treeTimer = setInterval(() => {
      void this.snapshotTrees();
    }, this.options.treeSnapshotMs);
    this.treeTimer.unref?.();
  }

  stopWatchdog(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    if (this.treeTimer) {
      clearInterval(this.treeTimer);
      this.treeTimer = null;
    }
  }

  /**
   * Startup reconciliation after a server kill (ADR-0005):
   * live PIDs of "running" sessions are orphaned CLIs — reap them by tree
   * (plus every recorded descendant), mark sessions orphan-killed, then
   * requeue tasks per restart policy.
   */
  async recover(): Promise<{ reaped: string[]; requeued: string[]; failed: string[] }> {
    const reaped: string[] = [];
    const requeued: string[] = [];
    const failed: string[] = [];
    for (const session of this.store.sessions.listByStatus("running")) {
      await this.reapSession(session);
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
