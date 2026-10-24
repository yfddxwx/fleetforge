import { spawnSync } from "node:child_process";
import { ev, parseEventBody, type AgentEventBody, type EventKind } from "@fleetforge/schema";
import { startLineProtocolSession } from "../line-session.js";
import {
  CAPABILITIES,
  type AgentDriver,
  type DriverDetect,
  type DriverSession,
  type SpawnOptions,
} from "../types.js";

export interface GenericShellConfig {
  /** Executable (resolved via PATH). */
  command: string;
  /** Argv template; every "{prompt}" is substituted with the task prompt. */
  argsTemplate: string[];
  /** Extra env for the child. */
  env?: Record<string, string>;
  /** Version probe args, e.g. ["--version"]; empty disables probing. */
  versionArgs?: string[];
}

/**
 * generic-shell driver — run ANY command as an "agent" (capability floor).
 * stdout structured capture: a line that parses as JSON with a valid schema
 * event kind is normalized; every other line becomes a session.log event.
 * That means a plain shell script and a JSON-emitting wrapper both work, and
 * a homegrown CLI can adopt the schema incrementally.
 */
export class GenericShellDriver implements AgentDriver {
  readonly id: string;
  readonly label: string;
  readonly capabilities = { ...CAPABILITIES.shellOnly };

  constructor(private readonly config: GenericShellConfig, id = "generic-shell", label?: string) {
    this.id = id;
    this.label = label ?? `shell: ${config.command}`;
  }

  async detect(): Promise<DriverDetect> {
    if (this.config.versionArgs && this.config.versionArgs.length > 0) {
      try {
        const result = spawnSync(this.config.command, this.config.versionArgs, {
          encoding: "utf8",
          timeout: 5000,
          windowsHide: true,
        });
        const version = (result.stdout ?? result.stderr ?? "").trim().split("\n")[0] ?? null;
        return {
          driverId: this.id,
          installed: !result.error,
          version: result.error ? null : version || "unknown",
          authenticated: "unknown",
          capabilities: this.capabilities,
          hint: result.error ? `command not runnable: ${this.config.command}` : null,
        };
      } catch {
        return {
          driverId: this.id,
          installed: false,
          version: null,
          authenticated: "unknown",
          capabilities: this.capabilities,
          hint: `command not runnable: ${this.config.command}`,
        };
      }
    }
    return {
      driverId: this.id,
      installed: true,
      version: null,
      authenticated: "unknown",
      capabilities: this.capabilities,
      hint: null,
    };
  }

  buildArgs(opts: Pick<SpawnOptions, "prompt" | "model" | "resumeFrom">): string[] {
    return this.argsFor(opts.prompt);
  }

  spawn(opts: SpawnOptions): DriverSession {
    const args = this.argsFor(opts.prompt);
    return startLineProtocolSession({
      sessionId: opts.sessionId,
      driverId: this.id,
      model: opts.model,
      command: this.config.command,
      args,
      cwd: opts.cwd,
      env: { ...this.config.env, ...opts.env },
      createParser: () => ({ parse: (line) => parseShellLine(line) }),
      followUpWriter: null,
    });
  }

  private argsFor(prompt: string): string[] {
    const template = this.config.argsTemplate;
    if (template.some((arg) => arg.includes("{prompt}"))) {
      return template.map((arg) => arg.replaceAll("{prompt}", prompt));
    }
    return [...template, prompt];
  }
}

/** Structured stdout capture: schema-JSON lines normalize, the rest log. */
export function parseShellLine(line: string): AgentEventBody[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  if (!trimmed.startsWith("{")) {
    return [ev("session.log", { stream: "stdout", text: line })];
  }
  try {
    const json = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof json["kind"] === "string") {
      const body = parseEventBody({ kind: json["kind"] as EventKind, payload: json["payload"] });
      if (body.kind !== "raw") return [body];
    }
  } catch {
    // fall through to session.log
  }
  return [ev("session.log", { stream: "stdout", text: line })];
}
