import { describe, expect, it } from "vitest";
import { createClaudeFamilyParser } from "../../src/claude-family.js";
import { createCodexParser } from "../../src/codex/codex-wire.js";
import { parseShellLine } from "../../src/generic-shell/generic-shell.js";
import { createClaudeCodeDriver, createZcodeDriver } from "../../src/claude-code/claude-code.js";
import { CodexDriver } from "../../src/codex/codex.js";
import { SimDriver } from "../../src/sim/sim.js";
import {
  CANONICAL_SCENARIO,
  compareSequences,
  filterByCapabilities,
  goldenSequence,
  renderClaudeWire,
  renderCodexWire,
  renderShellWire,
  renderZcodeWire,
} from "./harness.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const simEntry = require.resolve("@fleetforge/sim-agent");

/**
 * The same canonical scenario must normalize to the same event sequence
 * through every driver's wire parser (capability-filtered). This is the
 * contract that makes the fleet interchangeable (docs/adr/0002).
 */
describe("driver conformance: one scenario, one normalized sequence", () => {
  const golden = goldenSequence();

  it("claude-code wire normalizes to the golden sequence", () => {
    const parser = createClaudeFamilyParser("claude-code");
    const events = renderClaudeWire(CANONICAL_SCENARIO).flatMap((line) => parser.parse(line));
    const filtered = filterByCapabilities(events, createClaudeCodeDriver().capabilities);
    const report = compareSequences(filtered, golden);
    expect(report.mismatches).toEqual([]);
    expect(report.pass).toBe(true);
  });

  it("sim wire (claude-family, as emitted by sim-agent) matches too", () => {
    const parser = createClaudeFamilyParser("sim");
    const events = renderClaudeWire(CANONICAL_SCENARIO).flatMap((line) => parser.parse(line));
    const filtered = filterByCapabilities(events, new SimDriver({ entry: simEntry }).capabilities);
    expect(compareSequences(filtered, golden).pass).toBe(true);
  });

  it("zcode wire (claude-family + tolerated extensions) matches", () => {
    const parser = createClaudeFamilyParser("zcode");
    const events = renderZcodeWire(CANONICAL_SCENARIO).flatMap((line) => parser.parse(line));
    const filtered = filterByCapabilities(events, createZcodeDriver().capabilities);
    // Extension lines must be absorbed (no extra/missing normalized events).
    expect(compareSequences(filtered, golden).pass).toBe(true);
  });

  it("codex wire normalizes to the golden sequence", () => {
    const parser = createCodexParser();
    const events = renderCodexWire(CANONICAL_SCENARIO).flatMap((line) => parser.parse(line));
    const filtered = filterByCapabilities(events, new CodexDriver().capabilities);
    // codex reports file_change before the write tool completes; golden order
    // is tool.started → file.changed → tool.completed. The codex renderer
    // emits file_change first, so compare in a codex-canonical order:
    // normalize by reordering file.changed immediately after its tool.started.
    const reordered = reorderCodexFileChanges(filtered);
    const report = compareSequences(reordered, golden);
    expect(report.mismatches, report.mismatches.join("\n")).toEqual([]);
    expect(parser.ref.externalRef).toBe("thread-canon");
  });

  it("generic-shell wire normalizes to the capability-filtered golden", () => {
    const shellCaps = {
      resume: false,
      followUp: false,
      toolEvents: false,
      usageEvents: false,
      thinking: false,
      fileChanges: false,
      modelSelection: false,
    };
    const events = filterByCapabilities(
      renderShellWire(CANONICAL_SCENARIO).flatMap((line) => parseShellLine(line)),
      shellCaps,
    );
    const expected = filterByCapabilities(golden, shellCaps);
    expect(compareSequences(events, expected).pass).toBe(true);
  });

  it("capability declarations are locked: real drivers cannot over-claim", () => {
    const claude = createClaudeCodeDriver();
    expect(claude.capabilities.toolEvents).toBe(true);
    expect(claude.capabilities.usageEvents).toBe(true);
    expect(claude.capabilities.followUp).toBe(false); // single-shot exec mode, v1
    const codex = new CodexDriver();
    expect(codex.capabilities.resume).toBe(true);
    expect(codex.capabilities.followUp).toBe(false);
    const shellLike = { resume: false, followUp: false, toolEvents: false, usageEvents: false, thinking: false, fileChanges: false, modelSelection: false };
    const filtered = filterByCapabilities(golden, shellLike);
    expect(filtered.every((e) => e.kind === "message")).toBe(true);
  });

  it("unknown wire families never break a session (raw fallback)", () => {
    const claudeParser = createClaudeFamilyParser("claude-code");
    const junk = ["not json", JSON.stringify({ type: "brand-new-envelope" }), ""];
    const events = junk.flatMap((line) => claudeParser.parse(line));
    expect(events.filter((e) => e.kind === "raw")).toHaveLength(2);
    const codexParser = createCodexParser();
    const codexEvents = ["garbage", JSON.stringify({ type: "mystery" })].flatMap((line) => codexParser.parse(line));
    expect(codexEvents.every((e) => e.kind === "raw")).toBe(true);
  });
});

/** codex emits item.completed(file_change) *before* the paired
 * item.started/…(command_execution) for a write; fold it right after the
 * corresponding tool.started to match the golden order. */
function reorderCodexFileChanges(events: ReturnType<typeof filterByCapabilities>): ReturnType<typeof filterByCapabilities> {
  const out = [...events];
  for (let i = 0; i < out.length; i++) {
    if (out[i]?.kind === "tool.started" && (out[i].payload as { input: { command?: string } }).input?.command?.startsWith("write ")) {
      // the stray file.changed sits immediately before this tool.started
      for (let j = i - 1; j >= 0; j--) {
        if (out[j]?.kind === "file.changed") {
          const [moved] = out.splice(j, 1);
          if (moved) out.splice(i, 0, moved); // after splice, tool.started is at i
          break;
        }
        if (out[j]?.kind === "tool.completed") break; // crossed into a prior pair
      }
    }
  }
  return out;
}
