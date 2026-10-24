import { z } from "zod";

/**
 * sim-agent scenario format v1 (see README.md). Deterministic, programmable
 * replay of a coding agent: streaming text, tool calls, real file edits, real
 * shell commands, usage, mid-run crashes.
 */
export const Step = z.discriminatedUnion("type", [
  z.object({ type: z.literal("think"), text: z.string() }),
  z.object({ type: z.literal("say"), text: z.string(), chunks: z.number().int().min(1).max(10).default(2) }),
  z.object({
    type: z.literal("write"),
    path: z.string(),
    content: z.string(),
    mode: z.enum(["create", "append"]).default("create"),
  }),
  z.object({ type: z.literal("edit"), path: z.string(), old: z.string(), new: z.string() }),
  z.object({ type: z.literal("delete"), path: z.string() }),
  z.object({
    type: z.literal("tool"),
    name: z.string(),
    input: z.unknown().default({}),
    output: z.string().nullable().default(null),
    error: z.string().nullable().default(null),
  }),
  z.object({ type: z.literal("shell"), command: z.string() }),
  z.object({
    type: z.literal("usage"),
    inputTokens: z.number().int().nonnegative().default(0),
    outputTokens: z.number().int().nonnegative().default(0),
    cacheReadTokens: z.number().int().nonnegative().default(0),
    cacheWriteTokens: z.number().int().nonnegative().default(0),
  }),
  z.object({ type: z.literal("sleep"), ms: z.number().nonnegative() }),
  z.object({
    type: z.literal("crash"),
    exitCode: z.number().int().default(1),
    after: z.number().nonnegative().default(0),
    message: z.string().default("simulated agent crash"),
  }),
  z.object({ type: z.literal("fail"), message: z.string().default("simulated task failure") }),
]);
export type Step = z.infer<typeof Step>;

export const Scenario = z.object({
  name: z.string().min(1),
  model: z.string().default("sim-large"),
  wire: z.literal("sim").default("sim"),
  externalRef: z.string().nullable().default(null),
  followUp: z.boolean().default(true),
  steps: z.array(Step),
  /** Steps replayed (in order) each time a follow-up arrives on stdin. */
  followUpSteps: z.array(Step).default([]),
});
export type Scenario = z.infer<typeof Scenario>;
