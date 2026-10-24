import { z } from "zod";

/**
 * Price table — configurable JSON. First pattern (glob, case-insensitive) that
 * matches the model name wins; unmapped models cost $0 (visible in the
 * dashboard as "unpriced" so operators add rows rather than silently burn money).
 */
export const PriceEntry = z.object({
  pattern: z.string().min(1),
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
  cacheReadPerMTok: z.number().nonnegative().default(0),
  cacheWritePerMTok: z.number().nonnegative().default(0),
  note: z.string().optional(),
});
export type PriceEntry = z.infer<typeof PriceEntry>;

export const PriceTable = z.object({
  version: z.literal(1),
  currency: z.literal("USD").default("USD"),
  prices: z.array(PriceEntry),
});
export type PriceTable = z.infer<typeof PriceTable>;

export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

/** Returns the first matching entry, or null when the model is unpriced. */
export function priceFor(table: PriceTable, model: string | null): PriceEntry | null {
  if (!model) return null;
  for (const entry of table.prices) {
    if (globToRegExp(entry.pattern).test(model)) return entry;
  }
  return null;
}

export interface UsageQuantities {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

const MTOK = 1_000_000;

export function estimateCost(q: UsageQuantities, entry: PriceEntry): number {
  const cost =
    (q.inputTokens / MTOK) * entry.inputPerMTok +
    (q.outputTokens / MTOK) * entry.outputPerMTok +
    (q.cacheReadTokens / MTOK) * entry.cacheReadPerMTok +
    (q.cacheWriteTokens / MTOK) * entry.cacheWritePerMTok;
  return cost;
}

/** Default table: sim models + common CLIs' model families, editable at runtime. */
export const DEFAULT_PRICE_TABLE: PriceTable = {
  version: 1,
  currency: "USD",
  prices: [
    {
      pattern: "sim-*",
      inputPerMTok: 0.5,
      outputPerMTok: 2,
      cacheReadPerMTok: 0.05,
      cacheWritePerMTok: 0.63,
      note: "sim-agent demo pricing",
    },
    {
      pattern: "claude-sonnet-4*",
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheReadPerMTok: 0.3,
      cacheWritePerMTok: 3.75,
    },
    {
      pattern: "claude-opus-4*",
      inputPerMTok: 15,
      outputPerMTok: 75,
      cacheReadPerMTok: 1.5,
      cacheWritePerMTok: 18.75,
    },
    {
      pattern: "claude-haiku-4*",
      inputPerMTok: 0.8,
      outputPerMTok: 4,
      cacheReadPerMTok: 0.08,
      cacheWritePerMTok: 1,
    },
    { pattern: "gpt-5*", inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.13, cacheWritePerMTok: 0 },
    { pattern: "codex-*", inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.13, cacheWritePerMTok: 0 },
    { pattern: "glm-4*", inputPerMTok: 0.6, outputPerMTok: 2.2, cacheReadPerMTok: 0.11, cacheWritePerMTok: 0 },
    { pattern: "deepseek-chat", inputPerMTok: 0.27, outputPerMTok: 1.1, cacheReadPerMTok: 0, cacheWritePerMTok: 0 },
    { pattern: "deepseek-reasoner", inputPerMTok: 0.55, outputPerMTok: 2.19, cacheReadPerMTok: 0, cacheWritePerMTok: 0 },
  ],
};
