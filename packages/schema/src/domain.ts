import { z } from "zod";

/** Canonical task lifecycle. Board columns: backlog | running | review | done. */
export const TaskStatus = z.enum([
  "backlog", // created, not yet dispatched
  "queued", // dispatched, waiting for a concurrency slot
  "running", // an agent session is live in its own worktree
  "review", // session finished; diff awaiting human approval
  "conflict", // merge precheck found conflicts with base branch
  "done", // approved & merged back into base branch
  "failed", // session exited non-zero and no restart policy applies
  "cancelled", // cancelled by the operator
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const MergeStrategy = z.enum(["ff", "squash", "merge"]);
export type MergeStrategy = z.infer<typeof MergeStrategy>;

export const TaskPriority = z.number().int().min(0).max(9).default(0);

export const Task = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  prompt: z.string(),
  agent: z.string().min(1), // driver id, e.g. "sim" | "claude-code"
  model: z.string().optional(),
  repoPath: z.string().min(1), // absolute path of the target git repository
  baseBranch: z.string().min(1),
  branch: z.string().nullable().default(null), // fleet/<short-id>-<slug>
  worktreePath: z.string().nullable().default(null),
  priority: TaskPriority,
  status: TaskStatus,
  mergeStrategy: MergeStrategy.default("ff"),
  maxAttempts: z.number().int().min(1).default(1),
  attempt: z.number().int().min(1).default(1),
  sessionId: z.string().nullable().default(null), // current / latest session
  costUsd: z.number().default(0), // rolled-up estimate from usage events
  exitCode: z.number().nullable().default(null),
  error: z.string().nullable().default(null),
  createdAt: z.number(), // epoch ms
  updatedAt: z.number(),
  startedAt: z.number().nullable().default(null),
  finishedAt: z.number().nullable().default(null),
});
export type Task = z.infer<typeof Task>;

export const SessionStatus = z.enum([
  "starting",
  "running",
  "completed",
  "failed",
  "cancelled",
  "orphan-killed",
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const AgentSession = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  driver: z.string().min(1),
  status: SessionStatus,
  pid: z.number().nullable().default(null),
  model: z.string().nullable().default(null),
  externalRef: z.string().nullable().default(null), // driver-resumable handle (e.g. claude session id)
  attempt: z.number().int().min(1).default(1),
  startedAt: z.number(),
  heartbeatAt: z.number(),
  endedAt: z.number().nullable().default(null),
  exitCode: z.number().nullable().default(null),
  inputTokens: z.number().int().default(0),
  outputTokens: z.number().int().default(0),
  costUsd: z.number().default(0),
});
export type AgentSession = z.infer<typeof AgentSession>;

/** One parsed usage datum; cost estimation is applied by @fleetforge/usage. */
export const UsageRecord = z.object({
  sessionId: z.string(),
  taskId: z.string(),
  driver: z.string(),
  model: z.string().nullable(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().default(0),
  cacheWriteTokens: z.number().int().nonnegative().default(0),
  ts: z.number(),
  costUsd: z.number().nonnegative(),
});
export type UsageRecord = z.infer<typeof UsageRecord>;

/** Aggregate row served to the cost dashboard. */
export interface UsageAggregate {
  groupBy: "task" | "agent" | "model" | "day";
  key: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  events: number;
}

/** Normalized diff summary for review UI. */
export const DiffFile = z.object({
  path: z.string(),
  change: z.enum(["add", "modify", "delete", "rename"]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  binary: z.boolean().default(false),
});
export type DiffFile = z.infer<typeof DiffFile>;

export const DiffSummary = z.object({
  taskId: z.string(),
  branch: z.string(),
  baseBranch: z.string(),
  commits: z.number().int().nonnegative(),
  files: z.array(DiffFile),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  conflicts: z.array(z.string()).default([]), // conflicting paths when precheck fails
  mergeable: z.boolean(),
  patch: z.string(), // unified diff, may be large
});
export type DiffSummary = z.infer<typeof DiffSummary>;
