import { z } from "zod";
import { SCHEMA_VERSION } from "./version.js";

/**
 * Normalized agent events (schema v1).
 *
 * Every driver parses its CLI's wire format into exactly these kinds.
 * Lifecycle contract for a session's event stream:
 *   first event  = session.started
 *   last  event  = session.completed
 * Drivers synthesize lifecycle events when the underlying CLI does not emit them.
 */

export const EventKind = z.enum([
  "session.started",
  "session.completed",
  "turn.started",
  "turn.completed",
  "message", // a complete message (assistant / user / system)
  "message.delta", // streaming chunk of an assistant message
  "thinking", // streaming chunk of chain-of-thought
  "tool.started",
  "tool.completed",
  "usage",
  "file.changed",
  "session.log", // raw console output (stderr, generic-shell stdout, ...)
  "followup", // operator sent an additional instruction mid-session
  "raw", // unparsable wire line, kept verbatim for debugging
]);
export type EventKind = z.infer<typeof EventKind>;

export const SessionStartedPayload = z.object({
  driver: z.string(),
  pid: z.number().nullable().default(null),
  model: z.string().nullable().default(null),
  externalRef: z.string().nullable().default(null),
});

export const SessionCompletedPayload = z.object({
  status: z.enum(["completed", "failed", "cancelled"]),
  exitCode: z.number().nullable().default(null),
  error: z.string().nullable().default(null),
});

export const TurnStartedPayload = z.object({ turn: z.number().int().positive() });
export const TurnCompletedPayload = z.object({
  turn: z.number().int().positive(),
  stopReason: z.string().nullable().default(null),
});

export const MessagePayload = z.object({
  role: z.enum(["assistant", "user", "system"]),
  text: z.string(),
});
export const MessageDeltaPayload = z.object({ text: z.string() });
export const ThinkingPayload = z.object({ text: z.string() });

export const ToolStartedPayload = z.object({
  toolCallId: z.string(),
  name: z.string(),
  input: z.unknown().optional(),
});
export const ToolCompletedPayload = z.object({
  toolCallId: z.string(),
  status: z.enum(["success", "error"]),
  output: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
});

export const UsagePayload = z.object({
  model: z.string().nullable().default(null),
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  cacheReadTokens: z.number().int().nonnegative().default(0),
  cacheWriteTokens: z.number().int().nonnegative().default(0),
});

export const FileChangedPayload = z.object({
  path: z.string(),
  change: z.enum(["add", "modify", "delete", "rename"]),
  previousPath: z.string().nullable().default(null),
});

export const SessionLogPayload = z.object({
  stream: z.enum(["stdout", "stderr"]),
  text: z.string(),
});

export const FollowupPayload = z.object({ text: z.string() });

export const RawPayload = z.object({ wire: z.string(), parseError: z.string().nullable().default(null) });

export const EventPayloads = {
  "session.started": SessionStartedPayload,
  "session.completed": SessionCompletedPayload,
  "turn.started": TurnStartedPayload,
  "turn.completed": TurnCompletedPayload,
  message: MessagePayload,
  "message.delta": MessageDeltaPayload,
  thinking: ThinkingPayload,
  "tool.started": ToolStartedPayload,
  "tool.completed": ToolCompletedPayload,
  usage: UsagePayload,
  "file.changed": FileChangedPayload,
  "session.log": SessionLogPayload,
  followup: FollowupPayload,
  raw: RawPayload,
} as const;

export type EventPayloadMap = { [K in EventKind]: z.infer<(typeof EventPayloads)[K]> };

/**
 * Event body as produced by a driver's wire parser (before the server stamps
 * identity + sequence and persists it as an envelope).
 */
export const AgentEventBody = z.object({
  kind: EventKind,
  ts: z.number().optional(), // epoch ms; server stamps when absent
  payload: z.unknown(),
});
export type AgentEventBody = z.infer<typeof AgentEventBody>;

/** Persisted, broadcast event. `seq` is 1-based and monotonic per session. */
export interface EventEnvelope<K extends EventKind = EventKind> {
  id: string;
  seq: number;
  ts: number;
  schemaVersion: typeof SCHEMA_VERSION;
  taskId: string;
  sessionId: string;
  kind: K;
  payload: EventPayloadMap[K];
}

export function parseEventBody(input: unknown): AgentEventBody {
  const body = AgentEventBody.parse(input);
  const payloadSchema = EventPayloads[body.kind];
  if (!payloadSchema) {
    throw new Error(`unknown event kind: ${String(body.kind)}`);
  }
  return { ...body, payload: payloadSchema.parse(body.payload) };
}

export function makeEnvelope<K extends EventKind>(
  body: AgentEventBody & { kind: K; payload: EventPayloadMap[K] },
  identity: { taskId: string; sessionId: string; seq: number; id: string },
): EventEnvelope<K> {
  return {
    id: identity.id,
    seq: identity.seq,
    ts: body.ts ?? Date.now(),
    schemaVersion: SCHEMA_VERSION,
    taskId: identity.taskId,
    sessionId: identity.sessionId,
    kind: body.kind,
    payload: body.payload,
  };
}

/** Convenience constructors for drivers. */
export function ev<K extends EventKind>(
  kind: K,
  payload: EventPayloadMap[K],
  ts?: number,
): AgentEventBody {
  return { kind, payload, ...(ts !== undefined ? { ts } : {}) };
}
