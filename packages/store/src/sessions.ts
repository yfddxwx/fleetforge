import type { AgentSession, SessionStatus } from "@fleetforge/schema";
import type { Database } from "./db.js";

interface SessionRow {
  id: string;
  task_id: string;
  driver: string;
  status: string;
  pid: number | null;
  model: string | null;
  external_ref: string | null;
  attempt: number;
  started_at: number;
  heartbeat_at: number;
  ended_at: number | null;
  exit_code: number | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

function rowToSession(row: SessionRow): AgentSession {
  return {
    id: row.id,
    taskId: row.task_id,
    driver: row.driver,
    status: row.status as SessionStatus,
    pid: row.pid,
    model: row.model,
    externalRef: row.external_ref,
    attempt: row.attempt,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    endedAt: row.ended_at,
    exitCode: row.exit_code,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
  };
}

export interface NewSessionInput {
  id: string;
  taskId: string;
  driver: string;
  model: string | null;
  attempt: number;
  startedAt?: number;
}

export class SessionRepo {
  constructor(private readonly db: Database) {}

  create(input: NewSessionInput): AgentSession {
    const startedAt = input.startedAt ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO sessions (id, task_id, driver, status, model, attempt, started_at, heartbeat_at)
         VALUES (@id, @taskId, @driver, 'starting', @model, @attempt, @startedAt, @startedAt)`,
      )
      .run({ ...input, startedAt });
    return this.get(input.id) as AgentSession;
  }

  get(id: string): AgentSession | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
      | SessionRow
      | undefined;
    return row ? rowToSession(row) : null;
  }

  require(id: string): AgentSession {
    const session = this.get(id);
    if (!session) throw new Error(`session not found: ${id}`);
    return session;
  }

  listByTask(taskId: string): AgentSession[] {
    const rows = this.db
      .prepare("SELECT * FROM sessions WHERE task_id = ? ORDER BY started_at ASC")
      .all(taskId) as SessionRow[];
    return rows.map(rowToSession);
  }

  listByStatus(status: SessionStatus): AgentSession[] {
    const rows = this.db
      .prepare("SELECT * FROM sessions WHERE status = ? ORDER BY started_at ASC")
      .all(status) as SessionRow[];
    return rows.map(rowToSession);
  }

  setPid(id: string, pid: number | null): void {
    this.db.prepare("UPDATE sessions SET pid = ? WHERE id = ?").run(pid, id);
  }

  setExternalRef(id: string, ref: string | null): void {
    this.db.prepare("UPDATE sessions SET external_ref = ? WHERE id = ?").run(ref, id);
  }

  setModel(id: string, model: string | null): void {
    this.db.prepare("UPDATE sessions SET model = ? WHERE id = ?").run(model, id);
  }

  setStatus(id: string, status: SessionStatus): void {
    this.db.prepare("UPDATE sessions SET status = ? WHERE id = ?").run(status, id);
  }

  heartbeat(id: string, at?: number): void {
    this.db.prepare("UPDATE sessions SET heartbeat_at = ? WHERE id = ?").run(at ?? Date.now(), id);
  }

  complete(id: string, patch: { status: SessionStatus; exitCode: number | null; endedAt: number }): void {
    this.db
      .prepare("UPDATE sessions SET status = @status, exit_code = @exitCode, ended_at = @endedAt WHERE id = @id")
      .run({ id, ...patch });
  }

  addTokens(id: string, delta: { inputTokens: number; outputTokens: number; costUsd: number }): void {
    this.db
      .prepare(
        `UPDATE sessions SET input_tokens = input_tokens + @inputTokens,
           output_tokens = output_tokens + @outputTokens, cost_usd = cost_usd + @costUsd
         WHERE id = @id`,
      )
      .run({ id, ...delta });
  }
}
