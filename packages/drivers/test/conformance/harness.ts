import type { AgentEventBody, EventKind } from "@fleetforge/schema";
import { ev } from "@fleetforge/schema";
import type { DriverCapabilities } from "../../src/types.js";

/**
 * Driver conformance harness (docs/adr/0002):
 * one canonical scenario, rendered into each driver's wire format, parsed by
 * that driver's pure parser, capability-filtered, then compared event-by-event
 * against the golden normalized sequence. Runs fully offline in CI.
 */

export interface CanonicalStep {
  think?: string;
  say?: string;
  write?: { path: string; content: string };
  command?: { command: string; output: string; exitCode?: number };
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number };
}

export const CANONICAL_SCENARIO: CanonicalStep[] = [
  { think: "Analyzing the request." },
  { say: "I will create the file." },
  { write: { path: "fizzbuzz.ts", content: "export function fizzbuzz() {}\n" } },
  { command: { command: "npm test", output: "all green", exitCode: 0 } },
  { usage: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 80 } },
];

/** Golden: the normalized sequence every conforming driver must produce. */
export function goldenSequence(): AgentEventBody[] {
  return [
    ev("thinking", { text: "Analyzing the request." }),
    ev("message", { role: "assistant", text: "I will create the file." }),
    ev("tool.started", { toolCallId: "t-write", name: "Write", input: { file_path: "fizzbuzz.ts" } }),
    ev("file.changed", { path: "fizzbuzz.ts", change: "modify", previousPath: null }),
    ev("tool.completed", { toolCallId: "t-write", status: "success", output: "wrote fizzbuzz.ts", error: null }),
    ev("tool.started", { toolCallId: "t-cmd", name: "Bash", input: { command: "npm test" } }),
    ev("tool.completed", { toolCallId: "t-cmd", status: "success", output: "all green", error: null }),
    ev("usage", { model: null, inputTokens: 1200, outputTokens: 340, cacheReadTokens: 80, cacheWriteTokens: 0 }),
  ];
}

/* ---------------------------------------------------------------------------
 * Renderers: canonical scenario → wire lines per driver family.
 * ------------------------------------------------------------------------- */

/** claude stream-json family (also emitted verbatim by sim-agent). */
export function renderClaudeWire(steps: CanonicalStep[]): string[] {
  const lines: string[] = [];
  lines.push(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-canon", model: "canon-model", cwd: "." }));
  for (const step of steps) {
    if (step.think) {
      lines.push(
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "thinking", thinking: step.think }] },
        }),
      );
    }
    if (step.say) {
      lines.push(
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: step.say }] },
        }),
      );
    }
    if (step.write) {
      lines.push(
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", id: "t-write", name: "Write", input: { file_path: step.write.path, content: step.write.content } },
            ],
          },
        }),
      );
      lines.push(
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t-write", content: `wrote ${step.write.path}` }],
          },
        }),
      );
    }
    if (step.command) {
      const ok = (step.command.exitCode ?? 0) === 0;
      lines.push(
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "t-cmd", name: "Bash", input: { command: step.command.command } }],
          },
        }),
      );
      lines.push(
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "t-cmd",
                ...(ok ? { content: step.command.output } : { is_error: true, content: `exit code ${step.command.exitCode}` }),
              },
            ],
          },
        }),
      );
    }
    if (step.usage) {
      lines.push(
        JSON.stringify({
          type: "usage",
          model: null,
          input_tokens: step.usage.inputTokens,
          output_tokens: step.usage.outputTokens,
          cache_read_input_tokens: step.usage.cacheReadTokens ?? 0,
          cache_creation_input_tokens: 0,
        }),
      );
    }
  }
  return lines;
}

/** zcode wire: claude-family plus zcode-specific extension lines that must be
 * tolerated (normalized or raw) without breaking the sequence. */
export function renderZcodeWire(steps: CanonicalStep[]): string[] {
  const lines = renderClaudeWire(steps);
  // zcode emits a few extension envelopes; unknown subtypes normalize away.
  lines.splice(1, 0, JSON.stringify({ type: "system", subtype: "zcode.environment", tools: 42 }));
  return lines;
}

