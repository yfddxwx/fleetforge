import { existsSync, readFileSync } from "node:fs";
import {
  DEFAULT_PRICE_TABLE,
  PriceTable,
  estimateCost,
  priceFor,
  type PriceEntry,
} from "./pricing.js";

/**
 * Price table provider: embedded defaults, optionally overridden by a JSON file
 * (FLEETFORGE_PRICES env var or explicit path). Bad override files fall back to
 * defaults with a warning surfaced to the caller.
 */
export class PriceBook {
  private table: PriceTable;
  private source: string;

  constructor(overridePath?: string | null) {
    const path = overridePath ?? process.env["FLEETFORGE_PRICES"] ?? null;
    if (path && existsSync(path)) {
      try {
        const parsed = PriceTable.parse(JSON.parse(readFileSync(path, "utf8")));
        this.table = parsed;
        this.source = path;
      } catch (error) {
        this.table = DEFAULT_PRICE_TABLE;
        this.source = `defaults (bad override ${path}: ${error instanceof Error ? error.message : error})`;
      }
    } else {
      this.table = DEFAULT_PRICE_TABLE;
      this.source = path ? `defaults (${path} not found)` : "defaults";
    }
  }

  get current(): PriceTable {
    return this.table;
  }

  get sourceLabel(): string {
    return this.source;
  }

  entry(model: string | null): PriceEntry | null {
    return priceFor(this.table, model);
  }

  cost(q: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }, model: string | null): { costUsd: number; priced: boolean } {
    const entry = this.entry(model);
    if (!entry) return { costUsd: 0, priced: false };
    return { costUsd: estimateCost(q, entry), priced: true };
  }

  replace(table: PriceTable): void {
    this.table = PriceTable.parse(table);
    this.source = "runtime-replaced";
  }
}
