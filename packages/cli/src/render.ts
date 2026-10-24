import type { EventEnvelope } from "@fleetforge/schema";

/** Terminal rendering of the normalized event stream (keyboard-first, compact). */

const ANSI = {
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  reset: "\x1b[0m",
};

export function supportsColor(stream: { isTTY?: boolean }): boolean {
  return stream.isTTY === true && process.env["NO_COLOR"] === undefined;
}

interface RenderStyle {
  enabled: boolean;
  color(code: string, text: string): string;
}

function style(enabled: boolean): RenderStyle {
  return {
    enabled,
    color: (code, text) => (enabled ? `${code}${text}${ANSI.reset}` : text),
  };
}

/** One-line summary per event; deltas fold into a single growing line. */
export class EventStreamRenderer {
  private readonly s: RenderStyle;
  private deltaBuffer = "";
  private inDelta = false;

  constructor(
    private readonly write: (line: string) => void,
    colored: boolean,
  ) {
    this.s = style(colored);
  }

  render(envelope: EventEnvelope): void {
    const { kind, payload } = envelope;
    const seq = this.s.color(ANSI.gray, String(envelope.seq).padStart(4, " "));

    switch (kind) {
      case "session.started": {
        const p = payload as { driver: string; model: string | null; pid: number | null };
        this.write(
          `${seq} ${this.s.color(ANSI.green, "▶ session started")} ${this.s.color(ANSI.dim, `${p.driver}${p.model ? ` · ${p.model}` : ""} · pid ${p.pid ?? "?"}`)}`,
        );
        break;
      }
      case "session.completed": {
        const p = payload as { status: string; exitCode: number | null; error: string | null };
        this.flushDelta();
        const mark =
          p.status === "completed"
            ? this.s.color(ANSI.green, "✔ session completed")
            : p.status === "cancelled"
              ? this.s.color(ANSI.yellow, "■ session cancelled")
              : this.s.color(ANSI.red, "✖ session failed");
        const detail = p.error ? this.s.color(ANSI.red, ` — ${trunc(p.error, 300)}`) : "";
        this.write(`${seq} ${mark}${this.s.color(ANSI.dim, ` (exit ${p.exitCode ?? "?"})`)}${detail}`);
        break;
      }
      case "turn.started":
      case "turn.completed":
        break;
      case "message": {
        const p = payload as { role: string; text: string };
        this.flushDelta();
        const who =
          p.role === "assistant"
            ? this.s.color(ANSI.cyan, "assistant")
            : p.role === "user"
              ? this.s.color(ANSI.blue, "user")
              : this.s.color(ANSI.gray, "system");
        this.write(`${seq} ${who} ${trunc(p.text.replace(/\n/g, " "), 400)}`);
        break;
      }
      case "message.delta": {
        const p = payload as { text: string };
        this.deltaBuffer += p.text;
        this.inDelta = true;
        break;
      }
      case "thinking": {
        const p = payload as { text: string };
        this.flushDelta();
        this.write(`${seq} ${this.s.color(ANSI.magenta, "thinking")} ${this.s.color(ANSI.dim, trunc(p.text.replace(/\n/g, " "), 200))}`);
        break;
      }
      case "tool.started": {
        const p = payload as { toolCallId: string; name: string; input: unknown };
        this.flushDelta();
        const arg = summarizeInput(p.input);
        this.write(`${seq} ${this.s.color(ANSI.yellow, "⚡ tool")} ${p.name} ${this.s.color(ANSI.dim, arg)}`);
        break;
      }
      case "tool.completed": {
        const p = payload as { toolCallId: string; status: string; output: string | null; error: string | null };
        const mark = p.status === "success" ? this.s.color(ANSI.green, "·") : this.s.color(ANSI.red, "×");
        const text = p.error ?? p.output ?? "";
        this.write(`${seq}   ${mark} ${this.s.color(ANSI.dim, trunc(text.replace(/\n/g, " "), 240))}`);
        break;
      }
      case "usage": {
        const p = payload as { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
        this.flushDelta();
        const parts = [`in ${p.inputTokens}`, `out ${p.outputTokens}`];
        if (p.cacheReadTokens > 0) parts.push(`cache-r ${p.cacheReadTokens}`);
        if (p.cacheWriteTokens > 0) parts.push(`cache-w ${p.cacheWriteTokens}`);
        this.write(`${seq} ${this.s.color(ANSI.gray, `tokens: ${parts.join(" · ")}`)}`);
        break;
      }
      case "file.changed": {
        const p = payload as { path: string; change: string };
        this.flushDelta();
        const mark = { add: "+", modify: "~", delete: "-", rename: "→" }[p.change] ?? "?";
        this.write(`${seq} ${this.s.color(ANSI.green, mark)} ${p.path}`);
        break;
      }
      case "session.log": {
        const p = payload as { stream: string; text: string };
        this.flushDelta();
        this.write(`${seq} ${this.s.color(ANSI.gray, `[${p.stream}]`)} ${trunc(p.text, 300)}`);
        break;
      }
      case "followup": {
        const p = payload as { text: string };
        this.flushDelta();
        this.write(`${seq} ${this.s.color(ANSI.blue, "↩ follow-up")} ${trunc(p.text, 200)}`);
        break;
      }
      case "raw": {
        const p = payload as { wire: string };
        this.flushDelta();
        this.write(`${seq} ${this.s.color(ANSI.gray, "raw")} ${trunc(p.wire, 160)}`);
        break;
      }
    }
  }

  /** Print the accumulated message.delta buffer as one assistant line. */
  flushDelta(): void {
    if (!this.inDelta) return;
    this.inDelta = false;
    const text = this.deltaBuffer.replace(/\n/g, " ");
    this.deltaBuffer = "";
    if (text.trim()) {
      this.write(`     ${this.s.color(ANSI.cyan, "assistant")} ${trunc(text, 400)}`);
    }
  }
}

function trunc(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function summarizeInput(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "object") {
    const record = input as Record<string, unknown>;
    const keys = ["file_path", "path", "command", "pattern", "url", "query"];
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string") return trunc(value, 120);
    }
    try {
      return trunc(JSON.stringify(input), 120);
    } catch {
      return "";
    }
  }
  return trunc(String(input), 120);
}
