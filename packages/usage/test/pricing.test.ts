import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PriceBook } from "../src/price-book.js";
import { DEFAULT_PRICE_TABLE, estimateCost, globToRegExp, priceFor } from "../src/pricing.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("pricing", () => {
  it("matches globs case-insensitively, first match wins", () => {
    const table = DEFAULT_PRICE_TABLE;
    expect(priceFor(table, "SIM-LARGE")?.pattern).toBe("sim-*");
    expect(priceFor(table, "claude-sonnet-4-5")?.pattern).toBe("claude-sonnet-4*");
    expect(priceFor(table, "mystery-model")).toBeNull();
    expect(priceFor(table, null)).toBeNull();
  });

  it("computes cost from token quantities", () => {
    const entry = { pattern: "x", inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 };
    const cost = estimateCost(
      { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 100_000, cacheWriteTokens: 0 },
      entry,
    );
    expect(cost).toBeCloseTo(3 + 7.5 + 0.03, 6);
  });

  it("unpriced models cost $0 and are reported as unpriced", () => {
    const book = new PriceBook();
    expect(book.cost({ inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, "mystery")).toEqual({
      costUsd: 0,
      priced: false,
    });
  });

  it("loads an override file", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleetforge-prices-"));
    dirs.push(dir);
    const file = join(dir, "prices.json");
    writeFileSync(
      file,
      JSON.stringify({ version: 1, currency: "USD", prices: [{ pattern: "*", inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 0, cacheWritePerMTok: 0 }] }),
    );
    const book = new PriceBook(file);
    expect(book.sourceLabel).toBe(file);
    expect(book.cost({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 }, "anything").costUsd).toBe(3);
  });

  it("falls back to defaults on malformed override", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleetforge-prices-"));
    dirs.push(dir);
    const file = join(dir, "bad.json");
    writeFileSync(file, "{ not json");
    const book = new PriceBook(file);
    expect(book.sourceLabel).toContain("defaults");
    expect(priceFor(book.current, "sim-large")).not.toBeNull();
  });

  it("glob escaping is sound", () => {
    expect(globToRegExp("a.b*").test("a.bX")).toBe(true);
    expect(globToRegExp("a.b*").test("aXbX")).toBe(false);
  });
});
