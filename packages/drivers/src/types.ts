import type { AgentEventBody } from "@fleetforge/schema";

/**
 * AgentDriver — the unified interface every coding-agent CLI driver implements.
 * (Design rationale: docs/adr/0002-driver-interface.md)
 *
 * Contract:
 *  - `spawn()` launches the CLI with structured JSON output enabled and returns
 *    a live session. No pseudo-terminals, no screen scraping — wire lines only.
 *  - The session's `events` async iterable yields schema-normalized events;
 *    unparsable wire lines are surfaced as `raw` events, never dropped.
 *  - Exactly one `session.started` is emitted first and one `session.completed`
 *    last; drivers synthesize them when the CLI does not.
 *  - `cancel()` must terminate the whole OS process tree (Windows-safe).
 */

export interface DriverCapabilities {
  /** `driver.resume()` / `--resume` style continuation of a prior session. */
  resume: boolean;
  /** Can push an additional instruction into a running session. */
  followUp: boolean;
  /** Wire format carries tool-call begin/end. */
  toolEvents: boolean;
  /** Wire format carries token usage. */
  usageEvents: boolean;
  /** Wire format carries chain-of-thought. */
  thinking: boolean;
  /** Wire format carries file change notices. */
  fileChanges: boolean;
  /** `--model <id>` style model selection honored. */
  modelSelection: boolean;
}

export interface DriverDetect {
  driverId: string;
  installed: boolean;
  version: string | null;
  /** Login/subscription state when the CLI exposes a check; otherwise "unknown". */
  authenticated: boolean | "unknown";
  capabilities: DriverCapabilities;
  /** Human-readable guidance, e.g. how to install or log in. */
  hint: string | null;
}

export interface SpawnOptions {
  taskId: string;
  sessionId: string;
  prompt: string;
  /** Working directory (normally the task's isolated worktree). */
  cwd: string;
  model: string | null;
  /** Resume handle from a previous session (driver-specific externalRef). */
  resumeFrom: string | null;
  /** Extra environment for the child process (merged over process.env). */
  env: Record<string, string>;
}

export interface SessionExit {
  code: number | null;
  signal: string | null;
}

export interface DriverSession {
  readonly sessionId: string;
  readonly pid: number | null;
  /** Normalized event stream; ends after `session.completed`. */
  events: AsyncIterable<AgentEventBody>;
  /**
   * Send an additional instruction to the running agent.
   * Rejects with FollowUpUnsupportedError when capabilities.followUp is false.
   */
  sendFollowUp(text: string): Promise<void>;
  /** Kill the process tree. Idempotent. */
  cancel(): Promise<void>;
  /** Resolves when the CLI process exits (cancel counts as exit). */
  whenExit(): Promise<SessionExit>;
}

export interface AgentDriver {
  readonly id: string;
  readonly label: string;
  readonly capabilities: DriverCapabilities;
  /** Probe the local machine: binary present? version? authenticated? */
  detect(): Promise<DriverDetect>;
  /** The exact argv this driver would run (for doctor/dry-run display). */
  buildArgs(options: Pick<SpawnOptions, "prompt" | "model" | "resumeFrom">): string[];
  spawn(options: SpawnOptions): DriverSession;
}

export class FollowUpUnsupportedError extends Error {
  constructor(driverId: string) {
    super(`driver "${driverId}" does not support mid-session follow-ups`);
    this.name = "FollowUpUnsupportedError";
  }
}

export class DriverNotInstalledError extends Error {
  constructor(
    public readonly driverId: string,
    public readonly hint: string,
  ) {
    super(`driver "${driverId}" is not installed: ${hint}`);
    this.name = "DriverNotInstalledError";
  }
}

/** Shared plumbing: queue-backed async iterable used by every driver session. */
export class EventChannel implements AsyncIterable<AgentEventBody> {
  private queue: AgentEventBody[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(event: AgentEventBody): void {
    if (this.closed) return;
    this.queue.push(event);
    this.wake?.();
    this.wake = null;
  }

  /** Called when the underlying process exits; flushes consumers. */
  close(): void {
    this.closed = true;
    this.wake?.();
    this.wake = null;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentEventBody> {
    while (true) {
      while (this.queue.length > 0) {
        const event = this.queue.shift();
        if (event) yield event;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

export const CAPABILITIES = {
  full: {
    resume: true,
    followUp: true,
    toolEvents: true,
    usageEvents: true,
    thinking: true,
    fileChanges: true,
    modelSelection: true,
  },
  singleShot: {
    resume: true,
    followUp: false,
    toolEvents: true,
    usageEvents: true,
    thinking: true,
    fileChanges: true,
    modelSelection: true,
  },
  shellOnly: {
    resume: false,
    followUp: false,
    toolEvents: false,
    usageEvents: false,
    thinking: false,
    fileChanges: false,
    modelSelection: false,
  },
} as const satisfies Record<string, DriverCapabilities>;