/** codex exec --json wire. */
export function renderCodexWire(steps: CanonicalStep[]): string[] {
  const lines: string[] = [];
  lines.push(JSON.stringify({ type: "thread.started", thread_id: "thread-canon" }));
  lines.push(JSON.stringify({ type: "turn.started", turn_index: 1 }));
  for (const step of steps) {
    if (step.think) {
      lines.push(JSON.stringify({ type: "item.completed", item: { type: "reasoning", summary: [{ type: "summary_text", text: step.think }] } }));
    }
    if (step.say) {
      lines.push(JSON.stringify({ type: "item.completed", item: { type: "agent_message", content: [{ type: "output_text", text: step.say }] } }));
    }
    if (step.write) {
      lines.push(JSON.stringify({ type: "item.completed", item: { type: "file_change", changes: [{ kind: "modify", path: step.write.path }] } }));
      // codex reports the write through its file_change item; the runner tool
      // surface here is the file operation itself.
      lines.push(JSON.stringify({ type: "item.started", item: { type: "command_execution", id: "t-write", command: `write ${step.write.path}` } }));
      lines.push(JSON.stringify({ type: "item.completed", item: { type: "command_execution", id: "t-write", command: `write ${step.write.path}`, exit_code: 0, output: `wrote ${step.write.path}` } }));
    }
    if (step.command) {
      lines.push(JSON.stringify({ type: "item.started", item: { type: "command_execution", id: "t-cmd", command: step.command.command } }));
      lines.push(
        JSON.stringify({
          type: "item.completed",
          item: { type: "command_execution", id: "t-cmd", command: step.command.command, exit_code: step.command.exitCode ?? 0, output: step.command.output },
        }),
      );
    }
    if (step.usage) {
      lines.push(
        JSON.stringify({
          type: "turn.completed",
          turn_index: 1,
          usage: {
            input_tokens: step.usage.inputTokens,
            output_tokens: step.usage.outputTokens,
            cached_input_tokens: step.usage.cacheReadTokens ?? 0,
          },
        }),
      );
    }
  }
  return lines;
}

/** generic-shell wire: schema-JSON stdout lines (its only channel). */
export function renderShellWire(steps: CanonicalStep[]): string[] {
  const lines: string[] = [];
  for (const step of steps) {
    if (step.say) lines.push(JSON.stringify({ kind: "message", payload: { role: "assistant", text: step.say } }));
    if (step.usage) {
      lines.push(
        JSON.stringify({
          kind: "usage",
          payload: {
            model: null,
            inputTokens: step.usage.inputTokens,
            outputTokens: step.usage.outputTokens,
            cacheReadTokens: step.usage.cacheReadTokens ?? 0,
            cacheWriteTokens: 0,
          },
        }),
      );
    }
  }
  return lines;
}

/* ---------------------------------------------------------------------------
 * Comparison with capability filtering.
 * ------------------------------------------------------------------------- */

const KIND_TO_CAPABILITY: Partial<Record<EventKind, keyof DriverCapabilities>> = {
  thinking: "thinking",
  "tool.started": "toolEvents",
  "tool.completed": "toolEvents",
  "file.changed": "fileChanges",
  usage: "usageEvents",
};

/**
 * Turn-boundary events are a driver-specific enhancement (codex emits them,
 * the claude stream-json family does not). They carry no payload semantics
 * beyond ordering hints, so they are excluded from cross-driver identity.
 */
const CROSS_DRIVER_EXCLUDED: ReadonlySet<EventKind> = new Set(["turn.started", "turn.completed"]);

/** Drop event kinds the driver declares unsupported (and turn boundaries). */
export function filterByCapabilities(
  events: AgentEventBody[],
  capabilities: DriverCapabilities,
): AgentEventBody[] {
  return events.filter((event) => {
    if (CROSS_DRIVER_EXCLUDED.has(event.kind)) return false;
    const cap = KIND_TO_CAPABILITY[event.kind];
    return cap === undefined || capabilities[cap] === true;
  });
}

export interface DiffReport {
  pass: boolean;
  mismatches: string[];
}

/** Compare two normalized sequences on semantic fields.
 *
 * Identity contract across heterogeneous CLIs:
 *  - `tool.started` / `tool.completed` compare by `toolCallId` (+status):
 *    tool *names* are driver dialect (claude: Write/Bash; codex: everything is
 *    a command_execution), and `input`/`output` are passthrough.
 *  - everything else compares the full payload.
 */
export function compareSequences(actual: AgentEventBody[], expected: AgentEventBody[]): DiffReport {
  const mismatches: string[] = [];
  if (actual.length !== expected.length) {
    mismatches.push(
      `length: expected ${expected.length} events, got ${actual.length}`,
    );
  }
  const n = Math.min(actual.length, expected.length);
  for (let i = 0; i < n; i++) {
    const a = actual[i];
    const e = expected[i];
    if (!a || !e) {
      mismatches.push(`[${i}] missing event`);
      continue;
    }
    if (a.kind !== e.kind) {
      mismatches.push(`[${i}] kind: expected ${e.kind}, got ${a.kind}`);
      continue;
    }
    const ap = a.payload as Record<string, unknown>;
    const ep = e.payload as Record<string, unknown>;
    if (a.kind === "tool.started" || a.kind === "tool.completed") {
      const fields = a.kind === "tool.started" ? ["toolCallId"] : ["toolCallId", "status"];
      for (const field of fields) {
        if (ap[field] !== ep[field]) {
          mismatches.push(`[${i}] ${a.kind}.${field}: expected ${JSON.stringify(ep[field])}, got ${JSON.stringify(ap[field])}`);
        }
      }
      continue;
    }
    const as = JSON.stringify(ap);
    const es = JSON.stringify(ep);
    if (as !== es) mismatches.push(`[${i}] ${a.kind} payload: expected ${es}, got ${as}`);
  }
  return { pass: mismatches.length === 0, mismatches };
}
