import type { AgentEventBody, EventEnvelope, EventKind, EventPayloadMap } from "@fleetforge/schema";
import { SCHEMA_VERSION, parseEventBody } from "@fleetforge/schema";
import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";

interface EventRow {
  id: string;
  session_id: string;
  task_id: string;
  seq: number;
  ts: number;
  schema_version: number;
  kind: string;
  payload: string;
}

function rowToEnvelope(row: EventRow): EventEnvelope {
  return {
    id: row.id,
    seq: row.seq,
    ts: row.ts,
    schemaVersion: row.schema_version as typeof SCHEMA_VERSION,
    taskId: row.task_id,
    sessionId: row.session_id,
    kind: row.kind as EventKind,
    payload: JSON.parse(row.payload) as EventPayloadMap[EventKind],
  };
}

/**
 * Event persistence with per-session seq allocation.
 * The (session_id, seq) unique index + synchronous transaction is what makes
 * concurrent ingestion of many sessions safe (ADR-0003).
 */
export class EventRepo {
  private readonly nextSeqStmt;

  constructor(private readonly db: Database) {
    this.nextSeqStmt = db.prepare(
      "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE session_id = ?",
    );
  }

  /**
   * Validate + persist one event body as a full envelope.
   * Invalid payloads are persisted as `raw` events (never silently dropped).
   */
  ingest(sessionId: string, taskId: string, body: AgentEventBody): EventEnvelope {
    let normalized: AgentEventBody;
    try {
      normalized = parseEventBody(body);
    } catch (error) {
      normalized = {
        kind: "raw",
        payload: {
          wire: JSON.stringify(body).slice(0, 4000),
          parseError: error instanceof Error ? error.message : String(error),
        },
      };
    }

    const envelope: EventEnvelope = {
      id: randomUUID(),
      seq: (this.nextSeqStmt.get(sessionId) as { next: number }).next,
      ts: normalized.ts ?? Date.now(),
      schemaVersion: SCHEMA_VERSION,
      taskId,
      sessionId,
      kind: normalized.kind,
      payload: normalized.payload as never,
    };

    this.db
      .prepare(
        `INSERT INTO events (id, session_id, task_id, seq, ts, schema_version, kind, payload)
         VALUES (@id, @sessionId, @taskId, @seq, @ts, @schemaVersion, @kind, @payload)`,
      )
      .run({ ...envelope, payload: JSON.stringify(envelope.payload) });
    return envelope;
  }

  ingestMany(sessionId: string, taskId: string, bodies: AgentEventBody[]): EventEnvelope[] {
    const insertAll = this.db.transaction(() => bodies.map((b) => this.ingest(sessionId, taskId, b)));
    return insertAll();
  }

  get(sessionId: string, seq: number): EventEnvelope | null {
    const row = this.db
      .prepare("SELECT * FROM events WHERE session_id = ? AND seq = ?")
      .get(sessionId, seq) as EventRow | undefined;
    return row ? rowToEnvelope(row) : null;
  }

  /** Historical replay: events after `afterSeq` (exclusive), ascending. */
  listBySession(sessionId: string, afterSeq = 0, limit = 5000): EventEnvelope[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
      )
      .all(sessionId, afterSeq, limit) as EventRow[];
    return rows.map(rowToEnvelope);
  }

  listByTask(taskId: string, limit = 5000): EventEnvelope[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE task_id = ? ORDER BY seq ASC LIMIT ?")
      .all(taskId, limit) as EventRow[];
    return rows.map(rowToEnvelope);
  }

  lastSeq(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS max FROM events WHERE session_id = ?")
      .get(sessionId) as { max: number };
    return row.max;
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c;
  }
}
