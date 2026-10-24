import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Scenario, Step } from "./scenario.js";

/**
 * Executes a scenario and emits the sim wire protocol (claude stream-json
 * shaped JSONL) on stdout. All file effects are real: they happen in `cwd`.
 */
export class SimRunner {
  private readonly sessionId: string;
  private msgSeq = 0;
  private toolSeq = 0;
  private totalUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  constructor(
    private readonly scenario: Scenario,
    private readonly cwd: string,
    private readonly speedFactor: number,
    private readonly out: (line: string) => void,
    private readonly err: (line: string) => void,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {
    this.sessionId = scenario.externalRef ?? `sim-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  get externalRef(): string {
    return this.sessionId;
  }

  async start(): Promise<number> {
    this.emit({
      type: "system",
      subtype: "init",
      session_id: this.sessionId,
      model: this.scenario.model,
      cwd: this.cwd,
    });
    const exit = await this.runSteps(this.scenario.steps);
    if (exit === "done") {
      this.emitResult("success", null);
      return 0;
    }
    if (exit.kind === "fail") {
      this.emitResult("error", exit.message);
      return 1;
    }
    // crash: no result line, hard exit
    this.err(`sim-agent: ${exit.message}`);
    return exit.exitCode;
  }

  /** Handles a follow-up pushed on stdin; returns steps' outcome. */
  async handleFollowUp(text: string): Promise<void> {
    this.emitUserMessage(`[follow-up] ${text}`);
    if (this.scenario.followUpSteps.length === 0) {
      this.emit({
        type: "assistant",
        message: this.assistantMessage([{ type: "text", text: "Acknowledged (sim, no follow-up script)." }]),
      });
      return;
    }
    await this.runSteps(this.scenario.followUpSteps);
  }

  private async runSteps(
    steps: Step[],
  ): Promise<"done" | { kind: "fail"; message: string } | { kind: "crash"; exitCode: number; message: string }> {
    for (const step of steps) {
      const outcome = await this.runStep(step);
      if (outcome !== "continue") return outcome;
    }
    return "done";
  }

  private async runStep(
    step: Step,
  ): Promise<"continue" | { kind: "fail"; message: string } | { kind: "crash"; exitCode: number; message: string }> {
    switch (step.type) {
      case "think": {
        this.emit({
          type: "assistant",
          message: this.assistantMessage([{ type: "thinking", thinking: step.text }]),
        });
        return "continue";
      }
      case "say": {
        // Streaming deltas first (stream_event), then the complete message.
        const chunkSize = Math.max(1, Math.ceil(step.text.length / step.chunks));
        for (let i = 0; i < step.text.length; i += chunkSize) {
          this.emit({
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: step.text.slice(i, i + chunkSize) },
            },
            session_id: this.sessionId,
          });
        }
        this.emit({ type: "assistant", message: this.assistantMessage([{ type: "text", text: step.text }]) });
        return "continue";
      }
      case "write": {
        const toolCallId = this.nextToolId();
        const full = join(this.cwd, step.path);
        this.emit({
          type: "assistant",
          message: this.assistantMessage([
            { type: "tool_use", id: toolCallId, name: step.mode === "append" ? "Edit" : "Write", input: { file_path: step.path, content: step.content } },
          ]),
        });
        try {
          if (step.mode === "append") {
            appendFileSync(full, step.content);
          } else {
            writeFileSync(full, step.content);
          }
        } catch (error) {
          this.emitToolResult(toolCallId, null, error instanceof Error ? error.message : String(error));
          return { kind: "fail", message: `write failed: ${step.path}` };
        }
        this.emitToolResult(toolCallId, `wrote ${step.path}`, null);
        return "continue";
      }
      case "edit": {
        const toolCallId = this.nextToolId();
        const full = join(this.cwd, step.path);
        this.emit({
          type: "assistant",
          message: this.assistantMessage([
            { type: "tool_use", id: toolCallId, name: "Edit", input: { file_path: step.path, old_string: step.old, new_string: step.new } },
          ]),
        });
        if (!existsSync(full)) {
          this.emitToolResult(toolCallId, null, `file not found: ${step.path}`);
          return { kind: "fail", message: `edit failed: missing ${step.path}` };
        }
        const { readFileSync } = await import("node:fs");
        const content = readFileSync(full, "utf8");
        if (!content.includes(step.old)) {
          this.emitToolResult(toolCallId, null, `old text not found in ${step.path}`);
          return { kind: "fail", message: `edit failed: old text not found in ${step.path}` };
        }
        writeFileSync(full, content.replace(step.old, step.new));
        this.emitToolResult(toolCallId, `edited ${step.path}`, null);
        return "continue";
      }
      case "delete": {
        const toolCallId = this.nextToolId();
        this.emit({
          type: "assistant",
          message: this.assistantMessage([
            { type: "tool_use", id: toolCallId, name: "Bash", input: { command: `rm ${step.path}` } },
          ]),
        });
        try {
          rmSync(join(this.cwd, step.path));
        } catch (error) {
          this.emitToolResult(toolCallId, null, error instanceof Error ? error.message : String(error));
          return { kind: "fail", message: `delete failed: ${step.path}` };
        }
        this.emitToolResult(toolCallId, `deleted ${step.path}`, null);
        return "continue";
      }
      case "tool": {
        const toolCallId = this.nextToolId();
        this.emit({
          type: "assistant",
          message: this.assistantMessage([
            { type: "tool_use", id: toolCallId, name: step.name, input: step.input },
          ]),
        });
        this.emitToolResult(toolCallId, step.output, step.error);
        return "continue";
      }
      case "shell": {
        const toolCallId = this.nextToolId();
        this.emit({
          type: "assistant",
          message: this.assistantMessage([
            { type: "tool_use", id: toolCallId, name: "Bash", input: { command: step.command } },
          ]),
        });
        const result = spawnSync(step.command, {
          cwd: this.cwd,
          shell: true,
          encoding: "utf8",
          windowsHide: true,
        });
        const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
        if (result.status !== 0) {
          this.emitToolResult(toolCallId, output || null, `exit code ${result.status}`);
          return { kind: "fail", message: `shell failed (${result.status}): ${step.command}` };
        }
        this.emitToolResult(toolCallId, output || "(no output)", null);
        return "continue";
      }
      case "usage": {
        this.totalUsage.inputTokens += step.inputTokens;
        this.totalUsage.outputTokens += step.outputTokens;
        this.totalUsage.cacheReadTokens += step.cacheReadTokens;
        this.totalUsage.cacheWriteTokens += step.cacheWriteTokens;
        this.emit({
          type: "usage",
          model: this.scenario.model,
          input_tokens: step.inputTokens,
          output_tokens: step.outputTokens,
          cache_read_input_tokens: step.cacheReadTokens,
          cache_creation_input_tokens: step.cacheWriteTokens,
        });
        return "continue";
      }
      case "sleep": {
        const scaled = this.speedFactor > 0 ? step.ms / this.speedFactor : 0;
        if (scaled > 0) await this.sleep(scaled);
        return "continue";
      }
      case "crash": {
        const scaled = this.speedFactor > 0 ? step.after / this.speedFactor : 0;
        if (scaled > 0) await this.sleep(scaled);
        return { kind: "crash", exitCode: step.exitCode, message: step.message };
      }
      case "fail": {
        this.emit({
          type: "assistant",
          message: this.assistantMessage([{ type: "text", text: `FAIL: ${step.message}` }]),
        });
        return { kind: "fail", message: step.message };
      }
    }
  }

  private emit(line: unknown): void {
    this.out(JSON.stringify(line));
  }

  private nextToolId(): string {
    this.toolSeq += 1;
    return `toolu_sim_${this.toolSeq.toString().padStart(2, "0")}`;
  }

  private assistantMessage(content: Array<Record<string, unknown>>): { id: string; role: "assistant"; content: Array<Record<string, unknown>> } {
    this.msgSeq += 1;
    return { id: `msg_sim_${this.msgSeq}`, role: "assistant", content };
  }

  private emitUserMessage(text: string): void {
    this.msgSeq += 1;
    this.emit({
      type: "user",
      message: {
        id: `msg_sim_${this.msgSeq}`,
        role: "user",
        content: [{ type: "text", text }],
      },
    });
  }

  private emitToolResult(toolCallId: string, content: string | null, error: string | null): void {
    this.emit({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolCallId,
            ...(error !== null ? { is_error: true, content: error } : { content: content ?? "" }),
          },
        ],
      },
    });
  }

  private emitResult(subtype: "success" | "error", errorText: string | null): void {
    this.emit({
      type: "result",
      subtype,
      ...(errorText !== null ? { result: errorText } : { result: `${this.scenario.name} complete` }),
      session_id: this.sessionId,
      usage: {
        input_tokens: this.totalUsage.inputTokens,
        output_tokens: this.totalUsage.outputTokens,
        cache_read_input_tokens: this.totalUsage.cacheReadTokens,
        cache_creation_input_tokens: this.totalUsage.cacheWriteTokens,
      },
    });
  }
}
