import type { Database } from "./db.js";

export interface UsageRowInput {
  id: string;
  sessionId: string;
  taskId: string;
  driver: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  ts: number;
  costUsd: number;
}

export interface UsageAggregates {
  key: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  events: number;
}

export type UsageGroupBy = "task" | "agent" | "model" | "day";

export class UsageRepo {
  constructor(private readonly db: Database) {}

  record(row: UsageRowInput): void {
    this.db
      .prepare(
        `INSERT INTO usage (id, session_id, task_id, driver, model, input_tokens, output_tokens,
           cache_read_tokens, cache_write_tokens, ts, cost_usd)
         VALUES (@id, @sessionId, @taskId, @driver, @model, @inputTokens, @outputTokens,
           @cacheReadTokens, @cacheWriteTokens, @ts, @costUsd)`,
      )
      .run(row);
  }

  /**
   * Aggregate by task id / driver (agent) / model / local calendar day (ts is epoch ms;
   * day grouping buckets on the server-local timezone, matching the dashboard).
   */
  aggregate(groupBy: UsageGroupBy, filter?: { taskId?: string; driver?: string }): UsageAggregates[] {
    const groupExpr =
      groupBy === "task"
        ? "task_id"
        : groupBy === "agent"
          ? "driver"
          : groupBy === "model"
            ? "COALESCE(model, '(unknown)')"
            : "date(ts / 1000, 'unixepoch', 'localtime')";

    const clauses: string[] = [];
    const params: Record<string, string> = {};
    if (filter?.taskId) {
      clauses.push("task_id = @taskId");
      params.taskId = filter.taskId;
    }
    if (filter?.driver) {
      clauses.push("driver = @driver");
      params.driver = filter.driver;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

    const rows = this.db
      .prepare(
        `SELECT ${groupExpr} AS key,
           SUM(input_tokens) AS inputTokens,
           SUM(output_tokens) AS outputTokens,
           SUM(cache_read_tokens) AS cacheReadTokens,
           SUM(cache_write_tokens) AS cacheWriteTokens,
           SUM(cost_usd) AS costUsd,
           COUNT(*) AS events
         FROM usage ${where}
         GROUP BY ${groupExpr}
         ORDER BY key ASC`,
      )
      .all(params) as Array<{
      key: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      costUsd: number;
      events: number;
    }>;
    return rows.map((r) => ({
      key: r.key,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadTokens: r.cacheReadTokens,
      cacheWriteTokens: r.cacheWriteTokens,
      costUsd: r.costUsd,
      events: r.events,
    }));
  }
}
