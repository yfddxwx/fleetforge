import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { createCodexParser } from "./codex-wire.js";
import { probeVersion } from "../claude-code/claude-code.js";
import { startLineProtocolSession } from "../line-session.js";
import {
  CAPABILITIES,
  type AgentDriver,
  type DriverDetect,
  type DriverSession,
  type SpawnOptions,
} from "../types.js";

/**
 * OpenAI Codex CLI driver — `codex exec --json`.
 * Resume: `codex exec resume <thread_id> --json` (externalRef = thread id).
 */
export class CodexDriver implements AgentDriver {
  readonly id = "codex";
  readonly label = "OpenAI Codex";
  readonly capabilities = { ...CAPABILITIES.singleShot };

  private resolvedCommand(): string {
    return process.env["FLEETFORGE_CODEX_PATH"] ?? "codex";
  }

  async detect(): Promise<DriverDetect> {
    const command = this.resolvedCommand();
    const version = probeVersion(command, ["--version"]);
    if (version === null) {
      return {
        driverId: this.id,
        label: this.label,
        installed: false,
        version: null,
        authenticated: "unknown",
        capabilities: this.capabilities,
        hint: "npm i -g @openai/codex (or set FLEETFORGE_CODEX_PATH)",
      };
    }
    const authenticated = existsSync(join(homedir(), ".codex", "auth.json"));
    return {
      driverId: this.id,
      label: this.label,
      installed: true,
      version,
      authenticated,
      capabilities: this.capabilities,
      hint: authenticated ? null : "run `codex login` once",
    };
  }

  buildArgs(opts: Pick<SpawnOptions, "prompt" | "model" | "resumeFrom">): string[] {
    if (opts.resumeFrom) {
      const args = ["exec", "resume", opts.resumeFrom, "--json"];
      if (opts.model) args.push("--model", opts.model);
      args.push(opts.prompt);
      return args;
    }
    const args = ["exec", "--json"];
    if (opts.model) args.push("--model", opts.model);
    args.push(opts.prompt);
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
      createParser: () => createCodexParser(),
      followUpWriter: null,
    });
  }
}
