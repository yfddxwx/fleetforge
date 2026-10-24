import type { AgentDriver, DriverRegistry, DriverSession } from "@fleetforge/drivers";
import { DriverNotInstalledError } from "@fleetforge/drivers";
import type { EventEnvelope, Task } from "@fleetforge/schema";
import { newId } from "@fleetforge/schema";
import type { FleetStore } from "@fleetforge/store";
import type { EventIngestor } from "./ingest.js";

export interface RunResult {
  sessionId: string;
  status: "completed" | "failed" | "cancelled";
  exitCode: number | null;
  error: string | null;
  costUsd: number;
  externalRef: string | null;
}

export interface RunOptions {
  /** Observe every persisted envelope as it happens (WS/CLI streaming). */
  onEvent?: (envelope: EventEnvelope) => void;
  /** Called once the driver session is live (pid assigned). */
  onSessionStart?: (info: { sessionId: string; pid: number | null; driver: AgentDriver }) => void;
  resumeFrom?: string | null;
  /** Heartbeat interval for live sessions. */
  heartbeatMs?: number;
}

/**
 * Executes one task attempt: session row → driver spawn → ingest pump →
 * finalize task/session. The orchestrator's queue (M3) composes around this;
 * this unit only ever runs a single session.
 */
export class SessionRunner {
  private readonly active = new Map<string, DriverSession>();
  private readonly cancelled = new Set<string>();

  constructor(
    private readonly store: FleetStore,
    private readonly ingestor: EventIngestor,
    private readonly registry: DriverRegistry,
  ) {}

  isRunning(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  /** Push an additional instruction into a live session (M4). */
  async followUp(sessionId: string, text: string): Promise<void> {
    const session = this.active.get(sessionId);
    if (!session) throw new Error(`session not running: ${sessionId}`);
    await session.sendFollowUp(text);
    this.ingestor.ingest(sessionId, { kind: "followup", payload: { text } });
  }

  /** Does the driver of this session support follow-ups? */
  followUpCapable(sessionId: string): boolean {
    const session = this.store.sessions.get(sessionId);
    if (!session) return false;
    const driver = this.registry.get(session.driver);
    return driver?.capabilities.followUp === true;
  }

  /** Cancel a live session by sessionId (idempotent, process-tree kill). */
  async cancel(sessionId: string): Promise<void> {
    const session = this.active.get(sessionId);
    if (!session) return;
    this.cancelled.add(sessionId);
    await session.cancel();
  }

  async run(task: Task, options: RunOptions = {}): Promise<RunResult> {
    const now = Date.now();
    const sessionId = newId("sess");

    this.store.sessions.create({
      id: sessionId,
      taskId: task.id,
      driver: task.agent,
      model: task.model ?? null,
      attempt: task.attempt,
      startedAt: now,
    });
    this.store.tasks.update(task.id, {
      status: "running",
      sessionId,
      startedAt: task.startedAt ?? now,
    });

    let driver: AgentDriver;
    try {
      driver = this.registry.require(task.agent);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.finalize(sessionId, task.id, "failed", null, message);
      return {
        sessionId,
        status: "failed",
        exitCode: null,
        error: message,
        costUsd: 0,
        externalRef: null,
      };
    }

    const detect = await driver.detect();
    if (!detect.installed) {
      const error = new DriverNotInstalledError(driver.id, detect.hint ?? "not found");
      this.finalize(sessionId, task.id, "failed", null, error.message);
      return {
        sessionId,
        status: "failed",
        exitCode: null,
        error: error.message,
        costUsd: 0,
        externalRef: null,
      };
    }

    const session = driver.spawn({
      taskId: task.id,
      sessionId,
      prompt: task.prompt,
      cwd: task.worktreePath ?? task.repoPath,
      model: task.model ?? null,
      resumeFrom: options.resumeFrom ?? null,
      env: {
        FLEETFORGE_TASK_ID: task.id,
        FLEETFORGE_SESSION_ID: sessionId,
      },
    });
    this.active.set(sessionId, session);
    this.store.sessions.setPid(sessionId, session.pid);
    options.onSessionStart?.({ sessionId, pid: session.pid, driver });

    const heartbeat = setInterval(
      () => this.store.sessions.heartbeat(sessionId),
      options.heartbeatMs ?? 5000,
    );

    let lastCompleted: { status: "completed" | "failed" | "cancelled"; error: string | null } | null = null;
    let lastLog: string | null = null;

    try {
      for await (const body of session.events) {
        const envelope = this.ingestor.ingest(sessionId, body);
        options.onEvent?.(envelope);
        if (envelope.kind === "session.completed") {
          lastCompleted = {
            status: (envelope.payload as { status: "completed" | "failed" | "cancelled" }).status,
            error: (envelope.payload as { error: string | null }).error,
          };
        } else if (envelope.kind === "session.log") {
          const text = (envelope.payload as { text: string }).text.trim();
          if (text) lastLog = text;
        }
      }
      this.store.sessions.heartbeat(sessionId);
      const externalRef = session.externalRef?.() ?? null;
      if (externalRef) this.store.sessions.setExternalRef(sessionId, externalRef);
    } finally {
      clearInterval(heartbeat);
      this.active.delete(sessionId);
    }

    const exit = await session.whenExit();
    const wasCancelled = this.cancelled.has(sessionId) || lastCompleted?.status === "cancelled";

    let status: "completed" | "failed" | "cancelled";
    if (wasCancelled) {
      status = "cancelled";
    } else if (lastCompleted?.status === "failed") {
      status = "failed";
    } else if (exit.code !== null && exit.code !== 0) {
      status = "failed";
    } else if (lastCompleted === null) {
      // No result line and a null/0 exit code: treat missing completion as failure
      // (crash without wire output), except for pure signal kills already covered above.
      status = exit.code === 0 ? "completed" : "failed";
    } else {
      status = "completed";
    }

    const cost = this.store.sessions.require(sessionId).costUsd;
    const error =
      status === "cancelled"
        ? "cancelled by operator"
        : status === "failed"
          ? (lastCompleted?.error ??
            (lastLog !== null ? `${lastLog} (exit code ${exit.code ?? "null"})` : `process exited with code ${exit.code ?? "null"}`))
          : null;

    this.finalize(sessionId, task.id, status, exit.code, error);
    return { sessionId, status, exitCode: exit.code, error, costUsd: cost, externalRef: session.externalRef?.() ?? null };
  }

  private finalize(
    sessionId: string,
    taskId: string,
    status: "completed" | "failed" | "cancelled",
    exitCode: number | null,
    error: string | null,
  ): void {
    this.store.sessions.complete(sessionId, {
      status,
      exitCode,
      endedAt: Date.now(),
    });
    const taskStatus: Task["status"] =
      status === "completed" ? "review" : status === "cancelled" ? "cancelled" : "failed";
    this.store.tasks.update(taskId, {
      status: taskStatus,
      exitCode,
      error,
      finishedAt: Date.now(),
    });
  }
}
