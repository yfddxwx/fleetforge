import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { ev, type AgentEventBody } from "@fleetforge/schema";
import { createClaudeFamilyParser } from "../claude-family.js";
import { startLineProtocolSession } from "../line-session.js";
import {
  CAPABILITIES,
  type AgentDriver,
  type DriverDetect,
  type DriverSession,
  type SpawnOptions,
} from "../types.js";

export interface SimDriverOptions {
  /** Absolute path to sim-agent's dist/main.js; null ⇒ detect reports not installed. */
  entry: string | null;
  /** Time factor passed through (0 = full speed, CI). Defaults to env FLEETFORGE_SIM_SPEED or 1. */
  speed?: number;
}

/**
 * sim driver — spawns fixtures/sim-agent and parses its claude-family wire.
 * The prompt is the scenario: "@path/to/scenario.json" (file), "{...}" (inline
 * JSON), or plain text (wrapped in a minimal say-only scenario so
 * `fleet task new --agent sim "写个 FizzBuzz"` works out of the box).
 */
export class SimDriver implements AgentDriver {
  readonly id = "sim";
  readonly label = "sim-agent (fixture)";
  readonly capabilities = { ...CAPABILITIES.full };

  constructor(private readonly options: SimDriverOptions) {}

  async detect(): Promise<DriverDetect> {
    const entry = this.options.entry;
    if (!entry || !existsSync(entry)) {
      return {
        driverId: this.id,
        installed: false,
        version: null,
        authenticated: true, // no auth by design
        capabilities: this.capabilities,
        hint: "build the fixture: pnpm --filter @fleetforge/sim-agent build",
      };
    }
    return {
      driverId: this.id,
      installed: true,
      version: "local",
      authenticated: true,
      capabilities: this.capabilities,
      hint: null,
    };
  }

  buildArgs(opts: Pick<SpawnOptions, "prompt" | "model" | "resumeFrom">): string[] {
    const scriptPath = this.resolveScenarioPath(opts.prompt);
    return [
      this.options.entry ?? "<sim-agent-not-built>",
      "--script",
      scriptPath,
      "--speed",
      String(this.speed()),
    ];
  }

  spawn(opts: SpawnOptions): DriverSession {
    const scriptPath = this.resolveScenarioPath(opts.prompt);
    const speed = this.speed();
    const args = [
      this.options.entry ?? "sim-agent-missing",
      "--script",
      scriptPath,
      "--speed",
      String(speed),
      "--cwd",
      opts.cwd,
    ];
    return startLineProtocolSession({
      sessionId: opts.sessionId,
      driverId: this.id,
      model: opts.model,
      command: process.execPath,
      args,
      cwd: opts.cwd,
      env: opts.env,
      createParser: () => createClaudeFamilyParser(this.id),
      followUpWriter: (text) => `${JSON.stringify({ type: "followup", text })}\n`,
    });
  }

  /**
   * Resolve the prompt into a scenario file. Files/inlines are passed through;
   * plain text becomes a deterministic single-say scenario written to a
   * per-session temp file (sim-agent keeps --script file-based for auditability).
   */
  private resolveScenarioPath(prompt: string): string {
    if (prompt.startsWith("@")) {
      const p = prompt.slice(1);
      if (!existsSync(p)) throw new Error(`sim scenario file not found: ${p}`);
      return p;
    }
    if (prompt.trimStart().startsWith("{")) {
      const dir = mkdtempSync(join(tmpdir(), "fleetforge-sim-"));
      const file = join(dir, "scenario.inline.json");
      writeFileSync(file, prompt, "utf8");
      return file;
    }
    const dir = mkdtempSync(join(tmpdir(), "fleetforge-sim-"));
    const file = join(dir, "scenario.json");
    const escaped = JSON.stringify(prompt);
    writeFileSync(
      file,
      JSON.stringify(
        {
          name: "ad-hoc",
          model: "sim-large",
          steps: [
            { type: "think", text: `Analyzing request: ${prompt}` },
            { type: "say", text: prompt, chunks: 2 },
            { type: "usage", inputTokens: 64, outputTokens: 32 },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    void escaped;
    return file;
  }

  private speed(): number {
    if (this.options.speed !== undefined) return this.options.speed;
    const env = process.env["FLEETFORGE_SIM_SPEED"];
    const parsed = env !== undefined ? Number(env) : 1;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1;
  }
}

/** Convenience for tests: parse sim wire text with a fresh parser. */
export function parseSimLines(lines: string[]): AgentEventBody[] {
  const parser = createClaudeFamilyParser("sim");
  return lines.flatMap((line) => parser.parse(line));
}

export const SIM_FOLLOWUP_LINE = (text: string): string => `${JSON.stringify({ type: "followup", text })}\n`;

export const SIM_WIRE_HELLO = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "sim-large", cwd: "." }),
  JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "he" } } }),
  JSON.stringify({ type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "hello" }] } }),
  JSON.stringify({ type: "usage", model: "sim-large", input_tokens: 10, output_tokens: 5 }),
  JSON.stringify({ type: "result", subtype: "success", result: "done", session_id: "s1", usage: { input_tokens: 10, output_tokens: 5 } }),
];

export const SIM_RAW_EVENT_STREAM = (): AgentEventBody[] => [
  ev("message.delta", { text: "he" }),
  ev("message", { role: "assistant", text: "hello" }),
  ev("usage", { model: "sim-large", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }),
  ev("session.completed", { status: "completed", exitCode: null, error: null }),
];
