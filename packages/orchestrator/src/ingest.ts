import { ev, type AgentEventBody, type EventEnvelope } from "@fleetforge/schema";
import type { FleetStore } from "@fleetforge/store";
import { type PriceBook } from "@fleetforge/usage";

/**
 * Ingestion pipeline: raw driver event body → validate → envelope(seq) →
 * SQLite (+ usage cost rollup). Every consumer (WS, CLI, dashboards) reads
 * only persisted envelopes, so this is the single write path.
 */
export class EventIngestor {
  private readonly sessionTask = new Map<string, { taskId: string; driver: string }>();

  constructor(
    private readonly store: FleetStore,
    private readonly priceBook: PriceBook,
  ) {}

  ingest(sessionId: string, body: AgentEventBody): EventEnvelope {
    const meta = this.metaFor(sessionId);
    const envelope = this.store.events.ingest(sessionId, meta.taskId, body);

    switch (envelope.kind) {
      case "session.started": {
        const payload = envelope.payload as { model: string | null };
        if (payload.model && !this.store.sessions.get(sessionId)?.model) {
          this.store.sessions.setModel(sessionId, payload.model);
        }
        this.store.sessions.setStatus(sessionId, "running");
        break;
      }
      case "usage": {
        const payload = envelope.payload as {
          model: string | null;
          inputTokens: number;
          outputTokens: number;
          cacheReadTokens: number;
          cacheWriteTokens: number;
        };
        const session = this.store.sessions.require(sessionId);
        const model = payload.model ?? session.model;
        const { costUsd } = this.priceBook.cost(payload, model);
        this.store.usage.record({
          id: envelope.id,
          sessionId,
          taskId: meta.taskId,
          driver: meta.driver,
          model,
          inputTokens: payload.inputTokens,
          outputTokens: payload.outputTokens,
          cacheReadTokens: payload.cacheReadTokens,
          cacheWriteTokens: payload.cacheWriteTokens,
          ts: envelope.ts,
          costUsd,
        });
        this.store.sessions.addTokens(sessionId, {
          inputTokens: payload.inputTokens,
          outputTokens: payload.outputTokens,
          costUsd,
        });
        this.store.tasks.addCost(meta.taskId, costUsd);
        break;
      }
      default:
        break;
    }
    return envelope;
  }

  private metaFor(sessionId: string): { taskId: string; driver: string } {
    const cached = this.sessionTask.get(sessionId);
    if (cached) return cached;
    const session = this.store.sessions.get(sessionId);
    if (!session) throw new Error(`cannot ingest into unknown session: ${sessionId}`);
    const meta = { taskId: session.taskId, driver: session.driver };
    this.sessionTask.set(sessionId, meta);
    return meta;
  }
}

export const FOLLOWUP_EVENT = (text: string): AgentEventBody => ev("followup", { text });
