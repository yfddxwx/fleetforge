import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { createClaudeFamilyParser } from "../claude-family.js";
import { startLineProtocolSession } from "../line-session.js";
import {
  CAPABILITIES,
  type AgentDriver,
  type DriverDetect,
  type DriverSession,
  type SpawnOptions,
} from "../types.js";

export interface CliDriverConfig {
  /** Executable name resolved via PATH (or absolute path). */
  command: string;
  /** Env var that can override the command (e.g. FLEETFORGE_CLAUDE_PATH). */
  envOverride?: string;
  /** Config directory under the home dir used as login-state evidence. */
  configDirs: string[];
  versionArgs: string[];
  loginProbeArgs?: string[];
  authenticatedHint: string;
}

/** Shared implementation for claude-stream-json-family CLIs (claude-code, zcode). */
export class ClaudeFamilyCliDriver implements AgentDriver {
  readonly capabilities = { ...CAPABILITIES.singleShot };

  constructor(
    readonly id: string,
    readonly label: string,
    private readonly config: CliDriverConfig,
  ) {}

  private resolvedCommand(): string {
    return this.config.envOverride
      ? (process.env[this.config.envOverride] ?? this.config.command)
      : this.config.command;
  }

  async detect(): Promise<DriverDetect> {
    const command = this.resolvedCommand();
    const version = probeVersion(command, this.config.versionArgs);
    if (version === null) {
      return {
        driverId: this.id,
        label: this.label,
        installed: false,
        version: null,
        authenticated: "unknown",
        capabilities: this.capabilities,
        hint: `install the CLI or point ${this.config.envOverride ?? `${this.id} path`} at it`,
      };
    }
    const configPresent = this.config.configDirs.some((dir) =>
      existsSync(join(homedir(), dir)),
    );
    let authenticated: boolean | "unknown" = configPresent;
    if (this.config.loginProbeArgs) {
      const probe = spawnSync(command, this.config.loginProbeArgs, {
        encoding: "utf8",
        timeout: 8000,
        windowsHide: true,
      });
      if (probe.status === 0) authenticated = true;
      else if (probe.status !== null) authenticated = false;
    }
    return {
      driverId: this.id,
      label: this.label,
      installed: true,
      version,
      authenticated,
      capabilities: this.capabilities,
      hint:
        authenticated === false
          ? this.config.authenticatedHint
          : null,
    };
  }

  buildArgs(opts: Pick<SpawnOptions, "prompt" | "model" | "resumeFrom">): string[] {
    const args: string[] = ["-p", opts.prompt, "--output-format", "stream-json", "--verbose"];
    if (opts.model) args.push("--model", opts.model);
    if (opts.resumeFrom) args.push("--resume", opts.resumeFrom);
    return args;
  }

  spawn(opts: SpawnOptions): DriverSession {
    const args = this.buildArgs(opts);
    return startLineProtocolSession({
      sessionId: opts.sessionId,
      driverId: this.id,
      model: opts.model,
      command: this.resolvedCommand(),
      args,
      cwd: opts.cwd,
      env: opts.env,
      createParser: () => createClaudeFamilyParser(this.id),
      followUpWriter: null,
    });
  }
}

/** Run `<command> --version` with a timeout; null when not runnable. */
export function probeVersion(command: string, args: string[]): string | null {
  try {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true,
    });
    if (result.error) return null;
    const out = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    const firstLine = out.split("\n")[0] ?? "";
    return firstLine.trim() || "unknown";
  } catch {
    return null;
  }
}

export function createClaudeCodeDriver(): ClaudeFamilyCliDriver {
  return new ClaudeFamilyCliDriver("claude-code", "Claude Code", {
    command: "claude",
    envOverride: "FLEETFORGE_CLAUDE_PATH",
    configDirs: [".claude"],
    versionArgs: ["--version"],
    authenticatedHint: "run `claude` once and log in (or set ANTHROPIC_API_KEY)",
  });
}

export function createZcodeDriver(): ClaudeFamilyCliDriver {
  return new ClaudeFamilyCliDriver("zcode", "ZCode", {
    command: "zcode",
    envOverride: "FLEETFORGE_ZCODE_PATH",
    configDirs: [".zcode"],
    versionArgs: ["--version"],
    authenticatedHint: "launch zcode and sign in once",
  });
}
